import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  acpConversationDetailInputSchema,
  acpConversationEventsInputSchema,
  type AcpConversationDetailInput,
  type AcpConversationEventPage,
  type AcpConversationEventsInput,
  type AcpConversationListInput,
  type AcpConversationListSnapshot,
} from '../../../shared/acp-projections'
import type { AcpSessionMeta, TimelineEvent } from '../../../shared/types'
import { listHistoryDeletions, readHistoryDeletion } from './history-deletion'
import { AcpControlPlaneCursorError, AcpControlPlaneStore } from './control-plane-store'
import { canonicalDirectory } from './metadata'
import { isPrivateAcpRecord } from './private-access'
import { AcpV2FileStore, type AcpV2NativeRecord } from './v2/persistence'

export { AcpControlPlaneCursorError }

interface SessionRow { root: string; sessionId: string; metadata: string; coverage: string; lastActivityAt: number }
interface EventRow { seq: number; payload: string }

const MIGRATION_SESSION_LIMIT = 100
const V2_RECORD_LIMIT = 200
const ARCHIVE_PAGE_ROWS = 256
const ARCHIVE_PAGE_BYTES = 2 * 1024 * 1024

/** All source reads are read-only and stay local to the daemon. */
export class AcpConversationProjectionService {
  private store: AcpControlPlaneStore | undefined

  constructor(private readonly userData: string) {}

  private ensureStore(): AcpControlPlaneStore {
    if (!isAbsolute(this.userData)) throw new Error('Projection user data must be absolute')
    if (!this.store) this.store = new AcpControlPlaneStore(join(this.userData, 'acp'), 'primary')
    return this.store
  }

  private openArchive(): DatabaseSync | undefined {
    const path = join(this.userData, 'acp', 'history.sqlite')
    return existsSync(path) ? new DatabaseSync(path, { readOnly: true, timeout: 2000 }) : undefined
  }

  private migrateArchive(archive: DatabaseSync, root: string, nativeRecords: ReadonlyMap<string, AcpV2NativeRecord>, sessionId?: string): { rows: number; bytes: number } {
    const store = this.ensureStore()
    const epoch = archive.prepare("SELECT value FROM archive_meta WHERE key='epoch'").get()?.value
    if (typeof epoch !== 'string' || !epoch) throw new Error('Conversation archive identity missing')
    const rows = (sessionId === undefined
      ? archive.prepare('SELECT * FROM sessions WHERE root=? ORDER BY lastActivityAt DESC LIMIT ?')
        .all(root, MIGRATION_SESSION_LIMIT) as unknown as SessionRow[]
      : archive.prepare('SELECT * FROM sessions WHERE root=? AND sessionId=?')
        .all(root, sessionId) as unknown as SessionRow[])
    const headFor = archive.prepare('SELECT seq FROM events WHERE root=? AND sessionId=? ORDER BY seq DESC LIMIT 1')
    const eventsFor = archive.prepare('SELECT seq,payload FROM events WHERE root=? AND sessionId=? AND seq>? ORDER BY seq LIMIT ?')
    const countAfter = archive.prepare('SELECT COUNT(*) count FROM events WHERE root=? AND sessionId=? AND seq>?')
    const consumed = { rows: 0, bytes: 0 }
    for (const row of rows) {
      const meta = JSON.parse(row.metadata) as AcpSessionMeta
      if (meta.sessionId !== row.sessionId || isPrivateAcpRecord(meta) || readHistoryDeletion(join(this.userData, 'acp'), row.root, row.sessionId)) continue
      const engine = meta.engine ?? 'acp'
      const nativeRecord = nativeRecords.get(row.sessionId)
      const nativeSessionId = engine === 'acp'
        ? meta.capabilities?.protocolVersion === 2 ? meta.backendSessionId
          : nativeRecord && (meta.backendSessionId === undefined || meta.backendSessionId === nativeRecord.nativeSessionId) ? nativeRecord.nativeSessionId : undefined
        : undefined
      const sourceEpoch = nativeSessionId === undefined ? epoch
        : createHash('sha256').update(JSON.stringify([epoch, 'native-items-v1', nativeSessionId])).digest('hex')
      const head = Number(headFor.get(root, row.sessionId)?.seq ?? 0)
      const sourceDigest = createHash('sha256').update(JSON.stringify([sourceEpoch, row.metadata, row.coverage, head])).digest('hex')
      const state = store.migrationState(root, row.sessionId, engine)
      const after = store.archiveCursor(root, row.sessionId, engine, sourceEpoch, head)
      if (state?.sourceDigest === sourceDigest && (after === head || sessionId === undefined)) continue
      const events: Array<TimelineEvent & { historySeq: number }> = []
      if (sessionId !== undefined && after < head) {
        const page = eventsFor.iterate(root, row.sessionId, after, ARCHIVE_PAGE_ROWS) as unknown as Iterable<EventRow>
        for (const event of page) {
          const size = Buffer.byteLength(event.payload)
          if (events.length > 0 && consumed.bytes + size > ARCHIVE_PAGE_BYTES) break
          events.push({ ...(JSON.parse(event.payload) as TimelineEvent), historySeq: event.seq })
          consumed.bytes += size
          consumed.rows += 1
        }
      }
      const appliedThrough = events.at(-1)?.historySeq ?? after
      const coverage = JSON.parse(row.coverage) as { state?: unknown; reason?: unknown }
      store.migrateArchive({
        root, meta, events, sourceEpoch, sourceDigest, throughSequence: head, lastActivityAt: row.lastActivityAt, nativeSessionId,
        remainingEventCount: sessionId === undefined || appliedThrough === head ? 0 : Number(countAfter.get(root, row.sessionId, appliedThrough)?.count ?? 0),
        coverageState: coverage.state === 'partial' || coverage.state === 'unknown' ? coverage.state : 'complete',
        coverageReason: typeof coverage.reason === 'string' ? coverage.reason : undefined,
      })
    }
    return consumed
  }

