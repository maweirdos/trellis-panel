import { app } from 'electron'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { neighborWorkerFile } from '../worker-path'
import { canonicalDirectory } from './metadata'
import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'
import { acpHistoryEventsInputSchema, acpHistoryListInputSchema, type AcpHistoryEventPage, type AcpHistoryListResult, type AcpHistoryPersistence, type AcpHistorySummary } from '../../../shared/acp-history'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import type { HistoryBatchItem } from './history-core'
import type { HandoffArchive } from './handoff-history'
import type { HistoryOperation, HistoryWorkerRequest, HistoryWorkerResponse } from './history-worker'
import { readHistoryDeletion } from './history-deletion'
import { getSettings } from '../store'

interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface BufferedSession { record: AcpSessionRecord; events: TimelineEvent[]; dirty: boolean; pendingBytes: number }
const requests = new Map<number, PendingRequest>()
const buffered = new Map<string, BufferedSession>()
const health = new Map<string, AcpHistoryPersistence>()
const overflowed = new Map<string, number>()
const writeBlocked = new Set<string>()
let bufferedBytes = 0
let bufferedCount = 0
let worker: Worker | undefined
let ready: Promise<void> | undefined
let nextId = 1
let timer: NodeJS.Timeout | undefined
let writing: Promise<void> | undefined
let notify: (id: string, persistence: AcpHistoryPersistence) => void = () => {}
const MAX_PENDING_EVENTS = 10_000
const MAX_PENDING_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_PENDING_BYTES = 256 * 1024 * 1024
const QUEUE_LIMIT_ERROR = '历史写入队列已达安全上限；超出部分未确认保存，快照只能保留最近内容'
class HistoryRequestError extends Error { constructor(message: string, readonly resetRequired = false) { super(message) } }

