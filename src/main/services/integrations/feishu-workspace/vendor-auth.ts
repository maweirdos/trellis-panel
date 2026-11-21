import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { IntegrationError } from '../types'
import {
  appIdSchema, assertCredentials, assertNotAborted, authorizationUrl, FEISHU_ACCOUNTS,
  FEISHU_AUTHORIZATION_TIMEOUT_MS, FEISHU_OPEN, FEISHU_SOURCE, FeishuHttp, openIdSchema, parseResponse,
  tenantKeySchema, tokenSchema, type FeishuAuthorizationInput, type FeishuCredentials
} from './vendor-http'

const REGISTER_ENDPOINT = `${FEISHU_ACCOUNTS}/oauth/v1/app/registration`
const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' }
const registrationSession = new AsyncLocalStorage<{ signal: AbortSignal; http: FeishuHttp }>()
const expirySeconds = z.number().int().positive().max(3600)
const pollSeconds = z.number().int().positive().max(300)
const registrationBegin = z.object({
  verification_uri_complete: z.string().url().max(4096),
  device_code: tokenSchema,
  expire_in: expirySeconds.optional(),
  expires_in: expirySeconds.optional(),
  interval: pollSeconds.optional()
})

export type FeishuSdk = typeof import('@larksuiteoapi/node-sdk')
let loadedSdk: Promise<FeishuSdk> | undefined
export function loadFeishuSdk(): Promise<FeishuSdk> {
  loadedSdk ??= import('@larksuiteoapi/node-sdk').then(sdk => {
    sdk.defaultHttpInstance.interceptors.request.use(config => {
      const session = registrationSession.getStore()
      if (!session) return config
      assertNotAborted(session.signal)
      if (config.url !== REGISTER_ENDPOINT || config.method !== 'post' || typeof config.data !== 'string') {
        throw new IntegrationError('飞书注册接口地址无法验证', 'denied')
      }
      const form = new URLSearchParams(config.data)
      const action = form.get('action')
      if (action === 'begin') {
        form.set('request_user_info', 'open_id tenant_brand')
      } else if (action !== 'poll' || !tokenSchema.safeParse(form.get('device_code')).success) {
        throw new IntegrationError('飞书注册请求格式无效', 'denied')
      }
      config.adapter = async request => {
        const result = await session.http.json(REGISTER_ENDPOINT, {
          method: 'POST', headers: formHeaders, body: form, signal: session.signal
        })
        if (!result.ok && (action === 'begin' || result.status !== 400)) {
          throw new IntegrationError(`飞书注册请求失败（HTTP ${result.status}）`, 'upstream')
        }
        let data = result.body
        if (action === 'begin') {
          const begin = parseResponse(registrationBegin, data)
          data = { ...begin, expires_in: begin.expire_in ?? begin.expires_in }
        }
        return { data, status: result.status, statusText: '', headers: {}, config: request }
      }
      return config
    })
    return sdk
  })
  return loadedSdk
}

const registrationResult = z.object({
  client_id: appIdSchema,
  client_secret: z.string().min(1).max(512),
  user_info: z.object({ tenant_brand: z.enum(['feishu', 'lark']).optional() }).nullish()
})
const vendorError = z.object({ code: z.string().max(40) }).passthrough()

export type FeishuRegistrationInput = FeishuAuthorizationInput & { name: string; kind?: 'assistant' | 'agent' }

export async function registerApplication(http: FeishuHttp, input: FeishuRegistrationInput): Promise<FeishuCredentials> {
  assertNotAborted(input.signal)
  const deadline = Date.now() + FEISHU_AUTHORIZATION_TIMEOUT_MS
  const timeout = AbortSignal.timeout(FEISHU_AUTHORIZATION_TIMEOUT_MS)
  const brand = new AbortController()
  const signal = AbortSignal.any([input.signal, timeout, brand.signal])
  const scopes = ['im:message.group_msg', 'im:message:readonly', 'im:message:send_as_bot', 'im:chat:read', 'im:message.p2p_msg:readonly']
  let qrPresented = false
  try {
    const sdk = await loadFeishuSdk()
    assertNotAborted(signal)
    const raw = await registrationSession.run({ signal, http }, () => sdk.registerApp({
      source: FEISHU_SOURCE,
      signal,
      appPreset: { name: input.name },
      addons: {
        preset: false,
        scopes: { tenant: scopes },
        events: { items: { tenant: ['im.message.receive_v1'] } }
      },
      onStatusChange(info) {
        if (info.status === 'domain_switched') brand.abort()
      },
      onQRCodeReady({ url, expireIn }) {
        assertNotAborted(signal)
        if (!Number.isSafeInteger(expireIn) || expireIn <= 0) throw new IntegrationError('飞书返回的授权有效期无效', 'upstream')
        const link = new URL(authorizationUrl(url, FEISHU_OPEN, '/page/launcher'))
        if (!link.searchParams.get('user_code') || link.searchParams.getAll('user_code').length !== 1) {
          throw new IntegrationError('飞书授权地址缺少有效的用户码', 'upstream')
        }
        input.onQr(link.href, Math.min(deadline, Date.now() + expireIn * 1000))
        qrPresented = true
      }
    }))
    assertNotAborted(signal)
    const result = parseResponse(registrationResult, raw)
    if (result.user_info?.tenant_brand === 'lark') throw new IntegrationError('请使用飞书账号注册应用', 'denied')
    return { appId: result.client_id, appSecret: result.client_secret }
  } catch (error) {
    if (brand.signal.aborted) throw new IntegrationError('请使用飞书账号注册应用', 'denied')
    assertNotAborted(input.signal)
    const parsed = vendorError.safeParse(error)
    if (timeout.aborted || (parsed.success && parsed.data.code === 'expired_token')) {
      throw new IntegrationError('飞书扫码授权已过期', 'denied')
    }
    if (parsed.success && parsed.data.code === 'access_denied') throw new IntegrationError('飞书扫码授权未获同意', 'denied')
    if (error instanceof IntegrationError && (error.kind !== 'upstream' || !qrPresented)) throw error
    throw new IntegrationError('飞书注册结果无法确认，请到飞书开放平台核对', 'uncertain')
  }
}

