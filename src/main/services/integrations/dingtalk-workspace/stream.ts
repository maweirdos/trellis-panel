import { z } from 'zod'
import type { DingApp, DingAssistant } from '../../../../shared/dingtalk-integration'
import { DINGTALK_STREAM_VERSION } from '../../../../shared/dingtalk-integration'
import { IntegrationError } from '../types'
import type { DingTalkRest } from './rest'

const topic = '/v1.0/im/bot/messages/get'
const frame = z.object({ type: z.string().max(40), headers: z.object({ messageId: z.string().min(1).max(256), topic: z.string().max(256) }).passthrough(), data: z.string().max(128 * 1024) }).passthrough()
export interface StableDingTalkClient {
  connected: boolean; registered: boolean
  config: { autoReconnect?: boolean; subscriptions: Array<{ type: string; topic: string }> }
  getEndpoint(): Promise<StableDingTalkClient>
  getAccessToken(): Promise<unknown>
  connect(): Promise<void>; disconnect(): void
  onDownStream(data: string): void
  registerCallbackListener(topic: string, callback: (message: unknown) => void): unknown
  socketCallBackResponse(id: string, result: unknown): void
}
export interface DingTalkStreamFactory {
  /** No package download. Main supplies the installed pinned module constructor
   * and verifies its version/license record at composition. */
  version: typeof DINGTALK_STREAM_VERSION
  create(input: { app: DingApp & { secret: string }; onMessage(frame: unknown): boolean; health(state: DingAssistant['state'], detail: string): void }): Promise<{ close(): Promise<void> }>
}
export interface DingTalkStreamNetwork {
  /** Every reconnect resolves current proxy policy. A configured proxy MUST
   * provide a ws-compatible Node Agent or fail closed; no direct fallback. */
  socketOptions(url: string): Promise<{ mode: 'direct'; agent?: never } | { mode: 'proxy'; agent: unknown }>
}
export function createStableDingTalkStreamFactory(input: {
  version: typeof DINGTALK_STREAM_VERSION
  load(): Promise<{ DWClient: new (config: { clientId: string; clientSecret: string; keepAlive: boolean; debug: boolean }) => StableDingTalkClient }>
  rest: DingTalkRest; network: DingTalkStreamNetwork
}): DingTalkStreamFactory {
  if (input.version !== '2.1.5') throw new IntegrationError('钉钉 Stream SDK 版本不匹配', 'conflict')
  return { version: '2.1.5', async create({ app, onMessage, health }) {
    const sdk = await input.load()
    const client = new sdk.DWClient({ clientId: app.appKey, clientSecret: app.secret, debug: false, keepAlive: false })
    // The 2.1.5 constructor shares a mutable default subscriptions array. Isolate
    // it and subscribe only to robot callbacks; EVENT's default ACK is unsafe.
    client.config.subscriptions = []; client.config.autoReconnect = false
    let closed = false, connecting = false, attempts = 0, retryAt = 0
    const controller = new AbortController()
    // Stable 2.1.5 has no public proxy/HTTP/backpressure options. This guarded,
    // version-specific adaptation changes only SDK connection inputs; framing,
    // socket lifecycle and ACK encoding remain the official implementation.
    const ssl = Reflect.get(client, 'sslopts') as unknown
    if (!ssl || typeof ssl !== 'object' || !('rejectUnauthorized' in ssl)) throw new IntegrationError('SDK 2.1.5 网络适配结构不匹配，已阻止直连', 'conflict')
    client.getEndpoint = async () => {
      const url = await input.rest.gateway(app, client.config.subscriptions, controller.signal)
      const network = await input.network.socketOptions(url)
      if (closed) throw new IntegrationError('Stream 已停止', 'denied')
      if (network.mode === 'proxy' && !network.agent) throw new IntegrationError('已配置代理但 Stream 代理 Agent 不可用', 'denied')
      Object.assign(ssl, { rejectUnauthorized: true, handshakeTimeout: 15000, maxPayload: 256 * 1024, followRedirects: false, agent: network.mode === 'proxy' ? network.agent : undefined })
      Reflect.set(client, 'dw_url', url)
      return client
    }
    client.getAccessToken = () => input.rest.token(app, controller.signal)
    const downstream = client.onDownStream.bind(client)
    client.onDownStream = data => {
      if (closed) return
      try { const raw = String(data); if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('frame limit'); frame.parse(JSON.parse(raw)); downstream(raw) }
      catch { client.disconnect(); health('degraded', 'Stream 消息格式或大小无效，已断开接收') }
    }
    client.registerCallbackListener(topic, message => {
      if (closed) return
      try { const parsed = frame.parse(message); if (onMessage(parsed)) client.socketCallBackResponse(parsed.headers.messageId, { code: 0 }) }
      catch { health('blocked', '消息未持久化，未发送 ACK；请检查凭据和账本容量') }
    })
    async function connect(): Promise<void> {
      if (closed || connecting) return
      connecting = true; health(attempts ? 'retrying' : 'connecting', attempts ? 'Stream 正在重连' : '正在建立 Stream 连接')
      try {
        // SDK connect() catches errors and may resolve while disconnected. It
        // cannot establish registration. The monitor below checks actual flags.
        await client.connect()
        if (closed) client.disconnect()
        else if (!client.connected) { attempts++; retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(attempts, 6)); health('retrying', 'Stream 尚未连接，将按退避策略重试') }
      } finally { connecting = false }
    }
    let registered = false, connectStarted = 0
    const monitor = setInterval(() => {
      if (closed) return
      if (client.connected && client.registered) { if (!registered) health('registered', 'Stream 已连接并注册'); registered = true; attempts = 0; return }
      if (registered) { registered = false; health('retrying', 'Stream 连接中断，等待重连') }
      if (client.connected && !client.registered && Date.now() - connectStarted > 20000) { client.disconnect(); retryAt = Date.now() + 5000 }
      if (!connecting && !client.connected && Date.now() >= retryAt) { connectStarted = Date.now(); void connect().catch(() => { attempts++; retryAt = Date.now() + 60000; health('degraded', 'Stream 网络适配不可用，请检查代理和凭据') }) }
    }, 1000)
    return { async close() { closed = true; clearInterval(monitor); controller.abort(); client.disconnect() } }
  } }
}
