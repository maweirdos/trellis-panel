import type { DocumentChangedEvent } from '../../../shared/documents'

/**
 * 文档会话集线器（S0 G2 第三片）：渲染端对 document:changed 定向事件的按会话分发。
 *
 * - 事件以 canonicalPath 定向：只有注册过该 canonicalPath 的会话键收到回调，
 *   其余文档零分发（对应主进程 change-bridge 的"不广播无关文档"）。
 * - 事件源经 attachDocumentChangedSource 注入（App 挂载时接 api.onDocumentChanged）；
 *   本模块因此保持纯注册表，可被冒烟直接驱动（不 import api/window）。
 * - 一个 canonicalPath 可挂多个会话键（同一文件被多个入口同时打开，键不同）；
 *   注销一个键不影响同路径的其他键。
 */

export type DocumentChangedListener = (event: DocumentChangedEvent) => void

interface HubEntry {
  key: string
  listener: DocumentChangedListener
}

/** canonicalPath → 会话键集合。 */
const byCanonical = new Map<string, Set<HubEntry>>()

let sourceAttached = false

/** 注入事件源（App 挂载时调用一次）；重复调用幂等。 */
export function attachDocumentChangedSource(
  subscribe: (cb: (e: DocumentChangedEvent) => void) => () => void
): void {
  if (sourceAttached) return
  sourceAttached = true
  subscribe(receiveDocumentChanged)
}

/**
 * 注册一个会话；返回注销函数（组件卸载/切换文档时调用）。
 * 返回的注销幂等（React StrictMode 双调用安全）。
 */
export function registerDocumentSession(
  key: string,
  canonicalPath: string,
  listener: DocumentChangedListener
): () => void {
  let set = byCanonical.get(canonicalPath)
  if (set === undefined) {
    set = new Set()
    byCanonical.set(canonicalPath, set)
  }
  const entry: HubEntry = { key, listener }
  set.add(entry)
  let done = false
  return () => {
    if (done) return
    done = true
    const cur = byCanonical.get(canonicalPath)
    if (cur === undefined) return
    cur.delete(entry)
    if (cur.size === 0) byCanonical.delete(canonicalPath)
  }
}

/** 事件分发核心（纯注册表操作，冒烟直接断言）：只派发给该 canonicalPath 的会话。 */
export function receiveDocumentChanged(event: DocumentChangedEvent): void {
  const set = byCanonical.get(event.canonicalPath)
  if (set === undefined) return
  for (const entry of set) {
    try {
      entry.listener(event)
    } catch {
      // 单个会话消费失败不阻断同路径其他会话
    }
  }
}

/** 冒烟/诊断用：当前注册的 canonicalPath 数。 */
export function documentSessionCount(): number {
  return byCanonical.size
}
