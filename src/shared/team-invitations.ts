import { z } from 'zod'
import { teamCommandIdSchema, teamIdSchema, teamMembershipRoleSchema, teamRoleSchema } from './team-platform'
import { teamLocalUsernameSchema } from './team-auth'

export const teamInvitationTokenSchema = z.string().regex(/^ti_[A-Za-z0-9_-]{43}$/)
export const teamInvitationRecipientSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), username: teamLocalUsernameSchema }).strict(),
  z.object({ kind: z.literal('person'), userId: teamIdSchema }).strict(),
  z.object({ kind: z.literal('oidc-subject'), subject: z.string().trim().min(1).max(512) }).strict()
])
const teamRoles = z.array(teamMembershipRoleSchema).min(1).max(3).refine((roles) => new Set(roles).size === roles.length, 'Duplicate roles')
const projectRoles = z.array(teamRoleSchema).min(1).max(5).refine((roles) => new Set(roles).size === roles.length, 'Duplicate roles')
export const teamInvitationCreateSchema = z.object({
  commandId: teamCommandIdSchema, teamId: teamIdSchema, projectId: teamIdSchema,
  spaceId: z.string().min(1).max(256).optional(),
  teamRoles, projectRoles, recipient: teamInvitationRecipientSchema, token: teamInvitationTokenSchema,
  expiresInMs: z.number().int().min(60_000).max(7 * 24 * 60 * 60_000).default(24 * 60 * 60_000)
}).strict()
export const teamInvitationInspectSchema = z.object({ token: teamInvitationTokenSchema }).strict()
export const teamInvitationAcceptSchema = z.object({
  commandId: teamCommandIdSchema, token: teamInvitationTokenSchema, expectedUserId: teamIdSchema,
  expectedTeamId: teamIdSchema, expectedProjectId: teamIdSchema, expectedSpaceId: z.string().min(1).max(256).optional()
}).strict()
export const teamInvitationRevokeSchema = z.object({ commandId: teamCommandIdSchema }).strict()
export const teamInvitationListSchema = z.object({
  teamId: teamIdSchema, cursor: z.string().max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict()
const timestamp = z.number().int().nonnegative().safe()
export const teamInvitationSchema = z.object({
  invitationId: teamIdSchema, teamId: teamIdSchema, projectId: teamIdSchema,
  teamName: z.string().max(200), projectName: z.string().max(200), teamRoles, projectRoles,
  space: z.object({ id: z.string().min(1).max(256), name: z.string().max(300) }).strict().optional(),
  recipient: teamInvitationRecipientSchema, createdBy: teamIdSchema, createdAt: timestamp, expiresAt: timestamp,
  status: z.enum(['pending', 'expired', 'revoked', 'accepted']), acceptedBy: teamIdSchema.nullable(), acceptedAt: timestamp.nullable()
}).strict()
export type TeamInvitation = z.infer<typeof teamInvitationSchema>
export type TeamInvitationRecipient = z.infer<typeof teamInvitationRecipientSchema>
