import { z } from 'zod'
import { daemonIdentitySchema, processOwnerSchema } from '../../shared/daemon'

/** Data-only schema: build stamps and lifecycle fences must not depend on the
 * lease acquisition module's runtime initialization order. */
export const daemonLeaseSchema = z.object({
  version: z.literal(1), epoch: z.string().uuid(), nonce: z.string().uuid(),
  identity: daemonIdentitySchema, owner: processOwnerSchema,
  acquiredAt: z.number().int().nonnegative()
}).strict()
export type DaemonLease = z.infer<typeof daemonLeaseSchema>
