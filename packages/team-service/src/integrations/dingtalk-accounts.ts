import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { TeamServiceError } from '../errors'

const id = z.string().min(1).max(256)
export const dingTalkAccountOwnerSchema = z.object({ nativeSubject: id, personId: z.string().uuid(), deviceId: z.string().uuid(), projectId: z.string().uuid(), serviceBinding: id }).strict()
export type DingTalkAccountOwner = z.infer<typeof dingTalkAccountOwnerSchema>
const identity = z.object({ unionId: id, staffId: id, corpId: id, displayName: z.string().max(256), serviceBinding: id }).strict()
const entry = z.object({
  id: z.string().uuid(), owner: dingTalkAccountOwnerSchema, appId: z.string().uuid(), appRevision: z.number().int().positive(),
  requestId: z.string().uuid(), stateHash: z.string().length(64), nonceHash: z.string().length(64), expiresAt: z.number().int(),
  state: z.enum(['pending', 'processing', 'ready', 'claimed', 'unknown', 'revoked']), identity: identity.nullable()
}).strict()
const storeSchema = z.object({ version: z.literal(1), entries: z.array(entry).max(1000) }).strict()
type AccountState = z.infer<typeof storeSchema>
export interface DingTalkAccountProtection { protect(text: string): string; reveal(text: string): string }
/** Explicit single-writer server store. Protection comes from the deployed server
 * secret manager. It must not reuse a desktop AppSecret or a plaintext fallback. */
