import { z } from 'zod'
import { teamCommandIdSchema, teamIdSchema } from './team-platform'

export const TEAM_CONTENT_MAX_TEXT_BYTES = 32 * 1024
export const TEAM_CONTENT_MAX_OUTPUT_BYTES = 128 * 1024
export const teamContentScopeIdSchema = z.string().min(1).max(200)
const count = z.number().int().nonnegative().safe()
const revision = z.number().int().nonnegative().safe()
export const teamContentKindSchema = z.enum(['requirements', 'summary', 'test-package'])
export const teamContentLimitsSchema = z.object({
  teamConcurrency: z.number().int().min(1).max(16), memberConcurrency: z.number().int().min(1).max(8),
  teamDailyRequests: z.number().int().min(1).max(10_000), memberDailyRequests: z.number().int().min(1).max(1000),
  teamDailyTokens: z.number().int().min(1024).max(1_000_000_000), memberDailyTokens: z.number().int().min(1024).max(100_000_000),
  inputTokenLimit: z.number().int().min(512).max(131_072), outputTokenLimit: z.number().int().min(16).max(16_384),
  timeoutMs: z.number().int().min(100).max(60_000)
}).strict()
export const teamContentHealthSchema = z.object({
  state: z.enum(['unverified', 'ready', 'degraded']), checkedAt: count.nullable(),
  code: z.string().max(80).nullable(), consecutiveFailures: count
}).strict()
export const teamContentConfigSchema = z.object({
  teamId: teamIdSchema, revision, provider: z.literal('openai-compatible'), endpoint: z.string().url().max(2048),
  model: z.string().min(1).max(200), enabled: z.boolean(), capabilities: z.array(teamContentKindSchema).min(1).max(3),
  hasCredential: z.boolean(), credentialProtectionAvailable: z.boolean(), limits: teamContentLimitsSchema,
  health: teamContentHealthSchema, updatedAt: count
}).strict()
export const teamContentConfigureSchema = z.object({
  commandId: teamCommandIdSchema, expectedEpoch: teamIdSchema, expectedRevision: revision,
  provider: z.literal('openai-compatible'), endpoint: z.string().url().max(2048), model: z.string().trim().min(1).max(200),
  enabled: z.boolean(), capabilities: z.array(teamContentKindSchema).min(1).max(3), limits: teamContentLimitsSchema,
  apiKey: z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/).optional()
}).strict().refine((v) => new Set(v.capabilities).size === v.capabilities.length, 'Duplicate capability')
export const teamContentGenerateSchema = z.object({
  commandId: teamCommandIdSchema, expectedEpoch: teamIdSchema,
  expectedSpaceId: teamContentScopeIdSchema, expectedTaskCreatedAt: z.string().min(1).max(100),
  expectedTaskUpdatedAt: z.string().min(1).max(100), kind: teamContentKindSchema,
  text: z.string().max(TEAM_CONTENT_MAX_TEXT_BYTES).default(''),
  references: z.array(z.object({ documentId: teamIdSchema, versionId: z.string().regex(/^[1-9][0-9]{0,8}$/) }).strict()).max(8).optional()
}).strict()
export const teamContentProbeSchema = z.object({
  commandId: teamCommandIdSchema, expectedEpoch: teamIdSchema, expectedConfigRevision: revision
}).strict()
export const teamContentCancelSchema = z.object({ commandId: teamCommandIdSchema, expectedEpoch: teamIdSchema }).strict()
export const teamContentUsageSchema = z.object({
  source: z.enum(['provider', 'administrator-reconciliation']), inputTokens: count, outputTokens: count,
  cachedInputTokens: count.nullable()
}).strict().refine((v) => v.cachedInputTokens === null || v.cachedInputTokens <= v.inputTokens, 'Cached input exceeds input usage')
export const teamContentSourceSchema = z.object({
  kind: z.enum(['task-snapshot', 'explicit-text', 'probe', 'published-material', 'governance-rule']), sourceId: z.string().min(1).max(250),
  digest: z.string().regex(/^[a-f0-9]{64}$/), byteLength: count, capturedAt: count,
  taskCreatedAt: z.string().max(100).nullable(), taskUpdatedAt: z.string().max(100).nullable(),
  title: z.string().min(1).max(300).optional(), versionNumber: z.number().int().positive().safe().optional()
}).strict()
export const teamContentJobSchema = z.object({
  jobId: teamIdSchema, commandId: teamCommandIdSchema, instanceId: teamIdSchema, epoch: teamIdSchema,
  teamId: teamIdSchema, projectId: teamIdSchema.nullable(), taskId: teamContentScopeIdSchema.nullable(),
  spaceId: teamContentScopeIdSchema.nullable(), taskCreatedAt: z.string().max(100).nullable(),
  ownerId: teamIdSchema, deviceId: teamIdSchema.nullable(), kind: z.enum(['requirements', 'summary', 'test-package', 'probe']),
  state: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'unknown']), revision,
  configRevision: revision, model: z.string().max(200), templateVersion: z.literal('team-content-v1'),
  sources: z.array(teamContentSourceSchema).max(74), evidenceCoverage: z.enum(['task-and-explicit-text-only', 'task-explicit-and-published-materials', 'task-explicit-and-governance-rules', 'task-explicit-published-materials-and-governance-rules']),
  missingEvidence: z.array(z.enum(['repository', 'deployed-capabilities', 'published-materials'])).max(3),
  estimatedInputTokens: count, declaredInputTokenLimit: count, declaredOutputTokenLimit: count,
  reservedTokens: count, reservation: z.enum(['held', 'settled', 'released']), slotHeld: z.boolean(),
  usage: teamContentUsageSchema.nullable(), cost: z.null(), costStatus: z.literal('unknown'),
  limitExceeded: z.boolean(), candidate: z.object({ body: z.string().max(TEAM_CONTENT_MAX_OUTPUT_BYTES), digest: z.string().regex(/^[a-f0-9]{64}$/), published: z.literal(false) }).strict().nullable(),
  errorCode: z.string().max(80).nullable(), cancelRequested: z.boolean(),
  reconciliation: z.object({ actorId: teamIdSchema, evidence: z.string().min(1).max(2000), at: count }).strict().nullable(),
  createdAt: count, updatedAt: count, startedAt: count.nullable(), finishedAt: count.nullable()
}).strict()
export const teamContentJobReplySchema = z.object({ status: z.enum(['accepted', 'duplicate']), job: teamContentJobSchema }).strict()
export const teamContentBudgetScopeSchema = z.object({
  requests: count, activeSlots: count, reservedTokens: count,
  measuredInputTokens: count, measuredOutputTokens: count, measuredCachedInputTokens: count,
  unknownUsageJobs: count, unknownCacheUsageJobs: count
}).strict()
export const teamContentBudgetSchema = z.object({
  teamId: teamIdSchema, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memberId: teamIdSchema,
  team: teamContentBudgetScopeSchema, member: teamContentBudgetScopeSchema,
  limits: teamContentLimitsSchema.nullable(), cost: z.null(), costStatus: z.literal('unknown'), serverTime: count
}).strict()
export const teamContentReadinessSchema = z.object({
  instanceId: teamIdSchema, epoch: teamIdSchema, teamId: teamIdSchema, projectId: teamIdSchema,
  status: z.enum(['unconfigured', 'disabled', 'protection-unavailable', 'unverified', 'ready', 'degraded']),
  administratorActionRequired: z.boolean(), canManage: z.boolean(), model: z.string().max(200).nullable(),
  capabilities: z.array(teamContentKindSchema).max(3), templateVersion: z.literal('team-content-v1'),
  health: teamContentHealthSchema.nullable(), manualWorkAvailable: z.literal(true),
  evidenceCoverage: z.literal('task-and-explicit-text-only'), serverTime: count
}).strict()
export const teamContentReconcileSchema = z.object({
  commandId: teamCommandIdSchema, expectedEpoch: teamIdSchema, expectedRevision: revision,
  outcome: z.enum(['completed', 'not-started']), evidence: z.string().trim().min(1).max(2000),
  usage: teamContentUsageSchema.nullable()
}).strict().refine((v) => v.outcome === 'not-started' ? v.usage === null : v.usage?.source === 'administrator-reconciliation', 'Completed reconciliation requires explicit administrator usage')

export type TeamContentKind = z.infer<typeof teamContentKindSchema>
export type TeamContentConfig = z.infer<typeof teamContentConfigSchema>
export type TeamContentGenerate = z.infer<typeof teamContentGenerateSchema>
export type TeamContentJob = z.infer<typeof teamContentJobSchema>
export type TeamContentJobReply = z.infer<typeof teamContentJobReplySchema>
export type TeamContentUsage = z.infer<typeof teamContentUsageSchema>
export type TeamContentSource = z.infer<typeof teamContentSourceSchema>
export type TeamContentBudget = z.infer<typeof teamContentBudgetSchema>
export type TeamContentReadiness = z.infer<typeof teamContentReadinessSchema>
