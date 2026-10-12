import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import {
  observationQueryRequestSchema,
  observationScopeSchema,
  type ObservationBindingStatus,
  type ObservationCursor,
  type ObservationHealth,
  type ObservationQueryRequest,
  type ObservationQuerySuccess,
  type ObservationScope,
  type ObservationStatusResult,
  type ObservationSubscriptionEvent,
  type ObservationSubscribeResult
} from '../../../shared/observability/store'
import { IpcErrorCode, ipcFail, type IpcFail } from '../../../shared/ipc-errors'
import {
  createOrVerifyBinding,
  ensureInstallationIdentity,
  ensureRuntimeDir,
  readBinding,
  readInstallationIdentity,
  sameRoot,
  setCollectionEnabled,
  type GitBindingFacts,
  type InstallationIdentity,
  type PanelBinding
} from './identity'
import { redactText, type StoreBindingContext, type StoreLimits, type VerifyAliasesResult } from './store-core'
import { neighborWorkerFile } from '../worker-path'
import type { ObservationWorkerRequest, ObservationWorkerResponse } from './observation-worker'
import { readTrellisTaskId, scanKnownTaskDirs, taskRefFor, observationRuntimeExists } from '../task-identity'

/**
 * 观测存储主进程服务（S0 G3 第一片，design §4/§5.1/§5.2）：
 * 专用 worker 线程承担全部同步 SQLite 调用（懒创建），主进程只发请求-响应消息；
 * 订阅 = 独立高水位轮询（可见页初始 1s；后台 5s 与暂停降频留后续片）。
 *
 * 生命周期收口：
 * - 项目打开（state.openProjectAt）→ initObservationForRoot：已有绑定才拉起 worker；
 *   无绑定不创建任何文件（首次显式绑定是用户动作，design §3.1）。
 * - 项目关闭 → closeObservationForProject：取消全部订阅（generation++ 丢弃旧响应）、
 *   关闭库连接（worker 线程保留供下次懒复用）。
 * - before-quit → stopObservationWorker：close 尽力回执后 terminate（全退出路径收口）。
 *
 * 语义红线：
 * - 未初始化/不可用不是错误：query 返回空集 + 哨兵 epoch（旧 cursor → resetRequired），
 *   不把它伪装成 ipcFail；未知 ≠ 故障。
 * - resetRequired/reset 推送只用数据字段表达（epoch 变化），不默默跳过。
 * - 本模块不 import electron：订阅推送经 onObservationEvents 回调，由 ipc 层接线广播
 *   （与 diff-service 相同的可冒烟边界）。
 * - 绑定门禁（installationId/canonical root 不符）只停采集；读取/清理照常（design §3.1）。
 */

/** 冒烟/试验用：显式指定 worker 文件（ESM 产物无 __filename 时必需）。 */
export const OBSERVATION_WORKER_FILE_ENV = 'TRELLIS_OBSERVATION_WORKER_FILE'
/** 订阅轮询间隔（可见页默认 1s，design §5.2；冒烟可调小）。 */
export const OBSERVATION_POLL_MS_ENV = 'TRELLIS_OBSERVATION_POLL_MS'
/** 单次 worker 请求超时（默认 10s：迁移/清理属短事务，长于常规路径）。 */
export const OBSERVATION_OP_TIMEOUT_MS_ENV = 'TRELLIS_OBSERVATION_OP_TIMEOUT_MS'

const DEFAULT_POLL_MS = 1000
const DEFAULT_OP_TIMEOUT_MS = 10_000
/** 未初始化/未绑定时 cursor 使用的哨兵 epoch（与库内真实 storeEpoch 必然不同）。 */
export const OBSERVATION_UNAVAILABLE_EPOCH = 'store-unavailable'

export interface ObservationServiceOverrides {
  /** 冒烟/试验用限额覆盖（生产走 design §4.3 默认值）。 */
  limits?: Partial<StoreLimits>
  /** 覆盖安装目录与 git 探测（冒烟用）。 */
  installDir?: string
  gitFacts?: GitBindingFacts
  /** 用户显式确认迁移：覆盖不符的旧绑定（design §3.1）。 */
  rebind?: boolean
}

export type ObservationInitResult =
  | { ok: true; bound: false; bindingStatus: 'not_bound' }
  | {
      ok: true
      bound: true
      bindingStatus: 'bound' | 'rebind_required'
      blockReason: string | null
      health: ObservationHealth
    }
  | { ok: false; code: IpcErrorCode; error: string }

