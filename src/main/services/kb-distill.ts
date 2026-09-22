import { getSettings } from './store'
import { aiChat } from './ai'
import { noteUpsert } from './knowledge'
import type { AiConfig } from '../../shared/types'

/**
 * 知识沉淀（飞轮）：把一段有价值的对话（用户问题 + AI 回答 + 来源）交给 AI
 * 加工成结构化知识笔记——拟标题、打标签、摘要、整理正文——写入我的笔记库。
 * 面向不懂编程的用户：一键完成，产物直接进入五库检索与问答。
 */

export interface DistillInput {
  question: string
  answer: string
  /** 回答引用的来源（kb 工具命中） */
  sources?: Array<{ title: string; path: string }>
  /** 关联任务（如有） */
  taskTitle?: string
}

const DISTILL_SYSTEM = `你是知识管理助手。把一段对话加工成一篇可长期复用的知识笔记（Markdown）。
要求：
1. 第一行输出 frontmatter：---
   title: 不超过 20 字的知识标题
   tags: 3~5 个标签（逗号分隔，小写英文或中文短语）
   source: 对话沉淀
   ---
2. 正文结构：## 摘要（2~3 句话）→ ## 要点（列表，保留关键细节与数字）→ ## 适用场景（什么情况下会用到这条知识）
3. 忠于原对话内容，不新增事实；对话中的操作步骤要保留完整顺序
4. 全文简体中文；直接输出 Markdown，不要任何解释`

function todayCompact(): string {
  const d = new Date()
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

function slugify(title: string): string {
  const slug = title
    .trim()
    .replace(/[\\/:*?"<>|\s#]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || '知识'
}

export async function distillToNote(root: string, input: DistillInput): Promise<{ ok: boolean; error?: string; fileName?: string; path?: string }> {
  const cfg: AiConfig = getSettings().ai
  if (!cfg.enabled) return { ok: false, error: '应用内 AI 未启用（设置 → AI 模型）' }

  const userPrompt = [
    input.taskTitle ? `关联任务：${input.taskTitle}` : '',
    `用户问题：\n${input.question.slice(0, 4000)}`,
    `AI 回答：\n${input.answer.slice(0, 8000)}`,
    input.sources?.length ? `回答参考来源：\n${input.sources.map((s) => `- ${s.title}（${s.path}）`).join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  const res = await aiChat(cfg, [
    { role: 'system', content: DISTILL_SYSTEM },
    { role: 'user', content: userPrompt }
  ], { temperature: 0.2 })
  if (!res.ok || !res.content) return { ok: false, error: res.error ?? 'AI 加工失败' }

  let content = res.content.trim()
  if (!content.startsWith('---')) {
    // 模型没按格式给 frontmatter：补一个最小头，保证笔记库元数据一致
    content = `---\ntitle: ${slugify(input.question)}\ntags: 对话沉淀\nsource: 对话沉淀\n---\n\n${content}`
  }
  // 追加出处信息（可追溯）
  if (input.sources?.length) {
    content += `\n\n## 出处\n\n- 沉淀时间：${new Date().toLocaleString('zh-CN')}\n${input.sources.map((s) => `- ${s.title}（${s.path}）`).join('\n')}`
  }

  const titleMatch = /^title:\s*(.+)$/m.exec(content)
  const baseName = `chat-${todayCompact()}-${slugify(titleMatch?.[1] ?? input.question)}`
  const save = noteUpsert(root, baseName, content)
  if (!save.ok) return { ok: false, error: save.error }
  return { ok: true, fileName: `${baseName}.md`, path: save.path }
}
