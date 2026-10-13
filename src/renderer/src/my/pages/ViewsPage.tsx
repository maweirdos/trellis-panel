// 视图页：已存视图卡片（名称 / 描述 / 筛选摘要 chips / 创建者）；
// 选中视图进入详情（面包屑返回 + filterIssues 过滤后按状态分组的看板，本文件内定义局部 BoardColumn 复用）。
import { type JSX } from 'react'
import { ArrowLeft, Plus } from 'lucide-react'
import { useMy, filterIssues } from '../store'
import { Avatar, Button, EmptyState, Tooltip } from '../ui'
import { NavIcon, WorkspaceMark, PriorityIcon, StateGroupIcon } from '../icons'
import type { Issue, IssueFilters, Label, Member, Priority, SavedView, StateGroup, WorkItemState } from '../types'

/* ---------------- 常量 ---------------- */

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
  none: '无'
}

const GROUP_LABELS: Record<StateGroup, string> = {
  backlog: 'Backlog',
  unstarted: '未开始',
  started: '进行中',
  completed: '已完成',
  cancelled: '已取消'
}

/* ---------------- 筛选摘要 ---------------- */

/** 由 view.filters 生成中文摘要 chips 文本 */
function filterChipTexts(view: SavedView, members: Member[], labels: Label[]): string[] {
  const chips: string[] = []
  const f = view.filters
  if (f.priority !== undefined && f.priority.length > 0) {
    chips.push(`优先级: ${f.priority.map((p) => PRIORITY_LABELS[p]).join('、')}`)
  }
  if (f.stateGroup !== undefined && f.stateGroup.length > 0) {
    chips.push(`状态组: ${f.stateGroup.map((g) => GROUP_LABELS[g]).join('、')}`)
  }
  if (f.assigneeIds !== undefined && f.assigneeIds.length > 0) {
    const names = f.assigneeIds.map((id) => members.find((m) => m.id === id)?.name ?? id)
    chips.push(`负责人: ${names.join('、')}`)
  }
  if (f.labelIds !== undefined && f.labelIds.length > 0) {
    const names = f.labelIds.map((id) => labels.find((l) => l.id === id)?.name ?? id)
    chips.push(`标签: ${names.join('、')}`)
  }
  return chips
}

/** SavedView 的部分筛选 → 完整 IssueFilters（缺省段为空数组=不过滤） */
function toIssueFilters(view: SavedView): IssueFilters {
  return {
    priority: view.filters.priority ?? [],
    stateGroup: view.filters.stateGroup ?? [],
    assigneeIds: view.filters.assigneeIds ?? [],
    labelIds: view.filters.labelIds ?? []
  }
}

/* ---------------- 小件 ---------------- */

