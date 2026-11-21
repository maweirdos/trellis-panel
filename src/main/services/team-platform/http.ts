import { z } from 'zod'
import { TEAM_MAX_REQUEST_BYTES, TEAM_MAX_RESPONSE_BYTES, teamApiReplySchema } from '../../../shared/team-platform'
import { TEAM_AUTH_OPTIONS_CAPABILITY_HEADER, TEAM_AUTH_OPTIONS_INITIAL_TASK_TYPES } from '../../../shared/team-auth'
import { DesktopTeamError, type TeamTransportFailure } from './types'

const commandDenials = new WeakSet<DesktopTeamError>()
const verifiedCommandDenials = new WeakSet<DesktopTeamError>()
const revisionConflicts = new WeakSet<DesktopTeamError>()
const terminalRevisionConflicts = new WeakSet<DesktopTeamError>()
const receivedRateLimits = new WeakSet<DesktopTeamError>()
/** Only a validated response from the actual HTTP exchange can mark a throttle. */
export const isReceivedTeamRateLimit = (error: unknown): error is DesktopTeamError => error instanceof DesktopTeamError && receivedRateLimits.has(error)
function transportFailure(target: URL, method: 'GET' | 'POST', status: number | null, retryAfterMs: number | null, reason: TeamTransportFailure['reason']): TeamTransportFailure {
  const names = new Set(['api', 'auth', 'session', 'projects', 'crux', 'tasks', 'executions', 'inputs', 'resources', 'artifacts', 'commands', 'reconcile', 'cutovers', 'local', 'login', 'register', 'logout'])
  return { method, status, retryAfterMs, reason, route: '/' + target.pathname.split('/').filter(Boolean).map(part => names.has(part) ? part : ':id').join('/').slice(0, 500) }
}
function retryAfter(response: Response): number | null {
  const value = response.headers.get('retry-after')
  if (value === null || value.length > 128) return null
  const ms = /^\d+$/.test(value.trim()) ? Number(value.trim()) * 1000 : Math.max(0, Date.parse(value) - Date.now())
  return Number.isFinite(ms) && ms >= 0 && ms <= 86_400_000 ? Math.ceil(ms) : null
}
function isConnectionReset(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; cause?: unknown }
  return value.code === 'ECONNRESET' || Boolean(value.cause && typeof value.cause === 'object'
    && (value.cause as { code?: unknown }).code === 'ECONNRESET')
}
export const isCruxCommandDenial = (error: unknown): error is DesktopTeamError => error instanceof DesktopTeamError && commandDenials.has(error)
export const isVerifiedCruxCommandDenial = (error: unknown): boolean => error instanceof DesktopTeamError && verifiedCommandDenials.has(error)
export function verifyCruxCommandDenial(error: DesktopTeamError): void {
  if (!commandDenials.has(error)) throw new DesktopTeamError('FORBIDDEN', '无法核实原业务拒绝')
  verifiedCommandDenials.add(error)
}
export const isCruxRevisionConflict = (error: unknown): error is DesktopTeamError => error instanceof DesktopTeamError && revisionConflicts.has(error)
export const isTerminalCruxRevisionConflict = (error: unknown): boolean => error instanceof DesktopTeamError && terminalRevisionConflicts.has(error)
export function verifyTerminalCruxRevisionConflict(error: DesktopTeamError): void {
  if (!revisionConflicts.has(error)) throw new DesktopTeamError('RECONCILE_REQUIRED', '缺少原命令的版本拒绝来源', true)
  terminalRevisionConflicts.add(error)
}

