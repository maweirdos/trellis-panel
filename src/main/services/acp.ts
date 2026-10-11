/**
 * ACP（Agent Client Protocol v1）客户端服务 —— 10-09-acp-agent-console。
 *
 * 职责：spawn 任意 NDJSON ACP agent 子进程（codex-acp / gemini --acp / 内置 mock），
 * 在 stdio 上跑 JSON-RPC 2.0（一行一条消息，规范要求消息内禁换行）；
 * session/update 归一化为 TimelineEvent（acp 轨道）经 ipcEvent.acpOutput 广播；
 * session/request_permission 挂起 → 渲染层权限卡 → 回写（120s 超时默认拒绝）。
 *
 * Trellis 轨道：watcher / jira / bridge notify 的既有信号经 emitTrellisTimeline /
 * routeWatcherEvent 归一为同一 TimelineEvent 流（卡片信号只信面板第一方数据，
 * 不解析 agent 输出中的 Trellis 语义）。
 *
 * 刻意不 import state.ts（getProjectRoot 等由调用方传入），保持本模块为无环叶子，
 * 供 state/ipc/bridge 各处安全引用。
 */
import { app } from 'electron'
import { execSync, spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getSettings } from './store'
import { broadcastToWindows } from './bridge'
import { ipcEvent } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail, type IpcFail } from '../../shared/ipc-errors'
import type {
  AcpAgentConfig,
  AcpAgentStatus,
  AcpPermissionOption,
  AcpPermissionPayload,
  AcpSessionRecord,
  AcpSessionStatus,
  TimelineEvent,
  TimelineEventKind
} from '../../shared/types'

/* ---------------- agent 注册表 ---------------- */

const PRESETS: AcpAgentConfig[] = [
  { id: 'codex', name: 'Codex（codex-acp 适配器）', command: 'codex-acp', enabled: true },
  { id: 'gemini', name: 'Gemini CLI（原生 ACP）', command: 'gemini --acp', enabled: true },
  { id: 'mock', name: '内置冒烟 Mock Agent', command: 'node', enabled: true }
]

function mockCommand(): string {
  const script = join(app.getAppPath(), 'scripts', 'smoke', 'acp-mock-agent.mjs')
  return `node "${script}" --serve`
}

/** where/which 探测命令首词是否在 PATH 上（结果缓存到进程生命周期） */
const probeCache = new Map<string, boolean>()

function commandHead(command: string): string {
  const m = command.trim().match(/^(?:"([^"]+)"|(\S+))/)
  return (m?.[1] ?? m?.[2] ?? '').trim()
}

function probeAvailable(command: string): boolean {
  const head = commandHead(command)
  if (!head) return false
  if (probeCache.has(head)) return probeCache.get(head) === true
  let ok = false
  try {
    execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${head}`, {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5000
    })
    ok = true
  } catch {
    ok = false
  }
  probeCache.set(head, ok)
  return ok
}

export function listAcpAgents(): { ok: true; agents: AcpAgentStatus[] } {
  const overrides = new Map((getSettings().acp?.agents ?? []).map((a) => [a.id, a]))
  const agents: AcpAgentStatus[] = PRESETS.map((preset) => {
    const merged = { ...preset, ...(overrides.get(preset.id) ?? {}) } as AcpAgentConfig
    const command = merged.id === 'mock' ? mockCommand() : merged.command
    return { ...merged, command, available: merged.id === 'mock' ? true : probeAvailable(command) }
  })
  // 用户自定义条目（非预置 id）也列出
  for (const [id, cfg] of overrides) {
    if (PRESETS.some((p) => p.id === id)) continue
    agents.push({ ...cfg, available: probeAvailable(cfg.command) })
  }
  return { ok: true, agents }
}

/* ---------------- 会话存储 ---------------- */

interface PendingRpc {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface PermissionPending {
  rpcId: number | string
  timer: NodeJS.Timeout
  options: AcpPermissionOption[]
  /** allow_always 记忆键（toolCall kind + title） */
  memoryKey: string
}

interface ActiveSession {
  meta: AcpSessionRecord
  proc: ChildProcess | null
  agent: AcpAgentConfig
  nextRpcId: number
  pending: Map<number, PendingRpc>
  permission: Map<string, PermissionPending>
  /** allow_always 记忆：命中后同 kind+title 的权限请求自动放行 */
  allowAlways: Set<string>
  killed: boolean
  /** stdout 半行缓冲（NDJSON 跨 chunk 拼接） */
  lineBuf: string
  /** task-status 去抖：taskDir → 最近一次发射 ts */
  lastStatusAt: Map<string, number>
}

const sessions = new Map<string, ActiveSession>()
const MAX_ACTIVE = 4
const MAX_RECORD_EVENTS = 800

function sessionsDir(): string {
  const dir = join(app.getPath('userData'), 'acp-sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function recordPath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.json`)
}

