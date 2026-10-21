/** Transport-neutral team contracts. Server identities and ACLs are never client grants. */
import { z } from 'zod'

export const TEAM_CONTRACT_VERSION = 1 as const
export const TEAM_MAX_DOCUMENT_BYTES = 1024 * 1024
export const TEAM_MAX_REQUEST_BYTES = 2 * 1024 * 1024
export const TEAM_MAX_RESPONSE_BYTES = 3 * 1024 * 1024
export const TEAM_MAX_PAGE_ITEM_BYTES = 512 * 1024
export const teamIdSchema = z.string().uuid()
export const teamOpaqueIdSchema = z.string().min(1).max(512).refine((value) => value === value.trim() && !/[\\/\u0000-\u001f]/.test(value) && !/^[a-zA-Z]:/.test(value), 'Expected a scoped identity, not a local path')
export const teamCommandIdSchema = z.string().uuid()
export const teamRoleSchema = z.enum(['product', 'pm', 'developer', 'tester', 'admin'])
export const teamMembershipRoleSchema = z.enum(['owner', 'admin', 'member'])
export const teamMaterialKindSchema = z.enum(['product-requirement', 'trellis-prd', 'design', 'spec', 'code', 'feedback', 'other'])
export const teamVisibilitySchema = z.enum(['personal', 'project', 'team'])
export const teamDigestSchema = z.string().regex(/^[0-9a-f]{64}$/)
export const teamCapabilityNameSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/).refine((value) => !/^[A-Za-z]:[\\/]/.test(value), 'Capability names cannot be local paths')
export const teamRelativePathSchema = z.string().min(1).max(2048).refine((value) => !/^[\\/]|[\u0000-\u001f\u007f:]/.test(value) && !value.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'), 'Expected a project-relative path')
export const teamSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-material'), repositoryId: teamOpaqueIdSchema, workspaceId: teamOpaqueIdSchema, taskRef: teamOpaqueIdSchema.nullable(), relativePath: teamRelativePathSchema, version: teamOpaqueIdSchema }).strict(),
  z.object({ kind: z.literal('authored'), sourceId: teamOpaqueIdSchema, version: teamOpaqueIdSchema }).strict(),
  z.object({ kind: z.literal('external-reference'), instanceId: teamOpaqueIdSchema, objectId: teamOpaqueIdSchema, version: teamOpaqueIdSchema.nullable(), verified: z.literal(false) }).strict()
])