export function createDingTalkAccountStore(directory: string, protection: DingTalkAccountProtection, assertWriter: () => void) {
  const file = join(directory, 'dingtalk-account-callbacks-v1.protected.json')
  function read(): AccountState {
    assertWriter()
    if (!existsSync(file)) return { version: 1, entries: [] }
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('invalid file')
      const envelope = z.object({ version: z.literal(1), ciphertext: z.string().max(4 * 1024 * 1024) }).strict().parse(JSON.parse(readFileSync(file, 'utf8')))
      const clear = protection.reveal(envelope.ciphertext)
      if (Buffer.byteLength(clear) > 2 * 1024 * 1024) throw new Error('capacity')
      return storeSchema.parse(JSON.parse(clear))
    } catch { throw new TeamServiceError('DINGTALK_STATE_UNAVAILABLE', 'Protected DingTalk state is unavailable; original bytes are preserved', 503) }
  }
  return { read, change<T>(mutate: (state: AccountState) => T): T {
    const state = read(), result = mutate(state), clear = JSON.stringify(storeSchema.parse(state))
    if (Buffer.byteLength(clear) > 2 * 1024 * 1024) throw new TeamServiceError('DINGTALK_CAPACITY', 'DingTalk account state capacity reached', 409)
    const text = JSON.stringify({ version: 1, ciphertext: protection.protect(clear) })
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new TeamServiceError('DINGTALK_CAPACITY', 'Protected account state capacity reached', 409)
    assertWriter(); mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new TeamServiceError('DINGTALK_STATE_UNAVAILABLE', 'Redirected account state is forbidden', 503)
    const temporary = join(directory, `dingtalk-account-${randomUUID()}.tmp`)
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
    try { assertWriter(); renameSync(temporary, file) } finally { if (existsSync(temporary)) unlinkSync(temporary) }
    return structuredClone(result)
  } }
}
export interface DingTalkAccountServerPorts {
  publicOrigin: string
  serviceBinding: string
  store: ReturnType<typeof createDingTalkAccountStore>
  /** Existing team authority must require the exact active native device, person
   * and project on every call. No visitor, cookie or entered name is an owner. */
  requireDevice(request: FastifyRequest): Promise<DingTalkAccountOwner>
  assertOwner(owner: DingTalkAccountOwner): Promise<void>
  /** Protected, separately administered server configuration; no implicit upload
   * of the local application's AppSecret during account authorization. */
  credentials(owner: DingTalkAccountOwner, appId: string): Promise<{ appKey: string; appSecret: string; corpId: string; appRevision: number }>
  /** Deployed server's actual proxy/TLS transport. Must honor redirect:'error'. */
  fetch(url: string, init: RequestInit): Promise<Response>
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const sameOwner = (a: DingTalkAccountOwner, b: DingTalkAccountOwner): boolean => JSON.stringify(a) === JSON.stringify(b)
const sameHash = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** Mount explicitly in the existing Fastify composition; this module starts no
 * listener and installs no alternate team/session authentication. */
export async function registerDingTalkAccountRoutes(app: FastifyInstance, ports: DingTalkAccountServerPorts): Promise<void> {
  const origin = new URL(ports.publicOrigin)
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) throw new Error('DingTalk account callback requires an exact configured HTTPS origin')
  const callback = new URL('/api/integrations/dingtalk/accounts/callback', origin).href
  async function vendor(url: string, body: unknown, token?: string): Promise<unknown> {
    const response = await ports.fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', ...(token ? { 'x-acs-dingtalk-access-token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) })
    const chunks: Uint8Array[] = []; let size = 0; const reader = response.body?.getReader()
    try { if (reader) for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('response capacity') }; chunks.push(part.value) } } finally { reader?.releaseLock() }
    if (!response.ok || response.redirected) throw new TeamServiceError('DINGTALK_VENDOR_REJECTED', 'DingTalk authorization could not be verified', 502)
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }
  async function device(request: FastifyRequest): Promise<DingTalkAccountOwner> {
    if (request.headers.origin !== undefined || request.headers.cookie !== undefined) throw new TeamServiceError('FORBIDDEN', 'DingTalk account operations require native device authentication', 403)
    const owner = dingTalkAccountOwnerSchema.parse(await ports.requireDevice(request))
    if (owner.serviceBinding !== ports.serviceBinding) throw new TeamServiceError('FORBIDDEN', 'Account service identity changed', 403)
    await ports.assertOwner(owner); return owner
  }
  const common = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, bodyLimit: 8192 }
  app.post('/api/integrations/dingtalk/accounts/authorize', common, async request => {
    const owner = await device(request)
    const input = z.object({ nativeSubject: id, appId: z.string().uuid(), appRevision: z.number().int().positive(), appKey: id, corpId: id, requestId: z.string().uuid() }).strict().parse(request.body)
    if (owner.nativeSubject !== input.nativeSubject) throw new TeamServiceError('FORBIDDEN', 'Native account identity mismatch', 403)
    const credentials = await ports.credentials(owner, input.appId)
    if (credentials.appRevision !== input.appRevision || credentials.appKey !== input.appKey || credentials.corpId !== input.corpId) throw new TeamServiceError('CONFLICT', 'Server application setup does not match the native application revision', 409)
    const state = `${randomBytes(32).toString('hex')}.${randomBytes(32).toString('hex')}`, nonce = state.split('.')[1]
    if (!nonce) throw new Error('nonce generation failed')
    const authorizationId = randomUUID(), expiresAt = Date.now() + 300000
    ports.store.change(store => {
      if (store.entries.some(item => sameOwner(item.owner, owner) && item.requestId === input.requestId)) throw new TeamServiceError('CONFLICT', 'The original authorization intent already exists', 409)
      // Pending expired states may be removed; claimed identity/revocation rows
      // stay durable so old claims never create a new binding after unlink.
      store.entries = store.entries.filter(item => item.expiresAt > Date.now() || !['pending', 'processing', 'unknown'].includes(item.state))
      if (store.entries.length >= 1000) throw new TeamServiceError('CAPACITY', 'Account authorization capacity reached', 409)
      store.entries.push({ id: authorizationId, owner, appId: input.appId, appRevision: input.appRevision, requestId: input.requestId, stateHash: hash(state), nonceHash: hash(nonce), expiresAt, state: 'pending', identity: null })
    })
    const url = new URL('https://login.dingtalk.com/oauth2/auth')
    for (const [key, value] of Object.entries({ redirect_uri: callback, response_type: 'code', client_id: credentials.appKey, scope: 'openid corpid', prompt: 'consent', state })) url.searchParams.set(key, value)
    return { authorizationId, expiresAt, browserUrl: url.href, serviceBinding: ports.serviceBinding }
  })
  app.get('/api/integrations/dingtalk/accounts/callback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
    const finished = (ok: boolean) => reply.code(ok ? 200 : 400).type('text/plain; charset=utf-8').send(ok ? 'DingTalk identity verified. Return to the native application to claim it.' : 'DingTalk authorization was not completed. Return to the native application to review the original request.')
    if (request.headers.host !== origin.host) return finished(false)
    const parsed = z.object({ state: z.string().regex(/^[a-f0-9]{64}\.[a-f0-9]{64}$/), authCode: z.string().min(1).max(4096).optional(), error: z.string().max(256).optional() }).strict().safeParse(request.query)
    if (!parsed.success) return finished(false)
    const stateHash = hash(parsed.data.state), nonce = parsed.data.state.split('.')[1]
    if (!nonce) return finished(false)
    const intent = ports.store.read().entries.find(item => sameHash(item.stateHash, stateHash) && sameHash(item.nonceHash, hash(nonce)))
    if (!intent || intent.state !== 'pending' || intent.expiresAt <= Date.now()) return finished(false)
    // The state is consumed durably before token exchange. Duplicate callbacks,
    // crashes and unknown vendor results can never reuse this authCode.
    ports.store.change(store => { const current = store.entries.find(item => item.id === intent.id); if (!current || current.state !== 'pending') throw new TeamServiceError('CONFLICT', 'Authorization state consumed', 409); current.state = 'processing' })
    try {
      if (parsed.data.error || !parsed.data.authCode) throw new Error('authorization declined')
      await ports.assertOwner(intent.owner)
      const credentials = await ports.credentials(intent.owner, intent.appId)
      if (credentials.appRevision !== intent.appRevision) throw new Error('app revision changed')
      const token = z.object({ accessToken: z.string().min(1).max(8192), corpId: id, expireIn: z.number().int().positive() }).parse(await vendor('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', { clientId: credentials.appKey, clientSecret: credentials.appSecret, code: parsed.data.authCode, grantType: 'authorization_code' }))
      if (token.corpId !== credentials.corpId) throw new Error('foreign organization')
      const me = z.object({ unionId: id, nick: z.string().max(256).optional() }).parse(await vendor('https://api.dingtalk.com/v1.0/contact/users/me', undefined, token.accessToken))
      const appToken = z.object({ accessToken: z.string().min(1).max(8192) }).parse(await vendor('https://api.dingtalk.com/v1.0/oauth2/accessToken', { appKey: credentials.appKey, appSecret: credentials.appSecret }))
      const mapping = new URL('https://oapi.dingtalk.com/topapi/user/getbyunionid'); mapping.searchParams.set('access_token', appToken.accessToken)
      const member = z.object({ errcode: z.literal(0), result: z.object({ userid: id }) }).parse(await vendor(mapping.href, { unionid: me.unionId }))
      await ports.assertOwner(intent.owner)
      const currentCredentials = await ports.credentials(intent.owner, intent.appId)
      if (currentCredentials.appRevision !== intent.appRevision) throw new Error('app revision changed')
      ports.store.change(store => { const current = store.entries.find(item => item.id === intent.id); if (!current || current.state !== 'processing') throw new Error('authorization changed'); current.identity = { unionId: me.unionId, staffId: member.result.userid, corpId: token.corpId, displayName: me.nick ?? '', serviceBinding: ports.serviceBinding }; current.state = 'ready' })
      return finished(true)
    } catch { ports.store.change(store => { const current = store.entries.find(item => item.id === intent.id); if (current?.state === 'processing') current.state = 'unknown' }); return finished(false) }
  })
  app.post('/api/integrations/dingtalk/accounts/claim', common, async request => {
    const owner = await device(request), input = z.object({ nativeSubject: id, appId: z.string().uuid(), appRevision: z.number().int().positive(), authorizationId: z.string().uuid() }).strict().parse(request.body)
    if (input.nativeSubject !== owner.nativeSubject) throw new TeamServiceError('FORBIDDEN', 'Native subject mismatch', 403)
    const credentials = await ports.credentials(owner, input.appId)
    if (credentials.appRevision !== input.appRevision) throw new TeamServiceError('CONFLICT', 'Application revision changed', 409)
    return ports.store.change(store => {
      const intent = store.entries.find(item => item.id === input.authorizationId && item.appId === input.appId && item.appRevision === input.appRevision && sameOwner(item.owner, owner))
      if (!intent || !['ready', 'claimed'].includes(intent.state) || !intent.identity || intent.expiresAt <= Date.now()) throw new TeamServiceError('DINGTALK_NOT_READY', 'The original verified identity is unavailable or expired', 409)
      intent.state = 'claimed'; return intent.identity
    })
  })
  app.post('/api/integrations/dingtalk/accounts/unlink', common, async request => {
    const owner = await device(request), input = z.object({ nativeSubject: id, appId: z.string().uuid(), unionId: id, staffId: id }).strict().parse(request.body)
    if (input.nativeSubject !== owner.nativeSubject) throw new TeamServiceError('FORBIDDEN', 'Native subject mismatch', 403)
    ports.store.change(store => { for (const item of store.entries) if (sameOwner(item.owner, owner) && item.appId === input.appId && item.identity?.unionId === input.unionId && item.identity.staffId === input.staffId) item.state = 'revoked' })
    return null
  })
}