const deviceStart = z.object({
  device_code: tokenSchema,
  verification_uri_complete: z.string().url().max(4096),
  expires_in: expirySeconds,
  interval: pollSeconds.default(5)
})
const devicePoll = z.object({
  code: z.number().int().safe().optional(),
  error: z.string().max(80).optional(),
  access_token: tokenSchema.optional(),
  token_type: z.string().max(32).optional()
})
const userIdentity = z.object({
  data: z.object({
    open_id: openIdSchema, union_id: z.string().regex(/^on_[\w-]{1,120}$/).optional(),
    name: z.string().trim().min(1).max(256), tenant_key: tenantKeySchema.optional()
  })
})

export async function authorizeDevice(
  http: FeishuHttp, credentials: FeishuCredentials, input: FeishuAuthorizationInput
): Promise<{ openId: string; unionId?: string; tenantKey?: string; displayName: string }> {
  assertCredentials(credentials)
  assertNotAborted(input.signal)
  const deadline = Date.now() + FEISHU_AUTHORIZATION_TIMEOUT_MS
  const auth = Buffer.from(`${credentials.appId}:${credentials.appSecret}`).toString('base64')
  const begin = await http.json(`${FEISHU_ACCOUNTS}/oauth/v1/device_authorization`, {
    method: 'POST', headers: { ...formHeaders, authorization: `Basic ${auth}` },
    body: new URLSearchParams({ client_id: credentials.appId }), signal: input.signal
  })
  if (!begin.ok) throw new IntegrationError('此飞书应用无法发起个人账号授权，请检查应用的设备授权配置', 'upstream')
  const device = parseResponse(deviceStart, begin.body)
  const expiresAt = Math.min(deadline, Date.now() + device.expires_in * 1000)
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(Math.max(0, expiresAt - Date.now()))])
  const link = URL.parse(device.verification_uri_complete)
  const origin = link?.origin === FEISHU_OPEN ? FEISHU_OPEN : FEISHU_ACCOUNTS
  assertNotAborted(signal)
  input.onQr(authorizationUrl(device.verification_uri_complete, origin), expiresAt)

  let interval = device.interval * 1000
  for (;;) {
    try { await delay(interval, undefined, { signal }) } catch { assertNotAborted(signal) }
    const result = await http.json(`${FEISHU_ACCOUNTS}/oauth/v3/token`, {
      method: 'POST', headers: formHeaders,
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code,
        client_id: credentials.appId, client_secret: credentials.appSecret
      }),
      signal
    })
    const token = parseResponse(devicePoll, result.body)
    if (result.ok && !token.error && (token.code === undefined || token.code === 0) &&
        token.access_token && (!token.token_type || token.token_type.toLowerCase() === 'bearer')) {
      const identity = parseResponse(userIdentity, await http.api('/open-apis/authen/v1/user_info', { token: token.access_token, signal })).data
      assertNotAborted(signal)
      return { openId: identity.open_id, unionId: identity.union_id, tenantKey: identity.tenant_key, displayName: identity.name }
    }
    if (token.error === 'authorization_pending') continue
    if (token.error === 'slow_down') {
      interval += 5000
      continue
    }
    if (token.error === 'access_denied') throw new IntegrationError('飞书账号授权未获同意', 'denied')
    if (token.error === 'expired_token' || token.error === 'invalid_grant') throw new IntegrationError('飞书账号授权已过期', 'denied')
    throw new IntegrationError('飞书账号授权未完成，请检查应用的设备授权配置', 'upstream')
  }
}
