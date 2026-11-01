// 工作项页：顶栏（面包屑 + tabs + 布局切换器 + 筛选/显示 + 新建按钮）与 5 种布局（List/Board/Spreadsheet/Gantt/Calendar）。
import { useEffect, useRef, useState, type JSX } from 'react'
import { clsx } from 'clsx'
import { Bookmark, Calendar, Star } from 'lucide-react'
import { currentWeekKey, isoWeekRangeTitle, nextWeekKey } from '../isoWeek'
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListTree,
  MoreHorizontal,
  Plus,
  Settings2,
  SlidersHorizontal
} from 'lucide-react'
import { PRIORITY_ORDER, useMy } from '../store'
import { useApp } from '../../store'
import {
  WorkItemsProvider, canEditWorkItem, issueAssigneeIds, issueCycleIds, issueIdentifier,
  useWorkItems, useWorkItemsSource, type WorkItemsSource
} from './work-items/work-items-context'
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
import { LayoutIcon, PriorityIcon, StateGroupIcon } from '../icons'
import { PAGE_LAYOUTS, PageHeader, PageLayout } from '../layout/PageLayout'
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
  backlog: '未规划',
  unstarted: '未开始',
  started: '进行中',
  completed: '已完成',
  cancelled: '已取消'
}
const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
  none: '无'
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
  { id: 'package', label: '模块' },
  { id: 'cycle', label: '周期' },
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
  | { kind: 'package'; pkg: string }
  | { kind: 'cycle'; cycle: string }
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
  labels: Label[],
  source: WorkItemsSource
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
      issues: sorted.filter((i) => issueAssigneeIds(source, i).includes(m.id))
    }))
    byMember.push({
      key: 'assignee:none',
      title: '未分配',
      meta: { kind: 'assignee', member: null },
      issues: sorted.filter((i) => issueAssigneeIds(source, i).length === 0)
    })
    return byMember
  }
  if (groupBy === 'cycle') {
    const versions = source.presentation?.cycleMode === 'version'
    const weeks = Array.from(new Set(sorted.flatMap((i) => issueCycleIds(source, i))))
      .filter((w): w is string => Boolean(w))
      .sort((a, b) => a.localeCompare(b))
    const cols: IssueGroup[] = weeks.map((w) => ({
      key: `cycle:${w}`,
      title: versions ? source.store.data.cycles.find((cycle) => cycle.id === w)?.name ?? w : `第 ${w.split('-W')[1]} 周（${isoWeekRangeTitle(w)}）`,
      meta: { kind: 'cycle', cycle: w },
      issues: sorted.filter((i) => issueCycleIds(source, i).includes(w))
    }))
    cols.push({
      key: 'cycle:none',
      title: versions ? '未排版本' : '无周期',
      meta: { kind: 'cycle', cycle: '' },
      issues: sorted.filter((i) => issueCycleIds(source, i).length === 0)
    })
    return cols
  }
  if (groupBy === 'package') {
    // 模块 = task.json 既有 package 字段；缺失归入「未分组」
    const pkgs = Array.from(new Set(sorted.map((i) => i.pkg ?? null))).sort((a, b) =>
      (a ?? '').localeCompare(b ?? '')
    )
    return pkgs.map((pkg) => ({
      key: `package:${pkg ?? 'none'}`,
      title: pkg ?? '未分组',
      meta: { kind: 'package', pkg: pkg ?? '' },
      issues: sorted.filter((i) => (i.pkg ?? null) === pkg)
    }))
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
  const source = useWorkItemsSource()
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-my-sm"
      style={{ background: source.presentation?.labelColor?.(label) ?? `var(--my-label-${label.color}-icon)` }}
    />
  )
}

function WorkItemLabel({ label }: { label: Label }): JSX.Element {
  const source = useWorkItemsSource()
  return <>{source.presentation?.renderLabel?.(label) ?? <LabelPill label={label} />}</>
}

function IssueVersions({ issue }: { issue: Issue }): JSX.Element | null {
  const source = useWorkItemsSource()
  if (source.presentation?.cycleMode !== 'version') return null
  const names = issueCycleIds(source, issue).map((id) => source.store.data.cycles.find((cycle) => cycle.id === id)?.name ?? id)
  return <span className="max-w-28 shrink-0 truncate text-my-xs text-my-tertiary" title={names.join('、') || '未排版本'}>{names.join('、') || '未排版本'}</span>
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
  if (meta.kind === 'cycle') {
    return <Calendar size={size} className="shrink-0 text-my-icon-secondary" />
  }
  if (meta.kind === 'package') {
    return (
      <span
        title={`模块：${meta.pkg || '未分组'}`}
        className="flex shrink-0 items-center justify-center rounded-my-sm border border-my-line-strong text-my-2xs font-semibold text-my-tertiary"
        style={{ width: size + 6, height: size + 6 }}
      >
        {(meta.pkg || '·').slice(0, 1)}
      </span>
    )
  }
  if (meta.kind === 'label') {
    if (meta.label) return <LabelDot label={meta.label} />
    return <span className="inline-block h-2 w-2 shrink-0 rounded-my-sm border border-dashed border-my-line-strong" />
  }
  return null
}

/** 截止日期 chip：逾期标红 */
function DueChip({ due, stateGroup, done }: { due: string; stateGroup: StateGroup; done?: boolean }): JSX.Element {
  const source = useWorkItemsSource()
  const today = toIso(new Date())
  const overdue = !done && stateGroup !== 'completed' && stateGroup !== 'cancelled' && due < today
  return (
    <span
      title={source.presentation?.dueDateLabel}
      className={clsx(
        'inline-flex h-[20px] shrink-0 items-center gap-1 rounded-my-sm px-1.5 text-my-xs',
        overdue ? 'bg-my-danger-subtle text-my-danger-text' : 'text-my-tertiary'
      )}
    >
      <CalendarDays size={11} className={overdue ? 'text-my-danger-text' : 'text-my-icon-tertiary'} />
      {formatDate(due)}
    </span>
  )
}