  private readV2Records(root: string, sessionId?: string, nativeRecordId?: string): Map<string, AcpV2NativeRecord> {
    const directory = join(this.userData, 'acp', 'runtime-v2-store')
    const records = new Map<string, AcpV2NativeRecord>()
    if (!existsSync(directory)) return records
    const files = new AcpV2FileStore(directory)
    const targeted = nativeRecordId === undefined ? undefined : files.readProjectionRecord(nativeRecordId)
    for (const record of targeted === undefined ? files.list(V2_RECORD_LIMIT) : [targeted]) {
      if (sessionId !== undefined && record.sessionKey !== sessionId) continue
      const projectRoot = record.projectRoot ?? record.cwd
      if (!isAbsolute(projectRoot) || canonicalDirectory(projectRoot) !== root
        || isPrivateAcpRecord({ sessionId: record.sessionKey })
        || readHistoryDeletion(join(this.userData, 'acp'), root, record.sessionKey)
        || records.has(record.sessionKey)) continue
      records.set(record.sessionKey, record)
    }
    return records
  }

  private refresh(root: string, sessionId?: string): void {
    const archive = this.openArchive()
    try {
      archive?.exec('BEGIN')
      const archived = archive?.prepare('SELECT metadata FROM sessions WHERE root=? AND sessionId=?')
      const metadata = (key: string): AcpSessionMeta | undefined => {
        const value = archived?.get(root, key)?.metadata
        return typeof value === 'string' ? JSON.parse(value) as AcpSessionMeta : undefined
      }
      const nativeRecords = this.readV2Records(root, sessionId, sessionId === undefined ? undefined : metadata(sessionId)?.nativeRecordId)
      const consumed = archive === undefined ? { rows: 0, bytes: 0 } : this.migrateArchive(archive, root, nativeRecords, sessionId)
      const headFor = archive?.prepare('SELECT seq FROM events WHERE root=? AND sessionId=? ORDER BY seq DESC LIMIT 1')
      for (const [key, record] of nativeRecords) {
        const meta = metadata(key)
        if (meta !== undefined && (meta.sessionId !== key || isPrivateAcpRecord(meta) || (meta.engine ?? 'acp') !== 'acp'
          || (meta.nativeRecordId !== undefined && meta.nativeRecordId !== record.recordId)
          || (meta.backendSessionId !== undefined && meta.backendSessionId !== record.nativeSessionId))) continue
        const archiveHead = meta === undefined ? undefined : Number(headFor?.get(root, key)?.seq ?? 0)
        this.ensureStore().migrateV2({ root, record, archiveHead, budget: {
          rows: ARCHIVE_PAGE_ROWS - consumed.rows, bytes: Math.max(0, ARCHIVE_PAGE_BYTES - consumed.bytes),
        } })
      }
    } finally { archive?.close() }
  }

  list(root: string, rawInput: AcpConversationListInput): AcpConversationListSnapshot {
    const canonical = canonicalDirectory(root)
    this.refresh(canonical)
    const store = this.ensureStore()
    const deleted = listHistoryDeletions(join(this.userData, 'acp'), canonical)
    if (deleted.length > 0) store.removeDeleted(canonical, deleted.map(entry => entry.metadata.sessionId))
    return store.list(canonical, rawInput)
  }

  detail(root: string, rawInput: AcpConversationDetailInput): ReturnType<AcpControlPlaneStore['detail']> {
    const input = acpConversationDetailInputSchema.parse(rawInput)
    const canonical = canonicalDirectory(root)
    this.assertReadable(canonical, input.sessionId)
    this.refresh(canonical, input.sessionId)
    return this.ensureStore().detail(canonical, input)
  }

  events(root: string, rawInput: AcpConversationEventsInput): AcpConversationEventPage {
    const input = acpConversationEventsInputSchema.parse(rawInput)
    const canonical = canonicalDirectory(root)
    const store = this.ensureStore()
    if (input.after > store.currentSequence) {
      return { ok: false, version: 1, resetRequired: true, reason: 'cursor-ahead', snapshotSequence: store.currentSequence }
    }
    this.assertReadable(canonical, input.sessionId)
    this.refresh(canonical, input.sessionId)
    return store.events(canonical, input)
  }

  private assertReadable(root: string, sessionId: string): void {
    if (isPrivateAcpRecord({ sessionId }) || readHistoryDeletion(join(this.userData, 'acp'), root, sessionId)) {
      throw new AcpControlPlaneCursorError('conversation-reset')
    }
  }

  close(): void { this.store?.close(); this.store = undefined }
}
