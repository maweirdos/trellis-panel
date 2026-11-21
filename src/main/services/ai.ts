import { protectedStorage as safeStorage } from '../daemon/protected-storage'
import type { AiApiFormat, AiChatResult, AiConfig, AiConnectionTestResult, ChatImage, ChatMessage, ModelFetchResult, ModelItem, ModelTestResult, ThinkingLevel } from '../../shared/types'
import { errorMessage, isAbortError } from '../../shared/errors'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../shared/ipc-errors'
import { proxiedFetch } from './proxy'

/**
 * 应用内 AI 客户端 —— OpenAI 兼容 /chat/completions。
 * baseUrl 约定：填到 /v1 即可；以 # 结尾则原样使用（自定义完整 URL）。
 */

const TIMEOUT_MS = 120_000
const CONNECTION_TEST_TIMEOUT_MS = 10_000
const MODEL_TEST_TIMEOUT_MS = 20_000
const MODEL_TEST_RESPONSE_CHARS = 1024 * 1024
const MODEL_TEST_SSE_DATA_FIELDS = 16_384
const MODEL_TEST_MAX_ATTEMPTS = 3
const MODEL_TEST_MAX_TOKENS = 1024
const MODEL_TEST_PROMPT = 'Reply with one word: OK.'
const KEY_DECRYPT_ERROR = '无法解密已保存的 API 密钥，请重新启动应用后重试或重新保存密钥。'
const MODEL_ERROR_BODY_BYTES = 16 * 1024

function decodeJsonErrorText(input: string): { text: string; starts: number[]; ends: number[] } {
  const chars: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
  for (let i = 0; i < input.length;) {
    const start = i
    let char = input[i]
    if (char === '\\' && i + 1 < input.length) {
      const next = input[i + 1]
      const hex = input.slice(i + 2, i + 6)
      if (next === 'u' && /^[a-f\d]{4}$/i.test(hex)) {
        char = String.fromCharCode(parseInt(hex, 16))
        i += 6
      } else if (Object.prototype.hasOwnProperty.call(escapes, next)) {
        char = escapes[next]
        i += 2
      } else {
        i++
      }
    } else {
      i++
    }
    chars.push(char)
    starts.push(start)
    ends.push(i)
  }
  return { text: chars.join(''), starts, ends }
}

