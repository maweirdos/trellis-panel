import { z } from 'zod'
import { databaseDeliveryCaptureRequestSchema } from './database-delivery'
import { processOwnerSchema, workspaceGrantSchema } from './daemon/identity'
import { teamContentPinSchema } from './team-content-transport'
import { teamDigestSchema, teamIdSchema } from './team-platform'
import { teamExecutionRecordSchema, teamTaskRefSchema } from './team-task-execution'
import { executionInputResourceSchema, executionInputSchema } from './team-execution-input'
import { portableOutputSchema } from './workflow/portable-definition'
import { workcopyIdentitySchema, workcopyObservationSchema } from './workcopy-use'

const count = z.number().int().nonnegative().safe()
export const nativePreparationPinSchema = teamContentPinSchema.extend({
  connectionId: teamIdSchema, pairingId: teamIdSchema, deviceId: teamIdSchema,
  origin: z.string().url().max(2048), projectId: teamIdSchema
}).strict()
export const nativePreparationResourceSchema = z.object({ resourceId: teamIdSchema, revision: count.min(1), selectionRevision: count.min(1), spaceRevision: count }).strict()
export const nativeTaskPrepareSchema = z.object({
  operation: z.literal('prepare'), preparationId: z.string().uuid(), origin: z.enum(['product', 'editor']),
  ownership: z.enum(['product-managed', 'editor-owned']), pin: nativePreparationPinSchema, task: teamTaskRefSchema,
  expected: z.object({ executionId: teamIdSchema, generation: count.min(1), nodeId: teamExecutionRecordSchema.shape.nodeId,
    attempt: count.min(1), inputDigest: teamDigestSchema, workcopy: workcopyObservationSchema,
    resource: nativePreparationResourceSchema.nullable() }).strict(),
  /** Explicit receiver paths for a predecessor's selected fixed files. */
  targetPaths: z.record(z.string().uuid(), z.string().min(1).max(4096)).optional()
}).strict()
export const nativeTaskPreparationRequestSchema = z.discriminatedUnion('operation', [nativeTaskPrepareSchema, databaseDeliveryCaptureRequestSchema,
  z.object({ operation: z.literal('verify'), preparationId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('inspect'), preparationId: z.string().uuid() }).strict()
])
const sourceVerification = z.object({ verification: z.literal('native-read'), availability: z.literal('available'),
  application: z.enum(['not-required', 'available-not-applied', 'applied']), ready: z.boolean(), sourceDigest: teamDigestSchema, observedAt: count }).strict()
/** Private native mapping. It is neither a shared identity nor a running-process receipt. */
export const nativeTaskBindingSchema = z.object({
  version: z.literal(1), state: z.literal('ready'), preparationId: z.string().uuid(), request: nativeTaskPrepareSchema,
  root: z.string().min(1).max(4096), directoryIdentity: teamDigestSchema, directory: z.string().min(1).max(4096), grant: workspaceGrantSchema,
  nativeOwner: processOwnerSchema, workcopy: workcopyIdentitySchema,
  execution: teamExecutionRecordSchema, input: executionInputSchema,
  resources: z.array(z.object({ resource: executionInputResourceSchema, status: z.enum(['available', 'withdrawn', 'unavailable']),
    path: z.string().min(1).max(4096).nullable() }).strict()).max(128),
  outputs: z.array(z.object({ nodeId: z.string().min(1).max(512), output: portableOutputSchema, path: z.string().min(1).max(4096) }).strict()).max(1024),
  predecessor: z.object({ executionId: teamIdSchema, checkpointVersionId: teamIdSchema, checkpointDigest: teamDigestSchema, source: sourceVerification }).strict().nullable(),
  resourceRevision: nativePreparationResourceSchema.nullable(), authorizationRevision: count, preparedAt: count
}).strict()
export type NativeTaskPrepare = z.infer<typeof nativeTaskPrepareSchema>
export type NativeTaskPreparationRequest = z.infer<typeof nativeTaskPreparationRequestSchema>
export type NativeTaskBinding = z.infer<typeof nativeTaskBindingSchema>