/* ---------------- worker 请求-响应 ---------------- */

let worker: Worker | null = null
let workerRoot: string | null = null
let workerBinding: StoreBindingContext | null = null
let workerLimits: Partial<StoreLimits> | undefined
let nextRequestId = 1

interface PendingEntry {
  resolve: (result: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}
const pending = new Map<number, PendingEntry>()

class ObservationWorkerError extends Error {}
class ObservationAbortedError extends Error {}

function resolveWorkerFile(): string {
  // 邻位产物；打包环境（asar）由 helper 重写到 app.asar.unpacked（worker_threads 不能从 asar 加载）
  return neighborWorkerFile('observation-worker.js', OBSERVATION_WORKER_FILE_ENV)
}

function killWorker(reason: Error): void {
  const w = worker
  worker = null
  workerRoot = null
  workerBinding = null
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new ObservationAbortedError(reason.message))
  }
  pending.clear()
  if (!w) return
  void w.terminate().catch(() => {
    /* already gone */
  })
}

function ensureWorker(): Worker {
  if (worker !== null) return worker
  const w = new Worker(resolveWorkerFile())
  w.unref()
  w.on('message', (msg: ObservationWorkerResponse) => {
    const entry = pending.get(msg.requestId)
    if (!entry) return
    pending.delete(msg.requestId)
    clearTimeout(entry.timer)
    if (msg.ok) entry.resolve(msg.result)
    else entry.reject(new ObservationWorkerError(msg.error))
  })
  w.on('error', (e) => {
    if (worker === w) killWorker(new ObservationWorkerError(`observation worker 异常：${e.message}`))
  })
  w.on('exit', (code) => {
    if (worker === w) killWorker(new ObservationWorkerError(`observation worker 退出（code ${code}）`))
  })
  worker = w
  return w
}

/** 可分配 Omit：请求联合类型需逐成员去掉 requestId（Omit 对 union 不分布）。 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never
type ObservationWorkerCall = DistributiveOmit<ObservationWorkerRequest, 'requestId'>

function opTimeoutMs(): number {
  const raw = Number(process.env[OBSERVATION_OP_TIMEOUT_MS_ENV])
  return Number.isFinite(raw) && raw >= 100 ? raw : DEFAULT_OP_TIMEOUT_MS
}

function workerRequest<T = unknown>(req: ObservationWorkerCall, timeoutMs = opTimeoutMs()): Promise<T> {
  const w = ensureWorker()
  const requestId = nextRequestId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      killWorker(new ObservationAbortedError(`observation worker 请求超时（${req.op}，${timeoutMs}ms），worker 已终止`))
      reject(new ObservationWorkerError(`observation op 超时: ${req.op}`))
    }, timeoutMs)
    pending.set(requestId, {
      resolve: (result) => resolve(result as T),
      reject,
      timer
    })
    try {
      w.postMessage({ requestId, ...req } satisfies ObservationWorkerRequest)
    } catch (e) {
      pending.delete(requestId)
      clearTimeout(timer)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/* ---------------- 订阅（独立高水位轮询 → 推送回调） ---------------- */

export interface ObservationPushEnvelope {
  subscriptionId: string
  event: ObservationSubscriptionEvent
}

type PushListener = (envelope: ObservationPushEnvelope) => void
const pushListeners = new Set<PushListener>()

/** 订阅推送出口（ipc 层接线 broadcastToWindows；冒烟直接挂回调）。 */
export function onObservationEvents(cb: PushListener): () => void {
  pushListeners.add(cb)
  return () => pushListeners.delete(cb)
}

function emitPush(envelope: ObservationPushEnvelope): void {
  for (const l of pushListeners) {
    try {
      l(envelope)
    } catch {
      /* 监听方异常不中断轮询 */
    }
  }
}

interface Subscription {
  id: string
  scope: ObservationScope
  lastSeq: number
  lastEpoch: string
  timer: NodeJS.Timeout
  generation: number
}
const subscriptions = new Map<string, Subscription>()
/** 项目切换/关闭递增：旧订阅轮询结果直接丢弃（防串线，design §5.1）。 */
let generation = 0

