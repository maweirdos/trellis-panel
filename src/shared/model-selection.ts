import { z } from 'zod'

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
