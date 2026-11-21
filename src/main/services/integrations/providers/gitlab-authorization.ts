import { shell } from 'electron'
import { createServer } from 'node:http'
import { z } from 'zod'
import { GITLAB_OAUTH_REDIRECT_URI, GITLAB_OAUTH_SCOPES } from '../../../../shared/integrations'
import { GITLAB_WRITE_SCOPES } from '../../../../shared/gitlab-integration'
import { protectSecret, revealSecret } from '../credentials'
import { readIntegrationState, updateIntegrationState } from '../repository'
import { integrationFetch, readRemoteJson, recordOf, textOf } from '../transport'
import { IntegrationError, verifiedGitlabIdentitySchema, type VerifiedGitlabIdentity, type AuthorizationPort, type ResolvedConnection } from '../types'
import type { AuthorizationServer, Client, TokenEndpointResponse } from 'oauth4webapi'

const tokenSchema = z.object({
  baseUrl: z.string(), clientId: z.string(), accessToken: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192), expiresAt: z.number().finite().positive(),
  scopes: z.array(z.string().max(80)).max(30).optional()
})
type Tokens = z.infer<typeof tokenSchema>
const refreshes = new Map<string, Promise<string>>()
let authorizing = false

export class GitlabIdentityMismatchError extends IntegrationError {
  constructor() { super('浏览器中的 GitLab 账号与团队登录账号不一致，请切换账号后重试', 'denied') }
}

export function normalizedGitlabIdentity(raw: VerifiedGitlabIdentity): VerifiedGitlabIdentity {
  const parsed = verifiedGitlabIdentitySchema.safeParse(raw)
  if (!parsed.success) throw new IntegrationError('团队 GitLab 登录身份无效', 'denied')
  const normalize = (value: string): string => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new IntegrationError('团队 GitLab 身份来源无效', 'denied')
    return url.href.replace(/\/+$/, '')
  }
  const identity = { ...parsed.data, issuer: normalize(parsed.data.issuer), baseUrl: normalize(parsed.data.baseUrl) }
  // GitLab 11.1+ OIDC sub is the decimal user ID. Older opaque subjects fail closed.
  if (identity.issuer !== identity.baseUrl || !/^[1-9]\d*$/.test(identity.subject)) throw new IntegrationError('无法将团队登录身份安全映射到此 GitLab 实例', 'denied')
  return identity
}

function requireExpectedIdentity(c: ResolvedConnection, identity: VerifiedGitlabIdentity): void {
  if (c.public.providerId !== 'gitlab' || c.public.legacy || c.public.config.authMethod !== 'oauth2' || c.public.config.baseUrl !== identity.baseUrl || c.public.config.clientId !== identity.clientId) throw new IntegrationError('GitLab 连接与已验证的团队身份不匹配', 'conflict')
}

function requireGitlabSubject(body: unknown, subject: string): void {
  const user = z.object({ id: z.number().int().positive().safe() }).safeParse(body)
  if (!user.success) throw new IntegrationError('GitLab 未返回有效的数字用户 ID', 'upstream')
  if (String(user.data.id) !== subject) throw new GitlabIdentityMismatchError()
}

/** Uses only an already protected native grant; never copies team-server tokens. */
export async function verifyGitlabConnectionIdentity(c: ResolvedConnection, raw: VerifiedGitlabIdentity, signal: AbortSignal, allowRefresh = false): Promise<void> {
  const identity = normalizedGitlabIdentity(raw)
  requireExpectedIdentity(c, identity)
  // Probing an unrelated account must not rotate or replace its credentials.
  const token = allowRefresh ? await gitlabOAuthAccessToken(c) : currentTokens(c).tokens.accessToken
  if (signal.aborted) throw new IntegrationError('GitLab 身份核验已取消', 'denied')
  const user = await readRemoteJson(`${identity.baseUrl}/api/v4/user`, { headers: { Authorization: `Bearer ${token}` }, signal })
  requireGitlabSubject(user.body, identity.subject)
}