function pollIntervalMs(requestedMs?: number): number {
  // 冒烟/试验环境变量优先（允许 <1000ms 的加速轮询）
  const raw = Number(process.env[OBSERVATION_POLL_MS_ENV])
  if (Number.isFinite(raw) && raw >= 100) return raw
  if (requestedMs === undefined) return DEFAULT_POLL_MS
  // 生产请求夹取 [1000, 5000]：可见 1s / 后台 5s（design §5.2）
  return Math.max(1000, Math.min(5000, Math.floor(requestedMs)))
}

function notInitializedHealth(): ObservationHealth {
  return {
    state: 'not_initialized',
    pauseReason: null,
    dbVersion: null,
    storeEpoch: null,
    logicalCount: 0,
    logicalPayloadBytes: 0,
    physicalBytes: 0,
    controlState: 'not_initialized'
  }
}

async function pollSubscription(sub: Subscription): Promise<void> {
  if (sub.generation !== generation) return
  let res: ObservationQuerySuccess
  try {
    res = await queryObservationsInternal(sub.scope, {
      after: sub.lastSeq,
      limit: 100,
      cursorEpoch: sub.lastEpoch
    })
  } catch {
    return /* 轮询失败按无变化处理；库不可用由 health/epoch 表达 */
  }
  if (sub.generation !== generation) return
  if (res.resetRequired) {
    // cursor 失效（清理/重建换 epoch）：推送 reset，从 0 重拉（不默默跳过，不猜窗口）
    sub.lastEpoch = res.nextCursor.storeEpoch
    sub.lastSeq = 0
    emitPush({
      subscriptionId: sub.id,
      event: { type: 'reset', reason: 'epoch_changed', health: res.health }
    })
    return
  }
  sub.lastEpoch = res.nextCursor.storeEpoch
  if (res.items.length > 0) {
    sub.lastSeq = res.items[res.items.length - 1].seq
    emitPush({
      subscriptionId: sub.id,
      event: { type: 'events', items: res.items, cursor: res.nextCursor, health: res.health }
    })
  }
}

/* ---------------- 初始化 / 绑定 ---------------- */

function bindingContextOf(
  binding: PanelBinding,
  verification: { installation: InstallationIdentity | null; root: string }
): StoreBindingContext {
  let blocked = false
  let blockReason: string | null = null
  const installation = verification.installation
  if (installation === null) {
    blocked = true
    blockReason = 'installation_missing'
  } else if (installation.installationId !== binding.installationId) {
    blocked = true
    blockReason = 'installation_mismatch'
  } else if (!sameRoot(binding.canonicalRoot, verification.root)) {
    blocked = true
    blockReason = 'root_mismatch'
  }
  return {
    repositoryId: binding.repositoryId,
    workspaceId: binding.workspaceId,
    collectionEnabled: binding.collectionEnabled,
    collectionBlocked: blocked,
    blockReason
  }
}

/**
 * 项目打开时初始化：已有绑定（binding.json 或观测库存在）才拉起 worker；
 * 无绑定不创建任何文件（首次显式绑定走 enableObservation，design §3.1）。
 * 绑定不符（installationId/canonical root）→ 仍初始化但 collectionBlocked（读取照常）。
 */
export async function initObservationForRoot(
  root: string,
  overrides: ObservationServiceOverrides = {}
): Promise<ObservationInitResult> {
  // 项目上下文切换先清场：旧订阅一律作废（generation 防串线）、关闭旧库连接——
  // 必须先于 not_bound 早退执行，否则切到无绑定项目时旧项目轮询继续广播（check P2-1）。
  generation += 1
  for (const sub of subscriptions.values()) clearInterval(sub.timer)
  subscriptions.clear()
  if (worker !== null) {
    workerRoot = null
    workerBinding = null
    void workerRequest({ op: 'close', args: null }).catch(() => {
      /* 关闭失败留给 exit 兜底；下一项目 init 会重建连接 */
    })
  }
  // 先探测后创建：无绑定痕迹的项目不写入任何 runtime 文件
  if (!observationRuntimeExists(root)) {
    return { ok: true, bound: false, bindingStatus: 'not_bound' }
  }
  const runtimeDir = ensureRuntimeDir(root)
  const binding = readBinding(runtimeDir)
  if (binding === null) {
    // 有库文件但无绑定（如 Hook 先落库、绑定文件丢失）：无身份上下文，不猜——等待显式绑定
    return { ok: true, bound: false, bindingStatus: 'not_bound' }
  }
  const installation = readInstallationIdentity(overrides.installDir)
  const context = bindingContextOf(binding, { installation, root })
  workerRoot = root
  workerBinding = context
  workerLimits = overrides.limits
  const health = await workerRequest<ObservationHealth>({
    op: 'init',
    args: { runtimeDir, binding: context, limits: overrides.limits }
  })
  void refreshTaskAliases(root).catch(() => {
    /* 别名核验失败不影响读取；下次打开重试 */
  })
  return {
    ok: true,
    bound: true,
    bindingStatus: context.collectionBlocked ? 'rebind_required' : 'bound',
    blockReason: context.blockReason,
    health
  }
}