export function canonicalTeamOrigin(raw: string, allowLoopbackHttp = false): string {
  let url: URL
  try { url = new URL(raw) } catch { throw new DesktopTeamError('INVALID_ORIGIN', '请输入完整的团队服务 HTTPS 地址') }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(allowLoopbackHttp && local && url.protocol === 'http:'))) throw new DesktopTeamError('INVALID_ORIGIN', '团队服务必须是无凭据、参数或子路径的 HTTPS 来源；HTTP 仅用于显式环回测试')
  return url.origin
}
export function verificationUrl(origin: string, raw: string, pairingId: string): string {
  let url: URL
  try { url = new URL(raw) } catch { throw new DesktopTeamError('INVALID_PAIRING_URL', '配对网址无法核实，未打开浏览器') }
  if (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== '/' || url.searchParams.size !== 1 || url.searchParams.get('pairing') !== pairingId) throw new DesktopTeamError('INVALID_PAIRING_URL', '配对网址不属于原服务的明确配对入口')
  return url.href
}
export type TeamFetch = (url: string, init: RequestInit) => Promise<Response>
export type TeamBrowserCredentials = { cookie: string; csrfToken: string }
export type TeamHttpReply<T> = { value: T; setCookies: string[] }
export class TeamHttp {
  constructor(private readonly fetcher: TeamFetch, private readonly timeoutMs: number) {}
  private async exchange(origin: string, path: string, route: 'api' | 'local-auth', headers: Record<string, string>, body: unknown | undefined, outcomeUnknown: boolean, rejectDeviceAuthorization: boolean, deadline?: number): Promise<{ response: Response; raw: unknown; transport: TeamTransportFailure }> {
    const target = new URL(path, origin)
    const routeAllowed = route === 'api' ? target.pathname.startsWith('/api/') : /^\/auth\/(?:local\/(?:login|register)|logout)$/.test(target.pathname) && !target.search
    if (!path.startsWith('/') || target.origin !== origin || !routeAllowed || target.hash || target.username || target.password) throw new DesktopTeamError('INVALID_ROUTE', '团队请求不能转向其他来源')
    const text = body === undefined ? undefined : JSON.stringify(body)
    if (text !== undefined && Buffer.byteLength(text) > TEAM_MAX_REQUEST_BYTES) throw new DesktopTeamError('CAPACITY_EXCEEDED', '团队请求 JSON 封装超过限界')
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(this.timeoutMs, deadline === undefined ? this.timeoutMs : deadline - Date.now())))
    let diagnostic = transportFailure(target, text === undefined ? 'GET' : 'POST', null, null, 'network')
    let commandForbidden = false
    try {
      const fetchOnce = (): Promise<Response> => this.fetcher(target.href, { method: text === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', ...(text === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: text, redirect: 'manual', credentials: 'omit', signal: controller.signal })
      let response: Response
      try { response = await fetchOnce() }
      catch (error) {
        // A stale keep-alive socket can reset before any response headers.
        // Only a read may reconnect once, within the original deadline.
        if (text !== undefined || controller.signal.aborted || !isConnectionReset(error)) throw error
        await new Promise<void>(resolve => setImmediate(resolve))
        if (controller.signal.aborted) throw error
        response = await fetchOnce()
      }
      diagnostic = transportFailure(target, text === undefined ? 'GET' : 'POST', response.status, retryAfter(response), 'http')
      const discard = async (): Promise<void> => { try { await response.body?.cancel() } catch { /* Known HTTP identity/status still controls classification. */ } }
      if (response.status >= 300 && response.status < 400) { await discard(); throw new DesktopTeamError('REDIRECT_REJECTED', '团队服务返回了重定向，原凭据不会转发', outcomeUnknown) }
      if (response.url) {
        let actual: URL
        try { actual = new URL(response.url) } catch { await discard(); throw new DesktopTeamError('INVALID_RESPONSE', '团队响应来源无法核实', outcomeUnknown) }
        if (actual.origin !== origin) { await discard(); throw new DesktopTeamError('REDIRECT_REJECTED', '团队响应来源不匹配', outcomeUnknown) }
      }
      if (rejectDeviceAuthorization && (response.status === 401 || response.status === 403)) {
        commandForbidden = response.status === 403 && body !== undefined && /^\/api\/projects\/[^/]+\/crux\/commands$/.test(path)
        if (!commandForbidden) {
          await discard()
          // A POST denial alone does not prove an earlier upstream write absent.
          throw new DesktopTeamError(response.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', response.status === 401 ? '团队服务拒绝了当前设备身份，旧共享缓存已锁定' : '当前资料或操作不可访问，请核对原授权范围', outcomeUnknown)
        }
      }
      const header = response.headers.get('content-length')
      if (header && Number(header) > TEAM_MAX_RESPONSE_BYTES) { await discard(); throw new DesktopTeamError('RESPONSE_LIMIT', '团队响应超过限界', outcomeUnknown) }
      if (!response.body) throw new DesktopTeamError('INVALID_RESPONSE', '团队响应缺少正文', outcomeUnknown)
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
      try { for (;;) { const read = await reader.read(); if (read.done) break; size += read.value.byteLength; if (size > TEAM_MAX_RESPONSE_BYTES) throw new DesktopTeamError('RESPONSE_LIMIT', '团队响应超过限界', outcomeUnknown); chunks.push(read.value) } }
      finally { await reader.cancel().catch(() => {}) }
      let raw: unknown
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { throw new DesktopTeamError('INVALID_RESPONSE', '团队响应无法解析，不能推断操作结果', outcomeUnknown) }
      if (commandForbidden) {
        const denial = teamApiReplySchema(z.unknown()).safeParse(raw)
        // This one deployed business rule is only a candidate until fresh native
        // identity/scope verification. Unknown 403s retain the authorization fence.
        if (denial.success && !denial.data.ok && denial.data.code === 'TASK_INPUT_TEMPLATE_ROLE_REQUIRED') {
          const error = new DesktopTeamError(denial.data.code, `团队服务未完成操作（${denial.data.code}）`, outcomeUnknown)
          commandDenials.add(error)
          throw error
        }
        throw new DesktopTeamError('FORBIDDEN', '当前资料或操作不可访问，请核对原授权范围', outcomeUnknown)
      }
      return { response, raw, transport: diagnostic }
    } catch (error) {
      if (commandForbidden && !isCruxCommandDenial(error)) throw new DesktopTeamError('FORBIDDEN', '原业务拒绝未通过受限响应验证，请核对原授权范围', outcomeUnknown)
      if (error instanceof DesktopTeamError) {
        error.transport ??= { ...diagnostic, reason: error.code === 'INVALID_RESPONSE' || error.code === 'RESPONSE_LIMIT' ? 'response' : diagnostic.reason }
        throw error
      }
      const failure = new DesktopTeamError(outcomeUnknown ? 'ACKNOWLEDGEMENT_UNKNOWN' : 'NETWORK_UNAVAILABLE', outcomeUnknown ? '发送后未取得明确确认，请保留原命令并核对' : '团队服务暂时无法连接，可明确查阅已缓存版本', outcomeUnknown)
      failure.transport = { ...diagnostic, reason: controller.signal.aborted ? 'timeout' : 'network' }
      throw failure
    } finally { clearTimeout(timer) }
  }
  private value<T extends z.ZodType>(schema: T, exchange: { response: Response; raw: unknown }, outcomeUnknown: boolean, path = ''): z.output<T> {
    const reply = teamApiReplySchema(schema).safeParse(exchange.raw)
    if (!reply.success) throw new DesktopTeamError('INVALID_RESPONSE', '团队响应未通过版本化契约验证', outcomeUnknown)
    if (!reply.data.ok) {
      // Remote prose may contain URLs or upstream diagnostics; expose stable
      // bounded code and local explanation, never an untrusted credential echo.
      const code = /^[A-Z0-9_:-]{1,100}$/.test(reply.data.code) ? reply.data.code : 'REMOTE_FAILURE'
      if (this.isRouteUnavailable(path, code, exchange.response.status)) throw new DesktopTeamError('DESKTOP_API_UNAVAILABLE', '当前团队服务版本缺少桌面端必需接口，请先升级团队服务；不会自动改用其他创建方式', outcomeUnknown)
      throw new DesktopTeamError(code, `团队服务未完成操作（${code}）`, outcomeUnknown && (exchange.response.status >= 500 || code === 'ACKNOWLEDGEMENT_UNKNOWN'))
    }
    if (!exchange.response.ok) throw new DesktopTeamError('INVALID_RESPONSE', '团队 HTTP 状态与业务回执不一致', outcomeUnknown)
    return reply.data.value
  }
  private isRouteUnavailable(path: string, code: string, status: number): boolean {
    return code === 'NOT_FOUND' && status === 404 && (path === '/api/auth/options' || path === '/api/organizations')
  }
  private setCookies(response: Response): string[] {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const values = headers.getSetCookie?.()
    if (values && values.length > 0) return values
    const combined = response.headers.get('set-cookie')
    return combined ? combined.split(/,\s*(?=[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/) : []
  }
  async request<T extends z.ZodType>(origin: string, path: string, schema: T, token?: string, body?: unknown, deadline?: number): Promise<z.output<T>> {
    const write = body !== undefined
    const exchange = await this.exchange(origin, path, 'api', token ? { Authorization: `Bearer ${token}` } : {}, body, write, true, deadline)
    try { return this.value(schema, exchange, write, path) }
    catch (error) {
      if (error instanceof DesktopTeamError) {
        error.transport = { ...exchange.transport, reason: error.code === 'INVALID_RESPONSE' ? 'contract' : 'http' }
        if (exchange.response.status === 429 && error.code !== 'INVALID_RESPONSE') receivedRateLimits.add(error)
      }
      if (write && exchange.response.status === 409 && /^\/api\/projects\/[^/]+\/crux\/commands$/.test(path) && error instanceof DesktopTeamError && error.code === 'REVISION_CONFLICT') revisionConflicts.add(error)
      throw error
    }
  }
  async authOptions<T extends z.ZodType>(origin: string, schema: T): Promise<TeamHttpReply<z.output<T>>> {
    const exchange = await this.exchange(origin, '/api/auth/options', 'api', { [TEAM_AUTH_OPTIONS_CAPABILITY_HEADER]: TEAM_AUTH_OPTIONS_INITIAL_TASK_TYPES }, undefined, false, false)
    return { value: this.value(schema, exchange, false, '/api/auth/options'), setCookies: this.setCookies(exchange.response) }
  }
  async localAuth<T extends z.ZodType>(origin: string, operation: 'login' | 'register', schema: T, challenge: TeamBrowserCredentials, body: unknown): Promise<TeamHttpReply<z.output<T>>> {
    const exchange = await this.exchange(origin, `/auth/local/${operation}`, 'local-auth', { Origin: origin, Cookie: challenge.cookie, 'X-CSRF-Token': challenge.csrfToken }, body, true, false)
    return { value: this.value(schema, exchange, true, `/auth/local/${operation}`), setCookies: this.setCookies(exchange.response) }
  }
  async browserRequest<T extends z.ZodType>(origin: string, path: string, schema: T, credentials: TeamBrowserCredentials, body?: unknown, outcomeUnknown = body !== undefined): Promise<z.output<T>> {
    const exchange = await this.exchange(origin, path, path === '/auth/logout' ? 'local-auth' : 'api', { Origin: origin, Cookie: credentials.cookie, 'X-CSRF-Token': credentials.csrfToken, 'X-Trellis-Session-Proof': credentials.csrfToken }, body, outcomeUnknown, false)
    const value = this.value(schema, exchange, outcomeUnknown, path)
    if (exchange.response.headers.get('x-trellis-session-verified') !== '1') throw new DesktopTeamError('SESSION_UNVERIFIED', '团队服务未确认原桌面账号会话，请升级匹配的服务端', outcomeUnknown)
    return value
  }
}
