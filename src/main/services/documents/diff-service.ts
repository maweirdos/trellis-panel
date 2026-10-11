import { Worker } from 'node:worker_threads'
import { dirname, join, relative as pathRelative, sep } from 'node:path'
import {
  DOCUMENT_DIFF_CONTEXT_LINES,
  DOCUMENT_DIFF_SIDE_LIMIT_BYTES,
  DOCUMENT_DIFF_TIMEOUT_MS,
  documentDiffRequestSchema,
  documentReadScopeSchema,
  type DocumentDiffDiagnostic,
  type DocumentDiffOutcome,
  type DocumentDiffResult,
  type DocumentDiffResultSide
} from '../../../shared/documents'
import { IpcErrorCode, ipcFail } from '../../../shared/ipc-errors'
import { latestCommitBaseline, type GitBaseline, type GitBaselineFailureStatus } from './git-baseline'
import { realRootOf, resolveAuthorizedDocumentPath } from './paths'
import type { DiffWorkerRequest, DiffWorkerResponse, UnifiedDiffCore } from './diff-worker'

/**
 * document:diff 服务（S0 G2，design §6.2）：
 * 每侧 2MiB 上限 + worker 线程计算 + 1s 超时终止，超限/超时/Git 基线不可用
 * 一律返回明确诊断（降级说明），不是错误伪装，也不冻结调用方。
 *
 * worker 生命周期：懒创建、按需重建（超时终止后下一次调用重新拉起）、
 * before-quit 由 main/index.ts 调 stopDiffWorker() 收口（worker 无子进程，
 * terminate 即完整清理——与 acp.ts 树杀同一收口意图）。
 */

/** 冒烟/测试用：显式指定 worker 文件（ESM bundle 无 __filename 时必需）。 */
export const DIFF_WORKER_FILE_ENV = 'TRELLIS_DIFF_WORKER_FILE'

export interface DiffComputeOverrides {
  /** 计算超时毫秒数（冒烟用小阈值验证超时路径；生产走 DOCUMENT_DIFF_TIMEOUT_MS）。 */
  timeoutMs?: number
}

class DiffTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`diff 计算超过 ${timeoutMs}ms`)
  }
}
class DiffAbortedError extends Error {
  constructor(reason: string) {
    super(reason)
  }
}
class DiffWorkerError extends Error {}

let worker: Worker | null = null
let nextRequestId = 0

interface PendingEntry {
  resolve: (core: UnifiedDiffCore) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}
const pending = new Map<number, PendingEntry>()

function resolveWorkerFile(): string {
  const fromEnv = process.env[DIFF_WORKER_FILE_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv
  // electron-vite 主进程产物为 CJS（out/main/index.js），worker 产物按构建配置同名邻位
  if (typeof __filename === 'string') return join(dirname(__filename), 'diff-worker.js')
  throw new Error(`diff worker 文件未定位（当前为 ESM 运行环境）：请设置 ${DIFF_WORKER_FILE_ENV}`)
}

function settleOk(id: number, core: UnifiedDiffCore): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  clearTimeout(entry.timer)
  entry.resolve(core)
}

function settleErr(id: number, err: Error): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  clearTimeout(entry.timer)
  entry.reject(err)
}

/** 终止 worker 并拒绝所有 in-flight 请求（超时、异常退出、应用退出共用）。 */
function killWorker(reason: Error): void {
  const w = worker
  worker = null
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new DiffAbortedError(reason.message))
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
  w.on('message', (msg: DiffWorkerResponse) => {
    if (msg.ok) settleOk(msg.id, msg.result)
    else settleErr(msg.id, new DiffWorkerError(msg.error))
  })
  w.on('error', (e) => {
    if (worker === w) killWorker(new DiffWorkerError(`diff worker 异常：${e.message}`))
  })
  w.on('exit', (code) => {
    if (worker === w) killWorker(new DiffWorkerError(`diff worker 退出（code ${code}）`))
  })
  worker = w
  return w
}

function computeViaWorker(oldText: string, newText: string, timeoutMs: number): Promise<UnifiedDiffCore> {
  const w = ensureWorker()
  nextRequestId += 1
  const id = nextRequestId
  return new Promise<UnifiedDiffCore>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      killWorker(new DiffAbortedError(`diff 计算超时（${timeoutMs}ms），worker 已终止`))
      reject(new DiffTimeoutError(timeoutMs))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    const msg: DiffWorkerRequest = { id, oldText, newText, context: DOCUMENT_DIFF_CONTEXT_LINES }
    w.postMessage(msg)
  })
}

/** 应用退出收口（before-quit 调用）：终止 worker、拒绝 in-flight。 */
export function stopDiffWorker(): void {
  killWorker(new DiffAbortedError('应用退出，diff worker 已终止'))
}

/* ---------------- 诊断构造 ---------------- */

const tooLargeDiagnostic = (side: 'baseline' | 'current', sizeBytes: number): DocumentDiffDiagnostic => ({
  code: 'diff_side_too_large',
  severity: 'warning',
  message: `${side === 'baseline' ? '基准侧' : '当前侧'}文本 ${(sizeBytes / 1024 / 1024).toFixed(1)}MiB 超过对比上限 ${DOCUMENT_DIFF_SIDE_LIMIT_BYTES / 1024 / 1024}MiB，未计算差异；可改为原文对比或在本机工具中打开`,
  data: { side, sizeBytes, limitBytes: DOCUMENT_DIFF_SIDE_LIMIT_BYTES, openLocally: true, rawCompare: true }
})