function persistRecord(rec: AcpSessionRecord): void {
  try {
    const p = recordPath(rec.sessionId)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf-8')
    renameSync(tmp, p)
  } catch {
    // best-effort：会话记录落盘失败不阻断事件流
  }
}

export function listAcpSessions(limit = 20): { ok: true; sessions: AcpSessionRecord[] } {
  const out: AcpSessionRecord[] = []
  const dir = sessionsDir()
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json') || f.endsWith('.tmp.json')) continue
      try {
        out.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')) as AcpSessionRecord)
      } catch {
        // skip 损坏记录
      }
    }
  } catch {
    return { ok: true, sessions: [] }
  }
  // 活跃会话优先（内存态最新），其余按开始时间倒序
  const active = [...sessions.values()].map((s) => s.meta)
  const rest = out.filter((r) => !sessions.has(r.sessionId)).sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  return { ok: true, sessions: [...active, ...rest] }
}

/* ---------------- 事件发射 ---------------- */

let eventSeq = 0

function emit(session: ActiveSession, kind: TimelineEventKind, text?: string, payload?: Record<string, unknown>): void {
  const ev: TimelineEvent = {
    id: `te-${Date.now().toString(36)}-${(eventSeq++).toString(36)}`,
    ts: Date.now(),
    source: 'acp',
    sessionId: session.meta.sessionId,
    projectRoot: session.meta.projectRoot,
    taskDir: session.meta.taskDir,
    kind,
    text,
    payload
  }
  broadcastToWindows(ipcEvent.acpOutput, ev)
  session.meta.events.push(ev)
  if (session.meta.events.length > MAX_RECORD_EVENTS) session.meta.events.splice(0, session.meta.events.length - MAX_RECORD_EVENTS)
  if (session.meta.events.length % 20 === 0) persistRecord(session.meta)
}

function setStatus(session: ActiveSession, status: AcpSessionStatus, error?: string): void {
  session.meta.status = status
  session.meta.error = error
  if (status === 'closed' || status === 'error') session.meta.endedAt = Date.now()
  broadcastToWindows(ipcEvent.acpDone, { sessionId: session.meta.sessionId, status, error })
  persistRecord(session.meta)
}

/**
 * Trellis 轨道统一入口：watcher / jira / bridge notify 调用。
 * projectRoot 必传（调用方持有）；广播给渲染层并追加进该项目下所有活跃会话记录。
 */
export function emitTrellisTimeline(
  projectRoot: string,
  kind: TimelineEventKind,
  text: string,
  payload?: Record<string, unknown>,
  taskDir?: string
): void {
  const ev: TimelineEvent = {
    id: `te-${Date.now().toString(36)}-${(eventSeq++).toString(36)}`,
    ts: Date.now(),
    source: 'trellis',
    projectRoot,
    taskDir,
    kind,
    text,
    payload
  }
  broadcastToWindows(ipcEvent.acpOutput, ev)
  for (const s of sessions.values()) {
    if (s.meta.projectRoot !== projectRoot) continue
    s.meta.events.push(ev)
    if (s.meta.events.length > MAX_RECORD_EVENTS) s.meta.events.splice(0, s.meta.events.length - MAX_RECORD_EVENTS)
  }
}

/** watcher 文件级探针 → trellis 轨道事件（task.json 状态 / 任务文档新增 / spec 变更） */
export function routeWatcherEvent(projectRoot: string, rawPath: string, ev: 'add' | 'change'): void {
  const p = rawPath.replace(/\\/g, '/')
  const taskMatch = p.match(/^(?:.*\/)?\.trellis\/tasks\/([^/]+)\/(.+)$/)
  if (taskMatch) {
    const taskDir = taskMatch[1]
    const rest = taskMatch[2]
    if (rest === 'task.json' && ev === 'change') {
      // 同一任务 1.5s 内多次写只报一次（AI 批量改字段常见）
      const now = Date.now()
      for (const s of sessions.values()) {
        if (s.meta.projectRoot !== projectRoot) continue
        if (now - (s.lastStatusAt.get(taskDir) ?? 0) < 1500) return
        s.lastStatusAt.set(taskDir, now)
      }
      let status = ''
      try {
        status = String(JSON.parse(readFileSync(rawPath, 'utf-8')).status ?? '')
      } catch {
        // 读失败仍发事件（无 status 字段）
      }
      emitTrellisTimeline(projectRoot, 'task-status', `任务状态变更${status ? `：${status}` : ''}`, { taskDir, status }, taskDir)
      return
    }
    if (ev === 'add' && (rest === 'prd.md' || rest === 'PRD.md' || rest === 'design.md' || rest.startsWith('research/'))) {
      emitTrellisTimeline(projectRoot, 'doc-created', `创建文档：${rest}`, { taskDir, file: rest, path: rawPath }, taskDir)
    }
    return
  }
  if (/^(?:.*\/)?\.trellis\/spec\/.+/.test(p)) {
    const file = p.split('.trellis/spec/')[1] ?? ''
    emitTrellisTimeline(projectRoot, 'spec-updated', `规范变更：${file}`, { file, path: rawPath })
  }
}

