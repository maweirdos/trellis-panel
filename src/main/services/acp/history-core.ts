import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AcpSessionRecord, TimelineEvent } from '../../../shared/types'
import type { AcpHistoryCoverage, AcpHistoryDiagnostic, AcpHistoryEventPage, AcpHistoryListResult, AcpHistoryPersistence, AcpHistorySummary } from '../../../shared/acp-history'
import { acpConversationPreview, type AcpConversationPreview } from '../../../shared/acp-conversation-preview'
import { historicalEvent, HistoryTurnBoundaryError, selectHistoryTurns, type HistoryEventMetadata } from './history-turns'
import { applySessionPreferences, compareHistorySummaries, matchesHistorySummary, readSessionPreferences, type SessionPreferences } from './session-preferences'
import { HandoffHistoryError, readHandoffArchive, type HandoffArchive } from './handoff-history'
import { readHistoryDeletion } from './history-deletion'
import { readHistoryText } from './history-text'
import { isPrivateAcpRecord } from './private-access'
import { isRecoverableRuntimeRecord } from './runtime-definitions'

const DB_VERSION = 1
const SNAPSHOT_TTL = 5 * 60_000
// SQLite's default trim only removes spaces; use JavaScript trim's whitespace set.
const MESSAGE_TEXT = "trim(json_extract(payload,'$.text'),char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))"
const SCHEMA = `
CREATE TABLE archive_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sessions (
 root TEXT NOT NULL, sessionId TEXT NOT NULL, metadata TEXT NOT NULL,
 lastActivityAt INTEGER NOT NULL, search TEXT NOT NULL, coverage TEXT NOT NULL,
 PRIMARY KEY(root,sessionId));
CREATE INDEX sessions_activity ON sessions(root,lastActivityAt DESC,sessionId DESC);
CREATE TABLE events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, root TEXT NOT NULL, sessionId TEXT NOT NULL,
 eventId TEXT NOT NULL, ts INTEGER NOT NULL, digest TEXT NOT NULL,
 payload TEXT NOT NULL, bytes INTEGER NOT NULL, turnId TEXT, kind TEXT NOT NULL,
 UNIQUE(root,sessionId,eventId));
CREATE INDEX events_session ON events(root,sessionId,seq);
CREATE TABLE imports (source TEXT NOT NULL,digest TEXT NOT NULL,root TEXT,sessionId TEXT,
 eventCount INTEGER NOT NULL,importedAt INTEGER NOT NULL,PRIMARY KEY(source,digest));
`

