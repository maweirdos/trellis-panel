import { z } from 'zod'

export const teamTransportFailureSchema = z.object({ status: z.number().int().min(100).max(599).nullable(),
  method: z.enum(['GET', 'POST']), route: z.string().max(512), retryAfterMs: z.number().int().nonnegative().max(86_400_000).nullable(),
  reason: z.enum(['http', 'contract', 'response', 'network', 'timeout', 'retry-budget', 'invalid-retry-after', 'cancelled']) }).strict()

/** Local diagnostics carry classifications, never remote prose, prompts or credentials. */
export const nativeTaskFailureSchema = z.object({
  phase: z.string().max(80), code: z.string().max(100),
  reason: z.enum(['transport', 'validation', 'context-capability', 'context-budget', 'context-mismatch', 'native-failure']).optional(),
  transport: teamTransportFailureSchema.optional()
}).strict()
export type NativeTaskFailure = z.infer<typeof nativeTaskFailureSchema>