/**
 * bridge notify 轨道：tpanel notify 文本以 `acp:<kind>:` 前缀路由为 trellis 卡片
 * （Studio 钩子一键接线 SessionStart / 每轮注入上报用）。其余文本不受影响。
 */
export function routeNotifyRail(projectRoot: string, text: string): void {
  const m = text.match(/^acp:(spec-injected|task-status|doc-created|spec-updated|jira-sync):\s*(.*)$/)
  if (!m) return
  const kind = m[1] as TimelineEventKind
  emitTrellisTimeline(projectRoot, kind, m[2] || kind, { via: 'tpanel-notify' })
}

/* ---------------- JSON-RPC / NDJSON ---------------- */

function writeLine(session: ActiveSession, msg: unknown): void {
  // NDJSON 硬约束：消息内禁换行（JSON.stringify 保证），行尾 \n
  session.proc?.stdin?.write(`${JSON.stringify(msg)}\n`)
}

function rpcSend(session: ActiveSession, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = session.nextRpcId++
    const timer = setTimeout(() => {
      session.pending.delete(id)
      reject(new Error(`ACP 请求超时：${method}`))
    }, timeoutMs)
    session.pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer)
        session.pending.delete(id)
        resolve(result)
      },
      reject: (err) => {
        clearTimeout(timer)
        session.pending.delete(id)
        reject(err)
      },
      timer
    })
    writeLine(session, { jsonrpc: '2.0', id, method, params })
  })
}

function handleMessage(session: ActiveSession, msg: Record<string, unknown>): void {
  if (typeof msg.id === 'number' || typeof msg.id === 'string') {
    if (msg.method) {
      // agent → client 请求（目前只有 session/request_permission）
      handleServerRequest(session, msg)
      return
    }
    // 响应
    const entry = session.pending.get(msg.id as number)
    if (!entry) return
    if ('error' in msg) entry.reject(new Error(String((msg.error as { message?: string })?.message ?? 'ACP 调用失败')))
    else entry.resolve(msg.result)
    return
  }
  if (msg.method === 'session/update' && msg.params) {
    handleSessionUpdate(session, msg.params as { sessionId?: string; update?: Record<string, unknown> })
  }
  // 其余通知（session/cancel 回显等）忽略
}

function handleServerRequest(session: ActiveSession, msg: Record<string, unknown>): void {
  const method = String(msg.method)
  const params = (msg.params ?? {}) as Record<string, unknown>
  if (method !== 'session/request_permission') {
    // 未声明的客户端能力（fs/terminal/elicitation 等）：规范允许返回 method-not-found
    writeLine(session, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `client method not found: ${method}` } })
    return
  }
  const rawOptions = Array.isArray(params.options) ? (params.options as Array<Record<string, unknown>>) : []
  const options: AcpPermissionOption[] = rawOptions.map((o) => ({
    optionId: String(o.optionId ?? ''),
    name: String(o.name ?? o.optionId ?? ''),
    kind: (['allow_once', 'allow_always', 'reject_once'].includes(String(o.kind)) ? String(o.kind) : 'allow_once') as AcpPermissionOption['kind']
  }))
  const toolCall = params.toolCall as { toolCallId?: string; title?: string; kind?: string } | undefined
  const memoryKey = `${toolCall?.kind ?? ''}|${toolCall?.title ?? ''}`

  // 「本次会话允许」记忆命中：直接放行，不打扰 UI
  if (session.allowAlways.has(memoryKey)) {
    const allow = options.find((o) => o.kind !== 'reject_once')
    if (allow) {
      writeLine(session, { jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } })
      return
    }
  }

  const requestId = `perm-${session.meta.sessionId}-${String(msg.id)}`
  const timer = setTimeout(() => {
    // 120s 超时默认拒绝（cancelled 语义，agent 会改道）
    session.permission.delete(requestId)
    writeLine(session, { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'permission timeout' } })
    emit(session, 'permission', '权限请求超时，已自动拒绝', { requestId, outcome: 'timeout' })
  }, 120_000)
  session.permission.set(requestId, { rpcId: msg.id as number | string, timer, options, memoryKey })

  const payload: AcpPermissionPayload = {
    requestId,
    sessionId: session.meta.sessionId,
    agentName: session.meta.agentName,
    toolCall: toolCall ? { toolCallId: toolCall.toolCallId, title: toolCall.title, kind: toolCall.kind } : undefined,
    options
  }
  broadcastToWindows(ipcEvent.acpPermission, payload)
}

