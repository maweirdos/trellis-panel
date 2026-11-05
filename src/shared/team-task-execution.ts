import { z } from 'zod'
import { teamCommandIdSchema, teamDigestSchema, teamIdSchema } from './team-platform'
import { teamTaskProgressResourceIdSchema, teamTaskProgressRecordSchema } from './team-task-progress'
import { hifoxTransitionTaskInputSchema } from './hifox-schema'

const counter = z.number().int().nonnegative().safe()
const serial = counter.min(1)
const name = z.string().min(1).max(200).regex(/^[\p{L}\p{N}_.@ -]+$/u)
export const TEAM_EXECUTION_CONTRACT_VERSION = 2 as const
/** Epoch is an admission fence, never part of a task's durable identity. */
export const teamTaskRefSchema = z.object({
  instanceId: teamIdSchema, projectId: teamIdSchema, spaceId: teamTaskProgressResourceIdSchema,
  taskId: teamTaskProgressResourceIdSchema, taskCreatedAt: z.string().min(1).max(100)
}).strict()
export type TeamTaskRef = z.infer<typeof teamTaskRefSchema>
export function teamTaskIdentity(raw: TeamTaskRef): string {
  const t = teamTaskRefSchema.parse(raw)
  return JSON.stringify(['team-task', 2, t.instanceId, t.projectId, t.spaceId, t.taskId, t.taskCreatedAt])
}
/** Portable provenance only; importing/installing is owned by the source adapter. */
export const teamExecutionSourceRefSchema = z.object({ sourceProjectId: name, sourceTaskId: name, revision: name, digest: teamDigestSchema }).strict()
export const teamExecutionBundleRefSchema = z.object({ bundleId: teamIdSchema, revision: serial, digest: teamDigestSchema }).strict()
export const teamExecutionWorkflowRefSchema = z.object({ definitionId: name, revision: serial, digest: teamDigestSchema }).strict()
export const teamExecutionExecutorSchema = z.object({ engine: name, adapterVersion: name }).strict()
export const teamExecutionDependencySchema = z.object({ kind: z.literal('confirmed-document'), documentId: teamIdSchema, versionId: teamIdSchema, bodyDigest: teamDigestSchema }).strict()
export const teamExecutionFinalizationSchema = z.object({
  outcome: z.enum(['completed', 'interrupted', 'unknown']), evidenceRef: name,
  outputs: z.array(teamExecutionDependencySchema).max(16)
}).strict()
export const teamExecutionNativeStateSchema = z.enum(['unknown', 'running', 'idle', 'stop-requested', 'stopped', 'completed', 'interrupted'])
const envelope = {
  contractVersion: z.literal(2), commandId: teamCommandIdSchema, task: teamTaskRefSchema,
  expectedEpoch: teamIdSchema, expectedActorId: teamIdSchema, expectedDeviceId: teamIdSchema.nullable(),
  expectedGeneration: counter, expectedExecutionId: teamIdSchema.nullable()
}
export const teamExecutionCommandSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('claim'), ownership: z.enum(['product-managed', 'editor-owned']),
    workflow: teamExecutionWorkflowRefSchema, executor: teamExecutionExecutorSchema,
    inputBundle: teamExecutionBundleRefSchema.nullable(), predecessorExecutionId: teamIdSchema.nullable(),
    source: teamExecutionSourceRefSchema.nullable(), nodeId: name, attempt: serial }).strict(),
  z.object({ ...envelope, kind: z.literal('report'), seq: serial, nodeId: name, attempt: serial,
    state: teamTaskProgressRecordSchema.shape.state, step: teamTaskProgressRecordSchema.shape.step,
    blockingReason: teamTaskProgressRecordSchema.shape.blockingReason, nativeState: teamExecutionNativeStateSchema }).strict(),
  z.object({ ...envelope, kind: z.literal('finalize'), finalization: teamExecutionFinalizationSchema }).strict(),
  z.object({ ...envelope, kind: z.literal('release'), nativeState: teamExecutionNativeStateSchema }).strict(),
  z.object({ ...envelope, kind: z.literal('transition'), expectedRevision: counter, transition: hifoxTransitionTaskInputSchema }).strict()
])
export type TeamExecutionCommand = z.infer<typeof teamExecutionCommandSchema>
export const teamExecutionRecordSchema = z.object({
  contractVersion: z.literal(2), executionId: teamIdSchema, task: teamTaskRefSchema, epoch: teamIdSchema, generation: serial,
  actorId: teamIdSchema, deviceId: teamIdSchema.nullable(), ownership: z.enum(['product-managed', 'editor-owned']),
  workflow: teamExecutionWorkflowRefSchema, executor: teamExecutionExecutorSchema, inputBundle: teamExecutionBundleRefSchema.nullable(),
  predecessorExecutionId: teamIdSchema.nullable(), source: teamExecutionSourceRefSchema.nullable(), nodeId: name, attempt: serial,
  authority: z.enum(['active', 'released', 'revoked']), revocationReason: z.string().max(200).nullable(),
  nativeState: teamExecutionNativeStateSchema, nativeVerification: z.literal('owner-reported'),
  progress: teamTaskProgressRecordSchema.nullable(), finalization: teamExecutionFinalizationSchema.nullable(),
  createdAt: counter, updatedAt: counter
}).strict()
export type TeamExecutionRecord = z.infer<typeof teamExecutionRecordSchema>
export const teamExecutionViewSchema = z.object({ contractVersion: z.literal(2), task: teamTaskRefSchema,
  epoch: teamIdSchema, authorizationRevision: counter, generation: counter,
  active: teamExecutionRecordSchema.nullable(), serverTime: counter }).strict()