export function onHistoryPersistence(callback: typeof notify): void { notify = callback }
export function historyPersistence(sessionId: string): AcpHistoryPersistence {
  return health.get(sessionId) ?? { state: 'saved', pendingCount: 0, committedThroughEventId: null, committedThroughSeq: null }
}
function publish(id: string, update: Partial<AcpHistoryPersistence>): void {
  const previous = historyPersistence(id)
  const value = { ...previous, ...update }
  health.set(id, value)
  if (previous.state !== value.state || previous.committedThroughSeq !== value.committedThroughSeq || previous.error !== value.error) notify(id, value)
}
function unavailable(error: Error): void {
  for (const request of requests.values()) { clearTimeout(request.timer); request.reject(error) }
  requests.clear()
  for (const [id, item] of buffered) {
    writeBlocked.add(id)
    publish(id, { state: 'degraded', pendingCount: item.events.length + (overflowed.get(id) ?? 0), error: overflowed.has(id) ? QUEUE_LIMIT_ERROR : error.message })
  }
}
function request<T>(operation: HistoryOperation): Promise<T> {
  const active = worker
  if (!active) return Promise.reject(new Error('Conversation archive worker unavailable'))
  return new Promise<T>((resolve, reject) => {
    const requestId = nextId++
    const timeout = setTimeout(() => { requests.delete(requestId); reject(new Error('Conversation archive operation timed out; acknowledgement unavailable')) }, 15_000)
    requests.set(requestId, { resolve: (value) => resolve(value as T), reject, timer: timeout })
    try { active.postMessage({ ...operation, requestId } satisfies HistoryWorkerRequest) }
    catch (error) { clearTimeout(timeout); requests.delete(requestId); reject(error) }
  })
}
export function ensureAcpHistory(): Promise<void> {
  if (ready) return ready
  ready = (async () => {
    const active = new Worker(neighborWorkerFile('history-worker.js', 'TRELLIS_ACP_HISTORY_WORKER_FILE'))
    worker = active
    active.on('message', (message: HistoryWorkerResponse) => {
      const entry = requests.get(message.requestId)
      if (!entry) return
      clearTimeout(entry.timer); requests.delete(message.requestId)
      if (message.ok) entry.resolve(message.result)
      else entry.reject(new HistoryRequestError(message.error, message.resetRequired))
    })
    active.on('error', (error) => { if (worker === active) { worker = undefined; ready = undefined; unavailable(error) } })
    active.on('exit', (code) => { if (worker === active) { worker = undefined; ready = undefined; unavailable(new Error(`Conversation archive worker exited (${code})`)) } })
    active.unref()
    const directory = join(app.getPath('userData'), 'acp')
    await request({ op: 'init', directory, sourceDirectory: join(app.getPath('userData'), 'acp-sessions') })
  })().catch((error: unknown) => {
    const active = worker; worker = undefined; ready = undefined
    if (active) void active.terminate()
    const reason = error instanceof Error ? error : new Error(String(error))
    unavailable(reason)
    throw reason
  })
  return ready
}
/** Called at admission, before the bounded compatibility cache is trimmed. */
export function archiveAcpEvent(record: AcpSessionRecord, event?: TimelineEvent): void {
  const id = record.sessionId
  if (readHistoryDeletion(join(app.getPath('userData'), 'acp'), record.projectRoot, id)) return
  let item = buffered.get(id)
  if (!item) { item = { record, events: [], dirty: true, pendingBytes: 0 }; buffered.set(id, item) }
  item.record = record; item.dirty = true
  if (event) {
    const cloned = structuredClone(event)
    const bytes = Buffer.byteLength(JSON.stringify(cloned))
    const oversizedAlone = bufferedCount === 0 && item.events.length === 0
    if (writeBlocked.has(id) && (item.events.length >= MAX_PENDING_EVENTS || bufferedCount >= MAX_PENDING_EVENTS * 4 || (!oversizedAlone && (item.pendingBytes + bytes > MAX_PENDING_BYTES || bufferedBytes + bytes > MAX_TOTAL_PENDING_BYTES)))) {
      const count = (overflowed.get(id) ?? 0) + 1
      overflowed.set(id, count)
      item.dirty = true
      publish(id, { state: 'degraded', pendingCount: item.events.length + count, unarchivedCount: count, error: QUEUE_LIMIT_ERROR })
      return
    }
    item.events.push(cloned)
    item.pendingBytes += bytes
    bufferedBytes += bytes
    bufferedCount++
  }
  const current = historyPersistence(id)
  publish(id, { state: current.state === 'degraded' ? 'degraded' : 'saving', pendingCount: item.events.length + (overflowed.get(id) ?? 0) })
  if (!timer && !writeBlocked.has(id)) {
    timer = setTimeout(() => { timer = undefined; void flushAcpHistory().catch(() => {}) }, 50)
    timer.unref()
  }
}
export async function flushAcpHistory(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = undefined }
  if (writing) return writing
  const operation = (async () => {
    if (![...buffered.values()].some((item) => item.dirty || item.events.length)) return
    await ensureAcpHistory()
    // Bound each transaction's event count/bytes. A single admitted image event stays intact.
    while ([...buffered.values()].some((item) => item.dirty || item.events.length)) {
      const batch: HistoryBatchItem[] = []
      const sizes = new Map<string, number>()
      let count = 0
      let bytes = 0
      for (const [id, item] of buffered) {
        if (!item.dirty && !item.events.length) continue
        const events: TimelineEvent[] = []
        for (const event of item.events) {
          const size = Buffer.byteLength(JSON.stringify(event))
          if (count && (count >= 200 || bytes + size > 2 * 1024 * 1024)) break
          events.push(event); count++; bytes += size
          if (bytes > 2 * 1024 * 1024) break
        }
        if (!events.length && item.events.length) break
        const { events: _cache, ...metadata } = item.record
        batch.push({ root: canonicalDirectory(item.record.projectRoot), record: { ...structuredClone(metadata), events: [] }, events,
          ...(overflowed.has(id) ? { coverage: { state: 'partial' as const, capturedFrom: item.record.startedAt, unarchivedCount: overflowed.get(id), reason: QUEUE_LIMIT_ERROR } } : {}) })
        sizes.set(id, events.length)
        item.dirty = false
        if (count >= 200 || bytes >= 2 * 1024 * 1024) break
      }
      if (!batch.length) break
      try {
        const markers = await request<Array<{ sessionId: string; seq: number | null; eventId: string | null }>>({ op: 'append', items: batch })
        for (const marker of markers) {
          writeBlocked.delete(marker.sessionId)
          const item = buffered.get(marker.sessionId)
          if (!item) continue
          const removed = item.events.splice(0, sizes.get(marker.sessionId) ?? 0)
          const removedBytes = removed.reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)), 0)
          item.pendingBytes = Math.max(0, item.pendingBytes - removedBytes)
          bufferedBytes = Math.max(0, bufferedBytes - removedBytes); bufferedCount = Math.max(0, bufferedCount - removed.length)
          const unarchivedCount = overflowed.get(marker.sessionId) ?? 0
          publish(marker.sessionId, { state: unarchivedCount ? 'degraded' : item.events.length || item.dirty ? 'saving' : 'saved', pendingCount: item.events.length + unarchivedCount,
            committedThroughEventId: marker.eventId, committedThroughSeq: marker.seq, error: unarchivedCount ? QUEUE_LIMIT_ERROR : undefined, unarchivedCount })
          if (!item.events.length && !item.dirty) buffered.delete(marker.sessionId)
        }
      } catch (error) { for (const item of batch) { const pending = buffered.get(item.record.sessionId); if (pending) pending.dirty = true }; throw error }
    }
  })()
  const completion: Promise<void> = operation.catch((error: unknown) => {
    unavailable(error instanceof Error ? error : new Error(String(error)))
    throw error
  }).finally(() => { if (writing === completion) writing = undefined })
  writing = completion
  return completion
}
function fail(error: unknown): IpcFail {
  return ipcFail(error instanceof HistoryRequestError && error.resetRequired ? IpcErrorCode.Conflict : IpcErrorCode.Io,
    `会话历史读取失败：${error instanceof Error ? error.message : String(error)}`, error instanceof HistoryRequestError && error.resetRequired ? { resetRequired: true } : undefined)
}
export async function listAcpHistory(root: string, input?: unknown): Promise<AcpHistoryListResult | IpcFail> {
  const parsed = acpHistoryListInputSchema.safeParse(input)
  if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '会话分页参数无效')
  try { await ensureAcpHistory(); await flushAcpHistory().catch(() => {}); return await request({ op: 'list', root: canonicalDirectory(root), input: parsed.data ?? {}, legacyIds: (getSettings().acp?.agents ?? []).map(item => item.id) }) }
  catch (error) { return fail(error) }
}
export async function readAcpHistorySession(root: string, sessionId: string): Promise<{ ok: true; version: 1; session: AcpHistorySummary } | IpcFail> {
  try {
    await ensureAcpHistory(); await flushAcpHistory().catch(() => {})
    const session = await request<AcpHistorySummary | null>({ op: 'session', root: canonicalDirectory(root), sessionId, legacyIds: (getSettings().acp?.agents ?? []).map(item => item.id) })
    return session ? { ok: true, version: 1, session } : ipcFail(IpcErrorCode.NotFound, '当前项目没有此会话')
  } catch (error) { return fail(error) }
}
export async function readAcpHistoryEvents(root: string, sessionId: string, input?: unknown): Promise<AcpHistoryEventPage | IpcFail> {
  const parsed = acpHistoryEventsInputSchema.safeParse(input)
  if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '正文分页参数无效')
  try {
    await ensureAcpHistory(); await flushAcpHistory().catch(() => {})
    const page = await request<AcpHistoryEventPage | null>({ op: 'events', root: canonicalDirectory(root), sessionId, input: parsed.data ?? {} })
    return page ?? ipcFail(IpcErrorCode.NotFound, '当前项目没有此会话')
  } catch (error) { return fail(error) }
}
/** Handoffs require acknowledged SQLite history; snapshot fallback is insufficient. */
export async function readAcpHandoffArchive(root: string, sessionId: string, byteLimit: number): Promise<HandoffArchive | IpcFail> {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 512 || byteLimit > 32 * 1024) return ipcFail(IpcErrorCode.InvalidArg, '交接上下文限额无效')
  try {
    await ensureAcpHistory(); await flushAcpHistory()
    if (historyPersistence(sessionId).state !== 'saved') return ipcFail(IpcErrorCode.Conflict, '源会话历史尚未确认保存')
    return await request<HandoffArchive | null>({ op: 'handoff', root: canonicalDirectory(root), sessionId, byteLimit })
      ?? ipcFail(IpcErrorCode.NotFound, '当前项目没有此源会话历史')
  } catch (error) { return fail(error) }
}
export async function retryAcpHistory(): Promise<void> { await flushAcpHistory() }
export async function drainAcpHistory(): Promise<void> {
  // A flush can join an existing writer; drain again to include writes queued at its completion.
  do { await flushAcpHistory() } while (writing || [...buffered.values()].some(item => item.dirty || item.events.length))
}
export async function deleteAcpHistoryArchive(root: string, sessionId: string): Promise<void> {
  await ensureAcpHistory()
  await request({ op: 'delete', root: canonicalDirectory(root), sessionId })
  health.delete(sessionId); overflowed.delete(sessionId); writeBlocked.delete(sessionId)
}
export async function readAcpTitleMaterial(root: string, sessionId: string): Promise<{ question: string; delivery: string; digest: string } | null> {
  await ensureAcpHistory(); await drainAcpHistory()
  return request({ op: 'title-material', root: canonicalDirectory(root), sessionId })
}
export async function stopAcpHistory(): Promise<void> {
  await flushAcpHistory()
  if (!worker) return
  await request({ op: 'close' })
  const active = worker; worker = undefined; ready = undefined
  await active.terminate()
}
