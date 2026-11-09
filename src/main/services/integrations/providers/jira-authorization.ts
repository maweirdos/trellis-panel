import { shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { JIRA_OAUTH_CALLBACK_PATH, JIRA_OAUTH_SCOPES } from '../../../../shared/integrations'
import { jiraOAuthRelaySchema, jiraOAuthRelayPollSchema, type JiraOAuthRelay } from '../../../../shared/jira-auth'
import { protectSecret, revealSecret } from '../credentials'
import { legacyConnections } from '../legacy'
import { readIntegrationState, updateIntegrationState, type StoredConnection } from '../repository'
import { integrationFetch, readRemoteJson } from '../transport'
import { IntegrationError, type AuthorizationPort, type ResolvedConnection } from '../types'

const tokensSchema = z.object({
  baseUrl: z.string(), clientId: z.string(), redirectUri: z.string(),
  accessToken: z.string().min(1).max(8192), refreshToken: z.string().min(1).max(8192),
  expiresAt: z.number().finite().positive(), scopes: z.array(z.string().max(80)).max(30),
  refreshAttempt: z.string().optional()
}).strict()
type Tokens = z.infer<typeof tokensSchema>
const tokenResponseSchema = z.object({
  token_type: z.string(), access_token: z.string().min(1).max(8192), refresh_token: z.string().min(1).max(8192),
  expires_in: z.number().finite().positive().max(365 * 24 * 3600), scope: z.string().max(2400).optional()
})
const accountSchema = z.object({ key: z.string().min(1).max(512).optional(), name: z.string().min(1).max(512), active: z.boolean() })
const refreshes = new Map<string, Promise<string>>()
const verifiedAccounts = new Map<string, number>()
const accountChecks = new Map<string, Promise<void>>()

export function assertJiraCurrent(c: ResolvedConnection): StoredConnection | undefined {
  if (c.public.providerId !== 'jira' || !c.public.enabled) throw new IntegrationError('请启用 Jira 连接', 'denied')
  if (c.public.legacy) {
    if (!legacyConnections().some(item => item.id === c.public.id && item.revision === c.public.revision && item.enabled)) throw new IntegrationError('Jira 连接已变更，请刷新', 'conflict')
    return undefined
  }
  const stored = readIntegrationState().connections.find(item => item.id === c.public.id && !item.deleted)
  if (!stored?.enabled || stored.revision !== c.public.revision) throw new IntegrationError('Jira 连接已变更，请刷新', 'conflict')
  return stored
}
export function jiraOAuthMetadata(c: ResolvedConnection): { baseUrl: string; clientId: string; redirectUri: string; clientSecret: string } {
  const { baseUrl, clientId, redirectUri } = c.public.config
  let base: URL, redirect: URL
  try { base = new URL(baseUrl); redirect = new URL(redirectUri) } catch { throw new IntegrationError('请配置 Jira HTTPS 实例、Client ID、Client Secret 和团队服务 HTTPS 回调地址') }
  if (c.public.legacy || c.public.config.authMethod !== 'oauth2' || !clientId || !c.secrets.clientSecret) throw new IntegrationError('请先保存完整的 Jira OAuth 客户端配置', 'denied')
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== JIRA_OAUTH_CALLBACK_PATH) throw new IntegrationError('Jira OAuth 需要 HTTPS 实例和已配对团队服务的 /auth/jira/callback HTTPS 回调地址')
  return { baseUrl, clientId, redirectUri, clientSecret: c.secrets.clientSecret }
}
export function validateJiraConnection(c: ResolvedConnection): void {
  if (c.public.config.authMethod === 'oauth2') jiraOAuthMetadata(c)
}

