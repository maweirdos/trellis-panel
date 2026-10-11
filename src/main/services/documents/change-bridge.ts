import { readFileSync, realpathSync } from 'fs'
import { relative as pathRelative, resolve, sep } from 'path'
import {
  documentReadScopeSchema,
  documentWatchRequestSchema,
  type DocumentChangedEvent,
  type DocumentWatchOutcome
} from '../../../shared/documents'
import { IpcErrorCode, ipcFail } from '../../../shared/ipc-errors'
import { computeRevision } from './controller'
import { realRootOf, resolveAuthorizedDocumentPath } from './paths'

/**
 * 文档变更信号桥（S0 G2 第三片，design §5.2"按 canonicalPath+digest 定向失效"）：
 * 渲染端为"当前打开的阅读会话"注册文档（document:watch，引用计数），watcher 的
 * 文件事件只对已注册路径做定向通知（settle 后读内容摘要），不触发全项目重扫、
 * 不广播给无关文档。
 *
 * 边界与纪律：
 * - 本模块不触碰 ipcMain/BrowserWindow；事件经 onReaderDocumentChanged 订阅
 *   由 IPC 域转发 broadcastToWindows（backend/ipc-conventions：广播统一走
 *   broadcastToWindows，channel 取 ipcEvent）。
 * - knownRevision 竞态闭合：注册时读一次磁盘，与调用方已展示版本不同则立即
 *   补发一条事件，覆盖「读取完成 → 注册监听」之间文件又变化的窗口。
 * - settle 防抖：同一文件的连续写入（Agent 保存）只在静默期后通知一次；
 *   读取失败（正被删除/锁定）通知 revision=null，由渲染端重读呈现诚实诊断。
 * - 项目切换 clearReaderDocuments() 全量清空（渲染端同时清空全部会话）。
 */

/** 冒烟用 settle 阈值覆盖（生产 300ms；与 DIFF_WORKER_FILE_ENV 同一注入模式）。 */
export const READER_SETTLE_MS_ENV = 'TRELLIS_READER_SETTLE_MS'
const SETTLE_MS = (() => {
  const raw = process.env[READER_SETTLE_MS_ENV]
  if (raw === undefined) return 300
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 300
})()

interface WatchEntry {
  relativePath: string
  /** 引用计数：同一 canonicalPath 被多个入口同时打开时全部解除才停发。 */
  refs: number
  timer: ReturnType<typeof setTimeout> | null
}

const watched = new Map<string, WatchEntry>()

type ChangedListener = (e: DocumentChangedEvent) => void
const listeners = new Set<ChangedListener>()

/** 订阅定向变更事件（IPC 域注册一次并转发广播）；返回反订阅。 */
export function onReaderDocumentChanged(cb: ChangedListener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emit(event: DocumentChangedEvent): void {
  for (const cb of listeners) cb(event)
}

/** watcher 原生路径与 canonicalPath 的对齐（realpath 优先，失败退词法路径）。 */
function normalizeAbs(absPath: string): string {
  try {
    return realpathSync(absPath)
  } catch {
    return resolve(absPath)
  }
}

/** 读取当前内容摘要；读不到返回 null（不猜测、不伪装成空文件版本）。 */
function currentRevision(canonicalPath: string): string | null {
  try {
    return computeRevision(readFileSync(canonicalPath))
  } catch {
    return null
  }
}

function relativeUnder(realRoot: string, canonicalPath: string): string {
  let rel = pathRelative(realRoot, canonicalPath)
  if (sep !== '/') rel = rel.split(sep).join('/')
  return rel
}

/**
 * 注册一个阅读会话监听。scope/input 非法或路径越界 → ipcFail（请求级失败，
 * 与 documentRead 同口径）。
 */
export function watchReaderDocument(root: string, scope: unknown, input: unknown): DocumentWatchOutcome {
  const scopeParsed = documentReadScopeSchema.safeParse(scope ?? {})
  if (scopeParsed.success === false) {
    return ipcFail(IpcErrorCode.InvalidArg, 'documentWatch scope 非法：workspaceId 必填且为非空字符串')
  }
  const reqParsed = documentWatchRequestSchema.safeParse(input ?? {})
  if (reqParsed.success === false) {
    const first = reqParsed.error.issues[0]?.message ?? '参数不合法'
    return ipcFail(IpcErrorCode.InvalidArg, `documentWatch 参数非法：${first}`)
  }
  const auth = resolveAuthorizedDocumentPath(root, reqParsed.data.relativePath)
  if (!auth.ok) return ipcFail(IpcErrorCode.InvalidArg, '路径超出已打开工作区范围（含软链接逃逸拒绝）')

  const realRoot = realRootOf(root)
  const relPath = relativeUnder(realRoot, auth.canonicalPath)
  const prev = watched.get(auth.canonicalPath)
  if (prev === undefined) {
    watched.set(auth.canonicalPath, { relativePath: relPath, refs: 1, timer: null })
  } else {
    prev.refs += 1
  }

  // 竞态闭合：注册时磁盘版本与调用方已展示版本不同 → 立即补发一条定向事件
  const known = reqParsed.data.knownRevision
  if (known !== null) {
    const disk = currentRevision(auth.canonicalPath)
    if (disk !== null && disk !== known) {
      emit({ canonicalPath: auth.canonicalPath, relativePath: relPath, revision: disk })
    }
  }
  return { ok: true, canonicalPath: auth.canonicalPath, relativePath: relPath }
}

/** 解除一个监听（引用计数归零才真正停发并清理定时器）。 */
export function unwatchReaderDocument(canonicalPath: string): void {
  const key = normalizeAbs(canonicalPath)
  const entry = watched.get(key)
  if (entry === undefined) return
  entry.refs -= 1
  if (entry.refs > 0) return
  if (entry.timer !== null) clearTimeout(entry.timer)
  watched.delete(key)
}

/** 项目切换/关闭：清空全部监听（渲染端同步清空全部会话）。 */
export function clearReaderDocuments(): void {
  for (const entry of watched.values()) {
    if (entry.timer !== null) clearTimeout(entry.timer)
  }
  watched.clear()
}

/**
 * watcher 文件事件入口（add/change/unlink 直通，不防抖）：
 * 只对已注册的 canonicalPath 生效——无关文档零通知、零重扫。
 */
export function routeReaderDocumentChange(absPath: string): void {
  if (watched.size === 0) return
  const key = normalizeAbs(absPath)
  const entry = watched.get(key)
  if (entry === undefined) return
  if (entry.timer !== null) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    // 定时器触发时条目可能已被解除/清空：只对仍注册的路径发通知
    const cur = watched.get(key)
    if (cur === undefined) return
    emit({ canonicalPath: key, relativePath: cur.relativePath, revision: currentRevision(key) })
  }, SETTLE_MS)
}
