// 工作项页：顶栏（面包屑 + tabs + 布局切换器 + 筛选/显示 + 新建按钮）与 5 种布局（List/Board/Spreadsheet/Gantt/Calendar）。
import { useState, type JSX } from 'react'
import { clsx } from 'clsx'
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListTree,
  MoreHorizontal,
  Plus,
  Settings2,
  SlidersHorizontal
} from 'lucide-react'
import { PRIORITY_ORDER, filterIssues, useMy } from '../store'
import {
  Avatar,
  Button,
  Checkbox,
  Dropdown,
  DropdownHeader,
  DropdownItem,
  EmptyState,
  LabelPill,
  Tabs,
  Tooltip,
  formatDate
} from '../ui'
import { LayoutIcon, WorkspaceMark, PriorityIcon, StateGroupIcon } from '../icons'
import type {
  GroupBy,
  Issue,
  Label,
  Member,
  OrderBy,
  Priority,
  StateGroup,
  WorkItemLayout,
  WorkItemState
} from '../types'

/* ---------------- 常量 ---------------- */

type IssueTab = 'all' | 'active' | 'backlog'

const STATE_GROUPS: StateGroup[] = ['backlog', 'unstarted', 'started', 'completed', 'cancelled']
const STATE_GROUP_LABELS: Record<StateGroup, string> = {
  backlog: 'Backlog',
  unstarted: 'Unstarted',
  started: 'Started',
  completed: 'Completed',
  cancelled: 'Cancelled'
}
const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'None'
}
const LAYOUTS: Array<{ id: WorkItemLayout; label: string }> = [
  { id: 'list', label: '列表' },
  { id: 'board', label: '看板' },
  { id: 'spreadsheet', label: '表格' },
  { id: 'gantt', label: '甘特' },
  { id: 'calendar', label: '日历' }
]
const GROUP_BY_OPTIONS: Array<{ id: GroupBy; label: string }> = [
  { id: 'state', label: '状态' },
  { id: 'priority', label: '优先级' },
  { id: 'assignee', label: '负责人' },
  { id: 'labels', label: '标签' },
  { id: 'none', label: '无' }
]
const ORDER_BY_OPTIONS: Array<{ id: OrderBy; label: string }> = [
  { id: 'priority', label: '优先级' },
  { id: 'due_date', label: '截止日期' },
  { id: 'created_at', label: '创建时间' },
  { id: 'manual', label: '手动' }
]
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

/* ---------------- 日期小工具（本地时区，YYYY-MM-DD） ---------------- */

function toIso(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function parseIso(s: string): Date {
  const parts = s.split('-').map((n) => Number(n))
  return new Date(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1)
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d)
  next.setDate(next.getDate() + n)
  return next
}

/** a - b 的天数差（两个均为当日零点或同源 Date） */
function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000)
}

/** 本周周一（周为列的起点） */
function startMonday(d: Date): Date {
  const day = d.getDay()
  const lead = (day + 6) % 7
  const mon = new Date(d)
  mon.setHours(0, 0, 0, 0)
  return addDays(mon, -lead)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}

/* ---------------- 分组模型 ---------------- */

type GroupMeta =
  | { kind: 'state'; state: WorkItemState }
  | { kind: 'priority'; priority: Priority }
  | { kind: 'assignee'; member: Member | null }
  | { kind: 'label'; label: Label | null }
  | { kind: 'none' }

interface IssueGroup {
  key: string
  title: string
  meta: GroupMeta
  issues: Issue[]
}

/** 组内排序（manual = 保持数据顺序） */
function sortIssues(issues: Issue[], orderBy: OrderBy): Issue[] {
  const arr = [...issues]
  if (orderBy === 'priority') {
    arr.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
  } else if (orderBy === 'due_date') {
    arr.sort((a, b) => {
      if (!a.dueDate && !b.dueDate) return 0
      if (!a.dueDate) return 1
      if (!b.dueDate) return -1
      return a.dueDate.localeCompare(b.dueDate)
    })
  } else if (orderBy === 'created_at') {
    arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  return arr
}

function buildGroups(
  issues: Issue[],
  groupBy: GroupBy,
  orderBy: OrderBy,
  states: WorkItemState[],
  members: Member[],
  labels: Label[]
): IssueGroup[] {
  const sorted = sortIssues(issues, orderBy)
  if (groupBy === 'none') {
    return [{ key: 'none', title: '全部', meta: { kind: 'none' }, issues: sorted }]
  }
  if (groupBy === 'state') {
    const ordered = [...states].sort((a, b) => a.sequence - b.sequence)
    return ordered.map((st) => ({
      key: `state:${st.id}`,
      title: st.name,
      meta: { kind: 'state', state: st },
      issues: sorted.filter((i) => i.stateId === st.id)
    }))
  }
  if (groupBy === 'priority') {
    return PRIORITIES.map((pr) => ({
      key: `priority:${pr}`,
      title: PRIORITY_LABELS[pr],
      meta: { kind: 'priority', priority: pr },
      issues: sorted.filter((i) => i.priority === pr)
    }))
  }
  if (groupBy === 'assignee') {
    const byMember: IssueGroup[] = members.map((m) => ({
      key: `assignee:${m.id}`,
      title: m.name,
      meta: { kind: 'assignee', member: m },
      issues: sorted.filter((i) => i.assigneeId === m.id)
    }))
    byMember.push({
      key: 'assignee:none',
      title: '未分配',
      meta: { kind: 'assignee', member: null },
      issues: sorted.filter((i) => i.assigneeId === null)
    })
    return byMember
  }
  // labels：同一工作项可出现在多个标签组；无标签项归入「无标签」
  const byLabel: IssueGroup[] = labels.map((lb) => ({
    key: `label:${lb.id}`,
    title: lb.name,
    meta: { kind: 'label', label: lb },
    issues: sorted.filter((i) => i.labelIds.includes(lb.id))
  }))
  byLabel.push({
    key: 'label:none',
    title: '无标签',
    meta: { kind: 'label', label: null },
    issues: sorted.filter((i) => i.labelIds.length === 0)
  })
  return byLabel
}

/* ---------------- 通用小组件 ---------------- */

/** 标签色点（下拉/分组头用） */
function LabelDot({ label }: { label: Label }): JSX.Element {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-[3px]"
      style={{ background: `var(--my-label-${label.color}-icon)` }}
    />
  )
}