/** 空负责人占位 */
/** 模块胶囊：无标签卡片的信息补充（色系由模块名哈希决定，同名同色） */
const PKG_FAMILIES = ['indigo', 'emerald', 'grey', 'crimson', 'yellow', 'orange', 'pink', 'purple']
function pkgLabel(pkg: string | null): Label | null {
  if (!pkg) return null
  let h = 0
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0
  return { id: `pkg:${pkg}`, name: pkg, color: PKG_FAMILIES[h % PKG_FAMILIES.length] }
}

/** 子工作项完成进度（基于 children 的状态统计） */
function subProgress(issue: Issue, issues: Issue[], states: WorkItemState[]): { done: number; total: number } {
  const total = issue.subIssueIds.length
  if (total === 0) return { done: 0, total: 0 }
  const done = issue.subIssueIds.reduce((acc, sid) => {
    const sub = issues.find((i) => i.id === sid)
    const group = sub ? states.find((s) => s.id === sub.stateId)?.group : undefined
    return acc + (group === 'completed' || group === 'cancelled' ? 1 : 0)
  }, 0)
  return { done, total }
}

/** 子工作项进度徽标：图标 + 迷你进度条 + n/n */
function SubProgressBadge({ done, total }: { done: number; total: number }): JSX.Element | null {
  if (total === 0) return null
  const allDone = done >= total
  return (
    <span
      title={`子工作项 ${done}/${total} 已完成`}
      className={clsx(
        'flex h-[18px] shrink-0 items-center gap-1 rounded-my-sm px-1 text-my-xs',
        allDone ? 'bg-my-success-subtle text-my-success-text' : 'bg-my-layer-2 text-my-tertiary'
      )}
    >
      <ListTree size={11} />
      <span className="leading-none">{done}/{total}</span>
      <span className="flex h-1 w-7 overflow-hidden rounded-full bg-my-layer-3">
        <span style={{ width: `${Math.round((done / total) * 100)}%` }} className="bg-my-success" />
      </span>
    </span>
  )
}

function EmptyAvatar({ size = 20 }: { size?: number }): JSX.Element {
  return <span className="inline-block shrink-0 rounded-full border border-dashed border-my-line-strong" style={{ width: size, height: size }} title="未分配" />
}

function IssueAssignees({ issue, size = 20 }: { issue: Issue; size?: number }): JSX.Element {
  const source = useWorkItemsSource()
  const members = issueAssigneeIds(source, issue).map((id) => source.store.data.members.find((member) => member.id === id) ??
    (source.kind === 'collaboration' ? { id, name: id, avatarColor: 'var(--my-avatar-bg)', role: 'Member' as const } : undefined))
    .filter((member): member is Member => Boolean(member))
  return members.length ? (
    <span className="flex items-center gap-1" title={members.map((member) => member.name).join('、')}>
      {members.slice(0, 2).map((member) => <Avatar key={member.id} name={member.name} color={member.avatarColor} size={size} />)}
      {members.length > 2 && <span className="text-my-xs text-my-tertiary">+{members.length - 2}</span>}
    </span>
  ) : <EmptyAvatar size={size} />
}

interface SelectStyle {
  trigger: string
}

const BARE_TRIGGER: SelectStyle = {
  trigger: 'flex h-6 min-w-0 items-center gap-1 rounded px-1.5 text-my-sm text-my-secondary hover:bg-my-layer-1-hover'
}
const BOX_TRIGGER: SelectStyle = {
  trigger:
    'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-my-md border border-my-line bg-my-layer-1 px-2 text-my-sm text-my-secondary hover:bg-my-layer-1-hover'
}

/** 状态字段 → Trellis 工作流入口。生命周期状态由 task.py 管理，面板不直接写
 *  task.json；可迁移的状态复制对应受控命令，无可命令的状态如实说明。 */
function stateWorkflow(dirName: string, stateId: string): { command?: string; hint: string } {
  switch (stateId) {
    case 'st-progress':
      return { command: `python .trellis/scripts/task.py start ${dirName}`, hint: '复制 start 命令' }
    case 'st-done':
      return { command: `python .trellis/scripts/task.py archive ${dirName}`, hint: '复制 archive 命令' }
    case 'st-planning':
    case 'st-backlog':
      return { hint: '任务创建后的初始状态，无命令' }
    case 'st-review':
      return { hint: '由项目流程推进，无受控命令' }
    default:
      return { hint: '由 Trellis 工作流管理' }
  }
}

/** 状态展示（列表行/表格单元格通用）：只读展示当前状态，下拉提供工作流入口，
 *  不再伪装可直接改状态——此前乐观更新会被落盘白名单静默回退。 */
