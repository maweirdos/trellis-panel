import { z } from 'zod'

export const CREATION_MAX_BODY_BYTES = 256 * 1024
export const CREATION_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const CREATION_MAX_RECORD_BYTES = 16 * 1024 * 1024
export const CREATION_MAX_REVISIONS = 40
export const CREATION_MAX_COMMENTS = 120
export const CREATION_MAX_REPLIES = 240
export const CREATION_MAX_SCENARIOS = 40
export const CREATION_MAX_ADOPTIONS = 100

const uuid = z.string().uuid()
const id = z.string().min(1).max(256)
const serial = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const title = z.string().trim().min(1).max(200)
const note = z.string().trim().min(1).max(2000)
const unique = <T>(values: T[]): boolean => new Set(values).size === values.length
const personIds = z.array(id).max(32).refine(unique, 'Duplicate person identity')
const commentIds = z.array(uuid).max(40).refine(unique, 'Duplicate comment identity')
const encoder = new TextEncoder()
export const creationBodySchema = z.string().max(CREATION_MAX_BODY_BYTES).refine((value) => encoder.encode(value).length <= CREATION_MAX_BODY_BYTES, 'Body exceeds 256 KiB UTF-8')

export const creationScenarioSchema = z.object({
  id, title, preconditions: z.array(note).max(20), steps: z.array(note).min(1).max(30), expectedResult: note
}).strict()
const scenarios = z.array(creationScenarioSchema).max(CREATION_MAX_SCENARIOS).refine((items) => unique(items.map((item) => item.id)), 'Duplicate scenario identity')
const box = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }).strict()
  .refine((value) => value.x + value.width <= 1.000001 && value.y + value.height <= 1.000001, 'Box must fit normalized viewport')
const targetText = z.string().max(500).refine((value) => !/[<>\u0000-\u001f]/.test(value), 'Target must contain sanitized plain text')
const selector = z.string().min(1).max(500).refine((value) => !/[\u0000-\u001f]/.test(value), 'Selector must not contain controls')
const sensitiveField = /password|passwd|token|secret|authorization|cookie|credential|api[-_ ]?key/i
const contextField = z.object({ selector: selector.optional(), name: targetText.optional(), value: z.string().max(128).refine((value) => !/[<>\u0000-\u001f]/.test(value), 'Field value must be sanitized plain text') }).strict()
  .refine((value) => Boolean(value.selector || value.name) && !sensitiveField.test(`${value.selector ?? ''} ${value.name ?? ''}`), 'Sensitive fields cannot be retained')
const locationPart = z.string().max(300).refine((value) => !/[<>\u0000-\u001f]/.test(value) && !sensitiveField.test(value), 'Location must be sanitized and contain no credentials')
export const creationWebContextSchema = z.object({ route: locationPart.optional(), hash: locationPart.optional(),
  scroll: z.object({ x: z.number().min(0).max(10_000_000), y: z.number().min(0).max(10_000_000) }).strict().optional(),
  viewport: z.object({ width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384) }).strict().optional(),
  fields: z.array(contextField).max(12).optional() }).strict()
/** Opaque retained-image identifiers only; never image bytes, URLs, paths or markup. */
const screenshotRefs = z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)).max(4)
export const creationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('web'), stableId: targetText.optional(), selector: selector.optional(), role: targetText.optional(), name: targetText.optional(), text: targetText.optional(), box: box.optional(), state: z.enum(['default', 'hover', 'focus', 'disabled', 'expanded', 'selected']).optional(), context: creationWebContextSchema.optional(), screenshotRefs: screenshotRefs.optional() }).strict()
    .refine((value) => Boolean(value.stableId || value.selector || value.role || value.name || value.text || value.box), 'A web target needs an anchor'),
  z.object({ kind: z.literal('text'), start: z.number().int().nonnegative().max(CREATION_MAX_BODY_BYTES), end: z.number().int().nonnegative().max(CREATION_MAX_BODY_BYTES), quote: z.string().min(1).max(1000) }).strict().refine((value) => value.end > value.start, 'Invalid text range'),
  z.object({ kind: z.literal('scenario'), scenarioId: id }).strict(),
  z.object({ kind: z.literal('general') }).strict()
])

