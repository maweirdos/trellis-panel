import { resolve } from 'node:path'
import { z } from 'zod'

const originSchema = z.string().url().transform((value) => new URL(value)).refine((value) => !value.username && !value.password && value.pathname === '/' && !value.search && !value.hash, 'Expected an origin without credentials or path')
const loopback = (url: URL): boolean => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
export const teamServiceConfigSchema = z.object({
  dataDir: z.string().min(1), publicOrigin: originSchema,
  oidc: z.object({ issuer: z.string().url(), clientId: z.string().min(1), clientSecret: z.string().min(1).optional(), scopes: z.string().default('openid profile') }).strict(),
  bootstrapSubject: z.string().min(1).max(512),
  allowLoopbackHttp: z.boolean().default(false),
  sessionTtlMs: z.number().int().min(60_000).max(24 * 60 * 60_000).default(8 * 60 * 60_000),
  pairingTtlMs: z.number().int().min(1000).max(10 * 60_000).default(5 * 60_000),
  onlineTtlMs: z.number().int().min(1000).max(5 * 60_000).default(45_000),
  webDir: z.string().min(1).optional(), logger: z.boolean().default(false)
}).strict().superRefine((value, ctx) => {
  const issuer = new URL(value.oidc.issuer)
  if (issuer.username || issuer.password || issuer.search || issuer.hash) ctx.addIssue({ code: 'custom', path: ['oidc', 'issuer'], message: 'OIDC issuer must not contain credentials/query/fragment' })
  for (const url of [value.publicOrigin, issuer]) if (url.protocol !== 'https:' && !(value.allowLoopbackHttp && url.protocol === 'http:' && loopback(url))) ctx.addIssue({ code: 'custom', message: 'HTTPS is required except explicitly enabled loopback tests' })
})
export type TeamServiceConfigInput = z.input<typeof teamServiceConfigSchema>
export type TeamServiceConfig = z.infer<typeof teamServiceConfigSchema>
export function parseTeamConfig(input: TeamServiceConfigInput): TeamServiceConfig {
  const value = teamServiceConfigSchema.parse(input)
  return { ...value, dataDir: resolve(value.dataDir), ...(value.webDir ? { webDir: resolve(value.webDir) } : {}) }
}
export function teamConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): TeamServiceConfigInput {
  return {
    dataDir: env.TEAM_DATA_DIR ?? './team-data', publicOrigin: env.TEAM_PUBLIC_ORIGIN ?? '',
    oidc: { issuer: env.TEAM_OIDC_ISSUER ?? '', clientId: env.TEAM_OIDC_CLIENT_ID ?? '', ...(env.TEAM_OIDC_CLIENT_SECRET ? { clientSecret: env.TEAM_OIDC_CLIENT_SECRET } : {}) },
    bootstrapSubject: env.TEAM_BOOTSTRAP_SUBJECT ?? '', allowLoopbackHttp: env.TEAM_ALLOW_LOOPBACK_HTTP === '1',
    ...(env.TEAM_WEB_DIR ? { webDir: env.TEAM_WEB_DIR } : {}), logger: true
  }
}
