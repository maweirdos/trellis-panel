import { z } from 'zod'
import type { DingApp } from '../../../../shared/dingtalk-integration'
import { integrationFetch } from '../transport'
import { IntegrationError } from '../types'

const tokenSchema = z.object({ accessToken: z.string().min(1).max(8192), expireIn: z.number().int().positive().max(86400) })
export class DingTalkRemoteError extends IntegrationError {
  constructor(readonly vendorCode: string, readonly definite: boolean) { super(`钉钉请求未成功（${vendorCode}）`, definite ? 'upstream' : 'uncertain') }
}
export class DingTalkRest {
  private tokens = new Map<string, { token: string; expires: number }>()
  private refreshing = new Map<string, Promise<string>>()
  constructor(private readonly transport: (url: string, init: RequestInit) => Promise<Response> = integrationFetch, private readonly assertCurrent: (app: DingApp) => void = () => {}) {}
  invalidate(id: string): void { for (const key of this.tokens.keys()) if (key.startsWith(`${id}:`)) this.tokens.delete(key) }
  async request(path: string, body: unknown, token?: string, signal?: AbortSignal): Promise<unknown> {
    if (!/^\/v1\.0\/[a-zA-Z0-9/]+$/.test(path)) throw new IntegrationError('钉钉接口不在允许范围内', 'denied')
    const response = await this.transport(`https://api.dingtalk.com${path}`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', accept: 'application/json', ...(token ? { 'x-acs-dingtalk-access-token': token } : {}) }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
    // Even an injected native transport must preserve limits and must not redirect.
    if (response.redirected) throw new DingTalkRemoteError('REDIRECT_REJECTED', false)
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0
    try {
      if (reader) for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new DingTalkRemoteError('RESPONSE_TOO_LARGE', false) }; chunks.push(part.value) }
    } finally { reader?.releaseLock() }
    let raw: unknown
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new DingTalkRemoteError('INVALID_RESPONSE', false) }
    const failure = z.object({ code: z.union([z.string(), z.number()]).optional(), errcode: z.union([z.string(), z.number()]).optional() }).passthrough().safeParse(raw)
    const code = failure.success ? failure.data.code ?? failure.data.errcode : undefined
    if (!response.ok || (code !== undefined && String(code) !== '0')) {
      // Never include vendor messages, URLs, tokens or arbitrary response bodies.
      const label = code !== undefined && /^[\w.-]{1,80}$/.test(String(code)) ? String(code) : `HTTP_${response.status}`
      throw new DingTalkRemoteError(label, response.status >= 400 && response.status < 500 || response.ok && code !== undefined)
    }
    return raw
  }
  token(app: DingApp & { secret: string }, signal?: AbortSignal): Promise<string> {
    this.assertCurrent(app)
    const key = `${app.id}:${app.revision}`, cached = this.tokens.get(key)
    if (cached && cached.expires > Date.now() + 60000) return Promise.resolve(cached.token)
    const active = this.refreshing.get(key); if (active) return active
    const pending = this.request('/v1.0/oauth2/accessToken', { appKey: app.appKey, appSecret: app.secret }, undefined, signal).then(raw => {
      this.assertCurrent(app)
      const token = tokenSchema.parse(raw); this.tokens.set(key, { token: token.accessToken, expires: Date.now() + token.expireIn * 1000 }); return token.accessToken
    }).finally(() => this.refreshing.delete(key))
    this.refreshing.set(key, pending); return pending
  }
  async gateway(app: DingApp & { secret: string }, subscriptions: Array<{ type: string; topic: string }>, signal?: AbortSignal): Promise<string> {
    this.assertCurrent(app)
    const data = z.object({ endpoint: z.string().url().max(2048), ticket: z.string().min(1).max(8192) }).parse(await this.request('/v1.0/gateway/connections/open', { clientId: app.appKey, clientSecret: app.secret, ua: 'trellis-panel/dingtalk-stream-2.1.5', subscriptions }, undefined, signal))
    this.assertCurrent(app)
    const url = new URL(data.endpoint)
    if (url.protocol !== 'wss:' || !url.hostname.endsWith('.dingtalk.com') || url.username || url.password || url.search || url.hash || url.port && url.port !== '443') throw new IntegrationError('钉钉 Stream 网关地址不符合安全约束', 'denied')
    url.searchParams.set('ticket', data.ticket); return url.href
  }
  async sendPrivate(app: DingApp & { secret: string }, staffId: string, title: string, body: string, signal?: AbortSignal): Promise<{ processQueryKey: string }> {
    const token = await this.token(app, signal)
    this.assertCurrent(app)
    const result = z.object({ processQueryKey: z.string().min(1).max(256), invalidStaffIdList: z.array(z.string()).optional(), flowControlledStaffIdList: z.array(z.string()).optional() }).parse(await this.request('/v1.0/robot/oToMessages/batchSend', { robotCode: app.robotCode, userIds: [staffId], msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title, text: body }) }, token, signal))
    if (result.invalidStaffIdList?.length || result.flowControlledStaffIdList?.length) throw new DingTalkRemoteError('RECIPIENT_REJECTED', true)
    return { processQueryKey: result.processQueryKey }
  }
  async reply(app: DingApp & { secret: string }, webhook: string, text: string, signal?: AbortSignal): Promise<void> {
    const url = new URL(webhook)
    if (url.protocol !== 'https:' || url.hostname !== 'oapi.dingtalk.com' || url.pathname !== '/robot/sendBySession' || url.username || url.password || url.port && url.port !== '443' || url.hash) throw new IntegrationError('消息回复地址不符合钉钉会话 Webhook 约束', 'denied')
    const token = await this.token(app, signal)
    this.assertCurrent(app)
    const response = await this.transport(url.href, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token }, body: JSON.stringify({ msgtype: 'text', text: { content: text.slice(0, 4000) } }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
    if (!response.ok || response.redirected) throw new DingTalkRemoteError(`HTTP_${response.status}`, response.status >= 400 && response.status < 500)
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0
    try { if (reader) for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) { await reader.cancel(); throw new DingTalkRemoteError('RESPONSE_TOO_LARGE', false) }; chunks.push(part.value) } } finally { reader?.releaseLock() }
    const result = z.object({ errcode: z.number().int() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (result.errcode !== 0) throw new DingTalkRemoteError(`ERR_${result.errcode}`, true)
  }
}