function handleSessionUpdate(session: ActiveSession, params: { sessionId?: string; update?: Record<string, unknown> }): void {
  const update = params.update ?? {}
  // 规范字段 sessionUpdate；部分实现用 update/type —— 三者兼容
  const kind = String((update as { sessionUpdate?: unknown }).sessionUpdate ?? update.update ?? update.type ?? '')
  if (kind === 'agent_message_chunk') {
    const content = update.content as { text?: string } | undefined
    if (content?.text) emit(session, 'message', content.text)
    return
  }
  if (kind === 'agent_thought_chunk') {
    const content = update.content as { text?: string } | undefined
    if (content?.text) emit(session, 'thought', content.text)
    return
  }
  if (kind === 'tool_call') {
    const status = String(update.status ?? '')
    const toolCallId = String(update.toolCallId ?? '')
    const title = String(update.title ?? update.kind ?? '工具调用')
    const toolKind = String(update.kind ?? '')
    const locations = Array.isArray(update.locations) ? (update.locations as Array<Record<string, unknown>>).slice(0, 3) : undefined
    const preview =
      typeof update.content === 'string'
        ? update.content.slice(0, 400)
        : typeof update.rawOutput === 'string'
          ? update.rawOutput.slice(0, 400)
          : undefined
    emit(session, 'tool-call', title, { toolCallId, status, kind: toolKind, locations, preview })
    return
  }
  if (kind === 'plan') {
    const steps = Array.isArray(update.steps) ? (update.steps as Array<Record<string, unknown>>).length : 0
    const title = String(update.title ?? '计划更新')
    emit(session, 'message', `📋 ${title}${steps ? `（${steps} 步）` : ''}`, { plan: true })
  }
  // available_commands_update / current_mode_update 等忽略
}

/* ---------------- 会话生命周期 ---------------- */

function killTree(session: ActiveSession): void {
  if (!session.proc || session.proc.exitCode !== null) return
  session.killed = true
  try {
    if (process.platform === 'win32' && session.proc.pid) {
      // 杀整棵进程树（shell -> node -> agent），与 cli.ts 同策略
      spawn('taskkill', ['/pid', String(session.proc.pid), '/T', '/F'], { windowsHide: true })
    } else {
      session.proc.kill('SIGTERM')
    }
  } catch {
    // already gone
  }
}

function teardown(session: ActiveSession, message: string, asError: boolean): void {
  for (const p of session.pending.values()) {
    clearTimeout(p.timer)
    p.reject(new Error(message))
  }
  session.pending.clear()
  for (const p of session.permission.values()) clearTimeout(p.timer)
  session.permission.clear()
  setStatus(session, asError ? 'error' : 'closed', asError ? message : undefined)
  sessions.delete(session.meta.sessionId)
}

