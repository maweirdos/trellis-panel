import type { AiConfig } from '@shared/types'
import { defaultConfiguredModelId, modelIdWithinLimit } from '@shared/model-selection'

export function piModelChoices(ai: AiConfig): { models: Array<{ id: string; label: string; available: boolean }>; defaultId?: string } {
  if (ai.providers?.length) {
    const candidates = ai.providers.filter((provider) => provider.enabled)
      .flatMap((provider) => provider.models.filter((model) => model.enabled).map((model) => ({ provider, model })))
    return { models: candidates.map(({ provider, model }) => ({ id: `${provider.id}:${model.id}`, label: `${provider.name} · ${model.name || model.id}`, available: modelIdWithinLimit(`${provider.id}:${model.id}`) })),
      defaultId: defaultConfiguredModelId(ai) }
  }
  if (ai.enabled && ai.model) return { models: [{ id: `default:${ai.model}`, label: `默认模型 · ${ai.model}`, available: modelIdWithinLimit(`default:${ai.model}`) }], defaultId: `default:${ai.model}` }
  return { models: [] }
}
