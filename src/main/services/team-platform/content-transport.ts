import { z } from 'zod'
import { teamContentPinSchema } from '../../../shared/team-content-transport'
import { teamIdSchema } from '../../../shared/team-platform'

export const nativeContentPinSchema = teamContentPinSchema.extend({
  connectionId: teamIdSchema, pairingId: teamIdSchema, deviceId: teamIdSchema,
  origin: z.string().url().max(2048), projectId: teamIdSchema
}).strict()
export type NativeContentPin = z.infer<typeof nativeContentPinSchema>
