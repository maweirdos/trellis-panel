import { parentPort } from 'node:worker_threads'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { AcpHistoryCore, HistoryCursorError, type HistoryBatchItem } from './history-core'
import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'

export type HistoryOperation =
  | { op: 'init'; directory: string; sourceDirectory: string }
  | { op: 'append'; items: HistoryBatchItem[] }
  | { op: 'list'; root: string; input: { limit?: number; cursor?: string; query?: string; filter?: string; archive?: string }; legacyIds: string[] }
  | { op: 'session'; root: string; sessionId: string; legacyIds: string[] }
  | { op: 'delete'; root: string; sessionId: string }
  | { op: 'title-material'; root: string; sessionId: string }
  | { op: 'events'; root: string; sessionId: string; input: { limit?: number; before?: string; after?: string } }
  | { op: 'handoff'; root: string; sessionId: string; byteLimit: number }
  | { op: 'recovery'; root: string; record: AcpSessionRecord; input: { sourcePath: string; sourceDigest: string; events: TimelineEvent[] } }
  | { op: 'close' }
export type HistoryWorkerRequest = HistoryOperation & { requestId: number }
export type HistoryWorkerResponse = { requestId: number; ok: true; result: unknown } | { requestId: number; ok: false; error: string; resetRequired: boolean }
let core: AcpHistoryCore | undefined

function canonical(root: string): string {
  let path: string
  try { path = realpathSync(resolve(root)) } catch { path = resolve(root) }
  return process.platform === 'win32' ? path.replace(/[\\/]+$/, '').toLowerCase() : path
}
export function handleHistoryMessage(message: HistoryOperation): unknown {
  if (message.op === 'init') {
    core?.close()
    core = new AcpHistoryCore(message.directory)
    core.importDirectory(message.sourceDirectory, canonical)
    return { ready: true }
  }
  if (!core) throw new Error('Conversation archive unavailable')
  switch (message.op) {
    case 'append': return core.append(message.items)
    case 'list': return core.list(message.root, message.input, message.legacyIds)
    case 'session': return core.session(message.root, message.sessionId, message.legacyIds)
    case 'delete': core.deleteSession(message.root, message.sessionId); return { deleted: true }
    case 'title-material': return core.titleMaterial(message.root, message.sessionId)
    case 'events': return core.events(message.root, message.sessionId, message.input)
    case 'handoff': return core.handoff(message.root, message.sessionId, message.byteLimit)
    case 'recovery': return core.importRecovery(message.root, message.record, message.input)
    case 'close': core.close(); core = undefined; return { closed: true }
  }
}
parentPort?.on('message', (message: HistoryWorkerRequest) => {
  let response: HistoryWorkerResponse
  try { response = { requestId: message.requestId, ok: true, result: handleHistoryMessage(message) } }
  catch (error) { response = { requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error), resetRequired: error instanceof HistoryCursorError } }
  parentPort?.postMessage(response)
})
