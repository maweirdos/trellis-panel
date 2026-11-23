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
  acpTurnItemProjectionSchema,
  acpTurnItemVariantSchema,
  type AcpConversationDetailInput,
  type AcpConversationEventsInput,
  type AcpConversationEventPage,
  type AcpConversationListInput,
  type AcpConversationListSnapshot,
  type AcpConversationDetailSnapshot,
  type AcpTurnItemProjection,
  type AcpTurnItemVariant,
} from '../../../shared/acp-projections'
import type { AcpSessionMeta, TimelineEvent } from '../../../shared/types'
import type { AcpV2NativeRecord } from './v2/persistence'
import { CONTROL_PLANE_DDL, CONTROL_PLANE_SCHEMA_VERSION } from './control-plane-schema'

export class AcpControlPlaneCursorError extends Error {
  constructor(readonly reason: 'cursor-ahead' | 'conversation-reset' | 'store-reset') {
    super('Conversation projection cursor is no longer resumable')
  }
}

export class AcpControlPlaneStoreError extends Error {
  constructor(message: string) { super(message) }
}

export interface AcpControlPlaneMigrationSource {
  root: string
  meta: AcpSessionMeta
  events: Array<TimelineEvent & { historySeq?: number }>
  sourceDigest: string
  sourceLastSequence: number | null
  afterSourceSequence?: number
  coverageReason?: string
}

interface SequenceRow { currentSequence: number; storeEpoch: string; schemaVersion: number }
interface ConversationRow {
  conversationId: string; sourceRoot: string; sourceSessionId: string; sourceEngine: 'acp' | 'pi';
  title: string; archivedAt: number | null; pinnedAt: number | null; lastActivityAt: number;
  createdAt: number; updatedAt: number; lastSequence: number
}
interface RuntimeRow { state: string; lastObservedAt: number | null; recoverable: number; engine: 'acp' | 'pi' }
interface RuntimeIdsRow { runtimeSessionId: string }
interface ProviderRow { providerInstanceId: string }
interface ItemRow {
  id: string; turnId: string; conversationId: string; ordinal: number; sourceEventId: string;
  sourceSequence: number; occurredAt: number; sequence: number; kind: string; payload: string
}
interface EventRow { sequence: number; conversationId: string; type: string; occurredAt: number; payload: string }
interface MigrationRow { state: string; sourceDigest: string; sourceLastSequence: number | null; sourceEventCount: number; projectedEventCount: number; diagnostic: string | null }

const PAGE_BYTES = 2 * 1024 * 1024
const MAX_ITEM_TEXT = 32_768

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function conversationId(root: string, sessionId: string, engine: 'acp' | 'pi'): string {
  return `cp-${createHash('sha256').update(JSON.stringify([root, sessionId, engine])).digest('hex').slice(0, 32)}`
}

