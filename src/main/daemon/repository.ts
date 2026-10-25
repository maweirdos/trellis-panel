import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DAEMON_LIMITS, commandReceiptSchema, daemonEventSchema, daemonPreferencesSchema, processOwnerSchema, workspaceGrantSchema, type DaemonEvent, type DaemonRequest, type DaemonPreferences, type EventCursor, type ProcessOwner, type WorkspaceGrant } from '../../shared/daemon'
import { integrationJobCountsSchema, integrationJobSchema, type IntegrationJob, type IntegrationJobState } from '../../shared/integration-work'
import { canonicalWorkflowJson } from '../../shared/workflow'
import { readBounded, writeAtomic } from './files'
import { DaemonError } from './errors'

const receiptSchema = commandReceiptSchema.extend({ digest: z.string().length(64), workspaceId: z.string().nullable(), result: z.unknown() }).strict()
const startupRegistrationSchema = z.object({ executable: z.string().min(1).max(4096), args: z.array(z.string().max(8192)).max(8), name: z.string().min(1).max(128), installationId: z.string().length(64) }).strict()
export type StartupRegistration = z.infer<typeof startupRegistrationSchema>
const stateSchema = z.object({
  version: z.literal(1), epoch: z.string().uuid(), sequence: z.number().int().nonnegative().safe(),
  preferences: daemonPreferencesSchema, grants: z.array(workspaceGrantSchema).max(100),
  startupIntent: z.object({ commandId: z.string().uuid(), preferences: daemonPreferencesSchema, registration: startupRegistrationSchema }).strict().nullable().default(null),
  jobs: z.array(integrationJobSchema).max(DAEMON_LIMITS.jobs),
  admissions: z.array(z.object({ jobId: z.string().uuid(), grant: workspaceGrantSchema, owner: processOwnerSchema }).strict()).max(DAEMON_LIMITS.jobs),
  commands: z.array(receiptSchema).max(DAEMON_LIMITS.commands),
  events: z.array(daemonEventSchema).max(DAEMON_LIMITS.retainedEvents)
}).strict().superRefine((state, context) => {
  const unique = (values: string[], label: string): void => { if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: `Duplicate ${label} identity` }) }
  unique(state.grants.map((item) => item.workspaceId), 'workspace'); unique(state.grants.map((item) => item.grantId), 'grant')
  unique(state.jobs.map((item) => item.id), 'job'); unique(state.commands.map((item) => item.commandId), 'command')
  unique(state.jobs.map((item) => item.commandId), 'job command')
  unique(state.admissions.map((item) => item.jobId), 'admission')
  const jobs = new Map(state.jobs.map((job) => [job.id, job]))
  const commands = new Map(state.commands.map((command) => [command.commandId, command]))
  const admissions = new Map(state.admissions.map((entry) => [entry.jobId, entry]))
  const counts = new Map<string, number>()
  for (const job of state.jobs) {
    const admission = admissions.get(job.id)
    const command = commands.get(job.commandId)
    if (admission?.grant.workspaceId !== job.workspaceId) context.addIssue({ code: 'custom', message: 'Job admission identity is missing or foreign' })
    if (!command || command.state !== 'committed' || command.method !== 'jobs.enqueue' || command.jobId !== job.id || command.workspaceId !== job.workspaceId) context.addIssue({ code: 'custom', message: 'Job lost its original committed admission command' })
    if (activeJob(job) && JSON.stringify(state.grants.find((grant) => grant.workspaceId === job.workspaceId)) !== JSON.stringify(admission?.grant)) context.addIssue({ code: 'custom', message: 'Active job lost its retained workspace grant' })
    if (['queued', 'dispatched', 'running', 'paused', 'cancel-requested', 'unknown'].includes(job.state)) counts.set(job.workspaceId, (counts.get(job.workspaceId) ?? 0) + 1)
  }
  if (state.admissions.some((entry) => !jobs.has(entry.jobId)) || [...counts.values()].some((count) => count > DAEMON_LIMITS.jobsPerWorkspace)) context.addIssue({ code: 'custom', message: 'Invalid admission or workspace work bound' })
  if (state.commands.some((command) => command.jobId !== null && jobs.get(command.jobId)?.workspaceId !== command.workspaceId)) context.addIssue({ code: 'custom', message: 'Command refers to a missing or foreign job' })
  if (state.events.some((event, index) => event.cursor.epoch !== state.epoch || event.cursor.sequence > state.sequence || index > 0 && event.cursor.sequence !== state.events[index - 1].cursor.sequence + 1)) context.addIssue({ code: 'custom', message: 'Invalid committed event sequence' })
  if ((state.events.at(-1)?.cursor.sequence ?? 0) !== state.sequence) context.addIssue({ code: 'custom', message: 'Committed event tail does not match its cursor' })
  if (state.startupIntent && !state.commands.some((command) => command.commandId === state.startupIntent?.commandId && command.state === 'unknown' && command.method === 'daemon.preferences.set')) context.addIssue({ code: 'custom', message: 'Startup intent lost its original command receipt' })
  if (state.startupIntent && state.startupIntent.preferences.revision !== state.preferences.revision) context.addIssue({ code: 'custom', message: 'Startup intent lost its original preferences revision' })
})
type State = z.infer<typeof stateSchema>
type Transaction = { state: State; emit: (event: Omit<DaemonEvent, 'cursor' | 'at'>) => void }
const transitions: Record<IntegrationJobState, readonly IntegrationJobState[]> = {
  queued: ['dispatched', 'cancelled', 'paused'], dispatched: ['running', 'paused', 'completed', 'cancelled', 'partially-failed', 'unknown', 'cancel-requested'],
  running: ['paused', 'completed', 'cancelled', 'partially-failed', 'unknown', 'cancel-requested'],
  paused: ['queued', 'cancelled', 'rollback-blocked'], 'partially-failed': ['rollback-blocked'],
  'cancel-requested': ['cancelled', 'unknown', 'completed', 'partially-failed'], unknown: ['completed', 'cancelled', 'partially-failed', 'rollback-blocked'],
  completed: ['rollback-blocked'], cancelled: ['rollback-blocked'], 'rollback-blocked': []
}
export const activeJob = (job: IntegrationJob): boolean => ['queued', 'dispatched', 'running', 'paused', 'cancel-requested', 'unknown'].includes(job.state)

