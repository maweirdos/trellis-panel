/**
 * HiFox 渲染层状态：单一快照 + 本地视图状态（当前空间/模块/打开的任务/筛选）。
 * 所有写操作走 run()：调 api.hifox.* → 成功回填快照，失败 toast。
 */
import { create } from 'zustand'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import type { HifoxWorkspaceContext } from '@shared/hifox-remote'
import type { TaskListLocation, WorkReturnContext } from './development/types'
import type {
  HifoxID,
  HifoxInboxItem,
  HifoxInboxSection,
  HifoxMember,
  HifoxPriority,
  HifoxSnapshot,
  HifoxTask,
  HifoxTaskStatus,
  HifoxViewFilter
} from '@shared/hifox'

export type HifoxModule =
  | 'overview' | 'tasks' | 'board' | 'inbox' | 'triage' | 'creations' | 'cockpit'
  | 'projects' | 'iterations' | 'members' | 'spaces'
  | 'agents' | 'skills' | 'crews' | 'automations' | 'views' | 'all-agents' | 'my-tasks'
  | 'task-types' | 'task-statuses' | 'task-labels'

export interface HifoxTaskFilterState extends HifoxViewFilter {
  keyword?: string
}

interface HifoxState {
  workReturn: WorkReturnContext | null
  developmentMode: 'task' | 'independent' | null
  developmentRevision: number
  taskWorkspaceLocations: Record<string, TaskListLocation>
  localWorkOpening: { projectRoot: string; taskId: string } | null
  createTaskContext: { spaceId?: string; iterationId?: string; triagePending?: boolean } | null
  snapshot: HifoxSnapshot | null
  loadError: string | null
  busy: boolean
  workspaceContext: HifoxWorkspaceContext
  module: HifoxModule
  currentSpaceId: HifoxID | null
  cockpitScope: { iterationId?: string; projectId?: string }
  openCockpit: (spaceId: string, scope?: { iterationId?: string; projectId?: string }) => void
  openTaskId: HifoxID | null
  createTaskOpen: boolean
  taskFilter: HifoxTaskFilterState
  /** 当前生效的保存视图 id（null = 临时筛选） */
  activeViewId: HifoxID | null
  bootstrap: () => Promise<void>
  selectWorkspace: (connectionId: string | null) => Promise<boolean>
  setModule: (module: HifoxModule) => void
  setCurrentSpace: (id: HifoxID) => void
  openTask: (id: HifoxID | null) => void
  setCreateTaskOpen: (open: boolean) => void
  beginCreateTask: (context?: { spaceId?: string; iterationId?: string; triagePending?: boolean }) => void
  setTaskFilter: (patch: Partial<HifoxTaskFilterState>) => void
  applySavedView: (id: HifoxID | null) => void
  run: <T extends { ok: true; data: HifoxSnapshot } | { ok: false; error: string }>(
    label: string,
    call: () => Promise<T>
  ) => Promise<T | null>
}

let snapshotTicket = 0
let workspaceTicket = 0
let pendingWrites = 0
let switchingWorkspace = false
let writeQueue: Promise<unknown> = Promise.resolve()

function acceptSnapshot(snapshot: HifoxSnapshot, currentSpaceId: string | null): { snapshot: HifoxSnapshot; currentSpaceId: string | null } {
  return { snapshot, currentSpaceId: snapshot.spaces.some((space) => space.id === currentSpaceId) ? currentSpaceId : snapshot.spaces[0]?.id ?? null }
}

