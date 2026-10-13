// 周期页：All/Active/Upcoming/Completed/Drafts 页签过滤 + 周期卡片网格；
// 选中周期进入详情（倒计时大卡片 + 进度 + 按状态分组的简单看板）。
import { useState, type JSX } from 'react'
import { ArrowLeft, CalendarDays, Plus } from 'lucide-react'
import { clsx } from 'clsx'
import { useMy } from '../store'
import { Avatar, AvatarStack, Button, EmptyState, Tabs, Tooltip, TriProgressBar, formatDate } from '../ui'
import { NavIcon, WorkspaceMark, PriorityIcon, StateGroupIcon } from '../icons'
import type { Cycle, CycleStatus, Issue, Member, WorkItemState } from '../types'

/* ---------------- 常量 ---------------- */

const STATUS_LABELS: Record<CycleStatus, string> = {
  draft: '草稿',
  upcoming: '即将开始',
  active: '进行中',
  completed: '已完成'
}

type CycleTab = 'all' | CycleStatus

const TAB_DEFS: Array<{ id: CycleTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'completed', label: 'Completed' },
  { id: 'draft', label: 'Drafts' }
]

/* ---------------- 日期小工具（本地时区，YYYY-MM-DD） ---------------- */

function parseIso(s: string): Date {
  const parts = s.split('-')
  const y = Number(parts[0] ?? 1970)
  const m = Number(parts[1] ?? 1)
  const d = Number(parts[2] ?? 1)
  return new Date(y, m - 1, d)
}

function todayIso(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** a - b 的天数差 */
function diffDays(a: string, b: string): number {
  return Math.round((parseIso(a).getTime() - parseIso(b).getTime()) / 86_400_000)
}

/* ---------------- 进度统计 ---------------- */

interface CycleProgress {
  done: number
  started: number
  todo: number
  total: number
}

function progressOf(cycleIssues: Issue[], states: WorkItemState[]): CycleProgress {
  let done = 0
  let started = 0
  for (const issue of cycleIssues) {
    const st = states.find((s) => s.id === issue.stateId)
    if (st?.group === 'completed') done += 1
    else if (st?.group === 'started') started += 1
  }
  return { done, started, todo: cycleIssues.length - done - started, total: cycleIssues.length }
}

/** 详情头部的倒计时文案 */
function countdownLabel(cycle: Cycle): string {
  const today = todayIso()
  if (cycle.status === 'active') {
    const remain = diffDays(cycle.endDate, today)
    return remain > 0 ? `剩余 ${remain} 天` : '今天结束'
  }
  if (cycle.status === 'upcoming' || cycle.status === 'draft') {
    const lead = diffDays(cycle.startDate, today)
    const prefix = cycle.status === 'draft' ? '草稿 · ' : ''
    return lead > 0 ? `${prefix}${lead} 天后开始` : `${prefix}即将开始`
  }
  return `已于 ${formatDate(cycle.endDate)} 结束`
}

/* ---------------- 小件 ---------------- */

function StatusBadge({ label, className }: { label: string; className?: string }): JSX.Element {
  return (
    <span
      className={clsx(
        'inline-flex h-[20px] shrink-0 items-center rounded-[4px] bg-my-layer-3 px-1.5 text-[11px] font-medium text-my-tertiary',
        className
      )}
    >
      {label}
    </span>
  )
}

function DotCount({ colorClass, label, value }: { colorClass: string; label: string; value: number }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx('h-2 w-2 rounded-full', colorClass)} />
      <span className="font-medium text-my-primary">{value}</span>
      <span className="text-my-tertiary">{label}</span>
    </span>
  )
}

function AssigneeBadge({ member }: { member: Member | null }): JSX.Element {
  if (!member) {
    return (
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-dashed border-my-line-strong text-[10px] leading-none text-my-disabled">
        –
      </span>
    )
  }
  return <Avatar name={member.name} color={member.avatarColor} size={18} />
}

/* ---------------- 周期卡片 ---------------- */

