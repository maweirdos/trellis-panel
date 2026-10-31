import { z } from 'zod'

export const TASK_OUTPUT_FILES = ['prd.md', 'design.md', 'implement.md', 'delivery.md'] as const
export const TASK_OUTPUT_KINDS = { 'prd.md': 'prd', 'design.md': 'design', 'implement.md': 'implement', 'delivery.md': 'delivery-note' } as const
export const taskOutputFileSchema = z.enum(TASK_OUTPUT_FILES)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const serial = z.number().int().positive().safe()
export const taskOutputOriginBundleSchema = z.object({ bundleId: z.string().uuid(), revision: serial, digest }).strict()
/** Device claims about the native input/attempt; no client assertion of verification or identity. */
export const taskOutputOriginSchema = z.object({
  kind: z.literal('native-task-output'), inputVersion: digest,
  attemptId: z.string().min(1).max(256), generation: serial, file: taskOutputFileSchema,
  inputBundle: taskOutputOriginBundleSchema.optional()
}).strict()
/** This identifies the reporting device, not server proof of native files or model compliance. */
export const taskOutputVersionOriginSchema = taskOutputOriginSchema.extend({ verification: z.literal('device-reported'), deviceId: z.string().uuid() }).strict()
export type TaskOutputFile = z.infer<typeof taskOutputFileSchema>
export type TaskOutputOriginBundle = z.infer<typeof taskOutputOriginBundleSchema>
export type TaskOutputOrigin = z.infer<typeof taskOutputOriginSchema>
export type TaskOutputVersionOrigin = z.infer<typeof taskOutputVersionOriginSchema>
