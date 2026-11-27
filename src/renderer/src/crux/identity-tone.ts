export type IdentityTone = 'indigo' | 'emerald' | 'purple' | 'orange' | 'pink'

const TONES: readonly IdentityTone[] = ['emerald', 'indigo', 'purple', 'orange', 'pink']

/** 按实体名称生成稳定的低饱和语义识别色（复用 my-tokens.css 的 --my-label-* 双主题令牌）。 */
export function identityTone(seed: string): IdentityTone {
  let hash = 0
  const normalized = seed.trim().toLowerCase()
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0
  }
  return TONES[Math.abs(hash) % TONES.length]
}
