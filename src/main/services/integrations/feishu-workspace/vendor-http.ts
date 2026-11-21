import { z } from 'zod'
import { feishuAppIdSchema } from '../../../../shared/feishu-integration'
import { integrationFetch } from '../transport'
import { IntegrationError } from '../types'

export const FEISHU_OPEN = 'https://open.feishu.cn'
export const FEISHU_ACCOUNTS = 'https://accounts.feishu.cn'
export const FEISHU_SOURCE = 'crux'
export const FEISHU_REQUEST_TIMEOUT_MS = 15_000
export const FEISHU_AUTHORIZATION_TIMEOUT_MS = 5 * 60_000
export const appIdSchema = feishuAppIdSchema
export const openIdSchema = z.string().regex(/^ou_[\w-]{1,120}$/)
export const tenantKeySchema = z.string().regex(/^[\w-]{1,128}$/)
export const tokenSchema = z.string().regex(/^[\x21-\x7e]{1,8192}$/)

export interface FeishuCredentials { appId: string; appSecret: string }
export interface FeishuAuthorizationInput {
  signal: AbortSignal
  onQr(url: string, expiresAt: number): void
}

export function assertCredentials(credentials: FeishuCredentials): void {
  if (!appIdSchema.safeParse(credentials.appId).success || !credentials.appSecret || credentials.appSecret.length > 512) {
    throw new IntegrationError('飞书应用凭证无效', 'invalid')
  }
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new IntegrationError('飞书操作已取消或过期', 'denied')
}

export function authorizationUrl(value: string, origin: string, path?: string): string {
  const url = URL.parse(value)
  if (value.length > 4096 || !url || url.origin !== origin || url.username || url.password || url.hash ||
    (path && url.pathname !== path)) {
    throw new IntegrationError('飞书授权地址无法验证', 'denied')
  }
  return url.href
}

export function parseResponse<Schema extends z.ZodType>(schema: Schema, raw: unknown): z.output<Schema> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new IntegrationError('飞书响应格式不符合预期', 'upstream')
  return parsed.data
}

const envelope = z.object({ code: z.number().int().safe() }).passthrough()
const unavailable = '飞书请求未完成，请检查网络和代理'

export class FeishuHttp {
  constructor(private readonly fetcher = integrationFetch) {}

  async json(url: string | URL, init: RequestInit, mutates = false): Promise<{ ok: boolean; status: number; body: unknown }> {
    const target = new URL(url)
    if (![FEISHU_OPEN, FEISHU_ACCOUNTS].includes(target.origin) || target.username || target.password || target.hash) {
      throw new IntegrationError('飞书接口地址无法验证', 'denied')
    }
    const parentSignal = init.signal ?? undefined
    assertNotAborted(parentSignal)
    const timeout = AbortSignal.timeout(FEISHU_REQUEST_TIMEOUT_MS)
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout
    const kind = mutates ? 'uncertain' : 'upstream'
    try {
      const headers = new Headers(init.headers)
      headers.set('accept-encoding', 'identity')
      const response = await this.fetcher(target, { ...init, headers, redirect: 'error', signal })
      if (response.redirected) throw new IntegrationError('飞书接口返回了重定向', kind)
      if (!mutates) assertNotAborted(parentSignal)
      let body: unknown
      try { body = await response.json() }
      catch { throw new IntegrationError(`飞书返回了无法解析的响应（HTTP ${response.status}）`, kind) }
      return { status: response.status, ok: response.ok, body }
    } catch (error) {
      if (!mutates) assertNotAborted(parentSignal)
      if (error instanceof IntegrationError) throw error
      throw new IntegrationError(mutates ? '飞书回复结果无法确认' : unavailable, kind)
    }
  }

  async api(path: string, options: { token?: string; payload?: unknown; signal?: AbortSignal; mutates?: boolean } = {}): Promise<Record<string, unknown>> {
    const { token, payload, signal, mutates } = options
    const response = await this.json(`${FEISHU_OPEN}${path}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: payload === undefined ? undefined : JSON.stringify(payload), signal
    }, mutates)
    const parsed = envelope.safeParse(response.body)
    if (parsed.success && parsed.data.code !== 0 && (response.ok || (response.status >= 400 && response.status < 500))) {
      throw new IntegrationError(`飞书拒绝了请求（${parsed.data.code}）`, 'upstream')
    }
    if (!response.ok || !parsed.success) {
      throw new IntegrationError(mutates ? '飞书回复结果无法确认' : `飞书返回无效响应（HTTP ${response.status}）`, mutates ? 'uncertain' : 'upstream')
    }
    return parsed.data
  }
}
