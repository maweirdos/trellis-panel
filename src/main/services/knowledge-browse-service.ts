import { Worker } from 'node:worker_threads'
import { neighborWorkerFile } from './worker-path'
import type { KbBrowseInput, KbBrowseSuccess, KbLibrary, KbSearchScope, KbSearchResult } from '../../shared/types'

type Pending = { resolve: (result: KbBrowseSuccess | KbSearchResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
const pending = new Map<number, Pending>()
let worker: Worker | undefined
let nextId = 0
function reset(active: Worker, error: Error): void {
  if (worker !== active) return
  worker = undefined
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
  pending.clear()
  void active.terminate()
}
function getWorker(): Worker {
  if (worker) return worker
  const active = new Worker(neighborWorkerFile('knowledge-browse-worker.js', 'TRELLIS_KB_BROWSE_WORKER_FILE'))
  worker = active
  active.on('message', (message: { requestId: number; ok: boolean; result?: KbBrowseSuccess | KbSearchResult; error?: string }) => {
    const entry = pending.get(message.requestId)
    if (!entry) return
    clearTimeout(entry.timer); pending.delete(message.requestId)
    if (message.ok && message.result) entry.resolve(message.result)
    else entry.reject(new Error(message.error || '本地知识扫描失败'))
  })
  active.on('error', (error) => reset(active, error))
  active.on('exit', (code) => reset(active, new Error(`本地知识扫描进程已退出 (${code})`)))
  active.unref()
  return active
}
function request<T extends KbBrowseSuccess | KbSearchResult>(root: string, generation: number, operation: object): Promise<T> {
  if (pending.size >= 8) return Promise.reject(new Error('本地知识浏览请求过多，请稍后重试'))
  const active = getWorker(), requestId = ++nextId
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reset(active, new Error('本地知识扫描超时，请稍后重试')), 30_000)
    pending.set(requestId, { resolve: (result) => resolve(result as T), reject, timer })
    try { active.postMessage({ requestId, root, generation, ...operation }) }
    catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error instanceof Error ? error : new Error('本地知识扫描启动失败')) }
  })
}
export function browseLocalKnowledge(root: string, generation: number, input: KbBrowseInput): Promise<KbBrowseSuccess> {
  return request(root, generation, { kind: 'browse', input })
}
export function searchLocalKnowledge(root: string, generation: number, library: KbLibrary | 'all', query: string, scope: KbSearchScope): Promise<KbSearchResult> {
  return request(root, generation, { kind: 'search', library, query, scope })
}