/** 分组徽标：按组别渲染状态/优先级/负责人/标签图标 */
function GroupBadge({ meta, size = 12 }: { meta: GroupMeta; size?: number }): JSX.Element | null {
  if (meta.kind === 'state') {
    return <StateGroupIcon stateGroup={meta.state.group} color={meta.state.color} size={size} />
  }
  if (meta.kind === 'priority') {
    return <PriorityIcon priority={meta.priority} size={size} />
  }
  if (meta.kind === 'assignee') {
    if (meta.member) {
      return <Avatar name={meta.member.name} color={meta.member.avatarColor} size={size + 6} />
    }
    return (
      <span
        className="inline-block shrink-0 rounded-full border border-dashed border-my-line-strong"
        style={{ width: size + 6, height: size + 6 }}
      />
    )
  }
  if (meta.kind === 'label') {
    if (meta.label) return <LabelDot label={meta.label} />
    return <span className="inline-block h-2 w-2 shrink-0 rounded-[3px] border border-dashed border-my-line-strong" />
  }
  return null
}

/** 截止日期 chip：逾期标红 */
function DueChip({ due, stateGroup, done }: { due: string; stateGroup: StateGroup; done?: boolean }): JSX.Element {
  const today = toIso(new Date())
  const overdue = !done && stateGroup !== 'completed' && stateGroup !== 'cancelled' && due < today
  return (
    <span
      className={clsx(
        'inline-flex h-[20px] shrink-0 items-center gap-1 rounded-[4px] px-1.5 text-[11px]',
        overdue ? 'bg-my-danger-subtle text-my-danger-text' : 'text-my-tertiary'
      )}
    >
      <CalendarDays size={11} className={overdue ? 'text-my-danger-text' : 'text-my-icon-tertiary'} />
      {formatDate(due)}
    </span>
  )
}

/** 空负责人占位 */
function EmptyAvatar({ size = 20 }: { size?: number }): JSX.Element {
  return <span className="inline-block shrink-0 rounded-full border border-dashed border-my-line-strong" style={{ width: size, height: size }} title="未分配" />
}

interface SelectStyle {
  trigger: string
}

const BARE_TRIGGER: SelectStyle = {
  trigger: 'flex h-6 min-w-0 items-center gap-1 rounded px-1.5 text-[11.5px] text-my-secondary hover:bg-my-layer-1-hover'
}
const BOX_TRIGGER: SelectStyle = {
  trigger:
    'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border border-my-line bg-my-layer-1 px-2 text-[12.5px] text-my-secondary hover:bg-my-layer-1-hover'
}

/** 状态下拉（列表行/表格单元格/peek 通用） */
function StateSelect({
  value,
  onChange,
  variant = 'bare',
  showChevron = true
}: {
  value: string
  onChange: (stateId: string) => void
  variant?: 'bare' | 'box'
  showChevron?: boolean
}): JSX.Element {
  const { data } = useMy()
  const current = data.states.find((s) => s.id === value)
  const states = [...data.states].sort((a, b) => a.sequence - b.sequence)
  return (
    <Dropdown
      width={200}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
          className={clsx((variant === 'box' ? BOX_TRIGGER : BARE_TRIGGER).trigger, 'max-w-[150px]')}
        >
          <StateGroupIcon stateGroup={current?.group ?? 'backlog'} color={current?.color} size={variant === 'box' ? 14 : 12} />
          <span className="min-w-0 flex-1 truncate text-left">{current?.name ?? '无状态'}</span>
          {showChevron && <ChevronDown size={11} className="shrink-0 text-my-icon-tertiary" />}
        </button>
      )}
    >
      {(close) => (
        <>
          {states.map((st) => (
            <DropdownItem
              key={st.id}
              selected={st.id === value}
              icon={<StateGroupIcon stateGroup={st.group} color={st.color} size={13} />}
              onClick={() => {
                onChange(st.id)
                close()
              }}
            >
              {st.name}
            </DropdownItem>
          ))}
        </>
      )}
    </Dropdown>
  )
}

/** 优先级下拉 */
function PrioritySelect({
  value,
  onChange,
  variant = 'bare'
}: {
  value: Priority
  onChange: (p: Priority) => void
  variant?: 'bare' | 'box'
}): JSX.Element {
  return (
    <Dropdown
      width={180}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
          className={clsx((variant === 'box' ? BOX_TRIGGER : BARE_TRIGGER).trigger)}
        >
          <PriorityIcon priority={value} size={12} />
          <span className="min-w-0 flex-1 truncate text-left">{PRIORITY_LABELS[value]}</span>
          <ChevronDown size={11} className="shrink-0 text-my-icon-tertiary" />
        </button>
      )}
    >
      {(close) => (
        <>
          {PRIORITIES.map((pr) => (
            <DropdownItem
              key={pr}
              selected={pr === value}
              icon={<PriorityIcon priority={pr} size={13} />}
              onClick={() => {
                onChange(pr)
                close()
              }}
            >
              {PRIORITY_LABELS[pr]}
            </DropdownItem>
          ))}
        </>
      )}
    </Dropdown>
  )
}

