/** Version-pinned collaboration. Reported native execution is not verified execution. */
import { z } from 'zod'
import { teamCommandIdSchema, teamDigestSchema, teamIdSchema, teamOpaqueIdSchema, teamPageInputSchema, teamRoleSchema } from './team-platform'

const time = z.number().int().nonnegative().safe()
const revision = z.number().int().positive().safe()
const content = z.string().trim().min(1).max(20_000).refine((value) => {
  for (let index = 0; index < value.length; index++) {
    const c = value.charCodeAt(index)
    if (c >= 0xd800 && c <= 0xdbff) { const n = value.charCodeAt(++index); if (!(n >= 0xdc00 && n <= 0xdfff)) return false }
    else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}, 'Expected well-formed Unicode')
const ids = z.array(teamIdSchema).min(1).max(50).refine((v) => new Set(v).size === v.length, 'Duplicate identity')
export const collaborationVersionRefSchema = z.object({ materialId: teamIdSchema, version: revision, bodyDigest: teamDigestSchema }).strict()
export const collaborationSelectionSchema = collaborationVersionRefSchema.extend({ feedbackId: teamIdSchema }).strict()
export const collaborationAnchorSchema = z.object({ start: z.number().int().nonnegative().safe(), end: z.number().int().nonnegative().safe() }).strict().refine((v) => v.end > v.start)
export const collaborationKindSchema = z.enum(['discussion', 'notice', 'decision', 'batch'])
export const collaborationActorSchema = z.object({ userId: teamIdSchema, displayName: z.string().max(200), roles: z.array(teamRoleSchema), authentication: z.enum(['session', 'device']), deviceId: teamIdSchema.nullable(), recordedAt: time }).strict()
const create = { commandId: teamCommandIdSchema, entityId: teamIdSchema, expectedRevision: z.null(), materialId: teamIdSchema, version: revision }
const update = { commandId: teamCommandIdSchema, entityId: teamIdSchema, expectedRevision: revision }
const option = z.object({ optionId: teamOpaqueIdSchema, label: content }).strict()
export const collaborationCheckSchema = z.object({ name: z.string().trim().min(1).max(300), result: z.enum(['passed', 'failed', 'not-run']), evidence: content }).strict()
export const collaborationReportSchema = z.object({
  reportId: teamIdSchema, phase: z.enum(['delivery', 'application', 'verification']), manifestDigest: teamDigestSchema,
  taskRef: teamOpaqueIdSchema, runRef: teamOpaqueIdSchema, revisionRef: teamOpaqueIdSchema, inputDigest: teamDigestSchema,
  turnRef: teamOpaqueIdSchema.nullable(), outputs: z.array(collaborationVersionRefSchema).max(30),
  checks: z.array(collaborationCheckSchema).max(30), note: content
}).strict()
export const collaborationCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...create, action: z.literal('discussion.create'), feedbackId: teamIdSchema }).strict(),
  z.object({ ...update, action: z.literal('discussion.reply'), replyId: teamIdSchema, parentReplyId: teamIdSchema.nullable(), body: content }).strict(),
  z.object({ ...update, action: z.literal('discussion.relocate'), target: collaborationVersionRefSchema, quote: z.string().min(1).max(4000), anchor: collaborationAnchorSchema, reason: content }).strict(),
  z.object({ ...create, action: z.literal('notice.create'), recipientIds: ids, message: content }).strict(),
  z.object({ ...update, action: z.literal('notice.acknowledge') }).strict(),
  z.object({ ...update, action: z.literal('notice.cancel'), reason: content }).strict(),
  z.object({ ...create, action: z.literal('decision.create'), question: content, options: z.array(option).min(2).max(8), recommendation: teamOpaqueIdSchema.nullable(), ownerId: teamIdSchema, coordinatorIds: ids, impact: z.array(z.string().trim().min(1).max(1000)).min(1).max(30), dueAt: time }).strict(),
  z.object({ ...update, action: z.literal('decision.answer'), optionId: teamOpaqueIdSchema, rationale: content }).strict(),
  z.object({ ...update, action: z.literal('decision.coordinate'), ownerId: teamIdSchema, coordinatorIds: ids, dueAt: time, note: content, reopen: z.boolean() }).strict(),
  z.object({ ...create, action: z.literal('batch.create'), selections: z.array(collaborationSelectionSchema).min(1).max(50), baselines: z.array(collaborationVersionRefSchema).max(30), assigneeId: teamIdSchema, timing: z.enum(['boundary', 'now', 'after-run']), rationale: content }).strict(),
  z.object({ ...update, action: z.literal('batch.report'), report: collaborationReportSchema }).strict(),
  z.object({ ...update, action: z.literal('batch.resolve'), verificationReportId: teamIdSchema, rationale: content }).strict(),
  z.object({ ...update, action: z.literal('batch.reopen'), reason: content }).strict(),
  z.object({ ...update, action: z.literal('batch.cancel'), reason: content }).strict(),
  z.object({ ...update, action: z.literal('batch.disposition'), dispositionId: teamIdSchema, feedbackId: teamIdSchema, outcome: z.enum(['declined', 'deferred', 'withdrawn']), ownerId: teamIdSchema, dueAt: time.nullable(), reason: content }).strict()
])
export type CollaborationCommand = z.infer<typeof collaborationCommandSchema>
const ref = collaborationVersionRefSchema
export const collaborationDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('discussion'), feedbackId: teamIdSchema, replyCount: z.number().int().nonnegative(), relocations: z.array(z.object({ target: ref, quote: z.string().max(4000), anchor: collaborationAnchorSchema, reason: content, actor: collaborationActorSchema }).strict()).max(50) }).strict(),
  z.object({ kind: z.literal('notice'), recipientIds: ids, message: content, acknowledgements: z.array(z.object({ userId: teamIdSchema, at: time }).strict()).max(50), cancelled: z.boolean(), cancellationReason: content.nullable() }).strict(),
  z.object({ kind: z.literal('decision'), question: content, options: z.array(option).min(2).max(8), recommendation: teamOpaqueIdSchema.nullable(), ownerId: teamIdSchema, coordinatorIds: ids, impact: z.array(z.string()).min(1).max(30), dueAt: time, state: z.enum(['open', 'answered']), answer: z.object({ optionId: teamOpaqueIdSchema, rationale: content, actor: collaborationActorSchema }).strict().nullable(), coordinationNote: content.nullable() }).strict(),
  z.object({ kind: z.literal('batch'), selections: z.array(collaborationSelectionSchema).min(1).max(50), baselines: z.array(ref).max(30), assigneeId: teamIdSchema, timing: z.enum(['boundary', 'now', 'after-run']), rationale: content, manifestDigest: teamDigestSchema, state: z.enum(['planned', 'awaiting-confirmation', 'resolved', 'cancelled']), reportCount: z.number().int().nonnegative(), resolution: z.object({ verificationReportId: teamIdSchema, rationale: content, actor: collaborationActorSchema, evidenceClassification: z.literal('human-confirmed') }).strict().nullable(), lastReason: content.nullable() }).strict()
])
export const collaborationRecordSchema = z.object({ entityId: teamIdSchema, materialId: teamIdSchema, version: revision, projectId: teamIdSchema, creatorId: teamIdSchema, revision, createdAt: time, updatedAt: time, data: collaborationDataSchema }).strict()
export const collaborationViewSchema = collaborationRecordSchema.extend({ serverTime: time, overdue: z.boolean(), blocksDevelopment: z.literal(false), nativeVerification: z.literal('not-verified') }).strict()
export const collaborationHistorySchema = z.object({ revision, action: z.string(), actor: collaborationActorSchema, record: collaborationRecordSchema }).strict()
export const collaborationReplySchema = z.object({ replyId: teamIdSchema, entityId: teamIdSchema, parentReplyId: teamIdSchema.nullable(), body: content, actor: collaborationActorSchema, createdAt: time }).strict()
export const collaborationExecutionReportSchema = collaborationReportSchema.extend({ entityId: teamIdSchema, actor: collaborationActorSchema, createdAt: time, trust: z.enum(['device-reported', 'browser-reported']), nativeVerification: z.literal('not-verified') }).strict()
export const collaborationDispositionSchema = z.object({ dispositionId: teamIdSchema, entityId: teamIdSchema, feedbackId: teamIdSchema, materialId: teamIdSchema, version: revision, outcome: z.enum(['declined', 'deferred', 'withdrawn']), ownerId: teamIdSchema, dueAt: time.nullable(), reason: content, actor: collaborationActorSchema, createdAt: time, applied: z.literal(false) }).strict()
export const collaborationListInputSchema = teamPageInputSchema.extend({ projectId: teamIdSchema, kind: collaborationKindSchema.optional() }).strict()
export const collaborationReanchorSchema = z.object({ feedbackId: teamIdSchema, original: ref, target: ref, quote: z.string().max(4000).nullable(), state: z.enum(['unique', 'ambiguous', 'missing', 'unquoted']), candidates: z.array(collaborationAnchorSchema).max(20), truncated: z.boolean(), automaticallyApplied: z.literal(false) }).strict()
export type CollaborationRecord = z.infer<typeof collaborationRecordSchema>
export type CollaborationView = z.infer<typeof collaborationViewSchema>
export type CollaborationActor = z.infer<typeof collaborationActorSchema>
export type CollaborationVersionRef = z.infer<typeof collaborationVersionRefSchema>
export type CollaborationExecutionReport = z.infer<typeof collaborationExecutionReportSchema>
