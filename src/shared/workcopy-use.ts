import { z } from 'zod'

const text = z.string().min(1).max(4096)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
/** Local native metadata only. Paths and occupancy tokens never enter team records. */
export const workcopyIdentitySchema = z.object({
  id: hash, canonicalRoot: text, repoRoot: text.nullable(), worktreeGitDir: text.nullable(),
  gitCommonDir: text.nullable(), commonId: hash.nullable(), physicalId: text,
  branch: z.string().max(4096).nullable(), head: z.string().max(128).nullable(), revision: hash
}).strict()
export type WorkcopyIdentity = z.infer<typeof workcopyIdentitySchema>
export const workcopyOwnerSchema = z.object({
  kind: z.enum(['agent', 'application', 'git']), id: z.string().min(1).max(200),
  generation: z.string().min(1).max(200), taskKey: z.string().min(1).max(4096).optional(),
  label: z.string().min(1).max(200)
}).strict()
export type WorkcopyOwner = z.infer<typeof workcopyOwnerSchema>
export const workcopyUseKindSchema = z.enum(['writer', 'consumer', 'tree-change', 'git-mutation'])
export type WorkcopyUseKind = z.infer<typeof workcopyUseKindSchema>
export const workcopyConsumerAccessSchema = z.object({
  revision: z.number().int().nonnegative().safe(), taskKeys: z.array(z.string().min(1).max(4096)).max(128)
}).strict()
export const workcopyLeaseSchema = z.object({
  token: z.string().uuid(), identity: workcopyIdentitySchema, owner: workcopyOwnerSchema,
  kind: workcopyUseKindSchema, state: z.enum(['held', 'unknown']), acquiredAt: z.number().int().nonnegative(),
  reason: z.string().max(400).optional(), consumerAccess: workcopyConsumerAccessSchema.optional()
}).strict()
export type WorkcopyLease = z.infer<typeof workcopyLeaseSchema>
export const workcopyObservationSchema = workcopyIdentitySchema.pick({ id: true, revision: true })
export type WorkcopyObservation = z.infer<typeof workcopyObservationSchema>
export const workcopyAcquireSchema = z.object({
  kind: workcopyUseKindSchema, owner: workcopyOwnerSchema, expected: workcopyObservationSchema.optional(),
  /** Minted and retained by the native lifecycle before submitting admission. */
  token: z.string().uuid().optional()
}).strict()
export type WorkcopyAcquire = z.infer<typeof workcopyAcquireSchema>
export const workcopyReleaseSchema = z.object({
  token: z.string().uuid(), owner: workcopyOwnerSchema,
  outcome: z.enum(['settled', 'cleanup-confirmed', 'unknown']), reason: z.string().max(400).optional()
}).strict()
export type WorkcopyRelease = z.infer<typeof workcopyReleaseSchema>
const workcopyReleaseRequestSchema = workcopyReleaseSchema.extend({ operation: z.literal('release') }).strict()
const privateConsumer = { token: z.string().uuid(), owner: workcopyOwnerSchema, root: text, identityId: hash }
export const workcopyCleanupRequestSchema = z.discriminatedUnion('operation', [
  workcopyReleaseRequestSchema,
  z.object({ operation: z.literal('consumer-read'), ...privateConsumer }).strict(),
  z.object({ operation: z.literal('consumer-restrict'), ...privateConsumer,
    expectedRevision: workcopyConsumerAccessSchema.shape.revision, taskKeys: workcopyConsumerAccessSchema.shape.taskKeys }).strict()
])
export const workcopyUseRequestSchema = z.discriminatedUnion('operation', [
  workcopyAcquireSchema.extend({ operation: z.literal('acquire') }).strict(),
  workcopyReleaseRequestSchema,
  z.object({ operation: z.literal('assert'), token: z.string().uuid(), owner: workcopyOwnerSchema }).strict(),
  z.object({ operation: z.literal('consumer-tasks'), token: z.string().uuid(), owner: workcopyOwnerSchema,
    expectedRevision: workcopyConsumerAccessSchema.shape.revision, taskKeys: workcopyConsumerAccessSchema.shape.taskKeys }).strict(),
  z.object({ operation: z.literal('inspect') }).strict()
])
export type WorkcopyUseRequest = z.infer<typeof workcopyUseRequestSchema>
/** Inspection omits the token; it grants neither release nor process termination. */
export const workcopyUseFactSchema = workcopyLeaseSchema.omit({ token: true })
export type WorkcopyUseFact = z.infer<typeof workcopyUseFactSchema>
export const workcopyUseResultSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('acquire'), lease: workcopyLeaseSchema }).strict(),
  z.object({ operation: z.literal('release'), released: z.boolean(), state: z.enum(['released', 'unknown', 'stale']) }).strict(),
  z.object({ operation: z.literal('assert'), identity: workcopyIdentitySchema }).strict(),
  z.object({ operation: z.literal('consumer-tasks'), lease: workcopyLeaseSchema }).strict(),
  z.object({ operation: z.literal('consumer-read'), lease: workcopyLeaseSchema }).strict(),
  z.object({ operation: z.literal('consumer-restrict'), lease: workcopyLeaseSchema }).strict(),
  z.object({ operation: z.literal('inspect'), identity: workcopyIdentitySchema, uses: z.array(workcopyUseFactSchema).max(256) }).strict()
])
export type WorkcopyUseResult = z.infer<typeof workcopyUseResultSchema>
/** Only bounded original-owner cleanup may pass a closed admission gate. */
export function isWorkcopyReleaseWire(value: unknown): boolean {
  return z.object({ inline: workcopyReleaseRequestSchema }).strict().safeParse(value).success
}
export function isBoundedWorkcopyCleanup(method: string, value: unknown): boolean {
  return method === 'runtime.workcopyUse' ? isWorkcopyReleaseWire(value)
    : method === 'runtime.workcopyCleanup' && z.object({ inline: workcopyCleanupRequestSchema }).strict().safeParse(value).success
}
