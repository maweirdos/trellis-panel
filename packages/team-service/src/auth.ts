import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import * as oidc from 'openid-client'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { TeamSession } from '../../../src/shared/team-platform'
import type { TeamServiceConfig } from './config'
import { TeamServiceError } from './errors'
import type { TeamStore } from './store-client'
import type { StoreActor, StorePrincipal } from './store-types'

declare module 'fastify' { interface FastifyRequest { teamPrincipal: StorePrincipal | null } }
export const TEAM_SESSION_COOKIE = 'tp_team_session'
const LOGIN_COOKIE = 'tp_team_login'
const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')
const equal = (a: string, b: string): boolean => { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right) }
export function bearerToken(request: FastifyRequest): string {
  const auth = request.headers.authorization
  if (typeof auth !== 'string' || !/^Bearer td_[A-Za-z0-9_-]{43}$/.test(auth)) throw new TeamServiceError('UNAUTHORIZED', 'Authentication is required', 401)
  return auth.slice('Bearer '.length)
}
export function credentialDigest(token: string): string { return tokenHash(token) }

export class TeamAuthentication {
  private discovery: Promise<oidc.Configuration> | null = null
  constructor(private readonly config: TeamServiceConfig, private readonly store: TeamStore) {}
  private checkedTransport(url: URL): void {
    if (url.username || url.password) throw new TeamServiceError('IDENTITY_UNAVAILABLE', 'Identity endpoint contains unsupported credentials', 503)
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(this.config.allowLoopbackHttp && local && url.protocol === 'http:')) throw new TeamServiceError('IDENTITY_UNAVAILABLE', 'Identity endpoint requires HTTPS', 503)
  }
  private async client(): Promise<oidc.Configuration> {
    if (this.discovery) return this.discovery
    const fetchBounded: oidc.CustomFetch = async (input, init) => {
      const url = new URL(input)
      this.checkedTransport(url)
      const timeout = AbortSignal.timeout(10_000)
      const body = init.body instanceof Uint8Array ? new Uint8Array(init.body) : init.body
      const response = await fetch(input, { ...init, body, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (declared > 2 * 1024 * 1024) { await response.body?.cancel(); throw new TeamServiceError('IDENTITY_UNAVAILABLE', 'Identity response exceeds its bounded limit', 503) }
      const reader = response.body?.getReader(); const buffers: Uint8Array[] = []; let size = 0
      if (reader) try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new TeamServiceError('IDENTITY_UNAVAILABLE', 'Identity response exceeds its bounded limit', 503) }; buffers.push(chunk.value) }
      } finally { reader.releaseLock() }
      return new Response(Buffer.concat(buffers), { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    const issuer = new URL(this.config.oidc.issuer)
    const pending = oidc.discovery(issuer, this.config.oidc.clientId,
      { token_endpoint_auth_method: this.config.oidc.clientSecret ? 'client_secret_basic' : 'none' },
      this.config.oidc.clientSecret ? oidc.ClientSecretBasic(this.config.oidc.clientSecret) : oidc.None(),
      { [oidc.customFetch]: fetchBounded, ...(this.config.allowLoopbackHttp ? { execute: [oidc.allowInsecureRequests] } : {}), timeout: 10 })
      .then((client) => {
        const metadata = client.serverMetadata()
        for (const value of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) if (typeof value === 'string') this.checkedTransport(new URL(value))
        return client
      })
    this.discovery = pending
    void pending.catch(() => { if (this.discovery === pending) this.discovery = null })
    return pending
  }
  private cookieOptions(): { path: string; httpOnly: true; sameSite: 'lax'; secure: boolean } {
    return { path: '/', httpOnly: true, sameSite: 'lax', secure: this.config.publicOrigin.protocol === 'https:' }
  }
  private returnPath(raw: unknown): string {
    const path = typeof raw === 'string' ? raw : '/'
    if (path.length > 2048 || !path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f]/.test(path) || /^\/(?:%2f|%5c)/i.test(path) || new URL(path, this.config.publicOrigin).origin !== this.config.publicOrigin.origin) throw new TeamServiceError('INVALID_INPUT', 'Return location must remain inside the team Web application')
    return path
  }
  registerRoutes(app: FastifyInstance): void {
    app.get('/auth/login', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
      const query = z.object({ returnTo: z.string().optional() }).strict().parse(request.query)
      const returnTo = this.returnPath(query.returnTo)
      const client = await this.client()
      const verifier = oidc.randomPKCECodeVerifier(); const state = oidc.randomState(); const nonce = oidc.randomNonce()
      const attempt = randomBytes(32).toString('base64url')
      await this.store.call('createLogin', { attemptHash: tokenHash(attempt), state, nonce, verifier, returnTo })
      const redirect = oidc.buildAuthorizationUrl(client, { redirect_uri: new URL('/auth/callback', this.config.publicOrigin).href, scope: this.config.oidc.scopes, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce })
      reply.setCookie(LOGIN_COOKIE, attempt, { ...this.cookieOptions(), maxAge: 300 })
      return reply.redirect(redirect.href)
    })
    app.get('/auth/callback', async (request, reply) => {
      const token = request.cookies[LOGIN_COOKIE]
      const query = z.object({ state: z.string().min(1).max(512) }).passthrough().safeParse(request.query)
      if (!token || !query.success || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new TeamServiceError('INVALID_LOGIN', 'Login attempt is invalid or expired', 401)
      const attempt = await this.store.call<{ state: string; nonce: string; verifier: string; returnTo: string }>('consumeLogin', { attemptHash: tokenHash(token), state: query.data.state })
      reply.clearCookie(LOGIN_COOKIE, this.cookieOptions())
      try {
        const client = await this.client()
        const currentUrl = new URL(request.raw.url ?? '/auth/callback', this.config.publicOrigin)
        const tokens = await oidc.authorizationCodeGrant(client, currentUrl, { pkceCodeVerifier: attempt.verifier, expectedState: attempt.state, expectedNonce: attempt.nonce, idTokenExpected: true })
        const claims = tokens.claims()
        if (!claims || typeof claims.sub !== 'string' || typeof claims.iss !== 'string') throw new TeamServiceError('INVALID_LOGIN', 'Verified identity did not contain a subject', 401)
        const displayName = ([claims.name, claims.preferred_username, claims.sub].find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? claims.sub).trim().slice(0, 200)
        const session = 'ts_' + randomBytes(32).toString('base64url'); const csrfToken = randomBytes(32).toString('base64url')
        const previous = request.cookies[TEAM_SESSION_COOKIE]
        await this.store.call('completeLogin', { issuer: claims.iss, subject: claims.sub, displayName, sessionHash: tokenHash(session), csrfToken, ...(previous && /^ts_[A-Za-z0-9_-]{43}$/.test(previous) ? { previousSessionHash: tokenHash(previous) } : {}) })
        reply.setCookie(TEAM_SESSION_COOKIE, session, { ...this.cookieOptions(), maxAge: Math.floor(this.config.sessionTtlMs / 1000) })
        return reply.redirect(attempt.returnTo)
      } catch (error) {
        if (error instanceof TeamServiceError && ['FORBIDDEN', 'STORE_UNAVAILABLE', 'ACKNOWLEDGEMENT_UNKNOWN'].includes(error.code)) throw error
        throw new TeamServiceError('AUTHENTICATION_FAILED', 'Identity verification failed; start a new sign-in', 401)
      }
    })
    app.post('/auth/logout', { preHandler: this.require.bind(this) }, async (request, reply) => {
      const principal = this.principal(request)
      if (principal.actor.kind !== 'session') throw new TeamServiceError('FORBIDDEN', 'Browser authentication is required', 403)
      await this.store.call('logout', { actor: principal.actor })
      reply.clearCookie(TEAM_SESSION_COOKIE, this.cookieOptions())
      return { ok: true, value: { loggedOut: true } }
    })
  }
  async require(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const cookie = request.cookies[TEAM_SESSION_COOKIE]; const header = request.headers.authorization
    if (cookie && header) throw new TeamServiceError('UNAUTHORIZED', 'Use one authentication credential', 401)
    let actor: StoreActor
    if (header) {
      if (request.headers.origin !== undefined) throw new TeamServiceError('FORBIDDEN', 'Device credentials cannot be used by a browser origin', 403)
      actor = { kind: 'device', credentialHash: tokenHash(bearerToken(request)) }
    } else {
      if (!cookie || !/^ts_[A-Za-z0-9_-]{43}$/.test(cookie)) throw new TeamServiceError('UNAUTHORIZED', 'Authentication is required', 401)
      actor = { kind: 'session', credentialHash: tokenHash(cookie) }
    }
    const principal = await this.store.call<StorePrincipal>('authenticate', { actor })
    if (actor.kind === 'session') {
      const origin = request.headers.origin
      if (origin !== undefined && origin !== this.config.publicOrigin.origin) throw new TeamServiceError('FORBIDDEN', 'Request origin does not match the team application', 403)
      if (!['GET', 'HEAD'].includes(request.method)) {
        const supplied = request.headers['x-csrf-token']
        if (origin !== this.config.publicOrigin.origin || typeof supplied !== 'string' || !principal.csrfToken || !equal(supplied, principal.csrfToken)) throw new TeamServiceError('CSRF_REJECTED', 'Refresh the signed-in page before sending this action', 403)
      }
    }
    request.teamPrincipal = principal
  }
  principal(request: FastifyRequest): StorePrincipal {
    if (!request.teamPrincipal) throw new TeamServiceError('UNAUTHORIZED', 'Authentication is required', 401)
    return request.teamPrincipal
  }
  session(request: FastifyRequest): TeamSession {
    const p = this.principal(request)
    return { contractVersion: 1, person: p.person, csrfToken: p.csrfToken, authentication: p.actor.kind === 'session' ? 'browser' : 'device', deviceId: p.deviceId }
  }
}
