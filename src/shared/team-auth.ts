import { z } from 'zod'
import { teamSessionSchema } from './team-platform'

export const TEAM_LOCAL_ISSUER = 'urn:trellis:local'
export const TEAM_AUTH_OPTIONS_CAPABILITY_HEADER = 'x-trellis-auth-options-capability'
export const TEAM_AUTH_OPTIONS_INITIAL_TASK_TYPES = 'initial-task-types'
export const teamLocalUsernameSchema = z.string().trim().toLowerCase().min(3).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/, 'Use 3–64 letters, digits, dots, underscores or hyphens')
export const teamLocalPasswordSchema = z.string().min(1, 'Password is required').max(256)
export const teamLocalLoginSchema = z.object({ username: teamLocalUsernameSchema, password: teamLocalPasswordSchema, returnTo: z.string().max(2048).optional() }).strict()
export const teamLocalRegisterSchema = teamLocalLoginSchema.extend({ password: teamLocalPasswordSchema, displayName: z.string().trim().min(1).max(200) }).strict()
export const teamAuthOptionsSchema = z.object({ localLogin: z.literal(true), selfRegistration: z.boolean(), oidcLogin: z.boolean(), oidcLabel: z.string().max(100), csrfToken: z.string().min(20).max(200), supportsInitialTaskTypes: z.boolean().default(false) }).strict()
export const teamLocalAuthReplySchema = z.object({ session: teamSessionSchema, returnTo: z.string().max(2048) }).strict()