/** 负责人下拉（null = 未分配） */
function AssigneeSelect({
  value,
  members,
  onChange,
  variant = 'bare'
}: {
  value: string | null
  members: Member[]
  onChange: (id: string | null) => void
  variant?: 'bare' | 'box'
}): JSX.Element {
  const current = members.find((m) => m.id === value)
  return (
    <Dropdown
      width={200}
      trigger={({ toggle }) => (
        <button
          type="button"
          title={current?.name ?? '未分配'}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
          className={clsx((variant === 'box' ? BOX_TRIGGER : BARE_TRIGGER).trigger, variant === 'bare' && 'h-6')}
        >
          {current ? (
            <Avatar name={current.name} color={current.avatarColor} size={variant === 'box' ? 18 : 20} />
          ) : (
            <EmptyAvatar size={variant === 'box' ? 18 : 20} />
          )}
          {variant === 'box' && (
            <>
              <span className="min-w-0 flex-1 truncate text-left">{current?.name ?? '未分配'}</span>
              <ChevronDown size={11} className="shrink-0 text-my-icon-tertiary" />
            </>
          )}
        </button>
      )}
    >
      {(close) => (
        <>
          <DropdownItem
            selected={value === null}
            onClick={() => {
              onChange(null)
              close()
            }}
          >
            未分配
          </DropdownItem>
          {members.map((m) => (
            <DropdownItem
              key={m.id}
              selected={m.id === value}
              icon={<Avatar name={m.name} color={m.avatarColor} size={16} />}
              onClick={() => {
                onChange(m.id)
                close()
              }}
            >
              {m.name}
            </DropdownItem>
          ))}
        </>
      )}
    </Dropdown>
  )
}

/* ---------------- List 布局 ---------------- */

function ListRow({ issue, ident }: { issue: Issue; ident: string }): JSX.Element {
  const { data, openIssue, updateIssue } = useMy()
  const state = data.states.find((s) => s.id === issue.stateId)
  const assignee = data.members.find((m) => m.id === issue.assigneeId)
  const labels = issue.labelIds
    .map((id) => data.labels.find((l) => l.id === id))
    .filter((l): l is Label => Boolean(l))
  const subCount = issue.subIssueIds.length
  const done = state?.group === 'completed' || state?.group === 'cancelled'
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openIssue(issue.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openIssue(issue.id)
        }
      }}
      className="my-row group flex h-[44px] cursor-pointer items-center gap-2 border-b border-my-line px-3 hover:bg-my-layer-1"
    >
      <span className="my-row-handle select-none text-[11px] leading-none text-my-icon-tertiary">⠿</span>
      <span className="w-16 shrink-0 text-[11.5px] text-my-tertiary">
        {ident}-{issue.sequenceId}
      </span>
      <PriorityIcon priority={issue.priority} size={12} />
      <span className="flex w-[110px] shrink-0 items-center gap-1 overflow-hidden">
        {labels.slice(0, 2).map((lb) => (
          <LabelPill key={lb.id} label={lb} />
        ))}
      </span>
      <span className={clsx('min-w-0 flex-1 truncate text-[13px] text-my-secondary', done && 'opacity-60')}>{issue.name}</span>
      {subCount > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-my-tertiary" title={`${subCount} 个子工作项`}>
          <ListTree size={11} className="text-my-icon-tertiary" />
          {subCount}
        </span>
      )}
      {issue.dueDate && state && <DueChip due={issue.dueDate} stateGroup={state.group} done={done} />}
      {/* 拦截键盘冒泡，避免下拉内按键触发行点击 */}
      <span onKeyDown={(e) => e.stopPropagation()} className="flex shrink-0 items-center">
        <StateSelect
          value={issue.stateId}
          onChange={(stateId) => {
            const st = data.states.find((s) => s.id === stateId)
            updateIssue(issue.id, { stateId, completedAt: st?.group === 'completed' ? toIso(new Date()) : null })
          }}
        />
      </span>
      <span className="ml-1 flex shrink-0 items-center">
        {assignee ? <Avatar name={assignee.name} color={assignee.avatarColor} size={20} /> : <EmptyAvatar />}
      </span>
    </div>
  )
}