export const useHifox = create<HifoxState>()((set, get) => ({
  workReturn: null,
  developmentMode: null,
  developmentRevision: 0,
  taskWorkspaceLocations: {},
  localWorkOpening: null,
  createTaskContext: null,
  snapshot: null,
  loadError: null,
  busy: false,
  workspaceContext: { key: 'local', connectionId: null, projectId: null, projectName: null, actorId: null, canManage: true, revision: 0, state: 'local', pendingCount: 0 },
  module: 'overview',
  currentSpaceId: null,
  cockpitScope: {},
  openCockpit: (spaceId, scope = {}) => {
    const state = get()
    if (!state.snapshot?.spaces.some((space) => space.id === spaceId)) return
    set({ currentSpaceId: spaceId, cockpitScope: scope, module: 'cockpit', openTaskId: null, createTaskOpen: false })
  },
  openTaskId: null,
  createTaskOpen: false,
  taskFilter: {},
  activeViewId: null,

  bootstrap: async () => {
    if (!hasIpc || !api.hifox) {
      set({ loadError: 'HiFox 协作模块需要在应用内运行（当前为浏览器预览环境）' })
      return
    }
    if (pendingWrites || switchingWorkspace) return
    const ticket = ++snapshotTicket
    try {
      const result = await api.hifox.snapshot()
      if (ticket !== snapshotTicket) return
      if (result.ok) {
        const context = result.context ?? get().workspaceContext
        const changed = context.key !== get().workspaceContext.key
        if (changed) workspaceTicket++
        set({ ...acceptSnapshot(result.data, changed ? null : get().currentSpaceId), workspaceContext: context, loadError: null,
          ...(changed ? { openTaskId: null, createTaskOpen: false, taskFilter: {}, activeViewId: null, cockpitScope: {} } : {}) })
      }
      else set({ loadError: result.error, ...(result.context ? { workspaceContext: result.context, ...(result.context.state === 'access-revoked' ? { snapshot: null, openTaskId: null, createTaskOpen: false } : {}) } : {}) })
    } catch (error) {
      if (ticket === snapshotTicket) set({ loadError: error instanceof Error ? error.message : String(error) })
    }
  },

  selectWorkspace: async (connectionId) => {
    if (get().busy || pendingWrites) return false
    const ticket = ++snapshotTicket
    workspaceTicket++
    switchingWorkspace = true
    set({ busy: true })
    try {
      const result = await api.hifox.selectWorkspace({ connectionId })
      if (ticket !== snapshotTicket) return false
      if (!result.ok) { useApp.getState().pushToast({ kind: 'error', title: '切换协作空间', body: result.error }); return false }
      set({ ...acceptSnapshot(result.data, null), workspaceContext: result.context ?? get().workspaceContext, loadError: null,
        openTaskId: null, createTaskOpen: false, taskFilter: {}, activeViewId: null, cockpitScope: {} })
      return true
    } catch (error) {
      useApp.getState().pushToast({ kind: 'error', title: '切换协作空间', body: error instanceof Error ? error.message : String(error) })
      return false
    } finally { switchingWorkspace = false; set({ busy: false }) }
  },

  setModule: (module) => set({ module, openTaskId: null, createTaskOpen: false }),
  setCurrentSpace: (id) => set({ currentSpaceId: id, activeViewId: null, taskFilter: {}, cockpitScope: {}, openTaskId: null, createTaskOpen: false }),
  setCreateTaskOpen: (createTaskOpen) => set({ createTaskOpen, createTaskContext: null }),
  beginCreateTask: (context) => set({ createTaskOpen: true, createTaskContext: context ?? null }),
  openTask: (id) => {
    const state = get()
    const task = id ? state.snapshot?.tasks.find((item) => item.id === id) : undefined
    set({ openTaskId: id, ...(task && task.spaceId !== state.currentSpaceId ? { currentSpaceId: task.spaceId, taskFilter: {}, activeViewId: null } : {}) })
  },
  setTaskFilter: (patch) => set((s) => ({ taskFilter: { ...s.taskFilter, ...patch }, activeViewId: null })),
  applySavedView: (id) => {
    const state = get()
    if (!id) {
      set({ activeViewId: null })
      return
    }
    const view = state.snapshot?.views.find((v) => v.id === id)
    if (!view || view.spaceId !== state.currentSpaceId) return
    set({ activeViewId: id, taskFilter: { ...view.filter } })
  },

  run: async (label, call) => {
    if (!hasIpc || !api.hifox) return null
    const scope = workspaceTicket
    if (get().workspaceContext.state === 'access-revoked') {
      useApp.getState().pushToast({ kind: 'error', title: label, body: '此共享空间的访问权限已失效，请重新登录核对。' })
      return null
    }
    snapshotTicket++
    pendingWrites++
    set({ busy: true })
    const previousWrite = writeQueue
    let release: () => void = () => {}
    writeQueue = new Promise<void>((resolve) => { release = resolve })
    await previousWrite
    try {
      if (scope !== workspaceTicket) return null
      const result = await call()
      if (scope !== workspaceTicket) return null
      if (result.ok) {
        const state = get()
        const context = 'context' in result ? result.context as HifoxWorkspaceContext | undefined : undefined
        if (context && context.key !== state.workspaceContext.key) return null
        set({ ...acceptSnapshot(result.data, state.currentSpaceId), workspaceContext: context ?? state.workspaceContext, loadError: null,
          openTaskId: result.data.tasks.some((task) => task.id === state.openTaskId) ? state.openTaskId : null })
      }
      else {
        if ('context' in result && result.context) {
          const context = result.context as HifoxWorkspaceContext
          set({ workspaceContext: context, ...(context.state === 'access-revoked' ? { snapshot: null, loadError: result.error, openTaskId: null, createTaskOpen: false } : {}) })
        }
        useApp.getState().pushToast({ kind: 'error', title: label, body: result.error })
      }
      return result
    } catch (e) {
      useApp.getState().pushToast({ kind: 'error', title: label, body: e instanceof Error ? e.message : String(e) })
      return null
    } finally {
      pendingWrites--
      snapshotTicket++
      set({ busy: pendingWrites > 0 })
      release()
    }
  }
}))

