import type { DatabaseSync } from 'node:sqlite'
import type { AcpHistorySummary } from '../../../shared/acp-history'

export interface HandoffArchive {
  checkpointEventId: string
  checkpointSeq: number
  tailSeq: number
  context: string
  includedMessages: number
  latestTurnIncluded: boolean
  omittedMessages: number
  attachments: number
  toolCalls: number
  truncated: boolean
  coverage: 'complete' | 'partial' | 'unknown'
}
interface Row {
  seq: number; eventId: string; kind: string; generation: string | null; turnId: string | null
  role: string | null; messageId: string | null; textBytes: number; images: number
  status: string | null; stopReason: string | null
}
interface SavedTurn {
  first: number; last: number; generation: string; turnId: string
  bytes: number; messages: number; user: boolean; previousMessage?: string; hostStopped?: boolean
}
export class HandoffHistoryError extends Error {}
const MAX_CONTEXT_TURNS = 64

/** Body-free scan followed by bounded text-only hydration. Images, tool payloads and
 * compatibility snapshots never become a second transcript authority. */
export function readHandoffArchive(db: DatabaseSync, root: string, session: AcpHistorySummary, byteLimit: number): HandoffArchive {
  if (session.schemaVersion !== 2 || session.historyPersistence.state !== 'saved' || session.historyPersistence.pendingCount) {
    throw new HandoffHistoryError('源会话历史尚未完整保存，请完成保存后重试')
  }
  const id = session.sessionId
  const tail = db.prepare('SELECT MAX(seq) seq FROM events WHERE root=? AND sessionId=?').get(root, id) as { seq: number | null }
  const rows = db.prepare(`SELECT seq,eventId,kind,
    json_extract(payload,'$.connectionGeneration') generation,json_extract(payload,'$.turnId') turnId,
    json_extract(payload,'$.payload.role') role,json_extract(payload,'$.payload.messageId') messageId,
    CASE WHEN kind='message' THEN length(CAST(COALESCE(json_extract(payload,'$.text'),'') AS BLOB)) ELSE 0 END textBytes,
    CASE WHEN kind='message' THEN COALESCE(json_array_length(payload,'$.payload.images'),0) ELSE 0 END images,
    CASE WHEN json_extract(payload,'$.payload.hostPolicyOutcome.authority')='host-policy'
      AND json_extract(payload,'$.payload.hostPolicyOutcome.status')='cancelled'
      AND json_extract(payload,'$.payload.hostPolicyOutcome.cause')='retry-beyond-turn-budget'
      AND json_extract(payload,'$.payload.hostPolicyOutcome.turnId')=json_extract(payload,'$.turnId')
      AND json_extract(payload,'$.payload.hostPolicyOutcome.connectionGeneration')=json_extract(payload,'$.connectionGeneration')
      THEN 'cancelled' ELSE json_extract(payload,'$.payload.result.status') END status,
    COALESCE(json_extract(payload,'$.payload.result.stopReason'),json_extract(payload,'$.payload.stopReason')) stopReason
    FROM events WHERE root=? AND sessionId=? AND json_extract(payload,'$.source') IN ('acp','pi')
    AND json_extract(payload,'$.sessionId')=? AND COALESCE(json_extract(payload,'$.payload.activityScope'),'turn')<>'connection'
    AND (kind IN ('message','thought','tool-call','permission','plan','turn-done')
      OR (kind='diagnostic' AND json_extract(payload,'$.payload.cancellationCause')='retry-beyond-turn-budget'
        AND json_extract(payload,'$.payload.nativeRetry.reason')='free_tier_limit'
        AND json_extract(payload,'$.payload.nativeRetry.turnId')=json_extract(payload,'$.turnId')
        AND json_extract(payload,'$.payload.nativeRetry.connectionGeneration')=json_extract(payload,'$.connectionGeneration')))
    ORDER BY seq`).iterate(root, id, id) as unknown as Iterable<Row>
  const selected: SavedTurn[] = []
  let current: SavedTurn | undefined
  let last: Row | undefined
  let checkpoint: Row | undefined
  let selectedBytes = 0
  let totalMessages = 0
  let attachments = 0
  for (const row of rows) {
    last = row
    if (!row.generation || !row.turnId) { current = undefined; continue }
    if (!current || current.generation !== row.generation || current.turnId !== row.turnId) {
      current = { first: row.seq, last: row.seq, generation: row.generation, turnId: row.turnId, bytes: 160, messages: 0, user: false }
    }
    current.last = row.seq
    if (row.kind === 'diagnostic') current.hostStopped = true
    const message = row.kind === 'message' && (row.role === 'user' || row.role === 'assistant' || row.role === null) && (row.textBytes > 0 || row.images > 0)
    if (message) {
      const role = row.role ?? 'assistant'
      const key = `${role}\0${row.messageId ?? ''}`
      // A second user opening under a reused ID is a new occurrence, not one turn.
      if (role === 'user' && current.user) {
        current = { first: row.seq, last: row.seq, generation: row.generation, turnId: row.turnId, bytes: 160, messages: 0, user: false }
      }
      if (current.previousMessage !== key || role === 'user') { current.messages++; totalMessages++; current.bytes += 64 }
      current.previousMessage = key
      current.user ||= role === 'user'
      current.bytes += row.textBytes + row.images * 64
      attachments += row.images
    }
    if (row.kind !== 'turn-done') continue
    if (current.user && !current.hostStopped && row.status === 'completed' && row.stopReason === 'end_turn') {
      checkpoint = row
      if (current.bytes <= byteLimit) {
        selected.push(current); selectedBytes += current.bytes
        while (selected.length > 1 && (selectedBytes > byteLimit || selected.length > MAX_CONTEXT_TURNS)) {
          const removed = selected.shift()
          if (removed) selectedBytes -= removed.bytes
        }
      }
    }
    current = undefined
  }
  if (!last || !checkpoint || checkpoint.seq !== last.seq || !tail.seq) {
    throw new HandoffHistoryError('只能从已保存且正常完成的完整回合接续；请先结束当前操作并完成一轮对话')
  }
  const chunks: string[] = []
  let includedMessages = 0
  let latestTurnIncluded = false
  const textRows = db.prepare(`SELECT json_extract(payload,'$.text') text,
    COALESCE(json_extract(payload,'$.payload.role'),'assistant') role,json_extract(payload,'$.payload.messageId') messageId,
    COALESCE(json_array_length(payload,'$.payload.images'),0) images
    FROM events WHERE root=? AND sessionId=? AND seq>=? AND seq<=? AND kind='message'
    AND json_extract(payload,'$.source') IN ('acp','pi') AND json_extract(payload,'$.sessionId')=? ORDER BY seq`)
  for (const turn of selected) {
    const messages: Array<{ key: string; role: string; text: string }> = []
    for (const row of textRows.iterate(root, id, turn.first, turn.last, id)) {
      const role = row.role === 'user' ? 'User' : 'Assistant'
      if (row.role !== 'user' && row.role !== 'assistant') continue
      const content = (typeof row.text === 'string' ? row.text : '') + (Number(row.images) ? `\n[${Number(row.images)} image attachment(s) omitted]` : '')
      if (!content) continue
      const key = `${role}\0${String(row.messageId ?? '')}`
      const previous = messages.at(-1)
      if (previous?.key === key && role !== 'User') previous.text += content
      else messages.push({ key, role, text: content })
    }
    const text = `### Saved turn (archive ${turn.first}–${turn.last})\n\n${messages.map(message => `${message.role}:\n${message.text}`).join('\n\n')}`
    // Estimates are conservative, but enforce the actual UTF-8 bound as well.
    if (Buffer.byteLength([...chunks, text].join('\n\n')) > byteLimit) continue
    chunks.push(text); includedMessages += messages.length
    if (turn.last === checkpoint.seq && messages.length > 0) latestTurnIncluded = true
  }
  const tools = db.prepare(`SELECT COUNT(DISTINCT COALESCE(json_extract(payload,'$.connectionGeneration'),'') || char(0) ||
    COALESCE(turnId,'') || char(0) || COALESCE(json_extract(payload,'$.payload.toolCallId'),eventId)) count
    FROM events WHERE root=? AND sessionId=? AND seq<=? AND kind='tool-call' AND json_extract(payload,'$.source') IN ('acp','pi')
    AND json_extract(payload,'$.sessionId')=?`).get(root, id, checkpoint.seq, id) as { count: number }
  return { checkpointEventId: checkpoint.eventId, checkpointSeq: checkpoint.seq, tailSeq: tail.seq,
    context: chunks.join('\n\n'), includedMessages, latestTurnIncluded, omittedMessages: Math.max(0, totalMessages - includedMessages),
    attachments, toolCalls: tools.count, truncated: includedMessages < totalMessages || attachments > 0 || tools.count > 0,
    coverage: session.historyCoverage.state }
}
