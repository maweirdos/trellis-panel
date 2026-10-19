import { createHmac } from 'node:crypto'
import type { NotificationPort } from '../types'
import { IntegrationError } from '../types'
import { readRemoteJson, recordOf } from '../transport'

export function validateWebhook(provider: string, value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new IntegrationError('请输入有效的群机器人 Webhook') }
  const valid = provider === 'dingtalk'
    ? url.hostname === 'oapi.dingtalk.com' && url.pathname === '/robot/send' && !!url.searchParams.get('access_token')
    : url.hostname === 'open.feishu.cn' && /^\/open-apis\/bot\/v2\/hook\/[^/]+$/.test(url.pathname) && !url.search
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !valid) throw new IntegrationError('Webhook 必须是对应厂商的官方 HTTPS 群机器人地址')
  if (provider === 'dingtalk' && [...url.searchParams.keys()].some((key) => key !== 'access_token')) throw new IntegrationError('请填写不含临时签名参数的原始 Webhook')
  return url
}
export const notificationPort: NotificationPort = {
  async send(c, title, body) {
    const url = validateWebhook(c.public.providerId, c.secrets.webhook || '')
    const secret = c.secrets.signingSecret
    const content = `${title}\n\n${body}`
    const payload: Record<string, unknown> = c.public.providerId === 'dingtalk'
      ? { msgtype: 'text', text: { content } }
      : { msg_type: 'text', content: { text: content } }
    if (secret) {
      if (c.public.providerId === 'dingtalk') {
        const timestamp = String(Date.now())
        url.searchParams.set('timestamp', timestamp)
        url.searchParams.set('sign', createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64'))
      } else {
        const timestamp = String(Math.floor(Date.now() / 1000))
        payload.timestamp = timestamp
        payload.sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
      }
    }
    let response: Record<string, unknown>
    try { response = recordOf((await readRemoteJson(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).body) }
    catch (error) {
      if (error instanceof IntegrationError && /HTTP 4\d\d/.test(error.message)) throw error
      throw new IntegrationError('网络中断或超时，消息可能已发送；请先在目标群核实', 'uncertain')
    }
    const code = c.public.providerId === 'dingtalk' ? response.errcode : response.code ?? response.StatusCode
    if (typeof code !== 'number') throw new IntegrationError('厂商响应缺少结果码，投递结果未知，请先在目标群核实', 'uncertain')
    if (code !== 0) throw new IntegrationError(`群机器人拒绝消息（厂商结果码 ${code}），请检查签名、关键词与群设置`, 'upstream')
  }
}
