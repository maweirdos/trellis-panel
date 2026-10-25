import { z } from 'zod'

const identityFields = { issuer: z.string().url(), subject: z.string().min(1).max(512), scopes: z.array(z.string().min(1).max(200)).max(50) }
export const teamGitlabIdentitySchema = z.object({
  provider: z.literal('gitlab'), ...identityFields, baseUrl: z.string().url(), clientId: z.string().min(1).max(512), username: z.string().min(1).max(200).optional()
}).strict()
export const teamIdentitySchema = z.discriminatedUnion('provider', [
  teamGitlabIdentitySchema,
  z.object({ provider: z.literal('local'), ...identityFields, username: z.string().min(3).max(64) }).strict(),
  z.object({ provider: z.literal('oidc'), ...identityFields }).strict()
])
export type TeamIdentity = z.infer<typeof teamIdentitySchema>
export type TeamGitlabIdentity = z.infer<typeof teamGitlabIdentitySchema>
