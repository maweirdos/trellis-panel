import { z } from 'zod'
import { publicationInputSchema, teamCommandIdSchema, teamCommandReplySchema, teamDigestSchema, teamIdSchema, teamPageInputSchema, teamPageSchema } from './team-platform'
import { teamTaskProgressResourceIdSchema } from './team-task-progress'
import { taskOutputOriginSchema, taskOutputVersionOriginSchema } from './task-output-origin'

const counter = z.number().int().nonnegative().safe()
const serial = counter.min(1)
const people = z.array(teamIdSchema).min(1).max(32).refine((ids) => new Set(ids).size === ids.length, 'Duplicate person')
export const teamTaskMaterialKindSchema = z.enum(['prd', 'design', 'implement', 'delivery-note'])
/** Fixed business templates. These describe document content, never task transition gates. */
export const TEAM_TASK_MATERIAL_TEMPLATES = {
  prd: { version: 1, sections: ['Target users', 'Current evidence', 'Business flows', 'Fields and rules', 'Page states', 'Exceptions', 'Acceptance', 'Open questions'] },
  design: { version: 1, sections: ['Approach', 'Interface states', 'Data and API impact', 'Risks'] },
  implement: { version: 1, sections: ['Scope', 'Implementation steps', 'Validation', 'Risks'] },
  'delivery-note': { version: 1, sections: ['Delivered', 'Not delivered', 'Where to try', 'How to verify', 'Remaining risks'] }
} as const
export const teamTaskMaterialTemplateSchema = z.object({ templateId: teamTaskMaterialKindSchema, version: z.literal(1) }).strict()
export const teamTaskMaterialScopeSchema = z.object({ spaceId: teamTaskProgressResourceIdSchema, taskCreatedAt: z.string().min(1).max(100) }).strict()
export const teamTaskMaterialReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('material'), materialId: teamIdSchema, version: serial, bodyDigest: teamDigestSchema }).strict(),
  z.object({ kind: z.literal('creation'), creationId: teamIdSchema, revisionId: teamIdSchema, bodyDigest: teamDigestSchema }).strict()
])
const references = z.array(teamTaskMaterialReferenceSchema).max(16)
const title = z.string().trim().min(1).max(300)
const content = { title, text: publicationInputSchema.shape.text, expectedDigest: teamDigestSchema, references, origin: taskOutputOriginSchema.optional() }
const envelope = { ...teamTaskMaterialScopeSchema.shape, commandId: teamCommandIdSchema, expectedEpoch: teamIdSchema }
const existing = { ...envelope, documentId: teamIdSchema }
export const teamTaskMaterialCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...envelope, action: z.literal('create'), kind: teamTaskMaterialKindSchema, editorIds: people, approverIds: people, ...content }).strict(),
  z.object({ ...existing, action: z.literal('saveDraft'), expectedDraftRevision: serial, ...content }).strict(),
  z.object({ ...existing, action: z.literal('setAccess'), expectedRevision: serial, editorIds: people, approverIds: people }).strict(),
  z.object({ ...existing, action: z.literal('submit'), expectedRevision: serial, expectedDraftRevision: serial, versionId: teamIdSchema, bodyDigest: teamDigestSchema }).strict(),
  z.object({ ...existing, action: z.literal('approve'), expectedRevision: serial, submissionId: teamIdSchema, bodyDigest: teamDigestSchema }).strict(),
  z.object({ ...existing, action: z.literal('reject'), expectedRevision: serial, submissionId: teamIdSchema, bodyDigest: teamDigestSchema, reason: z.string().trim().min(1).max(2000) }).strict()
])
const scope = { projectId: teamIdSchema, taskId: teamTaskProgressResourceIdSchema, ...teamTaskMaterialScopeSchema.shape }
export const teamTaskMaterialVersionSchema = z.object({
  versionId: teamIdSchema, documentId: teamIdSchema, number: serial, title,
  bodyDigest: teamDigestSchema, byteLength: serial.max(1024 * 1024), references,
  disposition: z.enum(['draft', 'conflict']), baseDraftRevision: counter,
  authorId: teamIdSchema, createdAt: counter, origin: taskOutputVersionOriginSchema.optional()
}).strict()
export const teamTaskMaterialSubmissionSchema = z.object({
  submissionId: teamIdSchema, documentId: teamIdSchema, versionId: teamIdSchema, bodyDigest: teamDigestSchema,
  submittedBy: teamIdSchema, submittedAt: counter, status: z.enum(['pending', 'approved', 'rejected']),
  decidedBy: teamIdSchema.nullable(), decidedAt: counter.nullable(), reason: z.string().max(2000).nullable()
}).strict()
export const teamTaskMaterialMetadataSchema = z.object({
  ...scope, documentId: teamIdSchema, kind: teamTaskMaterialKindSchema, template: teamTaskMaterialTemplateSchema,
  ownerId: teamIdSchema, editorIds: people, approverIds: people, revision: serial, draftRevision: serial,
  draft: teamTaskMaterialVersionSchema, latestSubmission: teamTaskMaterialSubmissionSchema.nullable(),
  approved: teamTaskMaterialSubmissionSchema.nullable(), createdAt: counter, updatedAt: counter
}).strict()
const identity = { instanceId: teamIdSchema, epoch: teamIdSchema, authorizationRevision: counter }
export const teamTaskMaterialListInputSchema = teamPageInputSchema.extend(teamTaskMaterialScopeSchema.shape).strict()
export const teamTaskMaterialListSchema = z.object({ ...identity, ...scope, page: teamPageSchema(teamTaskMaterialMetadataSchema) }).strict()
export const teamTaskMaterialReadInputSchema = teamTaskMaterialScopeSchema.extend({ versionId: teamIdSchema.optional() }).strict()
export const teamTaskMaterialViewSchema = z.object({ ...identity, document: teamTaskMaterialMetadataSchema, selected: teamTaskMaterialVersionSchema, text: publicationInputSchema.shape.text }).strict()
export const teamTaskMaterialHistorySchema = z.object({ ...identity, page: teamPageSchema(teamTaskMaterialVersionSchema) }).strict()
export const teamTaskMaterialSubmissionsSchema = z.object({ ...identity, page: teamPageSchema(teamTaskMaterialSubmissionSchema) }).strict()
/** Historical acknowledgement only. It cannot authorize reading a body or advance a task. */
export const teamTaskMaterialReceiptSchema = z.object({
  ...identity, ...scope, commandId: teamCommandIdSchema, action: teamTaskMaterialCommandSchema.options[0].shape.action.or(z.enum(['saveDraft', 'setAccess', 'submit', 'approve', 'reject'])),
  documentId: teamIdSchema, revision: serial, draftRevision: serial,
  versionId: teamIdSchema.nullable(), submissionId: teamIdSchema.nullable(), outcome: z.enum(['applied', 'conflict-preserved']),
  actorId: teamIdSchema, deviceId: teamIdSchema.nullable(), committedAt: counter
}).strict()
export const teamTaskMaterialCommandReplySchema = teamCommandReplySchema(teamTaskMaterialReceiptSchema)
export type TeamTaskMaterialKind = z.infer<typeof teamTaskMaterialKindSchema>
export type TeamTaskMaterialScope = z.infer<typeof teamTaskMaterialScopeSchema>
export type TeamTaskMaterialCommand = z.infer<typeof teamTaskMaterialCommandSchema>
export type TeamTaskMaterialReference = z.infer<typeof teamTaskMaterialReferenceSchema>
export type TeamTaskMaterialVersion = z.infer<typeof teamTaskMaterialVersionSchema>
export type TeamTaskMaterialSubmission = z.infer<typeof teamTaskMaterialSubmissionSchema>
export type TeamTaskMaterialMetadata = z.infer<typeof teamTaskMaterialMetadataSchema>
export type TeamTaskMaterialReceipt = z.infer<typeof teamTaskMaterialReceiptSchema>
export type TeamTaskMaterialCommandReply = z.infer<typeof teamTaskMaterialCommandReplySchema>
export type TeamTaskMaterialList = z.infer<typeof teamTaskMaterialListSchema>
export type TeamTaskMaterialView = z.infer<typeof teamTaskMaterialViewSchema>
