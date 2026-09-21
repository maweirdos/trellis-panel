import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import type { AiChatResult, AiConfig, PlanResult, PlanSource, TaskPlan, WeknoraConfig } from '../../shared/types'
import { kbSearch } from './knowledge'
import { aiChat } from './ai'
import { weknoraSearch } from './weknora'

/**
 * 任务规划管线：Jira issue / 需求描述 → 知识库检索（spec/wiki/需求/归档）
 * → 应用内 AI 生成结构化 Trellis 任务计划（可直接落成 task.json）。
 * 检索走面板内置倒排索引（毫秒级），AI 只负责组织与规划。
 */

const PLAN_SYSTEM = `你是 Trellis 工作流的首席规划者。基于给定素材（需求原文 + 知识库检索到的 spec/wiki/历史 PRD 摘录）产出一个可直接落成 Trellis 任务的计划。
严格只输出一个 JSON 对象（不要 markdown 代码围栏、不要解释），结构：
{
  "title": "中文任务标题（<=40字，动词开头，概括交付物）",
  "description": "PRD 草稿 Markdown：## 背景与目标\\n## 用户故事\\n## 功能需求（FR-1…编号列表）\\n## 非目标\\n## 验收标准（- [ ] 勾选清单）。必须只依据素材，不虚构；素材不足处写进 questions",
  "priority": "P0|P1|P2|P3",
  "dev_type": "frontend|backend|fullstack|null",
  "scope": "涉及模块名或 null",
  "workflow": "从候选 workflow id 里选一个最匹配的，或 null",
  "branch": "kebab-case 英文分支名建议，如 feat/return-audit-inline-binding",
  "subtasks": ["- [ ] 第一步（可勾选格式）", "…3到8条"],
  "questions": ["需要用户澄清的问题", "…没有则空数组"]
}`

function extractJson(text: string): Record<string, unknown> | null {
  let t = text.trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(t.slice(start, end + 1))
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

function workflowCandidates(root: string): string[] {
  const dir = join(root, '.trellis', 'workflows')
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
  } catch {
    return []
  }
}

/** 公司库（WeKnora）补充摘录的上限——远程素材只做本地检索的增量，不喧宾夺主 */
const COMPANY_EXCERPT_CAP = 12_000

