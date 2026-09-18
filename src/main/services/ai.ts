import { safeStorage } from 'electron'
import type { AiChatResult, AiConfig, ChatMessage } from '../../shared/types'

/**
 * 应用内 AI 客户端 —— OpenAI 兼容 /chat/completions。
 * baseUrl 约定：填到 /v1 即可；以 # 结尾则原样使用（自定义完整 URL）。
 */

const TIMEOUT_MS = 120_000

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

export function resolveEndpoint(baseUrl: string): string {
  let u = baseUrl.trim().replace(/\s+/g, '')
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  if (u.endsWith('#')) return u.slice(0, -1)
  u = u.replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(u)) return u
  return `${u}/chat/completions`
}

export async function aiChat(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number }
): Promise<AiChatResult> {
  if (!cfg.enabled) return { ok: false, error: '应用内 AI 未启用（设置 → AI 模型）' }
  const endpoint = resolveEndpoint(cfg.baseUrl)
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) return { ok: false, error: 'baseUrl 无效' }
  if (!cfg.model) return { ok: false, error: '未配置模型名' }

  const key = decryptKey(cfg)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {})
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts?.temperature ?? cfg.temperature ?? 0.3,
        ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {})
      })
    })
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 400)
      return { ok: false, error: `HTTP ${res.status} ${text || res.statusText}`.trim() }
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      model?: string
      error?: { message?: string }
    }
    if (data.error?.message) return { ok: false, error: data.error.message }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string') return { ok: false, error: '响应缺少 choices[0].message.content' }
    return { ok: true, content, model: data.model ?? cfg.model }
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