/** 首次显式绑定（用户动作/冒烟）：创建安装身份与绑定文件后初始化。 */
export async function enableObservation(
  root: string,
  overrides: ObservationServiceOverrides = {}
): Promise<ObservationInitResult> {
  const runtimeDir = ensureRuntimeDir(root)
  const installation = ensureInstallationIdentity(overrides.installDir)
  const verification = createOrVerifyBinding({
    runtimeDir,
    root,
    installation,
    rebind: overrides.rebind,
    installDir: overrides.installDir,
    gitFacts: overrides.gitFacts
  })
  if (verification.status === 'rebind_required') {
    return { ok: false, code: IpcErrorCode.Conflict, error: verification.detail }
  }
  return initObservationForRoot(root, overrides)
}

/** 显式启用/停用采集（FR2）：写 binding.collectionEnabled 并热更新 worker 门禁。 */
export async function setObservationCollectionEnabled(
  root: string,
  enabled: boolean
): Promise<{ ok: true; health: ObservationHealth } | IpcFail> {
  const runtimeDir = ensureRuntimeDir(root)
  let next: PanelBinding | null
  try {
    next = setCollectionEnabled(runtimeDir, enabled)
  } catch (e) {
    return ipcFail(IpcErrorCode.Io, `切换采集开关失败：${redactText(e instanceof Error ? e.message : String(e))}`)
  }
  if (next === null) return ipcFail(IpcErrorCode.InvalidArg, '尚未绑定工作区（先显式绑定再切换采集开关）')
  const installation = readInstallationIdentity()
  const context = bindingContextOf(next, { installation, root })
  workerRoot = root
  workerBinding = context
  try {
    const health = await workerRequest<ObservationHealth>({ op: 'init', args: { runtimeDir, binding: context, limits: workerLimits } })
    return { ok: true, health }
  } catch (e) {
    return ipcFail(IpcErrorCode.Unknown, `切换采集开关失败：${redactText(e instanceof Error ? e.message : String(e))}`)
  }
}

/* ---------------- 查询 / 订阅 ---------------- */

async function queryObservationsInternal(
  scope: ObservationScope,
  request: ObservationQueryRequest
): Promise<ObservationQuerySuccess> {
  const res = await workerRequest<Omit<ObservationQuerySuccess, 'ok'>>({
    op: 'query',
    args: { scope, request }
  })
  return { ok: true, ...res }
}

/**
 * 查询入口（design §5.1）：limit ≤100；库未初始化返回哨兵空集（旧 cursor → resetRequired）。
 * P3-c 偿还：scope.workspaceId 必须与当前绑定归属一致，拒绝跨工作区读取。
 */
export async function queryObservations(
  scope: unknown,
  request: unknown
): Promise<ObservationQuerySuccess | IpcFail> {
  const scopeParsed = observationScopeSchema.safeParse(scope ?? {})
  if (scopeParsed.success === false) {
    return ipcFail(IpcErrorCode.InvalidArg, 'observation query scope 非法：workspaceId 必填且为非空字符串')
  }
  const reqParsed = observationQueryRequestSchema.safeParse(request ?? {})
  if (reqParsed.success === false) {
    const first = reqParsed.error.issues[0]?.message ?? '参数不合法'
    return ipcFail(IpcErrorCode.InvalidArg, `observation query 参数非法：${first}`)
  }
  // P3-c：已绑定时只允许本绑定 workspaceId（未绑定走下方「未初始化≠错误」哨兵口径）
  if (workerBinding !== null && scopeParsed.data.workspaceId !== workerBinding.workspaceId) {
    return ipcFail(IpcErrorCode.InvalidArg, 'observation scope.workspaceId 与当前绑定不符（拒绝跨工作区读取）')
  }
  if (worker === null || workerBinding === null) {
    return {
      ok: true,
      items: [],
      highWatermark: 0,
      nextCursor: { storeEpoch: OBSERVATION_UNAVAILABLE_EPOCH, seq: 0 },
      retainedFrom: null,
      resetRequired: reqParsed.data.cursorEpoch !== undefined && reqParsed.data.cursorEpoch !== OBSERVATION_UNAVAILABLE_EPOCH,
      health: notInitializedHealth()
    }
  }
  try {
    return await queryObservationsInternal(scopeParsed.data, reqParsed.data)
  } catch (e) {
    // P3-d 偿还：fs/SQLite 原始 message 可能带绝对路径，IPC 边界统一脱敏
    return ipcFail(IpcErrorCode.Unknown, `observation query 失败：${redactText(e instanceof Error ? e.message : String(e))}`)
  }
}

