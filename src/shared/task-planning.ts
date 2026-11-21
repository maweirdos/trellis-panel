import { z } from 'zod'
import { modelSelectionIdSchema } from './model-selection'
import { cruxMaterialScopeSchema } from './crux-task-materials'
import { requirementCandidateSchema } from './conversation-requirements'
import { teamTaskMaterialReceiptSchema } from './team-task-materials'
import { conversationRespondSchema, type ConversationResult } from './private-conversations'

export const taskPlanningQuerySchema = cruxMaterialScopeSchema
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const taskPlanningPrepareSchema = taskPlanningQuerySchema.extend({
  commandId: z.string().uuid(), expectedUpdatedAt: z.string().min(1).max(100),
  agentId: z.literal('codex'), modelId: modelSelectionIdSchema,
  reusePlanningId: z.string().uuid().optional()
}).strict()
export const taskPlanningControlSchema = z.object({ planningId: z.string().uuid() }).strict()
export const taskPlanningRespondSchema = conversationRespondSchema.extend({ planningId: z.string().uuid() }).strict()
export const taskPlanningGenerateSchema = taskPlanningControlSchema.extend({ sourceDigest: digest }).strict()
export const taskPlanningSaveSchema = taskPlanningControlSchema.extend({
  candidateRevision: digest,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), editorIds: z.array(z.string().uuid()).min(1).max(32), approverIds: z.array(z.string().uuid()).min(1).max(32) }).strict(),
    z.object({ kind: z.literal('draft'), documentId: z.string().uuid(), expectedDraftRevision: z.number().int().positive().safe() }).strict()
  ])
}).strict()
export const taskPlanningRecoverySchema = taskPlanningControlSchema.extend({ retry: z.boolean().default(false) }).strict()
const nativeId = z.string().min(1).max(200)
const planningPermissionSchema = z.object({
  requestId: nativeId, sessionId: nativeId, agentName: z.string().max(500),
  toolCall: z.object({ toolCallId: nativeId.optional(), title: z.string().max(32_000).optional(), kind: z.string().max(100).optional() }).strict().optional(),
  options: z.array(z.object({ optionId: z.string().min(1).max(1000), name: z.string().max(32_000),
    kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']) }).strict()).max(32),
  projectRoot: z.string().max(8192).optional(), connectionGeneration: nativeId, turnId: nativeId,
  expiresAt: z.number().nonnegative().safe(),
  reviewContext: z.object({ command: z.string().min(1).max(8192), cwd: z.string().min(1).max(4096), details: z.string().max(16_384) }).strict().optional()
}).strict()
export const taskPlanningNativeViewSchema = z.object({
  sessionId: nativeId, connectionGeneration: nativeId, turnId: nativeId, requestId: z.string().uuid(),
  status: z.enum(['starting', 'ready', 'busy', 'awaiting_permission', 'cancelling', 'disconnected', 'legacy', 'error', 'closed']),
  pendingPermissions: z.array(planningPermissionSchema).max(64)
}).strict()
export const taskPlanningViewSchema = z.object({
  planningId: z.string().uuid().nullable(),
  state: z.enum(['empty', 'prepared', 'sending', 'running', 'candidate', 'cancelled', 'failed', 'unknown']),
  sourceDigest: digest.nullable(), current: z.boolean(), sourceError: z.string().nullable(),
  directoryName: z.string().nullable(), agentId: z.literal('codex').nullable(), modelId: z.string().nullable(),
  sources: z.array(z.object({ title: z.string(), revision: digest }).strict()).max(160),
  candidate: z.object({ revision: digest, value: requirementCandidateSchema }).strict().nullable(),
  nativeView: taskPlanningNativeViewSchema.optional(),
  cleanupConfirmed: z.boolean(),
  save: z.object({
    commandId: z.string().uuid(), state: z.enum(['pending', 'unknown', 'saved', 'conflict']),
    receipt: teamTaskMaterialReceiptSchema.nullable(), error: z.string().nullable()
  }).strict().nullable()
}).strict()
export type TaskPlanningQuery = z.infer<typeof taskPlanningQuerySchema>
export type TaskPlanningView = z.infer<typeof taskPlanningViewSchema>
export type TaskPlanningNativeView = z.infer<typeof taskPlanningNativeViewSchema>
export type TaskPlanningReply = ConversationResult<TaskPlanningView>
export interface TaskPlanningApi {
  read(input: TaskPlanningQuery): Promise<TaskPlanningReply>
  prepare(input: z.infer<typeof taskPlanningPrepareSchema>): Promise<TaskPlanningReply>
  selectSources(input: z.infer<typeof taskPlanningControlSchema>): Promise<TaskPlanningReply>
  generate(input: z.infer<typeof taskPlanningGenerateSchema>): Promise<TaskPlanningReply>
  respond(input: z.infer<typeof taskPlanningRespondSchema>): Promise<TaskPlanningReply>
  reconcile(input: z.infer<typeof taskPlanningControlSchema>): Promise<TaskPlanningReply>
  stop(input: z.infer<typeof taskPlanningControlSchema>): Promise<TaskPlanningReply>
  saveDraft(input: z.infer<typeof taskPlanningSaveSchema>): Promise<TaskPlanningReply>
  recoverSave(input: z.infer<typeof taskPlanningRecoverySchema>): Promise<TaskPlanningReply>
}
