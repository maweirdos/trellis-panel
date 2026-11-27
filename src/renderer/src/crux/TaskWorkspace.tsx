import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { clsx } from 'clsx'
import { Bot, ChevronDown } from 'lucide-react'
import type { CruxSnapshot, CruxTask, CruxTaskPatchInput, CruxViewFilter } from '@shared/crux'
import { getCruxLightweightTaskCapabilities } from '@shared/crux-domain/lightweight'
import { api, hasIpc } from '../api'
import { useMy } from '../my/store'
import { useApp } from '../store'
import { WorkItemsPage } from '../my/pages/WorkItemsPage'
import type { WorkItemsSource, WorkItemsStore } from '../my/pages/work-items/work-items-context'
import type { GroupBy, Issue, IssueFilters, OrderBy, StateGroup, WorkItemLayout } from '../my/types'
import { Button, Dropdown, DropdownHeader, DropdownItem, EmptyState, LabelPill, SearchInput } from '../my/ui'
import { PageToolbar } from '../my/layout/PageLayout'
import { useInteractionGuard } from '../utils/interaction-scope'
import { resolveAllowedTargetStatusIds, useCollaborationPlatform } from './collaboration-platform-store'
import { applyTaskFilter, statusDisplayName, useCrux, type CruxTaskFilterState } from './store'
import { isActiveRunStatus, RUN_STATUS_META, useTaskRuns } from './task-run-store'
import { LabelChip } from './ui'
import { TaskOutputReviewBoardBadge } from './task-output-review/task-output-review'
import { deriveTaskWorkspaceDataset, CRUX_STATE_GROUPS } from './task-workspace-adapter'
import { MyNextSteps } from './cockpit/MyNextSteps'
import { EmbeddedTaskPost } from './pages/TaskDetailDrawer'
import { taskSourceKey } from './pages/task-detail/use-task-source'
import { captureScrollPositions, restoreScrollPositions } from './development/context'
import type { TaskListLocation } from './development/types'

export interface TaskWorkspaceProps {
  scope: 'space' | 'mine' | 'triage'
  iterationId?: string
  taskIds?: readonly string[]
  /** Initial layout; subsequent choices belong to this collaboration source. */
  layout?: WorkItemLayout
}
const TASK_LAYOUT_SOURCE_KEYS = new Set(['mine', 'space', 'triage'])

export type PersonalTaskRelation = 'assigned' | 'created' | 'involved' | 'followed'

const PERSONAL_RELATIONS: ReadonlyArray<{ id: PersonalTaskRelation; label: string }> = [
  { id: 'assigned', label: '我负责' }, { id: 'created', label: '我发起' },
  { id: 'involved', label: '我参与' }, { id: 'followed', label: '我关注' }
]

const PERSONAL_STATUSES: ReadonlyArray<{ id: string; label: string; groups: StateGroup[] }> = [
  { id: 'all', label: '全部状态', groups: [] },
  { id: 'open', label: '未完成', groups: ['backlog', 'unstarted', 'started'] },
  { id: 'completed', label: '已完成', groups: ['completed'] }
]

/** Relations describe actual task facts, independently of completion or scheduling. */
export function matchesPersonalTaskRelation(snapshot: CruxSnapshot, task: CruxTask, actorId: string | null, relation: PersonalTaskRelation): boolean {
  if (!actorId) return false
  const handling = task.workflow?.handlerId ? task.workflow.handlerId === actorId : task.assigneeIds.includes(actorId)
  if (relation === 'assigned') return handling
  if (relation === 'created') return task.creatorId === actorId
  if (relation === 'followed') return task.followerIds.includes(actorId)
  const crew = task.executor?.kind === 'crew' ? snapshot.crews.find((item) => item.id === task.executor?.id && item.spaceId === task.spaceId) : undefined
  return handling || task.assigneeIds.includes(actorId) || task.creatorId === actorId ||
    Boolean(crew && [crew.captain, ...crew.members].some((member) => member.kind === 'member' && member.id === actorId)) ||
    Boolean(task.workflow?.history.some((event) => event.actorId === actorId || event.assigneeId === actorId)) ||
    snapshot.comments.some((comment) => comment.taskId === task.id && comment.authorId === actorId)
}

function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

