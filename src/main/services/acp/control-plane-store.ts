import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import {
  acpConversationDetailInputSchema,
  acpConversationEventsInputSchema,
  acpConversationListInputSchema,
  acpConversationListSnapshotSchema,
  acpConversationDetailSnapshotSchema,
  acpConversationEventPageSchema,
  acpConversationProjectionEventSchema,
  acpTurnItemProjectionSchema,
  type AcpConversationDetailInput,
  type AcpConversationEventsInput,
  type AcpConversationEventPage,
  type AcpConversationHistoryCoverage,
  type AcpConversationListInput,
  type AcpConversationListSnapshot,
  type AcpConversationDetailSnapshot,
  type AcpConversationProjectionEvent,
  type AcpTurnItemProjection,
  type AcpTurnItemVariant,
} from '../../../shared/acp-projections'
import { readConversationTextBlock } from '../../../shared/acp-text-blocks'
import type { AcpSessionMeta, TimelineEvent } from '../../../shared/types'
import { truncateDetail } from './t3-core/wire-projection'
import type { AcpV2NativeRecord } from './v2/persistence'
import { hasAcpCapability } from './v2/normalize'
import { CONTROL_PLANE_DDL, CONTROL_PLANE_SCHEMA_VERSION } from './control-plane-schema'

export class AcpControlPlaneCursorError extends Error {
  constructor(readonly reason: 'cursor-ahead' | 'conversation-reset' | 'store-reset') {
    super('Conversation projection cursor is no longer resumable')
  }
}

export class AcpControlPlaneStoreError extends Error {
  constructor(message: string) { super(message) }
}

export interface AcpArchiveProjectionSource {
  root: string
  meta: AcpSessionMeta
  sourceEpoch: string
  sourceDigest: string
  throughSequence: number
  lastActivityAt: number
  remainingEventCount: number
  events: Array<TimelineEvent & { historySeq: number }>
  coverageState: AcpConversationHistoryCoverage['state']
  coverageReason?: string
  nativeSessionId?: string
}

interface SequenceRow { currentSequence: number; storeEpoch: string; schemaVersion: number }
interface ConversationRow {
  conversationId: string; sourceRoot: string; sourceSessionId: string; sourceEngine: 'acp' | 'pi';
  title: string; archivedAt: number | null; pinnedAt: number | null; lastActivityAt: number;
  createdAt: number; updatedAt: number; lastSequence: number
}
interface RuntimeRow { runtimeSessionId: string; state: string; lastObservedAt: number | null; recoverable: number; engine: 'acp' | 'pi' }
interface ProviderRow { providerInstanceId: string }
interface ItemRow {
  id: string; turnId: string; conversationId: string; ordinal: number; sourceEventId: string;
  sourceSequence: number; occurredAt: number; sequence: number; kind: string; payload: string
}
interface EventRow { sequence: number; conversationId: string; type: string; occurredAt: number; payload: string }
interface MigrationRow { state: string; sourceDigest: string; sourceLastSequence: number | null; sourceEventCount: number; projectedEventCount: number; diagnostic: string | null }
interface ArchiveProgressRow { sourceEpoch: string; sourceSequence: number }
interface V2ProgressRow { sourceDigest: string; sourceOffset: number; sourceCount: number }

const PAGE_BYTES = 2 * 1024 * 1024

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function conversationId(root: string, sessionId: string, engine: 'acp' | 'pi'): string {
  return `cp-${createHash('sha256').update(JSON.stringify([root, sessionId, engine])).digest('hex').slice(0, 32)}`
}

