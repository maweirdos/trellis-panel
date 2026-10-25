export const IMPLICIT_MATERIAL_BUDGET_BYTES = 8192
export const EXPLICIT_MATERIAL_BUDGET_BYTES = 16384
export const TOTAL_MATERIAL_BUDGET_BYTES = IMPLICIT_MATERIAL_BUDGET_BYTES + EXPLICIT_MATERIAL_BUDGET_BYTES

function utf8CharacterBytes(character: string): number {
  const code = character.codePointAt(0) ?? 0
  return code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
}

/** UTF-8 size without Node globals or an intermediate encoded copy. */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const character of text) bytes += utf8CharacterBytes(character)
  return bytes
}

/** Pessimistic estimate of one token per UTF-8 byte, not a measured/model-specific count. */
export function estimateMaterialTokens(text: string): number {
  return utf8ByteLength(text)
}

/** Contiguous original prefix; byte limits are floored and clamped to 0..24 KiB. */
export function clipUtf8(text: string, maxBytes: number): string {
  const limit = Math.max(0, Math.min(TOTAL_MATERIAL_BUDGET_BYTES, Math.floor(maxBytes) || 0))
  let bytes = 0
  let end = 0
  for (const character of text) {
    const nextBytes = bytes + utf8CharacterBytes(character)
    if (nextBytes > limit) break
    bytes = nextBytes
    end += character.length
  }
  return text.slice(0, end)
}