/** Pin the authenticated actor independently from the immutable source namespace. */
export async function verifyJiraAccount(c: ResolvedConnection, authorization: string, signal?: AbortSignal): Promise<{ id: string; name: string; displayName: string }> {
  const { body } = await readRemoteJson(c.public.config.baseUrl + '/rest/api/2/myself', { headers: { Authorization: authorization }, signal })
  const parsed = accountSchema.safeParse(body)
  if (!parsed.success || !parsed.data.active) throw new IntegrationError('Jira 未返回有效的活动账号身份', 'denied')
  const account = { id: parsed.data.key ?? parsed.data.name, name: parsed.data.name }
  const current = assertJiraCurrent(c)
  if (current) {
    if (current.jiraAccount ? current.jiraAccount.id !== account.id : Boolean(current.jiraSourceUser) && current.jiraSourceUser !== account.name) throw new IntegrationError('Jira 账号与此连接原有来源不一致，请使用原账号或新建连接', 'denied')
  }
  const displayName = body && typeof body === 'object' && 'displayName' in body && typeof body.displayName === 'string' ? body.displayName.slice(0, 200) : account.name
  return { ...account, displayName }
}
function pinAccount(c: ResolvedConnection, account: { id: string; name: string }): void {
  updateIntegrationState(state => {
    const current = state.connections.find(item => item.id === c.public.id && !item.deleted)
    if (!current?.enabled || current.revision !== c.public.revision) throw new IntegrationError('连接已变更，未保存 Jira 身份', 'conflict')
    if (current.jiraAccount && current.jiraAccount.id !== account.id) throw new IntegrationError('Jira 账号已变化，请新建连接', 'denied')
    current.jiraAccount = { id: account.id, name: account.name }
  })
}
function currentTokens(c: ResolvedConnection): { tokens: Tokens; encrypted: string } {
  const metadata = jiraOAuthMetadata(c), stored = assertJiraCurrent(c), encrypted = stored?.secrets.oauthTokens
  if (!encrypted) throw new IntegrationError('Jira 尚未授权，请进行浏览器授权登录', 'denied')
  let raw: unknown
  try { raw = JSON.parse(revealSecret(encrypted)) } catch { throw new IntegrationError('Jira 授权无法读取，请重新登录', 'denied') }
  const parsed = tokensSchema.safeParse(raw)
  if (!parsed.success || parsed.data.baseUrl !== metadata.baseUrl || parsed.data.clientId !== metadata.clientId || parsed.data.redirectUri !== metadata.redirectUri) throw new IntegrationError('Jira 授权与当前实例或应用不匹配，请重新登录', 'denied')
  if (parsed.data.refreshAttempt) throw new IntegrationError('上次 Jira 凭据刷新结果未知，请重新进行浏览器授权登录', 'uncertain')
  return { tokens: parsed.data, encrypted }
}
function tokensFrom(c: ResolvedConnection, raw: unknown): Tokens {
  const response = tokenResponseSchema.safeParse(raw)
  if (!response.success || response.data.token_type.toLowerCase() !== 'bearer') throw new IntegrationError('Jira 未返回完整的可刷新 Bearer 凭证，请重新授权', 'upstream')
  const granted = response.data.scope?.split(/\s+/).filter(Boolean) ?? [...JIRA_OAUTH_SCOPES]
  if (!granted.includes('WRITE')) throw new IntegrationError('Jira 授权缺少 WRITE 权限，请重新授权', 'denied')
  return tokensSchema.parse({ baseUrl: c.public.config.baseUrl, clientId: c.public.config.clientId, redirectUri: c.public.config.redirectUri, accessToken: response.data.access_token, refreshToken: response.data.refresh_token, expiresAt: Date.now() + response.data.expires_in * 1000, scopes: granted })
}
async function exchange(c: ResolvedConnection, parameters: Record<string, string>, signal?: AbortSignal): Promise<Tokens> {
  const metadata = jiraOAuthMetadata(c)
  const response = await integrationFetch(metadata.baseUrl + '/rest/oauth2/latest/token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...parameters, redirect_uri: metadata.redirectUri, client_id: metadata.clientId, client_secret: metadata.clientSecret }), signal
  })
  if (!response.ok) throw new IntegrationError(response.status === 400 || response.status === 401 || response.status === 403 ? 'Jira 拒绝了授权或客户端凭证，请核对应用设置并重新登录' : 'Jira 凭据交换结果无法核实，请重新登录', response.status >= 500 ? 'uncertain' : 'denied')
  let body: unknown
  try { body = await response.json() } catch { throw new IntegrationError('Jira 凭据响应无法核实，请重新登录', 'upstream') }
  return tokensFrom(c, body)
}

