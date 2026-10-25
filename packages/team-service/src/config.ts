import { resolve } from 'node:path'
import { z } from 'zod'

const originSchema = z.string().url().transform((value) => new URL(value)).refine((value) => !value.username && !value.password && value.pathname === '/' && !value.search && !value.hash, 'Expected an origin without credentials or path')
const loopback = (url: URL): boolean => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
const privateHttpOriginSchema = z.string().regex(/^http:\/\/(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]{1,5})?\/?$/, 'Expected an exact private IPv4 HTTP origin').pipe(originSchema).refine((url) => {
  const parts = url.hostname.split('.').map(Number)
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && (parts[0] === 10 || parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31 || parts[0] === 192 && parts[1] === 168)
}, 'Expected an exact private IPv4 HTTP origin')
export const teamServiceConfigSchema = z.object({
  dataDir: z.string().min(1), publicOrigin: originSchema.prefault('http://127.0.0.1:5441'),
  deploymentMode: z.enum(['local', 'intranet']).default('local'),
  allowSelfRegistration: z.boolean().optional(),
  oidc: z.object({ issuer: z.string().url(), clientId: z.string().min(1), clientSecret: z.string().min(1).optional(), scopes: z.string().default('openid profile') }).strict().optional(),
  gitlabBaseUrl: originSchema.optional(),
  gitlabIntegration: z.object({ baseUrl: originSchema, clientId: z.string().trim().min(1).max(512) }).strict().optional(),
  bootstrapSubject: z.string().max(512).default(''),
  allowLoopbackHttp: z.boolean().default(false),
  allowedIntranetHttpOrigins: z.array(privateHttpOriginSchema).max(8).default([]),
  sessionTtlMs: z.number().int().min(60_000).max(24 * 60 * 60_000).default(8 * 60 * 60_000),
  pairingTtlMs: z.number().int().min(1000).max(10 * 60_000).default(5 * 60_000),
  onlineTtlMs: z.number().int().min(1000).max(5 * 60_000).default(45_000),
  webDir: z.string().min(1).optional(), logger: z.boolean().default(false)
}).strict().superRefine((value, ctx) => {
  const issuer = value.oidc ? new URL(value.oidc.issuer) : null
  if (issuer && (issuer.username || issuer.password || issuer.search || issuer.hash)) ctx.addIssue({ code: 'custom', path: ['oidc', 'issuer'], message: 'OIDC issuer must not contain credentials/query/fragment' })
  for (const base of [value.gitlabBaseUrl, value.gitlabIntegration?.baseUrl]) if (base && (!issuer || base.origin !== issuer.origin || issuer.pathname !== '/')) ctx.addIssue({ code: 'custom', message: 'Configured GitLab base URL must exactly match the OIDC issuer origin' })
  for (const url of [value.publicOrigin, ...(issuer ? [issuer] : [])]) if (url.protocol !== 'https:' && !(value.allowLoopbackHttp && url.protocol === 'http:' && loopback(url)) && !(url === value.publicOrigin && value.deploymentMode === 'local' && url.protocol === 'http:' && loopback(url)) && !value.allowedIntranetHttpOrigins.some((allowed) => allowed.origin === url.origin)) ctx.addIssue({ code: 'custom', message: 'HTTPS is required except explicitly enabled exact private origins or loopback tests' })
  if (value.allowSelfRegistration === undefined && value.deploymentMode !== 'local') ctx.addIssue({ code: 'custom', message: 'Set allowSelfRegistration explicitly for an intranet deployment' })
})
export type TeamServiceConfigInput = z.input<typeof teamServiceConfigSchema>
export type TeamServiceConfig = z.infer<typeof teamServiceConfigSchema>
export function parseTeamConfig(input: TeamServiceConfigInput): TeamServiceConfig {
  const value = teamServiceConfigSchema.parse(input)
  return { ...value, allowSelfRegistration: value.allowSelfRegistration ?? (value.deploymentMode === 'local' && loopback(value.publicOrigin)), dataDir: resolve(value.dataDir), ...(value.webDir ? { webDir: resolve(value.webDir) } : {}) }
}
export function teamConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): TeamServiceConfigInput {
  return {
    dataDir: env.TEAM_DATA_DIR ?? './team-data', publicOrigin: env.TEAM_PUBLIC_ORIGIN ?? 'http://127.0.0.1:5441',
    deploymentMode: env.TEAM_DEPLOYMENT_MODE === 'intranet' ? 'intranet' : 'local',
    ...(env.TEAM_ALLOW_SELF_REGISTRATION !== undefined ? { allowSelfRegistration: env.TEAM_ALLOW_SELF_REGISTRATION === '1' } : {}),
    ...(env.TEAM_OIDC_ISSUER || env.TEAM_OIDC_CLIENT_ID || env.TEAM_OIDC_CLIENT_SECRET ? { oidc: { issuer: env.TEAM_OIDC_ISSUER ?? '', clientId: env.TEAM_OIDC_CLIENT_ID ?? '', ...(env.TEAM_OIDC_CLIENT_SECRET ? { clientSecret: env.TEAM_OIDC_CLIENT_SECRET } : {}) } } : {}),
    ...(env.TEAM_GITLAB_BASE_URL ? { gitlabBaseUrl: env.TEAM_GITLAB_BASE_URL } : {}),
    ...(env.TEAM_GITLAB_NATIVE_CLIENT_ID ? { gitlabIntegration: { baseUrl: env.TEAM_GITLAB_INTEGRATION_BASE_URL ?? env.TEAM_GITLAB_BASE_URL ?? '', clientId: env.TEAM_GITLAB_NATIVE_CLIENT_ID } } : {}),
    bootstrapSubject: env.TEAM_BOOTSTRAP_SUBJECT ?? '', allowLoopbackHttp: env.TEAM_ALLOW_LOOPBACK_HTTP === '1',
    allowedIntranetHttpOrigins: env.TEAM_ALLOWED_INTRANET_HTTP_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [],
    ...(env.TEAM_WEB_DIR ? { webDir: env.TEAM_WEB_DIR } : {}), logger: true
  }
}