/* ---------------- 快照派生工具（页面共用） ---------------- */

export function memberOf(snapshot: HifoxSnapshot, id: HifoxID | undefined): HifoxMember | undefined {
  return id ? snapshot.members.find((m) => m.id === id) : undefined
}

export function memberName(snapshot: HifoxSnapshot, id: HifoxID | undefined): string {
  return memberOf(snapshot, id)?.name ?? '—'
}

/** New executor choices; unavailable historical references remain on the task. */
export function availableExecutionTargets(snapshot: HifoxSnapshot, spaceId: HifoxID | null) {
  const agents = snapshot.agents.filter((agent) => agent.spaceId === spaceId && agent.enabled && !agent.archived && !agent.exclusiveCrewId)
  const crews = snapshot.crews.filter((crew) => crew.spaceId === spaceId && !crew.archived && (crew.captain.kind === 'member'
    ? snapshot.spaces.find((space) => space.id === spaceId)?.memberIds.includes(crew.captain.id) && snapshot.members.some((member) => member.id === crew.captain.id)
    : snapshot.agents.some((agent) => agent.id === crew.captain.id && agent.spaceId === spaceId && agent.enabled && !agent.archived && (!agent.exclusiveCrewId || agent.exclusiveCrewId === crew.id))))
  return { agents, crews }
}

export function statusOf(snapshot: HifoxSnapshot, id: HifoxID | undefined): HifoxTaskStatus | undefined {
  return id ? snapshot.taskStatuses.find((s) => s.id === id) : undefined
}

export function spaceTasks(snapshot: HifoxSnapshot, spaceId: HifoxID | null): HifoxTask[] {
  return spaceId ? snapshot.tasks.filter((t) => t.spaceId === spaceId) : snapshot.tasks
}

