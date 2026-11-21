import { z } from 'zod'
import { acpPermissionReviewSchema } from './acp-permission-review'
import { cruxWorkQuerySchema } from './crux-work'
import { nativeTaskOutputSelectionSchema, nativeTaskOutputSyncSchema, nativeTaskSelectedCodeSchema } from './native-task-execution'
import { executionArtifactRefSchema, executionArtifactVersionSchema, executionVersionRefSchema, executionArtifactViewSchema } from './team-execution-artifacts'
import type { IpcFail } from './ipc-errors'
import { teamExecutionBundleRefSchema } from './team-task-execution'

export const productTaskEngineSchema = z.object({ agentId: z.enum(['pi', 'codex', 'claude']), profileId: z.string().min(1).max(200).regex(/^[\w.-]+$/).optional() }).strict()
export const productTaskReadSchema = cruxWorkQuerySchema.extend({
  spaceId: z.string().min(1).max(300).optional(), taskCreatedAt: z.string().min(1).max(100).optional(), entryId: z.string().uuid().optional()
}).strict()
export const productTaskSuccessorSchema = z.object({ predecessorEntryId: z.string().uuid(), returnEventId: z.string().min(1).max(300),
  expectedInputBundle: teamExecutionBundleRefSchema }).strict()
export const productTaskReturnSchema = z.object({ id: z.string().min(1).max(300), action: z.enum(['return_development', 'return_delivery']),
  actorId: z.string().min(1).max(300), assigneeId: z.string().min(1).max(300), at: z.string(), body: z.string().min(1).max(1024 * 1024), bodyDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const productTaskPrepareSchema = productTaskReadSchema.omit({ entryId: true }).extend({
  engine: productTaskEngineSchema, successor: productTaskSuccessorSchema.optional()
}).strict()
export const productTaskControlSchema = z.object({ entryId: z.string().uuid() }).strict()
export const productTaskRetryPrepareSchema = productTaskControlSchema.extend({ afterCompleted: z.literal(true).optional() }).strict()
export const productTaskStartSchema = productTaskControlSchema.extend({ instruction: z.string().trim().max(32000), outputs: z.array(nativeTaskOutputSelectionSchema).max(16) }).strict()
export const productTaskPermissionSchema = productTaskControlSchema.extend({ requestId: z.string().min(1).max(200), optionId: z.string().min(1).max(1000) }).strict()
export const productTaskResultsQuerySchema = cruxWorkQuerySchema.extend({ spaceId: z.string().min(1).max(300), taskCreatedAt: z.string().min(1).max(100) }).strict()
export const productTaskArtifactQuerySchema = productTaskResultsQuerySchema.extend({ ref: executionArtifactRefSchema }).strict()
export const productTaskFinishSchema = productTaskResultsQuerySchema.extend({
  code: nativeTaskSelectedCodeSchema.optional()
}).strict()
const resultArtifacts = z.array(z.object({ ref: executionArtifactRefSchema, title: z.string(), kind: executionArtifactVersionSchema.shape.kind, byteLength: z.number().int().nonnegative(), createdAt: z.number().int().nonnegative() }).strict()).max(64)
export const productTaskHandoffPreflightSchema = z.object({
  ready: z.boolean(),
  blockers: z.array(z.string().min(1).max(500)).max(12)
}).strict()
export const productTaskResultsSchema = z.object({
  executionId: z.string().nullable(), sync: nativeTaskOutputSyncSchema.nullable(),
  artifacts: resultArtifacts,
  manifest: executionVersionRefSchema.nullable(), checkpoint: executionVersionRefSchema.nullable(),
  finalized: z.boolean(), nativeCleanupConfirmed: z.boolean().nullable(),
  canFinish: z.boolean(), repositoryId: z.string().nullable(),
  handoffPreflight: productTaskHandoffPreflightSchema,
  previous: z.object({ executionId: z.string(), artifacts: resultArtifacts, manifest: executionVersionRefSchema, checkpoint: executionVersionRefSchema }).strict().optional()
}).strict()
export const productTaskViewSchema = z.object({
  owner: z.enum(['native', 'legacy']), entryId: z.string().uuid().nullable(),
  state: z.enum(['unavailable', 'available', 'preparing', 'prepared', 'starting', 'running', 'idle', 'failed', 'stop-requested', 'stopped', 'unknown']),
  preparationPending: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  blockers: z.array(z.object({ target: z.enum(['assignment', 'phase', 'inputs', 'workflow', 'resource', 'directory', 'runtime', 'reconcile']), message: z.string() }).strict()).max(32),
  directoryName: z.string().nullable(), resourceName: z.string().nullable(), nodeName: z.string().nullable(),
  materials: z.array(z.object({ title: z.string(), version: z.string() }).strict()).max(70),
  outputs: z.array(z.object({ id: z.string(), kind: z.string(), required: z.boolean() }).strict()).max(16),
  promptWritten: z.boolean(), outcome: z.enum(['completed', 'cancelled', 'failed']).nullable(), cleanupConfirmed: z.boolean(),
  executionId: z.string().nullable().optional(), generation: z.number().int().nonnegative().nullable().optional(), historical: z.boolean().optional(),
  successor: productTaskSuccessorSchema.extend({ feedback: productTaskReturnSchema }).strict().optional(),
  feedback: productTaskReturnSchema.optional(),
  instructionRemaining: z.number().int().nonnegative().optional(),
  canRetry: z.boolean().optional(), canRestart: z.boolean().optional(), retryOf: z.string().uuid().optional(),
  outputSelections: z.array(nativeTaskOutputSelectionSchema).max(16).optional(),
  permissions: z.array(z.object({ requestId: z.string(), tool: z.string().nullable(),
    expiresAt: z.number().nullable().optional(), sessionId: z.string().optional(), connectionGeneration: z.string().optional(), turnId: z.string().optional(),
    reviewContext: acpPermissionReviewSchema.optional(),
    options: z.array(z.object({ optionId: z.string(), name: z.string(), kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']).optional() }).strict()).max(32)
  }).strict()).max(32)
}).strict()
export type ProductTaskView = z.infer<typeof productTaskViewSchema>
export type ProductTaskEngine = z.infer<typeof productTaskEngineSchema>
export type ProductTaskReply = { ok: true; value: ProductTaskView } | IpcFail
export type ProductTaskResults = z.infer<typeof productTaskResultsSchema>
export type ProductTaskResultsReply = { ok: true; value: ProductTaskResults } | IpcFail
export interface ProductTaskApi {
  read(input: z.infer<typeof productTaskReadSchema>): Promise<ProductTaskReply>
  prepare(input: z.infer<typeof productTaskPrepareSchema>): Promise<ProductTaskReply>
  retryPrepare(input: z.infer<typeof productTaskRetryPrepareSchema>): Promise<ProductTaskReply>
  start(input: z.infer<typeof productTaskStartSchema>): Promise<ProductTaskReply>
  reconcile(input: z.infer<typeof productTaskControlSchema>): Promise<ProductTaskReply>
  stop(input: z.infer<typeof productTaskControlSchema>): Promise<ProductTaskReply>
  permission(input: z.infer<typeof productTaskPermissionSchema>): Promise<ProductTaskReply>
  results(input: z.infer<typeof productTaskResultsQuerySchema>): Promise<ProductTaskResultsReply>
  artifact(input: z.infer<typeof productTaskArtifactQuerySchema>): Promise<{ ok: true; value: z.infer<typeof executionArtifactViewSchema> } | IpcFail>
  finish(input: z.infer<typeof productTaskFinishSchema>): Promise<ProductTaskResultsReply>
}