export const createTeamSchema = z.object({ commandId: teamCommandIdSchema, name: z.string().trim().min(1).max(200) }).strict()
export const teamMemberInputSchema = z.object({ commandId: teamCommandIdSchema, userId: teamIdSchema, roles: z.array(teamMembershipRoleSchema).min(1).max(3), active: z.boolean(), expectedRevision: z.number().int().positive().nullable() }).strict()
export const createTeamProjectSchema = z.object({ commandId: teamCommandIdSchema, teamId: teamIdSchema, name: z.string().trim().min(1).max(200) }).strict()
export const projectMemberInputSchema = z.object({ commandId: teamCommandIdSchema, userId: teamIdSchema, roles: z.array(teamRoleSchema).min(1).max(5), active: z.boolean(), expectedRevision: z.number().int().positive().nullable() }).strict()
export const teamPersonStatusInputSchema = z.object({ commandId: teamCommandIdSchema, active: z.boolean(), expectedRevision: z.number().int().positive() }).strict()
const wellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}
export const publicationInputSchema = z.object({
  commandId: teamCommandIdSchema, materialId: teamIdSchema, projectId: teamIdSchema,
  visibility: teamVisibilitySchema, title: z.string().trim().min(1).max(300), kind: teamMaterialKindSchema,
  text: z.string().min(1).max(TEAM_MAX_DOCUMENT_BYTES).refine((value) => value.trim().length > 0, 'Material content cannot be blank').refine(wellFormedUnicode, 'Material content must contain well-formed Unicode'), source: teamSourceSchema,
  expectedVersion: z.number().int().positive().nullable(), expectedDigest: teamDigestSchema.optional()
}).strict()
export const teamFeedbackInputSchema = z.object({
  commandId: teamCommandIdSchema, feedbackId: teamIdSchema, materialId: teamIdSchema, version: z.number().int().positive(),
  body: z.string().trim().min(1).max(20_000).refine(wellFormedUnicode, 'Feedback content must contain well-formed Unicode'), quote: z.string().max(4000).optional(),
  anchor: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict().refine((value) => value.end >= value.start).optional()
}).strict()
export const deviceEnrollmentInputSchema = z.object({
  deviceName: z.string().trim().min(1).max(150), projectId: teamIdSchema.nullable().optional(),
  capabilityClaims: z.array(teamCapabilityNameSchema).max(50)
}).strict()
export const deviceApproveInputSchema = z.object({ commandId: teamCommandIdSchema, userCode: z.string().regex(/^[A-Z2-9]{10}$/), expectedProjectId: teamIdSchema }).strict()
export const deviceRevokeInputSchema = z.object({ commandId: teamCommandIdSchema }).strict()
export const deviceHeartbeatInputSchema = z.object({ capabilityClaims: z.array(teamCapabilityNameSchema).max(50), sequence: z.number().int().nonnegative().safe() }).strict()
export const teamEventsInputSchema = z.object({ cursor: z.string().max(2048).nullable().default(null), limit: z.coerce.number().int().min(1).max(100).default(50), projectId: teamIdSchema.optional() }).strict()
export const teamPageInputSchema = z.object({ cursor: z.string().max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict()
export const teamListInputSchema = teamPageInputSchema.extend({ projectId: teamIdSchema.optional() }).strict()

export type TeamRole = z.infer<typeof teamRoleSchema>
export type TeamVisibility = z.infer<typeof teamVisibilitySchema>
export type TeamMaterialSource = z.infer<typeof teamSourceSchema>
export type TeamPublicationInput = z.infer<typeof publicationInputSchema>
export type TeamFeedbackInput = z.infer<typeof teamFeedbackInputSchema>
export type TeamEventsInput = z.infer<typeof teamEventsInputSchema>
const timestampSchema = z.number().int().nonnegative().safe()
export const teamPersonSchema = z.object({ userId: teamIdSchema, displayName: z.string().max(200), active: z.boolean(), isPlatformAdmin: z.boolean(), revision: z.number().int().positive() }).strict()
export const teamTeamSchema = z.object({ teamId: teamIdSchema, name: z.string().min(1).max(200), createdAt: timestampSchema }).strict()
export const teamMembershipSchema = z.object({ userId: teamIdSchema, displayName: z.string().max(200), roles: z.array(teamRoleSchema).min(1).max(5), active: z.boolean(), revision: z.number().int().positive() }).strict()
export const teamTeamMembershipSchema = z.object({ userId: teamIdSchema, displayName: z.string().max(200), roles: z.array(teamMembershipRoleSchema).min(1).max(3), active: z.boolean(), revision: z.number().int().positive() }).strict()
export const teamProjectSchema = z.object({ projectId: teamIdSchema, teamId: teamIdSchema, name: z.string().min(1).max(200), createdAt: timestampSchema, roles: z.array(teamRoleSchema).min(1).max(5) }).strict()
export const teamMaterialVersionSchema = z.object({
  materialId: teamIdSchema, version: z.number().int().positive(), projectId: teamIdSchema, teamId: teamIdSchema, ownerId: teamIdSchema,
  title: z.string().min(1).max(300), kind: teamMaterialKindSchema, visibility: teamVisibilitySchema,
  bodyDigest: teamDigestSchema, byteLength: z.number().int().min(1).max(TEAM_MAX_DOCUMENT_BYTES), source: teamSourceSchema,
  createdAt: timestampSchema, authorId: teamIdSchema
}).strict()
export const teamPublishedDocumentSchema = z.object({ material: teamMaterialVersionSchema, text: z.string().max(TEAM_MAX_DOCUMENT_BYTES) }).strict()
const deviceBaseSchema = z.object({ deviceId: teamIdSchema, deviceName: z.string().min(1).max(150), lastSeenAt: timestampSchema.nullable(), online: z.boolean(), capabilityClaims: z.array(teamCapabilityNameSchema).max(50), capabilityEvidence: z.literal('device-declared'), sequence: z.number().int().min(-1).safe() }).strict()
export const teamDeviceSchema = z.discriminatedUnion('status', [
  deviceBaseSchema.extend({ status: z.literal('active'), projectId: teamIdSchema, ownerId: teamIdSchema }).strict(),
  deviceBaseSchema.extend({ status: z.enum(['pending', 'expired']), projectId: teamIdSchema.nullable(), ownerId: z.null(), online: z.literal(false) }).strict(),
  deviceBaseSchema.extend({ status: z.literal('revoked'), projectId: teamIdSchema.nullable(), ownerId: teamIdSchema.nullable(), online: z.literal(false) }).strict()
]).superRefine((value, context) => { if (value.online && value.lastSeenAt === null) context.addIssue({ code: 'custom', path: ['lastSeenAt'], message: 'Online state needs an observed heartbeat' }) })
export const teamEventSchema = z.object({ eventId: teamIdSchema, sequence: z.number().int().positive().safe(), type: z.string().min(1).max(200), projectId: teamIdSchema.nullable(), occurredAt: timestampSchema, payload: z.record(z.string(), z.unknown()) }).strict()
export const teamEventPageSchema = z.object({ contractVersion: z.literal(1), items: z.array(teamEventSchema).max(100), cursor: z.string().min(1).max(2048), resetRequired: z.boolean(), hasMore: z.boolean(), serverTime: timestampSchema }).strict()
export const teamApiErrorSchema = z.object({ ok: z.literal(false), code: z.string().min(1).max(200), error: z.string().max(2000) }).strict()
export const teamSessionSchema = z.object({ contractVersion: z.literal(1), person: teamPersonSchema, csrfToken: z.string().min(20).max(200).nullable(), authentication: z.enum(['browser', 'device']), deviceId: teamIdSchema.nullable() }).strict().superRefine((value, context) => {
  if ((value.authentication === 'browser' && (value.csrfToken === null || value.deviceId !== null)) || (value.authentication === 'device' && (value.csrfToken !== null || value.deviceId === null))) context.addIssue({ code: 'custom', message: 'Session credential facts disagree' })
})
export const teamFeedbackSchema = z.object({ feedbackId: teamIdSchema, materialId: teamIdSchema, version: z.number().int().positive(), authorId: teamIdSchema, body: z.string().min(1).max(20_000), quote: z.string().max(4000).nullable(), anchor: teamFeedbackInputSchema.shape.anchor.unwrap().nullable(), createdAt: timestampSchema, state: z.literal('recorded'), applied: z.literal(false) }).strict()
export const teamDeviceEnrollmentSchema = z.object({ pairingId: teamIdSchema, deviceId: teamIdSchema, deviceToken: z.string().regex(/^td_[A-Za-z0-9_-]{43}$/), userCode: z.string().regex(/^[A-Z2-9]{10}$/), verificationUri: z.string().url(), expiresAt: timestampSchema, pollAfterMs: z.number().int().positive() }).strict()
export const teamDeviceApprovalSchema = z.object({ deviceId: teamIdSchema, projectId: teamIdSchema, ownerId: teamIdSchema, decision: z.literal('approved'), approvedAt: timestampSchema }).strict()
export type TeamPerson = z.infer<typeof teamPersonSchema>
export type TeamMembership = z.infer<typeof teamMembershipSchema>
export type TeamTeam = z.infer<typeof teamTeamSchema>
export type TeamTeamMembership = z.infer<typeof teamTeamMembershipSchema>
export type TeamProject = z.infer<typeof teamProjectSchema>
export type TeamMaterialVersion = z.infer<typeof teamMaterialVersionSchema>
export type TeamPublishedDocument = z.infer<typeof teamPublishedDocumentSchema>
export type TeamDevice = z.infer<typeof teamDeviceSchema>
export type TeamEvent = z.infer<typeof teamEventSchema>
export type TeamEventPage = z.infer<typeof teamEventPageSchema>
export type TeamApiError = z.infer<typeof teamApiErrorSchema>
export type TeamApiReply<T> = { ok: true; value: T } | TeamApiError
export type TeamPage<T> = { items: T[]; nextCursor: string | null; hasMore: boolean }
export type TeamCommandReply<T> = { status: 'committed' | 'duplicate'; commandId: string; result: T }
export type TeamSession = z.infer<typeof teamSessionSchema>
export type TeamFeedback = z.infer<typeof teamFeedbackSchema>
export type TeamDeviceEnrollment = z.infer<typeof teamDeviceEnrollmentSchema>
export type TeamDeviceApproval = z.infer<typeof teamDeviceApprovalSchema>
export type TeamDevicePairing = TeamDevice & { pairingId: string; expiresAt: number }
export function parseTeamDevicePairing(raw: unknown): TeamDevicePairing {
  const value = z.object({ pairingId: teamIdSchema, expiresAt: timestampSchema }).passthrough().parse(raw)
  const { pairingId, expiresAt, ...device } = value
  return { ...teamDeviceSchema.parse(device), pairingId, expiresAt }
}
export function teamPageSchema<T extends z.ZodType>(item: T): z.ZodType<TeamPage<z.output<T>>> {
  return z.object({ items: z.array(item).max(100), nextCursor: z.string().max(2048).nullable(), hasMore: z.boolean() }).strict().superRefine((value, context) => { if (value.hasMore !== (value.nextCursor !== null)) context.addIssue({ code: 'custom', message: 'Page continuation facts disagree' }) }) as z.ZodType<TeamPage<z.output<T>>>
}
export function teamApiReplySchema<T extends z.ZodType>(value: T): z.ZodType<TeamApiReply<z.output<T>>> {
  return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value }).strict(), teamApiErrorSchema]) as z.ZodType<TeamApiReply<z.output<T>>>
}
export function teamCommandReplySchema<T extends z.ZodType>(result: T): z.ZodObject<{ status: z.ZodEnum<{ committed: 'committed'; duplicate: 'duplicate' }>; commandId: z.ZodString; result: T }, z.core.$strict> {
  return z.object({ status: z.enum(['committed', 'duplicate']), commandId: teamCommandIdSchema, result }).strict()
}
