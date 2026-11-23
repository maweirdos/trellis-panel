const MAX_DETAIL_STRING_BYTES = 32_768
const TRUNCATION_MARKER = '\n… output truncated for transport'
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf8')

export function truncateDetail(
  value: string | undefined,
  maxBytes = MAX_DETAIL_STRING_BYTES,
): string | undefined {
  if (
    value === undefined ||
    (value.length <= maxBytes && Buffer.byteLength(value, 'utf8') <= maxBytes)
  ) {
    return value
  }
  const budget = maxBytes - TRUNCATION_MARKER_BYTES
  const prefix = Buffer.from(value.slice(0, budget), 'utf8')
    .subarray(0, budget)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')
  return `${prefix}${TRUNCATION_MARKER}`
}