/** One owner and one durable pre-dispatch marker prevent replay after rotating-token response loss. */
export async function jiraOAuthAccessToken(c: ResolvedConnection): Promise<string> {
  const key = c.public.id + ':' + c.public.revision
  const running = refreshes.get(key)
  if (running) return running
  const original = currentTokens(c)
  if (original.tokens.expiresAt > Date.now() + 30000) return original.tokens.accessToken
  const pending = (async (): Promise<string> => {
    // No await before publication: every later owner request sees this attempt.
    const marked = protectSecret(JSON.stringify({ ...original.tokens, refreshAttempt: randomBytes(32).toString('base64url') }))
    updateIntegrationState(state => {
      const current = state.connections.find(item => item.id === c.public.id && !item.deleted)
      if (!current?.enabled || current.revision !== c.public.revision || current.secrets.oauthTokens !== original.encrypted) throw new IntegrationError('Jira 授权已更新，请刷新', 'conflict')
      current.secrets.oauthTokens = marked
    })
    try {
      const tokens = await exchange(c, { grant_type: 'refresh_token', refresh_token: original.tokens.refreshToken })
      const encrypted = protectSecret(JSON.stringify(tokens))
      updateIntegrationState(state => {
        const current = state.connections.find(item => item.id === c.public.id && !item.deleted)
        if (!current?.enabled || current.revision !== c.public.revision || current.secrets.oauthTokens !== marked) throw new IntegrationError('Jira 凭据刷新后连接已变更，请重新登录', 'conflict')
        current.secrets.oauthTokens = encrypted
      })
      return tokens.accessToken
    } catch (error) {
      // Even a successful remote rotation whose response/save was lost cannot reuse the old refresh token.
      if (error instanceof IntegrationError && error.kind === 'denied') throw error
      throw new IntegrationError('Jira 凭据刷新结果未知，请重新登录；已提交的工单操作需先核实原结果', 'uncertain')
    }
  })()
  refreshes.set(key, pending)
  try { return await pending } finally { if (refreshes.get(key) === pending) refreshes.delete(key) }
}

/** Rechecked on every transport request, including every page and post-write reconciliation. */
export async function jiraAuthorizationHeader(c: ResolvedConnection, signal?: AbortSignal): Promise<string> {
  const stored = assertJiraCurrent(c), method = c.public.config.authMethod ?? 'basic'
  if (method === 'oauth2') {
    const token = await jiraOAuthAccessToken(c)
    assertJiraCurrent(c)
    return 'Bearer ' + token
  }
  let header: string
  if (method === 'token') {
    if (!c.secrets.token) throw new IntegrationError('请配置 Jira PAT', 'denied')
    header = 'Bearer ' + c.secrets.token
  } else {
    if (method !== 'basic' || !c.public.config.user || !c.secrets.password) throw new IntegrationError('请配置 Jira 用户名和密码', 'denied')
    header = 'Basic ' + Buffer.from(c.public.config.user + ':' + c.secrets.password).toString('base64')
  }
  if (stored && verifiedAccounts.get(c.public.id) !== c.public.revision) {
    const key = c.public.id + ':' + c.public.revision
    let checking = accountChecks.get(key)
    if (!checking) {
      checking = (async () => {
        const account = await verifyJiraAccount(c, header, signal)
        pinAccount(c, account)
        verifiedAccounts.set(c.public.id, c.public.revision)
      })()
      accountChecks.set(key, checking)
    }
    try { await checking } finally { if (accountChecks.get(key) === checking) accountChecks.delete(key) }
  }
  assertJiraCurrent(c)
  return header
}