function ListLayout({
  groups,
  collapsed,
  onToggleGroup,
  onCreate,
  showEmpty,
  ident
}: {
  groups: IssueGroup[]
  collapsed: Set<string>
  onToggleGroup: (key: string) => void
  onCreate: () => void
  showEmpty: boolean
  ident: string
}): JSX.Element {
  const shown = groups.filter((g) => g.meta.kind === 'none' || showEmpty || g.issues.length > 0)
  if (shown.every((g) => g.issues.length === 0)) {
    return <EmptyState title="没有工作项" description="当前筛选与页签下没有匹配的工作项，调整条件或新建一个。" />
  }
  return (
    <div className="my-scrollbar h-full overflow-y-auto">
      {shown.map((g) => {
        if (g.meta.kind === 'none') {
          return (
            <div key={g.key}>
              {g.issues.map((i) => (
                <ListRow key={i.id} issue={i} ident={ident} />
              ))}
            </div>
          )
        }
        const isCollapsed = collapsed.has(g.key)
        return (
          <section key={g.key}>
            <div className="group flex h-9 items-center gap-1.5 border-b border-my-line px-3">
              <button
                type="button"
                onClick={() => onToggleGroup(g.key)}
                className="flex min-w-0 items-center gap-1.5 rounded text-left hover:bg-my-layer-1-hover"
              >
                <ChevronRight
                  size={12}
                  className={clsx('shrink-0 text-my-icon-tertiary transition-transform', !isCollapsed && 'rotate-90')}
                />
                <GroupBadge meta={g.meta} />
                <span className="truncate text-[13px] font-medium text-my-secondary">{g.title}</span>
                <span className="shrink-0 text-[11px] text-my-tertiary">{g.issues.length}</span>
              </button>
              <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <Tooltip label="新建工作项">
                  <button
                    type="button"
                    onClick={onCreate}
                    className="flex h-6 w-6 items-center justify-center rounded text-my-icon-tertiary hover:bg-my-layer-1-hover hover:text-my-secondary"
                  >
                    <Plus size={13} />
                  </button>
                </Tooltip>
                <Tooltip label={isCollapsed ? '展开分组' : '折叠分组'}>
                  <button
                    type="button"
                    onClick={() => onToggleGroup(g.key)}
                    className="flex h-6 w-6 items-center justify-center rounded text-my-icon-tertiary hover:bg-my-layer-1-hover hover:text-my-secondary"
                  >
                    <MoreHorizontal size={13} />
                  </button>
                </Tooltip>
              </div>
            </div>
            {!isCollapsed &&
              g.issues.map((i) => <ListRow key={i.id} issue={i} ident={ident} />)}
          </section>
        )
      })}
    </div>
  )
}

/* ---------------- Board 布局 ---------------- */

function BoardCard({ issue }: { issue: Issue }): JSX.Element {
  const { data, openIssue } = useMy()
  const state = data.states.find((s) => s.id === issue.stateId)
  const assignee = data.members.find((m) => m.id === issue.assigneeId)
  const labels = issue.labelIds
    .map((id) => data.labels.find((l) => l.id === id))
    .filter((l): l is Label => Boolean(l))
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openIssue(issue.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openIssue(issue.id)
        }
      }}
      className="my-card mx-2.5 mb-1.5 cursor-pointer p-2.5"
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-[3px]">
          <PriorityIcon priority={issue.priority} size={12} />
        </span>
        <span className="line-clamp-2 text-[13px] leading-5 text-my-secondary">{issue.name}</span>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        {labels.slice(0, 2).map((lb) => (
          <LabelPill key={lb.id} label={lb} />
        ))}
        {issue.dueDate && state && <DueChip due={issue.dueDate} stateGroup={state.group} />}
        <span className="ml-auto flex shrink-0 items-center">
          {assignee ? <Avatar name={assignee.name} color={assignee.avatarColor} size={18} /> : <EmptyAvatar size={18} />}
        </span>
      </div>
    </div>
  )
}