function redactJsonEncodedSecrets(message: string, secrets: readonly string[]): string {
  if (!message.includes('\\')) return message
  const decoded = decodeJsonErrorText(message)
  const ranges: Array<{ start: number; end: number }> = []
  for (const secret of new Set(secrets.filter(Boolean))) {
    let from = 0
    for (;;) {
      const index = decoded.text.indexOf(secret, from)
      if (index < 0) break
      ranges.push({ start: decoded.starts[index], end: decoded.ends[index + secret.length - 1] })
      from = index + secret.length
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  let safe = ''
  let end = 0
  for (const range of ranges) {
    if (range.start < end) { end = Math.max(end, range.end); continue }
    safe += `${message.slice(end, range.start)}[redacted]`
    end = range.end
  }
  return ranges.length ? safe + message.slice(end) : message
}

function redactAiError(message: string, secrets: readonly string[]): string {
  let safe = message
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join('[redacted]')
    const escaped = JSON.stringify(secret).slice(1, -1)
    if (escaped !== secret) safe = safe.split(escaped).join('[redacted]')
  }
  safe = redactJsonEncodedSecrets(safe, secrets)
  return safe
    .replace(/(["'](?:authorization|proxy-authorization|x-api-key|api[-_]?key)["']\s*:\s*)(["'])(?:\\.|(?!\2)[\s\S])*?(?:\2|$)/gi, (_match, prefix: string, quote: string) => `${prefix}${quote}[redacted]${quote}`)
    .replace(/(\b(?:authorization|proxy-authorization|x-api-key|api[-_]?key)[ \t]*[:=][ \t]*)(["'])(?:\\.|(?!\2)[\s\S])*?(?:\2|$)/gi, (_match, prefix: string, quote: string) => `${prefix}${quote}[redacted]${quote}`)
    .replace(/(\b(?:authorization|proxy-authorization|x-api-key|api[-_]?key)[ \t]*[:=][ \t]*)(?:Bearer[ \t]+)?(?:\[redacted\]|[^\s,"';}\]]+)/gi, '$1[redacted]')
    .replace(/(^|\n)([ \t]*(?:authorization|proxy-authorization|x-api-key|api[-_]?key)[ \t]*[:=][ \t]*)[^\r\n]*/gi, '$1$2[redacted]')
    .replace(/\bBearer[ \t]+(?:\[redacted\]|[^\s"',;}\]]+)/gi, 'Bearer [redacted]')
}

async function modelUpstreamError(
  response: Response,
  secrets: readonly string[],
  inspect?: (body: string) => void
): Promise<string> {
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let body = ''
  let bytes = 0
  let truncated = false
  let interrupted = false
  try {
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = MODEL_ERROR_BODY_BYTES - bytes
      body += decoder.decode(value.subarray(0, remaining), { stream: true })
      bytes += Math.min(value.byteLength, remaining)
      if (value.byteLength > remaining) {
        truncated = true
        void reader.cancel().catch(() => undefined)
        break
      }
    }
  } catch { interrupted = true } finally { reader?.releaseLock() }
  body += decoder.decode()
  if (truncated || interrupted) {
    body = ''
  } else {
    let readable = true
    const looksJson = /^\s*[\[{"]/.test(body)
    if (body && (/json/i.test(response.headers.get('content-type') ?? '') || looksJson)) {
      try { JSON.parse(body) } catch { readable = false }
    }
    if (readable || !looksJson) inspect?.(body)
    if (!readable) body = '[响应正文格式无效，已隐藏]'
  }
  const status = `HTTP ${response.status}${response.statusText ? ` ${redactAiError(response.statusText, secrets)}` : ''}`
  return [status, redactAiError(body, secrets), truncated ? '[响应正文超过 16 KiB，已截断]' : '', interrupted ? '[响应正文读取中断]' : ''].filter(Boolean).join('\n')
}

/** 保守收窄：仅当值为普通对象时返回 Record 视图，其余返回 null */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
}

/** 从 choices 数组安全取第一个元素的 message 对象 */
function firstChoiceMessage(dataObj: Record<string, unknown> | null): Record<string, unknown> | null {
  const choices = dataObj?.choices
  if (!Array.isArray(choices)) return null
  return asRecord(asRecord(choices[0])?.message)
}

export function protectAiKey(plain: string): { apiKey: string; apiKeyEncrypted: boolean } {
  try {
    if (plain && safeStorage.isEncryptionAvailable()) {
      return { apiKey: safeStorage.encryptString(plain).toString('base64'), apiKeyEncrypted: true }
    }
  } catch {
    // fall through
  }
  return { apiKey: plain, apiKeyEncrypted: false }
}

function requestKey(cfg: { apiKey?: string; apiKeyEncrypted?: boolean }): { ok: true; key: string } | IpcFail {
  try { return { ok: true, key: decryptKeyOf(cfg.apiKey ?? '', cfg.apiKeyEncrypted).trim() } }
  catch { return ipcFail(IpcErrorCode.Unavailable, KEY_DECRYPT_ERROR) }
}

export function resolveEndpoint(baseUrl: string, format?: string): string {
  let u = baseUrl.trim().replace(/\s+/g, '')
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  if (u.endsWith('#')) return u.slice(0, -1)
  u = u.replace(/\/+$/, '')
  if (format === 'response') {
    if (/\/responses$/.test(u)) return u
    return u.endsWith('/v1') ? `${u}/responses` : `${u}/v1/responses`
  }
  if (format === 'anthropic') {
    if (/\/messages$/.test(u)) return u
    return u.endsWith('/v1') ? `${u}/messages` : `${u}/v1/messages`
  }
  if (format === 'ollama') {
    if (/\/api\/chat$/.test(u)) return u
    return `${u}/api/chat`
  }
  if (/\/chat\/completions$/.test(u)) return u
  return `${u}/chat/completions`
}

export async function aiChat(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number; signal?: AbortSignal }
): Promise<AiChatResult> {
  if (!cfg.enabled) return { ok: false, error: '应用内 AI 未启用（设置 → AI 模型）' }
  const activeProvider = cfg.providers?.find((p) => p.id === cfg.activeProviderId) || cfg.providers?.[0]
  const format = activeProvider?.apiFormat || cfg.apiFormat || 'openai'
  const endpoint = resolveEndpoint(cfg.baseUrl, format)
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) return { ok: false, error: 'baseUrl 无效' }
  if (!cfg.model) return { ok: false, error: '未配置模型名' }

  const resolvedKey = requestKey(cfg)
  if (!resolvedKey.ok) return resolvedKey
  const key = resolvedKey.key
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  opts?.signal?.addEventListener('abort', abort, { once: true })
  if (opts?.signal?.aborted) controller.abort()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    let body: Record<string, unknown> | null = null

    if (format === 'anthropic') {
      if (key) {
        headers['x-api-key'] = key
        headers['anthropic-version'] = '2023-06-01'
      }
      body = {
        model: cfg.model,
        messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
        system: messages.find((m) => m.role === 'system')?.content,
        max_tokens: opts?.maxTokens ?? 2048,
        temperature: opts?.temperature ?? cfg.temperature ?? 0.3
      }
    } else if (format === 'ollama') {
      body = {
        model: cfg.model,
        messages,
        stream: false
      }
    } else if (format === 'response') {
      if (key) {
        headers['Authorization'] = `Bearer ${key}`
      }
      body = {
        model: cfg.model,
        input: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: opts?.temperature ?? cfg.temperature ?? 0.3,
        ...(opts?.maxTokens ? { max_output_tokens: opts.maxTokens } : {})
      }
    } else {
      if (key) {
        headers['Authorization'] = `Bearer ${key}`
      }
      body = {
        model: cfg.model,
        messages,
        temperature: opts?.temperature ?? cfg.temperature ?? 0.3,
        ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {})
      }
    }

    const res = await proxiedFetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      return { ok: false, error: await modelUpstreamError(res, [key, cfg.apiKey]) }
    }
    const data: unknown = await res.json()
    const dataObj = asRecord(data)
    const apiErrorMsg = asRecord(dataObj?.error)?.message
    if (typeof apiErrorMsg === 'string' && apiErrorMsg) return { ok: false, error: redactAiError(apiErrorMsg, [key, cfg.apiKey]) }

    let content: string | undefined
    if (format === 'response') {
      if (typeof dataObj?.output_text === 'string') {
        content = dataObj.output_text
      } else if (Array.isArray(dataObj?.output)) {
        for (const item of dataObj.output) {
          const itemObj = asRecord(item)
          if (itemObj?.type === 'message' && Array.isArray(itemObj.content)) {
            for (const c of itemObj.content) {
              const cObj = asRecord(c)
              if (typeof cObj?.text === 'string') {
                content = (content || '') + cObj.text
              }
            }
          }
        }
      }
      const fallbackMsg = firstChoiceMessage(dataObj)
      if (!content && typeof fallbackMsg?.content === 'string') {
        content = fallbackMsg.content
      }
    } else if (format === 'anthropic') {
      if (Array.isArray(dataObj?.content)) {
        content = dataObj.content
          .map((c: unknown) => {
            const cObj = asRecord(c)
            return typeof cObj?.text === 'string' && cObj.text ? cObj.text : ''
          })
          .join('')
      }
    } else if (format === 'ollama') {
      const msgObj = asRecord(dataObj?.message)
      if (typeof msgObj?.content === 'string') content = msgObj.content
    } else {
      const firstMsg = firstChoiceMessage(dataObj)
      if (typeof firstMsg?.content === 'string') content = firstMsg.content
    }

    if (typeof content !== 'string') return { ok: false, error: '响应缺少有效文本内容' }
    const modelField = dataObj?.model
    return { ok: true, content, model: typeof modelField === 'string' ? modelField : cfg.model }
  } catch (e) {
    const err = e as Error
    return { ok: false, error: err.name === 'AbortError' ? `请求超时（${TIMEOUT_MS / 1000}s）` : redactAiError(err.message, [key, cfg.apiKey]) }
  } finally {
    clearTimeout(timer)
    opts?.signal?.removeEventListener('abort', abort)
  }
}

export async function aiTest(cfg: AiConfig): Promise<AiChatResult> {
  return aiChat({ ...cfg, enabled: true }, [{ role: 'user', content: '回复"ok"两个字母即可。' }], { maxTokens: 16, temperature: 0 })
}

export function inferModelMetadata(id: string): { contextWindow?: string; tags: string[] } {
  const lower = id.toLowerCase()
  const tags: string[] = []
  let contextWindow: string | undefined

  if (lower.includes('1m') || lower.includes('1000k') || lower.includes('1024k')) {
    contextWindow = '1M'
    tags.push('1M')
  } else if (lower.includes('200k')) {
    contextWindow = '200k'
    tags.push('200k')
  } else if (lower.includes('128k')) {
    contextWindow = '128k'
    tags.push('128k')
  } else if (lower.includes('64k')) {
    contextWindow = '64k'
    tags.push('64k')
  } else if (lower.includes('32k')) {
    contextWindow = '32k'
    tags.push('32k')
  } else if (lower.includes('16k')) {
    contextWindow = '16k'
    tags.push('16k')
  } else if (lower.includes('8k')) {
    contextWindow = '8k'
    tags.push('8k')
  }

  if (
    lower.includes('vision') ||
    lower.includes('vl') ||
    lower.includes('4o') ||
    lower.includes('sonnet') ||
    lower.includes('opus') ||
    lower.includes('flash') ||
    lower.includes('gemini')
  ) {
    tags.push('视觉')
  }

  if (
    lower.includes('coder') ||
    lower.includes('code') ||
    lower.includes('coding') ||
    lower.includes('codex')
  ) {
    tags.push('代码')
  }

  if (
    lower.includes('r1') ||
    lower.includes('o1') ||
    lower.includes('o3') ||
    lower.includes('reason') ||
    lower.includes('thinking') ||
    lower.includes('deepseek-r1')
  ) {
    tags.push('推理')
  }

  return { contextWindow, tags }
}

export async function fetchModelsFromProvider(cfg: {
  baseUrl: string
  apiKey?: string
  apiKeyEncrypted?: boolean
  apiFormat: string
}): Promise<ModelFetchResult> {
  let u = cfg.baseUrl.trim().replace(/\s+/g, '')
  if (!u) return { ok: false, error: 'Base URL 不能为空' }
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  u = u.replace(/\/+$/, '')

  const resolvedKey = requestKey(cfg)
  if (!resolvedKey.ok) return resolvedKey
  const key = resolvedKey.key
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)

  try {
    let endpoint = ''
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    if (cfg.apiFormat === 'ollama') {
      endpoint = `${u}/api/tags`
    } else if (cfg.apiFormat === 'anthropic') {
      endpoint = u.endsWith('/v1') ? `${u}/models` : `${u}/v1/models`
      if (key) {
        headers['x-api-key'] = key
        headers['anthropic-version'] = '2023-06-01'
      }
    } else {
      if (u.endsWith('/v1')) {
        endpoint = `${u}/models`
      } else if (/\/chat\/completions$/.test(u)) {
        endpoint = u.replace(/\/chat\/completions$/, '/models')
      } else if (/\/responses$/.test(u)) {
        endpoint = u.replace(/\/responses$/, '/models')
      } else {
        endpoint = `${u}/v1/models`
      }
      if (key) {
        headers['Authorization'] = `Bearer ${key}`
      }
    }

    const res = await proxiedFetch(endpoint, {
      method: 'GET',
      headers,
      signal: controller.signal
    })

    if (!res.ok) {
      return { ok: false, error: await modelUpstreamError(res, [key, cfg.apiKey ?? '']) }
    }

    const data: unknown = await res.json()
    const dataObj = asRecord(data)
    const dataField = dataObj?.data
    const modelsField = dataObj?.models
    const rawList: unknown[] = Array.isArray(dataField)
      ? dataField
      : Array.isArray(modelsField)
        ? modelsField
        : Array.isArray(data)
          ? data
          : []

    if (!rawList.length) {
      return { ok: false, error: '供应商未返回可用模型列表' }
    }

    const models: ModelItem[] = rawList.map((item: unknown) => {
      const itemObj = asRecord(item)
      const id = String(itemObj?.id || itemObj?.name || '')
      const { contextWindow, tags } = inferModelMetadata(id)
      return {
        id,
        name: id,
        contextWindow,
        tags,
        enabled: true
      }
    })

    return { ok: true, models }
  } catch (e) {
    return { ok: false, error: isAbortError(e) ? '获取模型超时 (15s)' : redactAiError(errorMessage(e) || '网络请求失败', [key, cfg.apiKey ?? '']) }
  } finally {
    clearTimeout(timer)
  }
}

export async function testConnection(baseUrl: string): Promise<AiConnectionTestResult> {
  let url = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\s+/g, '') : ''
  if (!url) return ipcFail(IpcErrorCode.InvalidArg, 'Base URL 不能为空')
  if (url.endsWith('#')) url = url.slice(0, -1)
  if (!/^https?:\/\//i.test(url)) {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) return ipcFail(IpcErrorCode.InvalidArg, 'Base URL 无效')
    url = `http://${url}`
  }
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return ipcFail(IpcErrorCode.InvalidArg, 'Base URL 无效')
    }
    url = parsed.href
  } catch {
    return ipcFail(IpcErrorCode.InvalidArg, 'Base URL 无效')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONNECTION_TEST_TIMEOUT_MS)
  const start = performance.now()
  try {
    const response = await proxiedFetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal })
    const latencyMs = Math.round(performance.now() - start)
    if (controller.signal.aborted) return ipcFail(IpcErrorCode.Timeout, '连接超时 (10s)')
    void response.body?.cancel().catch(() => undefined)
    return { ok: true, latencyMs, httpStatus: response.status }
  } catch {
    return controller.signal.aborted
      ? ipcFail(IpcErrorCode.Timeout, '连接超时 (10s)')
      : ipcFail(IpcErrorCode.Upstream, '连接失败')
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

function hasModelText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function isModelFailureStatus(status: unknown): boolean {
  return typeof status === 'string' && ['failed', 'failure', 'error', 'incomplete', 'cancelled', 'canceled', 'aborted', 'timeout', 'timed_out'].includes(status.toLowerCase())
}

function messageHasText(message: Record<string, unknown> | null, partType: string): boolean {
  if (!message || (message.role !== undefined && message.role !== 'assistant')) return false
  if (isModelFailureStatus(message.status)) return false
  if (hasModelText(message.content)) return true
  return Array.isArray(message.content) && message.content.some((part: unknown) => {
    const item = asRecord(part)
    return item?.type === partType && hasModelText(item.text)
  })
}

function modelTestSecrets(baseUrl: string, endpoint: string, key: string, encryptedKey: string): string[] {
  const secrets = new Set([baseUrl, endpoint, key, encryptedKey])
  const addValue = (raw: string): void => {
    if (!raw) return
    secrets.add(raw)
    let decoded = raw.replace(/\+/g, ' ')
    try { decoded = decodeURIComponent(decoded) } catch { /* retain the original malformed value */ }
    secrets.add(decoded)
    secrets.add(new URLSearchParams([['value', decoded]]).toString().slice(6))
    try {
      secrets.add(encodeURIComponent(decoded))
      secrets.add(encodeURIComponent(raw))
    } catch { /* malformed UTF-16 cannot be URI encoded */ }
    secrets.add(raw.replace(/%[a-f\d]{2}/gi, (part) => part.toLowerCase()))
    secrets.add(raw.replace(/%[a-f\d]{2}/gi, (part) => part.toUpperCase()))
  }
  for (const url of [baseUrl, endpoint]) {
    const authority = /^(?:[a-z][a-z\d+.-]*:\/\/)?([^/?#]*)/i.exec(url.trim())?.[1] ?? ''
    const at = authority.lastIndexOf('@')
    if (at >= 0) {
      const userinfo = authority.slice(0, at)
      addValue(userinfo)
      for (const part of userinfo.split(':')) addValue(part)
    }
    const query = /\?([^#]*)/.exec(url)?.[1]
    if (query) {
      for (const part of query.split(/[&;]/)) {
        const separator = part.indexOf('=')
        if (separator >= 0) addValue(part.slice(separator + 1))
      }
    }
  }
  return [...secrets].filter(Boolean)
}

function modelTestError(detail: unknown, secrets: readonly string[], fallback = '模型服务返回错误'): Error {
  let text = ''
  if (typeof detail === 'string') text = detail
  else if (detail !== undefined && detail !== null) text = JSON.stringify(detail) ?? ''
  const safe = redactAiError(text, secrets)
  return new Error(safe ? `${fallback}: ${safe.slice(0, MODEL_ERROR_BODY_BYTES)}` : fallback)
}

function checkModelFailure(obj: Record<string, unknown>, secrets: readonly string[]): void {
  const reason = asRecord(obj.incomplete_details)?.reason
  if (obj.status === 'incomplete' && typeof reason === 'string' && /(?:max.*tokens?|token.*limit|length)/i.test(reason)) {
    throw modelTestError(obj, secrets, '模型输出达到 token 上限')
  }
  if (obj.error !== undefined && obj.error !== null && obj.error !== false) {
    throw modelTestError(obj.error, secrets)
  }
  if (isModelFailureStatus(obj.status)) {
    const detail = obj.incomplete_details ?? obj
    throw modelTestError(detail, secrets, '模型响应未成功完成')
  }
}

function checkFinishReason(reason: unknown, accepted: readonly string[], secrets: readonly string[]): boolean {
  if (reason === undefined || reason === null) return false
  if (typeof reason !== 'string' || !reason) throw new Error('模型结束原因无效')
  if (/(?:^length$|max.*tokens?|token.*limit)/i.test(reason)) {
    throw modelTestError(reason, secrets, '模型输出达到 token 上限')
  }
  if (!accepted.includes(reason)) throw modelTestError(reason, secrets, '模型响应未成功完成')
  return true
}

function completeModelHasText(data: unknown, format: string, secrets: readonly string[]): boolean {
  const obj = asRecord(data)
  if (!obj) throw new Error('模型响应格式无效')
  checkModelFailure(obj, secrets)
  if (format === 'anthropic') {
    if (!checkFinishReason(obj.stop_reason, ['end_turn', 'stop_sequence'], secrets)) {
      throw new Error('模型响应尚未结束')
    }
    return Array.isArray(obj.content) && messageHasText(obj, 'text')
  }
  if (format === 'ollama') {
    if (obj.done !== true) throw new Error('模型响应尚未结束')
    if ('done_reason' in obj && !checkFinishReason(obj.done_reason, ['stop'], secrets)) {
      throw new Error('模型响应尚未结束')
    }
    const message = asRecord(obj.message)
    if (message) checkModelFailure(message, secrets)
    return messageHasText(message, 'text')
  }
  if (format === 'response') {
    if (obj.status !== 'completed') throw new Error('模型响应尚未结束')
    if (obj.incomplete_details !== undefined && obj.incomplete_details !== null) {
      throw modelTestError(obj.incomplete_details, secrets, '模型响应未成功完成')
    }
    if (Array.isArray(obj.output)) {
      for (const item of obj.output) {
        const output = asRecord(item)
        if (output) {
          checkModelFailure(output, secrets)
          if (output.type === 'message' && output.status !== undefined && output.status !== 'completed') {
            throw new Error('模型响应尚未结束')
          }
        }
      }
    }
    if (hasModelText(obj.output_text)) return true
    return Array.isArray(obj.output) && obj.output.some((item: unknown) => {
      const message = asRecord(item)
      return message?.type === 'message' && Array.isArray(message.content) && (message.status === undefined || message.status === 'completed')
        && messageHasText(message, 'output_text')
    })
  }
  const choice = Array.isArray(obj.choices) ? asRecord(obj.choices[0]) : null
  if (choice) checkModelFailure(choice, secrets)
  if (!choice || !checkFinishReason(choice.finish_reason, ['stop'], secrets)) {
    throw new Error('模型响应尚未结束')
  }
  const message = asRecord(choice?.message)
  if (message) checkModelFailure(message, secrets)
  return messageHasText(message, 'text')
}

type ModelTestStreamState = { firstOutputAt?: number; completed: boolean }

function processModelTestEvent(
  payload: string,
  eventName: string,
  format: string,
  state: ModelTestStreamState,
  secrets: readonly string[]
): void {
  if (payload.trim() === '[DONE]') {
    if (['error', 'response.failed', 'response.incomplete', 'response.cancelled', 'response.canceled'].includes(eventName)) {
      throw new Error('模型服务返回错误')
    }
    if (format === 'anthropic' || format === 'response') {
      if (state.completed) return
      throw new Error('模型响应结束标记无效')
    }
    if (format === 'ollama') throw new Error('模型响应结束标记无效')
    if (state.firstOutputAt === undefined) throw new Error('模型响应结束，但未返回有效文本')
    state.completed = true
    return
  }
  let data: unknown
  try { data = JSON.parse(payload) as unknown } catch {
    if (eventName === 'error') throw new Error('模型服务返回错误（响应格式无效）')
    throw new Error('模型响应格式无效')
  }
  const obj = asRecord(data)
  if (!obj) throw new Error('模型响应格式无效')
  const type = typeof obj.type === 'string' ? obj.type : eventName
  const failedEvents = ['error', 'response.failed', 'response.incomplete', 'response.cancelled', 'response.canceled']
  const nestedResponse = asRecord(obj.response)
  checkModelFailure(obj, secrets)
  if (nestedResponse) checkModelFailure(nestedResponse, secrets)
  if (failedEvents.includes(eventName) || failedEvents.includes(type)) {
    throw modelTestError(obj.error ?? nestedResponse?.error ?? nestedResponse?.incomplete_details ?? obj, secrets)
  }
  const markOutput = (hasText: boolean): void => {
    if (hasText && state.firstOutputAt === undefined) state.firstOutputAt = performance.now()
  }
  const finish = (): void => {
    if (state.firstOutputAt === undefined) throw new Error('模型响应结束，但未返回有效文本')
    state.completed = true
  }

  if (format === 'ollama') {
    const message = asRecord(obj.message)
    if (message) checkModelFailure(message, secrets)
    markOutput(messageHasText(message, 'text'))
    if (obj.done === true) {
      checkFinishReason(obj.done_reason, ['stop'], secrets)
      finish()
    }
    return
  }
  if (format === 'anthropic') {
    if (type === 'content_block_start') {
      const block = asRecord(obj.content_block)
      if (block) checkModelFailure(block, secrets)
      markOutput(block?.type === 'text' && hasModelText(block.text))
    } else if (type === 'content_block_delta') {
      const delta = asRecord(obj.delta)
      if (delta) checkModelFailure(delta, secrets)
      markOutput(delta?.type === 'text_delta' && hasModelText(delta.text))
    } else if (type === 'message_delta') {
      checkFinishReason(asRecord(obj.delta)?.stop_reason, ['end_turn', 'stop_sequence'], secrets)
    } else if (type === 'message_stop') {
      checkFinishReason(obj.stop_reason, ['end_turn', 'stop_sequence'], secrets)
      finish()
    }
    return
  }
  if (format === 'response') {
    if (type === 'response.output_text.delta') markOutput(hasModelText(obj.delta))
    else if (type === 'response.output_text.done') markOutput(hasModelText(obj.text))
    else if (type === 'response.completed') {
      if (nestedResponse) {
        if (nestedResponse.status !== undefined && nestedResponse.status !== 'completed') throw new Error('模型响应尚未结束')
        if (nestedResponse.incomplete_details !== undefined && nestedResponse.incomplete_details !== null) {
          throw modelTestError(nestedResponse.incomplete_details, secrets, '模型响应未成功完成')
        }
        markOutput(completeModelHasText({ ...nestedResponse, status: 'completed' }, format, secrets))
      }
      finish()
    }
    return
  }
  const choices = obj.choices
  if (!Array.isArray(choices)) return
  const choice = asRecord(choices[0])
  if (!choice) return
  checkModelFailure(choice, secrets)
  const delta = asRecord(choice.delta)
  if (delta) checkModelFailure(delta, secrets)
  markOutput(messageHasText(delta, 'text'))
  if (checkFinishReason(choice.finish_reason, ['stop'], secrets)) finish()
}

type ModelTestOutput = { latencyKind: 'first_output' | 'response'; latencyMs: number }

async function readModelTestOutput(
  response: Response,
  format: string,
  start: number,
  secrets: readonly string[],
  requireJson: boolean
): Promise<ModelTestOutput> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('模型响应为空')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  let mode: 'detect' | 'json' | 'ollama-json' | 'sse' | 'ndjson' = requireJson ? 'json' : 'detect'
  let buffer = ''
  let eventName = ''
  let eventData = ''
  let hasEventData = false
  let totalDataSize = 0
  let totalDataFields = 0
  const state: ModelTestStreamState = { completed: false }

  const dispatchSse = (): void => {
    const name = eventName
    const data = eventData
    const hadData = hasEventData
    eventName = ''
    eventData = ''
    hasEventData = false
    if (name === 'error' && !data) throw new Error('模型服务返回错误')
    if (hadData && data) processModelTestEvent(data, name, format, state, secrets)
  }
  const consumeLine = (line: string): void => {
    if (mode === 'ndjson') {
      if (line.trim()) processModelTestEvent(line, '', format, state, secrets)
      return
    }
    if (!line) { dispatchSse(); return }
    if (line.startsWith(':')) return
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') eventName = value
    if (field === 'data') {
      totalDataSize += value.length + 1
      totalDataFields++
      if (totalDataSize > MODEL_TEST_RESPONSE_CHARS || totalDataFields > MODEL_TEST_SSE_DATA_FIELDS) {
        throw new Error('模型响应过大')
      }
      eventData += `${hasEventData ? '\n' : ''}${value}`
      hasEventData = true
    }
  }
  const consumeLines = (ended: boolean): void => {
    for (;;) {
      const index = buffer.search(/[\r\n]/)
      if (index < 0 || (!ended && buffer[index] === '\r' && index === buffer.length - 1)) break
      const line = buffer.slice(0, index)
      const length = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1
      buffer = buffer.slice(index + length)
      consumeLine(line)
    }
    if (ended && mode === 'ndjson' && buffer.trim()) {
      const line = buffer
      buffer = ''
      consumeLine(line)
    }
  }
  const consume = (text: string, ended: boolean): ModelTestOutput | undefined => {
    buffer += text
    if (buffer.length > MODEL_TEST_RESPONSE_CHARS) throw new Error('模型响应过大')
    if (mode === 'detect') {
      const first = buffer.trimStart()[0]
      if (!first) {
        if (ended) throw new Error('模型响应为空')
        return undefined
      }
      if (first === '{' || first === '[') {
        mode = format === 'ollama'
          ? (/ndjson|jsonl/.test(contentType) ? 'ndjson' : 'ollama-json')
          : 'json'
      } else {
        mode = 'sse'
      }
    }
    if (mode === 'ollama-json') {
      const lineEnd = buffer.search(/[\r\n]/)
      if (lineEnd >= 0) {
        let firstRecord: Record<string, unknown> | null = null
        try { firstRecord = asRecord(JSON.parse(buffer.slice(0, lineEnd)) as unknown) } catch { /* complete JSON may be pretty-printed */ }
        mode = firstRecord?.done === false ? 'ndjson' : 'json'
      } else if (ended) {
        mode = 'json'
      }
    }
    if (mode === 'sse' || mode === 'ndjson') {
      consumeLines(ended)
      if (state.completed && state.firstOutputAt !== undefined) {
        return { latencyKind: 'first_output', latencyMs: Math.round(state.firstOutputAt - start) }
      }
      if (ended) throw new Error('模型流在成功结束前中断')
    } else if (mode === 'json' && ended) {
      let data: unknown
      try { data = JSON.parse(buffer) as unknown } catch { throw new Error('模型响应格式无效') }
      if (!completeModelHasText(data, format, secrets)) throw new Error('模型响应缺少有效文本内容')
      return { latencyKind: 'response', latencyMs: Math.round(performance.now() - start) }
    }
    return undefined
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      const result = consume(done ? decoder.decode() : decoder.decode(value, { stream: true }), done)
      if (result) return result
      if (done) throw new Error('模型响应为空')
    }
  } finally {
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function streamingUnsupported(body: string): boolean {
  try {
    const error = asRecord(asRecord(JSON.parse(body) as unknown)?.error)
    if (error?.param === 'stream' && error.code === 'unsupported_value') return true
  } catch { /* plain text errors can still explicitly reject streaming */ }
  return /\bstream["']?\s+does\s+not\s+support\s+["']?true\b/i.test(body)
    || /\bstream(?:ing)?\b(?:["']?\s*[:=]\s*true\b)?(?:\s+(?:requests?|responses?|mode|feature))?\s+(?:(?:is|are)\s+)?(?:currently\s+)?(?:not\s+supported|unsupported|disabled|not\s+available)\b/i.test(body)
    || /\b(?:does\s+not|doesn't|do\s+not|cannot|can't)\s+(?:currently\s+)?(?:support|allow|accept)\s+(?:the\s+)?stream(?:ing)?\b/i.test(body)
    || /\bunsupported\s+stream(?:ing)?\b/i.test(body)
    || /\bstream\b.{0,35}\bmust\s+(?:be|equal)\s+false\b/i.test(body)
}

function unsupportedMaxCompletionTokens(body: string): boolean {
  try {
    const error = asRecord(asRecord(JSON.parse(body) as unknown)?.error)
    if (error?.param === 'max_completion_tokens' && typeof error.code === 'string'
      && ['unsupported_parameter', 'unknown_parameter', 'unrecognized_parameter', 'unexpected_parameter'].includes(error.code)) return true
  } catch { /* plain text errors can still explicitly identify the unsupported field */ }
  return /\bmax_completion_tokens\b["']?\s+(?:(?:is|are)\s+)?(?:not\s+supported|unsupported|not\s+allowed|unrecognized|unknown)\b/i.test(body)
    || /\b(?:unsupported|unrecognized|unknown|unexpected)\s+(?:request\s+)?(?:parameter|argument(?:\s+supplied)?|field|keyword(?:\s+argument)?)\s*[:'"\s]+\bmax_completion_tokens\b/i.test(body)
    || /\b(?:does\s+not|doesn't|do\s+not|cannot|can't)\s+(?:support|recognize|accept)\s+(?:the\s+)?(?:parameter\s+)?["']?max_completion_tokens\b/i.test(body)
}

export async function testSingleModel(
  provider: {
    baseUrl: string
    apiKey?: string
    apiKeyEncrypted?: boolean
    apiFormat: string
    model?: string
  },
  modelId?: string
): Promise<ModelTestResult> {
  const targetModel = modelId !== undefined ? modelId : provider?.model ?? ''
  if (typeof targetModel !== 'string' || !targetModel) return ipcFail(IpcErrorCode.InvalidArg, '未指定测试模型')
  if (typeof provider?.baseUrl !== 'string' || !provider.baseUrl.trim()) return ipcFail(IpcErrorCode.InvalidArg, 'Base URL 不能为空')
  const endpoint = resolveEndpoint(provider.baseUrl, provider.apiFormat)

  const resolvedKey = requestKey(provider)
  if (!resolvedKey.ok) return resolvedKey
  const key = resolvedKey.key
  const secrets = modelTestSecrets(provider.baseUrl, endpoint, key, provider.apiKey ?? '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODEL_TEST_TIMEOUT_MS)

  try {
    let body: Record<string, unknown>
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    if (provider.apiFormat === 'anthropic') {
      if (key) {
        headers['x-api-key'] = key
        headers['anthropic-version'] = '2023-06-01'
      }
      body = {
        model: targetModel,
        max_tokens: MODEL_TEST_MAX_TOKENS,
        messages: [{ role: 'user', content: MODEL_TEST_PROMPT }],
        stream: true
      }
    } else if (provider.apiFormat === 'ollama') {
      body = {
        model: targetModel,
        messages: [{ role: 'user', content: MODEL_TEST_PROMPT }],
        options: { num_predict: MODEL_TEST_MAX_TOKENS },
        stream: true
      }
    } else if (provider.apiFormat === 'response') {
      if (key) {
        headers['Authorization'] = `Bearer ${key}`
      }
      body = {
        model: targetModel,
        input: MODEL_TEST_PROMPT,
        max_output_tokens: MODEL_TEST_MAX_TOKENS,
        stream: true
      }
    } else {
      if (key) {
        headers['Authorization'] = `Bearer ${key}`
      }
      body = {
        model: targetModel,
        messages: [{ role: 'user', content: MODEL_TEST_PROMPT }],
        max_completion_tokens: MODEL_TEST_MAX_TOKENS,
        stream: true
      }
    }

    let requireJson = false
    let useLegacyTokens = false
    let attempts = 0
    for (;;) {
      attempts++
      const start = performance.now()
      const res = await proxiedFetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      })

      if (!res.ok) {
        let unsupportedStream = false
        let unsupportedModernLimit = false
        const error = await modelUpstreamError(res, secrets, (responseBody) => {
          if (res.status === 400 || res.status === 422) {
            const rawStreamRejection = streamingUnsupported(responseBody)
            const rawLimitRejection = unsupportedMaxCompletionTokens(responseBody)
            const diagnostic = redactAiError(responseBody, secrets)
            unsupportedStream = rawStreamRejection && streamingUnsupported(diagnostic)
            unsupportedModernLimit = provider.apiFormat !== 'anthropic' && provider.apiFormat !== 'ollama'
              && provider.apiFormat !== 'response' && rawLimitRejection && unsupportedMaxCompletionTokens(diagnostic)
          }
        })
        if (controller.signal.aborted) return ipcFail(IpcErrorCode.Timeout, '连接超时 (20s)')
        const retryWithoutStreaming = !requireJson && unsupportedStream
        const retryWithLegacyTokens = !useLegacyTokens && unsupportedModernLimit
        if (attempts < MODEL_TEST_MAX_ATTEMPTS && (retryWithoutStreaming || retryWithLegacyTokens)) {
          if (retryWithoutStreaming) {
            requireJson = true
            body = { ...body, stream: false }
          }
          if (retryWithLegacyTokens) {
            useLegacyTokens = true
            const { max_completion_tokens: _maxCompletionTokens, ...rest } = body
            body = { ...rest, max_tokens: MODEL_TEST_MAX_TOKENS }
          }
          continue
        }
        return ipcFail(IpcErrorCode.Upstream, error)
      }
      const result = await readModelTestOutput(res, provider.apiFormat, start, secrets, requireJson)
      if (controller.signal.aborted) return ipcFail(IpcErrorCode.Timeout, '连接超时 (20s)')
      return { ok: true, ...result, model: targetModel, message: `连接正常 (${result.latencyMs}ms)` }
    }
  } catch (e) {
    return controller.signal.aborted || isAbortError(e)
      ? ipcFail(IpcErrorCode.Timeout, '连接超时 (20s)')
      : ipcFail(IpcErrorCode.Upstream, redactAiError(errorMessage(e) || '连接失败', secrets))
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/* ---------------- 任务上下文 AI 能力 ---------------- */

interface TaskContextInput {
  title: string
  description: string
  notes: string
  subtasks: string[]
  specTitles: string[]
  devType: string | null
  scope: string | null
}

const PRD_SYSTEM = `你是资深产品经理。基于给定的任务信息产出一份中文 PRD（Markdown），供 AI 开发者直接消费。要求：
- 使用以下章节结构：## 背景与目标、## 用户故事、## 功能需求（带编号 FR-1…）、## 非目标、## 边界与约束、## 验收标准（可勾选清单）、## 开放问题
- 只依据给定信息，不虚构业务细节；信息不足时写入「开放问题」
- 直接输出 Markdown 正文，不要额外解释`

const SUMMARY_SYSTEM = `你是研发助手。用中文对任务做摘要：一段话（≤120字）概括目标与当前状态，再列出最多 5 条要点。直接输出 Markdown，不要解释。`

function taskUserPrompt(t: TaskContextInput, kind: 'prd' | 'summary'): string {
  const lines = [
    `任务标题：${t.title}`,
    t.devType ? `开发类型：${t.devType}` : '',
    t.scope ? `范围：${t.scope}` : '',
    `描述：\n${t.description || '（无）'}`,
    t.notes ? `备注：\n${t.notes}` : '',
    t.subtasks.length ? `子任务：\n${t.subtasks.map((s) => `- ${s}`).join('\n')}` : '',
    t.specTitles.length ? `项目相关规范（供参考命名，勿展开内容）：\n${t.specTitles.map((s) => `- ${s}`).join('\n')}` : ''
  ].filter(Boolean)
  return `${lines.join('\n\n')}\n\n请${kind === 'prd' ? '生成 PRD' : '生成任务摘要'}。`
}

export async function aiTaskPrompt(
  cfg: AiConfig,
  task: TaskContextInput,
  kind: 'prd' | 'summary'
): Promise<AiChatResult> {
  return aiChat(cfg, [
    { role: 'system', content: kind === 'prd' ? PRD_SYSTEM : SUMMARY_SYSTEM },
    { role: 'user', content: taskUserPrompt(task, kind) }
  ], { temperature: kind === 'prd' ? 0.4 : 0.2 })
}

/* ---------------- 流式对话（SSE / NDJSON） ---------------- */

/** 流式调用的目标：对话按会话绑定 provider+model，因此独立于全局 AiConfig */
export interface StreamTarget {
  baseUrl: string
  apiFormat: AiApiFormat
  apiKey?: string
  model: string
  temperature?: number
  maxTokens?: number
  /** 思考档位：按协议映射请求参数；off 或缺省不携带思考参数（TPD-014） */
  thinkingLevel?: ThinkingLevel
}

export interface StreamCallbacks {
  onDelta: (text: string) => void
  /** 思考流增量（reasoning_content / thinking_delta），独立于正文 */
  onReasoning?: (text: string) => void
  signal?: AbortSignal
  /** agent 工具循环：OpenAI function 工具表；传入后解析 tool_calls 增量（TPD-020） */
  tools?: Array<Record<string, unknown>>
}

export interface ToolCallReq {
  id: string
  name: string
  argsJson: string
}

/** agent 循环的上下文消息：普通消息之外还允许 assistant.tool_calls 与 tool 结果（TPD-020） */
export type AgentLoopMessage =
  | ChatMessage
  | {
      role: 'assistant'
      content: string
      tool_calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface StreamResult {
  ok: boolean
  content?: string
  reasoning?: string
  /** agent 循环：模型请求的工具调用（openai tool_calls 聚合） */
  toolCalls?: ToolCallReq[]
  error?: string
  aborted?: boolean
}

export function decryptKeyOf(apiKey: string, encrypted?: boolean): string {
  if (!apiKey) return ''
  if (!encrypted) return apiKey
  const ciphertext = Buffer.from(apiKey, 'base64')
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Protection unavailable')
    return safeStorage.decryptString(ciphertext)
  } catch {
    throw new Error(KEY_DECRYPT_ERROR)
  } finally { ciphertext.fill(0) }
}

/** 解析 dataURL 为 {mediaType, base64}；非 dataURL 返回 null */
function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl.trim())
  return m ? { mediaType: m[1], base64: m[2] } : null
}

function stripDataUrlPrefix(dataUrl: string): string {
  return parseDataUrl(dataUrl)?.base64 ?? dataUrl
}

/** 把 user 消息升维为多模态内容分片（openai 形态） */
function toOpenAiContent(m: ChatMessage): string | Array<Record<string, unknown>> {
  if (!m.images?.length) return m.content
  const parts: Array<Record<string, unknown>> = []
  for (const img of m.images) {
    const dataUrl = img.dataBase64.includes(',') ? `data:${img.mediaType};base64,${img.dataBase64}` : parseDataUrlSafe(img)
    parts.push({ type: 'image_url', image_url: { url: dataUrl } })
  }
  parts.push({ type: 'text', text: m.content })
  return parts
}

function parseDataUrlSafe(img: ChatImage): string {
  return `data:${img.mediaType};base64,${img.dataBase64}`
}

/** 把 user 消息升维为多模态内容分片（anthropic 形态） */
function toAnthropicContent(m: ChatMessage): string | Array<Record<string, unknown>> {
  if (!m.images?.length) return m.content
  const parts: Array<Record<string, unknown>> = []
  for (const img of m.images) {
    parts.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 } })
  }
  parts.push({ type: 'text', text: m.content })
  return parts
}

/** SSE 行解析：把字节流切成 data: 负载行；`[DONE]` 转换为显式标记 */
async function readSseLines(
  res: Response,
  onPayload: (payload: string) => void
): Promise<void> {
  const body = res.body
  if (!body) throw new Error('响应无 body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return
        onPayload(payload)
      }
      // 非 data 行（event:/id:/retry:）对本协议无意义，忽略
    }
  }
}

/** NDJSON 行解析（ollama /api/chat 流式形态） */
async function readNdjsonLines(
  res: Response,
  onLine: (line: string) => void
): Promise<void> {
  const body = res.body
  if (!body) throw new Error('响应无 body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) onLine(line)
    }
  }
  if (buffer.trim()) onLine(buffer.trim())
}

/**
 * 流式对话：openai chat.completions / anthropic messages / ollama chat / responses。
 * 逐段回调 onDelta；signal 触发时中断并返回 aborted。
 */
export async function aiChatStream(
  target: StreamTarget,
  messages: ReadonlyArray<ChatMessage | AgentLoopMessage>,
  cb: StreamCallbacks
): Promise<StreamResult> {
  const format = target.apiFormat || 'openai'
  const endpoint = resolveEndpoint(target.baseUrl, format)
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) return { ok: false, error: 'baseUrl 无效' }
  if (!target.model) return { ok: false, error: '未配置模型名' }

  const key = target.apiKey?.trim() || ''
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  cb.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let body: Record<string, unknown>
  const THINKING_BUDGET: Record<Exclude<ThinkingLevel, 'off'>, number> = { low: 4096, medium: 8192, high: 16384 }
  if (format === 'anthropic') {
    if (key) {
      headers['x-api-key'] = key
      headers['anthropic-version'] = '2023-06-01'
    }
    const level = target.thinkingLevel
    const budget = level && level !== 'off' ? THINKING_BUDGET[level] : null
    body = {
      model: target.model,
      messages: messages
        .filter((m) => m.role !== 'system' && m.role !== 'tool' && !('tool_calls' in m))
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: 'images' in m && m.images?.length ? toAnthropicContent(m) : m.content
        })),
      system: messages.find((m) => m.role === 'system')?.content,
      // anthropic 约束：max_tokens 必须大于 thinking budget
      max_tokens: budget ? Math.max(target.maxTokens ?? 0, budget + 1024) : target.maxTokens ?? 4096,
      temperature: target.temperature ?? 0.3,
      ...(budget ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
      stream: true
    }
  } else if (format === 'ollama') {
    body = {
      model: target.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...('images' in m && m.images?.length
          ? { images: m.images.map((img) => (img.dataBase64.includes(',') ? stripDataUrlPrefix(img.dataBase64) : img.dataBase64)) }
          : {})
      })),
      stream: true
    }
  } else if (format === 'response') {
    if (key) headers['Authorization'] = `Bearer ${key}`
    body = {
      model: target.model,
      input: messages.map((m) => {
        if (m.role !== 'user' || !m.images?.length) return { role: m.role, content: m.content }
        // response 格式图像分片（TPD-022）：input_image 直接接受 dataURL
        const parts: Array<Record<string, unknown>> = m.images.map((img) => ({
          type: 'input_image',
          image_url: `data:${img.mediaType};base64,${img.dataBase64}`
        }))
        parts.push({ type: 'input_text', text: m.content })
        return { role: m.role, content: parts }
      }),
      temperature: target.temperature ?? 0.3,
      stream: true
    }
  } else {
    if (key) headers['Authorization'] = `Bearer ${key}`
    body = {
      model: target.model,
      messages: messages.map((m) => {
        const out: Record<string, unknown> = { role: m.role }
        if ('images' in m && m.images?.length) out.content = toOpenAiContent(m)
        else out.content = m.content
        if ('tool_calls' in m && m.tool_calls) out.tool_calls = m.tool_calls
        if ('tool_call_id' in m) out.tool_call_id = m.tool_call_id
        return out
      }),
      temperature: target.temperature ?? 0.3,
      max_tokens: target.maxTokens,
      // agent 工具循环（TPD-020）
      ...(cb.tools?.length ? { tools: cb.tools, tool_choice: 'auto' } : {}),
      // reasoning 模型识别 reasoning_effort；严格网关可能忽略或拒绝，属供应商差异
      ...(target.thinkingLevel && target.thinkingLevel !== 'off'
        ? { reasoning_effort: target.thinkingLevel }
        : {}),
      stream: true
    }
  }

  let content = ''
  const toolCallsAcc = new Map<number, { id: string; name: string; argsBuf: string }>()
  try {
    const res = await proxiedFetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      return { ok: false, error: await modelUpstreamError(res, [key]) }
    }

    let reasoning = ''
    const emitDelta = (delta: unknown): void => {
      if (typeof delta === 'string' && delta) {
        content += delta
        cb.onDelta(delta)
      }
    }
    const emitReasoning = (text: unknown): void => {
      if (typeof text === 'string' && text) {
        reasoning += text
        cb.onReasoning?.(text)
      }
    }

    if (format === 'ollama') {
      await readNdjsonLines(res, (line) => {
        const obj = asRecord(JSON.parse(line) as unknown)
        emitDelta(asRecord(obj?.message)?.content)
      })
    } else if (format === 'anthropic') {
      await readSseLines(res, (payload) => {
        const obj = asRecord(JSON.parse(payload) as unknown)
        if (obj?.type !== 'content_block_delta') return
        const delta = asRecord(obj.delta)
        if (delta?.type === 'text_delta') emitDelta(delta.text)
        else if (delta?.type === 'thinking_delta') emitReasoning(delta.thinking)
      })
    } else if (format === 'response') {
      await readSseLines(res, (payload) => {
        const obj = asRecord(JSON.parse(payload) as unknown)
        if (obj?.type === 'response.output_text.delta') emitDelta(obj.delta)
      })
    } else {
      await readSseLines(res, (payload) => {
        const obj = asRecord(JSON.parse(payload) as unknown)
        // reasoning_content（DeepSeek-R1 / GLM 等）独立成思考流
        const choices = obj?.choices
        if (!Array.isArray(choices)) return
        const delta = asRecord(asRecord(choices[0])?.delta)
        emitReasoning(delta?.reasoning_content)
        emitDelta(delta?.content)
        // tool_calls 增量聚合（按 index 分片拼接 arguments）
        if (Array.isArray(delta?.tool_calls)) {
          for (const piece of delta.tool_calls as Array<Record<string, unknown>>) {
            const idx = typeof piece.index === 'number' ? piece.index : 0
            const pieceObj = asRecord(piece)
            const fn = asRecord(pieceObj?.function)
            const acc = toolCallsAcc.get(idx) ?? { id: '', name: '', argsBuf: '' }
            if (typeof pieceObj?.id === 'string' && pieceObj.id) acc.id = pieceObj.id
            if (typeof fn?.name === 'string' && fn.name) acc.name += fn.name
            if (typeof fn?.arguments === 'string') acc.argsBuf += fn.arguments
            toolCallsAcc.set(idx, acc)
          }
        }
      })
    }

    const toolCalls = [...toolCallsAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ id: v.id, name: v.name, argsJson: v.argsBuf || '{}' }))
    if (!content && toolCalls.length === 0) return { ok: false, error: '流式响应为空' }
    return {
      ok: true,
      ...(content ? { content } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(toolCalls.length ? { toolCalls } : {})
    }
  } catch (e) {
    if (controller.signal.aborted && cb.signal?.aborted) {
      return { ok: false, aborted: true, error: '已中止' }
    }
    if (isAbortError(e)) {
      return { ok: false, aborted: cb.signal?.aborted ?? false, error: `请求超时（${TIMEOUT_MS / 1000}s）` }
    }
    return { ok: false, error: redactAiError(errorMessage(e) || '流式请求失败', [key]) }
  } finally {
    clearTimeout(timer)
    cb.signal?.removeEventListener('abort', onAbort)
  }
}

