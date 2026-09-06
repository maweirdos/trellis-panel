import type { ProjectSnapshot } from '../../shared/types'
import { statusLabelShared as statusLabel } from '../../shared/labels-shared'
import { getActivity } from './activity'

const DAY = 24 * 3600 * 1000

function fmtDate(d: Date): string {
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** ISO week label like 2026-W36. */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / DAY + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export interface ReportInput {
  scope: 'personal' | 'team'
  developer: string | null
  projectName: string
}

export function generateWeeklyReport(snap: ProjectSnapshot, input: ReportInput): { markdown: string; suggestedFileName: string } {
  const now = new Date()
  const from = new Date(now.getTime() - 7 * DAY)
  const fromStr = fmtDate(from)
  const toStr = fmtDate(now)

  const matchScope = (t: { record?: { assignee?: string | null; creator?: string | null } | null }): boolean =>
    input.scope === 'team' ||
    (t.record?.assignee ?? t.record?.creator) === input.developer ||
    (!t.record?.assignee && t.record?.creator === input.developer)

  const tasks = [...snap.tasks, ...snap.archived].filter(matchScope)
  const completed = tasks.filter((t) => ['completed', 'done'].includes((t.record?.status ?? '').toLowerCase()))
  const completedThisWeek = completed.filter((t) => t.record?.completedAt && t.record.completedAt >= fromStr)
  const inProgress = tasks.filter((t) => t.record?.status === 'in_progress')
  const planning = tasks.filter((t) => t.record?.status === 'planning')
  const review = tasks.filter((t) => t.record?.status === 'review')

  const fromMs = from.getTime()
  const recentTransitions = getActivity(400).filter(
    (e) => e.ts >= fromMs && tasks.some((t) => t.dirName === e.dir)
  )

  // risks: in-flight without updates for 5+ days
  const risks = tasks
    .filter(
      (t) =>
        ['in_progress', 'review'].includes((t.record?.status ?? '').toLowerCase()) &&
        t.updatedAt &&
        now.getTime() - t.updatedAt > 5 * DAY
    )
    .map((t) => `- ⚠️ 「${t.record?.title}」（${t.record?.status === 'review' ? '评审中' : '进行中'}）已 ${Math.floor((now.getTime() - (t.updatedAt ?? 0)) / DAY)} 天无动静，负责人 ${t.record?.assignee || '未分配'}`)

  // jira reconciliation
  const linked = tasks.filter((t) => t.record?.meta?.jiraKey)
  const jiraLines = linked.map((t) => {
    const key = t.record?.meta?.jiraKey as string
    return `- ${key} ↔ ${t.dirName}（Trellis：${statusLabel(t.record?.status)}${t.record?.completedAt ? `，完成于 ${t.record.completedAt}` : ''}）`
  })

  // member breakdown (team scope)
  const memberMap = new Map<string, { done: number; doing: number; names: string[] }>()
  if (input.scope === 'team') {
    for (const t of tasks) {
      const who = t.record?.assignee || t.record?.creator || '未分配'
      const m = memberMap.get(who) ?? { done: 0, doing: 0, names: [] }
      const st = (t.record?.status ?? '').toLowerCase()
      if (['completed', 'done'].includes(st)) m.done += 1
      else if (['in_progress', 'review'].includes(st)) {
        m.doing += 1
        m.names.push(t.record?.title ?? t.dirName)
      }
      memberMap.set(who, m)
    }
  }

  const lines: string[] = []
  lines.push(`# Trellis ${input.scope === 'team' ? '团队' : '个人'}周报 · ${isoWeek(now)}`)
  lines.push('')
  lines.push(`> 项目 **${input.projectName}** ｜ 区间 ${fromStr} ~ ${toStr} ｜ 生成于 ${fmtDate(now)} ${now.toTimeString().slice(0, 5)} ｜ 由 Trellis Panel 自动生成`)
  lines.push('')
  lines.push('## 本期概览')
  lines.push('')
  lines.push(`- ✅ 本周完成任务：**${completedThisWeek.length}**`)
  lines.push(`- 🔄 进行中：**${inProgress.length}** ｜ 评审中：**${review.length}** ｜ 规划中：**${planning.length}**`)
  lines.push(`- 📥 本周任务流转：**${recentTransitions.length}** 次`)
  lines.push('')

  if (completedThisWeek.length > 0) {
    lines.push('## 本周完成')
    lines.push('')
    for (const t of completedThisWeek) {
      lines.push(`- ✅ ${t.record?.title}（${t.dirName}，完成于 ${t.record?.completedAt}）`)
    }
    lines.push('')
  }

  lines.push('## 当前在途')
  lines.push('')
  for (const t of [...inProgress, ...review]) {
    lines.push(`- ${t.record?.status === 'review' ? '🔎' : '🔄'} ${t.record?.title} — ${t.record?.assignee || '未分配'}${t.record?.branch ? `（分支 \`${t.record.branch}\`）` : ''}`)
  }
  if (inProgress.length + review.length === 0) lines.push('- （无）')
  lines.push('')

  if (input.scope === 'team' && memberMap.size > 0) {
    lines.push('## 成员工作量')
    lines.push('')
    lines.push('| 成员 | 本期完成 | 在途 |')
    lines.push('| --- | --- | --- |')
    for (const [who, m] of memberMap) {
      lines.push(`| ${who} | ${m.done} | ${m.doing} |`)
    }
    lines.push('')
  }

  if (risks.length > 0) {
    lines.push('## 风险与阻塞')
    lines.push('')
    lines.push(...risks)
    lines.push('')
  }

  if (linked.length > 0) {
    lines.push('## Jira 对账')
    lines.push('')
    lines.push(...jiraLines)
    lines.push('')
  }

  lines.push('---')
  lines.push(`*由 Trellis Panel 自动生成 · 数据源 \`.trellis/\` · ${new Date().toISOString()}*`)

  const suggestedFileName = `report-${input.scope === 'team' ? 'team' : input.developer ?? 'me'}-${toStr}.md`
  return { markdown: lines.join('\n'), suggestedFileName }
}

export function saveReport(root: string, fileName: string, markdown: string): { ok: boolean; error?: string; path?: string } {
  try {
    const { writeFileSync, mkdirSync } = require('fs') as typeof import('fs')
    const { join, basename } = require('path') as typeof import('path')
    const developer = basename(root) // fallback; caller passes developer dir
    const dir = join(root, '.trellis', 'workspace')
    mkdirSync(dir, { recursive: true })
    const safeName = fileName.replace(/[^\w.-]+/g, '-')
    const p = join(dir, safeName)
    writeFileSync(p, markdown, 'utf-8')
    return { ok: true, path: p }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? '保存失败' }
  }
}
