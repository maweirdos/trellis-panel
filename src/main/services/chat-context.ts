import { getSnapshot } from '../state'
import { getSettings } from './store'
import { GatewayManager } from './gateway/manager'
import type { ChatSessionTree } from './chat-store'
import { openSession } from './chat-store'

/**
 * 对话系统提示词构建器：让每轮对话携带「面板助手人设 + 项目实时上下文」。
 * 面向不懂编程的用户：自然语言、先查证再回答、结论先行。
 */

function taskLine(t: { dirName: string; record?: { title?: unknown; status?: unknown; description?: unknown } | null }): string {
  const title = String(t.record?.title ?? t.dirName)
  const status = String(t.record?.status ?? '')
  return `- ${title}${status ? `（${status}）` : ''} [${t.dirName}]`
}

/** 从项目快照提炼一段紧凑的上下文摘要（限长，防止撑爆上下文） */
function projectContextSection(): string {
  const snap = getSnapshot()
  if (!snap) return '- 当前未打开任何 Trellis 项目（可提示用户在概览页打开项目获得项目问答能力）'
  const lines: string[] = []
  lines.push(`- 项目：${snap.meta.name}（${snap.meta.root}）`)
  const tasks = snap.tasks ?? []
  if (tasks.length > 0) {
    const byStatus = new Map<string, number>()
    for (const t of tasks) {
      const s = String(t.record?.status ?? 'unknown')
      byStatus.set(s, (byStatus.get(s) ?? 0) + 1)
    }
    const stat = [...byStatus.entries()].map(([k, v]) => `${k} ${v}`).join(' / ')
    lines.push(`- 活跃任务 ${tasks.length} 个：${stat}`)
    // 最近 5 个任务（按更新时间近似：目录序即创建序，取尾部的更接近近期）
    const recent = tasks.slice(-5).reverse()
    for (const t of recent) lines.push(taskLine(t))
  } else {
    lines.push('- 项目暂无活跃任务')
  }
  const specs = snap.spec ?? []
  if (specs.length > 0) {
    const names: string[] = []
    const walk = (nodes: Array<{ type?: string; name?: string; children?: unknown[] }>, depth: number): void => {
      for (const n of nodes) {
        if (names.length >= 12) return
        if (n.type === 'file' && n.name) names.push(n.name)
        else if (depth < 3 && Array.isArray(n.children)) walk(n.children as Array<{ type?: string; name?: string; children?: unknown[] }>, depth + 1)
      }
    }
    walk(specs as Array<{ type?: string; name?: string; children?: unknown[] }>, 0)
    if (names.length > 0) lines.push(`- 规范文档（${specs.length > 0 ? '可读' : ''}）：${names.join('、')}${specs.length > names.length ? ' 等' : ''}`)
  }
  return lines.join('\n')
}

function toolSection(): string {
  const tools = GatewayManager.getStandardTools()
  if (tools.length === 0) return ''
  const groups = new Map<string, string[]>()
  for (const t of tools) {
    const list = groups.get(t.upstreamId) ?? []
    list.push(`${t.name}：${t.description}`)
    groups.set(t.upstreamId, list)
  }
  const lines: string[] = []
  for (const [upstream, list] of groups) lines.push(`- ${upstream} → ${list.join('；')}`)
  return `你可以调用以下工具（先查证再回答，回答时注明信息来自哪里）：
${lines.join('\n')}`
}

/** 会话绑定的任务上下文（R2 扩展点：会话可 pin 一个任务目录） */
function sessionSection(session: ChatSessionTree | null): string {
  if (!session?.taskDir) return ''
  const snap = getSnapshot()
  const task = snap?.tasks.find((t) => t.dirName === session.taskDir)
  if (!task) return ''
  const desc = String(task.record?.description ?? '').slice(0, 600)
  const notes = String(task.record?.notes ?? '').slice(0, 400)
  const subtasks = Array.isArray(task.record?.subtasks) ? (task.record?.subtasks as unknown[]).map(String).slice(0, 10) : []
  return `本轮对话聚焦的任务：
- ${String(task.record?.title ?? session.taskDir)}（${String(task.record?.status ?? '')}）[ ${session.taskDir} ]
${desc ? `- 任务描述：${desc}\n` : ''}${notes ? `- 备注：${notes}\n` : ''}${subtasks.length ? `- 子任务：\n${subtasks.map((s) => `  - ${s}`).join('\n')}` : ''}`
}

export function buildSystemPrompt(app: { getPath: (name: 'userData' | 'home' | 'appData' | 'temp') => string }, sessionId: string): string {
  let session: ChatSessionTree | null = null
  try {
    session = openSession(app, sessionId)
  } catch {
    session = null
  }
  const cfg = getSettings()
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  const sections: string[] = [
    `你是 Trellis Panel（Trellis 可视化面板）内置的 AI 助手。服务对象是**不懂编程的普通用户**，他们用自然语言描述需求。
行为准则：
1. 全程简体中文，口语化、友好；避免技术术语，必须使用时用一句话解释清楚。
2. 涉及项目事实（任务、规范、文档、数据）时，先调用工具查证再回答，禁止编造；查不到就直说查不到，并建议用户补充信息。
3. 回答结论先行，再展开步骤或依据；给出可操作的下一步（比如"要不要我帮你……"）。
4. 用户的需求描述可能不完整，主动用一两句话确认关键意图，但不要连环追问。
5. 今天是 ${date}。`
  ]

  const ctx = projectContextSection()
  if (ctx) sections.push(`当前项目上下文：\n${ctx}`)
  const taskCtx = sessionSection(session)
  if (taskCtx) sections.push(taskCtx)
  const tools = toolSection()
  if (tools && session?.agent) sections.push(tools)

  const weknoraOn = cfg.weknora?.enabled
  if (weknoraOn) sections.push('公司知识库（WeKnora）已接入：涉及公司级规范/历史归档的问题可用 weknora_search 检索。')

  return sections.join('\n\n')
}
