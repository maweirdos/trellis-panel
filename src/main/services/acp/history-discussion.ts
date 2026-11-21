import type { DatabaseSync } from 'node:sqlite'
import type { AcpHistoryEventPage } from '../../../shared/acp-history'
import type { TimelineEvent } from '../../../shared/types'
import { readConversationTextBlock } from '../../../shared/acp-text-blocks'
import { readHistoryText } from './history-text'

function messages(events: TimelineEvent[]): TimelineEvent[] {
  const result: TimelineEvent[] = []
  for (const event of events) {
    const previous = result.at(-1), id = event.payload?.messageId, previousId = previous?.payload?.messageId
    const sameMessage = id === undefined && previousId === undefined || typeof id === 'string' && id === previousId
    if (previous && event.payload?.role !== 'user' && previous.payload?.role !== 'user' && sameMessage && !readConversationTextBlock(event) && !readConversationTextBlock(previous)
      && event.source === previous.source && event.projectRoot === previous.projectRoot && event.sessionId === previous.sessionId && event.connectionGeneration === previous.connectionGeneration && event.turnId === previous.turnId) previous.text = (previous.text ?? '') + (event.text ?? '')
    else result.push({ ...event })
  }
  return result
}

/** Preserve the original idea and recent question/answer pairs without hydrating tools or images. */
export function readHistoryDiscussion(db: DatabaseSync, root: string, sessionId: string): NonNullable<AcpHistoryEventPage['discussion']> {
  const users = db.prepare(`SELECT seq FROM events WHERE root=? AND sessionId=? AND kind='message'
    AND json_extract(payload,'$.source') IN ('acp','pi') AND json_extract(payload,'$.payload.role')='user'
    ORDER BY seq`).all(root, sessionId) as unknown as Array<{ seq: number }>
  const selected = new Set([...users.slice(0, 4), ...users.slice(-12)].map(row => row.seq))
  const last = db.prepare('SELECT MAX(seq) seq FROM events WHERE root=? AND sessionId=?').get(root, sessionId) as { seq: number | null }
  const events: NonNullable<AcpHistoryEventPage['discussion']>['events'] = []
  let remaining = 60_000, truncated = selected.size < users.length
  for (let index = 0; index < users.length; index++) {
    const first = users[index].seq
    if (!selected.has(first) || last.seq === null) continue
    const through = (users[index + 1]?.seq ?? last.seq + 1) - 1
    let turnRemaining = Math.floor(60_000 / Math.max(1, selected.size)), turnMessages = 0
    try {
      for (const event of messages(readHistoryText(db, root, sessionId, first, through))) {
        if (!event.text?.trim() || event.kind !== 'message') continue
        if (turnMessages++ >= 16) { truncated = true; continue }
        // Keep space for later answers rather than letting one long draft consume the context.
        const text = event.text.slice(0, Math.min(8000, remaining, turnRemaining))
        if (text.length < event.text.length) truncated = true
        if (!text) { truncated = true; continue }
        remaining -= text.length; turnRemaining -= text.length
        events.push({ ...event, text, payload: { role: event.payload?.role ?? 'assistant' } })
      }
    } catch { truncated = true }
  }
  return { events, truncated }
}