const command = { commandId: uuid, creationId: uuid, expectedRevision: serial.nullable(), expectedEpoch: uuid.optional() }
export const creationCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...command, action: z.literal('create'), title, kind: z.enum(['prototype', 'document']), home: z.enum(['personal', 'team']), spaceId: id.nullable(), editorIds: personIds.optional(), body: creationBodySchema, scenarios: scenarios.optional(), privateNotes: z.string().max(4000).optional() }).strict(),
  z.object({ ...command, action: z.literal('saveDraft'), body: creationBodySchema, title: title.optional(), scenarios: scenarios.optional(), privateNotes: z.string().max(4000).optional() }).strict(),
  z.object({ ...command, action: z.literal('publish'), spaceId: id, reviewerIds: personIds, editorIds: personIds.optional() }).strict(),
  z.object({ ...command, action: z.literal('annotate'), revisionId: uuid, target: creationTargetSchema, body: note, severity: z.enum(['required', 'suggestion', 'question']) }).strict(),
  z.object({ ...command, action: z.literal('reply'), commentId: uuid, body: note }).strict(),
  z.object({ ...command, action: z.literal('disposition'), commentId: uuid, status: z.enum(['open', 'confirmed', 'dismissed']), finalRule: note.optional(), reviewRevisionId: uuid.optional() }).strict(),
  z.object({ ...command, action: z.literal('candidateSave'), body: creationBodySchema, baseDraftRevision: serial, selectedCommentIds: commentIds, scenarios: scenarios.optional() }).strict(),
  z.object({ ...command, action: z.literal('candidateAdopt'), candidateId: uuid }).strict(),
  z.object({ ...command, action: z.literal('candidateDiscard'), candidateId: uuid }).strict(),
  z.object({ ...command, action: z.literal('adoptForTask'), taskId: id, revisionId: uuid, confirmedCommentIds: commentIds }).strict()
])
export type CreationCommand = z.infer<typeof creationCommandSchema>

export const creationRevisionMetadataSchema = z.object({ revisionId: uuid, number: serial, title, bodyDigest: digest, authorId: id, createdAt: time, reviewerIds: personIds }).strict()
const publishedRevision = creationRevisionMetadataSchema.extend({ body: creationBodySchema, scenarios }).strict()
const draft = z.object({ revisionId: uuid, serial, body: creationBodySchema, bodyDigest: digest, scenarios, updatedAt: time }).strict()
const candidate = z.object({ candidateId: uuid, baseDraftRevision: serial, selectedCommentIds: commentIds, body: creationBodySchema, bodyDigest: digest, scenarios, createdAt: time }).strict()
const reply = z.object({ replyId: uuid, authorId: id, body: note, createdAt: time }).strict()
export const creationCommentSchema = z.object({ commentId: uuid, revisionId: uuid, authorId: id, private: z.boolean(), target: creationTargetSchema, body: note,
  severity: z.enum(['required', 'suggestion', 'question']), status: z.enum(['open', 'confirmed', 'dismissed']), finalRule: note.nullable(), reviewedRevisionId: uuid.nullable().default(null), dispositionBy: id.nullable(), dispositionAt: time.nullable(), reviewSerial: serial,
  replies: z.array(reply).max(12), createdAt: time }).strict()
const rule = z.object({ commentId: uuid, finalRule: note, originRevisionId: uuid.optional(), sourceRevisionId: uuid.optional(), reviewedRevisionId: uuid.optional(), target: creationTargetSchema.optional(), originalBody: note.optional() }).strict()
export const creationAdoptionSchema = z.object({ adoptionId: uuid, taskId: id, revisionId: uuid, revisionNumber: serial, bodyDigest: digest, title, reviewWatermark: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), confirmedRules: z.array(rule).max(40), adoptedBy: id, adoptedAt: time }).strict()

