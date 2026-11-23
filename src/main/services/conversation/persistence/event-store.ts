import { createHash } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import * as DateTime from 'effect/DateTime'
import * as Schema from 'effect/Schema'
import type { ConversationEventPage, ConversationHostEvent, ConversationWireEvent } from '../../../../shared/conversation/desktop'
import {
  OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
  OrchestrationV2StoredEvent,
} from '../../../../shared/conversation/contracts'

const decodeDomainEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)
const decodeStoredEvent = Schema.decodeUnknownSync(OrchestrationV2StoredEvent)
const encodeDomainEvent = Schema.encodeSync(OrchestrationV2DomainEventJson)

const text = (value: unknown): string | null => (value == null ? null : String(value))

function rowToStoredEvent(row: Record<string, unknown>): OrchestrationV2StoredEvent {
  const event = decodeDomainEvent(JSON.parse(String(row.payload_json)))
  return decodeStoredEvent({ sequence: row.sequence, commandId: row.command_id, event })
}

/**
 * One append, one transaction. Event rows commit together or not at all; callers that need
 * receipts and outbox entries in the same unit pass them through ConversationEventSink.
 */
export class ConversationEventStore {
  constructor(private readonly database: DatabaseSync) {}

  append(input: {
    readonly commandId?: string
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>
  }): ReadonlyArray<OrchestrationV2StoredEvent> {
    if (input.events.length === 0) return []
    const insert = this.database.prepare(`
      INSERT INTO conversation_v2_events (
        event_id, command_id, thread_id, run_id, node_id, provider, provider_instance_id,
        raw_event_id, event_type, occurred_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const stored: OrchestrationV2StoredEvent[] = []
    const persist = (): void => {
      for (const event of input.events) {
        const payload = JSON.stringify(encodeDomainEvent(event))
        const record = event as unknown as Record<string, unknown>
        const parameters: SQLInputValue[] = [
          event.id, input.commandId ?? null, event.threadId,
          text(record.runId), text(record.nodeId), text(record.provider), text(record.providerInstanceId), text(record.rawEventId),
          event.type, DateTime.formatIso(event.occurredAt), payload,
        ]
        insert.run(...parameters)
        const sequence = (this.database.prepare('SELECT last_insert_rowid() AS sequence').get() as { sequence: number }).sequence
        stored.push(decodeStoredEvent({ sequence, commandId: input.commandId ?? null, event }))
      }
    }
    if (this.database.isTransaction) { persist(); return stored }
    this.database.exec('BEGIN IMMEDIATE')
    try { persist(); this.database.exec('COMMIT') }
    catch (error) { this.database.exec('ROLLBACK'); throw error }
    return stored
  }

  appendHostEvents(events: ReadonlyArray<ConversationHostEvent>): void {
    const insert = this.database.prepare(`INSERT INTO conversation_v2_events
      (event_id, thread_id, run_id, event_type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)`)
    for (const event of events) {
      insert.run(event.id, event.threadId, event.runId, event.type, event.occurredAt, JSON.stringify(event))
    }
  }

  read(input?: { readonly threadId?: string; readonly afterSequence?: number; readonly eventType?: string; readonly limit?: number }): OrchestrationV2StoredEvent[] {
    const conditions = ["event_type NOT IN ('crux.run-evidence', 'crux.message-delta')"]
    const parameters: SQLInputValue[] = []
    if (input?.threadId !== undefined) { conditions.push('thread_id = ?'); parameters.push(input.threadId) }
    if (input?.afterSequence !== undefined) { conditions.push('sequence > ?'); parameters.push(input.afterSequence) }
    if (input?.eventType !== undefined) { conditions.push('event_type = ?'); parameters.push(input.eventType) }
    parameters.push(input?.limit ?? 200)
    const rows = this.database.prepare(
      `SELECT * FROM conversation_v2_events ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY sequence LIMIT ?`,
    ).all(...parameters) as Array<Record<string, unknown>>
    return rows.map(rowToStoredEvent)
  }

  readPage(threadId: string, afterSequence: number, limit: number): ConversationEventPage {
    const rows = this.database.prepare(`SELECT sequence, payload_json FROM conversation_v2_events
      WHERE thread_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`)
      .all(threadId, afterSequence, limit + 1) as { sequence: number; payload_json: string }[]
    const events: Array<{ sequence: number; event: ConversationWireEvent }> = []
    let bytes = 0
    for (const row of rows.slice(0, limit)) {
      bytes += Buffer.byteLength(row.payload_json)
      if (events.length > 0 && bytes > 512 * 1024) break
      events.push({ sequence: row.sequence, event: JSON.parse(row.payload_json) as ConversationWireEvent })
    }
    return { events, nextSequence: events.at(-1)?.sequence ?? afterSequence, hasMore: events.length < rows.length }
  }

  readByCommandId(commandId: string): OrchestrationV2StoredEvent[] {
    const rows = this.database.prepare('SELECT * FROM conversation_v2_events WHERE command_id = ? ORDER BY sequence').all(commandId) as Array<Record<string, unknown>>
    return rows.map(rowToStoredEvent)
  }

  latestSequence(threadId?: string): number {
    const row = threadId === undefined
      ? this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM conversation_v2_events').get() as { sequence: number }
      : this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM conversation_v2_events WHERE thread_id = ?').get(threadId) as { sequence: number }
    return row.sequence
  }
}

export interface CommandReceiptRow {
  readonly commandId: string
  readonly threadId: string
  readonly commandType: string
  readonly payloadDigest: string
  readonly acceptedAt: string
  readonly resultSequence: number
  readonly status: 'accepted' | 'rejected'
  readonly error: string | null
}

const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonicalJson((value as Record<string, unknown>)[key])]))
  }
  return value
}

/** Key order and whitespace never change a command's identity. */
export const commandPayloadDigest = (payload: unknown): string => createHash('sha256').update(JSON.stringify(canonicalJson(payload))).digest('hex')

/** Same commandId and payload replays the original receipt; a different payload is a conflict. */
export class ConversationCommandReceiptStore {
  constructor(private readonly database: DatabaseSync) {}

  getByCommandId(commandId: string): CommandReceiptRow | undefined {
    const row = this.database.prepare('SELECT * FROM conversation_v2_command_receipts WHERE command_id = ?').get(commandId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : {
      commandId: String(row.command_id), threadId: String(row.thread_id), commandType: String(row.command_type),
      payloadDigest: String(row.payload_digest), acceptedAt: String(row.accepted_at), resultSequence: Number(row.result_sequence),
      status: row.status === 'rejected' ? 'rejected' : 'accepted', error: text(row.error),
    }
  }

  insertAccepted(input: { readonly commandId: string; readonly threadId: string; readonly commandType: string; readonly payloadDigest: string; readonly acceptedAt: string; readonly resultSequence: number }): void {
    this.database.prepare(`
      INSERT INTO conversation_v2_command_receipts (command_id, thread_id, command_type, payload_digest, accepted_at, result_sequence, status, error)
      VALUES (?, ?, ?, ?, ?, ?, 'accepted', NULL)
    `).run(input.commandId, input.threadId, input.commandType, input.payloadDigest, input.acceptedAt, input.resultSequence)
  }

  insertRejected(input: { readonly commandId: string; readonly threadId: string; readonly commandType: string; readonly payloadDigest: string; readonly rejectedAt: string; readonly error: string }): void {
    this.database.prepare(`
      INSERT INTO conversation_v2_command_receipts (command_id, thread_id, command_type, payload_digest, accepted_at, result_sequence, status, error)
      VALUES (?, ?, ?, ?, ?, 0, 'rejected', ?)
    `).run(input.commandId, input.threadId, input.commandType, input.payloadDigest, input.rejectedAt, input.error)
  }
}
