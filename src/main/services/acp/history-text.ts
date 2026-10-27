import type { DatabaseSync } from 'node:sqlite'
import type { TimelineEvent } from '../../../shared/types'
import { replayConversationTextEvents } from '../../../shared/acp-text-blocks'

/** Text-only hydration excludes image bytes/tool bodies but retains authoritative block metadata. */
export function readHistoryText(db: DatabaseSync, root: string, id: string, first: number, last: number): TimelineEvent[] {
  const rows = db.prepare(`SELECT eventId,ts,kind,json_extract(payload,'$.source') source,
    json_extract(payload,'$.projectRoot') projectRoot,json_extract(payload,'$.sessionId') sessionId,
    json_extract(payload,'$.connectionGeneration') generation,turnId,
    json_extract(payload,'$.text') text,json_extract(payload,'$.payload.role') role,
    json_extract(payload,'$.payload.messageId') messageId,json_extract(payload,'$.payload.meta.piText') piText,
    json_extract(payload,'$.payload.meta.phase') phase,COALESCE(json_array_length(payload,'$.payload.images'),0) images
    FROM events WHERE root=? AND sessionId=? AND seq>=? AND seq<=? AND kind='message'
    AND json_extract(payload,'$.source') IN ('acp','pi')
    AND (json_extract(payload,'$.sessionId') IS NULL OR json_extract(payload,'$.sessionId')=?) ORDER BY seq`).iterate(root, id, first, last, id)
  const events: TimelineEvent[] = []
  let bytes = 0
  for (const row of rows) {
    const text = typeof row.text === 'string' ? row.text : ''
    bytes += Buffer.byteLength(text) + Buffer.byteLength(String(row.piText ?? '')) + 512
    if (bytes > 16 * 1024 * 1024) throw new Error('会话正文超过摘要读取限额，未生成摘要')
    events.push({ id: String(row.eventId), ts: Number(row.ts), kind: 'message', source: row.source === 'pi' ? 'pi' : 'acp',
      projectRoot: typeof row.projectRoot === 'string' ? row.projectRoot : '',
      sessionId: typeof row.sessionId === 'string' ? row.sessionId : undefined,
      connectionGeneration: typeof row.generation === 'string' ? row.generation : undefined,
      turnId: typeof row.turnId === 'string' ? row.turnId : undefined, text,
      payload: { ...(row.role !== null ? { role: row.role } : {}), ...(row.messageId !== null ? { messageId: row.messageId } : {}),
        historyImageCount: Number(row.images), meta: { ...(row.piText !== null ? { piText: JSON.parse(String(row.piText)) } : {}), ...(row.phase !== null ? { phase: row.phase } : {}) } } })
  }
  return replayConversationTextEvents(events)
}
