import { z } from 'zod'
import { TEAM_MAX_REQUEST_BYTES, TEAM_MAX_RESPONSE_BYTES, teamApiReplySchema } from '../../../shared/team-platform'
import { TEAM_AUTH_OPTIONS_CAPABILITY_HEADER, TEAM_AUTH_OPTIONS_INITIAL_TASK_TYPES } from '../../../shared/team-auth'
import { DesktopTeamError } from './types'

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
  private async exchange(origin: string, path: string, route: 'api' | 'local-auth', headers: Record<string, string>, body: unknown | undefined, outcomeUnknown: boolean, rejectDeviceAuthorization: boolean): Promise<{ response: Response; raw: unknown }> {
    const target = new URL(path, origin)
    const routeAllowed = route === 'api' ? target.pathname.startsWith('/api/') : /^\/auth\/(?:local\/(?:login|register)|logout)$/.test(target.pathname) && !target.search
    if (!path.startsWith('/') || target.origin !== origin || !routeAllowed || target.hash || target.username || target.password) throw new DesktopTeamError('INVALID_ROUTE', '团队请求不能转向其他来源')
    const text = body === undefined ? undefined : JSON.stringify(body)
    if (text !== undefined && Buffer.byteLength(text) > TEAM_MAX_REQUEST_BYTES) throw new DesktopTeamError('CAPACITY_EXCEEDED', '团队请求 JSON 封装超过限界')
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(target.href, { method: text === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', ...(text === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: text, redirect: 'manual', credentials: 'omit', signal: controller.signal })
      const discard = async (): Promise<void> => { try { await response.body?.cancel() } catch { /* Known HTTP identity/status still controls classification. */ } }
      if (response.status >= 300 && response.status < 400) { await discard(); throw new DesktopTeamError('REDIRECT_REJECTED', '团队服务返回了重定向，原凭据不会转发', outcomeUnknown) }
      if (response.url) {
        let actual: URL
        try { actual = new URL(response.url) } catch { await discard(); throw new DesktopTeamError('INVALID_RESPONSE', '团队响应来源无法核实', outcomeUnknown) }
        if (actual.origin !== origin) { await discard(); throw new DesktopTeamError('REDIRECT_REJECTED', '团队响应来源不匹配', outcomeUnknown) }
      }
      if (rejectDeviceAuthorization && (response.status === 401 || response.status === 403)) {
        await discard()
        // Even a reverse proxy's non-JSON access denial must lock stale cache.
        // A POST denial alone does not prove an earlier upstream write absent.
        throw new DesktopTeamError(response.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', response.status === 401 ? '团队服务拒绝了当前设备身份，旧共享缓存已锁定' : '当前资料或操作不可访问，请核对原授权范围', outcomeUnknown)
      }
      const header = response.headers.get('content-length')
      if (header && Number(header) > TEAM_MAX_RESPONSE_BYTES) { await discard(); throw new DesktopTeamError('RESPONSE_LIMIT', '团队响应超过限界', outcomeUnknown) }
      if (!response.body) throw new DesktopTeamError('INVALID_RESPONSE', '团队响应缺少正文', outcomeUnknown)
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
      try { for (;;) { const read = await reader.read(); if (read.done) break; size += read.value.byteLength; if (size > TEAM_MAX_RESPONSE_BYTES) throw new DesktopTeamError('RESPONSE_LIMIT', '团队响应超过限界', outcomeUnknown); chunks.push(read.value) } }
      finally { await reader.cancel().catch(() => {}) }
      let raw: unknown
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { throw new DesktopTeamError('INVALID_RESPONSE', '团队响应无法解析，不能推断操作结果', outcomeUnknown) }
      return { response, raw }
    } catch (error) {
      if (error instanceof DesktopTeamError) throw error
      throw new DesktopTeamError(outcomeUnknown ? 'ACKNOWLEDGEMENT_UNKNOWN' : 'NETWORK_UNAVAILABLE', outcomeUnknown ? '发送后未取得明确确认，请保留原命令并核对' : '团队服务暂时无法连接，可明确查阅已缓存版本', outcomeUnknown)
    } finally { clearTimeout(timer) }
  }
  private value<T extends z.ZodType>(schema: T, exchange: { response: Response; raw: unknown }, outcomeUnknown: boolean): z.output<T> {
    const reply = teamApiReplySchema(schema).safeParse(exchange.raw)
    if (!reply.success) throw new DesktopTeamError('INVALID_RESPONSE', '团队响应未通过版本化契约验证', outcomeUnknown)
    if (!reply.data.ok) {
      // Remote prose may contain URLs or upstream diagnostics; expose stable
      // bounded code and local explanation, never an untrusted credential echo.
      const code = /^[A-Z0-9_:-]{1,100}$/.test(reply.data.code) ? reply.data.code : 'REMOTE_FAILURE'
      throw new DesktopTeamError(code, `团队服务未完成操作（${code}）`, outcomeUnknown && (exchange.response.status >= 500 || code === 'ACKNOWLEDGEMENT_UNKNOWN'))
    }
    if (!exchange.response.ok) throw new DesktopTeamError('INVALID_RESPONSE', '团队 HTTP 状态与业务回执不一致', outcomeUnknown)
    return reply.data.value
  }
  private setCookies(response: Response): string[] {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const values = headers.getSetCookie?.()
    if (values && values.length > 0) return values
    const combined = response.headers.get('set-cookie')
    return combined ? combined.split(/,\s*(?=[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/) : []
  }
  async request<T extends z.ZodType>(origin: string, path: string, schema: T, token?: string, body?: unknown): Promise<z.output<T>> {
    const write = body !== undefined
    const exchange = await this.exchange(origin, path, 'api', token ? { Authorization: `Bearer ${token}` } : {}, body, write, true)
    return this.value(schema, exchange, write)
  }
  async authOptions<T extends z.ZodType>(origin: string, schema: T): Promise<TeamHttpReply<z.output<T>>> {
    const exchange = await this.exchange(origin, '/api/auth/options', 'api', { [TEAM_AUTH_OPTIONS_CAPABILITY_HEADER]: TEAM_AUTH_OPTIONS_INITIAL_TASK_TYPES }, undefined, false, false)
    return { value: this.value(schema, exchange, false), setCookies: this.setCookies(exchange.response) }
  }
  async localAuth<T extends z.ZodType>(origin: string, operation: 'login' | 'register', schema: T, challenge: TeamBrowserCredentials, body: unknown): Promise<TeamHttpReply<z.output<T>>> {
    const exchange = await this.exchange(origin, `/auth/local/${operation}`, 'local-auth', { Origin: origin, Cookie: challenge.cookie, 'X-CSRF-Token': challenge.csrfToken }, body, true, false)
    return { value: this.value(schema, exchange, true), setCookies: this.setCookies(exchange.response) }
  }
  async browserRequest<T extends z.ZodType>(origin: string, path: string, schema: T, credentials: TeamBrowserCredentials, body?: unknown, outcomeUnknown = body !== undefined): Promise<z.output<T>> {
    const exchange = await this.exchange(origin, path, path === '/auth/logout' ? 'local-auth' : 'api', { Origin: origin, Cookie: credentials.cookie, 'X-CSRF-Token': credentials.csrfToken, 'X-Trellis-Session-Proof': credentials.csrfToken }, body, outcomeUnknown, false)
    const value = this.value(schema, exchange, outcomeUnknown)
    if (exchange.response.headers.get('x-trellis-session-verified') !== '1') throw new DesktopTeamError('SESSION_UNVERIFIED', '团队服务未确认原桌面账号会话，请升级匹配的服务端', outcomeUnknown)
    return value
  }
}