/** All five layouts, filters, display controls and bulk selection come from WorkItemsPage. */
export function TaskWorkspace({ scope, layout, iterationId, taskIds }: TaskWorkspaceProps): JSX.Element {
  const context = useCrux((state) => state.workspaceContext)
  const actorId = useCrux((state) => state.workspaceContext.actorId ?? (state.workspaceContext.state === 'local' ? state.snapshot?.members.find((member) => member.role === 'owner')?.id : null))
  const spaceId = useCrux((state) => state.currentSpaceId)
  const owner = useRef({ mounted: false, generation: 0 })
  const [generation, setGeneration] = useState(0)
  useLayoutEffect(() => {
    owner.current.mounted = true
    const invalidate = (): void => { owner.current.generation++; setGeneration(owner.current.generation) }
    const identity = (state: ReturnType<typeof useCrux.getState>): string => JSON.stringify([
      state.workspaceContext.key, state.workspaceContext.actorId, state.workspaceContext.instanceId, state.workspaceContext.epoch,
      state.workspaceContext.state === 'access-revoked', Boolean(state.snapshot), state.module,
      scope === 'mine' ? null : state.currentSpaceId
    ])
    const offWorkspace = useCrux.subscribe((next, previous) => { if (identity(next) !== identity(previous)) invalidate() })
    const offPage = useApp.subscribe((next, previous) => {
      if (next.page !== previous.page || next.page === 'tasks' && (next.personalTaskSource !== previous.personalTaskSource || Boolean(next.openTaskDir) !== Boolean(previous.openTaskDir))) invalidate()
    })
    return () => { owner.current.mounted = false; offWorkspace(); offPage() }
  }, [scope])
  const ownsSurface = (): boolean => owner.current.mounted && owner.current.generation === generation
  return <TaskWorkspaceSource key={`${context.key}:${context.instanceId ?? ''}:${context.epoch ?? ''}:${actorId ?? ''}:${scope}:${scope === 'mine' ? '' : spaceId ?? ''}:${iterationId ?? ''}:${generation}`} ownsSurface={ownsSurface} scope={scope} layout={layout} iterationId={iterationId} taskIds={taskIds} />
}

