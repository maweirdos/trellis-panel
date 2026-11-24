import { z } from 'zod'
import { teamDigestSchema, teamIdSchema } from './team-platform'
import { workflowIdSchema } from './workflow/identity'
import { taskInputCanonical } from './team-canonical'

const count = z.number().int().nonnegative().safe()
const serial = count.min(1)
export const executionArtifactKindSchema = z.enum(['implementation-report', 'check-report', 'general', 'source-patch', 'selected-file'])
export const executionArtifactRefSchema = z.object({ kind: z.literal('confirmed-artifact'), executionId: teamIdSchema,
  artifactId: teamIdSchema, versionId: teamIdSchema, bodyDigest: teamDigestSchema }).strict()
export const executionDocumentRefSchema = z.object({ kind: z.literal('confirmed-document'), documentId: teamIdSchema, versionId: teamIdSchema, bodyDigest: teamDigestSchema }).strict()
export const executionCreationRefSchema = z.object({ kind: z.literal('confirmed-creation'), creationId: teamIdSchema,
  revisionId: teamIdSchema, bodyDigest: teamDigestSchema, format: z.literal('html') }).strict()
export const executionOutputRefSchema = z.discriminatedUnion('kind', [executionDocumentRefSchema, executionArtifactRefSchema, executionCreationRefSchema])
export const executionVersionRefSchema = z.object({ versionId: teamIdSchema, digest: teamDigestSchema }).strict()
export const executionTestDeliverySchema = z.object({
  executionId: teamIdSchema,
  manifest: executionVersionRefSchema,
  checkpoint: executionVersionRefSchema,
}).strict()
const binding = { taskIdentity: z.string().min(1).max(4096), executionId: teamIdSchema, generation: serial, nodeId: workflowIdSchema, attempt: serial }
export const executionArtifactVersionSchema = z.object({ ...binding, artifactId: teamIdSchema, versionId: teamIdSchema,
  previousVersionId: teamIdSchema.nullable(), kind: executionArtifactKindSchema, title: z.string().min(1).max(300),
  bodyDigest: teamDigestSchema, byteLength: count.max(1024 * 1024), format: z.literal('utf8'),
  disposition: z.enum(['draft', 'confirmed', 'conflict']), commandId: teamIdSchema, createdAt: count }).strict()
export const executionArtifactViewSchema = z.object({ contractVersion: z.literal(2), artifact: executionArtifactVersionSchema, text: z.string().max(1024 * 1024) }).strict()
export const executionCarrySourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node-delivery'), manifest: executionVersionRefSchema }).strict(),
  z.object({ kind: z.literal('predecessor-finalization'), executionId: teamIdSchema }).strict()
])
export const executionDeliveryEntrySchema = z.object({ outputId: workflowIdSchema, ref: executionOutputRefSchema, carriedFrom: executionCarrySourceSchema.optional() }).strict()
export const executionDeliveryManifestSchema = z.object({ contractVersion: z.literal(2), ...binding,
  versionId: teamIdSchema, previous: executionVersionRefSchema.nullable(), entries: z.array(executionDeliveryEntrySchema).min(1).max(16),
  digest: teamDigestSchema, createdAt: count }).strict().superRefine((value, ctx) => {
  if (new Set(value.entries.map(item => item.outputId)).size !== value.entries.length) ctx.addIssue({ code: 'custom', message: 'Duplicate delivery output identity' })
})
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
export const executionCodeSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('selected-files'), files: z.array(executionArtifactRefSchema).min(1).max(16) }).strict(),
  z.object({ kind: z.literal('git-commit'), repositoryId: z.string().min(1).max(300), base: oid, commit: oid }).strict(),
  z.object({ kind: z.literal('git-patch'), repositoryId: z.string().min(1).max(300), base: oid, patch: executionArtifactRefSchema }).strict()
])
/** A device observation is evidence from that device, never a server filesystem attestation. */
export const executionSourceObservationSchema = z.object({ verification: z.literal('device-reported'), observedAt: count,
  availability: z.literal('available'), sourceDigest: teamDigestSchema }).strict()
export const executionHandoffCheckpointSchema = z.object({ contractVersion: z.literal(2), ...binding, versionId: teamIdSchema,
  previous: executionVersionRefSchema.nullable(), manifest: executionVersionRefSchema,
  remainingWork: z.string().max(8192), source: executionCodeSourceSchema, observation: executionSourceObservationSchema.nullable(),
  digest: teamDigestSchema, createdAt: count }).strict()
export function executionArtifactDigestText(raw: Record<string, unknown>): string {
  const { digest: _digest, ...content } = raw
  return taskInputCanonical(content)
}
export type ExecutionArtifactRef = z.infer<typeof executionArtifactRefSchema>
export type ExecutionArtifactVersion = z.infer<typeof executionArtifactVersionSchema>
export type ExecutionDeliveryManifest = z.infer<typeof executionDeliveryManifestSchema>
export type ExecutionHandoffCheckpoint = z.infer<typeof executionHandoffCheckpointSchema>
export type ExecutionCodeSource = z.infer<typeof executionCodeSourceSchema>
export type ExecutionTestDelivery = z.infer<typeof executionTestDeliverySchema>
