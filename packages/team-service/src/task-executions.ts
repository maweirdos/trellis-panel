import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { canReadCruxSpace } from '../../../src/shared/crux-domain/commands'
import { cruxSnapshotSchema } from '../../../src/shared/crux-schema'
import type { CruxSnapshot, CruxTask, CruxTransitionTaskInput } from '../../../src/shared/crux'
import { taskInputCanonical, type TaskInputRead } from '../../../src/shared/team-task-inputs'
import { teamExecutionCommandSchema, teamExecutionRecordSchema, teamExecutionReceiptSchema, teamExecutionViewSchema,
  teamTaskIdentity, teamTaskRefSchema, type TeamTaskRef, type TeamExecutionCommand, type TeamExecutionRecord,
  type TeamExecutionReceipt, type TeamExecutionView, type teamExecutionDependencySchema } from '../../../src/shared/team-task-execution'
import type { CruxWorkspaceHost } from './crux-workspace'
import type { StoreActor, StorePrincipal } from './store-types'
import { TeamServiceError } from './errors'
import { taskProgressFence } from './task-progress'
import { TeamExecutionArtifacts } from './task-execution-artifacts'
import type { executionCreationRefSchema } from '../../../src/shared/team-execution-artifacts'
import { executionInputSchema } from '../../../src/shared/team-execution-input'

