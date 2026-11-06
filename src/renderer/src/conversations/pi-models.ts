import type { AiConfig } from '@shared/types'
import { modelIdWithinLimit } from '@shared/model-selection'

export function piModelChoices(ai: AiConfig): { models: Array<{ id: string; label: string; available: boolean }>; defaultId?: string } {
  if (ai.providers?.length) {
    const candidates = ai.providers.filter((provider) => provider.enabled)
      .flatMap((provider) => provider.models.filter((model) => model.enabled).map((model) => ({ provider, model })))
    const selected = candidates.find(({ provider, model }) => provider.id === ai.activeProviderId && model.id === ai.model)
      ?? candidates.find(({ provider }) => provider.id === ai.activeProviderId) ?? candidates[0]
    return { models: candidates.map(({ provider, model }) => ({ id: `${provider.id}:${model.id}`, label: `${provider.name} · ${model.name || model.id}`, available: modelIdWithinLimit(`${provider.id}:${model.id}`) })),
      defaultId: selected ? `${selected.provider.id}:${selected.model.id}` : undefined }
  }
  if (ai.enabled && ai.model) return { models: [{ id: `default:${ai.model}`, label: `默认模型 · ${ai.model}`, available: modelIdWithinLimit(`default:${ai.model}`) }], defaultId: `default:${ai.model}` }
  return { models: [] }
}
