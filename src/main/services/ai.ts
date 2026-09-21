import { safeStorage } from 'electron'
import type { AiChatResult, AiConfig, ChatMessage, ModelFetchResult, ModelItem } from '../../shared/types'
import { errorMessage, isAbortError } from '../../shared/errors'

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

    const res = await fetch(endpoint, {
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

    const res = await fetch(endpoint, {
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

    const res = await fetch(endpoint, {
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
