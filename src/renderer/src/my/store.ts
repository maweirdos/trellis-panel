// 应用级外壳状态。路由唯一事实是主 store 的 useApp.page，这里只管
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
  sidebarCollapsed: boolean
  favorites: string[]
  savedViews: SavedView[]
}

export interface PinnedDoc {
  key: string
  path: string
  title: string
  x: number
  y: number
  z: number
}

export interface SavedView {
  id: string
  name: string
  filters: IssueFilters
  groupBy: GroupBy
  createdAt: number
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

const FAV_KEY = 'tpanel.my.favorites'
const VIEW_KEY = 'tpanel.my.views'

function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAV_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function saveFavorites(ids: string[]): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(ids.slice(0, 50)))
  } catch {
    // 容量敏感数据截断保存
  }
}

function loadSavedViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    return raw ? (JSON.parse(raw) as SavedView[]) : []
  } catch {
    return []
  }
}

function saveSavedViews(views: SavedView[]): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(views.slice(0, 30)))
  } catch {
    // 静默降级
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

  sidebarCollapsed: boolean
  toggleSidebar: () => void
  /** 钉住的文档浮层（会话级，可多开；z 为层叠序） */
  pinnedDocs: PinnedDoc[]
  zTop: number
  openPinnedDoc: (opts: { path: string; title: string }) => void
  closePinnedDoc: (key: string) => void
  movePinnedDoc: (key: string, x: number, y: number) => void
  bringDocToFront: (key: string) => void
  favorites: string[]
  toggleFavorite: (id: string) => void
  savedViews: SavedView[]
  saveView: (name: string, filters: IssueFilters, groupBy: GroupBy) => void
  applyView: (id: string) => void
  removeView: (id: string) => void

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
    savePrefs({ layout: l, groupBy: get().groupBy, orderBy: get().orderBy, sidebarCollapsed: get().sidebarCollapsed, favorites: get().favorites, savedViews: get().savedViews })
  },
  setGroupBy: (g) => {
    set({ groupBy: g })
    savePrefs({ layout: get().layout, groupBy: g, orderBy: get().orderBy, sidebarCollapsed: get().sidebarCollapsed, favorites: get().favorites, savedViews: get().savedViews })
  },
  setOrderBy: (o) => {
    set({ orderBy: o })
    savePrefs({ layout: get().layout, groupBy: get().groupBy, orderBy: o, sidebarCollapsed: get().sidebarCollapsed, favorites: get().favorites, savedViews: get().savedViews })
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

  sidebarCollapsed: prefs.sidebarCollapsed ?? false,
  pinnedDocs: [],
  zTop: 1,
  openPinnedDoc: (opts) => {
    const existing = get().pinnedDocs.find((d) => d.key === opts.path)
    const z = get().zTop + 1
    if (existing) {
      set((s) => ({
        pinnedDocs: s.pinnedDocs.map((d) => (d.key === opts.path ? { ...d, z } : d)),
        zTop: z
      }))
      return
    }
    const n = get().pinnedDocs.length
    const doc: PinnedDoc = {
      key: opts.path,
      path: opts.path,
      title: opts.title,
      x: 560 + (n % 5) * 40,
      y: 110 + (n % 5) * 42,
      z
    }
    set((s) => ({ pinnedDocs: [...s.pinnedDocs, doc], zTop: z }))
  },
  closePinnedDoc: (key) => set((s) => ({ pinnedDocs: s.pinnedDocs.filter((d) => d.key !== key) })),
  movePinnedDoc: (key, x, y) =>
    set((s) => ({ pinnedDocs: s.pinnedDocs.map((d) => (d.key === key ? { ...d, x, y } : d)) })),
  bringDocToFront: (key) => {
    const z = get().zTop + 1
    set((s) => ({ pinnedDocs: s.pinnedDocs.map((d) => (d.key === key ? { ...d, z } : d)), zTop: z }))
  },
  toggleSidebar: () => {
    const collapsed = !get().sidebarCollapsed
    set({ sidebarCollapsed: collapsed })
    savePrefs({
      layout: get().layout,
      groupBy: get().groupBy,
      orderBy: get().orderBy,
      sidebarCollapsed: collapsed,
      favorites: get().favorites,
      savedViews: get().savedViews
    })
    savePrefs({
      layout: get().layout,
      groupBy: get().groupBy,
      orderBy: get().orderBy,
      sidebarCollapsed: get().sidebarCollapsed,
      favorites: get().favorites,
      savedViews: get().savedViews
    })
  },
  favorites: loadFavorites(),
  toggleFavorite: (id) => {
    const cur = get().favorites
    const next = cur.includes(id) ? cur.filter((f) => f !== id) : [id, ...cur]
    set({ favorites: next })
    saveFavorites(next)
  },
  savedViews: loadSavedViews(),
  saveView: (name, filters, groupBy) => {
    const view: SavedView = { id: `v-${Date.now()}`, name: name.trim(), filters: { ...filters }, groupBy, createdAt: Date.now() }
    if (!view.name) return
    const next = [view, ...get().savedViews].slice(0, 30)
    set({ savedViews: next })
    saveSavedViews(next)
  },
  applyView: (id) => {
    const view = get().savedViews.find((v) => v.id === id)
    if (!view) return
    set({ filters: { ...defaultFilters, ...view.filters }, groupBy: view.groupBy })
  },
  removeView: (id) => {
    const next = get().savedViews.filter((v) => v.id !== id)
    set({ savedViews: next })
    saveSavedViews(next)
  },

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
        const result = await api.updateTask(task.path, issueToTaskPatch(merged), task.taskJsonMtime)
        if (result && result.ok === false) {
          useApp.getState().pushToast({ kind: 'error', title: '保存失败', body: `${issue.name}: ${result.error ?? '未知错误'}` })
        }
        await useApp.getState().refresh()
      } catch (err) {
        useApp.getState().pushToast({ kind: 'error', title: '保存失败', body: `${issue.name}: ${String(err).slice(0, 80)}` })
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
