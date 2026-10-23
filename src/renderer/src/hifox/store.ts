/**
 * HiFox 渲染层状态：单一快照 + 本地视图状态（当前空间/模块/打开的任务/筛选）。
 * 所有写操作走 run()：调 api.hifox.* → 成功回填快照，失败 toast。
 */
import { create } from 'zustand'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
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
  | 'overview' | 'tasks' | 'board' | 'inbox' | 'triage'
  | 'projects' | 'iterations' | 'members' | 'spaces'
  | 'agents' | 'skills' | 'crews' | 'automations'

export interface HifoxTaskFilterState extends HifoxViewFilter {
  keyword?: string
}

interface HifoxState {
  snapshot: HifoxSnapshot | null
  loadError: string | null
  busy: boolean
  module: HifoxModule
  currentSpaceId: HifoxID | null
  openTaskId: HifoxID | null
  taskFilter: HifoxTaskFilterState
  /** 当前生效的保存视图 id（null = 临时筛选） */
  activeViewId: HifoxID | null
  bootstrap: () => Promise<void>
  setModule: (module: HifoxModule) => void
  setCurrentSpace: (id: HifoxID) => void
  openTask: (id: HifoxID | null) => void
  setTaskFilter: (patch: Partial<HifoxTaskFilterState>) => void
  applySavedView: (id: HifoxID | null) => void
  run: <T extends { ok: true; data: HifoxSnapshot } | { ok: false; error: string }>(
    label: string,
    call: () => Promise<T>
  ) => Promise<T | null>
}

export const useHifox = create<HifoxState>()((set, get) => ({
  snapshot: null,
  loadError: null,
  busy: false,
  module: 'overview',
  currentSpaceId: null,
  openTaskId: null,
  taskFilter: {},
  activeViewId: null,

  bootstrap: async () => {
    if (!hasIpc || !api.hifox) {
      set({ loadError: 'HiFox 协作模块需要在应用内运行（当前为浏览器预览环境）' })
      return
    }
    const result = await api.hifox.snapshot()
    if (result.ok) {
      const state = get()
      set({
        snapshot: result.data,
        loadError: null,
        currentSpaceId: state.currentSpaceId ?? result.data.spaces[0]?.id ?? null
      })
    } else {
      set({ loadError: result.error })
    }
  },

  setModule: (module) => set({ module }),
  setCurrentSpace: (id) => set({ currentSpaceId: id, activeViewId: null, taskFilter: {}, openTaskId: null }),
  openTask: (id) => set({ openTaskId: id }),
  setTaskFilter: (patch) => set((s) => ({ taskFilter: { ...s.taskFilter, ...patch }, activeViewId: null })),
  applySavedView: (id) => {
    const state = get()
    if (!id) {
      set({ activeViewId: null })
      return
    }
    const view = state.snapshot?.views.find((v) => v.id === id)
    if (!view) return
    set({ activeViewId: id, taskFilter: { ...view.filter } })
  },

  run: async (label, call) => {
    if (!hasIpc || !api.hifox) return null
    set({ busy: true })
    try {
      const result = await call()
      if (result.ok) set({ snapshot: result.data, loadError: null })
      else useApp.getState().pushToast({ kind: 'error', title: label, body: result.error })
      return result
    } catch (e) {
      useApp.getState().pushToast({ kind: 'error', title: label, body: e instanceof Error ? e.message : String(e) })
      return null
    } finally {
      set({ busy: false })
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

/** PRD 3.5 规则1：待分拣任务（Backlog 且无处理人无执行槽）默认排除出列表与看板 */
export function isTriagePending(snapshot: HifoxSnapshot, task: HifoxTask): boolean {
  const status = snapshot.taskStatuses.find((s) => s.id === task.statusId)
  return status?.category === 'backlog' && task.assigneeIds.length === 0 && !task.executor
}

/** 空间可见标签 = 空间标签 + 组织标签（PRD 4.3 规则4） */
export function visibleLabels(snapshot: HifoxSnapshot, spaceId: HifoxID | null) {
  return snapshot.taskLabels.filter((l) => !l.archived && (!l.spaceId || l.spaceId === spaceId))
}

export function applyTaskFilter(tasks: HifoxTask[], snapshot: HifoxSnapshot, filter: HifoxTaskFilterState): HifoxTask[] {
  return tasks.filter((task) => {
    if (filter.keyword && !`${task.id} ${task.title}`.toLowerCase().includes(filter.keyword.toLowerCase())) return false
    if (filter.typeIds?.length && (!task.typeId || !filter.typeIds.includes(task.typeId))) return false
    if (filter.labelIds?.length && !task.labelIds.some((id) => filter.labelIds!.includes(id))) return false
    if (filter.assigneeIds?.length && !task.assigneeIds.some((id) => filter.assigneeIds!.includes(id))) return false
    if (filter.priorities?.length && !filter.priorities.includes(task.priority)) return false
    if (filter.iterationId && !task.iterationIds.includes(filter.iterationId)) return false
    if (filter.projectId && task.projectId !== filter.projectId) return false
    return true
  })
}

export const PRIORITY_LABEL: Record<HifoxPriority, string> = {
  urgent: '紧急', high: '高', medium: '中', low: '低', none: '无'
}

export const PRIORITY_CLASS: Record<HifoxPriority, string> = {
  urgent: 'bg-red-500/15 text-red-500',
  high: 'bg-orange-500/15 text-orange-500',
  medium: 'bg-blue-500/15 text-blue-400',
  low: 'bg-emerald-500/15 text-emerald-500',
  none: 'bg-my-layer text-my-tertiary'
}

export const STATUS_CATEGORY_CLASS: Record<string, string> = {
  backlog: 'bg-zinc-500/15 text-zinc-400',
  todo: 'bg-sky-500/15 text-sky-400',
  in_progress: 'bg-blue-500/15 text-blue-400',
  in_review: 'bg-violet-500/15 text-violet-400',
  done: 'bg-emerald-500/15 text-emerald-500',
  blocked: 'bg-red-500/15 text-red-500',
  cancelled: 'bg-zinc-500/15 text-zinc-500'
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
