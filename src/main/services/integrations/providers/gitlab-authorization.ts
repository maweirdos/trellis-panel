import { shell } from 'electron'
import { createServer } from 'node:http'
import { z } from 'zod'
import { GITLAB_OAUTH_REDIRECT_URI, GITLAB_OAUTH_SCOPES } from '../../../../shared/integrations'
import { protectSecret, revealSecret } from '../credentials'
import { readIntegrationState, updateIntegrationState } from '../repository'
import { integrationFetch, readRemoteJson, recordOf, textOf } from '../transport'
import { IntegrationError, type AuthorizationPort, type ResolvedConnection } from '../types'
import type { AuthorizationServer, Client, TokenEndpointResponse } from 'oauth4webapi'

const tokenSchema = z.object({
  baseUrl: z.string(), clientId: z.string(), accessToken: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192), expiresAt: z.number().finite().positive()
})
type Tokens = z.infer<typeof tokenSchema>
const refreshes = new Map<string, Promise<string>>()
let authorizing = false

function metadata(c: ResolvedConnection): { server: AuthorizationServer; client: Client } {
  const base = c.public.config.baseUrl
  if (c.public.providerId !== 'gitlab' || c.public.legacy || c.public.config.authMethod !== 'oauth2' || !c.public.config.clientId) {
    throw new IntegrationError('请先配置 GitLab 浏览器授权方式及 Application ID')
  }
  return { server: { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token` }, client: { client_id: c.public.config.clientId } }
}

function tokensFrom(c: ResolvedConnection, response: TokenEndpointResponse): Tokens {
  if (response.token_type !== 'bearer' || !response.refresh_token || !response.expires_in || !Number.isFinite(response.expires_in) || response.expires_in <= 0) {
    throw new IntegrationError('GitLab 未返回可刷新的 Bearer 凭证，请重新授权', 'upstream')
  }
  if (response.scope && GITLAB_OAUTH_SCOPES.some((scope) => !response.scope?.split(' ').includes(scope))) {
    throw new IntegrationError('GitLab 授权缺少 read_api / read_user 权限，请检查 OAuth 应用范围', 'denied')
  }
  const parsed = tokenSchema.safeParse({ baseUrl: c.public.config.baseUrl, clientId: c.public.config.clientId, accessToken: response.access_token, refreshToken: response.refresh_token, expiresAt: Date.now() + response.expires_in * 1000 })
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
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Trellis Panel</title><h1>已收到授权回调</h1><p>请返回 Trellis Panel 查看登录结果。可以关闭此页面。</p></html>', () => finish(undefined, callback))
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

export const gitlabAuthorization: AuthorizationPort = {
  async authorize(c, signal) {
    if (authorizing) throw new IntegrationError('已有浏览器授权进行中，请先完成或取消该授权', 'conflict')
    authorizing = true
    try {
      const oauth = await import('oauth4webapi')
      const { server, client } = metadata(c)
      const state = oauth.generateRandomState()
      const verifier = oauth.generateRandomCodeVerifier()
      const authorizationUrl = new URL(server.authorization_endpoint || '')
      authorizationUrl.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: GITLAB_OAUTH_REDIRECT_URI, response_type: 'code', scope: GITLAB_OAUTH_SCOPES.join(' '), state, code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' }).toString()
      const callback = await browserCallback(authorizationUrl, state, signal)
      const params = oauth.validateAuthResponse(server, client, callback, state)
      const options = { [oauth.customFetch]: integrationFetch, [oauth.allowInsecureRequests]: c.public.config.baseUrl.startsWith('http:'), signal }
      const response = await oauth.authorizationCodeGrantRequest(server, client, oauth.None(), params, GITLAB_OAUTH_REDIRECT_URI, verifier, options)
      const tokens = tokensFrom(c, await oauth.processAuthorizationCodeResponse(server, client, response))
      const user = await readRemoteJson(`${c.public.config.baseUrl}/api/v4/user`, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal })
      const username = textOf(recordOf(user.body).username).slice(0, 100)
      if (!username) throw new IntegrationError('授权后未取得 GitLab 用户身份', 'upstream')
      return { secrets: { oauthTokens: JSON.stringify(tokens) }, detail: `浏览器授权成功 · ${username}` }
    } catch (error) {
      if (error instanceof IntegrationError) throw error
      throw new IntegrationError(signal.aborted ? '授权已取消或超时' : 'GitLab 授权未完成，请检查 Application ID、回调地址、应用是否为非保密客户端及授权权限', 'upstream')
    } finally { authorizing = false }
  }
}

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
      const tokens = tokensFrom(c, await oauth.processRefreshTokenResponse(server, client, response))
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
