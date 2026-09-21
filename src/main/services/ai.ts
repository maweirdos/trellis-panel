import { safeStorage } from 'electron'
import type { AiApiFormat, AiChatResult, AiConfig, ChatImage, ChatMessage, ModelFetchResult, ModelItem, ThinkingLevel } from '../../shared/types'
import { errorMessage, isAbortError } from '../../shared/errors'
import { proxiedFetch } from './proxy'

/**
 * 应用内 AI 客户端 —— OpenAI 兼容 /chat/completions。
 * baseUrl 约定：填到 /v1 即可；以 # 结尾则原样使用（自定义完整 URL）。
 */

const TIMEOUT_MS = 120_000

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

function decryptKey(cfg: AiConfig): string {
  if (!cfg.apiKey) return ''
  if (cfg.apiKeyEncrypted) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(cfg.apiKey, 'base64'))
      }
    } catch {
      return ''
    }
  }
  return cfg.apiKey
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
  opts?: { temperature?: number; maxTokens?: number }
): Promise<AiChatResult> {
  if (!cfg.enabled) return { ok: false, error: '应用内 AI 未启用（设置 → AI 模型）' }
  const activeProvider = cfg.providers?.find((p) => p.id === cfg.activeProviderId) || cfg.providers?.[0]
  const format = activeProvider?.apiFormat || cfg.apiFormat || 'openai'
  const endpoint = resolveEndpoint(cfg.baseUrl, format)
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) return { ok: false, error: 'baseUrl 无效' }
  if (!cfg.model) return { ok: false, error: '未配置模型名' }

  const key = decryptKey(cfg)
  const controller = new AbortController()
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
      const text = (await res.text().catch(() => '')).slice(0, 400)
      return { ok: false, error: `HTTP ${res.status} ${text || res.statusText}`.trim() }
    }
    const data: unknown = await res.json()
    const dataObj = asRecord(data)
    const apiErrorMsg = asRecord(dataObj?.error)?.message
    if (typeof apiErrorMsg === 'string' && apiErrorMsg) return { ok: false, error: apiErrorMsg }

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
    return { ok: false, error: err.name === 'AbortError' ? `请求超时（${TIMEOUT_MS / 1000}s）` : err.message }
  } finally {
    clearTimeout(timer)
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
  apiFormat: string
}): Promise<ModelFetchResult> {
  let u = cfg.baseUrl.trim().replace(/\s+/g, '')
  if (!u) return { ok: false, error: 'Base URL 不能为空' }
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  u = u.replace(/\/+$/, '')

  const key = cfg.apiKey?.trim() || ''
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
      const text = (await res.text().catch(() => '')).slice(0, 300)
      return { ok: false, error: `HTTP ${res.status} ${text || res.statusText}`.trim() }
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
    return { ok: false, error: isAbortError(e) ? '获取模型超时 (15s)' : errorMessage(e) || '网络请求失败' }
  } finally {
    clearTimeout(timer)
  }
}

export async function testSingleModel(
  provider: {
    baseUrl: string
    apiKey?: string
    apiFormat: string
    model?: string
  },
  modelId?: string
): Promise<{ ok: boolean; error?: string; latencyMs?: number; model?: string; message?: string }> {
  const targetModel = modelId || provider.model || ''
  if (!targetModel) return { ok: false, error: '未指定测试模型' }
  const start = Date.now()
  let u = provider.baseUrl.trim().replace(/\s+/g, '')
  if (!u) return { ok: false, error: 'Base URL 不能为空' }
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  u = u.replace(/\/+$/, '')

  const key = provider.apiKey?.trim() || ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)

  try {
    let endpoint = ''
    let body: Record<string, unknown> | null = null
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    if (provider.apiFormat === 'anthropic') {
      endpoint = u.endsWith('/v1') ? `${u}/messages` : `${u}/v1/messages`
      if (key) {
        headers['x-api-key'] = key
        headers['anthropic-version'] = '2023-06-01'
      }
      body = {
        model: targetModel,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }]
      }
    } else if (provider.apiFormat === 'ollama') {
      endpoint = `${u}/api/chat`
      body = {
        model: targetModel,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false
      }
    } else if (provider.apiFormat === 'response') {
      if (u.endsWith('/v1')) {
        endpoint = `${u}/responses`
      } else if (/\/responses$/.test(u)) {
        endpoint = u
      } else {
        endpoint = `${u}/v1/responses`
      }
      if (key) {
        headers['Authorization'] = `Bearer ${key}`
      }
      body = {
        model: targetModel,
        input: 'hi'
      }
    } else {
      if (u.endsWith('/v1')) {
        endpoint = `${u}/chat/completions`
      } else if (/\/chat\/completions$/.test(u)) {
        endpoint = u
      } else {
        endpoint = `${u}/v1/chat/completions`
      }
      if (key) {
        headers['Authorization'] = `Bearer ${key}`
      }
      body = {
        model: targetModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5
      }
    }

    const res = await proxiedFetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    })

    const latencyMs = Date.now() - start

    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300)
      return { ok: false, error: `HTTP ${res.status} ${text || res.statusText}`.trim(), latencyMs }
    }

    return { ok: true, latencyMs, model: targetModel, message: `连接正常 (${latencyMs}ms)` }
  } catch (e) {
    const latencyMs = Date.now() - start
    return {
      ok: false,
      error: isAbortError(e) ? '连接超时 (20s)' : errorMessage(e) || '连接失败',
      latencyMs
    }
  } finally {
    clearTimeout(timer)
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
  if (encrypted) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(apiKey, 'base64'))
      }
    } catch {
      return ''
    }
  }
  return apiKey
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
      input: messages.map((m) => ({ role: m.role, content: m.content })),
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
      const text = (await res.text().catch(() => '')).slice(0, 400)
      return { ok: false, error: `HTTP ${res.status} ${text || res.statusText}`.trim() }
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
    return { ok: false, error: errorMessage(e) || '流式请求失败' }
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
