import { z } from 'zod'
import type { AiConfig } from './types'

/** Default selection is catalog metadata; it must not require decrypting credentials. */
export function defaultConfiguredModelId(ai: Pick<AiConfig, 'providers' | 'activeProviderId' | 'enabled' | 'model'>): string | undefined {
  if (ai.providers?.length) {
    const candidates = ai.providers.filter(provider => provider.enabled).flatMap(provider => provider.models.filter(model => model.enabled).map(model => ({ provider, model })))
    const selected = candidates.find(item => item.provider.id === ai.activeProviderId && item.model.id === ai.model)
      ?? candidates.find(item => item.provider.id === ai.activeProviderId) ?? candidates[0]
    return selected ? `${selected.provider.id}:${selected.model.id}` : undefined
  }
  return ai.enabled && ai.model ? `default:${ai.model}` : undefined
}

export const MODEL_ID_MAX_BYTES = 8192
export function modelIdWithinLimit(value: string): boolean {
  return value.length > 0 && value.length <= MODEL_ID_MAX_BYTES && new TextEncoder().encode(value).length <= MODEL_ID_MAX_BYTES
}
export const modelSelectionIdSchema = z.string().refine(modelIdWithinLimit, `模型 ID 不能超过 ${MODEL_ID_MAX_BYTES} UTF-8 字节`)

export function cleanModelDisplayName(name?: string, engine?: string): string {
  if (!name) return ''
  const trimmed = name.trim()
  if (engine === 'pi') {
    const parts = trimmed.split(' · ')
    return parts.length > 1 ? parts.slice(1).join(' · ').trim() : trimmed
  }
  return trimmed.split(' · ')[0].trim()
}
