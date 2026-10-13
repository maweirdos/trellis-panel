// 模块页：模块卡片网格（色块图标 / 状态徽标 / 负责人 / 成员 / 进度 / 日期 / 计数）；
// 选中模块进入详情（进度大卡片 + 按状态分组的简单看板），结构与周期详情同构。
import { type JSX } from 'react'
import { ArrowLeft, CalendarDays, Plus } from 'lucide-react'
import { clsx } from 'clsx'
import { useMy } from '../store'
import { Avatar, AvatarStack, Button, EmptyState, Tooltip, TriProgressBar, formatDate } from '../ui'
import { NavIcon, WorkspaceMark, PriorityIcon, StateGroupIcon } from '../icons'
import type { Issue, Member, Module, WorkItemState } from '../types'

type ModuleStatus = Module['status']

/* ---------------- 常量 ---------------- */

const STATUS_META: Record<ModuleStatus, { label: string; className: string }> = {
  planned: { label: '已规划', className: 'bg-my-layer-3 text-my-tertiary' },
  'in-progress': { label: '进行中', className: 'bg-my-info-subtle text-my-info-text' },
  completed: { label: '已完成', className: 'bg-my-success-subtle text-my-success-text' },
  paused: { label: '已暂停', className: 'bg-my-warning-subtle text-my-warning-text' }
}

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

interface ModuleProgress {
  done: number
  started: number
  todo: number
  total: number
}

function progressOf(moduleIssues: Issue[], states: WorkItemState[]): ModuleProgress {
  let done = 0
  let started = 0
  for (const issue of moduleIssues) {
    const st = states.find((s) => s.id === issue.stateId)
    if (st?.group === 'completed') done += 1
    else if (st?.group === 'started') started += 1
  }
  return { done, started, todo: moduleIssues.length - done - started, total: moduleIssues.length }
}

/** 详情头部的进度文案 */
function countdownLabel(mod: Module): string {
  const today = todayIso()
  if (mod.status === 'completed') return '已完成'
  if (mod.status === 'paused') return '已暂停'
  if (mod.status === 'planned') {
    const lead = diffDays(mod.startDate, today)
    return lead > 0 ? `${lead} 天后开始` : '已进入执行窗口'
  }
  const remain = diffDays(mod.endDate, today)
  return remain > 0 ? `剩余 ${remain} 天` : '今天收尾'
}

/* ---------------- 小件 ---------------- */

function StatusBadge({ status }: { status: ModuleStatus }): JSX.Element {
  const meta = STATUS_META[status]
  return (
    <span
      className={clsx(
        'inline-flex h-[20px] shrink-0 items-center rounded-[4px] px-1.5 text-[11px] font-medium',
        meta.className
      )}
    >
      {meta.label}
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

/** 模块色块图标：项目色圆角块 + 模块名首字 */
function ModuleGlyph({ color, name, size = 28 }: { color: string; name: string; size?: number }): JSX.Element {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-md font-semibold text-white"
      style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}
    >
      {name.slice(0, 1)}
    </span>
  )
}

/* ---------------- 模块卡片 ---------------- */