/** PRD 4.4 两层模型：任务可选状态 = 类型的状态集（未配置时为空间全部） */
export function allowedStatusIdsFor(snapshot: HifoxSnapshot, spaceId: HifoxID | null, typeId?: string): Set<string> {
  const type = typeId ? snapshot.taskTypes.find((t) => t.id === typeId) : undefined
  if (type?.statusIds?.length) return new Set(type.statusIds)
  return new Set(snapshot.taskStatuses.filter((s) => !spaceId || s.spaceId === spaceId).map((s) => s.id))
}

/** Pending triage is explicit; unassigned backlog remains ordinary planned work. */
export function isTriagePending(_snapshot: HifoxSnapshot, task: HifoxTask): boolean {
  return task.triagePending === true
}

/** 空间可见标签 = 空间标签 + 组织标签（PRD 4.3 规则4） */
export function visibleLabels(snapshot: HifoxSnapshot, spaceId: HifoxID | null) {
  return snapshot.taskLabels.filter((l) => !l.archived && (!l.spaceId || l.spaceId === spaceId))
}

export function applyTaskFilter(tasks: HifoxTask[], snapshot: HifoxSnapshot, filter: HifoxTaskFilterState): HifoxTask[] {
  return tasks.filter((task) => {
    if (filter.keyword && !`${task.id} ${task.title}`.toLowerCase().includes(filter.keyword.toLowerCase())) return false
    if (filter.typeIds?.length && (!task.typeId || !filter.typeIds.includes(task.typeId))) return false
    if (filter.statusIds?.length && !filter.statusIds.includes(task.statusId)) return false
    const labelIds = filter.labelIds ?? []
    const assigneeIds = filter.assigneeIds ?? []
    if (labelIds.length && !labelIds.every((id) => task.labelIds.includes(id))) return false
    if (assigneeIds.length && !task.assigneeIds.some((id) => assigneeIds.includes(id))) return false
    if (filter.priorities?.length && !filter.priorities.includes(task.priority)) return false
    if (filter.iterationId && !task.iterationIds.includes(filter.iterationId)) return false
    if (filter.projectId && task.projectId !== filter.projectId) return false
    return true
  })
}

export const PRIORITY_LABEL: Record<HifoxPriority, string> = {
  urgent: '紧急', high: '高', medium: '中', low: '低', none: '无'
}

export const PRIORITY_ICON_CLASS: Record<HifoxPriority, string> = {
  urgent: 'text-my-urgent',
  high: 'text-my-high',
  medium: 'text-my-medium',
  low: 'text-my-low',
  none: 'text-my-none'
}

export const STATUS_CATEGORY_CLASS: Record<string, string> = {
  backlog: 'bg-my-layer-1 text-my-secondary',
  todo: 'bg-my-info-subtle text-my-info-text',
  in_progress: 'bg-my-info-subtle text-my-info-text',
  in_review: 'bg-my-warning-subtle text-my-warning-text',
  done: 'bg-my-success-subtle text-my-success-text',
  blocked: 'bg-my-danger-subtle text-my-danger-text',
  cancelled: 'bg-my-layer-1 text-my-tertiary'
}

/** 收件箱活跃分区视图（REA 实测语义：稍后/已清理互斥，到时回对应分区） */
export function inboxGroups(items: HifoxInboxItem[], now: number): {
  important: HifoxInboxItem[]
  other: HifoxInboxItem[]
  snoozed: HifoxInboxItem[]
  cleared: HifoxInboxItem[]
  unread: Record<HifoxInboxSection, number>
} {
  const important: HifoxInboxItem[] = []
  const other: HifoxInboxItem[] = []
  const snoozed: HifoxInboxItem[] = []
  const cleared: HifoxInboxItem[] = []
  for (const item of items) {
    if (item.cleared) cleared.push(item)
    else if (item.snoozedUntil && Date.parse(item.snoozedUntil) > now) snoozed.push(item)
    else (item.section === 'important' ? important : other).push(item)
  }
  const unread = {
    important: important.filter((i) => !i.read).length,
    other: other.filter((i) => !i.read).length
  }
  return { important, other, snoozed, cleared, unread }
}