/** 订阅入口：返回快照基准 cursor；增量经 onObservationEvents 推送（renderer 按 eventId 去重）。 */
export async function subscribeObservations(
  scope: unknown,
  options: { afterCursor?: ObservationCursor; pollMs?: number } | undefined
): Promise<ObservationSubscribeResult | IpcFail> {
  const scopeParsed = observationScopeSchema.safeParse(scope ?? {})
  if (scopeParsed.success === false) {
    return ipcFail(IpcErrorCode.InvalidArg, 'observation subscribe scope 非法：workspaceId 必填且为非空字符串')
  }
  // P3-c：订阅与查询同一归属校验（防渲染端拿别的工作区 ID 订阅推送）
  if (workerBinding !== null && scopeParsed.data.workspaceId !== workerBinding.workspaceId) {
    return ipcFail(IpcErrorCode.InvalidArg, 'observation scope.workspaceId 与当前绑定不符（拒绝跨工作区订阅）')
  }
  const afterCursor = options?.afterCursor
  // 快照基准：无论是否初始化都建立订阅（库稍后可用时经 epoch 变化自然 reset 对齐）
  const snapshot = await queryObservations(scopeParsed.data, { limit: 1 })
  if (snapshot.ok !== true) {
    return snapshot
  }
  const snapshotCursor = snapshot.nextCursor
  const lastEpoch = snapshotCursor.storeEpoch
  const cursorMatches = afterCursor !== undefined && afterCursor.storeEpoch === lastEpoch
  const sub: Subscription = {
    id: `obs-${randomUUID()}`,
    scope: scopeParsed.data,
    lastSeq: cursorMatches ? afterCursor.seq : snapshotCursor.seq,
    lastEpoch,
    timer: setInterval(() => void pollSubscription(sub), pollIntervalMs(options?.pollMs)),
    generation
  }
  sub.timer.unref()
  subscriptions.set(sub.id, sub)
  if (afterCursor !== undefined && !cursorMatches) {
    // 调用方 cursor 已失效（清理/重建/从未同步）：立即推 reset，不默默跳过
    emitPush({
      subscriptionId: sub.id,
      event: { type: 'reset', reason: 'epoch_changed', health: snapshot.health }
    })
  }
  return { ok: true, subscriptionId: sub.id, snapshotCursor }
}

export function unsubscribeObservations(subscriptionId: string): void {
  const sub = subscriptions.get(subscriptionId)
  if (!sub) return
  clearInterval(sub.timer)
  subscriptions.delete(subscriptionId)
}

/* ---------------- 别名编排（taskRef 身份与归档续接） ---------------- */

/** watcher 任务事件 → 别名登记（fire-and-forget；无绑定/无 worker 时静默跳过）。 */
export function noteTaskDir(root: string, taskDir: string): void {
  if (worker === null || workerRoot !== root || workerBinding === null) return
  const repoRelativeDir = `.trellis/tasks/${taskDir}`
  const trellisTaskId = readTrellisTaskId(root, repoRelativeDir)
  void workerRequest({
    op: 'recordAlias',
    args: { taskRef: taskRefFor(trellisTaskId, repoRelativeDir), trellisTaskId, dir: repoRelativeDir }
  }).catch(() => {
    /* 登记失败不阻塞 watcher 事件流 */
  })
}

