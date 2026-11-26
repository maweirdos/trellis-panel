/** Public desktop account DTOs never contain cookies, CSRF values or encrypted secrets. */
import { z } from 'zod'
import { teamAuthOptionsSchema, teamLocalLoginSchema, teamLocalRegisterSchema, teamLocalUsernameSchema } from './team-auth'
import { teamCommandIdSchema, teamIdSchema, teamPersonSchema, teamRoleSchema } from './team-platform'
import { teamInvitationSchema } from './team-invitations'

export const desktopTeamAccountIdSchema = z.string().uuid()
export const desktopTeamAccountStateSchema = z.enum(['active', 'signed-out', 'reauthentication-required'])
export const desktopTeamAccountSchema = z.object({
  accountId: desktopTeamAccountIdSchema,
  origin: z.string().url().max(2048),
  person: teamPersonSchema,
  state: desktopTeamAccountStateSchema,
  revision: z.number().int().positive().safe(),
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
  lastVerifiedAt: z.number().int().nonnegative().safe().nullable(),
  lastErrorCode: z.string().max(200).nullable()
}).strict()

export const desktopTeamAuthOptionsSchema = teamAuthOptionsSchema.omit({ csrfToken: true }).extend({
  origin: z.string().url().max(2048),
  externalLogin: z.object({
    browserRequired: z.literal(true),
    label: z.string().max(100),
    url: z.string().url().max(4096)
  }).strict().nullable()
}).omit({ oidcLogin: true, oidcLabel: true }).strict()

export const desktopTeamLoginSchema = teamLocalLoginSchema.omit({ returnTo: true }).extend({
  origin: z.string().min(1).max(2048)
}).strict()
export const desktopTeamRegisterSchema = teamLocalRegisterSchema.omit({ returnTo: true }).extend({
  origin: z.string().min(1).max(2048)
}).strict()
export const desktopTeamPageOptionsSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100).default(50)
}).strict()
export const desktopTeamCreateOrganizationSchema = z.object({
  accountId: desktopTeamAccountIdSchema,
  commandId: teamCommandIdSchema,
  name: z.string().trim().min(1).max(200),
  spaceKey: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,7}$/).optional()
}).strict()
export const desktopTeamCreateWorkspaceSchema = z.object({
  accountId: desktopTeamAccountIdSchema,
  commandId: teamCommandIdSchema,
  organizationId: teamIdSchema,
  name: z.string().trim().min(1).max(200)
}).strict()
export const desktopTeamCreatedOrganizationSchema = z.object({
  teamId: teamIdSchema,
  projectId: teamIdSchema,
  spaceId: z.string().min(1).max(256),
  name: z.string().min(1).max(200)
}).strict()
export const desktopTeamCreatedWorkspaceSchema = z.object({
  projectId: teamIdSchema,
  teamId: teamIdSchema,
  name: z.string().min(1).max(200)
}).strict()
export const desktopTeamInvitationSchema = z.object({
  accountId: desktopTeamAccountIdSchema,
  url: z.string().min(1).max(4096)
}).strict()
export const desktopTeamInvitationAcceptSchema = desktopTeamInvitationSchema.extend({
  commandId: teamCommandIdSchema
}).strict()
export const desktopTeamCreateInvitationSchema = z.object({
  accountId: desktopTeamAccountIdSchema,
  commandId: teamCommandIdSchema,
  workspaceId: teamIdSchema,
  spaceId: z.string().min(1).max(256).optional(),
  recipientUsername: teamLocalUsernameSchema,
  organizationRoles: z.array(z.enum(['member', 'admin'])).min(1).max(2).refine((roles) => new Set(roles).size === roles.length, 'Duplicate roles').default(['member']),
  projectRoles: z.array(teamRoleSchema).min(1).max(5).refine((roles) => new Set(roles).size === roles.length, 'Duplicate roles'),
  expiresInMs: z.number().int().min(60_000).max(7 * 24 * 60 * 60_000).default(24 * 60 * 60_000)
}).strict()
export const desktopTeamCreatedInvitationSchema = z.object({
  invitation: teamInvitationSchema,
  url: z.string().url().max(4096)
}).strict()
export const desktopTeamConnectWorkspaceSchema = z.object({
  accountId: desktopTeamAccountIdSchema,
  commandId: teamCommandIdSchema,
  workspaceId: teamIdSchema,
  deviceName: z.string().trim().min(1).max(150),
  capabilityClaims: z.array(z.string().min(1).max(200)).max(50).default([])
}).strict()

export type DesktopTeamAccount = z.infer<typeof desktopTeamAccountSchema>
export type DesktopTeamAuthOptions = z.infer<typeof desktopTeamAuthOptionsSchema>
export type DesktopTeamLoginInput = z.infer<typeof desktopTeamLoginSchema>
export type DesktopTeamRegisterInput = z.infer<typeof desktopTeamRegisterSchema>
export type DesktopTeamPageOptions = z.input<typeof desktopTeamPageOptionsSchema>
export type DesktopTeamCreateOrganizationInput = z.infer<typeof desktopTeamCreateOrganizationSchema>
export type DesktopTeamCreateWorkspaceInput = z.infer<typeof desktopTeamCreateWorkspaceSchema>
export type DesktopTeamCreatedOrganization = z.infer<typeof desktopTeamCreatedOrganizationSchema>
export type DesktopTeamCreatedWorkspace = z.infer<typeof desktopTeamCreatedWorkspaceSchema>
export type DesktopTeamInvitationInput = z.infer<typeof desktopTeamInvitationSchema>
export type DesktopTeamInvitationAcceptInput = z.infer<typeof desktopTeamInvitationAcceptSchema>
export type DesktopTeamCreateInvitationInput = z.input<typeof desktopTeamCreateInvitationSchema>
export type DesktopTeamCreatedInvitation = z.infer<typeof desktopTeamCreatedInvitationSchema>
export type DesktopTeamConnectWorkspaceInput = z.input<typeof desktopTeamConnectWorkspaceSchema>