export async function jiraRelayRequest(relay: JiraOAuthRelay, operation: 'poll' | 'cancel', signal?: AbortSignal): Promise<unknown> {
  const origin = new URL(relay.redirectUri).origin
  const { body } = await readRemoteJson(origin + '/api/integrations/jira/oauth/relay/' + encodeURIComponent(relay.relayId) + '/' + operation, { method: 'POST', headers: { Authorization: 'Bearer ' + relay.claimSecret, 'Content-Type': 'application/json' }, body: '{}', signal })
  const reply = z.object({ ok: z.literal(true), value: z.unknown() }).safeParse(body)
  if (!reply.success) throw new IntegrationError('Jira HTTPS 回调服务未返回有效响应', 'upstream')
  return reply.data.value
}
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = (): void => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new IntegrationError('Jira 授权已取消', 'denied')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, 350)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
  })
}
export async function authorizeJira(c: ResolvedConnection, signal: AbortSignal, rawRelay?: JiraOAuthRelay): ReturnType<AuthorizationPort['authorize']> {
  const metadata = jiraOAuthMetadata(c), relay = jiraOAuthRelaySchema.safeParse(rawRelay)
  if (!relay.success || relay.data.redirectUri !== metadata.redirectUri || relay.data.expiresAt <= Date.now() || relay.data.expiresAt > Date.now() + 5 * 60_000 + 10000) throw new IntegrationError('请先连接此 HTTPS 团队服务的配对设备，再重新发起 Jira 授权', 'denied')
  assertJiraCurrent(c)
  const verifier = randomBytes(32).toString('base64url')
  const url = new URL(metadata.baseUrl + '/rest/oauth2/latest/authorize')
  url.search = new URLSearchParams({ client_id: metadata.clientId, redirect_uri: metadata.redirectUri, response_type: 'code', scope: JIRA_OAUTH_SCOPES.join(' '), state: relay.data.state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString()
  const controller = new AbortController()
  const timeout = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(Math.min(5 * 60_000, relay.data.expiresAt - Date.now()))])
  const receive = async (): ReturnType<AuthorizationPort['authorize']> => {
    for (;;) {
      const poll = jiraOAuthRelayPollSchema.safeParse(await jiraRelayRequest(relay.data, 'poll', timeout))
      if (!poll.success) throw new IntegrationError('Jira 回调结果无效，请重新登录', 'upstream')
      if (poll.data.status === 'denied') throw new IntegrationError('浏览器拒绝了 Jira 授权，请重新登录', 'denied')
      if (poll.data.status === 'complete') {
        assertJiraCurrent(c)
        const tokens = await exchange(c, { grant_type: 'authorization_code', code: poll.data.code, code_verifier: verifier }, timeout)
        const account = await verifyJiraAccount(c, 'Bearer ' + tokens.accessToken, timeout)
        if (timeout.aborted) throw new IntegrationError('Jira 授权已取消，未保存凭证', 'denied')
        return { jiraAccount: account, secrets: { oauthTokens: JSON.stringify(tokens) }, detail: '浏览器授权成功 · ' + account.displayName }
      }
      await pause(timeout)
    }
  }
  let receiving: ReturnType<AuthorizationPort['authorize']> | undefined
  try {
    if (timeout.aborted) throw new IntegrationError('Jira 授权已取消', 'denied')
    // Arm polling before opening the browser. Jira codes default to a ten-second lifetime;
    // exchange as soon as the callback arrives, independently of shell-open acknowledgement.
    receiving = receive()
    const [, grant] = await Promise.all([shell.openExternal(url.href), receiving])
    return grant
  } catch (error) {
    if (error instanceof IntegrationError) throw error
    throw new IntegrationError(timeout.aborted ? 'Jira 授权已取消或超时，请重新登录' : 'Jira 浏览器授权失败，请核对 HTTPS 回调、客户端凭据与团队设备连接', 'upstream')
  } finally {
    controller.abort()
    await receiving?.catch(() => {})
    try { await jiraRelayRequest(relay.data, 'cancel', AbortSignal.timeout(3000)) } catch { /* The bounded relay expires without retaining tokens or device credentials. */ }
  }
}
export async function inspectJiraConnection(c: ResolvedConnection): Promise<string> {
  const header = await jiraAuthorizationHeader(c)
  const account = await verifyJiraAccount(c, header)
  if (!c.public.legacy) pinAccount(c, account)
  return 'Jira 认证成功 · ' + account.displayName
}
export const jiraAuthorization: AuthorizationPort = { authorize: (c, signal) => authorizeJira(c, signal) }
