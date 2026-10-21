import type { ProviderId } from '../../../shared/integrations'
import type { IntegrationProvider } from './types'
import { IntegrationError } from './types'

/** TPD-025: one registration per trusted built-in; core services resolve capabilities. */
export class IntegrationRegistry {
  private readonly providers = new Map<ProviderId, IntegrationProvider>()
  register(provider: IntegrationProvider): void {
    if (this.providers.has(provider.manifest.id)) throw new Error(`重复的集成提供方：${provider.manifest.id}`)
    if (provider.manifest.capabilities.includes('repository.read') && !provider.repository) throw new Error('仓库能力必须提供仓库适配器')
    if (provider.manifest.authentication?.some((method) => method.oauth) && !provider.authorization) throw new Error('浏览器授权方式必须提供授权适配器')
    if (provider.manifest.capabilities.includes('notification.send') && !provider.notification) throw new Error('通知能力必须提供通知适配器')
    if (provider.manifest.capabilities.some((capability) => capability.startsWith('task.')) && !provider.tasks) throw new Error('任务能力必须提供任务来源适配器')
    if (provider.manifest.capabilities.some((capability) => capability.startsWith('knowledge.')) && !provider.knowledge) throw new Error('知识能力必须提供知识适配器')
    this.providers.set(provider.manifest.id, provider)
  }
  get(id: ProviderId): IntegrationProvider {
    const provider = this.providers.get(id)
    if (!provider) throw new IntegrationError('此集成尚未注册', 'denied')
    return provider
  }
  catalog(): IntegrationProvider['manifest'][] { return [...this.providers.values()].map((provider) => provider.manifest) }
}
