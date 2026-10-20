import { StringDecoder } from 'node:string_decoder'
import { APP_RUNTIME_LIMITS } from '../../../../shared/app-runtime'

export function boundedTail(value: string, cap = APP_RUNTIME_LIMITS.outputBytes): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value)
  if (bytes.length <= cap) return { value, truncated: false }
  return { value: bytes.subarray(bytes.length - cap).toString('utf8').replace(/^\uFFFD+/, ''), truncated: true }
}

/** Delay an incomplete secret prefix across data chunks before exposing output. */
export function outputRedactor(secrets: string[], emit: (value: string) => void): { write(chunk: Buffer): void; end(): void } {
  const decoder = new StringDecoder('utf8')
  const candidates = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)
  const prefixes = new Map<string, string[]>()
  for (const secret of candidates) { const group = prefixes.get(secret[0]) ?? []; group.push(secret); prefixes.set(secret[0], group) }
  let pending = ''
  function flush(final: boolean): void {
    const result: string[] = []
    let position = 0
    let plainStart = 0
    while (position < pending.length) {
      const group = prefixes.get(pending[position])
      const match = group?.find((secret) => pending.startsWith(secret, position))
      if (match) { result.push(pending.slice(plainStart, position), '[REDACTED]'); position += match.length; plainStart = position; continue }
      if (!final && group?.some((secret) => secret.length > pending.length - position && secret.startsWith(pending.slice(position)))) break
      position += 1
    }
    result.push(pending.slice(plainStart, position))
    pending = pending.slice(position)
    const text = result.join('')
    if (text) emit(text)
  }
  return { write(chunk) { pending += decoder.write(chunk); flush(false) }, end() { pending += decoder.end(); flush(true) } }
}