function BoardLayout({
  groups,
  collapsed,
  onToggleGroup,
  showEmpty
}: {
  groups: IssueGroup[]
  collapsed: Set<string>
  onToggleGroup: (key: string) => void
  showEmpty: boolean
}): JSX.Element {
  const shown = groups.filter((g) => g.meta.kind === 'none' || showEmpty || g.issues.length > 0)
  if (shown.every((g) => g.issues.length === 0)) {
    return <EmptyState title="没有工作项" description="当前筛选与页签下没有匹配的工作项。" />
  }
  return (
    <div className="my-scrollbar flex h-full items-start overflow-x-auto">
      {shown.map((g) => {
        const isCollapsed = collapsed.has(g.key)
        return (
          <div key={g.key} className="flex w-[280px] min-w-[280px] shrink-0 flex-col">
            <div className="flex h-9 items-center gap-1.5 border-b border-my-line px-3">
              <button
                type="button"
                onClick={() => onToggleGroup(g.key)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left hover:bg-my-layer-1-hover"
              >
                <ChevronRight
                  size={12}
                  className={clsx('shrink-0 text-my-icon-tertiary transition-transform', !isCollapsed && 'rotate-90')}
                />
                <GroupBadge meta={g.meta} />
                <span className="truncate text-[13px] font-medium text-my-secondary">{g.title}</span>
                <span className="shrink-0 text-[11px] text-my-tertiary">{g.issues.length}</span>
              </button>
            </div>
            {!isCollapsed && (
              <div className="min-h-[80px]">
                {g.issues.map((i) => (
                  <BoardCard key={i.id} issue={i} />
                ))}
                {g.issues.length === 0 && (
                  <div className="mx-2.5 mt-2 rounded-md border border-dashed border-my-line py-5 text-center text-[11px] text-my-disabled">
                    暂无工作项
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ---------------- Spreadsheet 布局 ---------------- */

const CELL_BARE = 'flex h-6 min-w-0 items-center gap-1 rounded px-1 text-[12px] text-my-secondary hover:bg-my-layer-1-hover'

function SpreadsheetRow({
  issue,
  ident,
  checked,
  onCheck
}: {
  issue: Issue
  ident: string
  checked: boolean
  onCheck: (id: string, v: boolean) => void
}): JSX.Element {
  const { data, openIssue, updateIssue } = useMy()
  const state = data.states.find((s) => s.id === issue.stateId)
  const assignee = data.members.find((m) => m.id === issue.assigneeId)
  const subCount = issue.subIssueIds.length
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openIssue(issue.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openIssue(issue.id)
        }
      }}
      className="flex h-10 cursor-pointer items-center gap-2 border-b border-my-line px-3 hover:bg-my-layer-1"
    >
      {/* checkbox 列：阻止冒泡，不触发 peek */}
      <span className="flex w-8 shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={checked} onChange={(v) => onCheck(issue.id, v)} />
      </span>
      <span className="w-16 shrink-0 text-[11.5px] text-my-tertiary">
        {ident}-{issue.sequenceId}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate text-[13px] text-my-secondary">{issue.name}</span>
        {subCount > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-my-tertiary">
            <ListTree size={11} className="text-my-icon-tertiary" />
            {subCount}
          </span>
        )}
      </span>
      <span className="w-24 shrink-0" onClick={(e) => e.stopPropagation()}>
        <Dropdown
          width={170}
          trigger={({ toggle }) => (
            <button type="button" onClick={toggle} className={CELL_BARE}>
              <PriorityIcon priority={issue.priority} size={12} />
              <span className="min-w-0 flex-1 truncate text-left">{PRIORITY_LABELS[issue.priority]}</span>
              <ChevronDown size={11} className="shrink-0 text-my-icon-tertiary" />
            </button>
          )}
        >
          {(close) => (
            <>
              {PRIORITIES.map((pr) => (
                <DropdownItem
                  key={pr}
                  selected={pr === issue.priority}
                  icon={<PriorityIcon priority={pr} size={13} />}
                  onClick={() => {
                    updateIssue(issue.id, { priority: pr })
                    close()
                  }}
                >
                  {PRIORITY_LABELS[pr]}
                </DropdownItem>
              ))}
            </>
          )}
        </Dropdown>
      </span>
      <span className="w-32 shrink-0" onClick={(e) => e.stopPropagation()}>
        <StateSelect
          value={issue.stateId}
          onChange={(stateId) => {
            const st = data.states.find((s) => s.id === stateId)
            updateIssue(issue.id, { stateId, completedAt: st?.group === 'completed' ? toIso(new Date()) : null })
          }}
        />
      </span>
      <span className="w-28 shrink-0" onClick={(e) => e.stopPropagation()}>
        <AssigneeSelect
          value={issue.assigneeId}
          members={data.members}
          onChange={(mid) => updateIssue(issue.id, { assigneeId: mid })}
        />
      </span>
      <span className="w-24 shrink-0 truncate text-[12px] text-my-tertiary">{issue.startDate ? formatDate(issue.startDate) : '—'}</span>
      <span className="w-24 shrink-0 truncate text-[12px]">
        {issue.dueDate && state ? (
          <DueChip due={issue.dueDate} stateGroup={state.group} />
        ) : (
          <span className="text-my-tertiary">—</span>
        )}
      </span>
    </div>
  )
}

function SpreadsheetLayout({ issues, ident }: { issues: Issue[]; ident: string }): JSX.Element {
  const [checked, setChecked] = useState<Set<string>>(() => new Set<string>())
  const allChecked = issues.length > 0 && issues.every((i) => checked.has(i.id))
  const onCheck = (id: string, v: boolean): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (v) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const onCheckAll = (v: boolean): void => {
    setChecked(() => {
      if (!v) return new Set<string>()
      return new Set(issues.map((i) => i.id))
    })
  }
  if (issues.length === 0) {
    return <EmptyState title="没有工作项" description="当前筛选与页签下没有匹配的工作项。" />
  }
  const headCell = 'flex items-center px-1'
  return (
    <div className="my-scrollbar h-full overflow-auto">
      <div className="min-w-[860px]">
        {/* 表头（sticky） */}
        <div className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-my-line bg-my-layer-1 px-3 text-[11px] font-medium text-my-tertiary">
          <span className={clsx(headCell, 'w-8 shrink-0')}>
            <Checkbox checked={allChecked} onChange={onCheckAll} />
          </span>
          <span className="w-16 shrink-0">ID</span>
          <span className="min-w-0 flex-1">名称</span>
          <span className="w-24 shrink-0">优先级</span>
          <span className="w-32 shrink-0">状态</span>
          <span className="w-28 shrink-0">负责人</span>
          <span className="w-24 shrink-0">开始</span>
          <span className="w-24 shrink-0">截止</span>
        </div>
        {issues.map((i) => (
          <SpreadsheetRow key={i.id} issue={i} ident={ident} checked={checked.has(i.id)} onCheck={onCheck} />
        ))}
      </div>
    </div>
  )
}

/* ---------------- Gantt 布局 ---------------- */

const GANTT_LEFT = 300
const GANTT_COL = 44
const GANTT_WEEKS = 8
const GANTT_DAYS = GANTT_WEEKS * 7
const GANTT_WIDTH = GANTT_DAYS * GANTT_COL

function GanttLayout({ issues }: { issues: Issue[] }): JSX.Element {
  const { data } = useMy()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const monday = startMonday(today)
  const days = Array.from({ length: GANTT_DAYS }, (_, i) => addDays(monday, i))
  const todayIdx = diffDays(today, monday)
  if (issues.length === 0) {
    return <EmptyState title="没有工作项" description="当前筛选与页签下没有匹配的工作项。" />
  }
  return (
    <div className="my-scrollbar h-full overflow-auto">
      <div style={{ width: GANTT_LEFT + GANTT_WIDTH }} className="relative">
        {/* 时间线表头（sticky top；左侧首格同时 sticky left） */}
        <div className="sticky top-0 z-30 flex h-9 border-b border-my-line bg-my-layer-1">
          <div
            className="sticky left-0 z-10 flex w-[300px] shrink-0 items-center border-r border-my-line px-3 text-[11px] font-medium text-my-tertiary"
            style={{ width: GANTT_LEFT }}
          >
            工作项
          </div>
          {days.map((d, i) => {
            const isToday = i === todayIdx
            const isWeekStart = i % 7 === 0
            return (
              <div
                key={toIso(d)}
                style={{ width: GANTT_COL }}
                className={clsx(
                  'flex shrink-0 items-center justify-center border-r border-my-line text-[10px]',
                  isWeekStart && i > 0 && 'border-l border-my-line-strong',
                  isToday ? 'font-medium text-my-accent-text' : 'text-my-tertiary'
                )}
              >
                {d.getMonth() + 1}/{d.getDate()}
              </div>
            )
          })}
        </div>
        {/* 行区：今日竖线覆盖 */}
        <div className="relative">
          {todayIdx >= 0 && todayIdx < GANTT_DAYS && (
            <div
              className="absolute bottom-0 top-0 z-20 w-px bg-my-accent opacity-50"
              style={{ left: GANTT_LEFT + todayIdx * GANTT_COL + GANTT_COL / 2 }}
            />
          )}
          {issues.map((issue) => {
            const state = data.states.find((s) => s.id === issue.stateId)
            const st = state
            let bar: JSX.Element | null = null
            if (issue.startDate && issue.dueDate && st) {
              const startOff = clamp(diffDays(parseIso(issue.startDate), monday), 0, GANTT_DAYS)
              const endOff = clamp(diffDays(parseIso(issue.dueDate), monday) + 1, 0, GANTT_DAYS)
              if (endOff > startOff) {
                bar = (
                  <div
                    title={`${issue.name}（${issue.startDate} → ${issue.dueDate}）`}
                    className="absolute top-1/2 -translate-y-1/2 rounded-full"
                    style={{
                      left: startOff * GANTT_COL + 3,
                      width: Math.max((endOff - startOff) * GANTT_COL - 6, 8),
                      height: 10,
                      background: st.color
                    }}
                  />
                )
              }
            }
            return (
              <div key={issue.id} className="group/grow flex h-11 border-b border-my-line">
                <div
                  className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-my-line bg-my-canvas px-3 group-hover/grow:bg-my-layer-1"
                  style={{ width: GANTT_LEFT }}
                >
                  {st && <StateGroupIcon stateGroup={st.group} color={st.color} size={12} />}
                  <span className="min-w-0 truncate text-[12.5px] text-my-secondary">{issue.name}</span>
                </div>
                <div className="relative flex shrink-0" style={{ width: GANTT_WIDTH }}>
                  {days.map((d, i) => (
                    <div
                      key={toIso(d)}
                      style={{ width: GANTT_COL }}
                      className={clsx(
                        'h-full shrink-0 border-r border-my-line',
                        i % 7 === 0 && i > 0 && 'border-l border-my-line-strong'
                      )}
                    />
                  ))}
                  {bar}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ---------------- Calendar 布局 ---------------- */

function CalendarLayout({ issues }: { issues: Issue[] }): JSX.Element {
  const { openIssue, data } = useMy()
  const [cursor, setCursor] = useState<{ y: number; m: number }>(() => {
    const n = new Date()
    return { y: n.getFullYear(), m: n.getMonth() }
  })
  const goMonth = (delta: number): void => {
    setCursor((prev) => {
      const d = new Date(prev.y, prev.m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })
  }
  const goToday = (): void => {
    const n = new Date()
    setCursor({ y: n.getFullYear(), m: n.getMonth() })
  }
  // dueDate → issues 映射
  const byDue = new Map<string, Issue[]>()
  for (const issue of issues) {
    if (!issue.dueDate) continue
    const arr = byDue.get(issue.dueDate) ?? []
    arr.push(issue)
    byDue.set(issue.dueDate, arr)
  }
  const first = new Date(cursor.y, cursor.m, 1)
  const lead = (first.getDay() + 6) % 7 // 周一为一周起点
  const gridStart = addDays(first, -lead)
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  const todayIso = toIso(new Date())
  return (
    <div className="my-scrollbar flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3 flex shrink-0 items-center gap-1">
        <span className="mr-2 text-[13px] font-medium text-my-primary">
          {cursor.y}年{cursor.m + 1}月
        </span>
        <button
          type="button"
          onClick={() => goMonth(-1)}
          className="flex h-6 w-6 items-center justify-center rounded text-my-icon-tertiary hover:bg-my-layer-1-hover hover:text-my-secondary"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          type="button"
          onClick={() => goMonth(1)}
          className="flex h-6 w-6 items-center justify-center rounded text-my-icon-tertiary hover:bg-my-layer-1-hover hover:text-my-secondary"
        >
          <ChevronRight size={14} />
        </button>
        <Button size="sm" variant="ghost" className="ml-1" onClick={goToday}>
          回到今天
        </Button>
      </div>
      <div className="grid shrink-0 grid-cols-7 border-l border-t border-my-line">
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="flex h-8 items-center justify-center border-b border-r border-my-line bg-my-layer-1 text-[11px] font-medium text-my-tertiary"
          >
            {w}
          </div>
        ))}
        {cells.map((d) => {
          const iso = toIso(d)
          const inMonth = d.getMonth() === cursor.m
          const isToday = iso === todayIso
          const dayIssues = byDue.get(iso) ?? []
          const shownIssues = dayIssues.slice(0, 3)
          const rest = dayIssues.length - shownIssues.length
          return (
            <div
              key={iso}
              className={clsx(
                'flex min-h-[96px] flex-col gap-1 border-b border-r border-my-line p-1.5',
                inMonth ? 'bg-my-canvas' : 'bg-my-layer-1',
                isToday && 'bg-my-accent-subtle'
              )}
            >
              <span
                className={clsx(
                  'inline-flex h-5 min-w-5 items-center justify-end self-end rounded-full px-1 text-[11px]',
                  isToday
                    ? 'bg-my-accent font-medium text-my-on-color'
                    : inMonth
                      ? 'text-my-tertiary'
                      : 'text-my-disabled'
                )}
              >
                {d.getDate()}
              </span>
              {shownIssues.map((issue) => {
                const st = data.states.find((s) => s.id === issue.stateId)
                return (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => openIssue(issue.id)}
                    className="flex h-[20px] w-full items-center gap-1 rounded-[4px] border border-my-line bg-my-layer-2 px-1 text-left hover:bg-my-layer-1-hover"
                  >
                    {st && <StateGroupIcon stateGroup={st.group} color={st.color} size={10} />}
                    <span className="min-w-0 truncate text-[11px] text-my-secondary">{issue.name}</span>
                  </button>
                )
              })}
              {rest > 0 && <span className="pl-0.5 text-[10px] text-my-tertiary">还有 {rest} 项</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ---------------- 顶栏 ---------------- */

/** 筛选勾选行 */
function FilterCheckRow({
  checked,
  onToggle,
  label,
  icon
}: {
  checked: boolean
  onToggle: () => void
  label: string
  icon?: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-my-layer-1-hover"
    >
      <Checkbox checked={checked} onChange={() => onToggle()} />
      {icon && <span className="flex h-4 w-4 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-my-secondary">{label}</span>
    </button>
  )
}

/** 选中项标记（单选下拉里用） */
function CheckMark({ show }: { show: boolean }): JSX.Element {
  return <Check size={12} className={clsx('text-my-accent-text', !show && 'opacity-0')} />
}

/* ---------------- 页面 ---------------- */

function WorkItemsPageInner(): JSX.Element {
  const store = useMy()
  const { data, layout, groupBy, orderBy, filters, display, activeProjectId } = store
  const project = data.projects.find((p) => p.id === activeProjectId) ?? data.projects[0]
  const [tab, setTab] = useState<IssueTab>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set<string>())

  const toggleGroup = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const stateOf = (stateId: string): WorkItemState | undefined => data.states.find((s) => s.id === stateId)

  // 数据管线：项目 → store 筛选 → 子工作项显示开关 → 页签
  const projectIssues = data.issues.filter((i) => i.projectId === project.id)
  const filtered = filterIssues(projectIssues, filters)
  const visible = display.showSubIssues ? filtered : filtered.filter((i) => i.parentId === null)
  const tabbed = visible.filter((i) => {
    if (tab === 'all') return true
    const g = stateOf(i.stateId)?.group
    if (tab === 'active') return g === 'unstarted' || g === 'started'
    return g === 'backlog'
  })
  const countIn = (predicate: (g: StateGroup | undefined) => boolean): number =>
    visible.filter((i) => predicate(stateOf(i.stateId)?.group)).length
  const tabs: Array<{ id: IssueTab; label: string; count?: number }> = [
    { id: 'all', label: 'All', count: visible.length },
    { id: 'active', label: 'Active', count: countIn((g) => g === 'unstarted' || g === 'started') },
    { id: 'backlog', label: 'Backlog', count: countIn((g) => g === 'backlog') }
  ]

  const groups = buildGroups(tabbed, groupBy, orderBy, data.states, data.members, data.labels)
  const filterCount = filters.priority.length + filters.stateGroup.length + filters.assigneeIds.length + filters.labelIds.length
  const ident = project.id.replace(/^p-/, '').toUpperCase()

  let body: JSX.Element
  if (layout === 'list') {
    body = (
      <ListLayout
        groups={groups}
        collapsed={collapsed}
        onToggleGroup={toggleGroup}
        onCreate={() => store.setCreateIssueOpen(true)}
        showEmpty={display.showEmptyGroups}
        ident={ident}
      />
    )
  } else if (layout === 'board') {
    body = (
      <BoardLayout groups={groups} collapsed={collapsed} onToggleGroup={toggleGroup} showEmpty={display.showEmptyGroups} />
    )
  } else if (layout === 'spreadsheet') {
    body = <SpreadsheetLayout issues={tabbed} ident={ident} />
  } else if (layout === 'gantt') {
    body = <GanttLayout issues={tabbed} />
  } else {
    body = <CalendarLayout issues={tabbed} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 52px */}
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-my-line bg-my-canvas px-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <WorkspaceMark color={project.color} letter={project.icon} size={16} />
          <span className="truncate text-[13px] font-medium text-my-primary">{project.name}</span>
          <span className="text-my-disabled">/</span>
          <span className="shrink-0 text-[13px] text-my-tertiary">Work items</span>
        </div>
        <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id)} />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* 布局切换器 */}
          <div className="flex items-center gap-0.5 rounded-md border border-my-line bg-my-layer-1 p-0.5">
            {LAYOUTS.map((l) => (
              <Tooltip key={l.id} label={l.label}>
                <button
                  type="button"
                  onClick={() => store.setLayout(l.id)}
                  className={clsx(
                    'flex h-6 w-7 items-center justify-center rounded',
                    layout === l.id
                      ? 'bg-my-layer-1-active text-my-primary'
                      : 'text-my-icon-tertiary hover:bg-my-layer-1-hover hover:text-my-secondary'
                  )}
                >
                  <LayoutIcon layout={l.id} size={14} />
                </button>
              </Tooltip>
            ))}
          </div>
          {/* Filters 下拉：状态组/优先级/负责人/标签 四段 */}
          <Dropdown
            width={230}
            align="right"
            trigger={({ toggle }) => (
              <Button variant="neutral" onClick={toggle}>
                <SlidersHorizontal size={13} className="text-my-icon-secondary" />
                Filters
                {filterCount > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-my-accent px-1 text-[10px] font-medium text-my-on-color">
                    {filterCount}
                  </span>
                )}
              </Button>
            )}
          >
            {() => (
              <>
                <DropdownHeader>状态</DropdownHeader>
                {STATE_GROUPS.map((g) => (
                  <FilterCheckRow
                    key={g}
                    checked={filters.stateGroup.includes(g)}
                    onToggle={() => store.toggleFilter('stateGroup', g)}
                    label={STATE_GROUP_LABELS[g]}
                    icon={<StateGroupIcon stateGroup={g} size={12} />}
                  />
                ))}
                <DropdownHeader>优先级</DropdownHeader>
                {PRIORITIES.map((pr) => (
                  <FilterCheckRow
                    key={pr}
                    checked={filters.priority.includes(pr)}
                    onToggle={() => store.toggleFilter('priority', pr)}
                    label={PRIORITY_LABELS[pr]}
                    icon={<PriorityIcon priority={pr} size={12} />}
                  />
                ))}
                <DropdownHeader>负责人</DropdownHeader>
                {data.members.map((m) => (
                  <FilterCheckRow
                    key={m.id}
                    checked={filters.assigneeIds.includes(m.id)}
                    onToggle={() => store.toggleFilter('assigneeIds', m.id)}
                    label={m.name}
                    icon={<Avatar name={m.name} color={m.avatarColor} size={16} />}
                  />
                ))}
                <DropdownHeader>标签</DropdownHeader>
                {data.labels.map((lb) => (
                  <FilterCheckRow
                    key={lb.id}
                    checked={filters.labelIds.includes(lb.id)}
                    onToggle={() => store.toggleFilter('labelIds', lb.id)}
                    label={lb.name}
                    icon={<LabelDot label={lb} />}
                  />
                ))}
                {filterCount > 0 && (
                  <div className="mt-1 border-t border-my-line pt-1">
                    <DropdownItem onClick={() => store.clearFilters()}>清除筛选</DropdownItem>
                  </div>
                )}
              </>
            )}
          </Dropdown>
          {/* Display 下拉：布局/分组/排序/显示 */}
          <Dropdown
            width={210}
            align="right"
            trigger={({ toggle }) => (
              <Button variant="neutral" onClick={toggle}>
                <Settings2 size={13} className="text-my-icon-secondary" />
                Display
              </Button>
            )}
          >
            {() => (
              <>
                <DropdownHeader>布局</DropdownHeader>
                {LAYOUTS.map((l) => (
                  <DropdownItem
                    key={l.id}
                    selected={layout === l.id}
                    icon={<CheckMark show={layout === l.id} />}
                    onClick={() => store.setLayout(l.id)}
                  >
                    {l.label}
                  </DropdownItem>
                ))}
                <DropdownHeader>分组</DropdownHeader>
                {GROUP_BY_OPTIONS.map((o) => (
                  <DropdownItem
                    key={o.id}
                    selected={groupBy === o.id}
                    icon={<CheckMark show={groupBy === o.id} />}
                    onClick={() => store.setGroupBy(o.id)}
                  >
                    {o.label}
                  </DropdownItem>
                ))}
                <DropdownHeader>排序</DropdownHeader>
                {ORDER_BY_OPTIONS.map((o) => (
                  <DropdownItem
                    key={o.id}
                    selected={orderBy === o.id}
                    icon={<CheckMark show={orderBy === o.id} />}
                    onClick={() => store.setOrderBy(o.id)}
                  >
                    {o.label}
                  </DropdownItem>
                ))}
                <DropdownHeader>显示</DropdownHeader>
                <div className="flex w-full items-center gap-2 px-3 py-1.5">
                  <Checkbox
                    checked={display.showEmptyGroups}
                    onChange={(v) => store.setDisplay({ showEmptyGroups: v })}
                  />
                  <span className="text-[12.5px] text-my-secondary">显示空分组</span>
                </div>
                <div className="flex w-full items-center gap-2 px-3 py-1.5">
                  <Checkbox checked={display.showSubIssues} onChange={(v) => store.setDisplay({ showSubIssues: v })} />
                  <span className="text-[12.5px] text-my-secondary">显示子工作项</span>
                </div>
              </>
            )}
          </Dropdown>
          {/* 主按钮 */}
          <Button variant="primary" onClick={() => store.setCreateIssueOpen(true)}>
            <Plus size={13} />
            Add work item
          </Button>
        </div>
      </header>
      {/* 布局主体 */}
      <div className="min-h-0 flex-1 bg-my-canvas">{body}</div>
    </div>
  )
}

export function WorkItemsPage(): JSX.Element {
  return <WorkItemsPageInner />
}

export default WorkItemsPage