const GIT_DIAGNOSTIC_CODES: Record<Exclude<GitBaselineFailureStatus, 'too-large'>, DocumentDiffDiagnostic['code']> = {
  'no-repo': 'git_no_repo',
  'no-commits': 'git_no_commits',
  untracked: 'git_untracked',
  'not-in-commit': 'git_path_not_in_commit',
  'git-unavailable': 'git_unavailable'
}

function gitBaselineDiagnostic(gb: Extract<GitBaseline, { status: GitBaselineFailureStatus }>): DocumentDiffDiagnostic {
  if (gb.status === 'too-large') {
    return {
      code: 'diff_side_too_large',
      severity: 'warning',
      message: `${gb.message ?? '最近提交版本超过对比上限'}；可改为原文对比或在本机工具中打开`,
      data: { side: 'baseline', ...gb.detail, openLocally: true, rawCompare: true }
    }
  }
  return {
    code: GIT_DIAGNOSTIC_CODES[gb.status],
    severity: 'neutral',
    message: gb.message ?? '最近提交基线不可用',
    data: { ...gb.detail }
  }
}

/* ---------------- 主入口 ---------------- */

/**
 * 计算一次版本比较。scope/input 非法或路径越界 → ipcFail（请求级失败）；
 * 超限/超时/Git 基线不可用 → ok:true + diff:null + 诊断（降级说明）。
 */
export async function computeDocumentDiff(
  root: string,
  scope: unknown,
  input: unknown,
  overrides?: DiffComputeOverrides
): Promise<DocumentDiffOutcome> {
  const scopeParsed = documentReadScopeSchema.safeParse(scope ?? {})
  if (scopeParsed.success === false) {
    return ipcFail(IpcErrorCode.InvalidArg, 'documentDiff scope 非法：workspaceId 必填且为非空字符串')
  }
  const reqParsed = documentDiffRequestSchema.safeParse(input ?? {})
  if (reqParsed.success === false) {
    const first = reqParsed.error.issues[0]?.message ?? '参数不合法'
    return ipcFail(IpcErrorCode.InvalidArg, `documentDiff 参数非法：${first}`)
  }
  const { requestId, relativePath, baseline, current } = reqParsed.data

  // 当前侧上限（廉价先检，失败快返，不做 git spawn）
  const currentBytes = Buffer.byteLength(current.text, 'utf-8')
  if (currentBytes > DOCUMENT_DIFF_SIDE_LIMIT_BYTES) {
    return { ok: true, requestId, diff: null, diagnostics: [tooLargeDiagnostic('current', currentBytes)] }
  }

  // 基准侧
  let leftText: string
  let leftRevision: string | null
  let leftCommit: string | null = null
  let leftOrigin: DocumentDiffResultSide['origin'] = 'provided'
  if (baseline.kind === 'text') {
    leftText = baseline.side.text
    leftRevision = baseline.side.revision
  } else {
    // git 基线路径与 documentRead 走同一边界守卫（含软链接逃逸拒绝）
    const auth = resolveAuthorizedDocumentPath(root, relativePath)
    if (!auth.ok) return ipcFail(IpcErrorCode.InvalidArg, '路径超出已打开工作区范围（含软链接逃逸拒绝）')
    const realRoot = realRootOf(root)
    let repoRelative = pathRelative(realRoot, auth.canonicalPath)
    if (sep !== '/') repoRelative = repoRelative.split(sep).join('/')
    const gb = await latestCommitBaseline(realRoot, repoRelative)
    if (gb.status !== 'ok') {
      return { ok: true, requestId, diff: null, diagnostics: [gitBaselineDiagnostic(gb)] }
    }
    leftText = gb.text
    leftRevision = gb.revision
    leftCommit = gb.commit
    leftOrigin = 'git-latest-commit'
  }

  const baselineBytes = Buffer.byteLength(leftText, 'utf-8')
  if (baselineBytes > DOCUMENT_DIFF_SIDE_LIMIT_BYTES) {
    return { ok: true, requestId, diff: null, diagnostics: [tooLargeDiagnostic('baseline', baselineBytes)] }
  }

  const left: DocumentDiffResultSide = { revision: leftRevision, origin: leftOrigin, commit: leftCommit }
  const right: DocumentDiffResultSide = { revision: current.revision, origin: 'provided', commit: null }

  // 完全一致：不走 worker（避免无谓线程往返）
  if (leftText === current.text) {
    return {
      ok: true,
      requestId,
      diff: { identical: true, hunks: [], stats: { added: 0, removed: 0, context: 0 }, left, right, elapsedMs: 0 },
      diagnostics: []
    }
  }

  const startedAt = Date.now()
  try {
    const core = await computeViaWorker(leftText, current.text, overrides?.timeoutMs ?? DOCUMENT_DIFF_TIMEOUT_MS)
    return {
      ok: true,
      requestId,
      diagnostics: [],
      diff: { ...core, left, right, elapsedMs: Date.now() - startedAt }
    }
  } catch (e) {
    if (e instanceof DiffTimeoutError) {
      return {
        ok: true,
        requestId,
        diff: null,
        diagnostics: [
          {
            code: 'diff_timeout',
            severity: 'warning',
            message: `差异计算超过 ${e.timeoutMs}ms，已终止（页面未冻结）；建议改为原文对比，或在本机工具中打开两版比较`,
            data: { timeoutMs: e.timeoutMs, openLocally: true, rawCompare: true }
          }
        ]
      }
    }
    const message = e instanceof Error ? e.message : String(e)
    return {
      ok: true,
      requestId,
      diff: null,
      diagnostics: [
        { code: 'diff_worker_error', severity: 'warning', message: `差异计算失败：${message}；可改为原文对比`, data: {} }
      ]
    }
  }
}
