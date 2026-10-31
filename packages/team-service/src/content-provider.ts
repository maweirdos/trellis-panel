import { createHash } from 'node:crypto'
import { z } from 'zod'
import { TEAM_CONTENT_MAX_OUTPUT_BYTES, teamContentUsageSchema, type TeamContentUsage } from '../../../src/shared/team-content'
import { validateContentEndpoint } from './content-credentials'

export const contentProviderEnvelopeSchema = z.object({
  endpoint: z.string().max(2048), model: z.string().max(200), apiKey: z.string().max(4096),
  messages: z.array(z.object({ role: z.enum(['system', 'user']), content: z.string().max(256 * 1024) }).strict()).length(2),
  maxTokens: z.number().int().positive(), timeoutMs: z.number().int().min(100).max(60_000)
}).strict()
export type ContentProviderEnvelope = z.infer<typeof contentProviderEnvelopeSchema>
export const contentProviderResultSchema = z.object({
  state: z.enum(['succeeded', 'unknown']), body: z.string().max(TEAM_CONTENT_MAX_OUTPUT_BYTES).nullable(),
  usage: teamContentUsageSchema.nullable(), errorCode: z.enum([
    'CONTENT_TIMEOUT', 'CONTENT_CANCELLED_IN_FLIGHT', 'CONTENT_NETWORK_UNKNOWN', 'CONTENT_UPSTREAM_HTTP',
    'CONTENT_REDIRECT_REJECTED', 'CONTENT_RESPONSE_TOO_LARGE', 'CONTENT_RESPONSE_INVALID', 'CONTENT_ENDPOINT_INVALID'
  ]).nullable()
}).strict()
export type ContentProviderResult = z.infer<typeof contentProviderResultSchema>
const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1).max(16),
  usage: z.unknown().optional()
})
const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().max(1_000_000_000),
  completion_tokens: z.number().int().nonnegative().max(1_000_000_000),
  prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().max(1_000_000_000).optional() }).optional()
})
const MAX_RESPONSE_BYTES = 256 * 1024
export function contentDigest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
export function providerUsage(raw: unknown): TeamContentUsage | null {
  const parsed = usageSchema.safeParse(raw)
  if (!parsed.success) return null
  const usage = teamContentUsageSchema.safeParse({ source: 'provider', inputTokens: parsed.data.prompt_tokens,
    outputTokens: parsed.data.completion_tokens, cachedInputTokens: parsed.data.prompt_tokens_details?.cached_tokens ?? null })
  return usage.success ? usage.data : null
}
/** One non-streaming text request. Never retry, follow redirects, or expose upstream diagnostics. */
export async function callContentProvider(envelope: ContentProviderEnvelope, signal: AbortSignal): Promise<ContentProviderResult> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) controller.abort()
  const timer = setTimeout(abort, envelope.timeoutMs)
  const unknown = (errorCode: NonNullable<ContentProviderResult['errorCode']>): ContentProviderResult => ({ state: 'unknown', body: null, usage: null, errorCode })
  try {
    let endpoint: string
    try { endpoint = validateContentEndpoint(envelope.endpoint) } catch { return unknown('CONTENT_ENDPOINT_INVALID') }
    const response = await fetch(endpoint, { method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${envelope.apiKey}` },
      body: JSON.stringify({ model: envelope.model, messages: envelope.messages, max_tokens: envelope.maxTokens, stream: false }) })
    if (!response.ok) {
      await response.body?.cancel()
      return unknown(response.status >= 300 && response.status < 400 ? 'CONTENT_REDIRECT_REJECTED' : 'CONTENT_UPSTREAM_HTTP')
    }
    const announced = Number(response.headers.get('content-length'))
    if (announced > MAX_RESPONSE_BYTES) { await response.body?.cancel(); return unknown('CONTENT_RESPONSE_TOO_LARGE') }
    const reader = response.body?.getReader()
    if (!reader) return unknown('CONTENT_RESPONSE_INVALID')
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); return unknown('CONTENT_RESPONSE_TOO_LARGE') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    let raw: unknown
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return unknown('CONTENT_RESPONSE_INVALID') }
    const parsed = responseSchema.safeParse(raw)
    if (!parsed.success) return unknown('CONTENT_RESPONSE_INVALID')
    let body = parsed.data.choices[0]?.message.content ?? ''
    // Even a broken upstream echoing its Authorization header cannot return the key in a public candidate.
    for (const secret of new Set([envelope.apiKey, JSON.stringify(envelope.apiKey).slice(1, -1)])) body = body.split(secret).join('[redacted]')
    if (!body.trim() || Buffer.byteLength(body) > TEAM_CONTENT_MAX_OUTPUT_BYTES) return unknown('CONTENT_RESPONSE_INVALID')
    return { state: 'succeeded', body, usage: providerUsage(parsed.data.usage), errorCode: null }
  } catch {
    return unknown(signal.aborted ? 'CONTENT_CANCELLED_IN_FLIGHT' : controller.signal.aborted ? 'CONTENT_TIMEOUT' : 'CONTENT_NETWORK_UNKNOWN')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
