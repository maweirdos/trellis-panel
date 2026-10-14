// 应用级 参考 外壳状态。路由唯一事实是主 store 的 useApp.page，这里只管
// 视图偏好（布局/分组/排序/筛选）、弹层（peek/命令面板/新建）与数据镜像。
import { create } from 'zustand'
import { api } from '../api'
import { useApp } from '../store'
import { deriveDataset, issueToTaskPatch, todayIso, TRELLIS_PROJECT_ID } from './adapter'
import type { GroupBy, Issue, IssueFilters, OrderBy, Priority, ThemeMode, WorkItemLayout } from './types'

const STORAGE_KEY = 'tpanel.my.ui'

interface PersistedPrefs {
  layout: WorkItemLayout
  groupBy: GroupBy
  orderBy: OrderBy
}

function loadPrefs(): Partial<PersistedPrefs> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Partial<PersistedPrefs>
  } catch {
    return {}
  }
}

function savePrefs(prefs: PersistedPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // 隐私模式等场景下静默降级
  }
}

const prefs = loadPrefs()

export interface MyStore {
  /** 视图模型镜像；快照更新时 syncFromSnapshot() 重建 */
  data: ReturnType<typeof deriveDataset>
  syncFromSnapshot: () => void

  theme: ThemeMode
  setTheme: (t: ThemeMode) => void

  layout: WorkItemLayout
  groupBy: GroupBy
  orderBy: OrderBy
  filters: IssueFilters
  display: {
    showEmptyGroups: boolean
    showSubIssues: boolean
  }
  setLayout: (l: WorkItemLayout) => void
  setGroupBy: (g: GroupBy) => void
  setOrderBy: (o: OrderBy) => void
  toggleFilter: <K extends keyof IssueFilters>(key: K, value: IssueFilters[K][number]) => void
  clearFilters: () => void
  setDisplay: (patch: Partial<MyStore['display']>) => void

  peekIssueId: string | null
  openIssue: (id: string) => void
  closeIssue: () => void
  createIssueOpen: boolean
  setCreateIssueOpen: (v: boolean) => void
  paletteOpen: boolean
  setPaletteOpen: (v: boolean) => void

  updateIssue: (id: string, patch: Partial<Issue>) => Promise<void>
  createIssue: (input: { name: string; priority: Priority; description?: string }) => Promise<string | null>
  toggleTheme: () => void
}

const defaultFilters: IssueFilters = { priority: [], stateGroup: [], assigneeIds: [], labelIds: [] }

function currentDataset(): ReturnType<typeof deriveDataset> {
  return deriveDataset(useApp.getState().snapshot)
}

export const useMy = create<MyStore>()((set, get) => ({
  data: currentDataset(),
  syncFromSnapshot: () => set({ data: currentDataset() }),

  theme: useApp.getState().settings?.theme === 'light' ? 'light' : 'dark',
  setTheme: (t) => {
    set({ theme: t })
    void useApp.getState().saveSettings({ theme: t })
  },
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    get().setTheme(next)
  },

  layout: prefs.layout ?? 'list',
  groupBy: prefs.groupBy ?? 'state',
  orderBy: prefs.orderBy ?? 'manual',
  filters: defaultFilters,
  display: { showEmptyGroups: false, showSubIssues: true },
  setLayout: (l) => {
    set({ layout: l })
    savePrefs({ layout: get().layout, groupBy: get().groupBy, orderBy: get().orderBy })
  },
  setGroupBy: (g) => {
    set({ groupBy: g })
    savePrefs({ layout: get().layout, groupBy: g, orderBy: get().orderBy })
  },
  setOrderBy: (o) => {
    set({ orderBy: o })
    savePrefs({ layout: get().layout, groupBy: get().groupBy, orderBy: o })
  },
  toggleFilter: (key, value) => {
    const cur = get().filters[key] as unknown[]
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
    set({ filters: { ...get().filters, [key]: next } })
  },
  clearFilters: () => set({ filters: defaultFilters }),
  setDisplay: (patch) => set({ display: { ...get().display, ...patch } }),

  peekIssueId: null,
  openIssue: (id) => set({ peekIssueId: id }),
  closeIssue: () => set({ peekIssueId: null }),
  createIssueOpen: false,
  setCreateIssueOpen: (v) => set({ createIssueOpen: v }),
  paletteOpen: false,
  setPaletteOpen: (v) => set({ paletteOpen: v }),

  /** 本地乐观更新 + 经 IPC 落盘，随后由快照推送收敛 */
  updateIssue: async (id, patch) => {
    const data = get().data
    const issue = data.issues.find((i) => i.id === id)
    if (!issue) return
    const merged: Issue = { ...issue, ...patch }
    set((s) => ({
      data: { ...s.data, issues: s.data.issues.map((i) => (i.id === id ? merged : i)) }
    }))
    const task = useApp.getState().snapshot?.tasks.find((t) => t.dirName === id)
    if (task && api) {
      try {
        await api.updateTask(id, issueToTaskPatch(merged), task.taskJsonMtime)
        await useApp.getState().refresh()
      } catch {
        await useApp.getState().refresh()
      }
    }
  },

  createIssue: async (input) => {
    if (!api) return null
    try {
      await api.createTask({
        title: input.name,
        description: input.description ?? '',
        priority: { urgent: 'P0', high: 'P1', medium: 'P2', low: 'P3', none: 'P2' }[input.priority]
      })
      await useApp.getState().refresh()
      const created = get().data.issues.find((i) => i.name === input.name)
      return created?.id ?? null
    } catch {
      return null
    }
  }
}))

/* ------- 派生工具 ------- */

export function useProject(): ReturnType<typeof deriveDataset>['projects'][number] {
  const { data } = useMy()
  return data.projects[0]
}

export const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

export function filterIssues(issues: Issue[], filters: IssueFilters): Issue[] {
  return issues.filter((i) => {
    if (filters.priority.length > 0 && !filters.priority.includes(i.priority)) return false
    const st = useMy.getState().data.states.find((s) => s.id === i.stateId)
    if (filters.stateGroup.length > 0 && st && !filters.stateGroup.includes(st.group)) return false
    if (filters.assigneeIds.length > 0 && (!i.assigneeId || !filters.assigneeIds.includes(i.assigneeId))) return false
    if (filters.labelIds.length > 0 && !i.labelIds.some((l) => filters.labelIds.includes(l))) return false
    return true
  })
}

/** 当前页面是否属于项目上下文（决定项目侧边栏是否显示） */
export function isProjectPage(page: string): boolean {
  return ['tasks', 'knowledge', 'spec', 'archive', 'inbox'].includes(page)
}

export { todayIso, TRELLIS_PROJECT_ID }
