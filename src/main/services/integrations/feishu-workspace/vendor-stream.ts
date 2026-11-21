import type { HttpInstance } from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import { IntegrationError } from '../types'
import { loadFeishuSdk } from './vendor-auth'
import { assertCredentials, assertNotAborted, FEISHU_OPEN, FEISHU_REQUEST_TIMEOUT_MS, FEISHU_SOURCE, FeishuHttp, type FeishuCredentials } from './vendor-http'
import { normalizeFeishuMessage, type FeishuMessage } from './vendor-messages'

const GATEWAY_ENDPOINT = `${FEISHU_OPEN}/callback/ws/endpoint`
const PROXY_CHANGED = '网络代理已更改，请重新连接飞书'
const SOCKET_RETRY = '飞书消息网关尚未接通，正在重试。请检查网络和代理'
const noLogging = { error() {}, warn() {}, info() {}, debug() {}, trace() {} }
const gatewayCode = z.object({ code: z.number().int().safe() })
const gatewayConfig = z.object({
  code: z.literal(0),
  data: z.object({
    URL: z.string().max(4096),
    ClientConfig: z.object({
      PingInterval: z.number().int().min(1).max(3600).default(120),
      ReconnectCount: z.number().int().min(-1).max(65535).default(-1),
      ReconnectInterval: z.number().int().min(1).max(3600).default(120),
      ReconnectNonce: z.number().int().min(0).max(3600).default(0)
    }).prefault({})
  })
})

export interface FeishuStreamCallbacks {
  onMessage(message: FeishuMessage): Promise<void>
  onState(state: 'connecting' | 'connected' | 'failed', detail: string): void
}
export type FeishuProxy = () => { enabled: boolean; url: string }

async function socketAgent(proxy: ReturnType<FeishuProxy>): Promise<{ destroy(): void } | undefined> {
  if (!proxy.enabled) return undefined
  const url = URL.parse(proxy.url)
  if (url && ['http:', 'https:'].includes(url.protocol)) {
    const { HttpsProxyAgent } = await import('https-proxy-agent')
    return new HttpsProxyAgent(url)
  }
  if (url?.protocol === 'socks5:') {
    const { SocksProxyAgent } = await import('socks-proxy-agent')
    url.protocol = 'socks5h:'
    return new SocksProxyAgent(url.href)
  }
  throw new IntegrationError('飞书长连接代理地址无效', 'denied')
}

function gatewayFailure(code: number): { code: number; data: Record<string, never>; msg: string } {
  return { code, data: {}, msg: '飞书长连接网关拒绝接入' }
}

function gatewayHttp(
  http: FeishuHttp, credentials: FeishuCredentials, signal: AbortSignal, stillSameProxy: () => boolean,
  report: (detail?: string, retryable?: boolean) => void
): HttpInstance {
  const blocked = async () => { throw new IntegrationError('飞书长连接接口不在允许范围内', 'denied') }
  return {
    get: blocked, delete: blocked, head: blocked, options: blocked, post: blocked, put: blocked, patch: blocked,
    async request<T, Result = T>(options: Parameters<HttpInstance['request']>[0]): Promise<Result> {
      if (options.url !== GATEWAY_ENDPOINT || options.method !== 'post' || !stillSameProxy()) return gatewayFailure(400) as Result
      const userAgent: unknown = options.headers?.['User-Agent']
      const response = await http.json(GATEWAY_ENDPOINT, {
        method: 'POST', signal, headers: {
          'content-type': 'application/json', locale: 'zh',
          'user-agent': typeof userAgent === 'string' ? userAgent : FEISHU_SOURCE
        },
        body: JSON.stringify({ AppID: credentials.appId, AppSecret: credentials.appSecret })
      }).catch((error: unknown) => {
        if (!signal.aborted) report('飞书长连接网关暂不可达，正在重试。请检查网络和代理', true)
        throw error
      })
      assertNotAborted(signal)
      if (!stillSameProxy()) return gatewayFailure(400) as Result
      const remote = gatewayCode.safeParse(response.body)
      const code = remote.success && remote.data.code !== 0 ? remote.data.code : response.ok ? 0 : response.status
      if (code !== 0) {
        const retryable = code === 1 || code === 1000040343 || response.status === 429 || response.status >= 500
        const detail = retryable ? `飞书长连接网关暂不可用（${code}），正在重试`
          : `飞书长连接网关拒绝接入（${code}）。请检查应用凭证和事件订阅`
        report(detail, retryable)
        if (retryable) throw new IntegrationError(detail, 'upstream')
        return gatewayFailure(code) as Result
      }
      const parsed = gatewayConfig.safeParse(response.body)
      if (!parsed.success) {
        report('飞书长连接网关返回了无效的连接配置')
        return gatewayFailure(400) as Result
      }
      const url = URL.parse(parsed.data.data.URL)
      if (!url || url.protocol !== 'wss:' || !url.hostname.endsWith('.feishu.cn') || url.port || url.username || url.password || url.hash ||
          !url.searchParams.get('device_id') || !/^\d{1,10}$/.test(url.searchParams.get('service_id') ?? '')) {
        report('飞书长连接网关返回了无法验证的连接地址')
        return gatewayFailure(400) as Result
      }
      report()
      return parsed.data as Result
    }
  }
}