function boundedText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  return value.length > MAX_ITEM_TEXT ? `${value.slice(0, MAX_ITEM_TEXT - 12)}…[truncated]` : value
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
    return { kind: 'tool-call', title: boundedText(title ?? event.text, 'Tool call') }
  }
  if (event.kind === 'permission') {
    const toolCall = event.payload?.toolCall
    const title = toolCall && typeof toolCall === 'object' && 'title' in toolCall && typeof toolCall.title === 'string' ? toolCall.title : undefined
    return { kind: 'permission', title: boundedText(title ?? event.text, 'Permission'), pending: event.payload?.pending === true }
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
  return { kind: 'system-marker', text: boundedText(event.text ?? event.kind, event.kind) }
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

function sourceSequence(event: TimelineEvent & { historySeq?: number }, fallback: number): number {
  return typeof event.historySeq === 'number' && Number.isSafeInteger(event.historySeq) && event.historySeq > 0 ? event.historySeq : fallback
}

function v2TimelineEvents(record: AcpV2NativeRecord): Array<TimelineEvent & { historySeq?: number }> {
  const events: Array<TimelineEvent & { historySeq?: number }> = []
  const append = (nativeId: string, kind: TimelineEvent['kind'], text: string, payload?: Record<string, unknown>): void => {
    events.push({
      id: `v2:${record.nativeSessionId}:${nativeId}`,
      ts: record.updatedAt,
      source: 'acp',
      sessionId: record.sessionKey,
      projectRoot: record.cwd,
      kind,
      text: boundedText(text),
      payload: { ...payload, nativeId },
      historySeq: events.length + 1,
    })
  }
  for (const entity of record.aggregate.messages) {
    const value = readRecord(entity.value)
    if (value !== undefined) append(entity.nativeId, 'message', typeof value.text === 'string' ? value.text : '', {
      role: value.tag === 'user_message' || value.tag === 'user_message_chunk' ? 'user' : 'assistant',
    })
  }
  for (const entity of record.aggregate.toolCalls) {
    const value = readRecord(entity.value)
    if (value !== undefined) append(entity.nativeId, 'tool-call', typeof value.title === 'string' && value.title.length > 0 ? value.title : entity.nativeId, { status: value.status })
  }
  for (const entity of record.aggregate.plans) {
    const value = readRecord(entity.value)
    if (value !== undefined) append(entity.nativeId, 'plan', typeof value.summary === 'string' && value.summary.length > 0 ? value.summary : entity.nativeId)
  }
  for (const entity of [...record.aggregate.sessionInfo, ...record.aggregate.notices]) {
    const value = readRecord(entity.value)
    if (value !== undefined) append(entity.nativeId, 'session-status', typeof value.message === 'string' ? value.message : typeof value.summary === 'string' ? value.summary : 'ACP v2 更新')
  }
  const terminal = record.aggregate.terminal.find(entity => entity.nativeId === 'terminal')
  const terminalValue = terminal === undefined ? undefined : readRecord(terminal.value)
  if (terminalValue !== undefined) append('terminal', 'session-status', `ACP v2 ${typeof terminalValue.state === 'string' ? terminalValue.state : 'unknown'}`)
  return events
}

export interface AcpV2ProjectionSource {
  readonly root: string
  readonly record: AcpV2NativeRecord
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
      .run(value, `${conversationId}:${type}:${sequence ?? digest(payload)}`, conversationId, type, occurredAt, digest(payload), JSON.stringify(payload))
    return value
  }

  migrate(source: AcpControlPlaneMigrationSource): void {
    const root = source.root
    const id = conversationId(root, source.meta.sessionId, source.meta.engine ?? 'acp')
    const engine = source.meta.engine ?? 'acp'
    const migrationKey = [root, source.meta.sessionId, engine] as const
    const existing = this.selectOne<MigrationRow>('SELECT * FROM control_plane_migration WHERE root=? AND sessionId=? AND engine=?', ...migrationKey)
    const sameSource = existing?.sourceDigest === source.sourceDigest
    if (existing?.state === 'complete' && sameSource && (existing.sourceLastSequence ?? null) === (source.sourceLastSequence ?? null)) return

    this.transaction(() => {
      const resume = existing?.state === 'partial' && sameSource
      if (existing && !resume) {
        this.statement('DELETE FROM control_plane_events WHERE conversationId=?').run(id)
        this.statement('DELETE FROM turn_item_projection WHERE conversationId=?').run(id)
        this.statement('DELETE FROM turn_projection WHERE conversationId=?').run(id)
        this.statement('DELETE FROM runtime_thread_projection WHERE conversationId=?').run(id)
        this.statement('DELETE FROM runtime_session_projection WHERE conversationId=?').run(id)
        this.statement('DELETE FROM provider_instance_projection WHERE conversationId=?').run(id)
        this.statement('DELETE FROM conversation_projection WHERE conversationId=?').run(id)
      }

      const now = Date.now()
      const createdAt = Math.max(0, Math.trunc(source.meta.startedAt || now))
      const activity = Math.max(createdAt, ...source.events.map(event => Math.max(0, Math.trunc(event.ts))))
      const createdSequence = this.nextSequence()
      if (!resume) {
        this.statement(`INSERT INTO conversation_projection(conversationId,sourceRoot,sourceSessionId,sourceEngine,title,archivedAt,pinnedAt,lastActivityAt,createdAt,updatedAt,lastSequence)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, root, source.meta.sessionId, engine, boundedText(source.meta.title ?? source.meta.agentName ?? source.meta.sessionId).slice(0, 300),
          sqliteInteger(source.meta.archivedAt), sqliteInteger(source.meta.pinnedAt), activity, createdAt, now, createdSequence)
      } else {
        this.statement('UPDATE conversation_projection SET title=?,archivedAt=?,pinnedAt=?,lastActivityAt=?,updatedAt=? WHERE conversationId=?')
          .run(boundedText(source.meta.title ?? source.meta.agentName ?? source.meta.sessionId).slice(0, 300), sqliteInteger(source.meta.archivedAt), sqliteInteger(source.meta.pinnedAt), activity, now, id)
      }

      const runtimeState = source.meta.status === 'busy' ? 'running' : source.meta.status === 'awaiting_permission' ? 'awaiting-permission'
        : source.meta.status === 'cancelling' ? 'stopping' : source.meta.canResume === true ? 'recoverable' : 'stopped'
      const runtimeSessionId = `rt-${createHash('sha256').update(JSON.stringify([id, source.meta.connectionGeneration ?? 'legacy'])).digest('hex').slice(0, 24)}`
      this.statement(`INSERT INTO runtime_session_projection(runtimeSessionId,conversationId,state,lastObservedAt,recoverable,engine) VALUES(?,?,?,?,?,?)
        ON CONFLICT(runtimeSessionId) DO UPDATE SET state=excluded.state,lastObservedAt=excluded.lastObservedAt,recoverable=excluded.recoverable,engine=excluded.engine`)
        .run(runtimeSessionId, id, runtimeState, sqliteInteger(source.meta.endedAt ?? activity), source.meta.canResume === true ? 1 : 0, engine)
      this.statement(`INSERT INTO runtime_thread_projection(runtimeThreadId,conversationId,runtimeSessionId,nativeThreadId,identityStrength,recoverability) VALUES(?,?,?,?,?,?)
        ON CONFLICT(runtimeThreadId) DO UPDATE SET nativeThreadId=excluded.nativeThreadId,identityStrength=excluded.identityStrength,recoverability=excluded.recoverability`)
        .run(`${runtimeSessionId}:thread`, id, runtimeSessionId, source.meta.backendSessionId ?? null, source.meta.backendSessionId ? 'native' : 'session-only', source.meta.canResume === true ? 'recoverable' : 'unavailable')
      this.statement(`INSERT INTO provider_instance_projection(providerInstanceId,conversationId,launchKind,providerId,providerName,snapshotDigest,capabilityProjection) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(providerInstanceId) DO UPDATE SET launchKind=excluded.launchKind,providerId=excluded.providerId,providerName=excluded.providerName,snapshotDigest=excluded.snapshotDigest,capabilityProjection=excluded.capabilityProjection`)
        .run(`${runtimeSessionId}:provider`, id, source.meta.engine === 'pi' ? 'pi' : 'acp', source.meta.agentId ?? 'unknown', sqliteText(source.meta.agentName), digest([source.meta.runtimeSnapshot ?? null]), JSON.stringify(source.meta.capabilities ?? {}))
      if (!resume) this.appendEvent(id, 'conversation-created', createdAt, { sourceRoot: root, sourceSessionId: source.meta.sessionId, engine }, createdSequence)
      this.appendEvent(id, 'runtime-updated', now, { state: runtimeState, recoverable: source.meta.canResume === true })

      let ordinal = resume ? existing?.projectedEventCount ?? 0 : 0
      let projectedCount = ordinal
      let bytes = 0
      for (const [index, event] of source.events.entries()) {
        if (resume && source.afterSourceSequence !== undefined && sourceSequence(event, index + 1) <= source.afterSourceSequence) continue
        const turn = turnIdFor(root, source.meta.sessionId, event)
        const startedAt = Math.max(0, Math.trunc(event.ts))
        this.statement('INSERT OR IGNORE INTO turn_projection(turnId,conversationId,ordinal,status,providerRuntimeId,startedAt,endedAt) VALUES(?,?,?,?,?,?,?)')
          .run(turn, id, ordinal, 'archived', runtimeSessionId, startedAt, null)
        const sequence = this.nextSequence()
        const variant = itemVariant(event)
        const payload = JSON.stringify(variant)
        const eventBytes = Buffer.byteLength(payload)
        if (bytes + eventBytes > PAGE_BYTES && projectedCount > 0) {
          this.statement(`INSERT INTO control_plane_migration(root,sessionId,engine,state,sourceLastSequence,sourceEventCount,projectedEventCount,sourceDigest,diagnostic,migratedAt)
            VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(root,sessionId,engine) DO UPDATE SET state=excluded.state,sourceLastSequence=excluded.sourceLastSequence,
            sourceEventCount=excluded.sourceEventCount,projectedEventCount=excluded.projectedEventCount,sourceDigest=excluded.sourceDigest,diagnostic=excluded.diagnostic,migratedAt=excluded.migratedAt`)
            .run(root, source.meta.sessionId, engine, 'partial', source.sourceLastSequence, source.events.length, projectedCount, source.sourceDigest,
              boundedText(source.coverageReason ?? 'Legacy page exceeded the bounded projection budget'), Date.now())
          break
        }
        this.statement('INSERT INTO turn_item_projection(id,turnId,conversationId,ordinal,sourceEventId,sourceSequence,occurredAt,sequence,kind,payload) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(`${id}:source:${event.id}`, turn, id, index, event.id, sourceSequence(event, index + 1), startedAt, sequence, variant.kind, payload)
        this.appendEvent(id, 'item-updated', startedAt, { sourceEventId: event.id, sourceSequence: sourceSequence(event, index + 1), item: variant }, sequence)
        ordinal += 1
        projectedCount += 1
        bytes += eventBytes
      }

      const complete = projectedCount === source.events.length
      this.statement(`INSERT INTO control_plane_migration(root,sessionId,engine,state,sourceLastSequence,sourceEventCount,projectedEventCount,sourceDigest,diagnostic,migratedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(root,sessionId,engine) DO UPDATE SET state=excluded.state,sourceLastSequence=excluded.sourceLastSequence,
        sourceEventCount=excluded.sourceEventCount,projectedEventCount=excluded.projectedEventCount,sourceDigest=excluded.sourceDigest,diagnostic=excluded.diagnostic,migratedAt=excluded.migratedAt`)
        .run(root, source.meta.sessionId, engine, complete ? 'complete' : 'partial', source.sourceLastSequence, source.events.length, projectedCount, source.sourceDigest,
          complete ? null : boundedText(source.coverageReason ?? 'Legacy history changed during a bounded projection'), Date.now())
      const finalSequence = this.nextSequence()
      this.statement('UPDATE conversation_projection SET lastSequence=? WHERE conversationId=?').run(finalSequence, id)
      this.appendEvent(id, complete ? 'migration-completed' : 'conversation-updated', now, { sourceEventCount: source.events.length, projectedEventCount: projectedCount }, finalSequence)
    })
  }

  migrationState(root: string, sessionId: string, engine: 'acp' | 'pi'): MigrationRow | undefined {
    return this.selectOne<MigrationRow>('SELECT * FROM control_plane_migration WHERE root=? AND sessionId=? AND engine=?', root, sessionId, engine)
  }

  migrateV2(source: AcpV2ProjectionSource): void {
    const events = v2TimelineEvents(source.record)
    this.migrate({
      root: source.root,
      meta: {
        schemaVersion: 2,
        sessionId: source.record.sessionKey,
        projectRoot: source.root,
        cwd: source.record.cwd,
        agentId: source.record.negotiated.agent.name,
        agentName: source.record.negotiated.agent.title ?? source.record.negotiated.agent.name,
        status: source.record.cleanupState === 'live' ? 'ready' : 'disconnected',
        startedAt: source.record.updatedAt,
        capabilities: {
          controls: source.record.negotiated.capabilities.session === undefined ? [] : ['session/set_config_option', 'session/status'],
          loadSession: source.record.negotiated.capabilities.session !== undefined,
          promptCapabilities: {
            image: readNested(source.record.negotiated.capabilities, 'session', 'prompt', 'image') === true,
            embeddedContext: readNested(source.record.negotiated.capabilities, 'session', 'prompt', 'embeddedContext') === true,
          },
          protocolVersion: source.record.negotiated.protocolVersion,
          agentInfo: source.record.negotiated.agent,
          authMethods: [],
        },
        backendSessionId: source.record.nativeSessionId,
        nativeRecordId: source.record.recordId,
        canResume: source.record.cleanupState !== 'live',
      },
      events,
      sourceDigest: digest([source.record.recordId, source.record.replayCursor ?? '', source.record.aggregate.replayCursor ?? '', source.record.aggregate.revisionOrder, source.record.configOptions, source.record.cleanupState, source.record.updatedAt, source.record.aggregate]),
      sourceLastSequence: events.at(-1)?.historySeq ?? null,
      coverageReason: 'ACP v2 native aggregate projection is bounded to 200 entities',
    })
  }

  lastSourceSequence(root: string, sessionId: string, engine: 'acp' | 'pi'): number | null {
    return Number(this.selectOne<{ value: number | null }>('SELECT MAX(sourceSequence) value FROM turn_item_projection WHERE conversationId=?',
      conversationId(root, sessionId, engine))?.value ?? null)
  }

  list(root: string, rawInput: AcpConversationListInput): AcpConversationListSnapshot {
    const input = acpConversationListInputSchema.parse(rawInput)
    const snapshotSequence = this.currentSequence
    const params: Array<string | number> = [root]
    const archiveFilter = input.archive === 'archived' ? ' AND cp.archivedAt IS NOT NULL' : input.archive === 'all' ? '' : ' AND cp.archivedAt IS NULL'
    let where = `cp.sourceRoot=?${archiveFilter}`
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
    const runtime = this.selectOne<RuntimeRow>('SELECT * FROM runtime_session_projection WHERE conversationId=? ORDER BY runtimeSessionId LIMIT 1', row.conversationId)
    const runtimeIds = this.selectOne<RuntimeIdsRow>('SELECT runtimeSessionId FROM runtime_session_projection WHERE conversationId=? ORDER BY runtimeSessionId LIMIT 1', row.conversationId)
    const provider = this.selectOne<ProviderRow>('SELECT providerInstanceId FROM provider_instance_projection WHERE conversationId=? ORDER BY providerInstanceId LIMIT 1', row.conversationId)
    if (!runtime || !runtimeIds || !provider) throw new AcpControlPlaneStoreError('Conversation runtime projection is missing')
    const engine = runtime.engine === 'pi' ? 'pi' : 'acp'
    return acpConversationListSnapshotSchema.shape.conversations.element.parse({
      conversationId: row.conversationId, sourceSessionId: row.sourceSessionId, sourceEngine: row.sourceEngine,
      root: row.sourceRoot, title: row.title, status: row.archivedAt === null ? 'active' : 'archived',
      runtime: { state: runtime.state as 'stopped' | 'recoverable' | 'running' | 'awaiting-permission' | 'stopping' | 'unknown', lastObservedAt: runtime.lastObservedAt, recoverable: runtime.recoverable === 1, engine, providerInstanceId: provider.providerInstanceId, runtimeSessionId: runtimeIds.runtimeSessionId },
      lastActivityAt: row.lastActivityAt, createdAt: row.createdAt, updatedAt: row.updatedAt, lastSequence: row.lastSequence,
    })
  }

  detail(root: string, rawInput: AcpConversationDetailInput): AcpConversationDetailSnapshot {
    const input = acpConversationDetailInputSchema.parse(rawInput)
    const row = this.selectOne<ConversationRow>('SELECT * FROM conversation_projection WHERE sourceRoot=? AND sourceSessionId=?', root, input.sessionId)
    if (!row) throw new AcpControlPlaneCursorError('conversation-reset')
    const snapshotSequence = this.currentSequence
    const items = (this.statement('SELECT * FROM turn_item_projection WHERE conversationId=? ORDER BY sourceSequence DESC LIMIT ?')
      .all(row.conversationId, input.itemLimit) as unknown as ItemRow[]).reverse().map(itemProjection)
    const migration = this.selectOne<MigrationRow>('SELECT * FROM control_plane_migration WHERE root=? AND sessionId=? AND engine=?',
      row.sourceRoot, row.sourceSessionId, row.sourceEngine)
    const hasEarlier = items.length > 0 && Number(this.selectOne<{ count: number }>('SELECT COUNT(*) count FROM turn_item_projection WHERE conversationId=? AND sourceSequence < ?', row.conversationId, items[0].sourceSequence)?.count ?? 0) > 0
    const coverage = acpConversationDetailSnapshotSchema.shape.coverage.parse({
      state: migration?.state === 'complete' ? 'complete' : migration?.state === 'partial' ? 'partial' : 'unknown',
      sourceEventCount: migration?.sourceEventCount ?? 0, projectedEventCount: migration?.projectedEventCount ?? 0,
      capturedFrom: items[0]?.occurredAt ?? null, capturedThrough: items.at(-1)?.occurredAt ?? null,
      ...(migration?.diagnostic ? { reason: migration.diagnostic } : {}),
    })
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
    const rows = this.statement('SELECT * FROM control_plane_events WHERE conversationId=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(conversation.conversationId, input.after, input.limit + 1) as unknown as EventRow[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)?.sequence ?? Math.min(input.after, snapshotSequence)
      return acpConversationEventPageSchema.parse({
      ok: true, version: 1, hasMore: rows.length > input.limit, nextCursor: last,
      events: page.map(row => {
        const payload = JSON.parse(row.payload) as { item?: AcpTurnItemVariant }
        return {
          sequence: row.sequence, conversationId: row.conversationId,
          type: row.type === 'conversation-created' || row.type === 'conversation-updated' || row.type === 'turn-updated' || row.type === 'item-updated' || row.type === 'runtime-updated' || row.type === 'migration-completed' ? row.type : 'conversation-updated',
          occurredAt: row.occurredAt,
        }
      }).map(event => {
        const item = this.statement('SELECT * FROM turn_item_projection WHERE sequence=?').get(event.sequence) as unknown as ItemRow | undefined
        return item === undefined ? undefined : { ...event, item: itemProjection(item) }
      }).filter((event): event is NonNullable<typeof event> => event !== undefined),
    })
  }
}