function boundedText(value: unknown, fallback = ''): string {
  return truncateDetail(typeof value === 'string' ? value : undefined) ?? fallback
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function readNested(value: Record<string, unknown>, ...keys: readonly string[]): unknown {
  let current: unknown = value
  for (const key of keys) {
    current = readRecord(current)?.[key]
  }
  return current
}

function turnIdFor(root: string, sessionId: string, event: TimelineEvent): string {
  const scope = event.turnId ?? event.connectionGeneration ?? `session:${event.sessionId ?? sessionId}`
  return `turn-${createHash('sha256').update(JSON.stringify([root, sessionId, scope])).digest('hex').slice(0, 32)}`
}

function itemVariant(event: TimelineEvent): AcpTurnItemVariant {
  const source = event.source === 'pi' ? 'pi' : event.source === 'acp' ? 'acp' : 'trellis'
  const role = typeof event.payload?.role === 'string' ? event.payload.role : ''
  if ((source === 'acp' || source === 'pi') && event.kind === 'message' && role === 'user') return { kind: 'user-message', text: boundedText(event.text) }
  if ((source === 'acp' || source === 'pi') && event.kind === 'message') {
    const images = Array.isArray(event.payload?.images) ? event.payload.images.length : 0
    if (images > 0) return { kind: 'image', count: Math.min(images, 1000) }
    return { kind: 'assistant-message', text: boundedText(event.text ?? event.payload?.meta) }
  }
  if (event.kind === 'thought') return { kind: 'reasoning', text: boundedText(event.text) }
  if (event.kind === 'tool-call') {
    const title = typeof event.payload?.title === 'string' ? event.payload.title : undefined
    const status = typeof event.payload?.status === 'string' ? event.payload.status.slice(0, 120) : undefined
    return { kind: 'tool-call', title: boundedText(title ?? event.text, 'Tool call').slice(0, 2000), ...(status ? { status } : {}) }
  }
  if (event.kind === 'permission') {
    const toolCall = event.payload?.toolCall
    const title = toolCall && typeof toolCall === 'object' && 'title' in toolCall && typeof toolCall.title === 'string' ? toolCall.title : undefined
    return { kind: 'permission', title: boundedText(title ?? event.text, 'Permission').slice(0, 2000), pending: event.payload?.pending === true }
  }
  if (event.kind === 'plan') return { kind: 'plan', text: boundedText(event.text) }
  if (event.kind === 'session-status' && event.payload?.runtimeTelemetry instanceof Object) {
    const telemetry = event.payload.runtimeTelemetry as Record<string, unknown>
    const providerFamily = typeof telemetry.providerFamily === 'string' ? telemetry.providerFamily : 'unknown'
    const cause = typeof telemetry.cause === 'string' ? telemetry.cause : 'unknown'
    const reason = typeof telemetry.reason === 'string' ? telemetry.reason : 'unknown'
    return { kind: 'system-marker', text: `runtime ${providerFamily} ${cause} ${reason}`.slice(0, 2000) }
  }
  if (event.kind === 'turn-done' || event.kind === 'session-status' || event.kind === 'task-status' || event.kind === 'material-change') return { kind: 'status', text: boundedText(event.text) }
  if (event.kind === 'message' || event.kind === 'diagnostic') return { kind: 'diagnostic', text: boundedText(event.text ?? event.payload) }
  return { kind: 'system-marker', text: boundedText(event.text ?? event.kind, event.kind).slice(0, 2000) }
}

function itemProjection(row: ItemRow): AcpTurnItemProjection {
  return acpTurnItemProjectionSchema.parse({
    id: row.id, turnId: row.turnId, conversationId: row.conversationId, ordinal: row.ordinal,
    sourceEventId: row.sourceEventId, sourceSequence: row.sourceSequence, occurredAt: row.occurredAt,
    sequence: row.sequence, item: JSON.parse(row.payload),
  })
}

function sqliteInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

function sqliteText(value: string | undefined): string | null {
  return value ?? null
}

function nativeItemKey(sessionId: string, kind: TimelineEvent['kind'] | 'prompt', nativeId: string): string {
  return `v2:${digest([sessionId, kind, nativeId])}`
}

type NativeTimelineEvent = TimelineEvent & { legacyUserOccurrence?: number }

function v2TimelineEvents(root: string, record: AcpV2NativeRecord): NativeTimelineEvent[] {
  const events: NativeTimelineEvent[] = []
  const legacyUsers = new Map<string, number>()
  const append = (nativeId: string, kind: TimelineEvent['kind'], text: string, payload?: Record<string, unknown>,
    promptTurnId?: string, legacyUser = false): void => {
    const bounded = boundedText(text)
    const legacyUserOccurrence = legacyUser ? legacyUsers.get(bounded) ?? 0 : undefined
    if (legacyUserOccurrence !== undefined) legacyUsers.set(bounded, legacyUserOccurrence + 1)
    events.push({
      id: promptTurnId === undefined ? nativeItemKey(record.nativeSessionId, kind, nativeId) : nativeItemKey(record.nativeSessionId, 'prompt', promptTurnId),
      ts: record.updatedAt,
      source: 'acp',
      sessionId: record.sessionKey,
      projectRoot: root,
      kind,
      text: bounded,
      payload,
      turnId: promptTurnId,
      legacyUserOccurrence,
    })
  }
  for (const entity of record.aggregate.messages) {
    const value = readRecord(entity.value)
    if (value === undefined) continue
    const user = value.tag === 'user_message' || value.tag === 'user_message_chunk'
    const projection = readRecord(value.projection)
    const promptTurnId = user && typeof projection?.promptTurnId === 'string' ? projection.promptTurnId : undefined
    append(entity.nativeId, value.stream === 'thought' ? 'thought' : 'message', typeof value.text === 'string' ? value.text : '',
      { role: user ? 'user' : 'assistant' }, promptTurnId, user && projection === undefined)
  }
  for (const entity of record.aggregate.toolCalls) {
    const value = readRecord(entity.value)
    if (value !== undefined) append(entity.nativeId, 'tool-call', typeof value.title === 'string' && value.title.length > 0 ? value.title : entity.nativeId, { status: value.status })
  }
  for (const entity of record.aggregate.plans) {
    const value = readRecord(entity.value)
    if (value !== undefined) append(entity.nativeId, 'plan', typeof value.summary === 'string' && value.summary.length > 0 ? value.summary : entity.nativeId)
  }
  for (const entity of record.aggregate.sessionInfo) {
    const value = readRecord(entity.value)
    if (value !== undefined) append(`session-info:${entity.nativeId}`, 'session-status', 'ACP v2 会话信息已更新')
  }
  for (const entity of record.aggregate.notices) {
    const value = readRecord(entity.value)
    if (value !== undefined) append(`notice:${entity.nativeId}`, 'session-status', typeof value.message === 'string' ? value.message : typeof value.summary === 'string' ? value.summary : 'ACP v2 更新')
  }
  const terminal = record.aggregate.terminal.find(entity => entity.nativeId === 'terminal')
  const terminalValue = terminal === undefined ? undefined : readRecord(terminal.value)
  if (terminalValue !== undefined) append('terminal', 'session-status', `ACP v2 ${typeof terminalValue.state === 'string' ? terminalValue.state : 'unknown'}`)
  return events
}

export interface AcpV2ProjectionSource {
  readonly root: string
  readonly record: AcpV2NativeRecord
  readonly archiveHead?: number
  readonly budget: { readonly rows: number; readonly bytes: number }
}

export class AcpControlPlaneStore {
  private db: DatabaseSync
  private epoch: string
  private statements = new Map<string, StatementSync>()

  constructor(private readonly directory: string, private readonly storeId: string) {
    if (!isAbsolute(directory)) throw new AcpControlPlaneStoreError('Control-plane directory must be absolute')
    mkdirSync(directory, { recursive: true })
    this.db = new DatabaseSync(join(directory, 'control-plane.sqlite'))
    try {
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON;')
      const check = this.db.prepare('PRAGMA quick_check(1)').get() as { quick_check: string } | undefined
      if (check?.quick_check !== 'ok') throw new AcpControlPlaneStoreError('Control-plane database is damaged')
      this.db.exec(CONTROL_PLANE_DDL)
      const existing = this.selectOne<SequenceRow>('SELECT * FROM control_plane_sequence WHERE id=1')
      this.epoch = existing?.storeEpoch ?? randomUUID()
      this.transaction(() => {
        this.statement('INSERT OR IGNORE INTO control_plane_sequence(id,currentSequence,storeEpoch,schemaVersion) VALUES(1,0,?,?)')
          .run(this.epoch, CONTROL_PLANE_SCHEMA_VERSION)
        if (existing && existing.schemaVersion !== CONTROL_PLANE_SCHEMA_VERSION) throw new AcpControlPlaneStoreError('Unsupported control-plane schema version')
      })
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void { this.db.close() }
  get currentSequence(): number { return Number(this.selectOne<SequenceRow>('SELECT * FROM control_plane_sequence WHERE id=1')?.currentSequence ?? 0) }

  private statement(sql: string): StatementSync {
    let value = this.statements.get(sql)
    if (!value) { value = this.db.prepare(sql); this.statements.set(sql, value) }
    return value
  }

  private selectOne<T>(sql: string, ...params: Array<string | number | null>): T | undefined {
    return this.statement(sql).get(...params) as T | undefined
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = work(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private nextSequence(): number {
    const next = this.currentSequence + 1
    this.statement('UPDATE control_plane_sequence SET currentSequence=?, migratedAt=? WHERE id=1').run(next, Date.now())
    return next
  }

  private appendEvent(conversationId: string, type: string, occurredAt: number, payload: unknown, sequence?: number): number {
    const value = sequence ?? this.nextSequence()
    this.statement('INSERT OR IGNORE INTO control_plane_events(sequence,eventId,conversationId,type,occurredAt,payloadDigest,payload) VALUES(?,?,?,?,?,?,?)')
      .run(value, `${conversationId}:${type}:${value}`, conversationId, type, occurredAt, digest(payload), JSON.stringify(payload))
    return value
  }

  private writeMetadata(
    id: string,
    source: { root: string; meta: AcpSessionMeta; runtimeUnverified?: boolean },
    lastActivityAt: number,
    now: number,
    createdSequence: number,
  ): string {
    const { root, meta } = source
    const engine = meta.engine ?? 'acp'
    const title = boundedText(meta.title ?? meta.agentName ?? meta.sessionId).slice(0, 300)
    const createdAt = Math.max(0, Math.trunc(meta.startedAt || now))
    this.statement(`INSERT INTO conversation_projection(conversationId,sourceRoot,sourceSessionId,sourceEngine,title,archivedAt,pinnedAt,lastActivityAt,createdAt,updatedAt,lastSequence)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(conversationId) DO UPDATE SET
      title=excluded.title,archivedAt=excluded.archivedAt,pinnedAt=excluded.pinnedAt,lastActivityAt=MAX(conversation_projection.lastActivityAt,excluded.lastActivityAt),updatedAt=excluded.updatedAt`)
      .run(id, root, meta.sessionId, engine, title, sqliteInteger(meta.archivedAt), sqliteInteger(meta.pinnedAt),
        Math.max(createdAt, lastActivityAt), createdAt, now, createdSequence)

    const recoverable = meta.canResume === true && (engine === 'pi' || (meta.nativeRecordId !== undefined && meta.capabilities?.protocolVersion === 2))
    const runtimeState = source.runtimeUnverified ? 'unknown' : meta.status === 'busy' ? 'running' : meta.status === 'awaiting_permission' ? 'awaiting-permission'
      : meta.status === 'cancelling' ? 'stopping' : recoverable ? 'recoverable' : 'stopped'
    const runtimeSessionId = `rt-${digest([id, meta.connectionGeneration ?? 'legacy']).slice(0, 24)}`
    this.statement('DELETE FROM runtime_session_projection WHERE conversationId=? AND runtimeSessionId<>?').run(id, runtimeSessionId)
    this.statement('DELETE FROM provider_instance_projection WHERE conversationId=? AND providerInstanceId<>?').run(id, `${runtimeSessionId}:provider`)
    this.statement(`INSERT INTO runtime_session_projection(runtimeSessionId,conversationId,state,lastObservedAt,recoverable,engine) VALUES(?,?,?,?,?,?)
      ON CONFLICT(runtimeSessionId) DO UPDATE SET state=excluded.state,lastObservedAt=excluded.lastObservedAt,recoverable=excluded.recoverable,engine=excluded.engine`)
      .run(runtimeSessionId, id, runtimeState, sqliteInteger(meta.endedAt ?? lastActivityAt), recoverable ? 1 : 0, engine)
    this.statement(`INSERT INTO runtime_thread_projection(runtimeThreadId,conversationId,runtimeSessionId,nativeThreadId,identityStrength,recoverability) VALUES(?,?,?,?,?,?)
      ON CONFLICT(runtimeThreadId) DO UPDATE SET nativeThreadId=excluded.nativeThreadId,identityStrength=excluded.identityStrength,recoverability=excluded.recoverability`)
      .run(`${runtimeSessionId}:thread`, id, runtimeSessionId, meta.backendSessionId ?? null, meta.backendSessionId ? 'native' : 'session-only', recoverable ? 'recoverable' : 'unavailable')
    this.statement(`INSERT INTO provider_instance_projection(providerInstanceId,conversationId,launchKind,providerId,providerName,snapshotDigest,capabilityProjection) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(providerInstanceId) DO UPDATE SET launchKind=excluded.launchKind,providerId=excluded.providerId,providerName=excluded.providerName,snapshotDigest=excluded.snapshotDigest,capabilityProjection=excluded.capabilityProjection`)
      .run(`${runtimeSessionId}:provider`, id, engine, meta.agentId ?? 'unknown', sqliteText(meta.agentName), digest([meta.runtimeSnapshot ?? null]), JSON.stringify(meta.capabilities ?? {}))
    return runtimeSessionId
  }

  archiveCursor(root: string, sessionId: string, engine: 'acp' | 'pi', epoch: string, head: number): number {
    const progress = this.selectOne<ArchiveProgressRow>('SELECT sourceEpoch,sourceSequence FROM control_plane_archive_progress WHERE conversationId=?',
      conversationId(root, sessionId, engine))
    return progress?.sourceEpoch === epoch && progress.sourceSequence <= head ? progress.sourceSequence : 0
  }

  migrateArchive(source: AcpArchiveProjectionSource): void {
    const { root, meta, throughSequence, sourceEpoch, sourceDigest } = source
    const engine = meta.engine ?? 'acp'
    const id = conversationId(root, meta.sessionId, engine)
    const migration = this.migrationState(root, meta.sessionId, engine)
    const existing = this.selectOne<ArchiveProgressRow>('SELECT sourceEpoch,sourceSequence FROM control_plane_archive_progress WHERE conversationId=?', id)
    const resume = existing?.sourceEpoch === sourceEpoch && existing.sourceSequence <= throughSequence
    if (resume && migration?.sourceDigest === sourceDigest && source.events.length === 0) return

    this.transaction(() => {
      if (!resume && migration) this.statement('DELETE FROM conversation_projection WHERE conversationId=?').run(id)
      const now = Date.now()
      const createdSequence = this.nextSequence()
      const runtimeSessionId = this.writeMetadata(id, source, source.lastActivityAt, now, createdSequence)
      if (!resume) {
        this.appendEvent(id, migration ? 'projection-reset' : 'conversation-created', now, { sourceRoot: root, sourceSessionId: meta.sessionId, engine }, createdSequence)
      }
      let projectedCount = resume ? migration?.projectedEventCount ?? 0 : 0
      let sourceSequence = resume ? existing.sourceSequence : 0
      for (const event of source.events) {
        if (event.historySeq <= sourceSequence) continue
        if (this.ingestArchiveEvent(id, root, meta.sessionId, runtimeSessionId, event, source.nativeSessionId)) projectedCount += 1
        sourceSequence = event.historySeq
      }
      const complete = sourceSequence === throughSequence
      this.statement(`INSERT INTO control_plane_archive_progress(conversationId,sourceEpoch,sourceSequence) VALUES(?,?,?)
        ON CONFLICT(conversationId) DO UPDATE SET sourceEpoch=excluded.sourceEpoch,sourceSequence=excluded.sourceSequence`)
        .run(id, sourceEpoch, sourceSequence)
      this.writeMigration(source, complete ? source.coverageState : 'partial', throughSequence, projectedCount + source.remainingEventCount, projectedCount,
        complete ? source.coverageReason : (source.coverageReason ?? 'More archived events are available'), now)
      const finalSequence = this.appendEvent(id, 'conversation-updated', now, { projectedCount })
      this.statement('UPDATE conversation_projection SET lastSequence=? WHERE conversationId=?').run(finalSequence, id)
    })
  }

  private ingestArchiveEvent(id: string, root: string, sessionId: string, runtimeSessionId: string,
    event: TimelineEvent & { historySeq: number }, archiveSessionId?: string): boolean {
    const block = readConversationTextBlock(event)
    const meta = readRecord(event.payload?.meta)
    const structuredText = event.source === 'pi' ? meta?.piText : event.source === 'acp' ? meta?.acpText : undefined
    if (structuredText !== undefined && block === undefined) return false
    const sourceEventId = event.id.length <= 150 ? event.id : digest(event.id)
    const variant = itemVariant(event)
    const nativeSessionId = event.source === 'acp'
      ? (typeof event.payload?.nativeSessionId === 'string' ? event.payload.nativeSessionId : archiveSessionId) : undefined
    const messageId = typeof event.payload?.messageId === 'string' ? event.payload.messageId : undefined
    let nativeKey: string | undefined
    if (nativeSessionId !== undefined) {
      if ((event.kind === 'message' || event.kind === 'thought') && messageId !== undefined
        && (block === undefined || block.blockIndex === 0)) {
        nativeKey = nativeItemKey(nativeSessionId, event.kind, messageId)
      } else if (event.kind === 'message' && event.payload?.role === 'user' && event.turnId !== undefined) {
        nativeKey = nativeItemKey(nativeSessionId, 'prompt', event.turnId)
      } else if (event.kind === 'tool-call' && typeof event.payload?.toolCallId === 'string') {
        nativeKey = nativeItemKey(nativeSessionId, event.kind, event.payload.toolCallId)
      }
    }
    const itemId = nativeKey !== undefined ? `${id}:source:${nativeKey}` : block === undefined ? `${id}:source:${sourceEventId}`
      : `${id}:text:${digest([event.source, event.connectionGeneration, event.turnId, block.messageId, block.blockIndex, block.blockType])}`
    const previous = this.selectOne<ItemRow>('SELECT * FROM turn_item_projection WHERE id=?', itemId)
    const archivePayload = nativeKey === undefined && variant.kind !== 'user-message' ? undefined
      : this.selectOne<{ payload: string }>('SELECT payload FROM control_plane_archive_item_payload WHERE itemId=?', itemId)?.payload
    if (block?.operation === 'append' && 'text' in variant) {
      const prior = nativeKey === undefined ? previous?.payload : archivePayload
      const prefix = prior === undefined ? '' : (JSON.parse(prior) as { text?: string }).text ?? ''
      variant.text = boundedText(prefix + variant.text)
    }
    const archiveVariant = JSON.stringify(variant)
    const visible = previous === undefined ? undefined : readRecord(JSON.parse(previous.payload))
    if (nativeKey !== undefined && block?.operation === 'append' && 'text' in variant
      && typeof visible?.text === 'string' && visible.text.startsWith(variant.text)) variant.text = visible.text
    if (nativeKey !== undefined && variant.kind === 'tool-call' && archivePayload !== undefined && visible?.kind === 'tool-call') {
      const oldArchive = readRecord(JSON.parse(archivePayload))
      if (oldArchive?.title === variant.title && typeof visible.title === 'string') variant.title = visible.title
      if (oldArchive?.status === variant.status && typeof visible.status === 'string') variant.status = visible.status
    }
    this.writeItem({ id, itemId, root, sessionId, runtimeSessionId, event, sourceEventId, variant, previous, turnOrdinal: event.historySeq })
    if (nativeKey !== undefined || variant.kind === 'user-message') {
      this.statement(`INSERT INTO control_plane_archive_item_payload(itemId,conversationId,payload) VALUES(?,?,?)
        ON CONFLICT(itemId) DO UPDATE SET payload=excluded.payload`).run(itemId, id, archiveVariant)
    }
    return nativeKey !== undefined || variant.kind === 'user-message' ? archivePayload === undefined : previous === undefined
  }

  private writeItem(input: { id: string; itemId: string; root: string; sessionId: string; runtimeSessionId: string;
    event: TimelineEvent & { historySeq: number }; sourceEventId: string; variant: AcpTurnItemVariant; previous?: ItemRow; turnOrdinal: number }): boolean {
    const { id, itemId, root, sessionId, runtimeSessionId, event, sourceEventId, variant, previous, turnOrdinal } = input
    const payload = JSON.stringify(variant)
    if (previous?.payload === payload) return false
    const turnId = previous?.turnId ?? turnIdFor(root, sessionId, event)
    const occurredAt = previous?.occurredAt ?? Math.max(0, Math.trunc(event.ts))
    this.statement('INSERT OR IGNORE INTO turn_projection(turnId,conversationId,ordinal,status,providerRuntimeId,startedAt,endedAt) VALUES(?,?,?,?,?,?,?)')
      .run(turnId, id, turnOrdinal, 'archived', runtimeSessionId, occurredAt, null)
    if (event.kind === 'turn-done') {
      this.statement('UPDATE turn_projection SET endedAt=? WHERE turnId=?').run(occurredAt, turnId)
    }
    const sequence = this.nextSequence()
    const row: ItemRow = {
      id: itemId, turnId, conversationId: id, ordinal: previous?.ordinal ?? event.historySeq,
      sourceEventId: previous?.sourceEventId ?? sourceEventId, sourceSequence: previous?.sourceSequence ?? event.historySeq,
      occurredAt, sequence, kind: variant.kind, payload,
    }
    this.statement(`INSERT INTO turn_item_projection(id,turnId,conversationId,ordinal,sourceEventId,sourceSequence,occurredAt,sequence,kind,payload) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence,kind=excluded.kind,payload=excluded.payload`)
      .run(row.id, row.turnId, row.conversationId, row.ordinal, row.sourceEventId, row.sourceSequence, row.occurredAt, row.sequence, row.kind, row.payload)
    this.appendEvent(id, 'item-updated', Math.max(0, Math.trunc(event.ts)), { turnItem: itemProjection(row) }, sequence)
    return true
  }

  private writeMigration(
    source: { root: string; meta: AcpSessionMeta; sourceDigest: string },
    state: AcpConversationHistoryCoverage['state'],
    sourceLastSequence: number | null,
    sourceEventCount: number,
    projectedCount: number,
    diagnostic: string | undefined,
    now: number,
  ): void {
    this.statement(`INSERT INTO control_plane_migration(root,sessionId,engine,state,sourceLastSequence,sourceEventCount,projectedEventCount,sourceDigest,diagnostic,migratedAt)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(root,sessionId,engine) DO UPDATE SET state=excluded.state,sourceLastSequence=excluded.sourceLastSequence,
      sourceEventCount=excluded.sourceEventCount,projectedEventCount=excluded.projectedEventCount,sourceDigest=excluded.sourceDigest,diagnostic=excluded.diagnostic,migratedAt=excluded.migratedAt`)
      .run(source.root, source.meta.sessionId, source.meta.engine ?? 'acp', state, sourceLastSequence,
        sourceEventCount, projectedCount, source.sourceDigest, diagnostic?.slice(0, 2000) ?? null, now)
  }

  migrationState(root: string, sessionId: string, engine: 'acp' | 'pi'): MigrationRow | undefined {
    return this.selectOne<MigrationRow>('SELECT * FROM control_plane_migration WHERE root=? AND sessionId=? AND engine=?', root, sessionId, engine)
  }

  migrateV2(source: AcpV2ProjectionSource): void {
    const { record, root, archiveHead, budget } = source
    const id = conversationId(root, record.sessionKey, 'acp')
    const archive = this.selectOne<ArchiveProgressRow>('SELECT sourceEpoch,sourceSequence FROM control_plane_archive_progress WHERE conversationId=?', id)
    if (archiveHead !== undefined && archive?.sourceSequence !== archiveHead) return
    const events = v2TimelineEvents(root, record)
    const sourceDigest = digest([record.nativeSessionId, archive === undefined ? record.cleanupState : null, events.map(({ ts: _timestamp, ...event }) => event)])
    const progress = this.selectOne<V2ProgressRow>('SELECT * FROM control_plane_v2_progress WHERE conversationId=?', id)
    if (progress?.sourceDigest === sourceDigest && progress.sourceOffset === events.length) return
    const session = readRecord(record.negotiated.capabilities.session)
    const meta: AcpSessionMeta = {
      schemaVersion: 2,
      sessionId: record.sessionKey,
      projectRoot: root,
      cwd: record.cwd,
      agentId: record.negotiated.agent.name,
      agentName: record.negotiated.agent.title ?? record.negotiated.agent.name,
      status: record.cleanupState === 'live' ? 'ready' : 'disconnected',
      startedAt: record.updatedAt,
      capabilities: {
        controls: session === undefined ? [] : ['session/set_config_option', 'session/status'],
        loadSession: session !== undefined,
        promptCapabilities: {
          image: hasAcpCapability(readNested(record.negotiated.capabilities, 'session', 'prompt', 'image')),
          embeddedContext: hasAcpCapability(readNested(record.negotiated.capabilities, 'session', 'prompt', 'embeddedContext')),
        },
        protocolVersion: record.negotiated.protocolVersion,
        agentInfo: record.negotiated.agent,
        authMethods: [],
      },
      backendSessionId: record.nativeSessionId,
      nativeRecordId: record.recordId,
      canResume: record.cleanupState === 'closed' && session !== undefined,
    }
    this.transaction(() => {
      const now = Date.now()
      const conversation = this.selectOne<ConversationRow>('SELECT * FROM conversation_projection WHERE conversationId=?', id)
      let runtimeSessionId = this.selectOne<RuntimeRow>('SELECT * FROM runtime_session_projection WHERE conversationId=?', id)?.runtimeSessionId
      if (archive === undefined) {
        const sequence = this.nextSequence()
        runtimeSessionId = this.writeMetadata(id, { root, meta, runtimeUnverified: record.cleanupState !== 'closed' }, record.updatedAt, now, sequence)
        if (conversation === undefined) this.appendEvent(id, 'conversation-created', now, { sourceRoot: root, sourceSessionId: record.sessionKey, engine: 'acp' }, sequence)
      }
      if (runtimeSessionId === undefined) throw new AcpControlPlaneStoreError('ACP v2 projection runtime is missing')
      const start = progress?.sourceDigest === sourceDigest ? progress.sourceOffset : 0
      let offset = start
      let bytes = 0
      let changed = false
      let sourceSequence = Math.max(archiveHead ?? 0, this.selectOne<{ value: number }>(
        'SELECT COALESCE(MAX(sourceSequence),0) AS value FROM turn_item_projection WHERE conversationId=?', id)?.value ?? 0)
      for (const event of events.slice(start, start + budget.rows)) {
        const variant = itemVariant(event)
        const payload = JSON.stringify(variant)
        const size = Buffer.byteLength(payload) + 512
        if (bytes + size > budget.bytes) break
        bytes += size
        offset += 1
        const itemId = `${id}:source:${event.id}`
        if (archive !== undefined && variant.kind === 'user-message') {
          if (this.selectOne('SELECT 1 FROM control_plane_archive_item_payload WHERE itemId=?', itemId)) continue
          if (event.legacyUserOccurrence !== undefined && this.selectOne(`SELECT 1 FROM control_plane_archive_item_payload a
            JOIN turn_item_projection item ON item.id=a.itemId
            WHERE a.conversationId=? AND a.payload=? ORDER BY item.sourceSequence LIMIT 1 OFFSET ?`,
          id, payload, event.legacyUserOccurrence)) continue
        }
        const previous = this.selectOne<ItemRow>('SELECT * FROM turn_item_projection WHERE id=?', itemId)
        if (previous?.payload === payload) continue
        if (previous === undefined) sourceSequence += 1
        changed = this.writeItem({ id, itemId, root, sessionId: record.sessionKey, runtimeSessionId,
          event: { ...event, historySeq: sourceSequence }, sourceEventId: event.id, variant, previous,
          turnOrdinal: -this.currentSequence - 1 }) || changed
      }
      this.statement(`INSERT INTO control_plane_v2_progress(conversationId,sourceDigest,sourceOffset,sourceCount) VALUES(?,?,?,?)
        ON CONFLICT(conversationId) DO UPDATE SET sourceDigest=excluded.sourceDigest,sourceOffset=excluded.sourceOffset,sourceCount=excluded.sourceCount`)
        .run(id, sourceDigest, offset, events.length)
      if (archive === undefined) {
        const projected = this.selectOne<{ value: number }>('SELECT COUNT(*) AS value FROM turn_item_projection WHERE conversationId=?', id)?.value ?? 0
        this.writeMigration({ root, meta, sourceDigest }, offset === events.length ? 'complete' : 'partial', sourceSequence, events.length, projected,
          offset === events.length ? undefined : 'More ACP v2 native items are available', now)
      }
      if (changed || archive === undefined || progress?.sourceOffset !== offset || progress?.sourceCount !== events.length) {
        const sequence = this.appendEvent(id, 'conversation-updated', now, {})
        this.statement('UPDATE conversation_projection SET lastSequence=?,lastActivityAt=MAX(lastActivityAt,?),updatedAt=? WHERE conversationId=?')
          .run(sequence, changed ? record.updatedAt : 0, now, id)
      }
    })
  }

  removeDeleted(root: string, sessionIds: readonly string[]): void {
    this.transaction(() => {
      const projection = this.statement('DELETE FROM conversation_projection WHERE sourceRoot=? AND sourceSessionId=?')
      const migration = this.statement('DELETE FROM control_plane_migration WHERE root=? AND sessionId=?')
      let removed = false
      for (const sessionId of sessionIds) {
        if (projection.run(root, sessionId).changes > 0) removed = true
        migration.run(root, sessionId)
      }
      if (removed) this.nextSequence()
    })
  }

  list(root: string, rawInput: AcpConversationListInput): AcpConversationListSnapshot {
    const input = acpConversationListInputSchema.parse(rawInput)
    const snapshotSequence = this.currentSequence
    const params: Array<string | number> = [root]
    const archiveFilter = input.archive === 'archived' ? ' AND cp.archivedAt IS NOT NULL' : input.archive === 'all' ? '' : ' AND cp.archivedAt IS NULL'
    let where = `cp.sourceRoot=? AND cp.sourceSessionId NOT LIKE 'acp-private-%'${archiveFilter}`
    if (input.query) { where += ' AND instr(lower(cp.title), lower(?)) > 0'; params.push(input.query) }
    if (input.cursor) {
      if (input.cursor.scope !== this.scopeKey(root)) throw new AcpControlPlaneCursorError('store-reset')
      if (input.cursor.sequence > snapshotSequence) throw new AcpControlPlaneCursorError('cursor-ahead')
      where += ' AND (cp.lastActivityAt < ? OR (cp.lastActivityAt = ? AND cp.sourceSessionId < ?))'
      const cursorRow = this.selectOne<{ lastActivityAt: number; sourceSessionId: string }>(
        'SELECT lastActivityAt,sourceSessionId FROM conversation_projection WHERE conversationId=?', input.cursor.conversationId)
      if (!cursorRow) throw new AcpControlPlaneCursorError('conversation-reset')
      params.push(cursorRow.lastActivityAt, cursorRow.lastActivityAt, cursorRow.sourceSessionId)
    }
    const rows = this.statement(`SELECT cp.* FROM conversation_projection cp WHERE ${where}
      ORDER BY cp.lastActivityAt DESC, cp.sourceSessionId DESC LIMIT ?`).all(...params, input.limit + 1) as unknown as ConversationRow[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return acpConversationListSnapshotSchema.parse({
      ok: true, version: 1, conversations: page.map(row => this.listItem(row)), hasMore: rows.length > input.limit,
      nextCursor: rows.length > input.limit && last ? { sequence: snapshotSequence, scope: this.scopeKey(root), conversationId: last.conversationId } : null,
      snapshotSequence,
    })
  }

  private scopeKey(root: string): string { return digest([this.epoch, root]) }

  private listItem(row: ConversationRow): AcpConversationListSnapshot['conversations'][number] {
    const runtime = this.selectOne<RuntimeRow>('SELECT * FROM runtime_session_projection WHERE conversationId=? ORDER BY lastObservedAt DESC, runtimeSessionId LIMIT 1', row.conversationId)
    const provider = this.selectOne<ProviderRow>('SELECT providerInstanceId FROM provider_instance_projection WHERE conversationId=? ORDER BY providerInstanceId LIMIT 1', row.conversationId)
    if (!runtime || !provider) throw new AcpControlPlaneStoreError('Conversation runtime projection is missing')
    const engine = runtime.engine === 'pi' ? 'pi' : 'acp'
    return acpConversationListSnapshotSchema.shape.conversations.element.parse({
      conversationId: row.conversationId, sourceSessionId: row.sourceSessionId, sourceEngine: row.sourceEngine,
      root: row.sourceRoot, title: row.title, status: row.archivedAt === null ? 'active' : 'archived',
      runtime: { state: runtime.state, lastObservedAt: runtime.lastObservedAt, recoverable: runtime.recoverable === 1, engine, providerInstanceId: provider.providerInstanceId, runtimeSessionId: runtime.runtimeSessionId },
      lastActivityAt: row.lastActivityAt, createdAt: row.createdAt, updatedAt: row.updatedAt, lastSequence: row.lastSequence,
    })
  }

  private coverage(row: ConversationRow, capturedFrom: number | null, capturedThrough: number | null): AcpConversationDetailSnapshot['coverage'] {
    const migration = this.migrationState(row.sourceRoot, row.sourceSessionId, row.sourceEngine)
    const native = this.selectOne<V2ProgressRow>('SELECT * FROM control_plane_v2_progress WHERE conversationId=?', row.conversationId)
    const nativePartial = native !== undefined && native.sourceOffset < native.sourceCount
    return acpConversationDetailSnapshotSchema.shape.coverage.parse({
      state: nativePartial || migration?.state === 'partial' ? 'partial' : migration?.state === 'complete' ? 'complete' : 'unknown',
      sourceEventCount: migration?.sourceEventCount ?? 0, projectedEventCount: migration?.projectedEventCount ?? 0,
      capturedFrom, capturedThrough,
      ...(nativePartial ? { reason: 'More ACP v2 native items are available' } : migration?.diagnostic ? { reason: migration.diagnostic } : {}),
    })
  }

  detail(root: string, rawInput: AcpConversationDetailInput): AcpConversationDetailSnapshot {
    const input = acpConversationDetailInputSchema.parse(rawInput)
    const row = this.selectOne<ConversationRow>('SELECT * FROM conversation_projection WHERE sourceRoot=? AND sourceSessionId=?', root, input.sessionId)
    if (!row) throw new AcpControlPlaneCursorError('conversation-reset')
    const snapshotSequence = this.currentSequence
    const rows = this.statement('SELECT * FROM turn_item_projection WHERE conversationId=? ORDER BY sourceSequence DESC LIMIT ?')
      .iterate(row.conversationId, input.itemLimit + 1) as unknown as Iterable<ItemRow>
    const items: AcpTurnItemProjection[] = []
    let bytes = 0
    let hasEarlier = false
    for (const item of rows) {
      const size = Buffer.byteLength(item.payload) + 512
      if (items.length >= input.itemLimit || (items.length > 0 && bytes + size > PAGE_BYTES)) {
        hasEarlier = true
        break
      }
      items.push(itemProjection(item))
      bytes += size
    }
    items.reverse()
    const coverage = this.coverage(row, items[0]?.occurredAt ?? null, items.at(-1)?.occurredAt ?? null)
    return acpConversationDetailSnapshotSchema.parse({
      ok: true, version: 1,
      conversation: this.listItem(row), turnItems: items, hasEarlierItems: hasEarlier,
      earlierHistoryCursor: items[0]?.sourceSequence ?? 0,
      pendingRequests: items.filter((item): item is AcpTurnItemProjection & { item: { kind: 'permission'; title: string; pending: boolean } } =>
        item.item.kind === 'permission' && item.item.pending).slice(-20).map(item => ({ kind: 'permission', summary: item.item.title })), coverage, snapshotSequence,
    })
  }

  events(root: string, rawInput: AcpConversationEventsInput): AcpConversationEventPage {
    const input = acpConversationEventsInputSchema.parse(rawInput)
    const conversation = this.selectOne<ConversationRow>('SELECT * FROM conversation_projection WHERE sourceRoot=? AND sourceSessionId=?', root, input.sessionId)
    const snapshotSequence = this.currentSequence
    if (!conversation) throw new AcpControlPlaneCursorError('conversation-reset')
    if (input.after > snapshotSequence) return acpConversationEventPageSchema.parse({ ok: false, version: 1, resetRequired: true, reason: 'cursor-ahead', snapshotSequence })
    const reset = input.after > 0 && this.statement("SELECT 1 FROM control_plane_events WHERE conversationId=? AND sequence>? AND type='projection-reset' LIMIT 1")
      .get(conversation.conversationId, input.after)
    if (reset) return { ok: false, version: 1, resetRequired: true, reason: 'conversation-reset', snapshotSequence }
    const rows = this.statement('SELECT * FROM control_plane_events WHERE conversationId=? AND sequence>? ORDER BY sequence LIMIT ?')
      .iterate(conversation.conversationId, input.after, input.limit + 1) as unknown as Iterable<EventRow>
    const events: AcpConversationProjectionEvent[] = []
    let bytes = 0
    let hasMore = false
    let after = input.after
    let scanned = 0
    for (const row of rows) {
      const size = Buffer.byteLength(row.payload) + 256
      if (scanned >= input.limit || (scanned > 0 && bytes + size > PAGE_BYTES)) {
        hasMore = true
        break
      }
      scanned += 1
      bytes += size
      after = row.sequence
      if (row.type !== 'item-updated') continue
      const { turnItem } = JSON.parse(row.payload) as { turnItem?: AcpTurnItemProjection }
      const previous = turnItem ? undefined : this.selectOne<ItemRow>('SELECT * FROM turn_item_projection WHERE sequence=?', row.sequence)
      if (turnItem || previous) {
        events.push(acpConversationProjectionEventSchema.parse({
          sequence: row.sequence, conversationId: row.conversationId, type: row.type, occurredAt: row.occurredAt,
          item: turnItem ?? (previous ? itemProjection(previous) : undefined),
        }))
      }
    }
    const changed = !hasMore && conversation.lastSequence > input.after
    return acpConversationEventPageSchema.parse({
      ok: true, version: 1, hasMore, nextCursor: hasMore ? after : snapshotSequence, events,
      ...(changed ? { conversation: this.listItem(conversation), coverage: this.coverage(conversation, null, null) } : {}),
    })
  }
}