function CycleCard({
  cycle,
  progress,
  members,
  onSelect
}: {
  cycle: Cycle
  progress: CycleProgress
  members: Member[]
  onSelect: (id: string) => void
}): JSX.Element {
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => onSelect(cycle.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(cycle.id)
        }
      }}
      className="my-card cursor-pointer p-3"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-my-primary">{cycle.name}</span>
        <StatusBadge label={STATUS_LABELS[cycle.status]} />
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[12px] text-my-tertiary">
        <CalendarDays size={12} className="text-my-icon-tertiary" />
        <span>
          {formatDate(cycle.startDate)} – {formatDate(cycle.endDate)}
        </span>
      </div>
      <div className="mt-3">
        <TriProgressBar done={progress.done} started={progress.started} total={progress.total} />
      </div>
      <div className="mt-3 flex items-center justify-between">
        <AvatarStack members={members} max={3} size={20} />
        <span className="text-[11px] text-my-tertiary">{progress.total} 项工作项</span>
      </div>
    </article>
  )
}

/* ---------------- 详情看板（按状态分组） ---------------- */

function BoardMiniCard({
  issue,
  members,
  onOpen
}: {
  issue: Issue
  members: Member[]
  onOpen: (id: string) => void
}): JSX.Element {
  const assignee = issue.assigneeId === null ? null : (members.find((m) => m.id === issue.assigneeId) ?? null)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(issue.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(issue.id)
        }
      }}
      className="cursor-pointer rounded-md border border-my-line bg-my-layer-2 p-2 hover:border-my-line-strong"
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-[2px]">
          <PriorityIcon priority={issue.priority} size={12} />
        </span>
        <span className="line-clamp-2 text-[12.5px] leading-5 text-my-secondary">{issue.name}</span>
      </div>
      <div className="mt-1.5 flex items-center justify-end">
        <AssigneeBadge member={assignee} />
      </div>
    </div>
  )
}

