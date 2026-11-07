import { z } from 'zod'
import { taskProgressPinSchema } from '../../../../shared/crux-task-progress-native'
import { taskOutputBindingViewSchema, TASK_OUTPUT_FILES } from '../../../../shared/crux-task-outputs'
import { teamTaskMaterialCommandSchema, teamTaskMaterialReceiptSchema, teamTaskMaterialReferenceSchema } from '../../../../shared/team-task-materials'

export const OUTPUT_STABLE_MS = 1500
export const MAX_OUTPUT_BYTES = 1024 * 1024
export const MAX_PENDING_BYTES = 8 * 1024 * 1024
export const MAX_STATE_BYTES = 32 * 1024 * 1024
export const outputCommandSchema = z.union([teamTaskMaterialCommandSchema.options[0], teamTaskMaterialCommandSchema.options[1]])
export type OutputCommand = z.infer<typeof outputCommandSchema>
export const outputBindingSchema = taskOutputBindingViewSchema.omit({ pending: true }).extend({
  pin: taskProgressPinSchema, taskCreatedAt: z.string().min(1).max(100), projectRoot: z.string().min(1).max(8192),
  taskDir: z.string().min(1).max(200), localTaskId: z.string(), sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
  projectIdentity: z.string(), references: z.array(teamTaskMaterialReferenceSchema).max(16), approverIds: z.array(z.string().uuid()).max(32),
  baselineDraftRevision: z.number().int().positive().nullable(),
  pending: z.object({ command: outputCommandSchema, state: z.enum(['queued', 'dispatching', 'unknown']), receipt: teamTaskMaterialReceiptSchema.nullable() }).strict().nullable(),
  observation: z.object({ digest: z.string(), at: z.number(), mtime: z.number() }).strict().nullable()
}).strict()
export const outputStoreSchema = z.object({ version: z.literal(1), bindings: z.array(outputBindingSchema).max(64) }).strict()
export type OutputBinding = z.infer<typeof outputBindingSchema>
export type OutputStore = z.infer<typeof outputStoreSchema>
export type OutputFile = typeof TASK_OUTPUT_FILES[number]
export class TaskOutputError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