function TaskWorkspaceSource({ scope, layout: initialLayout = 'list', iterationId, taskIds, ownsSurface }: TaskWorkspaceProps & { ownsSurface: () => boolean }): JSX.Element {
  const state = useCrux()
  const { snapshot, workspaceContext, currentSpaceId, busy, activeViewId } = state
  const typeWorkflows = useCollaborationPlatform((platform) => platform.typeWorkflows)
  const platformFavorites = useCollaborationPlatform((platform) => platform.favorites)
  const togglePlatformFavorite = useCollaborationPlatform((platform) => platform.toggleFavorite)
  const runs = useTaskRuns((runState) => runState.runs)
  const usesGlobalFilter = scope === 'space' && !iterationId
  const sourceIdentity = snapshot ? taskSourceKey(snapshot, workspaceContext) : ''
  const locationKey = JSON.stringify([sourceIdentity, state.module, scope, scope === 'mine' ? null : currentSpaceId, iterationId, taskIds])
  const [savedLocation] = useState(() => state.taskWorkspaceLocations[locationKey])
  const locationRoot = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<WorkItemLayout>(savedLocation?.layout ?? initialLayout)
  const [groupBy, setGroupBy] = useState<GroupBy>(savedLocation?.groupBy ?? 'state')
  const [orderBy, setOrderBy] = useState<OrderBy>(savedLocation?.orderBy ?? 'priority')
  const [display, setDisplay] = useState(savedLocation?.display ?? { showEmptyGroups: false, showSubIssues: true })
  const [tab, setTab] = useState<WorkItemsStore['workItemsTab']>(savedLocation?.tab ?? 'all')
  const [stateGroups, setStateGroups] = useState<StateGroup[]>(() => savedLocation?.stateGroups ?? (scope === 'mine' ? ['backlog', 'unstarted', 'started'] : []))
  const [sourceFilter, setSourceFilter] = useState<CruxTaskFilterState>(savedLocation?.sourceFilter ?? {})
  const favorites = useMemo(
    () => platformFavorites.filter((item) => item.kind === 'task').map((item) => item.id),
    [platformFavorites]
  )
  const [relation, setRelation] = useState<PersonalTaskRelation>(savedLocation?.relation ?? 'assigned')
  const [personalSpaceId, setPersonalSpaceId] = useState<string | null>(savedLocation?.personalSpaceId ?? null)
  const mounted = useRef(true)
  const canInteract = useInteractionGuard()
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (!savedLocation) setLayout(initialLayout) }, [initialLayout])
  const restoredView = useRef(Boolean(savedLocation))
  useEffect(() => {
    if (restoredView.current) { restoredView.current = false; return }
    if (!usesGlobalFilter || !activeViewId) return
    const view = useCrux.getState().snapshot?.views.find((item) => item.id === activeViewId)
    if (view) setGroupBy(view.groupBy === 'status' ? 'state' : view.groupBy === 'type' ? 'state' : view.groupBy)
    setStateGroups([])
  }, [activeViewId, usesGlobalFilter])

  const location: TaskListLocation = { layout, groupBy, orderBy, display, tab, stateGroups, sourceFilter, favorites, relation, personalSpaceId, scrollPositions: [] }
  const latestLocation = useRef(location); latestLocation.current = location
  const persistLocation = (): void => {
    const current = useCrux.getState()
    if (!current.snapshot || taskSourceKey(current.snapshot, current.workspaceContext) !== sourceIdentity || !locationRoot.current) return
    const entry = { ...latestLocation.current, scrollPositions: captureScrollPositions(locationRoot.current) }
    useCrux.setState({ taskWorkspaceLocations: Object.fromEntries(Object.entries({ ...current.taskWorkspaceLocations, [locationKey]: entry }).slice(-24)) })
  }
  useLayoutEffect(() => {
    restoreScrollPositions(locationRoot.current, savedLocation?.scrollPositions ?? [])
    return () => { persistLocation() }
  }, [locationKey])
  useLayoutEffect(() => { persistLocation() }, [layout, groupBy, orderBy, display, tab, stateGroups, sourceFilter, favorites, relation, personalSpaceId])

  const splitSidebarRestore = useRef<boolean | null>(null)
  const taskSplitActive = Boolean(
    snapshot && state.openTaskId && TASK_LAYOUT_SOURCE_KEYS.has(scope) &&
    snapshot.tasks.some((task) => task.id === state.openTaskId && (scope === 'mine' || task.spaceId === currentSpaceId))
  )
  useEffect(() => {
    if (taskSplitActive) {
      if (splitSidebarRestore.current === null) splitSidebarRestore.current = useMy.getState().sidebarCollapsed
      useMy.getState().setSidebarCollapsed(true, false)
    } else if (splitSidebarRestore.current !== null) {
      const restore = splitSidebarRestore.current
      splitSidebarRestore.current = null
      useMy.getState().setSidebarCollapsed(restore, false)
    }
  }, [taskSplitActive])
  useEffect(() => () => {
    if (splitSidebarRestore.current !== null) {
      const restore = splitSidebarRestore.current
      splitSidebarRestore.current = null
      useMy.getState().setSidebarCollapsed(restore, false)
    }
  }, [])

  if (!snapshot) return <EmptyState title={state.loadError ?? '正在加载任务…'} />
  const actorId = workspaceContext.actorId ?? (workspaceContext.state === 'local' ? snapshot.members.find((member) => member.role === 'owner')?.id ?? null : null)
  const spaceId = scope === 'mine' ? null : currentSpaceId
  const filterSpaceId = scope === 'mine' ? personalSpaceId : spaceId
  const createSpaceId = filterSpaceId ?? currentSpaceId
  const personalStatus = PERSONAL_STATUSES.find((item) => item.groups.length === stateGroups.length && item.groups.every((group) => stateGroups.includes(group)))
  const filter = usesGlobalFilter ? state.taskFilter : sourceFilter
  const setFilter = (patch: Partial<CruxTaskFilterState>): void => {
    if (!ownsSource()) return
    if (usesGlobalFilter) state.setTaskFilter(patch)
    else setSourceFilter((previous) => ({ ...previous, ...patch }))
  }
  const taskById = new Map(snapshot.tasks.map((task) => [task.id, task]))
  const isUnversioned = (task: CruxTask): boolean => {
    const category = snapshot.taskStatuses.find((status) => status.id === task.statusId)?.category
    return task.triagePending !== true && task.iterationIds.length === 0 && category !== 'done' && category !== 'cancelled'
  }
  const scoped = snapshot.tasks.filter((task) => (scope === 'mine'
    ? matchesPersonalTaskRelation(snapshot, task, actorId, relation) && (!personalSpaceId || task.spaceId === personalSpaceId)
    : Boolean(spaceId && task.spaceId === spaceId)) && (!iterationId || task.iterationIds.includes(iterationId)) && (!taskIds || taskIds.includes(task.id)))
  const tasks = applyTaskFilter(scoped, snapshot, filter).filter((task) => scope === 'triage'
    ? task.triagePending === true || isUnversioned(task)
    : scope === 'mine' || task.triagePending !== true)
  const data = deriveTaskWorkspaceDataset(snapshot, tasks, {
    spaceId, actorId, workspaceKey: workspaceContext.key, workspaceName: workspaceContext.projectName
  })
  const writable = hasIpc && Boolean(api.crux) && !busy && workspaceContext.state !== 'access-revoked'
  const canWriteSpace = (id: string | null): boolean => {
    const target = useCrux.getState().snapshot?.spaces.find((item) => item.id === id)
    return Boolean(target && !target.archived && (workspaceContext.state === 'local' || actorId && target.memberIds.includes(actorId)))
  }
  const ownsSource = (): boolean => {
    const current = useCrux.getState()
    return mounted.current && ownsSurface() && canInteract() && current.workspaceContext.key === workspaceContext.key && current.workspaceContext.actorId === workspaceContext.actorId &&
      current.workspaceContext.instanceId === workspaceContext.instanceId && current.workspaceContext.epoch === workspaceContext.epoch && current.workspaceContext.state !== 'access-revoked' &&
      (scope === 'mine' || current.currentSpaceId === spaceId)
  }

  // Re-read original ownership at action time; a retained callback cannot adopt another workspace.
  const currentTask = (id: string): CruxTask | undefined => {
    const current = useCrux.getState()
    if (!ownsSource()) return undefined
    const task = current.snapshot?.tasks.find((item) => item.id === id)
    return task && task.createdAt === taskById.get(id)?.createdAt &&
      (scope === 'mine' ? Boolean(current.snapshot && matchesPersonalTaskRelation(current.snapshot, task, actorId, relation)) : task.spaceId === spaceId) ? task : undefined
  }
  const canEdit = (id: string): boolean => {
    const task = currentTask(id)
    return Boolean(writable && task && canWriteSpace(task.spaceId))
  }
  const patchTask = async (id: string, patch: CruxTaskPatchInput): Promise<void> => {
    const task = currentTask(id)
    if (!task || !canEdit(id)) return
    const flow = getCruxLightweightTaskCapabilities(snapshot, task, actorId ?? undefined)
    if (patch.statusId && (!flow.canEditStatus || !flow.statusOptions.some(item => item.id === patch.statusId))) return
    if (patch.statusId && !task.workflow) {
      const allowed = resolveAllowedTargetStatusIds(snapshot, task, typeWorkflows)
      if (!allowed.has(patch.statusId)) {
        useApp.getState().pushToast({ kind: 'info', title: '受工作流规则限制', body: '当前任务类型不允许直接流转到此状态。' })
        return
      }
    }
    if (patch.assigneeIds && !flow.canAssign) return
    if (task.workflow && (patch.statusId || patch.assigneeIds)) {
      if (flow.canRestore) await state.run('更新任务', () => api.crux.restoreLightweightTask({ taskId: id, expectedUpdatedAt: task.updatedAt, statusId: patch.statusId, assigneeIds: patch.assigneeIds }))
      return
    }
    await state.run('更新任务', () => canEdit(id) ? api.crux.updateTask({ id, patch }) : Promise.resolve({ ok: false as const, error: '任务来源已变化，请重新打开任务。' }))
  }
  const filters: IssueFilters = {
    priority: filter.priorities ?? [], stateGroup: stateGroups,
    assigneeIds: filter.assigneeIds ?? [], labelIds: filter.labelIds ?? []
  }
  const toggleFilter: WorkItemsStore['toggleFilter'] = (key, value) => {
    if (!ownsSource()) return
    if (key === 'stateGroup') { setStateGroups((previous) => toggleValue(previous, value as StateGroup)); return }
    const field = key === 'priority' ? 'priorities' : key
    setFilter({ [field]: toggleValue<string>(filters[key], value) })
  }
  const clearFilters = (): void => {
    if (!ownsSource()) return
    setStateGroups([])
    setPersonalSpaceId(null)
    setFilter({ keyword: undefined, typeIds: undefined, statusIds: undefined, priorities: undefined,
      assigneeIds: undefined, labelIds: undefined, projectId: undefined, iterationId: undefined })
  }
  const saveGroup = groupBy === 'state' ? 'status' : groupBy === 'assignee' || groupBy === 'priority' ? groupBy : null
  const canSaveScope = scope === 'space' && taskIds === undefined && (!iterationId || !filter.iterationId || filter.iterationId === iterationId)
  const saveView: WorkItemsStore['saveView'] = (name) => {
    if (!canSaveScope || !writable || !spaceId || !saveGroup || !ownsSource() || !canWriteSpace(spaceId) || useCrux.getState().currentSpaceId !== spaceId) return
    const viewFilter: CruxViewFilter = { ...filter, ...(iterationId ? { iterationId } : {}) }
    if (stateGroups.length || tab !== 'all') {
      viewFilter.statusIds = snapshot.taskStatuses.filter((status) => {
        const group = CRUX_STATE_GROUPS[status.category]
        return status.spaceId === spaceId && (!stateGroups.length || stateGroups.includes(group)) &&
          (tab === 'all' || (tab === 'active' ? group === 'unstarted' || group === 'started' : group === 'backlog')) &&
          (!filter.statusIds?.length || filter.statusIds.includes(status.id))
      }).map((status) => status.id)
      if (!viewFilter.statusIds.length) {
        useApp.getState().pushToast({ kind: 'info', title: '无法保存视图', body: '当前状态条件没有交集。' })
        return
      }
    }
    void state.run('保存视图', () => ownsSource() && canWriteSpace(spaceId) ? api.crux.saveView({ spaceId, name, filter: viewFilter, groupBy: saveGroup }) : Promise.resolve({ ok: false as const, error: '任务来源已变化，请重新保存视图。' }))
  }
  const source: WorkItemsSource = {
    key: `${workspaceContext.key}:${workspaceContext.instanceId ?? ''}:${workspaceContext.epoch ?? ''}:${actorId ?? ''}:${scope}:${spaceId ?? ''}`,
    kind: 'collaboration', projectId: spaceId,
    capabilities: {
      editableFields: writable ? ['priority', 'assigneeId', 'stateId'] : [],
      create: Boolean(writable && canWriteSpace(createSpaceId) && (!iterationId || snapshot.iterations.find((item) => item.id === iterationId)?.status !== 'completed')),
      favorites: true, saveView: Boolean(canSaveScope && writable && spaceId && canWriteSpace(spaceId) && saveGroup)
    },
    canEditIssue: (id, field) => {
      const task = currentTask(id)
      if (!task || !canEdit(id)) return false
      const flow = getCruxLightweightTaskCapabilities(snapshot, task, actorId ?? undefined)
      if (field === 'stateId') return flow.canEditStatus && (!task.workflow || flow.canRestore)
      if (field === 'assigneeId') return flow.canAssign && (!task.workflow || flow.canRestore)
      return true
    },
    setAssignees: async (id, ids) => {
      const task = currentTask(id)
      const taskSpace = snapshot.spaces.find((item) => item.id === task?.spaceId)
      if (!taskSpace || ids.some((memberId) => !taskSpace.memberIds.includes(memberId))) return
      await patchTask(id, { assigneeIds: ids })
    },
    presentation: {
      title: scope === 'mine' ? '我的任务' : scope === 'triage' ? '分拣' : '任务',
      identifier: (issue) => issue.id,
      renderBoardReview: issue => {
        const task = taskById.get(issue.id)
        if (!task) return null
        const taskRuns = runs.filter((run) => run.taskId === task.id)
        const activeRun = taskRuns.find((run) => isActiveRunStatus(run.status))
        const queuedCount = taskRuns.filter((run) => run.status === 'queued').length
        const showRunChip = Boolean(activeRun || queuedCount > 0 || task.executor)
        if (!task.outputReview && !showRunChip) return null
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            {task.outputReview && <TaskOutputReviewBoardBadge task={task} />}
            {activeRun ? (
              <span className="inline-flex items-center gap-1 rounded-my-sm bg-my-info-subtle px-1.5 py-0.5 text-my-2xs text-my-info-text">
                <Bot size={11} />
                {activeRun.executorName} · {RUN_STATUS_META[activeRun.status].label}
              </span>
            ) : queuedCount > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-my-sm bg-my-layer-2 px-1.5 py-0.5 text-my-2xs text-my-secondary">
                <Bot size={11} />排队 {queuedCount}
              </span>
            ) : task.executor ? (
              <span className="inline-flex items-center gap-1 rounded-my-sm bg-my-layer-2 px-1.5 py-0.5 text-my-2xs text-my-tertiary">
                <Bot size={11} />{task.executor.name}
              </span>
            ) : null}
          </div>
        )
      },
      stateIds: id => {
        const task = taskById.get(id)
        if (!task) return []
        const baseOptions = getCruxLightweightTaskCapabilities(snapshot, task, actorId ?? undefined).statusOptions.map(status => status.id)
        if (task.workflow) return baseOptions
        const allowed = resolveAllowedTargetStatusIds(snapshot, task, typeWorkflows)
        return baseOptions.filter((statusId) => allowed.has(statusId))
      },
      cycleMode: 'version', cycleIds: (issue) => taskById.get(issue.id)?.iterationIds ?? [],
      assigneeIds: (issue) => taskById.get(issue.id)?.assigneeIds ?? [],
      assigneeOptions: (id) => data.members.filter((member) => snapshot.spaces.find((item) => item.id === taskById.get(id)?.spaceId)?.memberIds.includes(member.id)),
      multiAssignee: (id) => Boolean(snapshot.spaces.find((item) => item.id === taskById.get(id)?.spaceId)?.multiAssignee || (taskById.get(id)?.assigneeIds.length ?? 0) > 1),
      labelColor: (label) => snapshot.taskLabels.find((item) => item.id === label.id)?.color ?? `var(--my-label-${label.color}-icon)`,
      renderLabel: (label) => {
        const item = snapshot.taskLabels.find((candidate) => candidate.id === label.id)
        return item ? <LabelChip label={item} /> : <LabelPill label={label} />
      },
      startDateLabel: '版本开始', dueDateLabel: '版本截止',
      ...(scope === 'triage' ? {
        tabs: [{ id: 'all' as const, label: '待分拣' }, { id: 'active' as const, label: '已接受 · 未排版本' }],
        matchesTab: (issue: Issue, selected: WorkItemsStore['workItemsTab']) => {
          const task = taskById.get(issue.id)
          return Boolean(task && (selected === 'all' ? task.triagePending === true : isUnversioned(task)))
        }
      } : scope === 'mine' ? { tabs: [{ id: 'all' as const, label: '全部' }], matchesTab: () => true } : {}),
      additionalFilterCount: Number(Boolean(filter.keyword)) + (filter.typeIds?.length ?? 0) + (filter.statusIds?.length ?? 0) + Number(Boolean(filter.projectId)) + Number(Boolean(filter.iterationId)) + Number(Boolean(personalSpaceId)),
      filterContent: <>
        <div className="px-3 py-1.5"><SearchInput value={filter.keyword ?? ''} onChange={(keyword) => setFilter({ keyword })} placeholder="搜索任务编号或标题" /></div>
        <DropdownHeader>任务类型</DropdownHeader>
        {snapshot.taskTypes.filter((type) => !filterSpaceId || type.spaceId === filterSpaceId).map((type) =>
          <DropdownItem key={type.id} selected={filter.typeIds?.includes(type.id)} onClick={() => setFilter({ typeIds: toggleValue(filter.typeIds ?? [], type.id) })}>{type.name}</DropdownItem>)}
        <DropdownHeader>工作状态</DropdownHeader>
        {snapshot.taskStatuses.filter((status) => !filterSpaceId || status.spaceId === filterSpaceId).map((status) =>
          <DropdownItem key={status.id} selected={filter.statusIds?.includes(status.id)} onClick={() => setFilter({ statusIds: toggleValue(filter.statusIds ?? [], status.id) })}>{statusDisplayName(status)}</DropdownItem>)}
        <DropdownHeader>版本</DropdownHeader>
        {data.cycles.filter((version) => !filterSpaceId || version.projectId === filterSpaceId).map((version) => <DropdownItem key={version.id} selected={filter.iterationId === version.id} onClick={() => setFilter({ iterationId: filter.iterationId === version.id ? undefined : version.id })}>{version.name}</DropdownItem>)}
        <DropdownHeader>专项</DropdownHeader>
        {data.modules.filter((project) => !filterSpaceId || project.projectId === filterSpaceId).map((project) => <DropdownItem key={project.id} selected={filter.projectId === project.id} onClick={() => setFilter({ projectId: filter.projectId === project.id ? undefined : project.id })}>{project.name}</DropdownItem>)}
      </>
    },
    store: {
      data, layout, groupBy, orderBy, filters, display, workItemsView: 'items', workItemsTab: tab,
      setLayout, setGroupBy, setOrderBy, setWorkItemsTab: setTab, toggleFilter, clearFilters,
      setDisplay: (patch) => setDisplay((previous) => ({ ...previous, ...patch })),
      openIssue: (id) => { if (currentTask(id)) state.openTask(id) },
      updateIssue: async (id, patch) => {
        if (Object.keys(patch).some((field) => field !== 'priority' && field !== 'assigneeId' && field !== 'stateId')) {
          useApp.getState().pushToast({ kind: 'info', title: '请在任务详情中操作' })
          return
        }
        await patchTask(id, { ...(patch.priority ? { priority: patch.priority } : {}), ...(patch.stateId ? { statusId: patch.stateId } : {}),
          ...('assigneeId' in patch ? { assigneeIds: patch.assigneeId ? [patch.assigneeId] : [] } : {}) })
      },
      setCreateIssueOpen: (open) => {
        if (source.capabilities.create && ownsSource() && useCrux.getState().currentSpaceId === currentSpaceId) {
          if (open) state.beginCreateTask({ ...(createSpaceId ? { spaceId: createSpaceId } : {}), ...(iterationId ? { iterationId } : {}), ...(scope === 'triage' ? { triagePending: true } : {}) })
          else state.setCreateTaskOpen(false)
        }
      },
      favorites, toggleFavorite: (id) => {
        const task = taskById.get(id)
        togglePlatformFavorite('task', id, task?.spaceId)
      }, saveView
    }
  }
  const openTaskId = state.openTaskId
  const openTask = openTaskId ? snapshot.tasks.find(task => task.id === openTaskId && (scope === 'mine' || task.spaceId === spaceId)) : undefined
  return <div ref={locationRoot} onScrollCapture={persistLocation} className="flex h-full min-h-0 min-w-0 flex-col">
    {scope === 'mine' && <MyNextSteps />}
    {scope === 'mine' && <PageToolbar className="bg-my-surface-1 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Dropdown trigger={({ open, toggle }) => (
          <button
            type="button"
            aria-label="任务关系"
            aria-expanded={open}
            onClick={toggle}
            className={clsx(
              'my-control my-control-sm flex items-center gap-1.5 rounded-my-base px-2.5 transition-colors',
              relation !== 'assigned'
                ? 'border border-my-line-strong bg-my-layer-2 text-my-primary font-medium'
                : 'border border-my-line bg-my-panel text-my-secondary hover:border-my-line-strong hover:text-my-primary'
            )}
          >
            <span>{PERSONAL_RELATIONS.find((item) => item.id === relation)?.label}</span>
            <ChevronDown size={12} className={clsx('text-my-icon-tertiary transition-transform', open && 'rotate-180')} />
          </button>
        )}>
          {(close) => PERSONAL_RELATIONS.map((item) => <DropdownItem key={item.id} selected={relation === item.id} onClick={() => { if (ownsSource()) setRelation(item.id); close() }}>{item.label}</DropdownItem>)}
        </Dropdown>
        <Dropdown trigger={({ open, toggle }) => (
          <button
            type="button"
            aria-label="个人任务状态"
            aria-expanded={open}
            onClick={toggle}
            className={clsx(
              'my-control my-control-sm flex items-center gap-1.5 rounded-my-base px-2.5 transition-colors',
              personalStatus?.id !== 'open'
                ? 'border border-my-line-strong bg-my-layer-2 text-my-primary font-medium'
                : 'border border-my-line bg-my-panel text-my-secondary hover:border-my-line-strong hover:text-my-primary'
            )}
          >
            <span>{personalStatus?.label ?? '已筛选状态'}</span>
            <ChevronDown size={12} className={clsx('text-my-icon-tertiary transition-transform', open && 'rotate-180')} />
          </button>
        )}>
          {(close) => PERSONAL_STATUSES.map((item) => <DropdownItem key={item.id} selected={personalStatus === item} onClick={() => { if (ownsSource()) { setStateGroups(item.groups); setTab('all'); setFilter({ statusIds: undefined }) } close() }}>{item.label}</DropdownItem>)}
        </Dropdown>
        <Dropdown trigger={({ open, toggle }) => (
          <button
            type="button"
            aria-label="个人任务空间"
            aria-expanded={open}
            onClick={toggle}
            className={clsx(
              'my-control my-control-sm flex items-center gap-1.5 rounded-my-base px-2.5 transition-colors',
              personalSpaceId
                ? 'border border-my-line-strong bg-my-layer-2 text-my-primary font-medium'
                : 'border border-my-line bg-my-panel text-my-secondary hover:border-my-line-strong hover:text-my-primary'
            )}
          >
            <span className="max-w-40 truncate">{snapshot.spaces.find((space) => space.id === personalSpaceId)?.name ?? '全部空间'}</span>
            <ChevronDown size={12} className={clsx('text-my-icon-tertiary transition-transform', open && 'rotate-180')} />
          </button>
        )}>
          {(close) => <>
            <DropdownItem selected={!personalSpaceId} onClick={() => { if (ownsSource()) setPersonalSpaceId(null); close() }}>全部空间</DropdownItem>
            {snapshot.spaces.map((space) => <DropdownItem key={space.id} selected={personalSpaceId === space.id} onClick={() => { if (ownsSource()) { setPersonalSpaceId(space.id); setFilter({ typeIds: undefined, statusIds: undefined, iterationId: undefined, projectId: undefined }) } close() }}>{space.name}</DropdownItem>)}
          </>}
        </Dropdown>
        <Dropdown trigger={({ open, toggle }) => (
          <button
            type="button"
            aria-label="个人任务版本"
            aria-expanded={open}
            onClick={toggle}
            className={clsx(
              'my-control my-control-sm flex items-center gap-1.5 rounded-my-base px-2.5 transition-colors',
              filter.iterationId
                ? 'border border-my-line-strong bg-my-layer-2 text-my-primary font-medium'
                : 'border border-my-line bg-my-panel text-my-secondary hover:border-my-line-strong hover:text-my-primary'
            )}
          >
            <span className="max-w-40 truncate">{snapshot.iterations.find((version) => version.id === filter.iterationId)?.name ?? '全部版本'}</span>
            <ChevronDown size={12} className={clsx('text-my-icon-tertiary transition-transform', open && 'rotate-180')} />
          </button>
        )}>
          {(close) => <>
            <DropdownItem selected={!filter.iterationId} onClick={() => { setFilter({ iterationId: undefined }); close() }}>全部版本</DropdownItem>
            {snapshot.iterations.filter((version) => !personalSpaceId || version.spaceId === personalSpaceId).map((version) => <DropdownItem key={version.id} selected={filter.iterationId === version.id} onClick={() => { setFilter({ iterationId: version.id }); close() }}>{personalSpaceId ? version.name : `${snapshot.spaces.find((space) => space.id === version.spaceId)?.name ?? ''} · ${version.name}`}</DropdownItem>)}
          </>}
        </Dropdown>
      </div>
    </PageToolbar>}
    <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
      {openTask && TASK_LAYOUT_SOURCE_KEYS.has(scope)
        ? <section className="team-task-layout" aria-label="任务与列表">
            <div className="team-task-reader"><EmbeddedTaskPost taskId={openTask.id} onClose={() => { if (ownsSource()) state.openTask(null) }} /></div>
            <div className="team-task-list" aria-label="来源工作视图"><WorkItemsPage source={source} /></div>
          </section>
        : <WorkItemsPage source={source} />}
    </div>
  </div>
}