/** One daemon lease, one atomic repository, command+job+outbox+event in one publication. */
export class DaemonRepository {
  private state: State
  private readonly file: string
  private readonly observers = new Set<(event: DaemonEvent) => void>()
  constructor(directory: string, readonly epoch: string, private readonly assertOwner: () => void, private readonly owner: ProcessOwner) {
    this.file = join(directory, 'integration-ledger.json')
    if (existsSync(this.file)) {
      try { this.state = stateSchema.parse(JSON.parse(readBounded(this.file, DAEMON_LIMITS.storeBytes))) }
      catch { throw new DaemonError('E_IO', 'Integration ledger is corrupt, oversized or from a future version. The original file is preserved.') }
    } else this.state = { version: 1, epoch, sequence: 0, preferences: { revision: 1, keepRunning: false, startup: 'client' }, startupIntent: null, grants: [], jobs: [], admissions: [], commands: [], events: [] }
    this.transact(({ state, emit }) => {
      state.epoch = epoch; state.sequence = 0; state.events = []
      // A lost process/adapter acknowledgement is not permission to repeat external work.
      for (const job of state.jobs) if (['dispatched', 'running', 'cancel-requested'].includes(job.state)) {
        job.state = 'unknown'; job.revision++; job.updatedAt = Date.now()
        emit({ kind: 'job.changed', entityId: job.id, revision: job.revision, workspaceId: job.workspaceId })
      }
    })
  }
  private transact<T>(change: (transaction: Transaction) => T): T {
    this.assertOwner()
    const next = structuredClone(this.state)
    const emitted: DaemonEvent[] = []
    const result = change({ state: next, emit: (event) => {
      const full = daemonEventSchema.parse({ ...event, cursor: { epoch: this.epoch, sequence: ++next.sequence }, at: Date.now() })
      next.events.push(full); emitted.push(full)
      next.events = next.events.slice(-DAEMON_LIMITS.retainedEvents)
    } })
    const validated = stateSchema.parse(next)
    const text = JSON.stringify(validated)
    if (Buffer.byteLength(text) > DAEMON_LIMITS.storeBytes) throw new DaemonError('E_BUSY', 'The integration ledger is full. Export/reconcile retained commands before admitting more work.')
    this.assertOwner()
    writeAtomic(this.file, text)
    this.state = validated
    for (const event of emitted) for (const observer of this.observers) {
      try { observer(event) } catch { this.observers.delete(observer) }
    }
    return structuredClone(result)
  }
  observe(observer: (event: DaemonEvent) => void): () => void { this.observers.add(observer); return () => this.observers.delete(observer) }
  cursor(): EventCursor { return { epoch: this.epoch, sequence: this.state.sequence } }
  preferences(): DaemonPreferences { return structuredClone(this.state.preferences) }
  startupIntent(): State['startupIntent'] { return structuredClone(this.state.startupIntent) }
  grant(id: string): WorkspaceGrant | null { return structuredClone(this.state.grants.find((grant) => grant.workspaceId === id) ?? null) }
  jobs(workspaceId: string): IntegrationJob[] { return structuredClone(this.state.jobs.filter((job) => job.workspaceId === workspaceId)) }
  allJobs(): IntegrationJob[] { return structuredClone(this.state.jobs) }
  admission(jobId: string): WorkspaceGrant | null { return structuredClone(this.state.admissions.find((item) => item.jobId === jobId)?.grant ?? null) }
  admittedOwner(jobId: string): ProcessOwner | null { return structuredClone(this.state.admissions.find((item) => item.jobId === jobId)?.owner ?? null) }
  job(id: string, workspaceId: string): IntegrationJob | null { return structuredClone(this.state.jobs.find((job) => job.id === id && job.workspaceId === workspaceId) ?? null) }
  receipt(commandId: string, workspaceId: string | null = null): z.infer<typeof commandReceiptSchema> | null {
    const receipt = this.state.commands.find((item) => item.commandId === commandId && item.workspaceId === workspaceId)
    return receipt ? commandReceiptSchema.parse({ commandId: receipt.commandId, method: receipt.method, state: receipt.state, jobId: receipt.jobId, committedAt: receipt.committedAt }) : null
  }
  replay(after: EventCursor, workspaceId: string | null, limit: number): { events: DaemonEvent[]; cursor: EventCursor; hasMore: boolean; resetRequired: boolean } {
    const oldest = this.state.events[0]?.cursor.sequence ?? this.state.sequence + 1
    if (after.epoch !== this.epoch || after.sequence < oldest - 1 || after.sequence > this.state.sequence) return { events: [], cursor: this.cursor(), hasMore: false, resetRequired: true }
    const visible = this.state.events.filter((event) => event.cursor.sequence > after.sequence && (event.workspaceId === null || event.workspaceId === workspaceId))
    const events = visible.slice(0, limit)
    const hasMore = visible.length > limit
    return { events: structuredClone(events), cursor: hasMore && events.length ? structuredClone(events[events.length - 1].cursor) : this.cursor(), hasMore, resetRequired: false }
  }
  /** The digest excludes transport epoch/requestId so the same intent survives reconnect. */
  committedResult(request: DaemonRequest): { found: false } | { found: true; data: unknown } {
    const existing = this.state.commands.find((item) => item.commandId === request.commandId)
    if (!existing) return { found: false }
    const digest = createHash('sha256').update(canonicalWorkflowJson({ method: request.method, workspace: request.workspace ?? null, payload: request.payload })).digest('hex')
    if (existing.digest !== digest) throw new DaemonError('E_CONFLICT', 'This command ID has already been admitted with a different payload.')
    if (existing.state === 'unknown') throw new DaemonError('E_UNKNOWN', 'The original native effect is still uncertain; reconcile its retained command.', 'unknown')
    return { found: true, data: structuredClone(existing.result) }
  }
  command<T>(request: DaemonRequest, change: (transaction: Transaction) => T): T {
    if (!request.commandId) throw new DaemonError('E_INVALID_ARG', 'Mutations require a stable commandId.')
    const digest = createHash('sha256').update(canonicalWorkflowJson({ method: request.method, workspace: request.workspace ?? null, payload: request.payload })).digest('hex')
    const existing = this.state.commands.find((item) => item.commandId === request.commandId)
    if (existing) {
      if (existing.digest !== digest) throw new DaemonError('E_CONFLICT', 'This commandId was already used with a different intent.')
      if (existing.state === 'unknown') throw new DaemonError('E_UNKNOWN', 'The original command still requires evidence-based reconciliation.', 'unknown')
      return structuredClone(existing.result) as T
    }
    if (this.state.commands.length >= DAEMON_LIMITS.commands) throw new DaemonError('E_BUSY', 'The durable command receipt limit is reached. Reconcile/export receipts before admission.')
    return this.transact((transaction) => {
      const result = change(transaction)
      const jobId = typeof result === 'object' && result !== null && 'id' in result && typeof result.id === 'string' && transaction.state.jobs.some((job) => job.id === result.id) ? result.id : null
      transaction.state.commands.push(receiptSchema.parse({ commandId: request.commandId, method: request.method, digest, state: 'committed', workspaceId: request.workspace?.workspaceId ?? null, result, jobId, committedAt: Date.now() }))
      return result
    })
  }
  setPreferences(request: DaemonRequest, input: Omit<DaemonPreferences, 'revision'> & { revision: number }): DaemonPreferences {
    if (this.state.startupIntent) throw new DaemonError('E_UNKNOWN', 'A startup registration command needs reconciliation before preferences can change.', 'unknown')
    return this.command(request, ({ state, emit }) => {
      if (state.preferences.revision !== input.revision) throw new DaemonError('E_CONFLICT', 'Daemon preferences changed. Reload before saving.')
      state.preferences = { ...input, revision: input.revision + 1 }
      emit({ kind: 'preferences.changed', workspaceId: null, entityId: 'preferences', revision: state.preferences.revision })
      return state.preferences
    })
  }
  /** Persist native-effect intent before registry writes. An interrupted intent is never reapplied automatically. */
  registerStartup(request: DaemonRequest, input: DaemonPreferences, registration: StartupRegistration, apply: () => void): DaemonPreferences {
    if (!request.commandId) throw new DaemonError('E_INVALID_ARG', 'Startup changes require a commandId.')
    const digest = createHash('sha256').update(canonicalWorkflowJson({ method: request.method, workspace: request.workspace ?? null, payload: request.payload })).digest('hex')
    const prior = this.state.commands.find((item) => item.commandId === request.commandId)
    if (prior) {
      if (prior.digest !== digest) throw new DaemonError('E_CONFLICT', 'This command ID describes a different startup change.')
      if (prior.state === 'committed') return daemonPreferencesSchema.parse(prior.result)
      throw new DaemonError('E_UNKNOWN', 'The original startup operation has an uncertain outcome. Verify the exact native registration before settlement.', 'unknown')
    }
    if (this.state.startupIntent || this.state.preferences.revision !== input.revision) throw new DaemonError('E_CONFLICT', 'Preferences changed or another startup registration needs reconciliation.')
    if (this.state.commands.length >= DAEMON_LIMITS.commands) throw new DaemonError('E_BUSY', 'Command receipt retention is full.')
    const commandId = request.commandId
    this.transact(({ state }) => {
      state.startupIntent = { commandId, preferences: input, registration: startupRegistrationSchema.parse(registration) }
      state.commands.push({ commandId, method: request.method, state: 'unknown', jobId: null, committedAt: Date.now(), digest, workspaceId: request.workspace?.workspaceId ?? null, result: null })
    })
    try { apply(); return this.reconcileStartup(commandId, () => true) }
    catch { throw new DaemonError('E_UNKNOWN', 'Native startup registration or receipt publication did not confirm its outcome. Reconcile the retained command; do not retry registration blindly.', 'unknown') }
  }
  /** Native-only: caller verifies the exact original entry, without another registration write. */
  reconcileStartup(commandId: string, verify: (input: DaemonPreferences, registration: StartupRegistration) => boolean): DaemonPreferences {
    const intent = this.state.startupIntent
    if (!intent || intent.commandId !== commandId || !verify(intent.preferences, intent.registration)) throw new DaemonError('E_CONFLICT', 'The original startup intent is absent or not confirmed by native evidence.')
    return this.transact(({ state, emit }) => {
      const receipt = state.commands.find((item) => item.commandId === commandId)
      if (!receipt || receipt.state !== 'unknown') throw new DaemonError('E_CONFLICT', 'The retained startup command changed.')
      state.preferences = { ...intent.preferences, revision: intent.preferences.revision + 1 }
      receipt.state = 'committed'; receipt.result = state.preferences; receipt.committedAt = Date.now(); state.startupIntent = null
      emit({ kind: 'preferences.changed', workspaceId: null, entityId: 'preferences', revision: state.preferences.revision })
      return state.preferences
    })
  }
  grantWorkspace(request: DaemonRequest, input: { workspaceId: string; root: string; expectedRevision: number }): WorkspaceGrant {
    return this.command(request, ({ state, emit }) => {
      const current = state.grants.find((grant) => grant.workspaceId === input.workspaceId)
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new DaemonError('E_CONFLICT', 'Workspace grant changed. Reload the original workspace.')
      if (!current && state.grants.length >= 100) throw new DaemonError('E_BUSY', 'Workspace grant limit reached.')
      if (current && state.jobs.some((job) => job.workspaceId === current.workspaceId && activeJob(job))) throw new DaemonError('E_CONFLICT', 'Reconcile workspace jobs before replacing their grant.')
      const grant = { workspaceId: input.workspaceId, root: input.root, revision: input.expectedRevision + 1, grantId: randomUUID() }
      state.grants = [...state.grants.filter((item) => item.workspaceId !== input.workspaceId), grant]
      emit({ kind: 'workspace.changed', workspaceId: grant.workspaceId, entityId: grant.grantId, revision: grant.revision })
      return grant
    })
  }
  revoke(request: DaemonRequest, grant: WorkspaceGrant): null {
    return this.command(request, ({ state, emit }) => {
      if (state.jobs.some((job) => job.workspaceId === grant.workspaceId && activeJob(job))) throw new DaemonError('E_CONFLICT', 'Workspace jobs retain their grant until stopped or reconciled.')
      state.grants = state.grants.filter((item) => item.grantId !== grant.grantId)
      emit({ kind: 'workspace.changed', workspaceId: grant.workspaceId, entityId: grant.grantId, revision: grant.revision + 1 })
      return null
    })
  }
  enqueue(request: DaemonRequest, input: Pick<IntegrationJob, 'source' | 'input'>, grant: WorkspaceGrant): IntegrationJob {
    return this.command(request, ({ state, emit }) => {
      if (state.jobs.some((job) => job.state === 'unknown' && (job.workspaceId === grant.workspaceId || job.source.connectionId === input.source.connectionId && job.source.instanceId === input.source.instanceId))) throw new DaemonError('E_CONFLICT', 'Uncertain work retains this workspace/connection. Reconcile its original job before admitting another operation.')
      if (state.jobs.length >= DAEMON_LIMITS.jobs || state.jobs.filter((job) => job.workspaceId === grant.workspaceId && activeJob(job)).length >= DAEMON_LIMITS.jobsPerWorkspace) throw new DaemonError('E_BUSY', 'The durable integration work limit is reached.')
      const now = Date.now()
      const job = integrationJobSchema.parse({ ...input, id: randomUUID(), commandId: request.commandId, workspaceId: grant.workspaceId, state: 'queued', revision: 1, ownerEpoch: this.epoch, createdAt: now, updatedAt: now, cursor: null, counts: { processed: 0, failed: 0, total: null }, evidenceRef: null })
      state.jobs.push(job)
      state.admissions.push({ jobId: job.id, grant, owner: this.owner })
      emit({ kind: 'job.changed', workspaceId: job.workspaceId, entityId: job.id, revision: job.revision })
      return job
    })
  }
  cancel(request: DaemonRequest, id: string, revision: number, grant: WorkspaceGrant): IntegrationJob {
    return this.command(request, ({ state, emit }) => {
      const job = state.jobs.find((item) => item.id === id && item.workspaceId === grant.workspaceId)
      if (!job || job.revision !== revision) throw new DaemonError('E_CONFLICT', 'The original job revision is no longer current.')
      const next = ['queued', 'paused'].includes(job.state) ? 'cancelled' : 'cancel-requested'
      if (!transitions[job.state].includes(next)) throw new DaemonError('E_CONFLICT', 'This job requires evidence-based reconciliation before cancellation.')
      job.state = next; job.revision++; job.updatedAt = Date.now()
      emit({ kind: 'job.changed', workspaceId: job.workspaceId, entityId: job.id, revision: job.revision })
      return job
    })
  }
  transition(id: string, expectedRevision: number, ownerEpoch: string, next: IntegrationJobState, evidenceRef: string | null, update?: Pick<IntegrationJob, 'cursor' | 'counts'>): IntegrationJob {
    return this.transact(({ state, emit }) => {
      const job = state.jobs.find((item) => item.id === id)
      if (!job || job.revision !== expectedRevision || job.ownerEpoch !== ownerEpoch) throw new DaemonError('E_CONFLICT', 'Job owner/revision changed; original dispatch is fenced.')
      if (!transitions[job.state].includes(next)) throw new DaemonError('E_CONFLICT', 'Invalid integration job state transition.')
      if (['completed', 'cancelled', 'partially-failed', 'rollback-blocked'].includes(next) && !evidenceRef) throw new DaemonError('E_DENIED', 'Job settlement requires retained execution evidence.')
      if (update) this.validateProgress(job, update)
      if (next === 'dispatched') {
        const admission = state.admissions.find((item) => item.jobId === job.id)
        if (!admission || JSON.stringify(state.grants.find((grant) => grant.workspaceId === job.workspaceId)) !== JSON.stringify(admission.grant)) throw new DaemonError('E_CONFLICT', 'The original job admission is missing or stale.')
        if (state.jobs.some((other) => other.id !== job.id && other.state === 'unknown' && (other.workspaceId === job.workspaceId || other.source.connectionId === job.source.connectionId && other.source.instanceId === job.source.instanceId))) throw new DaemonError('E_CONFLICT', 'Uncertain work fences this workspace/connection before dispatch.')
        job.ownerEpoch = this.epoch; admission.owner = this.owner
      }
      job.state = next; job.revision++; job.updatedAt = Date.now(); job.evidenceRef = evidenceRef ?? job.evidenceRef
      if (update) { job.cursor = update.cursor; job.counts = update.counts }
      emit({ kind: 'job.changed', workspaceId: job.workspaceId, entityId: job.id, revision: job.revision })
      return job
    })
  }
  private validateProgress(job: IntegrationJob, update: Pick<IntegrationJob, 'cursor' | 'counts'>): void {
    integrationJobCountsSchema.parse(update.counts)
    if (update.counts.processed < job.counts.processed || update.counts.failed < job.counts.failed || job.counts.total !== null && update.counts.total !== job.counts.total) throw new DaemonError('E_CONFLICT', 'Job progress cannot regress or change an already known total.')
    if (job.cursor !== null && update.cursor === null) throw new DaemonError('E_CONFLICT', 'A retained checkpoint cursor cannot be erased.')
  }
  /** Same-state progress is separate from lifecycle transitions; retained dispatch identity is mandatory. */
  checkpoint(id: string, expectedRevision: number, ownerEpoch: string, update: Pick<IntegrationJob, 'cursor' | 'counts'>, evidenceRef: string): IntegrationJob {
    return this.transact(({ state, emit }) => {
      const job = state.jobs.find((item) => item.id === id)
      if (!job || job.revision !== expectedRevision || job.ownerEpoch !== ownerEpoch || !['dispatched', 'running', 'cancel-requested'].includes(job.state)) throw new DaemonError('E_CONFLICT', 'Checkpoint owner, revision or job state is stale.')
      if (!evidenceRef || evidenceRef.length > 256) throw new DaemonError('E_DENIED', 'A checkpoint requires a bounded retained evidence reference.')
      this.validateProgress(job, update)
      job.cursor = update.cursor; job.counts = update.counts; job.evidenceRef = evidenceRef; job.revision++; job.updatedAt = Date.now()
      emit({ kind: 'job.changed', workspaceId: job.workspaceId, entityId: job.id, revision: job.revision })
      return job
    })
  }
  stopping(request: DaemonRequest): { state: 'stopping' } {
    return this.command(request, ({ state, emit }) => {
      if (state.jobs.some((job) => ['queued', 'dispatched', 'running', 'cancel-requested'].includes(job.state))) throw new DaemonError('E_CONFLICT', 'Locally active integration work must stop before daemon exit. Retained unknown remote outcomes remain for later reconciliation.')
      emit({ kind: 'daemon.stopping', workspaceId: null, entityId: this.epoch, revision: 0 })
      return { state: 'stopping' as const }
    })
  }
}