function DetailBoard({
  issues,
  states,
  members,
  onOpen
}: {
  issues: Issue[]
  states: WorkItemState[]
  members: Member[]
  onOpen: (id: string) => void
}): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      {states.map((st) => {
        const items = issues.filter((i) => i.stateId === st.id)
        return (
          <div key={st.id} className="flex w-[248px] shrink-0 flex-col rounded-lg border border-my-line bg-my-layer-1">
            <div className="flex h-9 items-center gap-1.5 border-b border-my-line px-3">
              <StateGroupIcon stateGroup={st.group} color={st.color} size={14} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-my-secondary">{st.name}</span>
              <span className="text-[11px] text-my-tertiary">{items.length}</span>
            </div>
            <div className="flex flex-col gap-1.5 p-2">
              {items.map((i) => (
                <BoardMiniCard key={i.id} issue={i} members={members} onOpen={onOpen} />
              ))}
              {items.length === 0 && (
                <div className="rounded-md border border-dashed border-my-line py-4 text-center text-[11px] text-my-disabled">
                  暂无工作项
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ---------------- 周期详情 ---------------- */

function CycleDetail({ cycle, members }: { cycle: Cycle; members: Member[] }): JSX.Element {
  const data = useMy((s) => s.data)
  const setSelectedCycle = useMy((s) => s.setSelectedCycle)
  const openIssue = useMy((s) => s.openIssue)

  const cycleIssues = data.issues.filter((i) => cycle.issueIds.includes(i.id))
  const progress = progressOf(cycleIssues, data.states)

  return (
    <div className="flex h-full min-h-0 flex-col bg-my-canvas">
      {/* 详情顶栏：返回 + 面包屑 */}
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-my-line bg-my-canvas px-4">
        <Tooltip label="返回周期列表">
          <button
            type="button"
            onClick={() => setSelectedCycle(null)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-my-icon-secondary hover:bg-my-layer-1-hover"
          >
            <ArrowLeft size={14} />
          </button>
        </Tooltip>
        <NavIcon name="cycles" size={14} className="text-my-icon-tertiary" />
        <span className="shrink-0 text-[13px] text-my-tertiary">Cycles</span>
        <span className="text-my-disabled">/</span>
        <span className="min-w-0 truncate text-[13px] font-medium text-my-primary">{cycle.name}</span>
        <span className="ml-auto shrink-0">
          <StatusBadge label={STATUS_LABELS[cycle.status]} />
        </span>
      </header>

      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        {/* 头部大卡片：倒计时 + 进度 + 三段计数 */}
        <div className="my-card p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-wide text-my-tertiary">
                {STATUS_LABELS[cycle.status]}
              </div>
              <div className="mt-1 text-[20px] font-semibold text-my-primary">{countdownLabel(cycle)}</div>
              <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-my-tertiary">
                <CalendarDays size={12} className="text-my-icon-tertiary" />
                <span>
                  {formatDate(cycle.startDate)} – {formatDate(cycle.endDate)}
                </span>
              </div>
            </div>
            <AvatarStack members={members} max={4} size={24} />
          </div>
          <div className="mt-4">
            <TriProgressBar done={progress.done} started={progress.started} total={progress.total} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px]">
            <DotCount colorClass="bg-my-success-text" label="Done" value={progress.done} />
            <DotCount colorClass="bg-my-warning-text" label="In progress" value={progress.started} />
            <DotCount colorClass="bg-my-tertiary" label="To-do" value={progress.todo} />
          </div>
        </div>

        {/* 按状态分组的看板 */}
        <h3 className="mb-2 mt-5 text-[12px] font-medium text-my-tertiary">工作项看板</h3>
        {cycleIssues.length === 0 ? (
          <EmptyState title="周期内暂无工作项" description="把工作项加入该周期后会在这里按状态分组展示。" />
        ) : (
          <div className="my-scrollbar overflow-x-auto pb-2">
            <DetailBoard issues={cycleIssues} states={data.states} members={members} onOpen={(id) => openIssue(id)} />
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- 页面入口 ---------------- */

export function CyclesPage(): JSX.Element {
  const data = useMy((s) => s.data)
  const activeProjectId = useMy((s) => s.activeProjectId)
  const selectedCycleId = useMy((s) => s.selectedCycleId)
  const setSelectedCycle = useMy((s) => s.setSelectedCycle)
  const [tab, setTab] = useState<CycleTab>('all')

  const project = data.projects.find((p) => p.id === activeProjectId) ?? data.projects[0]
  const projectMembers: Member[] = project.memberIds
    .map((id) => data.members.find((m) => m.id === id))
    .filter((m): m is Member => Boolean(m))
  const projectCycles = data.cycles.filter((c) => c.projectId === project.id)
  const visible = tab === 'all' ? projectCycles : projectCycles.filter((c) => c.status === tab)
  const selected =
    selectedCycleId === null
      ? null
      : (data.cycles.find((c) => c.id === selectedCycleId && c.projectId === project.id) ?? null)

  // 选中周期：整页切换为详情
  if (selected) {
    return <CycleDetail cycle={selected} members={projectMembers} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-my-canvas">
      {/* 顶栏 52px：面包屑 + 页签 + 新建 */}
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-my-line bg-my-canvas px-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <WorkspaceMark color={project.color} letter={project.icon} size={16} />
          <span className="truncate text-[13px] font-medium text-my-primary">{project.name}</span>
          <span className="text-my-disabled">/</span>
          <NavIcon name="cycles" size={14} className="text-my-icon-tertiary" />
          <span className="shrink-0 text-[13px] text-my-tertiary">Cycles</span>
        </div>
        <Tabs
          tabs={TAB_DEFS.map((t) => ({
            id: t.id,
            label: t.label,
            count: t.id === 'all' ? projectCycles.length : projectCycles.filter((c) => c.status === t.id).length
          }))}
          active={tab}
          onChange={(id) => setTab(id)}
        />
        <div className="ml-auto flex shrink-0 items-center">
          <Button variant="primary" disabled title="演示模式，暂不支持新建周期">
            <Plus size={13} />
            New cycle
          </Button>
        </div>
      </header>

      {/* 周期卡片网格 */}
      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        {visible.length === 0 ? (
          <EmptyState title="暂无周期" description="当前页签下没有匹配的周期。" />
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {visible.map((c) => {
              const items = data.issues.filter((i) => c.issueIds.includes(i.id))
              return (
                <CycleCard
                  key={c.id}
                  cycle={c}
                  progress={progressOf(items, data.states)}
                  members={projectMembers}
                  onSelect={(id) => setSelectedCycle(id)}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