function stable(value: unknown, legacyLocaleOrder = false): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stable(item, legacyLocaleOrder)).join(',')}]`
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => legacyLocaleOrder ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stable(item, legacyLocaleOrder)}`).join(',')}}`
}
function digest(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function cleanEvent(event: TimelineEvent): TimelineEvent {
  const { historySeq: _sequence, ...original } = event
  return original
}
function matchesStoredEvent(stored: { digest: string; payload: string }, canonical: string): boolean {
  if (stored.digest === digest(canonical)) return true
  try {
    // Early v1 writers sorted keys by locale. Verify both the original payload
    // and its old digest; equal content alone must not excuse a damaged digest.
    const original: unknown = JSON.parse(stored.payload)
    return stable(original) === canonical && stored.digest === digest(stable(original, true))
  } catch { return false }
}
export class HistoryCursorError extends Error {}
export interface HistoryBatchItem { root: string; record: AcpSessionRecord; events: TimelineEvent[]; coverage?: AcpHistoryCoverage }
interface SessionRow { root: string; sessionId: string; metadata: string; lastActivityAt: number; coverage: string }
interface Snapshot { root: string; query: string; filter: string; archive: string; preferencesRevision: string; legacyIdsKey: string; expires: number; sessions: AcpHistorySummary[] }

/** Synchronous SQLite work is confined to the dedicated history worker. */
export class AcpHistoryCore {
  private db: DatabaseSync
  private epoch: string
  private snapshots = new Map<string, Snapshot>()
  private diagnostics: Array<AcpHistoryDiagnostic & { root?: string }> = []
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true })
    const path = join(directory, 'history.sqlite')
    const fresh = !existsSync(path)
    this.db = new DatabaseSync(path)
    try {
      if (fresh) {
        this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;')
        this.db.exec(SCHEMA)
        this.db.prepare('INSERT INTO archive_meta VALUES(?,?)').run('version', String(DB_VERSION))
        this.db.prepare('INSERT INTO archive_meta VALUES(?,?)').run('epoch', randomUUID())
        this.db.exec('COMMIT')
      }
      const version = this.db.prepare("SELECT value FROM archive_meta WHERE key='version'").get() as { value: string } | undefined
      if (version?.value !== String(DB_VERSION)) throw new Error('Unsupported conversation archive version; original database retained')
      const check = this.db.prepare('PRAGMA quick_check(1)').get() as { quick_check: string }
      if (check.quick_check !== 'ok') throw new Error('Conversation archive is damaged; original database retained')
      const epoch = this.db.prepare("SELECT value FROM archive_meta WHERE key='epoch'").get() as { value: string } | undefined
      if (!epoch?.value) throw new Error('Conversation archive identity missing; original database retained')
      this.epoch = epoch.value
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; PRAGMA secure_delete=ON;')
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.db.close() }
  deleteSession(root: string, sessionId: string): void {
    if (!readHistoryDeletion(this.directory, root, sessionId)) throw new Error('永久删除缺少已确认的持久记录')
    this.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE root=? AND sessionId=?').run(root, sessionId)
      this.db.prepare('DELETE FROM imports WHERE root=? AND sessionId=?').run(root, sessionId)
      this.db.prepare('DELETE FROM sessions WHERE root=? AND sessionId=?').run(root, sessionId)
    })
    this.snapshots.clear()
  }
  titleMaterial(root: string, sessionId: string): { question: string; delivery: string; digest: string } | null {
    if (!this.session(root, sessionId)) return null
    const first = this.db.prepare(`SELECT seq,json_extract(payload,'$.text') text FROM events WHERE root=? AND sessionId=? AND kind='message'
      AND json_extract(payload,'$.source') IN ('acp','pi') AND json_extract(payload,'$.payload.role')='user' AND ${MESSAGE_TEXT}<>'' ORDER BY seq LIMIT 1`).get(root, sessionId) as { seq: number; text: string } | undefined
    if (!first) return null
    const latest = this.db.prepare(`SELECT seq,turnId,json_extract(payload,'$.connectionGeneration') generation FROM events WHERE root=? AND sessionId=? AND kind='message'
      AND json_extract(payload,'$.source') IN ('acp','pi') AND COALESCE(json_extract(payload,'$.payload.role'),'assistant')='assistant' ORDER BY seq DESC LIMIT 1`).get(root, sessionId) as { seq: number; turnId: string | null; generation: string | null } | undefined
    if (!latest || latest.seq <= first.seq) return null
    const beginning = this.db.prepare(`SELECT MIN(seq) seq FROM events WHERE root=? AND sessionId=? AND turnId IS ?
      AND json_extract(payload,'$.connectionGeneration') IS ? AND seq>? AND seq<=?`).get(root, sessionId, latest.turnId, latest.generation, first.seq, latest.seq) as { seq: number }
    const messages = readHistoryText(this.db, root, sessionId, beginning.seq, latest.seq).filter(event => event.payload?.role !== 'user')
    const final = messages.filter(event => event.payload?.meta && (event.payload.meta as { phase?: unknown }).phase === 'final_answer')
    const delivery = (final.length ? final : messages).map(event => event.text ?? '').join('\n').slice(-10_000)
    const question = first.text.slice(0, 4000)
    return { question, delivery, digest: digest(stable([first.seq, latest.seq, latest.turnId, latest.generation, question, delivery])) }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private conversationPreview(root: string, sessionId: string): AcpConversationPreview | undefined {
    // Extract only text/correlation fields: image attachments never enter catalogue IPC.
    const latest = this.db.prepare(`SELECT seq,ts,json_extract(payload,'$.text') text,
      COALESCE(json_extract(payload,'$.payload.role'),'assistant') role,
      json_extract(payload,'$.connectionGeneration') generation,json_extract(payload,'$.turnId') turnId,
      json_extract(payload,'$.payload.messageId') messageId FROM events
      WHERE root=? AND sessionId=? AND kind='message' AND json_extract(payload,'$.source') IN ('acp','pi')
      AND (json_extract(payload,'$.sessionId') IS NULL OR json_extract(payload,'$.sessionId')=?)
      AND COALESCE(json_extract(payload,'$.payload.role'),'assistant') IN ('user','assistant')
      AND json_type(payload,'$.text')='text'
      ORDER BY seq DESC LIMIT 1`).get(root, sessionId, sessionId) as {
        seq: number; ts: number; text: string; role: string; generation: string | null; turnId: string | null; messageId: string | null
      } | undefined
    if (!latest) return undefined
    if (latest.role === 'user') return { text: latest.text.replace(/\s+/g, ' ').trim().slice(0, 180), at: latest.ts }
    const boundary = this.db.prepare(`SELECT seq FROM events WHERE root=? AND sessionId=? AND seq<?
      AND json_extract(payload,'$.source') IN ('acp','pi') AND (kind='turn-done' OR (kind='message' AND (
        COALESCE(json_extract(payload,'$.payload.role'),'assistant')<>'assistant'
        OR json_extract(payload,'$.connectionGeneration') IS NOT ?
        OR json_extract(payload,'$.turnId') IS NOT ? OR json_extract(payload,'$.payload.messageId') IS NOT ?)))
      ORDER BY seq DESC LIMIT 1`).get(root, sessionId, latest.seq, latest.generation, latest.turnId, latest.messageId) as { seq: number } | undefined
    return acpConversationPreview(readHistoryText(this.db, root, sessionId, (boundary?.seq ?? 0) + 1, latest.seq), sessionId)
  }
  private saveMetadata(item: HistoryBatchItem): void {
    const { events: _events, pendingPermissions: _permissions, historyPersistence: _persistence, ...metadata } = item.record
    const old = this.db.prepare('SELECT coverage,lastActivityAt FROM sessions WHERE root=? AND sessionId=?').get(item.root, item.record.sessionId) as { coverage: string; lastActivityAt: number } | undefined
    const lastActivityAt = Math.max(old?.lastActivityAt ?? 0, metadata.startedAt || 0, ...item.events.map((event) => event.ts))
    const oldCoverage = old ? JSON.parse(old.coverage) as AcpHistoryCoverage : undefined
    const coverage = JSON.stringify(item.coverage?.unarchivedCount ? item.coverage : oldCoverage?.unarchivedCount ? oldCoverage
      : item.coverage?.state === 'partial' ? item.coverage : oldCoverage ?? item.coverage ?? { state: 'complete', capturedFrom: metadata.startedAt })
    const preview = this.conversationPreview(item.root, metadata.sessionId)
    metadata.conversationPreview = preview?.text; metadata.conversationPreviewAt = preview?.at
    const search = [metadata.title, metadata.agentName, metadata.agentId, metadata.taskDir, metadata.profileSnapshot?.name].filter(Boolean).join(' ').toLocaleLowerCase()
    this.db.prepare(`INSERT INTO sessions VALUES(?,?,?,?,?,?) ON CONFLICT(root,sessionId) DO UPDATE SET metadata=excluded.metadata,lastActivityAt=excluded.lastActivityAt,search=excluded.search,coverage=excluded.coverage`)
      .run(item.root, metadata.sessionId, JSON.stringify(metadata), lastActivityAt, search, coverage)
  }
  private insert(root: string, sessionId: string, event: TimelineEvent): { seq: number; eventId: string } {
    if (!event || typeof event.id !== 'string' || !Number.isFinite(event.ts)) throw new Error('Invalid transcript event')
    const payload = JSON.stringify(cleanEvent(event))
    const canonical = stable(cleanEvent(event))
    const eventDigest = digest(canonical)
    const old = this.db.prepare('SELECT seq,digest,payload FROM events WHERE root=? AND sessionId=? AND eventId=?').get(root, sessionId, event.id) as { seq: number; digest: string; payload: string } | undefined
    if (old) {
      if (!matchesStoredEvent(old, canonical)) throw new Error(`Transcript event identity conflict: ${event.id}`)
      return { seq: old.seq, eventId: event.id }
    }
    const result = this.db.prepare('INSERT INTO events(root,sessionId,eventId,ts,digest,payload,bytes,turnId,kind) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(root, sessionId, event.id, event.ts, eventDigest, payload, Buffer.byteLength(payload), event.turnId ?? null, event.kind)
    return { seq: Number(result.lastInsertRowid), eventId: event.id }
  }
  append(items: HistoryBatchItem[]): Array<{ sessionId: string; seq: number | null; eventId: string | null }> {
    return this.transaction(() => items.map((item) => {
      if (readHistoryDeletion(this.directory, item.root, item.record.sessionId)) return { sessionId: item.record.sessionId, seq: null, eventId: null }
      let marker: { seq: number; eventId: string } | undefined
      for (const event of item.events) marker = this.insert(item.root, item.record.sessionId, event)
      this.saveMetadata(item)
      if (!marker) marker = this.db.prepare('SELECT seq,eventId FROM events WHERE root=? AND sessionId=? ORDER BY seq DESC LIMIT 1').get(item.root, item.record.sessionId) as typeof marker
      return { sessionId: item.record.sessionId, seq: marker?.seq ?? null, eventId: marker?.eventId ?? null }
    }))
  }
  importDirectory(sourceDirectory: string, canonicalize: (root: string) => string): void {
    if (!existsSync(sourceDirectory)) return
    for (const filename of readdirSync(sourceDirectory)) {
      if (!filename.endsWith('.json')) continue
      const source = join(sourceDirectory, filename)
      let root: string | undefined
      try {
        const bytes = readFileSync(source)
        const sourceDigest = digest(bytes)
        const raw = JSON.parse(bytes.toString('utf8')) as AcpSessionRecord
        if (typeof raw.projectRoot !== 'string' || typeof raw.sessionId !== 'string' || !Array.isArray(raw.events)) throw new Error('Invalid legacy conversation record')
        root = canonicalize(raw.projectRoot)
        if (readHistoryDeletion(this.directory, root, raw.sessionId)) continue
        this.backup(bytes, sourceDigest)
        if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1 && raw.schemaVersion !== 2) throw new Error('Unsupported conversation record version; source preserved')
        if (this.db.prepare('SELECT 1 FROM imports WHERE source=? AND digest=?').get(source, sourceDigest)) continue
        // A newer compatibility snapshot is a cache, never a transcript replacement.
        const existing = this.db.prepare('SELECT metadata FROM sessions WHERE root=? AND sessionId=?').get(root, raw.sessionId) as { metadata: string } | undefined
        const lastArchived = this.db.prepare('SELECT eventId FROM events WHERE root=? AND sessionId=? ORDER BY seq DESC LIMIT 1').get(root, raw.sessionId) as { eventId: string } | undefined
        const lastKnownIndex = lastArchived ? raw.events.findIndex((event) => event.id === lastArchived.eventId) : -1
        this.transaction(() => {
          let unknownOrder = false
          for (const [index, event] of raw.events.entries()) {
            const previous = this.db.prepare('SELECT digest,payload FROM events WHERE root=? AND sessionId=? AND eventId=?').get(root as string, raw.sessionId, event.id) as { digest: string; payload: string } | undefined
            if (previous && !matchesStoredEvent(previous, stable(cleanEvent(event)))) {
              this.diagnostics.push({ code: 'source_event_conflict', source: basename(source), root, message: `Original event retained after snapshot identity conflict: ${event.id}` })
              continue
            }
            if (!previous && lastArchived && (lastKnownIndex < 0 || index < lastKnownIndex)) {
              unknownOrder = true
              this.diagnostics.push({ code: 'source_event_order_unknown', source: basename(source), root, message: `Snapshot-only event preserved in original source; archive order cannot be established: ${event.id}` })
              continue
            }
            this.insert(root as string, raw.sessionId, event)
          }
          // Preserve current archive metadata on restart; recover new snapshot-only events.
          const metadata = existing ? JSON.parse(existing.metadata) as AcpSessionRecord : null
          this.saveMetadata({ root: root as string, record: metadata ? { ...raw, ...metadata, events: [] } : raw, events: raw.events,
            coverage: { state: unknownOrder ? 'partial' : 'unknown', capturedFrom: raw.events[0]?.ts ?? null,
              reason: unknownOrder ? 'Snapshot-only events remain preserved in the original source; their archive order requires explicit recovery' : 'Imported snapshot may have lost older events before full capture began' } })
          this.db.prepare('INSERT INTO imports VALUES(?,?,?,?,?,?)').run(source, sourceDigest, root as string, raw.sessionId, raw.events.length, Date.now())
        })
      } catch (error) {
        this.diagnostics.push({ code: 'source_unreadable', source: basename(source), root, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  private backup(bytes: Buffer, sha: string): void {
    const directory = join(this.directory, 'history-originals')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, `${sha}.json`)
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' })
    if (digest(readFileSync(path)) !== sha) throw new Error('Original conversation backup digest mismatch')
  }
  /** Explicit verified prefix import is only possible before any cursors for that session exist. */
  importRecovery(root: string, record: AcpSessionRecord, input: { sourcePath: string; sourceDigest: string; events: TimelineEvent[] }): void {
    if (readHistoryDeletion(this.directory, root, record.sessionId)) throw new Error('此会话已进入永久删除')
    const bytes = readFileSync(input.sourcePath)
    if (digest(bytes) !== input.sourceDigest) throw new Error('Recovery source changed')
    this.backup(bytes, input.sourceDigest)
    if (this.db.prepare('SELECT 1 FROM imports WHERE source=? AND digest=?').get(input.sourcePath, input.sourceDigest)) return
    if (this.db.prepare('SELECT 1 FROM events WHERE root=? AND sessionId=? LIMIT 1').get(root, record.sessionId)) throw new HistoryCursorError('Recovery requires an unimported session archive')
    const first = record.events[0]?.ts ?? Infinity
    if (input.events.some((event) => event.projectRoot !== record.projectRoot || event.sessionId !== record.sessionId || event.ts >= first)) throw new Error('Recovery prefix is outside the verified conversation boundary')
    this.transaction(() => {
      for (const event of [...input.events, ...record.events]) this.insert(root, record.sessionId, event)
      this.saveMetadata({ root, record, events: [...input.events, ...record.events], coverage: { state: 'partial', capturedFrom: input.events[0]?.ts ?? null, reason: 'Verified native message prefix recovered; earlier panel diagnostics and continuity remain unknown' } })
      this.db.prepare('INSERT INTO imports VALUES(?,?,?,?,?,?)').run(input.sourcePath, input.sourceDigest, root, record.sessionId, input.events.length, Date.now())
    })
  }
  private summary(row: SessionRow, preferences = readSessionPreferences(this.directory, row.root), legacyIds: readonly string[] = []): AcpHistorySummary {
    const meta = JSON.parse(row.metadata) as AcpSessionRecord
    const aggregate = this.db.prepare(`SELECT COUNT(*) count,MAX(seq) seq,
      EXISTS(SELECT 1 FROM events WHERE root=? AND sessionId=? AND json_extract(payload,'$.source') IN ('acp','pi')
        AND (json_extract(payload,'$.sessionId') IS NULL OR json_extract(payload,'$.sessionId')=?)
        AND ((kind='message' AND json_type(payload,'$.text')='text' AND ${MESSAGE_TEXT}<>'') OR kind IN ('tool-call','permission'))) hasConversation
      FROM events WHERE root=? AND sessionId=?`).get(row.root, row.sessionId, row.sessionId, row.root, row.sessionId) as { count: number; seq: number | null; hasConversation: number }
    const latest = aggregate.seq === null ? undefined : this.db.prepare('SELECT eventId FROM events WHERE seq=?').get(aggregate.seq) as { eventId: string } | undefined
    const coverage = JSON.parse(row.coverage) as AcpHistoryCoverage
    const historyPersistence: AcpHistoryPersistence = { state: coverage.unarchivedCount ? 'degraded' : 'saved', pendingCount: coverage.unarchivedCount ?? 0, committedThroughEventId: latest?.eventId ?? null, committedThroughSeq: aggregate.seq,
      ...(coverage.unarchivedCount ? { error: coverage.reason, unarchivedCount: coverage.unarchivedCount } : {}) }
    const legacy = meta.schemaVersion !== 2
    const canResume = !legacy && isRecoverableRuntimeRecord(meta, legacyIds)
      && meta.canResume === true && typeof meta.backendSessionId === 'string' && !!meta.backendSessionId.trim()
    const preview = this.conversationPreview(row.root, row.sessionId)
    return { ...applySessionPreferences(meta, preferences), ...(preview ? { conversationPreview: preview.text, conversationPreviewAt: preview.at } : {}), status: legacy ? 'legacy' : ['closed', 'error'].includes(meta.status) ? meta.status : 'disconnected',
      canResume, historyKind: legacy ? 'legacy' : canResume ? 'resumable' : 'transcript', restorePending: false, connectionOwned: false, cleanupRequired: false,
      eventCount: aggregate.count, hasConversation: aggregate.hasConversation === 1, lastActivityAt: row.lastActivityAt, historyCoverage: coverage,
      historyPersistence, pendingPermissions: [], stateRevision: 0 }
  }
  session(root: string, sessionId: string, legacyIds: readonly string[] = []): AcpHistorySummary | null {
    if (readHistoryDeletion(this.directory, root, sessionId)) return null
    const row = this.db.prepare('SELECT * FROM sessions WHERE root=? AND sessionId=?').get(root, sessionId) as SessionRow | undefined
    return row ? this.summary(row, undefined, legacyIds) : null
  }
  handoff(root: string, sessionId: string, byteLimit: number): HandoffArchive | null {
    const session = this.session(root, sessionId)
    if (!session) return null
    try { return readHandoffArchive(this.db, root, session, byteLimit) }
    catch (error) { if (error instanceof HandoffHistoryError) throw new HistoryCursorError(error.message); throw error }
  }
  private encode(value: Record<string, unknown>): string { return Buffer.from(JSON.stringify({ epoch: this.epoch, ...value })).toString('base64url') }
  private decode(cursor: string): Record<string, unknown> {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
      if (value.epoch !== this.epoch) throw new Error('epoch')
      return value
    } catch { throw new HistoryCursorError('History cursor is invalid or belongs to another archive; refresh required') }
  }
  list(root: string, input: { limit?: number; cursor?: string; query?: string; filter?: string; archive?: string } = {}, legacyIds: readonly string[] = []): AcpHistoryListResult {
    const now = Date.now()
    for (const [id, snapshot] of this.snapshots) if (snapshot.expires <= now) this.snapshots.delete(id)
    const query = (input.query ?? '').trim().toLocaleLowerCase()
    const filter = input.filter ?? 'all'
    const archive = input.archive ?? 'active'
    const legacyIdsKey = JSON.stringify([...new Set(legacyIds)].sort())
    const preferences: SessionPreferences = readSessionPreferences(this.directory, root)
    let snapshotId: string
    let snapshot: Snapshot
    let position = 0
    if (input.cursor) {
      const cursor = this.decode(input.cursor)
      const known = this.snapshots.get(String(cursor.snapshot))
      if (cursor.kind !== 'list' || cursor.root !== root || !known || known.root !== root || known.query !== query || known.filter !== filter || known.archive !== archive || known.preferencesRevision !== preferences.revision || known.legacyIdsKey !== legacyIdsKey || !Number.isSafeInteger(cursor.position)) throw new HistoryCursorError('History catalogue snapshot expired or changed; refresh required')
      snapshotId = String(cursor.snapshot); snapshot = known; position = Number(cursor.position)
      if (position < 0 || position > snapshot.sessions.length) throw new HistoryCursorError('Invalid history catalogue position')
    } else {
      // Search the effective metadata, including manual titles on unloaded records.
      const rows = this.db.prepare('SELECT * FROM sessions WHERE root=?').all(root) as unknown as SessionRow[]
      snapshotId = randomUUID()
      snapshot = { root, query, filter, archive, preferencesRevision: preferences.revision, legacyIdsKey, expires: now + SNAPSHOT_TTL,
        sessions: rows.filter(row => !readHistoryDeletion(this.directory, root, row.sessionId)).map((row) => this.summary(row, preferences, legacyIds)).filter((item) => !isPrivateAcpRecord(item) && matchesHistorySummary(item, query, filter, archive)).sort(compareHistorySummaries) }
      if (this.snapshots.size >= 16) this.snapshots.delete(this.snapshots.keys().next().value ?? '')
      this.snapshots.set(snapshotId, snapshot)
    }
    const scanned = snapshot.sessions.slice(position, position + (input.limit ?? 30))
    const sessions = scanned.filter(item => !readHistoryDeletion(this.directory, root, item.sessionId))
    const next = position + scanned.length
    const hasMore = next < snapshot.sessions.length
    return { ok: true, version: 1, sessions, hasMore, nextCursor: hasMore ? this.encode({ kind: 'list', root, snapshot: snapshotId, position: next }) : null,
      snapshotId, searchScope: 'metadata', diagnostics: this.diagnostics.filter((item) => !item.root || item.root === root).map(({ root: _root, ...item }) => item) }
  }
  events(root: string, sessionId: string, input: { before?: string; after?: string; limit?: number } = {}): AcpHistoryEventPage | null {
    const session = this.session(root, sessionId)
    if (!session) return null
    if (input.before && input.after) throw new HistoryCursorError('Choose one transcript page direction')
    let bound: number | undefined
    if (input.before || input.after) {
      const cursor = this.decode(input.before ?? input.after ?? '')
      if (cursor.kind !== 'events' || cursor.root !== root || cursor.sessionId !== sessionId || !Number.isSafeInteger(cursor.seq) || Number(cursor.seq) < 1) throw new HistoryCursorError('Transcript cursor belongs to another conversation')
      bound = Number(cursor.seq)
    }
    // Iterate only grouping metadata in the worker; hydrate the selected range
    // once, without materializing the archive's text/image payloads in JS.
    const candidates = this.db.prepare(`SELECT seq,bytes,kind,turnId,
      json_extract(payload,'$.source') source,json_extract(payload,'$.projectRoot') projectRoot,
      json_extract(payload,'$.sessionId') sessionId,json_extract(payload,'$.connectionGeneration') connectionGeneration,
      json_extract(payload,'$.payload.role') role,json_extract(payload,'$.payload.activityScope') activityScope
      FROM events WHERE root=? AND sessionId=? ORDER BY seq`).iterate(root, sessionId) as unknown as Iterable<HistoryEventMetadata>
    let selection: ReturnType<typeof selectHistoryTurns>
    try { selection = selectHistoryTurns(candidates, { root, sessionId, after: !!input.after, bound, limit: input.limit }) }
    catch (error) { if (error instanceof HistoryTurnBoundaryError) throw new HistoryCursorError(error.message); throw error }
    const { first, last, startsMidTurn, oversized } = selection
    const rows = first === undefined || last === undefined ? [] : this.db.prepare('SELECT seq,payload FROM events WHERE root=? AND sessionId=? AND seq>=? AND seq<=? ORDER BY seq')
      .all(root, sessionId, first, last) as unknown as Array<{ seq: number; payload: string }>
    const events = rows.map((row) => historicalEvent({ ...JSON.parse(row.payload) as TimelineEvent, historySeq: row.seq }))
    const hasEarlier = first !== undefined && !!this.db.prepare('SELECT 1 FROM events WHERE root=? AND sessionId=? AND seq<? LIMIT 1').get(root, sessionId, first)
    const hasLater = last !== undefined && !!this.db.prepare('SELECT 1 FROM events WHERE root=? AND sessionId=? AND seq>? LIMIT 1').get(root, sessionId, last)
    return { ok: true, version: 1, session, events, hasEarlier, hasLater, startsMidTurn, oversized,
      beforeCursor: hasEarlier ? this.encode({ kind: 'events', root, sessionId, seq: first }) : null,
      afterCursor: hasLater ? this.encode({ kind: 'events', root, sessionId, seq: last }) : null,
      coverage: session.historyCoverage, historyPersistence: session.historyPersistence }
  }
}