export async function aiPlanTask(
  root: string,
  cfg: AiConfig,
  input: { title: string; description: string; jiraKey?: string; jiraUrl?: string },
  weknoraCfg?: WeknoraConfig
): Promise<PlanResult> {
  if (!cfg.enabled)
    return { ok: false, error: '应用内 AI 未启用（设置 → AI 模型）', sources: [], contextChars: 0, workflows: workflowCandidates(root) }
  const keywords = [input.title, input.description.slice(0, 300)].filter(Boolean).join(' ').slice(0, 400)

  // 1) 知识库检索（本地索引，毫秒级）
  const search = kbSearch(root, 'all', keywords)
  const sources: PlanSource[] = search.hits.slice(0, 6).map((h) => ({
    path: h.doc.path,
    title: h.doc.title,
    library: h.doc.library
  }))

  // 1b) 公司库（WeKnora）并行补充——跨项目规范 / 历史归档 / 接口约定
  const companyHits = weknoraCfg?.enabled && weknoraCfg.searchKbIds.length
    ? await weknoraSearch(weknoraCfg, keywords, 4)
    : null

  // 2) 读取来源摘录（每篇最多 3500 字符）
  let contextChars = 0
  const excerpts: string[] = []
  for (const s of sources) {
    if (s.path.endsWith('.task.json') || s.path.endsWith('task.json')) continue
    try {
      // 延迟 require 避免 ai.ts 与主进程耦合
      const { readFileSync, statSync } = require('fs') as typeof import('fs')
      const st = statSync(s.path)
      if (st.size > 512 * 1024) continue
      let text = readFileSync(s.path, 'utf-8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      const cut = text.slice(0, 3500)
      contextChars += cut.length
      excerpts.push(`--- 来源 [${s.library}] ${s.title}（${s.path}）---\n${cut}`)
    } catch {
      // 读取失败跳过
    }
  }

  // 2b) 公司库摘录（命中分块即摘录，总量封顶）
  if (companyHits?.ok) {
    let companyChars = 0
    for (const h of companyHits.hits) {
      if (companyChars >= COMPANY_EXCERPT_CAP) break
      const cut = h.content.slice(0, 3000)
      companyChars += cut.length
      sources.push({
        path: `weknora://${h.knowledgeId}`,
        title: h.title || h.filename,
        library: 'company'
      })
      excerpts.push(
        `--- 来源 [company-kb] ${h.title || h.filename}（WeKnora knowledge_id: ${h.knowledgeId}）---\n${cut}`
      )
    }
    contextChars += companyChars
  }

  // 3) AI 规划
  const candidates = workflowCandidates(root)
  const userLines = [
    `需求标题：${input.title}`,
    input.jiraKey ? `Jira：${input.jiraKey}${input.jiraUrl ? `（${input.jiraUrl}）` : ''}` : '',
    `需求描述：\n${input.description || '（无）'}`,
    candidates.length ? `可选 workflow id：${candidates.join(', ')}` : '',
    excerpts.length
      ? `知识库检索摘录（本地 + 公司库，共 ${excerpts.length} 篇，${contextChars} 字符）：\n\n${excerpts.join('\n\n')}`
      : '（知识库未检索到相关内容——请在 questions 里指出需要补充的规范/文档）'
  ].filter(Boolean)

  const res = await aiChat(cfg, [
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: userLines.join('\n\n') }
  ], { temperature: 0.4 })

  if (!res.ok || !res.content) {
    return { ok: false, error: res.error ?? 'AI 未返回内容', sources, contextChars, workflows: candidates }
  }
  const obj = extractJson(res.content)
  if (!obj) return { ok: false, error: 'AI 返回的不是有效 JSON——请重试或换模型', sources, contextChars, workflows: candidates }

  const plan: TaskPlan = {
    title: str(obj.title, input.title),
    description: str(obj.description, input.description),
    priority: ['P0', 'P1', 'P2', 'P3'].includes(str(obj.priority, '')) ? str(obj.priority, 'P2') : 'P2',
    devType: typeof obj.dev_type === 'string' && obj.dev_type !== 'null' ? obj.dev_type : null,
    scope: typeof obj.scope === 'string' && obj.scope !== 'null' ? obj.scope : null,
    workflow: typeof obj.workflow === 'string' && candidates.includes(obj.workflow) ? obj.workflow : null,
    branch: typeof obj.branch === 'string' ? obj.branch.replace(/[^a-zA-Z0-9/_-]/g, '').slice(0, 60) || null : null,
    subtasks: Array.isArray(obj.subtasks) ? (obj.subtasks as unknown[]).map(String).slice(0, 12) : [],
    questions: Array.isArray(obj.questions) ? (obj.questions as unknown[]).map(String).slice(0, 8) : []
  }
  return { ok: true, plan, sources, contextChars, workflows: candidates }
}

/** 生成任务目录名 slug（与主进程 createTask 规则一致） */
export function planSlug(title: string): string {
  return title.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'req'
}

/** 各 AI 工具的启动提示词（官方约定：SessionStart 自动注入，continue/finish-work 为内置命令） */
export function handoffTexts(root: string, dirName: string): Array<{ platform: string; text: string }> {
  const taskPath = join(root, '.trellis', 'tasks', dirName)
  const generic = `请继续处理 Trellis 任务 ${dirName}：\n1. 读取 ${taskPath}\\task.json 与同目录 prd.md\n2. 按 .trellis/workflow.md 的当前阶段推进（可运行 python ./.trellis/scripts/get_context.py --mode phase 查看步骤）\n3. 完成后更新 task.json 状态与 subtasks 勾选`
  return [
    { platform: 'Claude Code', text: `/trellis:continue ${dirName}\n\n${generic}` },
    { platform: 'Cursor', text: `/trellis-continue ${dirName}\n\n${generic}` },
    { platform: 'Codex / ZCode（skills）', text: generic + '\n\n（会话启动时会自动加载 .agents/skills 里的 trellis 技能，直接发送上面文本即可）' },
    { platform: '通用（任意 AI 工具）', text: generic }
  ]
}

