import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { jiraOAuthRelayCreateSchema } from '../../../../src/shared/jira-auth'
import type { TeamAuthentication } from '../auth'
import type { TeamServiceConfig } from '../config'
import { TeamServiceError } from '../errors'
import type { TeamStore } from '../store-client'
import { JIRA_OAUTH_CALLBACK_PATH, jiraRelayRedirect, parseJiraRelayCallback } from './jira-oauth-relay'

const relayParams = z.object({ relayId: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
const empty = z.object({}).strict()
const browserResult = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Jira authorization</title><body><main><h1>Jira authorization</h1><p>Return to the desktop application to continue.</p></main></body></html>'

function nativeRequest(request: FastifyRequest): void {
  if (request.headers.origin !== undefined || request.headers.cookie !== undefined) throw new TeamServiceError('FORBIDDEN', 'Jira authorization relay requires the original desktop device', 403)
  if (request.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length !== 1) throw new TeamServiceError('UNAUTHORIZED', 'Use one authorization credential', 401)
}
function claim(request: FastifyRequest): { relayId: string; claimSecret: string } {
  nativeRequest(request)
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new TeamServiceError('UNAUTHORIZED', 'Jira authorization claim is required', 401)
  empty.parse(request.query)
  empty.parse(request.body ?? {})
  return { ...relayParams.parse(request.params), claimSecret: authorization.slice('Bearer '.length) }
}
function callbackHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').header('Referrer-Policy', 'no-referrer')
    .header('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
    .header('X-Frame-Options', 'DENY').type('text/html; charset=utf-8')
}

/** Mounted outside generic API authentication: only creation accepts the existing td_ device credential. */
export function registerJiraOAuthRelayRoutes(app: FastifyInstance, store: TeamStore, auth: TeamAuthentication, config: TeamServiceConfig): void {
  const path = '/api/integrations/jira/oauth/relay'
  app.post(path, { bodyLimit: 16_384, config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, preHandler: async (request, reply) => {
    nativeRequest(request)
    await auth.require(request, reply)
    if (auth.principal(request).actor.kind !== 'device') throw new TeamServiceError('FORBIDDEN', 'Jira authorization requires a paired desktop device', 403)
  } }, async request => {
    empty.parse(request.query)
    jiraRelayRedirect(config.publicOrigin.origin)
    const body = jiraOAuthRelayCreateSchema.parse(request.body)
    return { ok: true, value: await store.call('jiraOAuthRelayCreate', { actor: auth.principal(request).actor, body, publicOrigin: config.publicOrigin.origin }) }
  })
  for (const operation of ['poll', 'cancel'] as const) app.post(path + '/:relayId/' + operation, {
    bodyLimit: 1024, config: { rateLimit: { max: operation === 'poll' ? 1200 : 60, timeWindow: '1 minute' } }
  }, async request => ({ ok: true, value: await store.call(operation === 'poll' ? 'jiraOAuthRelayPoll' : 'jiraOAuthRelayCancel', claim(request)) }))
  app.get(JIRA_OAUTH_CALLBACK_PATH, { exposeHeadRoute: false, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    callbackHeaders(reply)
    try {
      if (request.method !== 'GET' || request.headers.host !== config.publicOrigin.host) throw new TeamServiceError('INVALID_INPUT', 'Jira callback is invalid')
      const result = parseJiraRelayCallback(request.raw.url ?? '', config.publicOrigin.origin)
      await store.call('jiraOAuthRelayCallback', result)
      return reply.send(browserResult)
    } catch {
      // Provider text, codes and state never appear in browser output or application logs.
      return reply.code(400).send(browserResult)
    }
  })
}
