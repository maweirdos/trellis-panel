import { useMemo, useState, type JSX } from 'react'
import { Archive, ArrowUpRight, Copy } from 'lucide-react'
import { useApp } from '../../store'
import { relTime } from '../../utils/format'
import { useMy } from '../store'
import { Avatar, Button, EmptyState, formatDate } from '../ui'
import { PriorityIcon, StateGroupIcon } from '../icons'
import type { Issue, Member, WorkItemState } from '../types'
import { PAGE_LAYOUTS, PageBody, PageContent, PageLayout } from '../layout/PageLayout'

type WorkView = 'assigned' | 'created' | 'recent'

function isIssueOpen(issue: Issue, states: Map<string, WorkItemState>): boolean {
  const group = states.get(issue.stateId)?.group
  return group !== 'completed' && group !== 'cancelled'
}

function IssueRow({ issue, members, states, updatedAt, onOpen }: {
  issue: Issue
  members: Map<string, Member>
  states: Map<string, WorkItemState>
  updatedAt?: number
  onOpen: (id: string) => void
}): JSX.Element {
  const state = states.get(issue.stateId)
  const assignee = issue.assigneeId ? members.get(issue.assigneeId) : undefined
  const due = formatDate(issue.dueDate)
  return (
    <button
      type="button"
      onClick={() => onOpen(issue.id)}
      className="group flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-my-layer-1-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-my-line-accent"
    >
      {state && <StateGroupIcon stateGroup={state.group} color={state.color} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-my-md font-medium text-my-primary">{issue.name}</span>
        <span className="mt-0.5 block truncate text-my-xs text-my-secondary">
          {state?.name ?? '状态未记录'}{assignee ? ` · ${assignee.name}` : ' · 未分配'}
        </span>
      </span>
      <PriorityIcon priority={issue.priority} size={13} />
      <span className="hidden shrink-0 text-my-xs text-my-secondary sm:block">
        {updatedAt ? `更新于 ${relTime(updatedAt)}` : due}
      </span>
      {assignee && <Avatar name={assignee.name} color={assignee.avatarColor} size={20} />}
      <ArrowUpRight size={13} className="shrink-0 text-my-icon-tertiary group-hover:text-my-icon-accent" />
    </button>
  )
}

/** A single queue; creator and update time come from the real task record. */
export function YourWorkPage(): JSX.Element {
  const { data, openIssue } = useMy()
  const snapshot = useApp((s) => s.snapshot)
  const [view, setView] = useState<WorkView>('assigned')
  const [maintenanceOpen, setMaintenanceOpen] = useState(false)
  const members = useMemo(() => new Map(data.members.map((m) => [m.id, m])), [data.members])
  const states = useMemo(() => new Map(data.states.map((s) => [s.id, s])), [data.states])
  const tasks = useMemo(() => new Map(snapshot?.tasks.map((t) => [t.dirName, t]) ?? []), [snapshot?.tasks])
  // A project without an identity must not impersonate its first member.
  const me = snapshot ? snapshot.meta.developer : data.workspace.memberId
  const queues = useMemo(() => {
    const updated = (issue: Issue): number => tasks.get(issue.id)?.updatedAt ?? 0
    const newest = (a: Issue, b: Issue): number => updated(b) - updated(a)
    return {
      assigned: data.issues.filter((i) => me && i.assigneeId === me && isIssueOpen(i, states)).sort(newest),
      created: data.issues.filter((i) => me && (snapshot ? tasks.get(i.id)?.record?.creator === me : i.activity[0]?.actorId === me)).sort(newest),
      recent: data.issues.slice().sort(newest)
    }
  }, [data.issues, me, snapshot, states, tasks])
  const views: Array<{ id: WorkView; label: string; description: string; empty: string }> = [
    { id: 'assigned', label: '我负责', description: '分配给我的未结束工作，按实际更新时间排列。', empty: '当前没有分配给你的未结束工作' },
    { id: 'created', label: '我创建', description: '由我创建的工作，包含已完成项。', empty: '当前没有由你创建的工作' },
    { id: 'recent', label: '最近更新', description: '项目内任务文件的最近更新记录，不代表实际操作者。', empty: '项目内暂无工作项' }
  ]
  const currentView = views.find((item) => item.id === view) ?? views[0]
  const staleDone = data.issues.filter((i) => {
    if (!i.completedAt) return false
    const timestamp = new Date(`${i.completedAt}T12:00:00`).getTime()
    return Number.isFinite(timestamp) && Date.now() - timestamp >= 10 * 86400000
  })
  const copyArchiveCmd = (dirName: string): void => {
    void navigator.clipboard.writeText(`python .trellis/scripts/task.py archive ${dirName}`).catch(() => undefined)
  }

  return (
    <PageLayout variant={PAGE_LAYOUTS.dashboard}>
    <PageBody>
    <PageContent>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-my-xl font-semibold text-my-primary">我的工作</h1>
          <p className="mt-1 text-my-sm text-my-secondary">
            {me ? `${me}，从当前需要推进的工作开始。` : '当前项目未设置开发者身份，可先查看最近更新。'}
          </p>
        </div>
        <span className="text-my-xs text-my-secondary">
          {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
        </span>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-1 border-b border-my-line" role="tablist" aria-label="我的工作视图">
        {views.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`overview-tab-${item.id}`}
            aria-selected={view === item.id}
            aria-controls="overview-work-list"
            onClick={() => setView(item.id)}
            className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-my-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-my-line-accent ${view === item.id ? 'border-my-line-accent text-my-accent-text' : 'border-transparent text-my-secondary hover:bg-my-layer-1-hover hover:text-my-primary'}`}
          >
            {item.label}<span className="rounded-my-sm bg-my-layer-2 px-1.5 text-my-xs tabular-nums text-my-secondary">{queues[item.id].length}</span>
          </button>
        ))}
      </div>
      <p className="mb-3 text-my-xs text-my-secondary">{currentView.description}{!snapshot && ' 当前为演示数据。'}</p>
      <section id="overview-work-list" role="tabpanel" aria-labelledby={`overview-tab-${view}`} className="overflow-hidden rounded-my-lg border border-my-line bg-my-surface-1">
        {queues[view].length === 0 ? <EmptyState title={currentView.empty} /> : (
          <div className="divide-y divide-my-line">
            {queues[view].map((issue) => (
              <IssueRow key={issue.id} issue={issue} members={members} states={states} updatedAt={tasks.get(issue.id)?.updatedAt} onOpen={openIssue} />
            ))}
          </div>
        )}
      </section>

      {staleDone.length > 0 && (
        <section className="mt-8 border-t border-my-line pt-3">
          <button type="button" onClick={() => setMaintenanceOpen((v) => !v)} aria-expanded={maintenanceOpen} className="flex items-center gap-2 text-my-xs text-my-secondary hover:text-my-primary">
            <Archive size={13} /> 归档整理 · {staleDone.length} 项已完成超过 10 天 <span>{maintenanceOpen ? '收起' : '查看'}</span>
          </button>
          {maintenanceOpen && (
            <div className="mt-3 space-y-2">
              <p className="text-my-xs text-my-secondary">复制命令后在项目目录执行；归档记录仍可查看。</p>
              {staleDone.map((issue) => (
                <div key={issue.id} className="flex items-center justify-between gap-3 text-my-sm text-my-secondary">
                  <button type="button" onClick={() => openIssue(issue.id)} className="truncate text-left hover:text-my-accent-text">{issue.name}</button>
                  <Button variant="ghost" size="sm" onClick={() => copyArchiveCmd(issue.id)}><Copy size={11} /> 复制命令</Button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </PageContent>
    </PageBody>
    </PageLayout>
  )
}