export function newAcpSession(projectRoot: string, input: { agentId: string; taskDir?: string }): { ok: true; sessionId: string } | IpcFail {
  if (!projectRoot) return ipcFail(IpcErrorCode.NoProject, '未打开项目')
  if (sessions.size >= MAX_ACTIVE) return ipcFail(IpcErrorCode.InvalidArg, `同时最多 ${MAX_ACTIVE} 个 ACP 会话`)
  const { agents } = listAcpAgents()
  const agent = agents.find((a) => a.id === input.agentId && a.enabled && a.available)
  if (!agent) return ipcFail(IpcErrorCode.InvalidArg, `agent 不可用或未启用：${input.agentId}`)

  const sessionId = `acp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const session: ActiveSession = {
    meta: {
      sessionId,
      agentId: agent.id,
      agentName: agent.name,
      projectRoot,
      taskDir: input.taskDir,
      status: 'starting',
      startedAt: Date.now(),
      events: []
    },
    proc: null,
    agent,
    nextRpcId: 1,
    pending: new Map(),
    permission: new Map(),
    allowAlways: new Set(),
    killed: false,
    lineBuf: '',
    lastStatusAt: new Map()
  }
  sessions.set(sessionId, session)

  const proc = spawn(agent.command, {
    cwd: projectRoot,
    shell: true,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  })
  session.proc = proc
  proc.stdin?.on('error', () => {
    /* agent 提前退出时写 stdin 报 EPIPE —— 由 close 事件统一收尾 */
  })
  proc.stdout?.on('data', (d: Buffer) => {
    session.lineBuf += d.toString('utf-8')
    let idx: number
    while ((idx = session.lineBuf.indexOf('\n')) >= 0) {
      const line = session.lineBuf.slice(0, idx).replace(/\r$/, '')
      session.lineBuf = session.lineBuf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        handleMessage(session, JSON.parse(line) as Record<string, unknown>)
      } catch {
        // 非 JSON 行（agent 日志）忽略
      }
    }
  })
  proc.stderr?.on('data', (d: Buffer) => {
    const text = d.toString('utf-8').trim()
    if (text) emit(session, 'session-status', text.slice(0, 300), { stream: 'stderr' })
  })
  proc.on('error', (e) => teardown(session, `启动 agent 失败：${e.message}`, true))
  proc.on('close', (code) => {
    const message = session.killed ? '会话已结束' : `agent 进程退出（code ${code ?? 'null'}）`
    teardown(session, message, !session.killed)
  })

  // 协议握手：initialize → session/new（各 30s 超时）
  void (async () => {
    try {
      await rpcSend(
        session,
        'initialize',
        { protocolVersion: 1, clientInfo: { name: 'trellis-panel', version: app.getVersion() } },
        30_000
      )
      const created = (await rpcSend(session, 'session/new', { cwd: projectRoot, mcpServers: [] }, 30_000)) as
        | { sessionId?: string }
        | undefined
      if (created?.sessionId) emit(session, 'session-status', `ACP 会话已建立（agent 侧会话 ${created.sessionId}）`)
      setStatus(session, 'ready')
    } catch (e) {
      teardown(session, (e as Error).message, true)
    }
  })()

  persistRecord(session.meta)
  return { ok: true, sessionId }
}

export async function promptAcpSession(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: '会话不存在或已结束' }
  if (session.meta.status !== 'ready' && session.meta.status !== 'busy') return { ok: false, error: `会话状态不可发送：${session.meta.status}` }
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: '发送内容不能为空' }

  emit(session, 'message', trimmed, { role: 'user' })
  if (!session.meta.title) session.meta.title = trimmed.slice(0, 40)
  setStatus(session, 'busy')
  try {
    const result = (await rpcSend(session, 'session/prompt', { prompt: [{ type: 'text', text: trimmed }] }, 30 * 60_000)) as
      | { stopReason?: string }
      | null
    const stopReason = String(result?.stopReason ?? '')
    emit(session, 'turn-done', `回合结束（${stopReason || 'end_turn'}）`, { stopReason })
    if (session.meta.status === 'busy') setStatus(session, 'ready')
    return { ok: true }
  } catch (e) {
    if (session.meta.status === 'busy') setStatus(session, 'error', (e as Error).message)
    return { ok: false, error: (e as Error).message }
  }
}

export function cancelAcpSession(sessionId: string): { ok: boolean; error?: string } {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: '会话不存在或已结束' }
  writeLine(session, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  return { ok: true }
}

export function killAcpSession(sessionId: string): { ok: boolean; error?: string } {
  const session = sessions.get(sessionId)
  if (!session) return { ok: false, error: '会话不存在或已结束' }
  killTree(session)
  return { ok: true }
}

export function respondAcpPermission(requestId: string, optionId: string): { ok: boolean; error?: string } {
  for (const session of sessions.values()) {
    const pending = session.permission.get(requestId)
    if (!pending) continue
    clearTimeout(pending.timer)
    session.permission.delete(requestId)
    const chosen = pending.options.find((o) => o.optionId === optionId)
    if (!chosen) return { ok: false, error: `无效的权限选项：${optionId}` }
    if (chosen.kind === 'allow_always') session.allowAlways.add(pending.memoryKey)
    writeLine(session, { jsonrpc: '2.0', id: pending.rpcId, result: { outcome: { outcome: 'selected', optionId } } })
    emit(session, 'permission', `权限决定：${chosen.name}`, { requestId, optionId, kind: chosen.kind })
    return { ok: true }
  }
  return { ok: false, error: '权限请求不存在或已超时' }
}

/* 应用退出前清理全部会话进程树 */
export function shutdownAcp(): void {
  for (const s of [...sessions.values()]) killTree(s)
}