function metadata(c: ResolvedConnection): { server: AuthorizationServer; client: Client } {
  const base = c.public.config.baseUrl
  if (c.public.providerId !== 'gitlab' || c.public.legacy || c.public.config.authMethod !== 'oauth2' || !c.public.config.clientId) {
    throw new IntegrationError('请先配置 GitLab 浏览器授权方式及 Application ID')
  }
  return { server: { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token` }, client: { client_id: c.public.config.clientId } }
}

function tokensFrom(c: ResolvedConnection, response: TokenEndpointResponse, requested: readonly string[] = GITLAB_OAUTH_SCOPES): Tokens {
  if (response.token_type !== 'bearer' || !response.refresh_token || !response.expires_in || !Number.isFinite(response.expires_in) || response.expires_in <= 0) {
    throw new IntegrationError('GitLab 未返回可刷新的 Bearer 凭证，请重新授权', 'upstream')
  }
  if (response.scope && requested.some((scope) => !response.scope?.split(' ').includes(scope))) {
    throw new IntegrationError('GitLab 授权缺少此次明确请求的权限，请检查 OAuth 应用范围', 'denied')
  }
  const parsed = tokenSchema.safeParse({ baseUrl: c.public.config.baseUrl, clientId: c.public.config.clientId, accessToken: response.access_token, refreshToken: response.refresh_token, expiresAt: Date.now() + response.expires_in * 1000, scopes: response.scope?.split(' ').filter(Boolean) ?? [...requested] })
  if (!parsed.success) throw new IntegrationError('GitLab 返回的凭证格式无效', 'upstream')
  return parsed.data
}

/** Only the exact loopback callback with this attempt's state can complete it. */
function browserCallback(authorizationUrl: URL, expectedState: string, signal: AbortSignal): Promise<URL> {
  return new Promise((resolve, reject) => {
    const redirect = new URL(GITLAB_OAUTH_REDIRECT_URI)
    let settled = false
    let received = false
    const finish = (error?: IntegrationError, url?: URL): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      server.close()
      server.closeAllConnections()
      if (error) reject(error)
      else if (url) resolve(url)
    }
    const abort = (): void => finish(new IntegrationError('授权已取消或超时，请重新发起登录', 'denied'))
    const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      let callback: URL
      try { callback = new URL(request.url || '/', redirect.origin) }
      catch { response.writeHead(400).end('Invalid callback'); return }
      if (request.method !== 'GET' || request.headers.host !== redirect.host || callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) {
        response.writeHead(404).end('Not found'); return
      }
      if (callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== expectedState) {
        response.writeHead(400).end('Invalid authorization state'); return
      }
      if (settled || received) { response.writeHead(409).end('Authorization already received'); return }
      received = true
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Crux</title><h1>已收到授权回调</h1><p>请返回 Crux 查看登录结果。可以关闭此页面。</p></html>', () => finish(undefined, callback))
    })
    server.headersTimeout = 10000
    server.requestTimeout = 10000
    server.once('error', () => finish(new IntegrationError('无法监听本机授权端口 17654，请关闭其他授权窗口或检查端口占用', 'io')))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    server.listen(Number(redirect.port), '127.0.0.1', () => {
      server.unref()
      if (signal.aborted || settled) { server.close(); server.closeAllConnections(); return }
      void shell.openExternal(authorizationUrl.href).catch(() => finish(new IntegrationError('无法打开系统浏览器，请检查默认浏览器设置', 'io')))
    })
  })
}

async function authorizeGitlab(c: ResolvedConnection, signal: AbortSignal, scopes: readonly string[], identity?: VerifiedGitlabIdentity): ReturnType<AuthorizationPort['authorize']> {
  const binding = readIntegrationState().connections.find((item) => item.id === c.public.id && !item.deleted)?.teamGitlab
  if (binding) {
    const boundIdentity = normalizedGitlabIdentity({ ...binding, provider: 'gitlab' })
    if (identity && (identity.issuer !== boundIdentity.issuer || identity.subject !== boundIdentity.subject || identity.baseUrl !== boundIdentity.baseUrl || identity.clientId !== boundIdentity.clientId)) throw new IntegrationError('GitLab 连接与已验证的团队身份不匹配', 'conflict')
    identity = boundIdentity
  }
  if (identity) requireExpectedIdentity(c, identity)
  if (authorizing) throw new IntegrationError('已有浏览器授权进行中，请先完成或取消该授权', 'conflict')
  authorizing = true
  try {
    const oauth = await import('oauth4webapi')
    const { server, client } = metadata(c)
    const state = oauth.generateRandomState()
    const verifier = oauth.generateRandomCodeVerifier()
    const authorizationUrl = new URL(server.authorization_endpoint || '')
    authorizationUrl.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: GITLAB_OAUTH_REDIRECT_URI, response_type: 'code', scope: scopes.join(' '), state, code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' }).toString()
    const callback = await browserCallback(authorizationUrl, state, signal)
    const params = oauth.validateAuthResponse(server, client, callback, state)
    const options = { [oauth.customFetch]: integrationFetch, [oauth.allowInsecureRequests]: c.public.config.baseUrl.startsWith('http:'), signal }
    const response = await oauth.authorizationCodeGrantRequest(server, client, oauth.None(), params, GITLAB_OAUTH_REDIRECT_URI, verifier, options)
    const tokens = tokensFrom(c, await oauth.processAuthorizationCodeResponse(server, client, response), scopes)
    const user = await readRemoteJson(`${c.public.config.baseUrl}/api/v4/user`, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal })
    if (identity) requireGitlabSubject(user.body, identity.subject)
    const username = textOf(recordOf(user.body).username).slice(0, 100)
    if (!username) throw new IntegrationError('授权后未取得 GitLab 用户身份', 'upstream')
    return { secrets: { oauthTokens: JSON.stringify(tokens) }, detail: identity ? '团队 GitLab 账号身份已核验' : `浏览器授权成功 · ${username}` }
  } catch (error) {
    if (error instanceof IntegrationError) throw error
    throw new IntegrationError(signal.aborted ? '授权已取消或超时' : 'GitLab 授权未完成，请检查 Application ID、回调地址、应用是否为非保密客户端及授权权限', 'upstream')
  } finally { authorizing = false }
}

/** Main-only constraint; expected identity is not part of renderer configuration. */
export async function authorizeGitlabForIdentity(c: ResolvedConnection, signal: AbortSignal, raw: VerifiedGitlabIdentity): ReturnType<AuthorizationPort['authorize']> {
  return authorizeGitlab(c, signal, GITLAB_OAUTH_SCOPES, normalizedGitlabIdentity(raw))
}
function authorizationFor(scopes: readonly string[]): AuthorizationPort {
  return { authorize: (connection, signal) => authorizeGitlab(connection, signal, scopes) }
}
export const gitlabAuthorization: AuthorizationPort = authorizationFor(GITLAB_OAUTH_SCOPES)
/** Explicit alternate flow; caller must fence/save through the current credential owner. */
export const gitlabWriteAuthorization: AuthorizationPort = authorizationFor(GITLAB_WRITE_SCOPES)

function currentTokens(c: ResolvedConnection): { tokens: Tokens; encrypted: string } {
  metadata(c)
  const stored = readIntegrationState().connections.find((item) => item.id === c.public.id && !item.deleted)
  if (!stored || !stored.enabled || stored.revision !== c.public.revision) throw new IntegrationError('连接已变更，请刷新后重试', 'conflict')
  const encrypted = stored.secrets.oauthTokens
  if (!encrypted) throw new IntegrationError('此 GitLab 连接尚未授权，请点击浏览器授权登录', 'denied')
  let raw: unknown
  try { raw = JSON.parse(revealSecret(encrypted)) }
  catch { throw new IntegrationError('保存的 GitLab 授权无法读取，请重新登录', 'denied') }
  const parsed = tokenSchema.safeParse(raw)
  if (!parsed.success || parsed.data.baseUrl !== c.public.config.baseUrl || parsed.data.clientId !== c.public.config.clientId) {
    throw new IntegrationError('授权与当前 GitLab 实例或应用不匹配，请重新登录', 'denied')
  }
  return { tokens: parsed.data, encrypted }
}

/** Refresh-token rotation is serialized and cannot overwrite a newer login/edit. */
export async function gitlabOAuthAccessToken(c: ResolvedConnection): Promise<string> {
  const current = currentTokens(c)
  if (current.tokens.expiresAt > Date.now() + 30000) return current.tokens.accessToken
  const key = `${c.public.id}:${c.public.revision}`
  const running = refreshes.get(key)
  if (running) return running
  const pending = (async (): Promise<string> => {
    try {
      const oauth = await import('oauth4webapi')
      const { server, client } = metadata(c)
      const options = { [oauth.customFetch]: integrationFetch, [oauth.allowInsecureRequests]: c.public.config.baseUrl.startsWith('http:') }
      const response = await oauth.refreshTokenGrantRequest(server, client, oauth.None(), current.tokens.refreshToken, options)
      const tokens = tokensFrom(c, await oauth.processRefreshTokenResponse(server, client, response), current.tokens.scopes ?? GITLAB_OAUTH_SCOPES)
      const encrypted = protectSecret(JSON.stringify(tokens))
      updateIntegrationState((state) => {
        const latest = state.connections.find((item) => item.id === c.public.id && !item.deleted)
        if (!latest || !latest.enabled || latest.revision !== c.public.revision || latest.secrets.oauthTokens !== current.encrypted) {
          throw new IntegrationError('授权已被其他操作更新，请刷新后重试', 'conflict')
        }
        latest.secrets.oauthTokens = encrypted
      })
      return tokens.accessToken
    } catch (error) {
      if (error instanceof IntegrationError) throw error
      throw new IntegrationError('GitLab 授权已过期或刷新失败，请重新进行浏览器授权登录', 'denied')
    }
  })()
  refreshes.set(key, pending)
  try { return await pending } finally { if (refreshes.get(key) === pending) refreshes.delete(key) }
}
