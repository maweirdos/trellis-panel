import { z } from 'zod'
import { IntegrationError } from '../types'
import type { DingTalkPersonalPort } from './ports'

/** Existing native team/account transport supplies protected device auth, exact
 * service identity and bounded proxied HTTP. No credential is sent to renderer.
 * The server app secret is configured separately by its administrator. */
export interface DingTalkAccountServiceTransport {
  serviceBinding: string
  request(method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal): Promise<unknown>
}
export function createDingTalkPersonalAdapter(transport: DingTalkAccountServiceTransport): DingTalkPersonalPort {
  let setup: ReturnType<DingTalkPersonalPort['setup']> = { available: true, serviceBinding: transport.serviceBinding, linkPreview: 'needs-setup', detail: '个人授权需要此服务独立配置的应用凭据与精确 HTTPS 回调地址；链接预览尚未验证' }
  return {
    setup: () => ({ ...setup }),
    async begin(input, signal) {
      const result = z.object({ authorizationId: z.string().uuid(), expiresAt: z.number().int().positive(), browserUrl: z.string().url(), serviceBinding: z.string().min(1) }).strict().parse(await transport.request('POST', '/api/integrations/dingtalk/accounts/authorize', input, signal))
      if (result.serviceBinding !== transport.serviceBinding) throw new IntegrationError('钉钉账号服务身份不匹配', 'denied')
      return result
    },
    async claim(input, signal) {
      const result = z.object({ unionId: z.string().min(1).max(256), staffId: z.string().min(1).max(256), corpId: z.string().min(1).max(256), displayName: z.string().max(256), serviceBinding: z.string().min(1).max(256) }).strict().parse(await transport.request('POST', '/api/integrations/dingtalk/accounts/claim', input, signal))
      if (result.serviceBinding !== transport.serviceBinding) throw new IntegrationError('钉钉账号服务身份不匹配', 'denied')
      return result
    },
    async unlink(account, signal) { await transport.request('POST', '/api/integrations/dingtalk/accounts/unlink', { nativeSubject: account.nativeSubject, appId: account.appId, unionId: account.unionId, staffId: account.staffId }, signal) }
  }
}
