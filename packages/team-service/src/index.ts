import Fastify, { LogController, type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import serveStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { TeamAuthentication } from './auth'
import { parseTeamConfig, type TeamServiceConfigInput, type TeamServiceConfig } from './config'
import { TeamServiceError } from './errors'
import { TeamStore } from './store-client'
import { registerTeamRoutes } from './routes'
import { TEAM_MAX_RESPONSE_BYTES } from '../../../src/shared/team-platform'

export type TeamService = { app: FastifyInstance; config: TeamServiceConfig; store: TeamStore; close(): Promise<void> }
export async function createTeamService(input: TeamServiceConfigInput): Promise<TeamService> {
  const config = parseTeamConfig(input)
  const store = await TeamStore.open({ dataDir: config.dataDir, issuer: config.oidc?.issuer ?? '', bootstrapSubject: config.bootstrapSubject, identityProvider: config.gitlabBaseUrl || config.gitlabIntegration ? 'gitlab' : 'oidc', sessionTtlMs: config.sessionTtlMs, pairingTtlMs: config.pairingTtlMs, onlineTtlMs: config.onlineTtlMs })
  const app = Fastify({ bodyLimit: 2 * 1024 * 1024, requestTimeout: 15_000, connectionTimeout: 10_000, keepAliveTimeout: 5000, logController: new LogController({ disableRequestLogging: true }), logger: config.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'], level: 'info' } : false })
  app.decorateRequest('teamPrincipal', null)
  app.setErrorHandler((error, _request, reply) => {
    const http = error instanceof Error ? error as Error & { statusCode?: number; code?: string } : null
    const known = error instanceof TeamServiceError ? error : error instanceof z.ZodError ? new TeamServiceError('INVALID_INPUT', error.issues[0]?.message ?? 'Invalid request') : http?.statusCode && http.statusCode >= 400 && http.statusCode < 500 ? new TeamServiceError(http.code ?? 'INVALID_INPUT', 'Request could not be accepted', http.statusCode) : new TeamServiceError('SERVICE_UNAVAILABLE', 'Team service could not complete this request; retain its command identity', 503)
    return reply.code(known.statusCode).send({ ok: false, code: known.code, error: known.message })
  })
  app.addHook('onRequest', async (request, reply) => {
    const path = (request.raw.url ?? '').split('?', 1)[0]
    if (!['/health', '/ready'].includes(path) && request.headers.host !== config.publicOrigin.host) throw new TeamServiceError('INVALID_HOST', 'Request host does not match the configured team service', 421)
    if (path.startsWith('/api/') || path.startsWith('/auth/')) reply.header('Cache-Control', 'no-store')
    reply.header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
  })
  const reserved = (path: string): boolean => ['/api', '/auth', '/assets'].some((prefix) => path === prefix || path.startsWith(prefix + '/'))
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?', 1)[0]
    if (config.webDir && request.method === 'GET' && !reserved(path)) return reply.type('text/html').sendFile('index.html', config.webDir)
    return reply.code(404).send({ ok: false, code: 'NOT_FOUND', error: 'Team route is unavailable' })
  })
  app.addHook('onSend', async (request, reply, payload) => {
    if ((request.url.startsWith('/api/') || request.url.startsWith('/auth/')) && (typeof payload === 'string' || Buffer.isBuffer(payload)) && Buffer.byteLength(payload) > TEAM_MAX_RESPONSE_BYTES) {
      reply.code(413)
      return JSON.stringify({ ok: false, code: 'CAPACITY_EXCEEDED', error: 'Response exceeds its bounded limit; use a smaller page' })
    }
    return payload
  })
  try {
    await app.register(cookie)
    await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })
    const auth = new TeamAuthentication(config, store)
    auth.registerRoutes(app)
    app.get('/health', async () => ({ ok: true, value: { service: 'trellis-team', contractVersion: 1 } }))
    app.get('/ready', async () => { await store.call('health', {}); return { ok: true, value: { service: 'trellis-team', storage: 'ready', contractVersion: 1 } } })
    await registerTeamRoutes(app, store, auth, config)
    let ticking = false
    const tickTimer = setInterval(() => {
      if (ticking) return
      ticking = true
      void store.call('hifoxTick', {}).catch(() => { if (config.logger) app.log.warn('Scheduled workspace rules could not complete; the next tick will recheck authority') }).finally(() => { ticking = false })
    }, 30_000)
    tickTimer.unref()
    app.addHook('preClose', async () => { clearInterval(tickTimer) })
    if (config.webDir) {
      if (!existsSync(join(config.webDir, 'index.html'))) throw new TeamServiceError('INVALID_CONFIG', 'TEAM_WEB_DIR must contain a built index.html')
      await app.register(serveStatic, { root: join(config.webDir, 'assets'), prefix: '/assets/', wildcard: true, decorateReply: true, dotfiles: 'deny', index: false })
      app.get('/', async (_request, reply) => reply.type('text/html').sendFile('index.html', config.webDir))
    } else app.get('/', async () => ({ ok: true, value: { service: 'trellis-team', web: 'not-configured' } }))
    app.addHook('onClose', async () => { await store.close() })
    await app.ready()
    return { app, config, store, close: () => app.close() }
  } catch (error) { await app.close().catch(() => {}); await store.close().catch(() => {}); throw error }
}
export { TeamServiceError } from './errors'
export { parseTeamConfig, teamConfigFromEnvironment } from './config'
export { restoreTeamBackup } from './restore'
export * from '../../../src/shared/team-platform'
export * from '../../../src/shared/team-collaboration'
export * from '../../../src/shared/team-invitations'
export * from '../../../src/shared/team-identity'
export * from '../../../src/shared/team-auth'
export * from '../../../src/shared/hifox-remote'
export * from '../../../src/shared/creations'
export * from '../../../src/shared/team-task-progress'