function StateSelect({
  value,
  dirName,
  variant = 'bare',
  showChevron = true
}: {
  value: string
  dirName: string
  variant?: 'bare' | 'box'
  showChevron?: boolean
}): JSX.Element {
  const source = useWorkItemsSource()
  const { data, openIssue } = source.store
  const current = data.states.find((s) => s.id === value)
  const allowed = source.presentation?.stateIds?.(dirName)
  const states = data.states.filter((state) => !allowed || allowed.includes(state.id)).sort((a, b) => a.sequence - b.sequence)
  const native = source.kind === 'native'
  if (!native) {
    return (
      <button type="button" title="打开任务流程" onClick={(event) => { event.stopPropagation(); openIssue(dirName) }}
        className={clsx((variant === 'box' ? BOX_TRIGGER : BARE_TRIGGER).trigger, 'max-w-[150px]')}>
        <StateGroupIcon stateGroup={current?.group ?? 'backlog'} color={current?.color} size={variant === 'box' ? 14 : 12} />
        <span className="min-w-0 flex-1 truncate text-left">{current?.name ?? '无状态'}</span>
      </button>
    )
  }
  const copyCommand = (command: string): void => {
    void navigator.clipboard
      .writeText(command)
      .then(() => useApp.getState().pushToast({ kind: 'success', title: '已复制工作流命令', body: command }))
      .catch(() => undefined)
  }
  return (
    <Dropdown
      width={260}
      trigger={({ toggle }) => (
        <button
          type="button"
          title="状态由 Trellis 工作流管理，点开查看流程入口"
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
          <DropdownHeader>状态由 Trellis 工作流管理</DropdownHeader>
          {states.map((st) => {
            const flow = stateWorkflow(dirName, st.id)
            const isCurrent = st.id === value
            const suffix = isCurrent ? ' · 当前' : ` · ${flow.hint}`
            return (
              <DropdownItem
                key={st.id}
                selected={isCurrent}
                disabled={isCurrent || !flow.command}
                icon={<StateGroupIcon stateGroup={st.group} color={st.color} size={13} />}
                onClick={() => {
                  if (flow.command) copyCommand(flow.command)
                  close()
                }}
              >
                {st.name + suffix}
              </DropdownItem>
            )
          })}
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
  const source = useWorkItemsSource()
  return (
    <Dropdown
      width={180}
      trigger={({ toggle }) => (
        <button
          type="button"
          disabled={!canEditWorkItem(source, 'priority')}
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
  issueId,
  variant = 'bare'
}: {
  value: string | null
  members: Member[]
  onChange: (id: string | null) => void
  issueId?: string
  variant?: 'bare' | 'box'
}): JSX.Element {
  const source = useWorkItemsSource()
  const issue = source.store.data.issues.find((item) => item.id === issueId)
  const options = issueId ? source.presentation?.assigneeOptions?.(issueId) ?? members : members
  const ids = issue ? issueAssigneeIds(source, issue) : value ? [value] : []
  const current = members.find((m) => m.id === ids[0])
  const multiple = Boolean(issueId && source.presentation?.multiAssignee?.(issueId))
  return (
    <Dropdown
      width={200}
      trigger={({ toggle }) => (
        <button
          type="button"
          title={ids.map((id) => members.find((member) => member.id === id)?.name ?? id).join('、') || '未分配'}
          disabled={!canEditWorkItem(source, 'assigneeId', issueId)}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
          className={clsx((variant === 'box' ? BOX_TRIGGER : BARE_TRIGGER).trigger, variant === 'bare' && 'h-6')}
        >
          {issue ? <IssueAssignees issue={issue} size={variant === 'box' ? 18 : 20} /> : current ? (
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
            disabled={!canEditWorkItem(source, 'assigneeId', issueId)}
            selected={ids.length === 0}
            onClick={() => {
              if (issueId && source.setAssignees) void source.setAssignees(issueId, [])
              else onChange(null)
              close()
            }}
          >
            未分配
          </DropdownItem>
          {options.map((m) => (
            <DropdownItem
              key={m.id}
              disabled={!canEditWorkItem(source, 'assigneeId', issueId)}
              selected={ids.includes(m.id)}
              icon={<Avatar name={m.name} color={m.avatarColor} size={16} />}
              onClick={() => {
                if (issueId && source.setAssignees) {
                  void source.setAssignees(issueId, multiple ? ids.includes(m.id) ? ids.filter((id) => id !== m.id) : [...ids, m.id] : [m.id])
                } else onChange(m.id)
                if (!multiple) close()
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

function ListRow({ issue, ident, focused, rowIdx }: { issue: Issue; ident: string; focused?: boolean; rowIdx?: number }): JSX.Element {
  const source = useWorkItemsSource()
  const { data, openIssue, updateIssue, favorites, toggleFavorite } = useWorkItems()
  const isFav = favorites.includes(issue.id)
  const state = data.states.find((s) => s.id === issue.stateId)
  const assignee = data.members.find((m) => m.id === issue.assigneeId)
  const labels = issue.labelIds
    .map((id) => data.labels.find((l) => l.id === id))
    .filter((l): l is Label => Boolean(l))
  const done = state?.group === 'completed' || state?.group === 'cancelled'
  const sub = subProgress(issue, data.issues, data.states)
  return (
    <div
      role="button"
      tabIndex={-1}
      data-row-idx={rowIdx}
      onClick={() => openIssue(issue.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.defaultPrevented || e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          openIssue(issue.id)
        }
      }}
      className={clsx(
        'my-row group flex h-[44px] cursor-pointer items-center gap-2 border-b border-my-line px-3 hover:bg-my-layer-1',
        focused && 'bg-my-layer-1-selected'
      )}
    >
      <span className="my-row-handle select-none text-my-xs leading-none text-my-icon-tertiary">⠿</span>
      <span className="w-16 shrink-0 text-my-sm text-my-tertiary">
        {issueIdentifier(source, issue, ident)}
      </span>
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <PriorityIcon priority={issue.priority} size={12} />
      </span>
      <span className="flex w-[110px] shrink-0 items-center gap-1 overflow-hidden">
        {(labels.length > 0 ? labels : [pkgLabel(issue.pkg)].filter((l): l is Label => Boolean(l))).slice(0, 2).map((lb) => (
          <WorkItemLabel key={lb.id} label={lb} />
        ))}
      </span>
      <span className={clsx('my-item-title min-w-0 flex-1 truncate', done && 'opacity-60')}>{issue.name}</span>
      <SubProgressBadge done={sub.done} total={sub.total} />
      <IssueVersions issue={issue} />
      {issue.dueDate && state && <DueChip due={issue.dueDate} stateGroup={state.group} done={done} />}
      {/* 拦截键盘冒泡，避免下拉内按键触发行点击 */}
      <span onKeyDown={(e) => e.stopPropagation()} className="flex shrink-0 items-center">
        <StateSelect value={issue.stateId} dirName={issue.id} />
      </span>
      <button
        type="button"
        disabled={!source.capabilities.favorites}
        title={isFav ? '取消收藏' : '收藏'}
        onClick={(e) => {
          e.stopPropagation()
          toggleFavorite(issue.id)
        }}
        className={clsx(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded',
          isFav ? 'text-my-warning' : 'text-my-icon-tertiary opacity-0 group-hover:opacity-100 hover:text-my-warning'
        )}
      >
        <Star size={12} className={isFav ? 'fill-current' : ''} />
      </button>
      <span className="ml-1 flex shrink-0 items-center">
        <IssueAssignees issue={issue} />
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
  const source = useWorkItemsSource()
  const { openIssue } = useWorkItems()
  const [focusIdx, setFocusIdx] = useState(-1)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const shown = groups.filter((g) => g.meta.kind === 'none' || showEmpty || g.issues.length > 0)
  // 可见行 = 未折叠分组的行集合；偏移表用于渲染时标注全局行号
  let acc = 0
  const offsets = new Map<string, number>()
  for (const g of shown) {
    offsets.set(g.key, acc)
    const isCollapsed = g.meta.kind !== 'none' && collapsed.has(g.key)
    if (!isCollapsed) acc += g.issues.length
  }
  const rows = shown.flatMap((g) => (g.meta.kind !== 'none' && collapsed.has(g.key) ? [] : g.issues))
  useEffect(() => {
    if (focusIdx < 0) return
    containerRef.current?.querySelector(`[data-row-idx="${focusIdx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focusIdx])
  const onContainerKeyDown = (e: React.KeyboardEvent): void => {
    if (e.target !== e.currentTarget || e.defaultPrevented || e.nativeEvent.isComposing || e.keyCode === 229) return
    if (rows.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusIdx((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && focusIdx >= 0 && rows[focusIdx]) {
      e.preventDefault()
      openIssue(rows[focusIdx].id)
    }
  }
  if (shown.every((g) => g.issues.length === 0)) {
    return <EmptyState title="没有工作项" description="当前筛选与页签下没有匹配的工作项，调整条件或新建一个。" />
  }
  return (
    <div ref={containerRef} tabIndex={0} onKeyDown={onContainerKeyDown} className="my-scrollbar h-full overflow-y-auto outline-none">
      {shown.map((g) => {
        if (g.meta.kind === 'none') {
          return (
            <div key={g.key}>
              {g.issues.map((i, li) => (
                <ListRow key={i.id} issue={i} ident={ident} focused={li === focusIdx} rowIdx={li} />
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
                <span className="my-item-title truncate">{g.title}</span>
                <span className="shrink-0 text-my-xs text-my-tertiary">{g.issues.length}</span>
              </button>
              <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <Tooltip label="新建任务">
                  <button
                    type="button"
                    disabled={!source.capabilities.create}
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
              g.issues.map((i, li) => {
                const base = offsets.get(g.key) ?? 0
                return <ListRow key={i.id} issue={i} ident={ident} focused={base + li === focusIdx} rowIdx={base + li} />
              })}
          </section>
        )
      })}
    </div>
  )
}

/* ---------------- Board 布局 ---------------- */

function BoardCard({ issue, ident }: { issue: Issue; ident: string }): JSX.Element {
  const source = useWorkItemsSource()
  const { data, openIssue } = useWorkItems()
  const state = data.states.find((s) => s.id === issue.stateId)
  const assignee = data.members.find((m) => m.id === issue.assigneeId)
  const sub = subProgress(issue, data.issues, data.states)
  const labels = issue.labelIds
    .map((id) => data.labels.find((l) => l.id === id))
    .filter((l): l is Label => Boolean(l))
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={source.kind === 'native'}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/my-issue-id', issue.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => openIssue(issue.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.defaultPrevented || e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          openIssue(issue.id)
        }
      }}
      className="my-card mx-2.5 mb-1.5 cursor-grab p-2.5 active:cursor-grabbing"
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-[2px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <PriorityIcon priority={issue.priority} size={12} />
        </span>
        <span className="my-item-title line-clamp-2">{issue.name}</span>
      </div>
      <div className="mt-2 flex min-h-[18px] items-center gap-1.5">
        <span className="shrink-0 text-my-2xs text-my-disabled">{issueIdentifier(source, issue, ident)}</span>
        {(labels.length > 0 ? labels : [pkgLabel(issue.pkg)].filter((l): l is Label => Boolean(l))).slice(0, 2).map((lb) => (
          <WorkItemLabel key={lb.id} label={lb} />
        ))}
        <SubProgressBadge done={sub.done} total={sub.total} />
        <IssueVersions issue={issue} />
        {issue.dueDate && state && <DueChip due={issue.dueDate} stateGroup={state.group} />}
        <span className="ml-auto flex shrink-0 items-center">
          <IssueAssignees issue={issue} size={18} />
        </span>
      </div>
    </div>
  )
}

function BoardLayout({
  groups,
  collapsed,
  onToggleGroup,
  showEmpty,
  groupBy,
  onMoveToState,
  onMoveToCycle,
  ident
}: {
  groups: IssueGroup[]
  collapsed: Set<string>
  onToggleGroup: (key: string) => void
  showEmpty: boolean
  groupBy: GroupBy
  onMoveToState: (stateId: string, issueId: string) => void
  onMoveToCycle: (cycle: string, issueId: string) => void
  ident: string
}): JSX.Element {
  const source = useWorkItemsSource()
  const [dragOver, setDragOver] = useState<string | null>(null)
  const shown = groups.filter((g) => g.meta.kind === 'none' || showEmpty || g.issues.length > 0)
  if (shown.every((g) => g.issues.length === 0)) {
    return <EmptyState title="没有工作项" description="当前筛选与页签下没有匹配的工作项。" />
  }
  return (
    <div className="my-scrollbar flex h-full items-start overflow-x-auto">
      {shown.map((g) => {
        const isCollapsed = collapsed.has(g.key)
        return (
          <div
            key={g.key}
            onDragOver={(e) => {
              const droppable =
                source.kind === 'native' && ((groupBy === 'state' && g.meta.kind === 'state') ||
                (groupBy === 'cycle' && g.meta.kind === 'cycle' && canEditWorkItem(source, 'cycle')))
              if (!droppable) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDragOver(g.key)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(null)
              const issueId = e.dataTransfer.getData('text/my-issue-id')
              if (!issueId || !source.store.data.issues.some((issue) => issue.id === issueId)) return
              if (source.kind !== 'native') return
              if (groupBy === 'state' && g.meta.kind === 'state') onMoveToState(g.meta.state.id, issueId)
              else if (groupBy === 'cycle' && g.meta.kind === 'cycle') onMoveToCycle(g.meta.cycle || '', issueId)
            }}
            className={clsx(
              'flex w-[280px] min-w-[280px] shrink-0 flex-col',
              dragOver === g.key && 'bg-my-accent-subtle ring-1 ring-inset ring-my-line-accent'
            )}
          >
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
                <span className="my-item-title truncate">{g.title}</span>
                <span className="shrink-0 text-my-xs text-my-tertiary">{g.issues.length}</span>
              </button>
            </div>
            {!isCollapsed && (
              <div className="min-h-[80px]">
                {g.issues.map((i) => (
                  <BoardCard key={i.id} issue={i} ident={ident} />
                ))}
                {g.issues.length === 0 && (
                  <div className="mx-2.5 mt-2 rounded-my-md border border-dashed border-my-line py-5 text-center text-my-xs text-my-disabled">
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

const CELL_BARE = 'flex h-6 min-w-0 items-center gap-1 rounded px-1 text-my-sm text-my-secondary hover:bg-my-layer-1-hover'

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
  const source = useWorkItemsSource()
  const { data, openIssue, updateIssue } = useWorkItems()
  const state = data.states.find((s) => s.id === issue.stateId)
  const assignee = data.members.find((m) => m.id === issue.assigneeId)
  const subCount = issue.subIssueIds.length
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openIssue(issue.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.defaultPrevented || e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          openIssue(issue.id)
        }
      }}
      className="flex h-10 cursor-pointer items-center gap-2 border-b border-my-line px-3 hover:bg-my-layer-1"
    >
      {/* checkbox 列：阻止冒泡，不触发 peek */}
      <span className="flex w-8 shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={checked} onChange={(v) => onCheck(issue.id, v)} />
      </span>
      <span className="w-16 shrink-0 text-my-sm text-my-tertiary">
        {issueIdentifier(source, issue, ident)}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate text-my-md text-my-secondary">{issue.name}</span>
        <IssueVersions issue={issue} />
        {subCount > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-my-xs text-my-tertiary">
            <ListTree size={11} className="text-my-icon-tertiary" />
            {subCount}
          </span>
        )}
      </span>
      <span className="w-24 shrink-0" onClick={(e) => e.stopPropagation()}>
        <Dropdown
          width={170}
          trigger={({ toggle }) => (
            <button type="button" onClick={toggle} disabled={!canEditWorkItem(source, 'priority', issue.id)} className={CELL_BARE}>
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
                  disabled={!canEditWorkItem(source, 'priority', issue.id)}
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
        <StateSelect value={issue.stateId} dirName={issue.id} />
      </span>
      <span className="w-28 shrink-0" onClick={(e) => e.stopPropagation()}>
        <AssigneeSelect
          issueId={issue.id}
          value={issue.assigneeId}
          members={data.members}
          onChange={(mid) => updateIssue(issue.id, { assigneeId: mid })}
        />
      </span>
      <span className="w-24 shrink-0 truncate text-my-sm text-my-tertiary">{issue.startDate ? formatDate(issue.startDate) : '—'}</span>
      <span className="w-24 shrink-0 truncate text-my-sm">
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
  const source = useWorkItemsSource()
  const { data, updateIssue } = useWorkItems()
  const [checked, setChecked] = useState<Set<string>>(() => new Set<string>())
  const selected = [...checked].filter((id) => issues.some((issue) => issue.id === id))
  const applyBatch = async (patch: Partial<Issue>): Promise<void> => {
    for (const id of selected) {
      if (!Object.keys(patch).every((field) => canEditWorkItem(source, field as keyof Issue, id))) continue
      await updateIssue(id, patch)
    }
    setChecked(new Set())
  }
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
        <div className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-my-line bg-my-layer-1 px-3 text-my-xs font-medium text-my-tertiary">
          <span className={clsx(headCell, 'w-8 shrink-0')}>
            <Checkbox checked={allChecked} onChange={onCheckAll} />
          </span>
          <span className="w-16 shrink-0">ID</span>
          <span className="min-w-0 flex-1">名称</span>
          <span className="w-24 shrink-0">优先级</span>
          <span className="w-32 shrink-0">状态</span>
          <span className="w-28 shrink-0">负责人</span>
          <span className="w-24 shrink-0">{source.presentation?.startDateLabel ?? '开始'}</span>
          <span className="w-24 shrink-0">{source.presentation?.dueDateLabel ?? '截止'}</span>
        </div>
        {issues.map((i) => (
          <SpreadsheetRow key={i.id} issue={i} ident={ident} checked={checked.has(i.id)} onCheck={onCheck} />
        ))}
      </div>
      {selected.length > 0 && (
        <div className="fixed bottom-8 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-my-lg border border-my-line bg-my-layer-2 px-3 py-2 shadow-[var(--my-shadow-overlay-200)]">
          <span className="text-my-sm text-my-secondary">已选 {selected.length} 项</span>
          {/* 批量状态不提供：生命周期状态由 Trellis 工作流逐任务管理（F01 同源），批量写入本就是缓议的受控命令 */}
          <Dropdown
            width={170}
            align="right"
            trigger={({ toggle }) => (
              <Button variant="neutral" size="sm" onClick={toggle} disabled={!canEditWorkItem(source, 'priority') || selected.some((id) => !canEditWorkItem(source, 'priority', id))}>
                设为优先级
              </Button>
            )}
          >
            {(close) => (
              <>
                {PRIORITIES.map((pr) => (
                  <DropdownItem
                    key={pr}
                    disabled={selected.some((id) => !canEditWorkItem(source, 'priority', id))}
                    icon={<PriorityIcon priority={pr} size={13} />}
                    onClick={() => {
                      void applyBatch({ priority: pr })
                      close()
                    }}
                  >
                    {PRIORITY_LABELS[pr]}
                  </DropdownItem>
                ))}
              </>
            )}
          </Dropdown>
          <Button variant="ghost" size="sm" onClick={() => setChecked(new Set())}>
            取消选择
          </Button>
        </div>
      )}
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
  const source = useWorkItemsSource()
  const { data, openIssue } = useWorkItems()
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
            className="sticky left-0 z-10 flex w-[300px] shrink-0 items-center border-r border-my-line px-3 text-my-xs font-medium text-my-tertiary"
            style={{ width: GANTT_LEFT }}
          >
            工作项{source.presentation?.cycleMode === 'version' ? ' · 版本排期' : ''}
          </div>
          {days.map((d, i) => {
            const isToday = i === todayIdx
            const isWeekStart = i % 7 === 0
            return (
              <div
                key={toIso(d)}
                style={{ width: GANTT_COL }}
                className={clsx(
                  'flex shrink-0 items-center justify-center border-r border-my-line text-my-2xs',
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
                  <button type="button" onClick={() => openIssue(issue.id)} className="min-w-0 truncate text-left text-my-sm text-my-secondary">{issue.name}</button>
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
  const source = useWorkItemsSource()
  const { openIssue, data } = useWorkItems()
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
        <span className="mr-2 text-my-md font-medium text-my-primary">
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
        {source.presentation?.cycleMode === 'version' && <span className="ml-auto text-my-xs text-my-tertiary">版本截止</span>}
      </div>
      <div className="grid shrink-0 grid-cols-7 border-l border-t border-my-line">
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="flex h-8 items-center justify-center border-b border-r border-my-line bg-my-layer-1 text-my-xs font-medium text-my-tertiary"
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
                  'inline-flex h-5 min-w-5 items-center justify-end self-end rounded-my-md px-1 text-my-xs',
                  isToday
                    ? 'bg-my-accent font-medium text-my-on-accent'
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
                    className="flex h-[20px] w-full items-center gap-1 rounded-my-sm border border-my-line bg-my-layer-2 px-1 text-left hover:bg-my-layer-1-hover"
                  >
                    {st && <StateGroupIcon stateGroup={st.group} color={st.color} size={10} />}
                    <span className="min-w-0 truncate text-my-xs text-my-secondary">{issue.name}</span>
                  </button>
                )
              })}
              {rest > 0 && <span className="pl-0.5 text-my-2xs text-my-tertiary">还有 {rest} 项</span>}
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
    <DropdownItem selected={checked} icon={icon} onClick={onToggle}>
      {label}
    </DropdownItem>
  )
}

/* ---------------- 保存视图表单 ---------------- */

function SaveViewBody({ onSave }: { onSave: (name: string) => void }): JSX.Element {
  const [name, setName] = useState('')
  const submit = (): void => {
    const n = name.trim()
    if (!n) return
    onSave(n)
  }
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div className="text-my-xs text-my-tertiary">保存当前筛选与分组，稍后在项目侧边栏「视图」区一键应用。</div>
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.defaultPrevented || e.nativeEvent.isComposing || e.keyCode === 229 || e.key !== 'Enter') return
          e.preventDefault()
          e.stopPropagation()
          submit()
        }}
        placeholder="视图名称，如：我的紧急项"
        className="my-input h-8"
      />
      <Button variant="primary" size="sm" onClick={submit} disabled={!name.trim()}>
        保存视图
      </Button>
    </div>
  )
}

/* ---------------- 页面 ---------------- */

function WorkItemsPageInner(): JSX.Element {
  const source = useWorkItemsSource()
  const store = useWorkItems()
  const { data, layout, groupBy, orderBy, filters, display, workItemsView, workItemsTab: tab, setWorkItemsTab: setTab } = store
  const project = data.projects[0]
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
  const projectId = source.projectId === undefined ? project?.id : source.projectId
  const projectIssues = projectId === null ? data.issues : data.issues.filter((i) => i.projectId === projectId)
  const filtered = projectIssues.filter((issue) => {
    if (filters.priority.length && !filters.priority.includes(issue.priority)) return false
    const state = stateOf(issue.stateId)
    if (filters.stateGroup.length && state && !filters.stateGroup.includes(state.group)) return false
    if (filters.assigneeIds.length && !issueAssigneeIds(source, issue).some((id) => filters.assigneeIds.includes(id))) return false
    if (filters.labelIds.length && (source.kind === 'native'
      ? !issue.labelIds.some((id) => filters.labelIds.includes(id))
      : !filters.labelIds.every((id) => issue.labelIds.includes(id)))) return false
    return true
  })
  const visible = display.showSubIssues ? filtered : filtered.filter((i) => i.parentId === null)
  const tabbed = visible.filter((i) => {
    if (source.presentation?.matchesTab) return source.presentation.matchesTab(i, tab)
    if (tab === 'all') return true
    const g = stateOf(i.stateId)?.group
    if (tab === 'active') return g === 'unstarted' || g === 'started'
    return g === 'backlog'
  })
  const countIn = (predicate: (g: StateGroup | undefined) => boolean): number =>
    visible.filter((i) => predicate(stateOf(i.stateId)?.group)).length
  const tabs: Array<{ id: IssueTab; label: string; count?: number }> = source.presentation?.tabs?.map((item) => ({
    ...item,
    count: visible.filter((issue) => source.presentation?.matchesTab?.(issue, item.id) ?? true).length
  })) ?? [
    { id: 'all', label: '不限', count: visible.length },
    { id: 'active', label: '待推进', count: countIn((g) => g === 'unstarted' || g === 'started') },
    { id: 'backlog', label: '未规划', count: countIn((g) => g === 'backlog') }
  ]

  // 周期概览：当前周完成进度与 7 日完成分布（仅按周期分组时展示）
  const thisWeek = currentWeekKey()
  const carryOver = (): void => {
    const stale = tabbed.filter((i) => i.cycle === thisWeek)
    const open = stale.filter((i) => {
      const g = stateOf(i.stateId)?.group
      return g !== 'completed' && g !== 'cancelled'
    })
    for (const i of open) void store.updateIssue(i.id, { cycle: nextWeekKey() })
  }

  const groups = buildGroups(tabbed, groupBy, orderBy, data.states, data.members, data.labels, source)
  const filterCount = filters.priority.length + filters.stateGroup.length + filters.assigneeIds.length + filters.labelIds.length + (source.presentation?.additionalFilterCount ?? 0)
  const ident = (project?.id ?? '').replace(/^p-/, '').slice(0, 3).toUpperCase()

  // 周期概览条：本周有任务显示进度与完成分布；空周给出「一键排入本周」引导
  let cycleOverview: JSX.Element | null = null
  if (groupBy === 'cycle' && source.kind === 'native') {
    const weekIssues = tabbed.filter((i) => i.cycle === thisWeek)
    const unplanned = tabbed.filter((i) => {
      if (i.cycle) return false
      const g = stateOf(i.stateId)?.group
      return g !== 'completed' && g !== 'cancelled'
    })
    const planIntoWeek = async (): Promise<void> => {
      for (const i of unplanned) await store.updateIssue(i.id, { cycle: thisWeek })
    }
    const doneByDay = Array.from({ length: 7 }, (_, di) => {
      const day = new Date()
      day.setHours(0, 0, 0, 0)
      day.setDate(day.getDate() - ((day.getDay() + 6) % 7) + di)
      const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      return { iso, label: day.getDate(), count: weekIssues.filter((i) => i.completedAt === iso).length }
    })
    const done = weekIssues.filter((i) => i.completedAt).length
    const total = Math.max(weekIssues.length, 1)
    const maxDay = Math.max(1, ...doneByDay.map((d) => d.count))
    cycleOverview = (
      <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-my-line bg-my-layer-1 px-my-page py-2.5">
        <span className="flex items-center gap-1.5 text-my-sm font-medium text-my-primary">
          <Calendar size={13} className="text-my-icon-secondary" />
          本周 {isoWeekRangeTitle(thisWeek)}
        </span>
        {weekIssues.length === 0 ? (
          <>
            <span className="text-my-sm text-my-tertiary">本周暂未安排工作项</span>
            {unplanned.length > 0 && (
              <Button variant="primary" size="sm" onClick={() => void planIntoWeek()}>
                把 {unplanned.length} 个未完结项排入本周
              </Button>
            )}
            {unplanned.length === 0 && (
              <span className="text-my-sm text-my-disabled">拖拽工作项到「本周」列即可排期</span>
            )}
          </>
        ) : (
          <>
            <span className="text-my-sm text-my-tertiary">
              {done}/{weekIssues.length} 已完成
            </span>
            <div className="flex h-1.5 w-40 overflow-hidden rounded-full bg-my-layer-3">
              <div style={{ width: `${(done / total) * 100}%` }} className="bg-my-success" />
            </div>
            {unplanned.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => void planIntoWeek()}>
                + 排入 {unplanned.length} 项
              </Button>
            )}
            <div className="ml-auto flex items-end gap-1" title="按日完成分布">
              {doneByDay.map((d, i) => (
                <div key={d.iso} className="flex flex-col items-center gap-0.5">
                  <div
                    style={{ height: 4 + (d.count / maxDay) * 16 }}
                    className={clsx('w-3 rounded-sm', d.count > 0 ? 'bg-my-success' : 'bg-my-layer-3')}
                  />
                  <span className="text-my-2xs leading-none text-my-disabled">{d.label}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    )
  }

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
      <BoardLayout
        groups={groups}
        collapsed={collapsed}
        onToggleGroup={toggleGroup}
        showEmpty={display.showEmptyGroups}
        groupBy={groupBy}
        ident={ident}
        onMoveToState={(stateId, issueId) => {
          if (source.kind !== 'native') {
            return
          }
          // 拖到目标状态列 = 提供该状态的工作流入口（复制受控命令）；
          // 不再伪装本地改状态——落盘白名单会静默回退（F01）。
          const flow = stateWorkflow(issueId, stateId)
          const target = data.states.find((s) => s.id === stateId)?.name ?? stateId
          if (flow.command) {
            void navigator.clipboard.writeText(flow.command)
              .then(() => useApp.getState().pushToast({ kind: 'success', title: `已复制「${target}」的工作流命令`, body: flow.command }))
              .catch(() => undefined)
          } else {
            useApp.getState().pushToast({ kind: 'info', title: `「${target}」无受控命令`, body: `${flow.hint}；状态由 Trellis 工作流管理` })
          }
        }}
        onMoveToCycle={(cycle, issueId) => void store.updateIssue(issueId, { cycle: cycle || null })}
      />
    )
  } else if (layout === 'spreadsheet') {
    body = <SpreadsheetLayout issues={tabbed} ident={ident} />
  } else if (layout === 'gantt') {
    body = <GanttLayout issues={tabbed} />
  } else {
    body = <CalendarLayout issues={tabbed} />
  }

  return (
    <PageLayout variant={PAGE_LAYOUTS.tasks}>
      <PageHeader className="my-work-items-header">
        <h1 className="shrink-0 text-my-md font-semibold text-my-primary">{source.presentation?.title ?? (workItemsView === 'iterations' ? '迭代' : '全部')}</h1>
        <Tabs tabs={tabs} active={tab} onChange={setTab} />
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          {/* 布局切换器 */}
          <div className="my-segmented" role="group" aria-label="工作项布局">
            {LAYOUTS.map((l) => (
              <Tooltip key={l.id} label={l.label} side="bottom">
                <button
                  type="button"
                  aria-label={`布局：${l.label}`}
                  aria-pressed={layout === l.id}
                  title={l.label}
                  onClick={() => store.setLayout(l.id)}
                  className={clsx(
                    'my-segment',
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
                筛选
                {filterCount > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-my-md bg-my-accent px-1 text-my-2xs font-medium text-my-on-accent">
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
                {/* 无标签数据时隐藏该筛选段 */}
                {data.labels.length > 0 && (
                  <>
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
                  </>
                )}
                {source.presentation?.filterContent}
                {filterCount > 0 && (
                  <div className="mt-1 border-t border-my-line pt-1">
                    <DropdownItem onClick={() => store.clearFilters()}>清除筛选</DropdownItem>
                  </div>
                )}
              </>
            )}
          </Dropdown>
          {groupBy === 'cycle' && source.kind === 'native' && (
            <Tooltip label="当前周未完结项移入下一周">
              <Button variant="neutral" onClick={carryOver}>
                结转未完成
              </Button>
            </Tooltip>
          )}
          {/* 存为视图：保存当前筛选+分组，项目侧边栏「视图」区可应用 */}
          <Dropdown
            width={230}
            align="right"
            trigger={({ toggle }) => (
              <Button variant="neutral" onClick={toggle} disabled={!source.capabilities.saveView} title={!source.capabilities.saveView ? '当前范围或分组不支持保存视图' : undefined}>
                <Bookmark size={13} className="text-my-icon-secondary" />
                存为视图
              </Button>
            )}
          >
            {(close) => (
              <SaveViewBody
                onSave={(name) => {
                  store.saveView(name, filters, groupBy)
                  close()
                }}
              />
            )}
          </Dropdown>
          {/* Display 下拉：布局/分组/排序/显示 */}
          <Dropdown
            width={210}
            align="right"
            trigger={({ toggle }) => (
              <Button variant="neutral" onClick={toggle}>
                <Settings2 size={13} className="text-my-icon-secondary" />
                显示
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
                    onClick={() => store.setLayout(l.id)}
                  >
                    {l.label}
                  </DropdownItem>
                ))}
                <DropdownHeader>分组</DropdownHeader>
                {/* 无标签数据时不提供标签分组维度 */}
                {GROUP_BY_OPTIONS.filter((o) => (o.id !== 'labels' || data.labels.length > 0) && (workItemsView !== 'iterations' || o.id === 'cycle')).map((o) => (
                  <DropdownItem
                    key={o.id}
                    selected={groupBy === o.id}
                    onClick={() => store.setGroupBy(o.id)}
                  >
                    {o.id === 'cycle' && source.presentation?.cycleMode === 'version' ? '版本' : o.id === 'package' && source.kind === 'collaboration' ? '专项' : o.label}
                  </DropdownItem>
                ))}
                <DropdownHeader>排序</DropdownHeader>
                {ORDER_BY_OPTIONS.map((o) => (
                  <DropdownItem
                    key={o.id}
                    selected={orderBy === o.id}
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
                  <span className="text-my-sm text-my-secondary">显示空分组</span>
                </div>
                <div className="flex w-full items-center gap-2 px-3 py-1.5">
                  <Checkbox checked={display.showSubIssues} onChange={(v) => store.setDisplay({ showSubIssues: v })} />
                  <span className="text-my-sm text-my-secondary">显示子工作项</span>
                </div>
              </>
            )}
          </Dropdown>
          {/* 主按钮 */}
          <Button variant="primary" disabled={!source.capabilities.create} onClick={() => store.setCreateIssueOpen(true)}>
            <Plus size={13} />
            新建任务
          </Button>
        </div>
      </PageHeader>
      {cycleOverview}
      {/* 布局主体 */}
      <div className="min-h-0 flex-1 bg-my-surface-1">{body}</div>
    </PageLayout>
  )
}

function NativeWorkItemsPage(): JSX.Element {
  const store = useMy()
  const source: WorkItemsSource = {
    key: store.projectRoot ?? 'native-preview',
    kind: 'native',
    store,
    capabilities: { editableFields: ['priority', 'assigneeId', 'cycle'], create: true, favorites: true, saveView: true }
  }
  return <WorkItemsProvider value={source}><WorkItemsPageInner /></WorkItemsProvider>
}

export function WorkItemsPage({ source }: { source?: WorkItemsSource } = {}): JSX.Element {
  return source
    ? <WorkItemsProvider key={source.key} value={source}><WorkItemsPageInner /></WorkItemsProvider>
    : <NativeWorkItemsPage />
}

export default WorkItemsPage
