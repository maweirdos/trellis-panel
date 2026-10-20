/** Clean-room ports for future adapters, with no runtime implementation in R0. */
import { z } from 'zod'
import {
  runRefSchema, stepRefSchema, workflowIdSchema, workflowScopeIdentity,
  workflowScopeSchema, workflowDigestSchema, workflowNodeIdentity
} from './identity'
import {
  executionEventSchema, runManifestSchema, workflowCommandSchema,
  workflowOperationSchema, workflowRunSchema
} from './contracts'
import { canonicalWorkflowJson, workflowPlanNodeSchema } from './definition'

export const workflowCursorSchema = z.object({ epoch: workflowIdSchema, sequence: z.number().int().nonnegative().safe() }).strict()
export const workflowOwnerSchema = z.object({ ownerId: workflowIdSchema, fencingToken: z.number().int().nonnegative().safe() }).strict()
export const driverDispatchSchema = z.object({
  operationId: workflowIdSchema,
  owner: workflowOwnerSchema,
  manifest: runManifestSchema,
  step: stepRefSchema,
  node: workflowPlanNodeSchema,
  executorBindingId: workflowIdSchema
}).strict().superRefine((value, context) => {
  if (value.step.runId !== value.manifest.run.runId || value.step.revision !== value.manifest.run.revision) context.addIssue({ code: 'custom', path: ['step'], message: 'Driver step and adopted manifest disagree' })
  const executor = value.manifest.executors.find((entry) => entry.bindingId === value.executorBindingId)
  if (!executor || canonicalWorkflowJson(executor) !== canonicalWorkflowJson(value.node.executor)) context.addIssue({ code: 'custom', path: ['executorBindingId'], message: 'Driver executor is not the snapshot pinned in the manifest' })
  if (value.node.nodeId !== value.step.nodeId || value.node.nodeId !== workflowNodeIdentity(value.manifest.definition, value.node.phaseId, value.node.stepId)) context.addIssue({ code: 'custom', path: ['node'], message: 'Driver node does not match the adopted definition and step identity' })
  if (value.node.role && !value.manifest.roles.some((role) => canonicalWorkflowJson(role) === canonicalWorkflowJson(value.node.role))) context.addIssue({ code: 'custom', path: ['node', 'role'], message: 'Driver role is not pinned in the manifest' })
})
export const driverOperationRefSchema = z.object({ operationId: workflowIdSchema, owner: workflowOwnerSchema, scope: workflowScopeSchema, run: runRefSchema }).strict()
export const driverAcknowledgementSchema = z.object({
  operationId: workflowIdSchema,
  status: z.enum(['accepted', 'rejected', 'outcome-unknown']),
  sessionId: workflowIdSchema.nullable(),
  turnId: workflowIdSchema.nullable(),
  evidenceRefs: z.array(workflowIdSchema)
}).strict()
export const driverStopResultSchema = z.object({ operationId: workflowIdSchema, status: z.enum(['requested', 'stopped', 'unconfirmed', 'rejected']), evidenceRefs: z.array(workflowIdSchema) }).strict()
export const driverReconciliationSchema = z.object({ operationId: workflowIdSchema, status: z.enum(['confirmed', 'unresolved', 'conflict']), evidenceRefs: z.array(workflowIdSchema) }).strict()
export const workflowWriteAcknowledgementSchema = z.object({
  id: workflowIdSchema,
  status: z.enum(['committed', 'duplicate', 'revision-conflict', 'payload-conflict', 'owner-conflict', 'store-unavailable']),
  cursor: workflowCursorSchema.nullable()
}).strict().superRefine((value, context) => {
  if ((value.status === 'committed' || value.status === 'duplicate') && value.cursor === null) context.addIssue({ code: 'custom', path: ['cursor'], message: 'Durable acceptance requires a committed cursor' })
})
export const journalCommitSchema = z.object({
  command: workflowCommandSchema,
  owner: workflowOwnerSchema,
  expectedCurrent: runRefSchema.nullable(),
  runChanges: z.array(workflowRunSchema).min(1),
  events: z.array(executionEventSchema),
  outbox: z.array(workflowOperationSchema)
}).strict().superRefine((value, context) => {
  const scope = workflowScopeIdentity(value.command.scope)
  const runIdentity = (run: z.infer<typeof runRefSchema>): string => JSON.stringify([run.runId, run.revision])
  const targetRun = { runId: value.command.runId, revision: value.command.expectedRevision }
  const targetIdentity = runIdentity(targetRun)
  if (value.command.kind !== 'start' && value.expectedCurrent === null) context.addIssue({ code: 'custom', path: ['expectedCurrent'], message: 'Existing-run admission requires an expected current identity' })
  if (value.expectedCurrent && (value.expectedCurrent.runId !== value.command.runId || value.expectedCurrent.revision !== value.command.expectedRevision)) context.addIssue({ code: 'custom', path: ['expectedCurrent'], message: 'Command and expected current run disagree' })
  const changedRuns = new Set<string>()
  let successorCount = 0
  value.runChanges.forEach((run, index) => {
    if (workflowScopeIdentity(run.scope) !== scope) context.addIssue({ code: 'custom', path: ['runChanges', index], message: 'Cross-scope control transaction' })
    const identity = runIdentity(run.run)
    if (changedRuns.has(identity)) context.addIssue({ code: 'custom', path: ['runChanges', index], message: 'Duplicate run change identity' })
    changedRuns.add(identity)
    if (identity === targetIdentity) return
    const isSuccessor = value.command.kind === 'adopt-revision' && value.expectedCurrent !== null && run.predecessor !== null && runIdentity(run.predecessor) === targetIdentity
    if (!isSuccessor) context.addIssue({ code: 'custom', path: ['runChanges', index], message: 'Run change is not the command target or its adopted successor' })
    else successorCount += 1
  })
  if (successorCount > 1) context.addIssue({ code: 'custom', path: ['runChanges'], message: 'One adoption command cannot create multiple successors' })
  const admittedRuns = new Set([targetIdentity, ...changedRuns])
  value.outbox.forEach((operation, index) => {
    if (workflowScopeIdentity(operation.scope) !== scope || operation.commandId !== value.command.commandId) context.addIssue({ code: 'custom', path: ['outbox', index], message: 'Cross-scope or unrelated outbox operation' })
    if (!admittedRuns.has(runIdentity(operation.run))) context.addIssue({ code: 'custom', path: ['outbox', index, 'run'], message: 'Outbox operation is not for an admitted run' })
    if (operation.ownerId !== value.owner.ownerId || operation.fencingToken !== value.owner.fencingToken) context.addIssue({ code: 'custom', path: ['outbox', index], message: 'Outbox operation owner/fence differs from the admitted owner' })
  })
  value.events.forEach((event, index) => {
    if (event.attribution.kind !== 'assigned' || workflowScopeIdentity(event.attribution.scope) !== scope) context.addIssue({ code: 'custom', path: ['events', index], message: 'Control transaction needs explicitly assigned matching events' })
    if (event.attribution.kind === 'assigned' && !admittedRuns.has(runIdentity(event.attribution.run))) context.addIssue({ code: 'custom', path: ['events', index, 'attribution', 'run'], message: 'Control event is not for an admitted run' })
  })
})
export const journalSnapshotSchema = z.object({ run: workflowRunSchema, manifest: runManifestSchema.nullable(), cursor: workflowCursorSchema }).strict().superRefine((value, context) => {
  if (value.manifest && (workflowScopeIdentity(value.run.scope) !== workflowScopeIdentity(value.manifest.scope) || value.run.run.runId !== value.manifest.run.runId || value.run.run.revision !== value.manifest.run.revision)) context.addIssue({ code: 'custom', path: ['manifest'], message: 'Snapshot run and adopted manifest disagree' })
  if (value.manifest && (value.run.definition.definitionId !== value.manifest.definition.definitionId || value.run.definition.revision !== value.manifest.definition.revision)) context.addIssue({ code: 'custom', path: ['manifest', 'definition'], message: 'Snapshot run and adopted definition disagree' })
})

