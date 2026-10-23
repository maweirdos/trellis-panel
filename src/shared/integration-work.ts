import { z } from 'zod'
import { providerIdSchema } from './integrations'

/** Additive execution contracts. A catalog declaration is not a verified grant. */
export const integrationIdSchema = z.string().min(1).max(128)
export const integrationRevisionSchema = z.number().int().positive().safe()
export const integrationSourceSchema = z.object({
  providerId: providerIdSchema, connectionId: integrationIdSchema,
  connectionRevision: integrationRevisionSchema, instanceId: integrationIdSchema,
  remoteProjectId: integrationIdSchema, bindingId: integrationIdSchema,
  bindingRevision: integrationRevisionSchema
}).strict()
export const executionTargetSchema = z.object({
  kind: z.literal('local-daemon'), profileId: z.string().length(64), workspaceId: integrationIdSchema
}).strict()
export const integrationAccountSchema = z.object({
  id: integrationIdSchema, providerId: providerIdSchema, connectionId: integrationIdSchema,
  revision: integrationRevisionSchema, remoteUserId: integrationIdSchema,
  displayName: z.string().max(256), state: z.enum(['unverified', 'linked', 'revoked', 'unavailable'])
}).strict()
export const syncPlanSchema = z.object({
  id: integrationIdSchema, revision: integrationRevisionSchema, source: integrationSourceSchema,
  target: executionTargetSchema, direction: z.enum(['inbound', 'bidirectional']),
  state: z.enum(['unverified', 'active', 'paused', 'degraded', 'blocked']),
  transport: z.enum(['polling', 'webhook', 'stream', 'unavailable']),
  fieldMappingRevision: integrationRevisionSchema
}).strict()
export const integrationWorkInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sync'), planId: integrationIdSchema, planRevision: integrationRevisionSchema }),
  z.object({ kind: z.literal('import'), previewId: integrationIdSchema, previewDigest: z.string().regex(/^[a-f0-9]{64}$/), format: z.enum(['api', 'csv']) }),
  z.object({ kind: z.literal('assistant'), assistantId: integrationIdSchema, assistantRevision: integrationRevisionSchema, inboxReceiptId: integrationIdSchema }),
  z.object({ kind: z.literal('notification'), previewId: integrationIdSchema, previewDigest: z.string().regex(/^[a-f0-9]{64}$/) })
])
export const integrationJobStateSchema = z.enum(['queued', 'dispatched', 'running', 'paused', 'partially-failed', 'completed', 'cancel-requested', 'cancelled', 'unknown', 'rollback-blocked'])
export const integrationJobCountsSchema = z.object({
  /** Processed counts visited records, including failures. */
  processed: z.number().int().nonnegative().safe(), failed: z.number().int().nonnegative().safe(),
  total: z.number().int().nonnegative().safe().nullable()
}).strict().refine((counts) => counts.failed <= counts.processed && (counts.total === null || counts.processed <= counts.total), 'Job counts must satisfy failed <= processed <= known total')
export const integrationJobSchema = z.object({
  id: z.string().uuid(), commandId: z.string().uuid(), workspaceId: integrationIdSchema,
  source: integrationSourceSchema, input: integrationWorkInputSchema,
  state: integrationJobStateSchema, revision: integrationRevisionSchema,
  ownerEpoch: z.string().uuid(), createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(), cursor: z.string().max(1024).nullable(),
  counts: integrationJobCountsSchema,
  evidenceRef: z.string().max(256).nullable()
}).strict()
export type IntegrationSource = z.infer<typeof integrationSourceSchema>
export type ExecutionTarget = z.infer<typeof executionTargetSchema>
export type IntegrationAccount = z.infer<typeof integrationAccountSchema>
export type SyncPlan = z.infer<typeof syncPlanSchema>
export type IntegrationWorkInput = z.infer<typeof integrationWorkInputSchema>
export type IntegrationJob = z.infer<typeof integrationJobSchema>
export type IntegrationJobState = z.infer<typeof integrationJobStateSchema>