/** Internal persistence only. Never serialize this record into a list, receipt or workspace snapshot. */
export const creationRecordSchema = z.object({
  creationId: uuid, projectId: id, ownerId: id, title, kind: z.enum(['prototype', 'document']), home: z.enum(['personal', 'team']), spaceId: id.nullable(),
  editorIds: personIds, revision: serial, draft, privateNotes: z.string().max(4000), candidate: candidate.nullable(),
  revisions: z.array(publishedRevision).max(CREATION_MAX_REVISIONS), comments: z.array(creationCommentSchema).max(CREATION_MAX_COMMENTS),
  adoptions: z.array(creationAdoptionSchema).max(CREATION_MAX_ADOPTIONS), reviewSerial: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), createdAt: time, updatedAt: time
}).strict()
export type CreationRecord = z.infer<typeof creationRecordSchema>
export type CreationAdoption = z.infer<typeof creationAdoptionSchema>
export type CreationComment = z.infer<typeof creationCommentSchema>
export type CreationScenario = z.infer<typeof creationScenarioSchema>

export const creationSummarySchema = z.object({
  creationId: uuid, projectId: id, ownerId: id, title, kind: z.enum(['prototype', 'document']), home: z.enum(['personal', 'team']), spaceId: id.nullable(), revision: serial,
  latestPublished: creationRevisionMetadataSchema.nullable(), adoptions: z.array(creationAdoptionSchema).max(CREATION_MAX_ADOPTIONS),
  canEdit: z.boolean(), canReview: z.boolean(), canManageReview: z.boolean(), createdAt: time, updatedAt: time
}).strict()
export type CreationSummary = z.infer<typeof creationSummarySchema>
export const creationHeadSchema = z.object({ projectId: id, epoch: uuid, fingerprint: digest }).strict()
export type CreationHead = z.infer<typeof creationHeadSchema>
export const creationViewInputSchema = z.object({ revisionId: uuid.optional(), commentOffset: z.coerce.number().int().min(0).max(CREATION_MAX_COMMENTS).default(0), commentLimit: z.coerce.number().int().min(1).max(20).default(20) }).strict()
export const creationViewSchema = z.object({
  summary: creationSummarySchema,
  selected: z.object({ revisionId: uuid, number: serial.nullable(), title, body: creationBodySchema, bodyDigest: digest, scenarios, published: z.boolean() }).strict(),
  revisions: z.array(creationRevisionMetadataSchema).max(CREATION_MAX_REVISIONS), comments: z.array(creationCommentSchema).max(20),
  commentOffset: z.number().int().nonnegative(), nextCommentOffset: z.number().int().nonnegative().nullable(),
  privateNotes: z.string().max(4000).optional(), draft: draft.omit({ body: true, scenarios: true }).optional(), candidate: candidate.omit({ body: true, scenarios: true }).optional()
}).strict()
export type CreationView = z.infer<typeof creationViewSchema>
export const creationListInputSchema = z.object({ scope: z.enum(['personal', 'team']).default('personal'), spaceId: id.optional(), taskId: id.optional(), cursor: z.string().max(4096).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict()
export const creationListSchema = z.object({ items: z.array(creationSummarySchema).max(50), hasMore: z.boolean(), nextCursor: z.string().max(4096).nullable() }).strict()
/** Receipts intentionally carry no draft, candidate, note, comment body or title. */
export const creationCommandResultSchema = z.object({ projectId: id, creationId: uuid, epoch: uuid.optional(), revision: serial, action: z.enum(['create', 'saveDraft', 'publish', 'annotate', 'reply', 'disposition', 'candidateSave', 'candidateAdopt', 'candidateDiscard', 'adoptForTask']),
  scopeSpaceIds: z.array(id).max(4), scopeTaskIds: z.array(id).max(2), scopePersonIds: z.array(id).max(64).default([]), private: z.boolean(), revisionId: uuid.optional(), reviewRevisionId: uuid.optional(), commentId: uuid.optional(), candidateId: uuid.optional(), adoptionId: uuid.optional() }).strict()
export type CreationCommandResult = z.infer<typeof creationCommandResultSchema>
export const creationCommandReplySchema = z.object({ status: z.enum(['committed', 'duplicate']), commandId: uuid, result: creationCommandResultSchema }).strict()
export type CreationCommandReply = z.infer<typeof creationCommandReplySchema>

/** Trusted adapters derive these grants from the current authenticated source. No Node/Electron dependency. */
export type CreationActorContext = {
  projectId: string; actorId: string; now: number; activeMemberIds: string[]; epoch?: string
  spaces: Array<{ id: string; archived: boolean; canRead: boolean; canWrite: boolean; memberIds: string[] }>
  tasks: Array<{ id: string; spaceId: string }>
  digestBody(body: string): string
}