export type DriverDispatch = z.infer<typeof driverDispatchSchema>
export type DriverOperationRef = z.infer<typeof driverOperationRefSchema>
export type DriverAcknowledgement = z.infer<typeof driverAcknowledgementSchema>
export type DriverStopResult = z.infer<typeof driverStopResultSchema>
export type DriverReconciliation = z.infer<typeof driverReconciliationSchema>
export type WorkflowWriteAcknowledgement = z.infer<typeof workflowWriteAcknowledgementSchema>
export type JournalCommit = z.infer<typeof journalCommitSchema>
export type JournalSnapshot = z.infer<typeof journalSnapshotSchema>
export const workflowEventReportSchema = z.object({ event: executionEventSchema, payloadDigest: workflowDigestSchema }).strict()
export type WorkflowEventReport = z.infer<typeof workflowEventReportSchema>

/** Acceptance only acknowledges dispatch handling; actual progress comes from source events. */
export interface WorkflowDriverPort {
  dispatch(request: DriverDispatch): Promise<DriverAcknowledgement>
  requestStop(request: DriverOperationRef): Promise<DriverStopResult>
  reconcile(request: DriverOperationRef): Promise<DriverReconciliation>
}
/** A committed receipt refers to durable control storage, never merely an in-memory queue. */
export interface WorkflowReportSinkPort {
  append(report: WorkflowEventReport): Promise<WorkflowWriteAcknowledgement>
}
/** Command/CAS/run/event/outbox admission is one transaction in the owning control store. */
export interface WorkflowJournalPort {
  commit(request: JournalCommit): Promise<WorkflowWriteAcknowledgement>
  load(scope: z.infer<typeof workflowScopeSchema>, run: z.infer<typeof runRefSchema>): Promise<JournalSnapshot | null>
}