/* ---------------- models.dev 富化（发现优先的补充元数据） ---------------- */

const MODELS_DEV_URL = 'https://models.dev/api.json'
const MODELS_DEV_TTL = 24 * 60 * 60 * 1000

interface ModelsDevModel {
  context_window?: number
  max_output_tokens?: number
}

interface ModelsDevEntry {
  id?: string
  models?: Record<string, ModelsDevModel>
}

async function loadModelsDevCatalog(app: { getPath: (name: 'userData' | 'home' | 'appData' | 'temp') => string }): Promise<Record<string, ModelsDevModel> | null> {
  const { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } = await import('fs')
  const { join, dirname } = await import('path')
  const cachePath = join(app.getPath('userData'), 'models-dev.json')
  const fresh = (p: string): boolean => {
    try {
      return existsSync(p) && Date.now() - statSync(p).mtimeMs < MODELS_DEV_TTL
    } catch {
      return false
    }
  }
  const parse = (raw: string): Record<string, ModelsDevModel> | null => {
    try {
      const data = asRecord(JSON.parse(raw) as unknown)
      if (!data) return null
      const flat: Record<string, ModelsDevModel> = {}
      for (const entry of Object.values(data)) {
        const e = entry as ModelsDevEntry
        if (!e || typeof e !== 'object' || !e.models) continue
        for (const [modelId, meta] of Object.entries(e.models)) {
          if (!flat[modelId]) flat[modelId] = meta
        }
      }
      return flat
    } catch {
      return null
    }
  }
  if (fresh(cachePath)) {
    const parsed = parse(readFileSync(cachePath, 'utf-8'))
    if (parsed) return parsed
  }
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10_000)
    const res = await proxiedFetch(MODELS_DEV_URL, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = await res.text()
    const parsed = parse(raw)
    if (parsed) {
      mkdirSync(dirname(cachePath), { recursive: true })
      writeFileSync(cachePath, raw, 'utf-8')
      return parsed
    }
  } catch {
    // 离线/超时：回退到过期缓存（如果有）
  }
  try {
    if (existsSync(cachePath)) return parse(readFileSync(cachePath, 'utf-8'))
  } catch {
    // ignore
  }
  return null
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** best-effort 富化：按模型 id 匹配 models.dev 元数据，写回 contextWindow 与上限 tag */
export async function enrichModelsWithCatalog(app: { getPath: (name: 'userData' | 'home' | 'appData' | 'temp') => string }, models: ModelItem[]): Promise<ModelItem[]> {
  const catalog = await loadModelsDevCatalog(app)
  if (!catalog) return models
  return models.map((m) => {
    const meta = catalog[m.id]
    if (!meta) return m
    const next: ModelItem = { ...m }
    if (typeof meta.context_window === 'number' && meta.context_window > 0 && !next.contextWindow) {
      next.contextWindow = formatTokenCount(meta.context_window)
      next.tags = [...(next.tags ?? []), next.contextWindow].filter((t, i, arr) => arr.indexOf(t) === i)
    }
    if (typeof meta.max_output_tokens === 'number' && meta.max_output_tokens > 0 && !next.maxTokens) {
      next.maxTokens = meta.max_output_tokens
    }
    return next
  })
}
