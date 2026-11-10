import { z } from 'zod'
import { daemonIdentitySchema, processOwnerSchema } from '../../shared/daemon'

export const nativeJobProofSchema = z.object({
  version: z.literal(1), nonce: z.string().uuid(), jobName: z.string(),
  identity: daemonIdentitySchema, root: processOwnerSchema, guardian: processOwnerSchema,
  controller: processOwnerSchema.optional()
}).strict()
