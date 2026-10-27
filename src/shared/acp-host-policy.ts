import { z } from 'zod'
import type { AcpHostPolicyOutcome } from './types'

const outcomeSchema = z.object({
  authority: z.literal('host-policy'), status: z.literal('cancelled'), cause: z.literal('retry-beyond-turn-budget'),
  turnId: z.string().min(1).max(200), connectionGeneration: z.string().min(1).max(200),
  backendSessionId: z.string().min(1).max(512), requestedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  message: z.string().min(1).max(4000), nativeCancellationAcknowledged: z.boolean()
})

/** A receipt may change the application outcome only for its exact native execution. */
export function readAcpHostPolicyOutcome(value: unknown, expected: {
  turnId?: string | null
  connectionGeneration?: string | null
  backendSessionId?: string | null
}): AcpHostPolicyOutcome | undefined {
  if (!expected.turnId || !expected.connectionGeneration || !expected.backendSessionId) return undefined
  const parsed = outcomeSchema.safeParse(value)
  if (!parsed.success || parsed.data.turnId !== expected.turnId || parsed.data.connectionGeneration !== expected.connectionGeneration
    || parsed.data.backendSessionId !== expected.backendSessionId) return undefined
  return parsed.data
}
