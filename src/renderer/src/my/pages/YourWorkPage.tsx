import { useState, type JSX, type ReactNode } from 'react'
import { useMy } from '../store'
import { Avatar, EmptyState, formatDate } from '../ui'
import { Check, Copy } from 'lucide-react'
import { PriorityIcon, StateGroupIcon } from '../icons'
import type { Issue, Member, WorkItemState } from '../types'

/** 判断工作项是否未完结（completed / cancelled 均视为已结束） */
function isIssueOpen(issue: Issue, states: Map<string, WorkItemState>): boolean {
  const group = states.get(issue.stateId)?.group
  return group !== 'completed' && group !== 'cancelled'
}


/* ---------------- 工作项行 ---------------- */

function IssueRow({
  issue,
  members,
  states,
  onOpen
}: {
  issue: Issue
  members: Map<string, Member>
  states: Map<string, WorkItemState>
  onOpen: (id: string) => void
}): JSX.Element {
  const state = states.get(issue.stateId)
  const assignee = issue.assigneeId ? members.get(issue.assigneeId) : undefined
  const due = formatDate(issue.dueDate)
  return (
    <div
      onClick={() => onOpen(issue.id)}
      className="flex h-11 cursor-pointer items-center gap-2.5 px-3 hover:bg-my-layer-1"
    >
      {state && <StateGroupIcon stateGroup={state.group} color={state.color} />}
      <span className="min-w-0 flex-1 truncate text-my-md text-my-primary">{issue.name}</span>
      <PriorityIcon priority={issue.priority} size={13} />
      {due !== '' && <span className="shrink-0 text-my-xs text-my-tertiary">{due}</span>}
      {assignee && <Avatar name={assignee.name} color={assignee.avatarColor} size={18} />}
    </div>
  )
}

/* ---------------- 区块容器 ---------------- */

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-my-md font-medium text-my-secondary">{title}</h2>
      {children}
    </section>
  )
}

function IssueList({
  issues,
  members,
  states,
  onOpen,
  emptyTitle
}: {
  issues: Issue[]
  members: Map<string, Member>
  states: Map<string, WorkItemState>
  onOpen: (id: string) => void
  emptyTitle: string
}): JSX.Element {
  if (issues.length === 0) return <EmptyState title={emptyTitle} />
  return (
    <div className="my-card divide-y divide-my-line overflow-hidden">
      {issues.map((i) => (
        <IssueRow key={i.id} issue={i} members={members} states={states} onOpen={onOpen} />
      ))}
    </div>
  )
}

/* ---------------- 页面 ---------------- */

export function YourWorkPage(): JSX.Element {
  const { data, openIssue } = useMy()

  const members = new Map<string, Member>(data.members.map((m) => [m.id, m]))
  const states = new Map<string, WorkItemState>(data.states.map((s) => [s.id, s]))

  const me = data.workspace.memberId

  const assigned = data.issues.filter((i) => i.assigneeId === me && isIssueOpen(i, states))
  const createdByMe = data.issues.filter((i) => i.activity[0]?.actorId === me)
  const completedRecently = data.issues.filter((i) => i.completedAt)

  // 近期更新：按创建时间倒序取 5 条
  const recent = data.issues
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 5)

  const hour = new Date().getHours()
  const greeting = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  const dateLine = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })

  const statCards = [
    { label: '分配给我', value: assigned.length },
    { label: '由我创建', value: createdByMe.length },
    { label: '已完成', value: completedRecently.length }
  ]

  // 归档提醒：已完成超过 10 天且未归档的工作项（本周内已忽略则不再提示）
  const staleDone = data.issues.filter((i) => {
    if (!i.completedAt) return false
    const d = new Date(`${i.completedAt}T12:00:00`)
    if (Number.isNaN(d.getTime())) return false
    return (Date.now() - d.getTime()) / 86400000 >= 10
  })
  const [hintDismissed, setHintDismissed] = useState(false)
  const weekKey = `tpanel.my.archive-hint.${new Date().toISOString().slice(0, 7)}`
  const hintSuppressed = hintDismissed || localStorage.getItem(weekKey) === '1'
  const dismissHint = (): void => {
    try {
      localStorage.setItem(weekKey, '1')
    } catch {
      // 忽略
    }
    setHintDismissed(true)
  }
  const copyArchiveCmd = (dirName: string): void => {
    void navigator.clipboard.writeText(`python .trellis/scripts/task.py archive ${dirName}`).catch(() => undefined)
  }

  return (
    <div className="mx-auto max-w-[1024px]">
      {/* 问候区 */}
      <header className="px-8 pb-4 pt-6">
        <h1 className="text-[20px] font-semibold text-my-primary">
          {greeting}，我
        </h1>
        <p className="mt-1 text-my-sm text-my-tertiary">{dateLine}</p>
      </header>

      <div className="px-8 pb-16">
        {/* 归档提醒：静置的已完成项 */}
        {staleDone.length > 0 && !hintSuppressed && (
          <div className="mb-3 flex items-start gap-3 rounded-my-lg border border-my-line bg-my-layer-2 p-3">
            <div className="min-w-0 flex-1">
              <div className="text-my-md font-medium text-my-primary">
                {staleDone.length} 个已完成任务已静置超过 10 天
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {staleDone.slice(0, 5).map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    title="点击复制归档命令"
                    onClick={() => copyArchiveCmd(i.id)}
                    className="flex items-center gap-1 text-my-sm text-my-tertiary hover:text-my-accent-text"
                  >
                    <Copy size={11} />
                    {i.name}
                  </button>
                ))}
                {staleDone.length > 5 && <span className="text-my-sm text-my-tertiary">等 {staleDone.length} 项</span>}
              </div>
              <div className="mt-1 text-my-xs text-my-disabled">点击条目复制归档命令（task.py archive），归档后从「归档」页可查。</div>
            </div>
            <button
              type="button"
              onClick={dismissHint}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-my-icon-tertiary hover:bg-my-layer-1-hover"
              title="本周不再提示"
            >
              <Check size={14} />
            </button>
          </div>
        )}
        {/* 统计卡行 */}
        <div className="grid grid-cols-3 gap-3">
          {statCards.map((s) => (
            <div key={s.label} className="my-card p-3">
              <div className="text-[22px] font-semibold text-my-primary">{s.value}</div>
              <div className="mt-0.5 text-my-sm text-my-tertiary">{s.label}</div>
            </div>
          ))}
        </div>

        <Section title="分配给我的工作项">
          <IssueList
            issues={assigned}
            members={members}
            states={states}
            onOpen={openIssue}
            emptyTitle="暂无分配给你的工作项"
          />
        </Section>

        <Section title="由我创建">
          <IssueList
            issues={createdByMe}
            members={members}
            states={states}
            onOpen={openIssue}
            emptyTitle="你还没有创建过工作项"
          />
        </Section>

        <Section title="近期更新">
          <IssueList
            issues={recent}
            members={members}
            states={states}
            onOpen={openIssue}
            emptyTitle="近期没有新的评论动态"
          />
        </Section>
      </div>
    </div>
  )
}