function Chip({ children }: { children: string }): JSX.Element {
  return (
    <span className="inline-flex h-[20px] shrink-0 items-center rounded-[4px] bg-my-layer-3 px-1.5 text-[11px] font-medium text-my-tertiary">
      {children}
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

/* ---------------- 视图卡片 ---------------- */

function ViewCard({
  view,
  members,
  labels,
  onSelect
}: {
  view: SavedView
  members: Member[]
  labels: Label[]
  onSelect: (id: string) => void
}): JSX.Element {
  const chips = filterChipTexts(view, members, labels)
  const owner = members.find((m) => m.id === view.ownedById) ?? null
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => onSelect(view.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(view.id)
        }
      }}
      className="my-card cursor-pointer p-3"
    >
      <div className="flex items-center gap-2">
        <NavIcon name="views" size={14} className="shrink-0 text-my-icon-tertiary" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-my-primary">{view.name}</span>
      </div>
      {view.description !== '' && <p className="mt-1.5 truncate text-[12px] text-my-tertiary">{view.description}</p>}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {chips.map((text) => (
          <Chip key={text}>{text}</Chip>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-1.5">
        {owner ? <Avatar name={owner.name} color={owner.avatarColor} size={16} /> : null}
        <span className="text-[11px] text-my-tertiary">{owner ? `${owner.name} 创建` : '未知创建者'}</span>
      </div>
    </article>
  )
}

/* ---------------- 局部看板列（按状态分组） ---------------- */

function BoardColumn({
  state,
  issues,
  members,
  onOpen
}: {
  state: WorkItemState
  issues: Issue[]
  members: Member[]
  onOpen: (id: string) => void
}): JSX.Element {
  return (
    <div className="flex w-[248px] shrink-0 flex-col rounded-lg border border-my-line bg-my-layer-1">
      <div className="flex h-9 items-center gap-1.5 border-b border-my-line px-3">
        <StateGroupIcon stateGroup={state.group} color={state.color} size={14} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-my-secondary">{state.name}</span>
        <span className="text-[11px] text-my-tertiary">{issues.length}</span>
      </div>
      <div className="flex flex-col gap-1.5 p-2">
        {issues.map((issue) => {
          const assignee = issue.assigneeId === null ? null : (members.find((m) => m.id === issue.assigneeId) ?? null)
          return (
            <div
              key={issue.id}
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
        })}
        {issues.length === 0 && (
          <div className="rounded-md border border-dashed border-my-line py-4 text-center text-[11px] text-my-disabled">
            暂无工作项
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- 视图详情 ---------------- */

function ViewDetail({ view }: { view: SavedView }): JSX.Element {
  const data = useMy((s) => s.data)
  const setSelectedView = useMy((s) => s.setSelectedView)
  const openIssue = useMy((s) => s.openIssue)

  const matched = filterIssues(
    data.issues.filter((i) => i.projectId === view.projectId),
    toIssueFilters(view)
  )
  const chips = filterChipTexts(view, data.members, data.labels)
  const owner = data.members.find((m) => m.id === view.ownedById) ?? null

  return (
    <div className="flex h-full min-h-0 flex-col bg-my-canvas">
      {/* 详情顶栏：返回 + 面包屑 */}
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-my-line bg-my-canvas px-4">
        <Tooltip label="返回视图列表">
          <button
            type="button"
            onClick={() => setSelectedView(null)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-my-icon-secondary hover:bg-my-layer-1-hover"
          >
            <ArrowLeft size={14} />
          </button>
        </Tooltip>
        <NavIcon name="views" size={14} className="text-my-icon-tertiary" />
        <span className="shrink-0 text-[13px] text-my-tertiary">Views</span>
        <span className="text-my-disabled">/</span>
        <span className="min-w-0 truncate text-[13px] font-medium text-my-primary">{view.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] text-my-tertiary">
          {owner ? <Avatar name={owner.name} color={owner.avatarColor} size={16} /> : null}
          {owner ? owner.name : ''}
        </span>
      </header>

      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        {/* 筛选摘要与命中数 */}
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((text) => (
            <Chip key={text}>{text}</Chip>
          ))}
          <span className="text-[12px] text-my-tertiary">共 {matched.length} 项工作项</span>
        </div>

        {/* 过滤后的状态看板 */}
        <div className="mt-4 my-scrollbar overflow-x-auto pb-2">
          <div className="flex items-start gap-3">
            {data.states.map((st) => (
              <BoardColumn
                key={st.id}
                state={st}
                issues={matched.filter((i) => i.stateId === st.id)}
                members={data.members}
                onOpen={(id) => openIssue(id)}
              />
            ))}
          </div>
        </div>
        {matched.length === 0 && (
          <EmptyState title="没有匹配的工作项" description="当前视图的筛选条件下没有工作项。" />
        )}
      </div>
    </div>
  )
}

/* ---------------- 页面入口 ---------------- */

export function ViewsPage(): JSX.Element {
  const data = useMy((s) => s.data)
  const activeProjectId = useMy((s) => s.activeProjectId)
  const selectedViewId = useMy((s) => s.selectedViewId)
  const setSelectedView = useMy((s) => s.setSelectedView)

  const project = data.projects.find((p) => p.id === activeProjectId) ?? data.projects[0]
  const projectViews = data.views.filter((v) => v.projectId === project.id)
  const selected =
    selectedViewId === null
      ? null
      : (data.views.find((v) => v.id === selectedViewId && v.projectId === project.id) ?? null)

  // 选中视图：整页切换为详情
  if (selected) {
    return <ViewDetail view={selected} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-my-canvas">
      {/* 顶栏 52px：面包屑 + 新建 */}
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-my-line bg-my-canvas px-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <WorkspaceMark color={project.color} letter={project.icon} size={16} />
          <span className="truncate text-[13px] font-medium text-my-primary">{project.name}</span>
          <span className="text-my-disabled">/</span>
          <NavIcon name="views" size={14} className="text-my-icon-tertiary" />
          <span className="shrink-0 text-[13px] text-my-tertiary">Views</span>
        </div>
        <span className="text-[12px] text-my-tertiary">{projectViews.length} 个视图</span>
        <div className="ml-auto flex shrink-0 items-center">
          <Button variant="primary" disabled title="演示模式，暂不支持新建视图">
            <Plus size={13} />
            New view
          </Button>
        </div>
      </header>

      {/* 视图卡片网格（两列） */}
      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        {projectViews.length === 0 ? (
          <EmptyState title="暂无视图" description="为该项目创建第一个已存视图。" />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {projectViews.map((v) => (
              <ViewCard
                key={v.id}
                view={v}
                members={data.members}
                labels={data.labels}
                onSelect={(id) => setSelectedView(id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
