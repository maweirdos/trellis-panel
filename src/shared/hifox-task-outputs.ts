import { z } from 'zod'
import { hifoxDevelopmentTargetSchema } from './hifox-work'
import type { TaskProgressPin } from './hifox-task-progress-native'
import { teamTaskMaterialKindSchema, teamTaskMaterialMetadataSchema } from './team-task-materials'
import { TASK_OUTPUT_FILES, TASK_OUTPUT_KINDS } from './task-output-origin'

export { TASK_OUTPUT_FILES, TASK_OUTPUT_KINDS } from './task-output-origin'
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const taskOutputScopeSchema = z.object({ query: hifoxDevelopmentTargetSchema.omit({ expected: true }), expected: hifoxDevelopmentTargetSchema.shape.expected }).strict()
export const taskOutputSelectionSchema = z.object({
  file: z.enum(TASK_OUTPUT_FILES), kind: teamTaskMaterialKindSchema, documentId: z.string().uuid().optional(),
  approverIds: z.array(z.string().uuid()).min(1).max(32).refine(ids => new Set(ids).size === ids.length).optional()
}).strict().refine(value => TASK_OUTPUT_KINDS[value.file] === value.kind && (value.documentId !== undefined || value.approverIds !== undefined), '请选择对应文档类型及首次创建所需的审批人')
export const taskOutputPreviewInputSchema = taskOutputScopeSchema.extend({ selection: taskOutputSelectionSchema }).strict()
export const taskOutputConfirmInputSchema = taskOutputScopeSchema.extend({ previewId: z.string().uuid() }).strict()
export const taskOutputCompareInputSchema = taskOutputScopeSchema.extend({ bindingId: z.string().uuid().optional(), previewId: z.string().uuid().optional(), side: z.enum(['local', 'remote', 'candidate']) }).strict()
export const taskOutputRecoverInputSchema = taskOutputScopeSchema.extend({ bindingId: z.string().uuid(), action: z.enum(['reconcile', 'retry', 'resume', 'pause', 'stop']), reviewToken: z.string().uuid().optional() }).strict()
export const taskOutputReadInputSchema = taskOutputScopeSchema.extend({ cursor: z.string().max(4096).optional() }).strict()
export const taskOutputBindingViewSchema = z.object({
  bindingId: z.string().uuid(), file: z.enum(TASK_OUTPUT_FILES), kind: teamTaskMaterialKindSchema, documentId: z.string().uuid().nullable(), title: z.string(),
  expected: taskOutputScopeSchema.shape.expected, state: z.enum(['active', 'pending', 'unknown', 'conflict', 'paused', 'stopped']),
  lastConfirmed: z.object({ at: z.number(), digest: hash, versionId: z.string().uuid(), draftRevision: z.number().int().positive() }).strict().nullable(),
  pending: z.object({ commandId: z.string().uuid(), digest: hash, state: z.enum(['queued', 'dispatching', 'unknown']) }).strict().nullable(),
  conflictVersionId: z.string().uuid().nullable(), error: z.string().nullable(), inputOutdated: z.boolean()
}).strict()
export const taskOutputStatusSchema = z.object({
  bindings: z.array(taskOutputBindingViewSchema).max(64), documents: z.array(teamTaskMaterialMetadataSchema).max(100), nextCursor: z.string().nullable(), hasMore: z.boolean()
}).strict()
export const taskOutputPreviewSchema = z.object({
  previewId: z.string().uuid(), expiresAt: z.number(), selection: taskOutputSelectionSchema, title: z.string(),
  text: z.string(), digest: hash, byteLength: z.number(), documentId: z.string().uuid().nullable(), draftRevision: z.number().nullable(),
  projectRoot: z.string(), taskDir: z.string(), taskId: z.string(), spaceId: z.string(), approverIds: z.array(z.string().uuid()),
  workingPrd: z.boolean(), comparisonTitle: z.string().nullable()
}).strict()
export const taskOutputComparisonSchema = z.object({
  side: z.enum(['local', 'remote', 'candidate']), text: z.string(), digest: hash, byteLength: z.number(), title: z.string(),
  versionId: z.string().uuid().nullable(), draftRevision: z.number().nullable(), reviewToken: z.string().uuid().optional()
}).strict()
export type TaskOutputScope = z.infer<typeof taskOutputScopeSchema>
export type TaskOutputSelection = z.infer<typeof taskOutputSelectionSchema>
export type TaskOutputStatus = z.infer<typeof taskOutputStatusSchema>
export type TaskOutputPreview = z.infer<typeof taskOutputPreviewSchema>
export type TaskOutputComparison = z.infer<typeof taskOutputComparisonSchema>
export type TaskOutputReply<T> = { ok: true; value: T } | { ok: false; code: string; error: string; outcomeUnknown?: boolean }
export interface TaskOutputsApi {
  read(input: z.input<typeof taskOutputReadInputSchema>): Promise<TaskOutputReply<TaskOutputStatus>>
  preview(input: z.input<typeof taskOutputPreviewInputSchema>): Promise<TaskOutputReply<TaskOutputPreview>>
  confirm(input: z.input<typeof taskOutputConfirmInputSchema>): Promise<TaskOutputReply<TaskOutputStatus>>
  compare(input: z.input<typeof taskOutputCompareInputSchema>): Promise<TaskOutputReply<TaskOutputComparison>>
  recover(input: z.input<typeof taskOutputRecoverInputSchema>): Promise<TaskOutputReply<TaskOutputStatus>>
}

/** Factory avoids a runtime import cycle when the existing native union adds these operations. */
export function createTaskOutputNativeSchema(pin: z.ZodType<TaskProgressPin>) {
  const identity = { pin, interactionKey: hash }
  return z.discriminatedUnion('operation', [
    taskOutputReadInputSchema.extend({ ...identity, operation: z.literal('outputs.read') }).strict(),
    taskOutputPreviewInputSchema.extend({ ...identity, operation: z.literal('outputs.preview') }).strict(),
    taskOutputConfirmInputSchema.extend({ ...identity, operation: z.literal('outputs.confirm') }).strict(),
    taskOutputCompareInputSchema.extend({ ...identity, operation: z.literal('outputs.compare') }).strict(),
    taskOutputRecoverInputSchema.extend({ ...identity, operation: z.literal('outputs.recover') }).strict()
  ])
}
export type TaskOutputNativeInput = z.infer<ReturnType<typeof createTaskOutputNativeSchema>>