export type TeamExecutionView = z.infer<typeof teamExecutionViewSchema>
export const teamExecutionReceiptSchema = z.object({ contractVersion: z.literal(2), commandId: teamCommandIdSchema,
  task: teamTaskRefSchema, epoch: teamIdSchema, kind: z.enum(['claim', 'report', 'finalize', 'release', 'transition']),
  requestDigest: teamDigestSchema, executionId: teamIdSchema, generation: serial,
  actorId: teamIdSchema, deviceId: teamIdSchema.nullable(), committedAt: counter }).strict()
export type TeamExecutionReceipt = z.infer<typeof teamExecutionReceiptSchema>
export const teamExecutionCommandReplySchema = z.object({ status: z.enum(['committed', 'duplicate']), commandId: teamCommandIdSchema, result: teamExecutionReceiptSchema }).strict()
export const teamExecutionReadQuerySchema = z.object({ contractVersion: z.coerce.number().pipe(z.literal(2)), instanceId: teamIdSchema,
  spaceId: teamTaskProgressResourceIdSchema, taskCreatedAt: z.string().min(1).max(100) }).strict()
export const desktopExecutionScopeSchema = z.object({ connectionId: teamIdSchema, task: teamTaskRefSchema }).strict()
export const desktopExecutionCommandSchema = desktopExecutionScopeSchema.extend({ command: teamExecutionCommandSchema }).strict()
export const desktopExecutionHistorySchema = desktopExecutionScopeSchema.extend({ executionId: teamIdSchema }).strict()
export const desktopExecutionIntentSchema = z.object({ connectionId: teamIdSchema, command: teamExecutionCommandSchema,
  state: z.enum(['dispatching', 'acknowledgement-unknown', 'committed', 'rejected']),
  receipt: teamExecutionReceiptSchema.nullable(), updatedAt: counter }).strict()
export const DESKTOP_EXECUTION_PENDING_MAX_ITEMS = 100
/** Leaves envelope headroom below the existing 3 MiB owned-worker RPC limit. */
export const DESKTOP_EXECUTION_PENDING_MAX_BYTES = 3 * 1024 * 1024 - 64 * 1024
export const desktopExecutionPendingInputSchema = desktopExecutionScopeSchema.extend({
  cursor: z.string().min(1).max(2048).optional(), limit: counter.min(1).max(DESKTOP_EXECUTION_PENDING_MAX_ITEMS).default(50)
}).strict()
export const desktopExecutionPendingPageSchema = desktopExecutionScopeSchema.extend({
  contractVersion: z.literal(2), items: z.array(desktopExecutionIntentSchema).max(DESKTOP_EXECUTION_PENDING_MAX_ITEMS),
  hasMore: z.boolean(), nextCursor: z.string().min(1).max(2048).nullable()
}).strict().superRefine((page, ctx) => {
  if (page.hasMore !== (page.nextCursor !== null)) ctx.addIssue({ code: 'custom', message: 'Pending continuation must have a cursor' })
  for (const item of page.items) if (item.state === 'committed' || item.connectionId !== page.connectionId || teamTaskIdentity(item.command.task) !== teamTaskIdentity(page.task)) ctx.addIssue({ code: 'custom', message: 'Pending item belongs to another scope or is already committed' })
})