export async function listenForMessages(http: FeishuHttp, credentials: FeishuCredentials, callbacks: FeishuStreamCallbacks, proxy: FeishuProxy): Promise<{ close(): void }> {
  assertCredentials(credentials)
  const sdk = await loadFeishuSdk()
  const capturedProxy = { ...proxy() }
  const agent = await socketAgent(capturedProxy)
  const controller = new AbortController()
  let gatewayDetail: string | undefined
  const stillSameProxy = () => {
    const latest = proxy()
    return latest.enabled === capturedProxy.enabled && (!latest.enabled || latest.url === capturedProxy.url)
  }
  const state = (value: Parameters<FeishuStreamCallbacks['onState']>[0], detail: string) => {
    if (!controller.signal.aborted) callbacks.onState(value, detail)
  }
  const dispatcher = new sdk.EventDispatcher({ logger: noLogging }).register({
    async 'im.message.receive_v1'(raw) {
      assertNotAborted(controller.signal)
      if (!stillSameProxy()) throw new IntegrationError(PROXY_CHANGED, 'denied')
      const message = normalizeFeishuMessage(raw, credentials.appId)
      if (message) await callbacks.onMessage(message)
    }
  })
  const client = new sdk.WSClient({
    appId: credentials.appId, appSecret: credentials.appSecret,
    domain: sdk.Domain.Feishu, source: FEISHU_SOURCE, autoReconnect: true, agent, logger: noLogging,
    handshakeTimeoutMs: FEISHU_REQUEST_TIMEOUT_MS, wsConfig: { pingTimeout: 25 },
    httpInstance: gatewayHttp(http, credentials, controller.signal, stillSameProxy, (detail, retryable) => {
      gatewayDetail = detail
      if (retryable && detail) state('connecting', detail)
    }),
    onReady: () => state('connected', '飞书长连接已接通'),
    onReconnected: () => state('connected', '飞书长连接已恢复'),
    onReconnecting: () => state('connecting', '正在重新连接飞书'),
    onError: () => fail(stillSameProxy() ? gatewayDetail ?? '飞书长连接未接通，请检查网络和代理' : PROXY_CHANGED)
  })
  state('connecting', '正在连接飞书')
  const policyWatch = setInterval(() => {
    if (!stillSameProxy()) fail(PROXY_CHANGED)
  }, 1000).unref()
  function fail(detail: string): void {
    state('failed', detail)
    close()
  }
  function close(): void {
    if (controller.signal.aborted) return
    clearInterval(policyWatch)
    controller.abort()
    client.close({ force: true })
    agent?.destroy()
  }
  void client.start({ eventDispatcher: dispatcher }).then(() => {
    if (!gatewayDetail && client.getConnectionStatus().state === 'connecting') state('connecting', SOCKET_RETRY)
  }).catch(() => fail('飞书长连接启动失败'))
  return { close }
}