function ModuleCard({
  mod,
  color,
  progress,
  lead,
  members,
  onSelect
}: {
  mod: Module
  color: string
  progress: ModuleProgress
  lead: Member | null
  members: Member[]
  onSelect: (id: string) => void
}): JSX.Element {
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => onSelect(mod.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(mod.id)
        }
      }}
      className="my-card cursor-pointer p-3"
    >
      <div className="flex items-start gap-2.5">
        <ModuleGlyph color={color} name={mod.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-my-primary">{mod.name}</span>
            <StatusBadge status={mod.status} />
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-my-tertiary">
            {lead ? <Avatar name={lead.name} color={lead.avatarColor} size={16} /> : null}
            <span className="truncate">{lead ? lead.name : '未设置负责人'}</span>
          </div>
        </div>
      </div>
      {mod.description !== '' && <p className="mt-2 truncate text-[12px] text-my-tertiary">{mod.description}</p>}
      <div className="mt-2 flex items-center gap-1.5 text-[12px] text-my-tertiary">
        <CalendarDays size={12} className="text-my-icon-tertiary" />
        <span>
          {formatDate(mod.startDate)} – {formatDate(mod.endDate)}
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

/* ---------------- 模块详情 ---------------- */

function ModuleDetail({ mod, color, lead, members }: { mod: Module; color: string; lead: Member | null; members: Member[] }): JSX.Element {
  const data = useMy((s) => s.data)
  const setSelectedModule = useMy((s) => s.setSelectedModule)
  const openIssue = useMy((s) => s.openIssue)

  const moduleIssues = data.issues.filter((i) => mod.issueIds.includes(i.id))
  const progress = progressOf(moduleIssues, data.states)

  return (
    <div className="flex h-full min-h-0 flex-col bg-my-canvas">
      {/* 详情顶栏：返回 + 面包屑 */}
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-my-line bg-my-canvas px-4">
        <Tooltip label="返回模块列表">
          <button
            type="button"
            onClick={() => setSelectedModule(null)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-my-icon-secondary hover:bg-my-layer-1-hover"
          >
            <ArrowLeft size={14} />
          </button>
        </Tooltip>
        <NavIcon name="modules" size={14} className="text-my-icon-tertiary" />
        <span className="shrink-0 text-[13px] text-my-tertiary">Modules</span>
        <span className="text-my-disabled">/</span>
        <span className="min-w-0 truncate text-[13px] font-medium text-my-primary">{mod.name}</span>
        <span className="ml-auto shrink-0">
          <StatusBadge status={mod.status} />
        </span>
      </header>

      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        {/* 头部大卡片：进度文案 + 负责人/成员 + 进度条 + 三段计数 */}
        <div className="my-card p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <ModuleGlyph color={color} name={mod.name} size={36} />
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-wide text-my-tertiary">
                  {STATUS_META[mod.status].label}
                </div>
                <div className="mt-1 text-[20px] font-semibold text-my-primary">{countdownLabel(mod)}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-my-tertiary">
                  <span className="flex items-center gap-1.5">
                    <CalendarDays size={12} className="text-my-icon-tertiary" />
                    {formatDate(mod.startDate)} – {formatDate(mod.endDate)}
                  </span>
                  {lead ? (
                    <span className="flex items-center gap-1.5">
                      <Avatar name={lead.name} color={lead.avatarColor} size={16} />
                      负责人 · {lead.name}
                    </span>
                  ) : null}
                </div>
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
        {moduleIssues.length === 0 ? (
          <EmptyState title="模块内暂无工作项" description="把工作项挂到该模块后会在这里按状态分组展示。" />
        ) : (
          <div className="my-scrollbar overflow-x-auto pb-2">
            <DetailBoard
              issues={moduleIssues}
              states={data.states}
              members={members}
              onOpen={(id) => openIssue(id)}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- 页面入口 ---------------- */

export function ModulesPage(): JSX.Element {
  const data = useMy((s) => s.data)
  const activeProjectId = useMy((s) => s.activeProjectId)
  const selectedModuleId = useMy((s) => s.selectedModuleId)
  const setSelectedModule = useMy((s) => s.setSelectedModule)

  const project = data.projects.find((p) => p.id === activeProjectId) ?? data.projects[0]
  const projectModules = data.modules.filter((m) => m.projectId === project.id)
  const selected =
    selectedModuleId === null
      ? null
      : (data.modules.find((m) => m.id === selectedModuleId && m.projectId === project.id) ?? null)

  const leadOf = (mod: Module): Member | null =>
    mod.leadId === '' ? null : (data.members.find((m) => m.id === mod.leadId) ?? null)
  const membersOf = (mod: Module): Member[] =>
    mod.memberIds.map((id) => data.members.find((m) => m.id === id)).filter((m): m is Member => Boolean(m))

  // 选中模块：整页切换为详情
  if (selected) {
    return <ModuleDetail mod={selected} color={project.color} lead={leadOf(selected)} members={membersOf(selected)} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-my-canvas">
      {/* 顶栏 52px：面包屑 + 新建 */}
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-my-line bg-my-canvas px-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <WorkspaceMark color={project.color} letter={project.icon} size={16} />
          <span className="truncate text-[13px] font-medium text-my-primary">{project.name}</span>
          <span className="text-my-disabled">/</span>
          <NavIcon name="modules" size={14} className="text-my-icon-tertiary" />
          <span className="shrink-0 text-[13px] text-my-tertiary">Modules</span>
        </div>
        <span className="text-[12px] text-my-tertiary">{projectModules.length} 个模块</span>
        <div className="ml-auto flex shrink-0 items-center">
          <Button variant="primary" disabled title="演示模式，暂不支持新建模块">
            <Plus size={13} />
            New module
          </Button>
        </div>
      </header>

      {/* 模块卡片网格 */}
      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        {projectModules.length === 0 ? (
          <EmptyState title="暂无模块" description="该项目还没有创建任何模块。" />
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {projectModules.map((m) => {
              const items = data.issues.filter((i) => m.issueIds.includes(i.id))
              return (
                <ModuleCard
                  key={m.id}
                  mod={m}
                  color={project.color}
                  progress={progressOf(items, data.states)}
                  lead={leadOf(m)}
                  members={membersOf(m)}
                  onSelect={(id) => setSelectedModule(id)}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
