import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { jiraOAuthRelayCreateSchema, type JiraOAuthRelay, type JiraOAuthRelayCreate } from '../../../../src/shared/jira-auth'
import { TeamServiceError } from '../errors'
import type { StoreActor, StorePrincipal } from '../store-types'

export const JIRA_OAUTH_CALLBACK_PATH = '/auth/jira/callback'
const ATTEMPT_TTL_MS = 5 * 60_000
const CODE_TTL_MS = 10_000
const MAX_ATTEMPTS = 256
const MAX_DEVICE_ATTEMPTS = 4
const MAX_PERSON_ATTEMPTS = 16
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const deviceActor = z.object({ kind: z.literal('device'), credentialHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const claimSchema = z.object({ relayId: opaque, claimSecret: opaque }).strict()
const codeSchema = z.string().min(1).max(8192).refine(value => !/[\u0000-\u0020\u007f]/.test(value))
const callbackSchema = z.discriminatedUnion('status', [
  z.object({ state: opaque, status: z.literal('complete'), code: codeSchema }).strict(),
  z.object({ state: opaque, status: z.literal('denied') }).strict()
])
export type JiraRelayCallback = z.infer<typeof callbackSchema>
type RelayResult = { status: 'pending' } | { status: 'complete'; code: string } | { status: 'denied' }
type RelayAttempt = {
  relayId: string; stateHash: string; claimHash: string; expiresAt: number
  actor: StoreActor; personId: string; deviceId: string; projectId: string
  instanceId: string; epoch: string; authorization: JiraOAuthRelayCreate; result: RelayResult
}
export interface JiraOAuthRelayHost {
  authenticate(actor: StoreActor): StorePrincipal
  identity(): { instanceId: string; epoch: string }
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const secret = (): string => randomBytes(32).toString('base64url')
const gone = (): TeamServiceError => new TeamServiceError('JIRA_OAUTH_RELAY_GONE', 'Jira authorization is expired, consumed or cancelled; start a new authorization', 410)

export function jiraRelayRedirect(publicOrigin: string): string {
  const origin = new URL(publicOrigin)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw new TeamServiceError('JIRA_OAUTH_RELAY_UNAVAILABLE', 'Jira authorization requires the configured public HTTPS team service origin', 503)
  }
  return new URL(JIRA_OAUTH_CALLBACK_PATH, origin).href
}

/** Ephemeral state belongs to the existing single writer. No code or claim is persisted or backed up. */
export class TeamJiraOAuthRelay {
  private readonly attempts = new Map<string, RelayAttempt>()
  private readonly states = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(private readonly host: JiraOAuthRelayHost) {}

  private remove(attempt: RelayAttempt): void {
    this.states.delete(attempt.stateHash)
    this.attempts.delete(attempt.relayId)
  }
  private prune(): void {
    const time = Date.now()
    for (const attempt of this.attempts.values()) if (attempt.expiresAt <= time) this.remove(attempt)
  }
  private assertOwner(attempt: RelayAttempt): void {
    try {
      const identity = this.host.identity()
      const principal = this.host.authenticate(attempt.actor)
      if (identity.instanceId !== attempt.instanceId || identity.epoch !== attempt.epoch || principal.actor.kind !== 'device'
        || principal.person.userId !== attempt.personId || principal.deviceId !== attempt.deviceId || principal.projectId !== attempt.projectId) throw gone()
    } catch (error) {
      this.remove(attempt)
      throw error
    }
  }
  create(raw: unknown): JiraOAuthRelay {
    this.prune()
    const input = z.object({ actor: deviceActor, body: jiraOAuthRelayCreateSchema, publicOrigin: z.string().url().max(2048) }).strict().parse(raw)
    const principal = this.host.authenticate(input.actor)
    if (!principal.deviceId || !principal.projectId || principal.actor.kind !== 'device') throw new TeamServiceError('FORBIDDEN', 'Jira authorization requires a paired desktop device', 403)
    const redirectUri = jiraRelayRedirect(input.publicOrigin)
    const base = new URL(input.body.baseUrl)
    if (input.body.redirectUri !== redirectUri || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || /[\s\u007f]/.test(input.body.baseUrl) || /[\u0000-\u001f\u007f]/.test(input.body.clientId) || !input.body.clientId.trim()) {
      throw new TeamServiceError('INVALID_INPUT', 'Jira HTTPS instance, client identity and exact registered callback are required')
    }
    const attempts = [...this.attempts.values()]
    const replaced = attempts.filter(attempt => attempt.deviceId === principal.deviceId && attempt.personId === principal.person.userId && attempt.authorization.connectionId === input.body.connectionId)
    const retained = attempts.filter(attempt => !replaced.includes(attempt))
    if (retained.length >= MAX_ATTEMPTS || retained.filter(attempt => attempt.deviceId === principal.deviceId).length >= MAX_DEVICE_ATTEMPTS
      || retained.filter(attempt => attempt.personId === principal.person.userId).length >= MAX_PERSON_ATTEMPTS) {
      throw new TeamServiceError('JIRA_OAUTH_RELAY_CAPACITY', 'Too many Jira authorizations are pending; cancel one or wait for expiry', 429)
    }
    for (const attempt of replaced) this.remove(attempt)
    const relayId = secret(), state = secret(), claimSecret = secret(), expiresAt = Date.now() + ATTEMPT_TTL_MS
    const attempt: RelayAttempt = { relayId, stateHash: hash(state), claimHash: hash(claimSecret), expiresAt,
      actor: input.actor, personId: principal.person.userId, deviceId: principal.deviceId, projectId: principal.projectId,
      ...this.host.identity(), authorization: input.body, result: { status: 'pending' } }
    this.attempts.set(relayId, attempt)
    this.states.set(attempt.stateHash, relayId)
    if (!this.timer) { this.timer = setInterval(() => this.prune(), 1000); this.timer.unref() }
    return { relayId, state, claimSecret, redirectUri, expiresAt }
  }
  private claim(raw: unknown): RelayAttempt {
    this.prune()
    const input = claimSchema.parse(raw)
    const attempt = this.attempts.get(input.relayId)
    if (!attempt) throw gone()
    if (!timingSafeEqual(Buffer.from(attempt.claimHash, 'hex'), Buffer.from(hash(input.claimSecret), 'hex'))) {
      throw new TeamServiceError('UNAUTHORIZED', 'Jira authorization claim is invalid', 401)
    }
    this.assertOwner(attempt)
    return attempt
  }
  poll(raw: unknown): RelayResult {
    const attempt = this.claim(raw)
    if (attempt.result.status === 'pending') return { status: 'pending' }
    // At-most-once delivery: response loss requires a new browser authorization, never code replay.
    this.remove(attempt)
    return attempt.result
  }
  cancel(raw: unknown): null {
    this.remove(this.claim(raw))
    return null
  }
  callback(raw: unknown): void {
    this.prune()
    const input = callbackSchema.parse(raw)
    const stateHash = hash(input.state), relayId = this.states.get(stateHash)
    const attempt = relayId ? this.attempts.get(relayId) : undefined
    if (!attempt || attempt.result.status !== 'pending') throw gone()
    this.assertOwner(attempt)
    this.states.delete(stateHash)
    if (input.status === 'complete') {
      attempt.result = { status: 'complete', code: input.code }
      attempt.expiresAt = Math.min(attempt.expiresAt, Date.now() + CODE_TTL_MS)
    } else attempt.result = { status: 'denied' }
  }
  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.states.clear()
    this.attempts.clear()
  }
}

/** Parse raw names before URL decoding so encoded aliases and duplicate query fields are rejected. */
export function parseJiraRelayCallback(rawUrl: string, publicOrigin: string): JiraRelayCallback {
  const redirect = jiraRelayRedirect(publicOrigin)
  if (rawUrl.length > 16_384 || rawUrl.split('?', 1)[0] !== JIRA_OAUTH_CALLBACK_PATH) throw new TeamServiceError('INVALID_INPUT', 'Jira callback is invalid')
  const url = new URL(rawUrl, publicOrigin)
  if (url.origin !== new URL(redirect).origin || url.pathname !== JIRA_OAUTH_CALLBACK_PATH || url.hash) throw new TeamServiceError('INVALID_INPUT', 'Jira callback is invalid')
  const fields = new Map<string, string>()
  const allowed = new Set(['state', 'code', 'error', 'error_description', 'error_uri'])
  for (const part of url.search.slice(1).split('&')) {
    const separator = part.indexOf('='), name = part.slice(0, separator)
    if (separator < 1 || !allowed.has(name) || fields.has(name)) throw new TeamServiceError('INVALID_INPUT', 'Jira callback fields are invalid')
    let value: string
    try { value = decodeURIComponent(part.slice(separator + 1).replace(/\+/g, ' ')) }
    catch { throw new TeamServiceError('INVALID_INPUT', 'Jira callback encoding is invalid') }
    if (value.length > (name === 'code' ? 8192 : 4096) || /[\u0000-\u001f\u007f]/.test(value)) throw new TeamServiceError('INVALID_INPUT', 'Jira callback fields are invalid')
    fields.set(name, value)
  }
  const state = fields.get('state'), code = fields.get('code'), error = fields.get('error')
  if ((code === undefined) === (error === undefined) || (error !== undefined && (!error || error.length > 256))
    || (code !== undefined && (fields.has('error_description') || fields.has('error_uri')))) throw new TeamServiceError('INVALID_INPUT', 'Jira callback result is invalid')
  return callbackSchema.parse(code !== undefined ? { state, status: 'complete', code } : { state, status: 'denied' })
}
