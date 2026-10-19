import { proxiedFetch } from '../proxy'
import { IntegrationError } from './types'

/** Same app/Undici instance, bounded body, no credential-bearing redirects. */
export async function integrationFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
  const response = await proxiedFetch(url, { ...init, signal, redirect: 'error' })
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new IntegrationError('远端响应超过容量限制，请缩小查询范围', 'upstream') }
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
  }
  const headers = new Headers(response.headers)
  headers.delete('content-encoding'); headers.delete('content-length')
  const body = response.status === 204 || response.status === 205 || response.status === 304 ? null : new Uint8Array(Buffer.concat(chunks))
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}
export async function readRemoteJson(url: string, init?: RequestInit): Promise<{ body: unknown; response: Response }> {
  const response = await integrationFetch(url, init)
  if (!response.ok) throw new IntegrationError(response.status === 401 || response.status === 403 ? `认证或权限不足（HTTP ${response.status}）` : `远端服务返回 HTTP ${response.status}`, 'upstream')
  try { return { body: await response.json(), response } }
  catch { throw new IntegrationError('远端返回的内容不是有效 JSON', 'upstream') }
}
export function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
export function rowsOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new IntegrationError('远端列表格式不符合预期，请检查实例版本与接口权限', 'upstream')
  return value.map(recordOf)
}
export function textOf(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : '' }
export function remoteUrl(value: unknown): string {
  const text = textOf(value)
  try { const url = new URL(text); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search) return ''; return url.href }
  catch { return '' }
}