/** 归档续接核验（design §3.1：原路径消失且唯一同 ID 目标才续接）。 */
export async function refreshTaskAliases(root: string): Promise<VerifyAliasesResult | null> {
  if (worker === null || workerRoot !== root) return null
  const known = scanKnownTaskDirs(root)
  return workerRequest<VerifyAliasesResult>({ op: 'verifyAliases', args: { known } })
}

/* ---------------- 健康与维护操作 ---------------- */

export async function observationHealth(): Promise<ObservationHealth> {
  if (worker === null) return notInitializedHealth()
  try {
    return await workerRequest({ op: 'health', args: null })
  } catch {
    return notInitializedHealth()
  }
}

/** 绑定/健康综合状态（observation:health IPC 口径；workspaceId 供渲染端组 scope）。 */
export async function observationStatus(): Promise<ObservationStatusResult> {
  const health = await observationHealth()
  const binding: ObservationBindingStatus =
    workerBinding === null
      ? {
          workspaceId: null,
          repositoryId: null,
          collectionEnabled: null,
          bindingStatus: 'not_bound',
          blockReason: null
        }
      : {
          workspaceId: workerBinding.workspaceId,
          repositoryId: workerBinding.repositoryId,
          collectionEnabled: workerBinding.collectionEnabled,
          bindingStatus: workerBinding.collectionBlocked ? 'rebind_required' : 'bound',
          blockReason: workerBinding.blockReason
        }
  return { ok: true, health, binding }
}

export async function cleanupObservationRetention(): Promise<{ ok: true; removed: number; resumed: boolean } | IpcFail> {
  if (worker === null || workerRoot === null) return ipcFail(IpcErrorCode.InvalidArg, '观测库未初始化')
  try {
    const res = await workerRequest<{ removed: number; resumed: boolean }>({ op: 'cleanup', args: null })
    return { ok: true, ...res }
  } catch (e) {
    return ipcFail(IpcErrorCode.Unknown, `观测保留清理失败：${redactText(e instanceof Error ? e.message : String(e))}`)
  }
}

/**
 * 显式清空观测记录（用户确认后调用，design §4.2）：只删事件与观测诊断并更新
 * storeEpoch（旧 cursor → resetRequired）；不触碰 control.sqlite / 绑定 / 任务文档。
 */
export async function clearObservationEvents(): Promise<{ ok: true; storeEpoch: string } | IpcFail> {
  if (worker === null || workerRoot === null) return ipcFail(IpcErrorCode.InvalidArg, '观测库未初始化')
  try {
    const res = await workerRequest<{ storeEpoch: string }>({ op: 'clearAll', args: null })
    return { ok: true, ...res }
  } catch (e) {
    return ipcFail(IpcErrorCode.Unknown, `清空观测记录失败：${redactText(e instanceof Error ? e.message : String(e))}`)
  }
}

/** 项目关闭（state.closeProjectAt）：取消订阅并关闭库连接；worker 线程保留懒复用。 */
export function closeObservationForProject(): void {
  generation += 1
  for (const sub of subscriptions.values()) clearInterval(sub.timer)
  subscriptions.clear()
  if (worker === null) return
  workerRoot = null
  workerBinding = null
  void workerRequest({ op: 'close', args: null }).catch(() => {
    /* 关闭失败留给 exit 兜底；下一项目 init 会重建连接 */
  })
}

/** 应用退出收口（before-quit）：close 尽力回执（≤1.5s）后 terminate；拒绝全部 in-flight。 */
export function stopObservationWorker(): void {
  const w = worker
  generation += 1
  for (const sub of subscriptions.values()) clearInterval(sub.timer)
  subscriptions.clear()
  worker = null
  workerRoot = null
  workerBinding = null
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new ObservationAbortedError('应用退出，observation worker 已终止'))
  }
  pending.clear()
  if (!w) return
  let settled = false
  const finish = (): void => {
    if (settled) return
    settled = true
    void w.terminate().catch(() => {
      /* already gone */
    })
  }
  const timer = setTimeout(finish, 1500)
  const closeRequestId = nextRequestId++
  w.once('message', (msg: ObservationWorkerResponse) => {
    // 只认 close 的回执；其他在途响应到达即终止（终止本身也是合法收口）
    if (msg.requestId !== closeRequestId) return
    clearTimeout(timer)
    finish()
  })
  try {
    w.postMessage({ requestId: closeRequestId, op: 'close', args: null } satisfies ObservationWorkerRequest)
  } catch {
    clearTimeout(timer)
    finish()
  }
}
