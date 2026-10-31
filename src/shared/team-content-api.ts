import { z } from 'zod'
import { teamCommandIdSchema, teamIdSchema } from './team-platform'
import {
  TEAM_CONTENT_MAX_TEXT_BYTES, teamContentConfigureSchema, teamContentGenerateSchema,
  teamContentKindSchema, teamContentScopeIdSchema,
  type TeamContentConfig, type TeamContentJob, type TeamContentJobReply, type TeamContentReadiness
} from './team-content'

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string; outcomeUnknown?: boolean }
export type TeamContentConfigure = z.infer<typeof teamContentConfigureSchema>
export const teamContentScopeSchema = z.object({ workspaceKey: z.string().min(1).max(2048) }).strict()
export const teamContentGenerateInputSchema = teamContentScopeSchema.extend({
  taskId: teamContentScopeIdSchema, spaceId: teamContentScopeIdSchema,
  taskCreatedAt: z.string().min(1).max(100), expectedTaskUpdatedAt: z.string().min(1).max(100),
  kind: teamContentKindSchema, commandId: teamCommandIdSchema,
  text: z.string().max(TEAM_CONTENT_MAX_TEXT_BYTES).refine(text => new TextEncoder().encode(text).byteLength <= TEAM_CONTENT_MAX_TEXT_BYTES, 'Content exceeds the UTF-8 input limit'),
  references: teamContentGenerateSchema.shape.references
}).strict()
export const teamContentJobInputSchema = teamContentScopeSchema.extend({ taskId: teamContentScopeIdSchema, jobId: teamIdSchema }).strict()
export const teamContentReceiptInputSchema = teamContentScopeSchema.extend({ taskId: teamContentScopeIdSchema, commandId: teamCommandIdSchema }).strict()
export const teamContentCancelInputSchema = teamContentJobInputSchema.extend({ commandId: teamCommandIdSchema }).strict()
export const teamContentReferencesInputSchema = teamContentScopeSchema.extend({ cursor: z.string().min(1).max(2048).optional() }).strict()
export const teamContentAdminInputSchema = teamContentScopeSchema.extend({ teamId: teamIdSchema }).strict()
const { expectedEpoch: _expectedEpoch, ...configureFields } = teamContentConfigureSchema.shape
const configureInput = z.object(configureFields).strict().refine(value => new Set(value.capabilities).size === value.capabilities.length, 'Duplicate capability')
export const teamContentConfigureInputSchema = teamContentAdminInputSchema.extend({ input: configureInput }).strict()
export const teamContentProbeInputSchema = teamContentAdminInputSchema.extend({ commandId: teamCommandIdSchema, expectedConfigRevision: z.number().int().nonnegative().safe() }).strict()
export const teamContentApiInputSchemas = {
  readiness: teamContentScopeSchema, generate: teamContentGenerateInputSchema, job: teamContentJobInputSchema,
  receipt: teamContentReceiptInputSchema, cancel: teamContentCancelInputSchema, listReferences: teamContentReferencesInputSchema,
  config: teamContentAdminInputSchema, configure: teamContentConfigureInputSchema, probe: teamContentProbeInputSchema
}
export const teamContentReferencesSchema = z.object({
  items: z.array(z.object({ documentId: teamIdSchema, versionId: z.string().regex(/^[1-9][0-9]{0,8}$/), title: z.string().min(1).max(300), digest: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().positive() }).strict()).max(100),
  nextCursor: z.string().min(1).max(2048).optional(), hasMore: z.boolean()
}).strict()
export type TeamContentReferences = z.infer<typeof teamContentReferencesSchema>
export interface TeamContentApi {
  readiness(input: z.input<typeof teamContentScopeSchema>): Promise<Result<TeamContentReadiness>>
  generate(input: z.input<typeof teamContentGenerateInputSchema>): Promise<Result<TeamContentJobReply>>
  job(input: z.input<typeof teamContentJobInputSchema>): Promise<Result<TeamContentJob>>
  /** null means not observed at this read, not that an in-flight command cannot commit. */
  receipt(input: z.input<typeof teamContentReceiptInputSchema>): Promise<Result<TeamContentJob | null>>
  cancel(input: z.input<typeof teamContentCancelInputSchema>): Promise<Result<TeamContentJob>>
  listReferences(input: z.input<typeof teamContentReferencesInputSchema>): Promise<Result<TeamContentReferences>>
  config(input: z.input<typeof teamContentAdminInputSchema>): Promise<Result<TeamContentConfig | null>>
  configure(input: z.input<typeof teamContentConfigureInputSchema>): Promise<Result<TeamContentConfig>>
  probe(input: z.input<typeof teamContentProbeInputSchema>): Promise<Result<TeamContentJobReply>>
}
