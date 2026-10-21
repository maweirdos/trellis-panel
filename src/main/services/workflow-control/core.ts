/** Clean-room control storage. All SQL/transaction work runs in the owned worker. */
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  canonicalWorkflowJson, verifyWorkflowCommand, executionEventSchema,
  journalSnapshotSchema, runRefSchema, runManifestSchema, workflowCommandSchema,
  workflowEventReportSchema, workflowOperationSchema, workflowOwnerSchema,
  workflowRunSchema, workflowScopeSchema, workflowScopeIdentity,
  type WorkflowCommand, type WorkflowEventReport, type WorkflowJournalPort,
  type WorkflowReportSinkPort, type JournalCommit, type JournalSnapshot,
  type RunManifest, type RunRef, type WorkflowWriteAcknowledgement
} from '../../../shared/workflow'
import { CONTROL_SCHEMA_V1_DDL, STORE_DB_VERSION, readTaskAliasRecord, upsertTaskAliasRecord, type TaskAliasRecord } from '../observability/store-core'
import { taskRefFor } from '../task-identity'
import { WORKFLOW_CONTROL_DDL, WORKFLOW_CONTROL_SCHEMA_VERSION } from './schema'
import {
  MAX_CONTROL_REQUEST_BYTES, MAX_CONTROL_EVENTS_PER_COMMIT,
  commitInputSchema, leaseInputSchema, workspaceIdentitySchema, eventPageInputSchema, operationInputSchema,
  settleOperationInputSchema, reconcileOperationInputSchema, stepRecordSchema,
  WorkflowControlError, type WorkflowScope, type WorkflowOwner, type WorkspaceLease,
  type LeaseInput, type LeaseResult, type WorkspaceIdentity, type WorkflowCommitInput, type WorkflowCursor,
  type WorkflowEventPage, type OperationRecord, type WorkflowStepRecord,
  type WorkflowControlHealth, type ExecutionEvent
} from './types'

type OwnerRow = { workspaceKey: string; scopeKey: string; scopeJson: string; ownerId: string; pid: number; fencingToken: number; leaseUntil: number; state: WorkspaceLease['state']; updatedAt: number }
export type CommandRecord = { command: WorkflowCommand; status: 'reserved' | 'committed' | 'cancelled'; cursor: WorkflowCursor; requestHash: string; commitHash: string | null }
export type CoreOptions = {
  now?: () => number
  busyTimeoutMs?: number
  /** Test/diagnostic hook only; production adapters never pass process-exit hooks. */
  onTransactionStage?: (stage: 'before-commit' | 'after-commit') => void
}

export function controlDigest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function encode(value: unknown): string { return canonicalWorkflowJson(value) }
function workspaceKey(scope: WorkflowScope): string { return encode([scope.repositoryId, scope.workspaceId]) }
function runKey(run: RunRef): string { return encode([run.runId, run.revision]) }
function semanticCommandHash(command: WorkflowCommand): string {
  return controlDigest(encode({ scope: command.scope, runId: command.runId, expectedRevision: command.expectedRevision, kind: command.kind, payloadDigest: command.payloadDigest }))
}
function semanticCommitHash(input: WorkflowCommitInput): string {
  const { journal, manifests } = input
  return controlDigest(encode({
    commandHash: semanticCommandHash(journal.command), expectedCurrent: journal.expectedCurrent,
    runChanges: journal.runChanges.map(({ createdAt: _createdAt, ...run }) => run),
    manifests: manifests.map(({ recordedAt: _recordedAt, ...manifest }) => manifest),
    events: journal.events.map(({ receivedAt: _receivedAt, ...event }) => event),
    outbox: journal.outbox.map(({ ownerId: _ownerId, fencingToken: _fence, ...operation }) => operation)
  }))
}
function parsedJson<T>(value: unknown, schema: z.ZodType<T>): T {
  if (typeof value !== 'string') throw new WorkflowControlError('STORE_DEGRADED', 'Stored workflow data is unavailable')
  return schema.parse(JSON.parse(value))
}

export class WorkflowControlCore implements WorkflowJournalPort, WorkflowReportSinkPort {
  private db: DatabaseSync | undefined
  private epoch = ''
  private readonly now: () => number
  private readonly busyTimeoutMs: number
  constructor(private readonly runtimeDir: string, private readonly options: CoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.busyTimeoutMs = options.busyTimeoutMs ?? 2_000
    if (!isAbsolute(runtimeDir)) throw new WorkflowControlError('INVALID_DIRECTORY', 'The trusted runtime directory must be absolute')
    if (!Number.isSafeInteger(this.busyTimeoutMs) || this.busyTimeoutMs < 0 || this.busyTimeoutMs > 5_000) throw new WorkflowControlError('INVALID_ARGUMENT', 'Invalid SQLite busy budget')
  }

