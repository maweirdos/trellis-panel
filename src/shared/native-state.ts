import { z } from 'zod'
import { runtimeWireSchema } from './daemon-runtime'

/** Native host-only state broker; preload exposes existing feature-specific facades. */
export const nativeStateRequests = {
  'native.provider.command': z.object({ commandId: z.string().uuid() }).strict(),
  'native.prepare': z.object({ releaseId: z.string().uuid() }).strict(),
  'native.state': z.object({}).strict(),
  'native.ready': z.object({}).strict(),
  'native.settings.write': z.object({
    expectedRevision: z.number().int().positive().safe(),
    patch: z.record(z.string().min(1).max(64), z.unknown()).refine((value) => Object.keys(value).length <= 30, 'Too many settings fields')
  }).strict()
} as const
export const nativeStateResults = {
  'native.provider.command': z.object({ state: z.enum(['absent', 'dispatching', 'completed', 'unknown']), result: runtimeWireSchema.optional() }).strict(),
  'native.prepare': z.object({ phase: z.literal('daemon'), revision: z.number().int().positive().safe() }).strict(),
  'native.state': z.object({ phase: z.enum(['legacy', 'prepared', 'daemon']), revision: z.number().int().positive().safe().nullable(), profileId: z.string().length(64) }).strict(),
  'native.ready': z.object({ ready: z.literal(true) }).strict(),
  'native.settings.write': z.object({ revision: z.number().int().positive().safe(), replayed: z.boolean() }).strict()
} as const
export const NATIVE_STATE_MUTATIONS = ['native.prepare', 'native.settings.write'] as const
export type NativeStateMethod = keyof typeof nativeStateRequests
export type NativeStateInput<M extends NativeStateMethod> = z.infer<(typeof nativeStateRequests)[M]>
export type NativeStateData<M extends NativeStateMethod> = z.infer<(typeof nativeStateResults)[M]>