type Host = Pick<CruxWorkspaceHost, 'identity' | 'get' | 'all' | 'run' | 'authenticate' | 'project' | 'mutation'> & {
  inputs(principal: StorePrincipal, task: TeamTaskRef): TaskInputRead
  dependency(principal: StorePrincipal, task: TeamTaskRef, ref: Extract<z.infer<typeof teamExecutionDependencySchema>, { kind: 'confirmed-document' }>): { text: string; title: string; withdrawn: boolean }
  creation(principal: StorePrincipal, task: TeamTaskRef, ref: z.infer<typeof executionCreationRefSchema>): { text: string; title: string }
  body(digest: string): Buffer
  persistBody(bytes: Buffer, digest: string): void
  recipient(userId: string, projectId: string): StorePrincipal
  fixedInput(principal: StorePrincipal, execution: TeamExecutionRecord): void
  transition(principal: StorePrincipal, projectId: string, revision: number, input: CruxTransitionTaskInput, commandId: string): void
  event(actorId: string, task: TeamTaskRef, executionId: string, commandId: string | null, kind: string): void
}
const hash = (s: string): string => createHash('sha256').update(s).digest('hex')
const owner = (a: StoreActor): string => hash(`execution-v2:${a.kind}:${a.credentialHash}`)
function fail(code: string, message: string, status = 409): never { throw new TeamServiceError(code, message, status) }
const next = (n: number): number => {
  if (!Number.isSafeInteger(n) || n < 0 || n >= Number.MAX_SAFE_INTEGER) fail('CAPACITY_EXCEEDED', 'Execution generation exhausted', 503)
  return n + 1
}
function stored<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(typeof value === 'string' ? JSON.parse(value) : value) }
  catch { return fail('CORRUPT_STORE', 'Stored execution record failed validation', 503) }
}
const handler = (t: CruxTask): string | undefined => t.workflow ? t.workflow.handlerId : t.assigneeIds.length === 1 ? t.assigneeIds[0] : undefined
type Context = { principal: StorePrincipal; task: CruxTask; ref: TeamTaskRef; fence: string; writable: boolean }
const actorSchema = z.object({ kind: z.enum(['session', 'device']), credentialHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const boundaryScope = { spaceId: z.string(), taskCreatedAt: z.string() }
const businessBoundarySchema = z.discriminatedUnion('kind', [
  z.object({ ...boundaryScope, kind: z.literal('formal'), stage: z.string(), handlerId: z.string().nullable(),
    historyLength: z.number().int().nonnegative().safe(), historyHeadId: z.string().nullable() }).strict(),
  z.object({ ...boundaryScope, kind: z.literal('legacy'), statusId: z.string(), statusCategory: z.string().nullable(),
    assigneeIds: z.array(z.string()), completedAt: z.string().nullable(), triagePending: z.boolean() }).strict()
])
const storedBoundarySchema = z.object({ original: businessBoundarySchema.nullable(), successor: businessBoundarySchema.nullable() }).strict()
function businessBoundary(task: CruxTask, statusCategory: string | null): z.infer<typeof businessBoundarySchema> {
  const scope = { spaceId: task.spaceId, taskCreatedAt: task.createdAt }
  return task.workflow ? { ...scope, kind: 'formal', stage: task.workflow.stage, handlerId: task.workflow.handlerId ?? null,
    historyLength: task.workflow.history.length, historyHeadId: task.workflow.history.at(-1)?.id ?? null }
    : { ...scope, kind: 'legacy', statusId: task.statusId, statusCategory, assigneeIds: [...task.assigneeIds].sort(), completedAt: task.completedAt ?? null, triagePending: task.triagePending === true }
}

export class TeamTaskExecutions {
  private readonly artifacts: TeamExecutionArtifacts
  constructor(private readonly host: Host) {
    this.artifacts = new TeamExecutionArtifacts({ ...host, document: host.dependency,
      history: (principal, task, id) => this.historyForPrincipal(principal, task, id) })
  }

  resolveOutput(principal: StorePrincipal, task: TeamTaskRef, ref: z.infer<typeof teamExecutionDependencySchema>): ReturnType<TeamExecutionArtifacts['resolve']> {
    this.principalContext(principal, task)
    return this.artifacts.resolve(principal, task, ref)
  }

  readArtifact(actor: StoreActor, task: TeamTaskRef, executionId: string, versionId: string): { contractVersion: 2; artifact: NonNullable<TeamExecutionRecord['artifacts']>[number]; text: string } {
    const record = this.history(actor, task, executionId), artifact = record.artifacts?.find(item => item.versionId === versionId)
    if (!artifact || artifact.taskIdentity !== teamTaskIdentity(task) || artifact.executionId !== executionId) fail('EXECUTION_UNAVAILABLE', 'Original artifact version is unavailable', 404)
    const bytes = this.host.body(artifact.bodyDigest), text = bytes.toString('utf8')
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.bodyDigest || bytes.length !== artifact.byteLength || !Buffer.from(text, 'utf8').equals(bytes)) fail('CORRUPT_STORE', 'Original artifact bytes failed verification', 503)
    return { contractVersion: 2, artifact, text }
  }

  private context(actor: StoreActor, raw: TeamTaskRef, writing = false): Context {
    return this.principalContext(this.host.authenticate(actor), raw, writing)
  }
  private principalContext(principal: StorePrincipal, raw: TeamTaskRef, writing = false): Context {
    const ref = teamTaskRefSchema.parse(raw)
    if (ref.instanceId !== this.host.identity().instanceId) fail('EXECUTION_SCOPE_CONFLICT', 'Original service instance changed')
    this.host.project(principal, ref.projectId)
    const row = this.host.get("SELECT t.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.tasks') t WHERE w.projectId=? AND json_extract(t.value,'$.id')=?", ref.projectId, ref.taskId)
    if (!row) fail('EXECUTION_UNAVAILABLE', 'Original task is unavailable', 404)
    const task = stored(cruxSnapshotSchema.shape.tasks.element, row.body)
    if (task.spaceId !== ref.spaceId || task.createdAt !== ref.taskCreatedAt) fail('EXECUTION_SCOPE_CONFLICT', 'Task incarnation changed')
    const sr = this.host.get("SELECT s.value AS body FROM crux_workspaces w,json_each(w.snapshotJson,'$.spaces') s WHERE w.projectId=? AND json_extract(s.value,'$.id')=?", ref.projectId, ref.spaceId)
    if (!sr) fail('EXECUTION_UNAVAILABLE', 'Original space is unavailable', 404)
    const space = stored(cruxSnapshotSchema.shape.spaces.element, sr.body)
    if (!canReadCruxSpace(space, principal.person.userId)) fail('EXECUTION_FORBIDDEN', 'Current space access is required', 403)
    const status = this.host.get("SELECT json_extract(s.value,'$.category') AS category FROM crux_workspaces w,json_each(w.snapshotJson,'$.taskStatuses') s WHERE w.projectId=? AND json_extract(s.value,'$.id')=? AND json_extract(s.value,'$.spaceId')=?", ref.projectId, task.statusId, ref.spaceId)
    const resource = taskProgressFence(this.host, ref.projectId, task)
    const writable = !space.archived && space.memberIds.includes(principal.person.userId) && handler(task) === principal.person.userId
      && !!status && !['done', 'cancelled'].includes(String(status.category)) && !task.completedAt && task.workflow?.stage !== 'done' && !task.triagePending && resource.resourceAvailable
    if (writing && !writable) fail('EXECUTION_FORBIDDEN', 'Only the current handler of an open task can write', 403)
    const inputs = this.host.get('SELECT revision,currentBundleId FROM task_input_heads WHERE projectId=? AND taskId=? AND spaceId=? AND taskCreatedAt=?', ref.projectId, ref.taskId, ref.spaceId, ref.taskCreatedAt)
    return { principal, task, ref, fence: hash(taskInputCanonical([ref, resource.fence, space.createdAt, inputs?.revision ?? 0, inputs?.currentBundleId ?? null,
      inputs?.currentBundleId ? null : [task.title, task.description ?? '']])), writable }
  }

  private head(ref: TeamTaskRef): { generation: number; activeExecutionId: string | null } {
    const row = this.host.get('SELECT generation,activeExecutionId FROM team_task_execution_heads WHERE projectId=? AND taskId=?', ref.projectId, ref.taskId)
    return row ? stored(z.object({ generation: z.number().int().nonnegative().safe(), activeExecutionId: z.string().uuid().nullable() }).strict(), row) : { generation: 0, activeExecutionId: null }
  }
  private row(id: string): { record: TeamExecutionRecord; actor: StoreActor; ownerKey: string; fence: string } {
    const row = this.host.get('SELECT recordJson,actorJson,ownerKey,fence FROM team_task_executions WHERE executionId=?', id)
    if (!row) fail('EXECUTION_UNAVAILABLE', 'Execution is unavailable', 404)
    if (typeof row.ownerKey !== 'string' || typeof row.fence !== 'string') fail('CORRUPT_STORE', 'Invalid execution owner', 503)
    return { record: stored(teamExecutionRecordSchema, row.recordJson), actor: stored(actorSchema, row.actorJson), ownerKey: row.ownerKey, fence: row.fence }
  }
  private valid(row: ReturnType<TeamTaskExecutions['row']>): boolean {
    try {
      const ctx = this.context(row.actor, row.record.task, true)
      if (row.record.epoch !== this.host.identity().epoch || ctx.fence !== row.fence) return false
      this.checkInputs(ctx, row.record.inputBundle)
      return true
    } catch (error) {
      if (error instanceof TeamServiceError && !['CORRUPT_STORE', 'STORE_UNAVAILABLE'].includes(error.code)) return false
      throw error
    }
  }
  private save(record: TeamExecutionRecord): void {
    const value = teamExecutionRecordSchema.parse(record)
    this.host.run('UPDATE team_task_executions SET authority=?,recordJson=? WHERE executionId=?', value.authority, JSON.stringify(value), value.executionId)
  }
  private producerAttempts(record: TeamExecutionRecord): NonNullable<TeamExecutionRecord['nodeAttempts']> {
    const visits = record.nodeAttempts ? record.nodeAttempts.map(item => ({ ...item })) : []
    if (!record.nodeAttempts) {
      for (const item of [record, ...(record.artifacts ?? []), ...(record.deliveries ?? []), ...(record.checkpoints ?? [])]) {
        const known = visits.find(visit => visit.nodeId === item.nodeId)
        if (known) known.maxAttempt = Math.max(known.maxAttempt, item.attempt)
        else visits.push({ nodeId: item.nodeId, maxAttempt: item.attempt })
      }
    }
    if (visits.length > 64) fail('CAPACITY_EXCEEDED', 'Visited output node capacity reached; original execution retained')
    if (visits.find(item => item.nodeId === record.nodeId)?.maxAttempt !== record.attempt) fail('EXECUTION_ATTEMPT_CONFLICT', 'Retained producer attempt is ambiguous; preserve the original execution')
    return visits
  }
  private revoke(id: string, reason: string): void {
    const { record } = this.row(id)
    if (record.authority !== 'active') return
    this.save({ ...record, authority: 'revoked', revocationReason: reason, updatedAt: Date.now() })
    const head = this.head(record.task)
    if (head.activeExecutionId === id) this.host.run('UPDATE team_task_execution_heads SET generation=?,activeExecutionId=NULL WHERE projectId=? AND taskId=?', next(head.generation), record.task.projectId, record.task.taskId)
    this.host.event(record.actorId, record.task, id, null, 'revoked')
    // Native state is deliberately preserved. Authority revocation is not shutdown.
  }
  /** Called in the owning account/device/resource transaction, before grants can be restored. */
  reconcileAuthorities(): void {
    for (const row of this.host.all("SELECT executionId FROM team_task_executions WHERE authority='active'")) {
      const execution = this.row(String(row.executionId))
      if (!this.valid(execution)) this.revoke(execution.record.executionId, 'authority-changed')
    }
  }
  invalidateResource(projectId: string, taskId: string): void {
    const head = this.host.get('SELECT activeExecutionId FROM team_task_execution_heads WHERE projectId=? AND taskId=?', projectId, taskId)
    if (typeof head?.activeExecutionId === 'string') this.revoke(head.activeExecutionId, 'resource-changed')
  }
  reconcileWorkspace(projectId: string, before: CruxSnapshot, after: CruxSnapshot): void {
    // This hook runs inside the business writer transaction. Input/resource/ACL
    // invalidation alone never records that an execution's phase was handed off.
    const nextTasks = new Map(after.tasks.map(task => [task.id, task]))
    const oldStatuses = new Map(before.taskStatuses.map(status => [status.id, status.category]))
    const nextStatuses = new Map(after.taskStatuses.map(status => [status.id, status.category]))
    for (const task of before.tasks) {
      const successor = nextTasks.get(task.id)
      if (!successor || successor.createdAt !== task.createdAt || successor.spaceId !== task.spaceId) continue
      const previousBoundary = businessBoundary(task, oldStatuses.get(task.statusId) ?? null)
      const nextBoundary = businessBoundary(successor, nextStatuses.get(successor.statusId) ?? null)
      if (taskInputCanonical(previousBoundary) === taskInputCanonical(nextBoundary)) continue
      this.host.run("UPDATE team_task_executions SET businessBoundaryJson=json_set(COALESCE(businessBoundaryJson,'{\"original\":null,\"successor\":null}'),'$.successor',json(?)) WHERE projectId=? AND taskId=? AND json_extract(recordJson,'$.task.spaceId')=? AND json_extract(recordJson,'$.task.taskCreatedAt')=? AND (businessBoundaryJson IS NULL OR json_extract(businessBoundaryJson,'$.successor') IS NULL)", JSON.stringify(nextBoundary), projectId, task.id, task.spaceId, task.createdAt)
    }
    for (const row of this.host.all('SELECT activeExecutionId,taskId FROM team_task_execution_heads WHERE projectId=? AND activeExecutionId IS NOT NULL', projectId)) {
      const old = before.tasks.find(t => t.id === row.taskId), task = after.tasks.find(t => t.id === row.taskId)
      const oldSpace = before.spaces.find(s => s.id === old?.spaceId), space = after.spaces.find(s => s.id === task?.spaceId)
      if (!old || !task || old.createdAt !== task.createdAt || taskProgressFence(this.host, projectId, old).fence !== taskProgressFence(this.host, projectId, task).fence
        || !space || space.archived || oldSpace?.createdAt !== space.createdAt || !space.memberIds.includes(handler(task) ?? '')) this.revoke(String(row.activeExecutionId), 'task-transition')
    }
  }
  assertNoWriter(projectId: string, taskId: string): void {
    this.reconcileAuthorities()
    if (this.host.get("SELECT executionId FROM team_task_executions WHERE projectId=? AND taskId=? AND authority='active'", projectId, taskId)) fail('EXECUTION_WRITER_CONFLICT', 'A v2 execution already owns this task')
  }
  read(actor: StoreActor, ref: TeamTaskRef): TeamExecutionView {
    const ctx = this.context(actor, ref), head = this.head(ctx.ref)
    const row = head.activeExecutionId ? this.row(head.activeExecutionId) : null
    const active = row && this.valid(row) ? row.record : null
    const { epoch, authorizationRevision } = this.host.identity()
    return teamExecutionViewSchema.parse({ contractVersion: 2, task: ctx.ref, epoch, authorizationRevision, generation: row && !active ? next(head.generation) : head.generation, active, serverTime: Date.now() })
  }
  history(actor: StoreActor, ref: TeamTaskRef, id: string): TeamExecutionRecord {
    return this.historyForPrincipal(this.host.authenticate(actor), ref, id)
  }
  /** Service-internal ACL projection for an actual active recipient; never a wire actor override. */
  historyForPrincipal(principal: StorePrincipal, ref: TeamTaskRef, id: string): TeamExecutionRecord {
    this.principalContext(principal, ref)
    const row = this.row(id)
    if (teamTaskIdentity(row.record.task) !== teamTaskIdentity(ref)) fail('EXECUTION_SCOPE_CONFLICT', 'Execution belongs to another task')
    return row.record.authority === 'active' && !this.valid(row) ? { ...row.record, authority: 'revoked', revocationReason: 'authority-changed' } : row.record
  }
  /** Shared input capture/use has exactly the admitted writer's original owner. */
  assertInputOwner(actor: StoreActor, task: TeamTaskRef, id: string, generation: number): TeamExecutionRecord {
    this.context(actor, task, true)
    const row = this.row(id), head = this.head(task)
    if (teamTaskIdentity(row.record.task) !== teamTaskIdentity(task) || row.ownerKey !== owner(actor)) fail('EXECUTION_FORBIDDEN', 'Original execution owner is required', 403)
    if (row.record.authority !== 'active' || row.record.finalization || row.record.generation !== generation || head.generation !== generation || head.activeExecutionId !== id || !this.valid(row)) fail('EXECUTION_GENERATION_CONFLICT', 'Original execution is no longer usable')
    return row.record
  }
  private checkInputs(ctx: Context, inputBundle: TeamExecutionRecord['inputBundle']): void {
    const inputs = this.host.inputs(ctx.principal, ctx.ref)
    const current = inputs.current ? { bundleId: inputs.current.bundleId, revision: inputs.current.revision, digest: inputs.current.digest } : null
    if (inputs.admission.status !== 'ready' || taskInputCanonical(current) !== taskInputCanonical(inputBundle)) fail('EXECUTION_INPUT_CONFLICT', 'Original adopted inputs are unavailable or changed')
  }
  private receiptContext(actor: StoreActor, command: TeamExecutionCommand, receipt: TeamExecutionReceipt): void {
    const ctx = this.context(actor, command.task)
    const row = this.row(receipt.executionId)
    if (receipt.epoch !== this.host.identity().epoch || command.expectedEpoch !== receipt.epoch) fail('WORKSPACE_EPOCH_CHANGED', 'Original service epoch changed')
    if (receipt.actorId !== ctx.principal.person.userId || receipt.deviceId !== ctx.principal.deviceId || row.ownerKey !== owner(actor)) fail('EXECUTION_FORBIDDEN', 'Original account and reporting session are required', 403)
    if (receipt.requestDigest !== hash(taskInputCanonical(command)) || teamTaskIdentity(receipt.task) !== teamTaskIdentity(ctx.ref)) fail('COMMAND_CONFLICT', 'Original command payload changed')
    // A historical receipt confirms only the original effect. Handoff and a
    // successor generation cannot hide it or restore the former writer.
    if (row.record.generation !== receipt.generation || teamTaskIdentity(row.record.task) !== teamTaskIdentity(receipt.task)) fail('CORRUPT_STORE', 'Execution receipt identity changed', 503)
  }
  reconcile(actor: StoreActor, raw: unknown): TeamExecutionReceipt | null {
    const command = teamExecutionCommandSchema.parse(raw)
    this.context(actor, command.task)
    if (command.expectedEpoch !== this.host.identity().epoch) fail('WORKSPACE_EPOCH_CHANGED', 'Original service epoch changed')
    const principal = this.host.authenticate(actor)
    this.checkPrincipal(principal, command)
    const row = this.host.get('SELECT kind,resultJson FROM commands WHERE userId=? AND commandId=?', principal.person.userId, command.commandId)
    if (!row) {
      const ctx = this.context(actor, command.task, true), head = this.head(ctx.ref)
      if (head.generation !== command.expectedGeneration || head.activeExecutionId !== command.expectedExecutionId) fail('EXECUTION_GENERATION_CONFLICT', 'Original execution generation changed')
      return null // A missing receipt does not prove a request still in flight cannot commit.
    }
    if (row.kind !== 'taskExecutionCommand') fail('COMMAND_CONFLICT', 'Command UUID belongs to another operation')
    const receipt = stored(teamExecutionReceiptSchema, row.resultJson)
    this.receiptContext(actor, command, receipt)
    return receipt
  }
  command(actor: StoreActor, raw: unknown): { status: 'committed' | 'duplicate'; commandId: string; result: TeamExecutionReceipt } {
    const command = teamExecutionCommandSchema.parse(raw)
    return this.host.mutation(actor, command.commandId, 'taskExecutionCommand', command,
      principal => {
        this.context(actor, command.task)
        this.checkPrincipal(principal, command)
        if (command.expectedEpoch !== this.host.identity().epoch) fail('WORKSPACE_EPOCH_CHANGED', 'Original service epoch changed')
      }, principal => {
        this.reconcileAuthorities()
        const ctx = this.context(actor, command.task, true), head = this.head(ctx.ref)
        if (head.generation !== command.expectedGeneration || head.activeExecutionId !== command.expectedExecutionId) fail('EXECUTION_GENERATION_CONFLICT', 'Reload original execution generation')
        let record: TeamExecutionRecord
        let receiptVersion: { versionId: string; digest: string } | undefined
        let disposition: 'draft' | 'confirmed' | 'conflict' | undefined
        if (command.kind === 'claim') {
          if (command.attempt !== 1) fail('EXECUTION_ATTEMPT_CONFLICT', 'A newly claimed node starts at its first attempt')
          if (head.activeExecutionId) fail('EXECUTION_WRITER_CONFLICT', 'Another execution owns this task')
          const progress = this.host.get('SELECT epoch,fence,bindingJson FROM crux_task_progress WHERE projectId=? AND taskId=?', ctx.ref.projectId, ctx.ref.taskId)
          if (progress?.bindingJson && progress.epoch === command.expectedEpoch && progress.fence === taskProgressFence(this.host, ctx.ref.projectId, ctx.task).fence) fail('EXECUTION_WRITER_CONFLICT', 'A v1 reporting binding already owns this task')
          this.checkInputs(ctx, command.inputBundle)
          if (command.predecessorExecutionId) {
            const previous = this.history(actor, ctx.ref, command.predecessorExecutionId)
            if (previous.authority === 'active') fail('EXECUTION_WRITER_CONFLICT', 'Predecessor still owns this task')
          }
          record = { contractVersion: 2, executionId: randomUUID(), task: ctx.ref, epoch: command.expectedEpoch, generation: next(head.generation),
            actorId: principal.person.userId, deviceId: principal.deviceId, ownership: command.ownership, workflow: command.workflow, executor: command.executor,
            inputBundle: command.inputBundle, predecessorExecutionId: command.predecessorExecutionId, source: command.source, nodeId: command.nodeId, attempt: command.attempt,
            authority: 'active', revocationReason: null, nativeState: 'unknown', nativeVerification: 'owner-reported', progress: null, finalization: null, createdAt: Date.now(), updatedAt: Date.now() }
          record.nodeAttempts = [{ nodeId: command.nodeId, maxAttempt: command.attempt }]
          const status = this.host.get("SELECT json_extract(s.value,'$.category') AS category FROM crux_workspaces w,json_each(w.snapshotJson,'$.taskStatuses') s WHERE w.projectId=? AND json_extract(s.value,'$.id')=? AND json_extract(s.value,'$.spaceId')=?", ctx.ref.projectId, ctx.task.statusId, ctx.task.spaceId)
          const boundary = { original: businessBoundary(ctx.task, typeof status?.category === 'string' ? status.category : null), successor: null }
          this.host.run('INSERT INTO team_task_executions(executionId,projectId,taskId,authority,ownerKey,actorJson,fence,recordJson,businessBoundaryJson) VALUES(?,?,?,?,?,?,?,?,?)', record.executionId, ctx.ref.projectId, ctx.ref.taskId, 'active', owner(actor), JSON.stringify(actor), ctx.fence, JSON.stringify(record), JSON.stringify(boundary))
          this.host.run('INSERT INTO team_task_execution_heads(projectId,taskId,generation,activeExecutionId) VALUES(?,?,?,?) ON CONFLICT(projectId,taskId) DO UPDATE SET generation=excluded.generation,activeExecutionId=excluded.activeExecutionId', ctx.ref.projectId, ctx.ref.taskId, record.generation, record.executionId)
        } else {
          if (!head.activeExecutionId) fail('EXECUTION_GENERATION_CONFLICT', 'Original writer is no longer active')
          const row = this.row(head.activeExecutionId)
          record = row.record
          if (row.ownerKey !== owner(actor) || record.generation !== command.expectedGeneration || !this.valid(row)) fail('EXECUTION_GENERATION_CONFLICT', 'Original writer is no longer authorized')
          if ((command.kind === 'save-artifact' || command.kind === 'seal-delivery' || command.kind === 'checkpoint')
            && (command.expectedNodeId !== record.nodeId || command.expectedAttempt !== record.attempt)) fail('EXECUTION_PRODUCER_CONFLICT', 'Original output-producing node or attempt changed')
          if (command.kind === 'save-artifact' || command.kind === 'seal-delivery' || command.kind === 'checkpoint') record = { ...record, nodeAttempts: this.producerAttempts(record) }
          if (command.kind !== 'release') this.checkInputs(ctx, record.inputBundle)
          if (record.finalization && ['save-artifact', 'seal-delivery', 'checkpoint'].includes(command.kind)) fail('EXECUTION_FINALIZATION_CONFLICT', 'Finalized execution artifacts are immutable')
          if (command.kind === 'report') {
            if (record.finalization || command.seq <= (record.progress?.seq ?? 0)) fail('EXECUTION_SEQUENCE_CONFLICT', 'Finalized or older progress cannot replace confirmed progress')
            const visits = this.producerAttempts(record), visited = visits.find(item => item.nodeId === command.nodeId)
            const allowed = command.nodeId === record.nodeId
              ? command.attempt === record.attempt || command.attempt === record.attempt + 1
              : command.attempt === (visited?.maxAttempt ?? 0) + 1
            if (!allowed) fail('EXECUTION_ATTEMPT_CONFLICT', 'A retry or node re-entry requires its next unused attempt')
            const captured = this.host.get('SELECT recordJson FROM team_task_execution_inputs WHERE executionId=?', record.executionId)
            if (captured) {
              const input = stored(executionInputSchema, captured.recordJson)
              if (!input.definition.nodes.some(node => node.id === command.nodeId && node.kind !== 'gate')) fail('EXECUTION_NODE_CONFLICT', 'Reported output node is not in the original captured definition')
            }
            if (visited) visited.maxAttempt = command.attempt
            else visits.push({ nodeId: command.nodeId, maxAttempt: command.attempt })
            if (visits.length > 64) fail('CAPACITY_EXCEEDED', 'Visited output node capacity reached; original execution retained')
            record = { ...record, nodeId: command.nodeId, attempt: command.attempt, nativeState: command.nativeState,
              nodeAttempts: visits,
              progress: { seq: command.seq, state: command.state, step: command.step, blockingReason: command.blockingReason, updatedAt: Date.now() } }
          } else if (command.kind === 'finalize') {
            if (record.finalization) fail('EXECUTION_FINALIZATION_CONFLICT', 'Execution already has a finalization boundary')
            this.host.fixedInput(principal, record)
            for (const ref of command.finalization.outputs) if (this.resolveOutput(principal, ctx.ref, ref).withdrawn) fail('EXECUTION_DEPENDENCY_CONFLICT', 'Required output was withdrawn')
            record = { ...record, finalization: command.finalization, nativeState: command.finalization.outcome }
            this.artifacts.validateFinalization(principal, record, true)
          } else if (command.kind === 'save-artifact') {
            const saved = this.artifacts.save(record, command)
            record = saved.record; receiptVersion = { versionId: saved.selected.versionId, digest: saved.selected.bodyDigest }; disposition = saved.selected.disposition
          } else if (command.kind === 'seal-delivery') {
            record = this.artifacts.seal(principal, record, command)
            const selected = record.deliveries?.at(-1)
            if (selected) receiptVersion = { versionId: selected.versionId, digest: selected.digest }
          } else if (command.kind === 'checkpoint') {
            record = this.artifacts.checkpoint(principal, record, command)
            const selected = record.checkpoints?.at(-1)
            if (selected) receiptVersion = { versionId: selected.versionId, digest: selected.digest }
          } else if (command.kind === 'release') {
            record = { ...record, authority: 'released', nativeState: command.nativeState }
            this.host.run('UPDATE team_task_execution_heads SET generation=?,activeExecutionId=NULL WHERE projectId=? AND taskId=?', next(head.generation), ctx.ref.projectId, ctx.ref.taskId)
          } else {
            if (command.transition.taskId !== ctx.ref.taskId) fail('EXECUTION_SCOPE_CONFLICT', 'Transition cannot retarget the execution')
            this.validateTransition(principal, ctx.ref.projectId, ctx.task, command.transition)
            this.host.transition(principal, ctx.ref.projectId, command.expectedRevision, command.transition, command.commandId)
            record = this.row(record.executionId).record
          }
          record = { ...record, updatedAt: Date.now() }; this.save(record)
        }
        const receipt = teamExecutionReceiptSchema.parse({ contractVersion: 2, commandId: command.commandId, task: ctx.ref, epoch: command.expectedEpoch,
          kind: command.kind, requestDigest: hash(taskInputCanonical(command)), executionId: record.executionId, generation: record.generation,
          actorId: principal.person.userId, deviceId: principal.deviceId, committedAt: Date.now(),
          ...(receiptVersion ? { version: receiptVersion } : {}), ...(disposition ? { disposition } : {}) })
        this.host.event(principal.person.userId, ctx.ref, record.executionId, command.commandId, command.kind)
        return receipt
      }, (_principal, receipt) => this.receiptContext(actor, command, receipt))
  }
  private checkPrincipal(principal: StorePrincipal, command: TeamExecutionCommand): void {
    if (command.expectedActorId !== principal.person.userId || command.expectedDeviceId !== principal.deviceId) fail('EXECUTION_FORBIDDEN', 'Command belongs to another original account or device', 403)
  }
  /** All ordinary business transition paths call this hook in their existing transaction. */
  validateTransition(principal: StorePrincipal, projectId: string, task: CruxTask, transition: CruxTransitionTaskInput, successor?: CruxTask): void {
    this.validateHandoff(principal, projectId, task, successor, transition.action === 'decline' || transition.action === 'reassign' && principal.person.userId !== handler(task), successor ? handler(successor) : transition.assigneeId)
  }
  /** Secondary automation changes and legacy field edits cannot bypass explicit handoff gates. */
  validateWorkspaceChanges(principal: StorePrincipal | null, projectId: string, before: CruxSnapshot, after: CruxSnapshot, explicitTaskId?: string): void {
    const nextTasks = new Map(after.tasks.map(task => [task.id, task]))
    const oldStatuses = new Map(before.taskStatuses.map(status => [status.id, status.category]))
    const nextStatuses = new Map(after.taskStatuses.map(status => [status.id, status.category]))
    for (const task of before.tasks) {
      const successor = nextTasks.get(task.id)
      if (!successor || task.id === explicitTaskId || successor.spaceId !== task.spaceId || successor.createdAt !== task.createdAt
        || taskInputCanonical(businessBoundary(task, oldStatuses.get(task.statusId) ?? null)) === taskInputCanonical(businessBoundary(successor, nextStatuses.get(successor.statusId) ?? null))) continue
      const last = this.host.get("SELECT executionId,businessBoundaryJson FROM team_task_executions WHERE projectId=? AND taskId=? AND json_extract(recordJson,'$.task.taskCreatedAt')=? AND json_extract(recordJson,'$.task.spaceId')=? ORDER BY rowid DESC LIMIT 1", projectId, task.id, task.createdAt, task.spaceId)
      if (!last) continue
      if (last.businessBoundaryJson !== null && stored(storedBoundarySchema, last.businessBoundaryJson).successor) continue
      const effective = principal ?? this.host.authenticate(this.row(String(last.executionId)).actor)
      const forced = principal !== null && (nextStatuses.get(successor.statusId) === 'cancelled' || handler(task) !== handler(successor) && principal.person.userId !== handler(task))
      this.validateHandoff(effective, projectId, task, successor, forced, handler(successor))
    }
  }
  private validateHandoff(principal: StorePrincipal, projectId: string, task: CruxTask, successor: CruxTask | undefined, forced: boolean, recipientId?: string): void {
    const last = this.host.get("SELECT executionId,businessBoundaryJson FROM team_task_executions WHERE projectId=? AND taskId=? AND json_extract(recordJson,'$.task.spaceId')=? AND json_extract(recordJson,'$.task.taskCreatedAt')=? ORDER BY rowid DESC LIMIT 1", projectId, task.id, task.spaceId, task.createdAt)
    if (!last) return
    const row = this.row(String(last.executionId)), record = row.record
    if (record.task.taskCreatedAt !== task.createdAt || record.task.spaceId !== task.spaceId) return
    // Only a committed business change closes this gate. Revocation, changed
    // inputs and unknown v18 boundaries retain the ordinary output requirement.
    const boundary = last.businessBoundaryJson === null ? null : stored(storedBoundarySchema, last.businessBoundaryJson)
    if (boundary?.successor) return
    // A manager's forced reassignment and cancellation revoke writes before native shutdown is known.
    if (forced) return
    if (record.finalization?.outcome !== 'completed' || record.finalization.outputs.length === 0) fail('EXECUTION_FINALIZATION_REQUIRED', 'Ordinary handoff requires completed finalization and confirmed output versions')
    this.host.fixedInput(principal, record)
    this.artifacts.validateFinalization(principal, record)
    const ref = { ...record.task, projectId }
    for (const dependency of record.finalization.outputs) if (this.resolveOutput(principal, ref, dependency).withdrawn) fail('EXECUTION_DEPENDENCY_CONFLICT', 'Required output was withdrawn')
    if (recipientId && recipientId !== principal.person.userId) {
      const recipient = this.host.recipient(recipientId, projectId)
      this.principalContext(recipient, ref)
      this.host.fixedInput(recipient, record)
      for (const dependency of record.finalization.outputs) if (this.resolveOutput(recipient, ref, dependency).withdrawn) fail('EXECUTION_DEPENDENCY_CONFLICT', 'Handoff recipient cannot use an original output')
    }
  }
}