  databasePath(): string { return join(this.runtimeDir, 'control.sqlite') }
  open(): WorkflowControlHealth {
    if (this.db) return this.health()
    mkdirSync(this.runtimeDir, { recursive: true })
    const db = new DatabaseSync(this.databasePath())
    this.db = db
    try {
      db.exec(`PRAGMA busy_timeout=${this.busyTimeoutMs};`)
      const hasTable = (name: string): boolean => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
      const version = (table: string, key: string): number => {
        if (!hasTable(table)) return 0
        const row = db.prepare(`SELECT value FROM ${table} WHERE key=?`).get(key)
        if (!row) return 0
        const number = Number(row.value)
        if (!Number.isSafeInteger(number) || number < 0) throw new WorkflowControlError('STORE_DEGRADED', 'Invalid control schema metadata')
        return number
      }
      const base = version('control_schema_meta', 'dbVersion')
      const own = version('workflow_meta', 'schemaVersion')
      if (base > STORE_DB_VERSION || own > WORKFLOW_CONTROL_SCHEMA_VERSION) throw new WorkflowControlError('FUTURE_SCHEMA', 'Control storage was written by a newer application; refusing migration')
      const journal = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toLowerCase()
      if (journal !== 'delete') throw new WorkflowControlError('UNSUPPORTED_JOURNAL', 'Workflow control requires the existing DELETE journal policy')
      db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=${this.busyTimeoutMs};`)
      this.transaction(() => {
        if (version('control_schema_meta', 'dbVersion') > STORE_DB_VERSION || version('workflow_meta', 'schemaVersion') > WORKFLOW_CONTROL_SCHEMA_VERSION) throw new WorkflowControlError('FUTURE_SCHEMA', 'Schema advanced while waiting for the migration lock')
        db.exec(CONTROL_SCHEMA_V1_DDL)
        db.prepare("INSERT OR IGNORE INTO control_schema_meta(key,value) VALUES('dbVersion',?)").run(String(STORE_DB_VERSION))
        db.exec(WORKFLOW_CONTROL_DDL)
        if (!db.prepare('PRAGMA table_info(workflow_commands)').all().some((column) => column.name === 'commitHash')) db.exec('ALTER TABLE workflow_commands ADD COLUMN commitHash TEXT')
        db.prepare("INSERT OR IGNORE INTO workflow_meta(key,value) VALUES('schemaVersion',?)").run(String(WORKFLOW_CONTROL_SCHEMA_VERSION))
        db.prepare("INSERT OR IGNORE INTO workflow_meta(key,value) VALUES('storeEpoch',?)").run(randomUUID())
      }, false)
      const stored = db.prepare("SELECT value FROM workflow_meta WHERE key='storeEpoch'").get()
      if (!stored || typeof stored.value !== 'string' || stored.value.length === 0) throw new WorkflowControlError('STORE_DEGRADED', 'Control store identity is missing')
      this.epoch = stored.value
      return this.health()
    } catch (error) { this.close(); throw error }
  }
  close(): void { const db = this.db; this.db = undefined; this.epoch = ''; db?.close() }
  health(): WorkflowControlHealth {
    const db = this.requireDb()
    return { state: 'active', baseSchemaVersion: STORE_DB_VERSION, workflowSchemaVersion: WORKFLOW_CONTROL_SCHEMA_VERSION, journalMode: String(db.prepare('PRAGMA journal_mode').get()?.journal_mode), synchronous: Number(db.prepare('PRAGMA synchronous').get()?.synchronous), databasePath: this.databasePath() }
  }
  private requireDb(): DatabaseSync { if (!this.db) throw new WorkflowControlError('STORE_UNAVAILABLE', 'Workflow control is not open'); return this.db }
  private transaction<T>(work: () => T, diagnostic = true): T {
    const db = this.requireDb(); db.exec('BEGIN IMMEDIATE')
    let committed = false
    try {
      const result = work()
      if (diagnostic) this.options.onTransactionStage?.('before-commit')
      db.exec('COMMIT'); committed = true
      if (diagnostic) this.options.onTransactionStage?.('after-commit')
      return result
    } catch (error) { if (!committed) db.exec('ROLLBACK'); throw error }
  }
  private bounded(value: unknown): void {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_CONTROL_REQUEST_BYTES) throw new WorkflowControlError('REQUEST_TOO_LARGE', 'Workflow control request exceeds the bounded transaction budget')
  }
  private cursor(scope: WorkflowScope | null, sequence: number): WorkflowCursor {
    return { epoch: controlDigest(encode([this.epoch, scope ? workflowScopeIdentity(scope) : 'unassigned'])), sequence }
  }
  private maxSequence(scope: WorkflowScope): number {
    return Number(this.requireDb().prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM workflow_run_events WHERE scopeKey=?').get(workflowScopeIdentity(scope))?.value ?? 0)
  }
  private ownerRow(scope: WorkflowScope): OwnerRow | null {
    return (this.requireDb().prepare('SELECT * FROM workflow_owners WHERE workspaceKey=?').get(workspaceKey(scope)) as unknown as OwnerRow | undefined) ?? null
  }
  private unresolved(scope: WorkflowScope): boolean {
    const key = workflowScopeIdentity(scope)
    const uncertain = this.requireDb().prepare("SELECT operationId FROM workflow_dispatch_outbox WHERE scopeKey=? AND state='outcome-unknown' LIMIT 1").get(key)
    const runs = this.requireDb().prepare('SELECT runJson FROM workflow_runs WHERE scopeKey=?').all(key)
    return Boolean(uncertain) || runs.some((row) => parsedJson(row.runJson, workflowRunSchema).state === 'outcome-unknown')
  }
  private lease(row: OwnerRow): WorkspaceLease {
    const scope = parsedJson(row.scopeJson, workflowScopeSchema)
    return { scope, owner: { ownerId: row.ownerId, fencingToken: row.fencingToken }, pid: row.pid, leaseUntil: row.leaseUntil, state: row.state, recoveryRequired: this.unresolved(scope) || row.state === 'recovery-required' }
  }
  workspaceOwner(raw: WorkspaceIdentity): WorkspaceLease | null {
    const input = workspaceIdentitySchema.parse(raw)
    const row = this.requireDb().prepare('SELECT * FROM workflow_owners WHERE workspaceKey=?').get(encode([input.repositoryId, input.workspaceId])) as unknown as OwnerRow | undefined
    if (!row) return null
    const lease = this.lease(row)
    if (lease.scope.projectId !== input.projectId) throw new WorkflowControlError('SCOPE_CHANGED', 'This physical workspace has a different pinned project owner; ownership is not free')
    return lease
  }
  private requireOwner(scope: WorkflowScope, owner: WorkflowOwner, allowRecovery = false): OwnerRow {
    const row = this.ownerRow(scope)
    if (!row || row.scopeKey !== workflowScopeIdentity(scope) || row.ownerId !== owner.ownerId || row.fencingToken !== owner.fencingToken || row.pid !== process.pid || row.state !== 'active') throw new WorkflowControlError('OWNER_CONFLICT', 'Workspace owner or fencing token changed')
    if (row.leaseUntil < this.now()) throw new WorkflowControlError('LEASE_EXPIRED', 'Workspace lease expired; explicit renewal/recovery is required')
    if (!allowRecovery && this.unresolved(scope)) throw new WorkflowControlError('OUTCOME_UNKNOWN', 'Unresolved execution requires reconciliation before new dispatch', true)
    return row
  }
  claimWorkspace(raw: LeaseInput): LeaseResult {
    const input = leaseInputSchema.parse(raw)
    return this.transaction(() => {
      const row = this.ownerRow(input.scope)
      if (row && row.state === 'active') {
        if (row.ownerId !== input.ownerId || row.pid !== process.pid || row.scopeKey !== workflowScopeIdentity(input.scope)) return { status: 'owner-conflict', lease: this.lease(row) }
        this.requireDb().prepare('UPDATE workflow_owners SET leaseUntil=?,updatedAt=? WHERE workspaceKey=?').run(this.now() + input.ttlMs, this.now(), workspaceKey(input.scope))
        return { status: 'renewed', lease: this.lease({ ...row, leaseUntil: this.now() + input.ttlMs }) }
      }
      if (row && row.scopeKey !== workflowScopeIdentity(input.scope) && this.unresolved(parsedJson(row.scopeJson, workflowScopeSchema))) return { status: 'owner-conflict', lease: this.lease(row) }
      const owner: OwnerRow = { workspaceKey: workspaceKey(input.scope), scopeKey: workflowScopeIdentity(input.scope), scopeJson: encode(input.scope), ownerId: input.ownerId, pid: process.pid, fencingToken: (row?.fencingToken ?? 0) + 1, leaseUntil: this.now() + input.ttlMs, state: 'active', updatedAt: this.now() }
      this.requireDb().prepare('INSERT INTO workflow_owners(workspaceKey,scopeKey,scopeJson,ownerId,pid,fencingToken,leaseUntil,state,updatedAt) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspaceKey) DO UPDATE SET scopeKey=excluded.scopeKey,scopeJson=excluded.scopeJson,ownerId=excluded.ownerId,pid=excluded.pid,fencingToken=excluded.fencingToken,leaseUntil=excluded.leaseUntil,state=excluded.state,updatedAt=excluded.updatedAt').run(...Object.values(owner))
      return { status: 'acquired', lease: this.lease(owner) }
    })
  }
  renewWorkspace(raw: LeaseInput, rawOwner: WorkflowOwner): WorkspaceLease {
    const input = leaseInputSchema.parse(raw); const owner = workflowOwnerSchema.parse(rawOwner)
    return this.transaction(() => {
      const row = this.ownerRow(input.scope)
      if (!row || row.ownerId !== owner.ownerId || row.fencingToken !== owner.fencingToken || row.scopeKey !== workflowScopeIdentity(input.scope) || row.pid !== process.pid || row.state !== 'active') throw new WorkflowControlError('OWNER_CONFLICT', 'Cannot renew a foreign workspace owner')
      const until = this.now() + input.ttlMs
      this.requireDb().prepare('UPDATE workflow_owners SET leaseUntil=?,updatedAt=? WHERE workspaceKey=?').run(until, this.now(), workspaceKey(input.scope))
      return this.lease({ ...row, leaseUntil: until })
    })
  }
  releaseWorkspace(rawScope: WorkflowScope, rawOwner: WorkflowOwner): void {
    const scope = workflowScopeSchema.parse(rawScope); const owner = workflowOwnerSchema.parse(rawOwner)
    this.transaction(() => {
      this.requireOwner(scope, owner)
      const outstanding = this.requireDb().prepare("SELECT operationId FROM workflow_dispatch_outbox WHERE scopeKey=? AND state='dispatched' LIMIT 1").get(workflowScopeIdentity(scope))
      const activeRun = this.headRun(scope)
      if (outstanding || (activeRun && ['queued', 'dispatched', 'running', 'waiting', 'stopping'].includes(activeRun.state))) throw new WorkflowControlError('EXECUTION_ACTIVE', 'Active execution still owns the workspace')
      this.requireDb().prepare("UPDATE workflow_owners SET state='released',updatedAt=? WHERE workspaceKey=?").run(this.now(), workspaceKey(scope))
    })
  }
  private recover(scope: WorkflowScope, expectedOwner: WorkflowOwner): WorkspaceLease {
    return this.transaction(() => {
      const row = this.ownerRow(scope)
      if (!row || row.ownerId !== expectedOwner.ownerId || row.fencingToken !== expectedOwner.fencingToken || row.scopeKey !== workflowScopeIdentity(scope)) throw new WorkflowControlError('OWNER_CONFLICT', 'Recovery owner changed')
      try { process.kill(row.pid, 0); throw new WorkflowControlError('OWNER_STILL_ALIVE', 'Owner process is still alive; expiry or writer exit cannot release it') }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error }
      const evidenceKind = 'process-dead'
      const key = workflowScopeIdentity(scope)
      for (const item of this.requireDb().prepare("SELECT operationId,operationJson,attempts FROM workflow_dispatch_outbox WHERE scopeKey=? AND state='dispatched'").all(key)) {
        const operation = parsedJson(item.operationJson, workflowOperationSchema)
        this.writeOperation({ ...operation, state: 'outcome-unknown' }, { evidenceRefs: [evidenceKind], updatedAt: this.now() })
        this.requireDb().prepare("UPDATE workflow_dispatch_attempts SET state='outcome-unknown' WHERE scopeKey=? AND operationId=? AND attempt=? AND state='dispatched'").run(key, operation.operationId, Number(item.attempts))
      }
      for (const item of this.requireDb().prepare('SELECT runId,revision,runJson FROM workflow_runs WHERE scopeKey=?').all(key)) {
        const run = parsedJson(item.runJson, workflowRunSchema)
        if (['running', 'dispatched', 'stopping'].includes(run.state)) this.requireDb().prepare('UPDATE workflow_runs SET runJson=?,updatedAt=? WHERE scopeKey=? AND runId=? AND revision=?').run(encode({ ...run, state: 'outcome-unknown' }), this.now(), key, String(item.runId), Number(item.revision))
      }
      this.requireDb().prepare("UPDATE workflow_owners SET state='recovery-required',updatedAt=? WHERE workspaceKey=?").run(this.now(), workspaceKey(scope))
      this.requireDb().prepare('INSERT INTO workflow_owner_recoveries(recoveryId,workspaceKey,ownerId,fencingToken,evidenceKind,observedAt) VALUES(?,?,?,?,?,?)').run(randomUUID(), workspaceKey(scope), expectedOwner.ownerId, expectedOwner.fencingToken, evidenceKind, this.now())
      const head = this.headRun(scope)
      if (head) this.internalEvent(scope, head.run, `owner-recovery:${randomUUID()}`, 'workflow.owner-recovery', { evidenceKind, previousOwner: expectedOwner })
      return this.lease({ ...row, state: 'recovery-required' })
    })
  }
  recoverProcessOwner(scope: WorkflowScope, expectedOwner: WorkflowOwner): WorkspaceLease { return this.recover(workflowScopeSchema.parse(scope), workflowOwnerSchema.parse(expectedOwner)) }

  private headRun(scope: WorkflowScope): ReturnType<typeof workflowRunSchema.parse> | null {
    const row = this.requireDb().prepare('SELECT runId,revision FROM workflow_heads WHERE scopeKey=?').get(workflowScopeIdentity(scope))
    return row ? this.loadRun(scope, { runId: String(row.runId), revision: Number(row.revision) }) : null
  }
  private loadRun(scope: WorkflowScope, run: RunRef): ReturnType<typeof workflowRunSchema.parse> | null {
    const row = this.requireDb().prepare('SELECT runJson FROM workflow_runs WHERE scopeKey=? AND runId=? AND revision=?').get(workflowScopeIdentity(scope), run.runId, run.revision)
    return row ? parsedJson(row.runJson, workflowRunSchema) : null
  }
  getCommand(rawScope: WorkflowScope, commandId: string): CommandRecord | null {
    const scope = workflowScopeSchema.parse(rawScope); const id = z.string().min(1).parse(commandId)
    const row = this.requireDb().prepare('SELECT * FROM workflow_commands WHERE scopeKey=? AND commandId=?').get(workflowScopeIdentity(scope), id)
    return row ? { command: parsedJson(row.commandJson, workflowCommandSchema), status: z.enum(['reserved', 'committed', 'cancelled']).parse(row.status), cursor: this.cursor(scope, Number(row.acknowledgedSequence)), requestHash: String(row.requestHash), commitHash: row.commitHash === null ? null : String(row.commitHash) } : null
  }
  private admit(command: WorkflowCommand, owner: WorkflowOwner): WorkflowWriteAcknowledgement | null {
    const key = workflowScopeIdentity(command.scope); const head = this.headRun(command.scope)
    if (command.kind === 'start') {
      if (head && !['verified', 'failed', 'cancelled', 'stopped'].includes(head.state)) return { id: command.commandId, status: 'revision-conflict', cursor: null }
    } else if (!head || head.run.runId !== command.runId || head.run.revision !== command.expectedRevision) return { id: command.commandId, status: 'revision-conflict', cursor: null }
    const target = command.kind === 'start' ? 'start' : runKey({ runId: command.runId, revision: command.expectedRevision })
    if (command.kind === 'adopt-revision' || command.kind === 'start') {
      const reserved = this.requireDb().prepare('SELECT commandId FROM workflow_revision_reservations WHERE scopeKey=? AND targetKey=?').get(key, target)
      if (reserved && reserved.commandId !== command.commandId) return { id: command.commandId, status: 'revision-conflict', cursor: null }
      this.requireDb().prepare('INSERT OR IGNORE INTO workflow_revision_reservations(scopeKey,targetKey,commandId) VALUES(?,?,?)').run(key, target, command.commandId)
    }
    const cursor = this.internalEvent(command.scope, { runId: command.runId, revision: command.expectedRevision }, command.commandId, 'workflow.command-reserved', { kind: command.kind })
    this.requireDb().prepare('INSERT INTO workflow_commands(scopeKey,commandId,requestHash,commandJson,status,ownerId,fencingToken,acknowledgedSequence,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)').run(key, command.commandId, semanticCommandHash(command), encode(command), 'reserved', owner.ownerId, owner.fencingToken, cursor.sequence, this.now(), this.now())
    return null
  }
  async reserveCommand(raw: unknown, owner: WorkflowOwner): Promise<WorkflowWriteAcknowledgement> {
    this.bounded(raw); const command = await verifyWorkflowCommand(raw, controlDigest); workflowOwnerSchema.parse(owner)
    return this.transaction(() => {
      const existing = this.getCommand(command.scope, command.commandId)
      if (existing?.status === 'cancelled') throw new WorkflowControlError('COMMAND_CANCELLED', 'A cancelled command cannot be revived')
      if (existing) return { id: command.commandId, status: existing.requestHash === semanticCommandHash(command) ? 'duplicate' : 'payload-conflict', cursor: existing.cursor }
      this.requireOwner(command.scope, owner, command.kind === 'reconcile' || command.kind === 'request-stop')
      const conflict = this.admit(command, owner)
      return conflict ?? { id: command.commandId, status: 'committed', cursor: this.cursor(command.scope, this.maxSequence(command.scope)) }
    })
  }
  async commit(journal: JournalCommit): Promise<WorkflowWriteAcknowledgement> { return this.commitWithManifests({ journal, manifests: [] }) }
  cancelReservedCommand(rawScope: WorkflowScope, commandId: string, rawOwner: WorkflowOwner, evidenceRefs: string[]): WorkflowWriteAcknowledgement {
    const scope = workflowScopeSchema.parse(rawScope); const owner = workflowOwnerSchema.parse(rawOwner)
    z.string().min(1).max(512).parse(commandId); z.array(z.string().min(1).max(512)).min(1).max(20).parse(evidenceRefs)
    return this.transaction(() => {
      this.requireOwner(scope, owner, true)
      const record = this.getCommand(scope, commandId)
      if (!record) throw new WorkflowControlError('NOT_FOUND', 'Reserved command does not exist')
      if (record.status === 'cancelled') return { id: commandId, status: 'duplicate', cursor: record.cursor }
      if (record.status !== 'reserved') throw new WorkflowControlError('COMMAND_COMMITTED', 'Committed commands cannot be cancelled or erased')
      const cursor = this.internalEvent(scope, { runId: record.command.runId, revision: record.command.expectedRevision }, commandId, 'workflow.command-cancelled', { evidenceRefs })
      this.requireDb().prepare("UPDATE workflow_commands SET status='cancelled',acknowledgedSequence=?,updatedAt=? WHERE scopeKey=? AND commandId=?").run(cursor.sequence, this.now(), workflowScopeIdentity(scope), commandId)
      this.requireDb().prepare('DELETE FROM workflow_revision_reservations WHERE scopeKey=? AND commandId=?').run(workflowScopeIdentity(scope), commandId)
      return { id: commandId, status: 'committed', cursor }
    })
  }
  async commitWithManifests(raw: WorkflowCommitInput): Promise<WorkflowWriteAcknowledgement> {
    this.bounded(raw); const { journal, manifests } = commitInputSchema.parse(raw)
    if (journal.events.length > MAX_CONTROL_EVENTS_PER_COMMIT) throw new WorkflowControlError('REQUEST_TOO_LARGE', 'Too many events in one control transaction')
    const command = await verifyWorkflowCommand(journal.command, controlDigest)
    const commitHash = semanticCommitHash({ journal, manifests })
    return this.transaction(() => {
      const key = workflowScopeIdentity(command.scope); const existing = this.getCommand(command.scope, command.commandId)
      if (existing && existing.requestHash !== semanticCommandHash(command)) return { id: command.commandId, status: 'payload-conflict', cursor: existing.cursor }
      if (existing?.status === 'committed') return { id: command.commandId, status: existing.commitHash === commitHash ? 'duplicate' : 'payload-conflict', cursor: existing.cursor }
      if (existing?.status === 'cancelled') throw new WorkflowControlError('COMMAND_CANCELLED', 'A cancelled command cannot be revived')
      if (command.kind === 'adopt-revision' && !journal.runChanges.some((run) => run.predecessor && journal.expectedCurrent && encode(run.predecessor) === encode(journal.expectedCurrent))) throw new WorkflowControlError('INVALID_ADOPTION', 'Adoption completion needs one explicitly linked successor; use reservation while waiting for the boundary')
      this.requireOwner(command.scope, journal.owner, command.kind === 'reconcile' || command.kind === 'request-stop')
      const head = this.headRun(command.scope)
      if (journal.expectedCurrent && (!head || encode(head.run) !== encode(journal.expectedCurrent))) return { id: command.commandId, status: 'revision-conflict', cursor: null }
      if (!existing) { const conflict = this.admit(command, journal.owner); if (conflict) return conflict }
      const manifestMap = new Map<string, RunManifest>()
      for (const manifest of manifests) {
        if (workflowScopeIdentity(manifest.scope) !== key) throw new WorkflowControlError('SCOPE_CHANGED', 'Manifest belongs to another task')
        const identity = runKey(manifest.run)
        if (manifestMap.has(identity)) throw new WorkflowControlError('IDENTITY_CONFLICT', 'Duplicate adopted manifest')
        manifestMap.set(identity, manifest)
      }
      for (const run of journal.runChanges) {
        const manifest = manifestMap.get(runKey(run.run))
        if (manifest && encode(manifest.definition) !== encode(run.definition)) throw new WorkflowControlError('IDENTITY_CONFLICT', 'Run and manifest definitions differ')
        const previous = this.requireDb().prepare('SELECT manifestJson,runJson FROM workflow_runs WHERE scopeKey=? AND runId=? AND revision=?').get(key, run.run.runId, run.run.revision)
        let persistedRun = run
        if (previous) {
          const old = parsedJson(previous.runJson, workflowRunSchema)
          if (encode(old.definition) !== encode(run.definition) || encode(old.predecessor) !== encode(run.predecessor)) throw new WorkflowControlError('IDENTITY_CONFLICT', 'Run revision identity cannot change adopted meaning')
          if (manifest && previous.manifestJson !== null && encode(parsedJson(previous.manifestJson, runManifestSchema)) !== encode(manifest)) throw new WorkflowControlError('IDENTITY_CONFLICT', 'Adopted manifest is immutable')
          persistedRun = { ...run, createdAt: old.createdAt }
        }
        this.requireDb().prepare('INSERT INTO workflow_runs(scopeKey,runId,revision,runJson,manifestJson,updatedAt) VALUES(?,?,?,?,?,?) ON CONFLICT(scopeKey,runId,revision) DO UPDATE SET runJson=excluded.runJson,manifestJson=COALESCE(excluded.manifestJson,workflow_runs.manifestJson),updatedAt=excluded.updatedAt').run(key, run.run.runId, run.run.revision, encode(persistedRun), manifest ? encode(manifest) : null, this.now())
        manifestMap.delete(runKey(run.run))
        if (run.predecessor && encode(run.run) !== encode(journal.expectedCurrent)) this.requireDb().prepare('INSERT INTO workflow_revisions(scopeKey,predecessorRunId,predecessorRevision,successorRunId,successorRevision,commandId) VALUES(?,?,?,?,?,?)').run(key, run.predecessor.runId, run.predecessor.revision, run.run.runId, run.run.revision, command.commandId)
      }
      if (manifestMap.size) throw new WorkflowControlError('IDENTITY_CONFLICT', 'Manifest has no corresponding run change')
      const successor = journal.runChanges.find((run) => run.predecessor && journal.expectedCurrent && encode(run.predecessor) === encode(journal.expectedCurrent))
      const selected = successor ?? journal.runChanges.find((run) => run.run.runId === command.runId && run.run.revision === command.expectedRevision)
      if (!selected) throw new WorkflowControlError('REVISION_CONFLICT', 'No accepted target run exists')
      this.requireDb().prepare('INSERT INTO workflow_heads(scopeKey,runId,revision) VALUES(?,?,?) ON CONFLICT(scopeKey) DO UPDATE SET runId=excluded.runId,revision=excluded.revision').run(key, selected.run.runId, selected.run.revision)
      for (const event of journal.events) this.insertEvent(event, controlDigest(encode(event)))
      for (const operation of journal.outbox) {
        if (operation.state !== 'pending' || operation.result !== null) throw new WorkflowControlError('INVALID_OPERATION_STATE', 'New outbox operations must begin pending without a claimed result')
        if (!this.loadRun(command.scope, operation.run)) throw new WorkflowControlError('REVISION_CONFLICT', 'Outbox run is not persisted')
        this.requireDb().prepare('INSERT INTO workflow_dispatch_outbox(scopeKey,operationId,commandId,operationJson,state,ownerId,fencingToken,updatedAt) VALUES(?,?,?,?,?,?,?,?)').run(key, operation.operationId, command.commandId, encode(operation), operation.state, operation.ownerId, operation.fencingToken, this.now())
      }
      const cursor = this.internalEvent(command.scope, selected.run, command.commandId, 'workflow.command-committed', { kind: command.kind })
      this.requireDb().prepare("UPDATE workflow_commands SET status='committed',commitHash=?,ownerId=?,fencingToken=?,acknowledgedSequence=?,updatedAt=? WHERE scopeKey=? AND commandId=?").run(commitHash, journal.owner.ownerId, journal.owner.fencingToken, cursor.sequence, this.now(), key, command.commandId)
      if (command.kind === 'start') this.requireDb().prepare("DELETE FROM workflow_revision_reservations WHERE scopeKey=? AND targetKey='start' AND commandId=?").run(key, command.commandId)
      return { id: command.commandId, status: 'committed', cursor }
    })
  }

  async load(rawScope: WorkflowScope, rawRun: RunRef): Promise<JournalSnapshot | null> {
    const scope = workflowScopeSchema.parse(rawScope); const run = runRefSchema.parse(rawRun)
    const row = this.requireDb().prepare('SELECT runJson,manifestJson FROM workflow_runs WHERE scopeKey=? AND runId=? AND revision=?').get(workflowScopeIdentity(scope), run.runId, run.revision)
    if (!row) return null
    return journalSnapshotSchema.parse({ run: parsedJson(row.runJson, workflowRunSchema), manifest: row.manifestJson === null ? null : parsedJson(row.manifestJson, runManifestSchema), cursor: this.cursor(scope, this.maxSequence(scope)) })
  }
  async head(scope: WorkflowScope): Promise<JournalSnapshot | null> { const run = this.headRun(workflowScopeSchema.parse(scope)); return run ? this.load(scope, run.run) : null }
  private insertEvent(event: ExecutionEvent, digest: string): { cursor: WorkflowCursor; duplicate: boolean } {
    const scope = event.attribution.kind === 'assigned' ? event.attribution.scope : null
    const previous = this.requireDb().prepare('SELECT payloadDigest,sequence FROM workflow_run_events WHERE eventId=?').get(event.eventId)
    if (previous) {
      if (previous.payloadDigest !== digest) throw new WorkflowControlError('EVENT_PAYLOAD_CONFLICT', 'Existing event identity has different content')
      return { cursor: this.cursor(scope, Number(previous.sequence)), duplicate: true }
    }
    const run = event.attribution.kind === 'assigned' ? event.attribution.run : null
    const result = this.requireDb().prepare('INSERT INTO workflow_run_events(eventId,scopeKey,runId,revision,payloadDigest,eventJson,createdAt) VALUES(?,?,?,?,?,?,?)').run(event.eventId, scope ? workflowScopeIdentity(scope) : null, run?.runId ?? null, run?.revision ?? null, digest, encode(event), this.now())
    const sequence = Number(result.lastInsertRowid)
    if (scope) this.requireDb().prepare('INSERT INTO workflow_sync_outbox(deliveryId,scopeKey,eventId,sequence) VALUES(?,?,?,?)').run(controlDigest(encode([this.epoch, event.eventId])), workflowScopeIdentity(scope), event.eventId, sequence)
    return { cursor: this.cursor(scope, sequence), duplicate: false }
  }
  private internalEvent(scope: WorkflowScope, run: RunRef, identity: string, type: string, payload: Record<string, unknown>): WorkflowCursor {
    const event = executionEventSchema.parse({ contractVersion: 1, eventId: controlDigest(encode([workflowScopeIdentity(scope), identity, type])), source: 'platform', type, attribution: { kind: 'assigned', scope, run, step: null, sessionId: null, turnId: null, historySeq: null }, occurredAt: this.now(), receivedAt: this.now(), epoch: this.epoch, sequence: Number(this.requireDb().prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM workflow_run_events').get()?.next), payload })
    return this.insertEvent(event, controlDigest(encode(event))).cursor
  }
  async append(raw: WorkflowEventReport): Promise<WorkflowWriteAcknowledgement> {
    this.bounded(raw); const report = workflowEventReportSchema.parse(raw)
    if (controlDigest(encode(report.event)) !== report.payloadDigest) throw new WorkflowControlError('EVENT_PAYLOAD_CONFLICT', 'Actual event bytes do not match the declared digest')
    return this.transaction(() => {
      const attribution = report.event.attribution
      if (attribution.kind === 'assigned' && !this.loadRun(attribution.scope, attribution.run)) throw new WorkflowControlError('NOT_FOUND', 'Assigned event references an unknown run revision')
      const result = this.insertEvent(report.event, report.payloadDigest)
      return { id: report.event.eventId, status: result.duplicate ? 'duplicate' : 'committed', cursor: result.cursor }
    })
  }
  events(raw: z.input<typeof eventPageInputSchema>): WorkflowEventPage {
    const input = eventPageInputSchema.parse(raw); const scopeKey = workflowScopeIdentity(input.scope); const expected = this.cursor(input.scope, 0)
    const resetRequired = input.cursor !== null && (input.cursor.epoch !== expected.epoch || input.cursor.sequence > this.maxSequence(input.scope))
    if (resetRequired) return { items: [], cursor: expected, resetRequired: true, hasMore: false }
    const rows = this.requireDb().prepare('SELECT sequence,eventJson,payloadDigest FROM workflow_run_events WHERE scopeKey=? AND sequence>? ORDER BY sequence LIMIT ?').all(scopeKey, input.cursor?.sequence ?? 0, input.limit + 1)
    const items = rows.slice(0, input.limit).map((row) => ({ event: parsedJson(row.eventJson, executionEventSchema), cursor: this.cursor(input.scope, Number(row.sequence)), payloadDigest: String(row.payloadDigest) }))
    return { items, cursor: items.at(-1)?.cursor ?? input.cursor ?? expected, resetRequired: false, hasMore: rows.length > input.limit }
  }
  getOperation(rawScope: WorkflowScope, operationId: string): OperationRecord | null {
    const scope = workflowScopeSchema.parse(rawScope)
    const row = this.requireDb().prepare('SELECT * FROM workflow_dispatch_outbox WHERE scopeKey=? AND operationId=?').get(workflowScopeIdentity(scope), operationId)
    return row ? { operation: parsedJson(row.operationJson, workflowOperationSchema), attempts: Number(row.attempts), dispatchedAt: row.dispatchedAt === null ? null : Number(row.dispatchedAt), updatedAt: Number(row.updatedAt), evidenceRefs: parsedJson(row.evidenceJson, z.array(z.string())) } : null
  }
  private writeOperation(operation: z.infer<typeof workflowOperationSchema>, patch: { evidenceRefs?: string[]; updatedAt?: number; dispatchedAt?: number; attempts?: number }): void {
    const key = workflowScopeIdentity(operation.scope)
    this.requireDb().prepare('UPDATE workflow_dispatch_outbox SET operationJson=?,state=?,ownerId=?,fencingToken=?,evidenceJson=COALESCE(?,evidenceJson),updatedAt=?,dispatchedAt=COALESCE(?,dispatchedAt),attempts=COALESCE(?,attempts) WHERE scopeKey=? AND operationId=?').run(encode(operation), operation.state, operation.ownerId, operation.fencingToken, patch.evidenceRefs ? encode(patch.evidenceRefs) : null, patch.updatedAt ?? this.now(), patch.dispatchedAt ?? null, patch.attempts ?? null, key, operation.operationId)
  }
  pendingOperations(rawScope: WorkflowScope, rawOwner: WorkflowOwner, limit = 50): OperationRecord[] {
    const scope = workflowScopeSchema.parse(rawScope); const owner = workflowOwnerSchema.parse(rawOwner); z.number().int().min(1).max(100).parse(limit)
    this.requireOwner(scope, owner)
    return this.requireDb().prepare("SELECT operationId FROM workflow_dispatch_outbox WHERE scopeKey=? AND state='pending' ORDER BY operationId LIMIT ?").all(workflowScopeIdentity(scope), limit).map((row) => this.getOperation(scope, String(row.operationId))).filter((value): value is OperationRecord => value !== null)
  }
  claimOperation(raw: z.input<typeof operationInputSchema>): OperationRecord {
    const input = operationInputSchema.parse(raw)
    return this.transaction(() => {
      this.requireOwner(input.scope, input.owner, true)
      const current = this.getOperation(input.scope, input.operationId)
      if (!current) throw new WorkflowControlError('NOT_FOUND', 'Outbox operation not found')
      const purpose = current.operation.purpose ?? 'execute-step'
      if (purpose === 'execute-step') this.requireOwner(input.scope, input.owner)
      if (current.operation.state !== 'pending') throw new WorkflowControlError('OPERATION_NOT_PENDING', 'An operation may only dispatch once from pending', current.operation.state === 'outcome-unknown')
      if (!this.loadRun(input.scope, current.operation.run)) throw new WorkflowControlError('NOT_FOUND', 'Outbox operation references an unknown run revision')
      if (purpose === 'execute-step') {
        const head = this.headRun(input.scope)
        if (!head || encode(head.run) !== encode(current.operation.run)) throw new WorkflowControlError('REVISION_CONFLICT', 'Execution operation is no longer the current run revision')
        if (['stopping', 'stopped', 'cancelled', 'failed', 'verified', 'outcome-unknown'].includes(head.state)) throw new WorkflowControlError('EXECUTION_INACTIVE', 'The current run no longer permits step execution')
      }
      const operation = { ...current.operation, state: 'dispatched' as const, ownerId: input.owner.ownerId, fencingToken: input.owner.fencingToken }
      this.writeOperation(operation, { attempts: current.attempts + 1, dispatchedAt: this.now() })
      this.requireDb().prepare('INSERT INTO workflow_dispatch_attempts(scopeKey,operationId,attempt,ownerId,fencingToken,dispatchedAt,state) VALUES(?,?,?,?,?,?,?)').run(workflowScopeIdentity(input.scope), input.operationId, current.attempts + 1, input.owner.ownerId, input.owner.fencingToken, this.now(), 'dispatched')
      this.internalEvent(input.scope, operation.run, input.operationId, 'workflow.operation-dispatched', { operationId: input.operationId, attempt: current.attempts + 1 })
      const result = this.getOperation(input.scope, input.operationId)
      if (!result) throw new WorkflowControlError('STORE_DEGRADED', 'Dispatched operation is unavailable')
      return result
    })
  }
  settleOperation(raw: z.input<typeof settleOperationInputSchema>): OperationRecord {
    const input = settleOperationInputSchema.parse(raw)
    return this.transaction(() => {
      this.requireOwner(input.scope, input.owner, true)
      const current = this.getOperation(input.scope, input.operationId)
      if (!current || current.operation.state !== 'dispatched' || current.operation.ownerId !== input.owner.ownerId || current.operation.fencingToken !== input.owner.fencingToken) throw new WorkflowControlError('OPERATION_CONFLICT', 'Operation dispatch ownership or state changed')
      const operation = { ...current.operation, state: input.state, result: input.result }
      this.writeOperation(operation, { evidenceRefs: input.evidenceRefs })
      this.requireDb().prepare('UPDATE workflow_dispatch_attempts SET state=?,resultJson=? WHERE scopeKey=? AND operationId=? AND attempt=?').run(input.state, input.result === null ? null : encode(input.result), workflowScopeIdentity(input.scope), input.operationId, current.attempts)
      this.internalEvent(input.scope, operation.run, input.operationId, `workflow.operation-${input.state}`, { operationId: input.operationId, evidenceRefs: input.evidenceRefs })
      const result = this.getOperation(input.scope, input.operationId)
      if (!result) throw new WorkflowControlError('STORE_DEGRADED', 'Operation result is unavailable')
      return result
    })
  }
  reconcileOperation(raw: z.input<typeof reconcileOperationInputSchema>): OperationRecord {
    const input = reconcileOperationInputSchema.parse(raw)
    return this.transaction(() => {
      this.requireOwner(input.scope, input.owner, true)
      const current = this.getOperation(input.scope, input.operationId)
      if (!current || current.operation.state !== 'outcome-unknown') throw new WorkflowControlError('OPERATION_CONFLICT', 'Only an unresolved operation can be reconciled')
      const operation = { ...current.operation, state: input.status === 'confirmed' ? 'confirmed' as const : 'outcome-unknown' as const, result: input.result }
      this.writeOperation(operation, { evidenceRefs: input.evidenceRefs })
      this.requireDb().prepare('UPDATE workflow_dispatch_attempts SET state=?,resultJson=? WHERE scopeKey=? AND operationId=? AND attempt=?').run(operation.state, input.result === null ? null : encode(input.result), workflowScopeIdentity(input.scope), input.operationId, current.attempts)
      this.internalEvent(input.scope, operation.run, `${input.operationId}:${randomUUID()}`, 'workflow.operation-reconciled', { operationId: input.operationId, status: input.status, evidenceRefs: input.evidenceRefs })
      const result = this.getOperation(input.scope, input.operationId)
      if (!result) throw new WorkflowControlError('STORE_DEGRADED', 'Reconciled operation is unavailable')
      return result
    })
  }
  recordStep(raw: WorkflowStepRecord): void {
    this.bounded(raw); const record = stepRecordSchema.parse(raw)
    this.transaction(() => {
      this.requireOwner(record.scope, record.owner, true)
      if (!this.loadRun(record.scope, record.step)) throw new WorkflowControlError('NOT_FOUND', 'Step references an unknown run revision')
      const previous = this.requireDb().prepare('SELECT recordJson FROM workflow_steps WHERE scopeKey=? AND runId=? AND revision=? AND nodeId=? AND attempt=?').get(workflowScopeIdentity(record.scope), record.step.runId, record.step.revision, record.step.nodeId, record.step.attempt)
      if (previous) {
        const old = parsedJson(previous.recordJson, stepRecordSchema)
        if (old.inputFingerprint !== record.inputFingerprint || encode(old.materialRefs) !== encode(record.materialRefs)) throw new WorkflowControlError('IDENTITY_CONFLICT', 'A step attempt cannot change its effective input fingerprint or ordered material references')
      }
      this.requireDb().prepare('INSERT INTO workflow_steps(scopeKey,runId,revision,nodeId,attempt,recordJson,updatedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(scopeKey,runId,revision,nodeId,attempt) DO UPDATE SET recordJson=excluded.recordJson,updatedAt=excluded.updatedAt').run(workflowScopeIdentity(record.scope), record.step.runId, record.step.revision, record.step.nodeId, record.step.attempt, encode(record), record.updatedAt)
    })
  }
  steps(scope: WorkflowScope, run: RunRef): WorkflowStepRecord[] {
    workflowScopeSchema.parse(scope); runRefSchema.parse(run)
    return this.requireDb().prepare('SELECT recordJson FROM workflow_steps WHERE scopeKey=? AND runId=? AND revision=? ORDER BY nodeId,attempt').all(workflowScopeIdentity(scope), run.runId, run.revision).map((row) => parsedJson(row.recordJson, stepRecordSchema))
  }
  syncPage(scope: WorkflowScope, limit = 100): Array<{ deliveryId: string; eventId: string; cursor: WorkflowCursor }> {
    workflowScopeSchema.parse(scope); z.number().int().min(1).max(200).parse(limit)
    return this.requireDb().prepare("SELECT deliveryId,eventId,sequence FROM workflow_sync_outbox WHERE scopeKey=? AND state='pending' ORDER BY sequence LIMIT ?").all(workflowScopeIdentity(scope), limit).map((row) => ({ deliveryId: String(row.deliveryId), eventId: String(row.eventId), cursor: this.cursor(scope, Number(row.sequence)) }))
  }
  confirmSync(scope: WorkflowScope, deliveryIds: string[]): void {
    workflowScopeSchema.parse(scope); z.array(z.string().min(1)).max(200).parse(deliveryIds)
    this.transaction(() => { for (const id of deliveryIds) this.requireDb().prepare("UPDATE workflow_sync_outbox SET state='confirmed',confirmedAt=? WHERE scopeKey=? AND deliveryId=?").run(this.now(), workflowScopeIdentity(scope), id) })
  }
  getAlias(taskRef: string): TaskAliasRecord | null {
    return readTaskAliasRecord(this.requireDb(), z.string().min(1).max(512).parse(taskRef))
  }
  upsertAlias(taskRef: string, trellisTaskId: string | null, dir: string): TaskAliasRecord | null {
    z.string().min(1).max(512).parse(taskRef)
    z.string().min(1).max(256).nullable().parse(trellisTaskId)
    if (!/^\.trellis\/tasks\/(?:archive\/[0-9]{4}-[0-9]{2}\/)?[^/\\]+$/.test(dir) || dir.split('/').includes('..')) throw new WorkflowControlError('INVALID_ALIAS', 'Verified alias must be a repository-relative Trellis task directory')
    if (taskRefFor(trellisTaskId, dir) !== taskRef) throw new WorkflowControlError('IDENTITY_CONFLICT', 'Alias reference differs from the existing task identity authority')
    return this.transaction(() => upsertTaskAliasRecord(this.requireDb(), taskRef, trellisTaskId, dir))
  }
}
