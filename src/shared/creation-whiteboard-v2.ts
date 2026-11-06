import { z } from 'zod'
import { CREATION_MAX_COMMENTS, CREATION_MAX_REVISIONS, creationCommandSchema, creationRecordSchema, creationRevisionMetadataSchema, creationSummarySchema, creationViewSchema } from './creations'
import { whiteboardDocumentSchema } from './creation-whiteboard'

export const whiteboardV2CapabilitiesSchema = z.object({
  version: z.literal(2), kind: z.literal('whiteboard'), scope: z.literal('local'), read: z.boolean(),
  create: z.boolean(), save: z.boolean(), publish: z.boolean(), review: z.boolean(), recover: z.boolean(),
  teamSharing: z.literal(false), taskAdoption: z.literal(false)
}).strict()
export const WHITEBOARD_V2_CAPABILITIES = Object.freeze(whiteboardV2CapabilitiesSchema.parse({
  version: 2, kind: 'whiteboard', scope: 'local', read: true, create: true, save: true,
  publish: true, review: true, recover: true, teamSharing: false, taskAdoption: false
}))
export type WhiteboardV2Capabilities = z.infer<typeof whiteboardV2CapabilitiesSchema>

function isWhiteboardBody(body: string): boolean {
  try { return whiteboardDocumentSchema.safeParse(JSON.parse(body)).success } catch { return false }
}
const body = creationCommandSchema.options[1].shape.body.refine(isWhiteboardBody, 'Invalid whiteboard document')

/** Internal, source-bound intent; no legacy IPC accepts this union. */
export const whiteboardV2CommandSchema = z.discriminatedUnion('action', [
  creationCommandSchema.options[0].extend({ kind: z.literal('whiteboard'), home: z.literal('personal'), spaceId: z.null(), body }).strict(),
  creationCommandSchema.options[1].extend({ body }).strict(),
  creationCommandSchema.options[2],
  creationCommandSchema.options[3].extend({ target: z.object({ kind: z.literal('general') }).strict() }).strict(),
  creationCommandSchema.options[4],
  creationCommandSchema.options[5]
]).superRefine((command, context) => {
  if (((command.action === 'create' || command.action === 'saveDraft') && command.scenarios?.length) ||
    ((command.action === 'create' || command.action === 'publish') && command.editorIds?.length)) {
    context.addIssue({ code: 'custom', message: 'Whiteboards do not support scenarios or editor grants' })
  }
})
export type WhiteboardV2Command = z.infer<typeof whiteboardV2CommandSchema>

/** Independent v2 persistence shape; the legacy record schema remains unchanged. */
export const whiteboardV2RecordSchema = creationRecordSchema.extend({ kind: z.literal('whiteboard') }).superRefine((record, context) => {
  const bodies = [record.draft, ...record.revisions, ...(record.candidate ? [record.candidate] : [])]
  if (bodies.some((entry) => !isWhiteboardBody(entry.body) || entry.scenarios.length > 0)) {
    context.addIssue({ code: 'custom', message: 'Invalid whiteboard body or scenarios' })
  }
  if (record.candidate || record.adoptions.length || record.comments.some((entry) => entry.target.kind !== 'general')) {
    context.addIssue({ code: 'custom', message: 'Whiteboard candidates and anchored opinions are unsupported' })
  }
})
export type WhiteboardV2Record = z.infer<typeof whiteboardV2RecordSchema>

/** Metadata index never contains bodies, private notes, source clues or receipts. */
export const whiteboardV2ReadMetadataSchema = creationRecordSchema.pick({
  creationId: true, projectId: true, ownerId: true, title: true, home: true, spaceId: true, editorIds: true,
  revision: true, draft: true, revisions: true, comments: true, adoptions: true, createdAt: true, updatedAt: true
}).extend({
  kind: z.literal('whiteboard'), home: z.literal('personal'),
  draft: creationRecordSchema.shape.draft.omit({ body: true, scenarios: true }),
  revisions: z.array(creationRevisionMetadataSchema).max(CREATION_MAX_REVISIONS),
  adoptions: z.array(creationRecordSchema.shape.adoptions.element).max(0)
}).strict()
export const whiteboardV2SummaryBasisSchema = whiteboardV2ReadMetadataSchema.omit({ draft: true, comments: true }).strict()
export type WhiteboardV2ReadMetadata = z.infer<typeof whiteboardV2ReadMetadataSchema>
export type WhiteboardV2SummaryBasis = z.infer<typeof whiteboardV2SummaryBasisSchema>
export const whiteboardV2SummarySchema = creationSummarySchema.extend({ kind: z.literal('whiteboard'), home: z.literal('personal'), adoptions: z.array(creationRecordSchema.shape.adoptions.element).max(0) }).strict()
export type WhiteboardV2Summary = z.infer<typeof whiteboardV2SummarySchema>
/** List items are owner-authorized and identify the exact current draft. */
export const whiteboardV2ListItemSchema = whiteboardV2SummarySchema.extend({ draftRevisionId: z.string().uuid() }).strict()
export const whiteboardV2ListInputSchema = z.object({ sort: z.enum(['updated', 'name']).default('updated'), cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict()
export const whiteboardV2ListSchema = z.object({ items: z.array(whiteboardV2ListItemSchema).max(50), hasMore: z.boolean(), nextCursor: z.string().max(4096).nullable() }).strict()
export type WhiteboardV2List = z.infer<typeof whiteboardV2ListSchema>
export const whiteboardV2ViewInputSchema = z.object({ revisionId: z.string().uuid(), commentOffset: z.number().int().min(0).max(CREATION_MAX_COMMENTS).default(0), commentLimit: z.number().int().min(1).max(20).default(20) }).strict()
export const whiteboardV2ViewSchema = creationViewSchema.omit({ privateNotes: true, privateSource: true, draft: true, candidate: true }).extend({ summary: whiteboardV2SummarySchema }).strict()
export type WhiteboardV2View = z.infer<typeof whiteboardV2ViewSchema>
