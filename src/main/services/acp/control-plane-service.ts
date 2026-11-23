import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  acpConversationDetailInputSchema,
  acpConversationEventsInputSchema,
  acpConversationListInputSchema,
  type AcpConversationDetailInput,
  type AcpConversationEventPage,
  type AcpConversationEventsInput,
  type AcpConversationListInput,
  type AcpConversationListSnapshot,
} from '../../../shared/acp-projections'
import type { AcpSessionMeta, TimelineEvent } from '../../../shared/types'
import { readHistoryDeletion } from './history-deletion'
import { AcpControlPlaneCursorError, AcpControlPlaneStore, type AcpControlPlaneMigrationSource } from './control-plane-store'
import { canonicalDirectory } from './metadata'
import { AcpV2FileStore, type AcpV2NativeRecord } from './v2/persistence'

export { AcpControlPlaneCursorError }

interface SessionRow { root: string; sessionId: string; metadata: string; coverage: string }
interface EventRow { seq: number; payload: string }
interface AggregateRow { count: number; lastSeq: number | null; digest: string | null }

const MIGRATION_SESSION_LIMIT = 100
const V2_RECORD_LIMIT = 200

function aggregate(value: Array<{ seq: number; payload: string }>): string {
  return createHash('sha256').update(value.map(row => `${row.seq}:${row.payload}`).join('\n')).digest('hex')
}

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
    if (!existsSync(path)) return undefined
    const db = new DatabaseSync(path, { readOnly: true, timeout: 2000 })
    try {
      const check = db.prepare('PRAGMA quick_check(1)').get() as { quick_check: string } | undefined
      if (check?.quick_check !== 'ok') throw new Error('Legacy conversation archive is damaged')
      return db
    } catch (error) { db.close(); throw error }
  }

  private migrateRoot(root: string): void {
    const archive = this.openArchive()
    if (!archive) return
    const store = this.ensureStore()
    try {
      const rows = archive.prepare('SELECT * FROM sessions WHERE root=? ORDER BY lastActivityAt DESC LIMIT ?')
        .all(root, MIGRATION_SESSION_LIMIT) as unknown as SessionRow[]
      for (const row of rows) {
        if (readHistoryDeletion(join(this.userData, 'acp'), row.root, row.sessionId)) continue
        const meta = JSON.parse(row.metadata) as AcpSessionMeta
        const events = archive.prepare('SELECT seq,payload FROM events WHERE root=? AND sessionId=? ORDER BY seq')
          .all(root, row.sessionId) as unknown as EventRow[]
        const engine = meta.engine ?? 'acp'
        const totals = events.length
          ? { count: events.length, lastSeq: events.at(-1)?.seq ?? null, digest: aggregate(events) }
          : archive.prepare(`SELECT COUNT(*) count,MAX(seq) lastSeq,NULL digest FROM events WHERE root=? AND sessionId=?`).get(root, row.sessionId) as unknown as AggregateRow
        if (totals.digest === null) totals.digest = createHash('sha256').update(JSON.stringify([row.metadata, row.coverage, totals.count, totals.lastSeq])).digest('hex')
        const state = store.migrationState(root, row.sessionId, engine)
        const lastProjectedSourceSequence = state ? store.lastSourceSequence(root, row.sessionId, engine) : null
        const source: AcpControlPlaneMigrationSource = {
          root, meta, events: events.map(item => ({ ...(JSON.parse(item.payload) as TimelineEvent), historySeq: item.seq })),
          sourceDigest: totals.digest, sourceLastSequence: totals.lastSeq,
          afterSourceSequence: lastProjectedSourceSequence ?? undefined,
          coverageReason: typeof JSON.parse(row.coverage).reason === 'string' ? JSON.parse(row.coverage).reason : undefined,
        }
        store.migrate(source)
      }
    } finally { archive.close() }
  }

  private migrateV2Records(root: string): void {
    const directory = join(this.userData, 'acp', 'runtime-v2-store')
    if (!existsSync(directory)) return
    const records = new AcpV2FileStore(directory).list(V2_RECORD_LIMIT)
    const store = this.ensureStore()
    for (const record of records) {
      if (record.cwd !== root || record.cleanupState === 'live') continue
      store.migrateV2({ root, record })
    }
  }

  list(root: string, rawInput: AcpConversationListInput): AcpConversationListSnapshot {
    const canonical = canonicalDirectory(root)
    this.migrateRoot(canonical)
    this.migrateV2Records(canonical)
    return this.ensureStore().list(canonical, rawInput)
  }

  detail(root: string, rawInput: AcpConversationDetailInput): AcpConversationListSnapshot | ReturnType<AcpControlPlaneStore['detail']> {
    const input = acpConversationDetailInputSchema.parse(rawInput)
    const canonical = canonicalDirectory(root)
    this.migrateRoot(canonical)
    this.migrateV2Records(canonical)
    if (readHistoryDeletion(join(this.userData, 'acp'), canonical, input.sessionId)) throw new AcpControlPlaneCursorError('conversation-reset')
    return this.ensureStore().detail(canonical, input)
  }

  events(root: string, rawInput: AcpConversationEventsInput): AcpConversationEventPage {
    const input = acpConversationEventsInputSchema.parse(rawInput)
    const canonical = canonicalDirectory(root)
    const store = this.ensureStore()
    if (input.after > store.currentSequence) {
      return { ok: false, version: 1, resetRequired: true, reason: 'cursor-ahead', snapshotSequence: store.currentSequence }
    }
    this.migrateRoot(canonical)
    this.migrateV2Records(canonical)
    if (readHistoryDeletion(join(this.userData, 'acp'), canonical, input.sessionId)) throw new AcpControlPlaneCursorError('conversation-reset')
    return store.events(canonical, input)
  }

  close(): void { this.store?.close(); this.store = undefined }
}
