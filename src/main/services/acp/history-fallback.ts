import { createHash } from 'node:crypto'
import { acpDataPath, canonicalDirectory, readRecords } from './metadata'
import { acpHistoryEventsInputSchema, type AcpHistoryEventPage, type AcpHistorySummary } from '../../../shared/acp-history'
import type { AcpSessionRecord } from '../../../shared/types'
import { acpConversationPreview, hasAcpConversationContent } from '../../../shared/acp-conversation-preview'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { historicalEvent, historyEventMetadata, HistoryTurnBoundaryError, selectHistoryTurns } from './history-turns'
import { applySessionPreferences, readSessionPreferences } from './session-preferences'
import { canAccessPrivateAcpRecord } from './private-access'

function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function decode(cursor: string): Record<string, unknown> { return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown> }
function summary(record: AcpSessionRecord, error: string): AcpHistorySummary {
  const { events, ...metadata } = record
  const preview = acpConversationPreview(events, record.sessionId, record.projectRoot)
  if (preview) { metadata.conversationPreview = preview.text; metadata.conversationPreviewAt = preview.at }
  const preferences = readSessionPreferences(acpDataPath(), record.projectRoot)
  return { ...applySessionPreferences(metadata, preferences), eventCount: events.length, hasConversation: hasAcpConversationContent(events, record.sessionId, record.projectRoot), lastActivityAt: Math.max(record.startedAt, ...events.map((event) => event.ts)),
    historyCoverage: { state: 'unknown', capturedFrom: events[0]?.ts ?? null, reason: 'Archive unavailable; only the bounded compatibility snapshot can be read' },
    historyPersistence: { state: 'degraded', pendingCount: 0, committedThroughEventId: null, committedThroughSeq: null, error }, pendingPermissions: [], stateRevision: 0, connectionOwned: false, cleanupRequired: false }
}
function records(root: string): AcpSessionRecord[] { return readRecords().filter((record) => canAccessPrivateAcpRecord(record) && canonicalDirectory(record.projectRoot) === canonicalDirectory(root)) }
function reset(): IpcFail { return ipcFail(IpcErrorCode.Conflict, '历史读取来源或快照已改变，请刷新后重试', { resetRequired: true }) }

/** Read-only bounded snapshots remain accessible when the archive fails; limits stay explicit. */
export function snapshotHistorySession(root: string, id: string, error: string): { ok: true; version: 1; session: AcpHistorySummary } | IpcFail {
  const record = records(root).find((item) => item.sessionId === id)
  return record ? { ok: true, version: 1, session: summary(record, error) } : ipcFail(IpcErrorCode.NotFound, '当前项目没有此会话')
}
export function snapshotHistoryEvents(root: string, id: string, input: unknown, error: string): AcpHistoryEventPage | IpcFail {
  const parsed = acpHistoryEventsInputSchema.safeParse(input)
  if (parsed.success && parsed.data?.tail) return ipcFail(IpcErrorCode.Conflict, '历史存储已变化，请重新读取会话。')
  if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '正文分页参数无效')
  const options = parsed.data ?? {}
  const record = records(root).find((item) => item.sessionId === id)
  if (!record) return ipcFail(IpcErrorCode.NotFound, '当前项目没有此会话')
  const sourceEvents = record.events
  if (options.before && options.after) return reset()
  const revision = createHash('sha256').update(JSON.stringify(record.events)).digest('hex')
  const rootKey = canonicalDirectory(root)
  let boundary: number | undefined
  if (options.before || options.after) {
    try {
      const cursor = decode(options.before ?? options.after ?? '')
      if (cursor.kind !== 'snapshot-events' || cursor.root !== rootKey || cursor.id !== id || cursor.revision !== revision || !Number.isSafeInteger(cursor.index)) return reset()
      boundary = Number(cursor.index)
      if (boundary < 0 || boundary >= record.events.length) return reset()
    } catch { return reset() }
  }
  function* metadata(): Generator<ReturnType<typeof historyEventMetadata>> {
    for (const [index, event] of sourceEvents.entries()) yield historyEventMetadata(event, index)
  }
  let selection: ReturnType<typeof selectHistoryTurns>
  try { selection = selectHistoryTurns(metadata(), { root: rootKey, sessionId: id, after: !!options.after, bound: boundary, limit: options.limit }) }
  catch (error) { if (error instanceof HistoryTurnBoundaryError) return reset(); throw error }
  const { first, last, startsMidTurn, oversized } = selection
  const session = summary(record, error)
  const cursor = (index: number): string => encode({ kind: 'snapshot-events', root: rootKey, id, revision, index })
  const hasEarlier = first !== undefined && first > 0
  const hasLater = last !== undefined && last < record.events.length - 1
  return { ok: true, version: 1, session, events: first === undefined || last === undefined ? [] : record.events.slice(first, last + 1).map(historicalEvent), hasEarlier, hasLater,
    beforeCursor: hasEarlier ? cursor(first) : null, afterCursor: hasLater ? cursor(last) : null,
    startsMidTurn, oversized, coverage: session.historyCoverage, historyPersistence: session.historyPersistence }
}
