/** Canonical semantic JSON for retained team input/command hashes. */
export function taskInputCanonical(value: unknown): string {
  // Hash the same JSON values that survive HTTP and persisted-intent encoding.
  // Optional undefined object fields disappear; undefined array entries are null.
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('Expected a JSON value')
  return canonicalJson(JSON.parse(serialized))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