/** 判断需求是否与已有任务相关（避免重复建任务） */
export function hasOpenTaskFor(root: string, titleKeywords: string): boolean {
  if (!titleKeywords.trim()) return false
  const r = kbSearch(root, 'requirements', titleKeywords)
  return r.hits.some((h) => !h.doc.synthetic && /prd/i.test(h.doc.name) && Date.now() - h.doc.mtime < 90 * 86400000)
}

export function specExists(root: string): boolean {
  return existsSync(join(root, '.trellis', 'spec'))
}

/* ---------- 开发流程 AI 端点（拆分 / 提交信息 / PR 描述） ---------- */

export interface EpicChildPlan {
  title: string
  description: string
  subtasks: string[]
}

const SPLIT_SYSTEM = `你是 Trellis 任务拆分专家。把父任务拆分为 2-6 个可独立交付的子任务（每个子任务一个目录、一个分支）。
严格只输出 JSON：{"children":[{"title":"中文标题（<=30字）","description":"一段话范围说明（含输入输出与边界）","subtasks":["- [ ] 步骤"]}]}
拆分原则：按业务能力或数据流切分，不按技术分层；每个子任务可独立验收；依赖关系写进 description 开头（"依赖 XX 先完成"）。`

export async function aiSplitEpic(
  cfg: AiConfig,
  task: { title: string; description: string; prd?: string | null }
): Promise<{ ok: boolean; error?: string; children?: EpicChildPlan[] }> {
  const user = [
    `父任务：${task.title}`,
    task.description ? `描述：\n${task.description}` : '',
    task.prd ? `PRD 摘录：\n${task.prd.slice(0, 6000)}` : ''
  ].filter(Boolean).join('\n\n')
  const res = await aiChat(cfg, [
    { role: 'system', content: SPLIT_SYSTEM },
    { role: 'user', content: user }
  ], { temperature: 0.4 })
  if (!res.ok || !res.content) return { ok: false, error: res.error ?? 'AI 未返回内容' }
  const obj = extractJson(res.content)
  const children = obj && Array.isArray(obj.children) ? (obj.children as unknown[]).map((c) => {
    const o = c as Record<string, unknown>
    return {
      title: str(o.title, ''),
      description: typeof o.description === 'string' ? o.description : '',
      subtasks: Array.isArray(o.subtasks) ? (o.subtasks as unknown[]).map(String).slice(0, 10) : []
    }
  }).filter((c) => c.title).slice(0, 8) : null
  if (!children || children.length === 0) return { ok: false, error: 'AI 未给出有效子任务' }
  return { ok: true, children }
}

export async function aiCommitMsg(
  cfg: AiConfig,
  ctx: { title: string; description: string; recentCommits: string[] }
): Promise<AiChatResult> {
  const res = await aiChat(cfg, [
    { role: 'system', content: '生成一条 conventional commit 信息：第一行 <=50 字符（type(scope): 中文概述），空一行后 2-3 条正文要点。只输出 commit 文本本身。' },
    { role: 'user', content: `任务：${ctx.title}\n描述：${ctx.description.slice(0, 800)}\n最近提交风格参考：\n${ctx.recentCommits.slice(0, 5).join('\n') || '（无）'}` }
  ], { temperature: 0.3, maxTokens: 200 })
  return res
}

export async function aiPrDesc(
  cfg: AiConfig,
  ctx: { title: string; description: string; subtasks: string[] }
): Promise<AiChatResult> {
  const res = await aiChat(cfg, [
    { role: 'system', content: '生成 MR/PR 描述（Markdown）：## 变更概述（一段话）、## 验收对照（对照需求验收标准逐条）、## 影响面、## 测试说明。只输出 Markdown 正文。' },
    { role: 'user', content: `任务：${ctx.title}\n描述：${ctx.description.slice(0, 3000)}\n子任务：\n${ctx.subtasks.join('\n') || '（无）'}` }
  ], { temperature: 0.3 })
  return res
}
