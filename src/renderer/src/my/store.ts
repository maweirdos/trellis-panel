// 模块内自治 zustand store（独立于面板主 store；持久化仅 UI 偏好，键前缀 tpanel.my.）
import { create } from 'zustand'
import { createDemoDataset } from './data'
import type {
  GroupBy,
  Issue,
  IssueFilters,
  OrderBy,
  MyDataset,
  MyPage,
  Priority,
  ThemeMode,
  WorkItemLayout
} from './types'

const STORAGE_KEY = 'tpanel.my.ui'

interface PersistedPrefs {
  theme: ThemeMode
  layout: WorkItemLayout
  groupBy: GroupBy
  orderBy: OrderBy
  customAccent: string | null
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
    // 持久化失败静默降级（隐私模式等）
  }
}

const prefs = loadPrefs()
const dataset: MyDataset = createDemoDataset()

export interface MyStore {
  data: MyDataset

  // 主题
  theme: ThemeMode
  customAccent: string | null
  setTheme: (t: ThemeMode) => void
  setCustomAccent: (hex: string | null) => void

  // 导航
  page: MyPage
  activeProjectId: string
  navigateWorkspace: (page: MyPage) => void
  navigateProject: (projectId: string, page?: MyPage) => void

  // 工作项视图偏好
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

  // 弹层与选中
  peekIssueId: string | null
  openIssue: (id: string) => void
  closeIssue: () => void
  createIssueOpen: boolean
  setCreateIssueOpen: (v: boolean) => void
  createProjectOpen: boolean
  setCreateProjectOpen: (v: boolean) => void
  paletteOpen: boolean
  setPaletteOpen: (v: boolean) => void
  selectedCycleId: string | null
  setSelectedCycle: (id: string | null) => void
  selectedModuleId: string | null
  setSelectedModule: (id: string | null) => void
  selectedViewId: string | null
  setSelectedView: (id: string | null) => void
  selectedPageDocId: string
  setSelectedPageDoc: (id: string) => void
  projectSettingsTab: 'general' | 'states' | 'labels' | 'members' | 'features'
  setProjectSettingsTab: (t: MyStore['projectSettingsTab']) => void
  workspaceSettingsTab: 'general' | 'members'
  setWorkspaceSettingsTab: (t: MyStore['workspaceSettingsTab']) => void

  // 数据操作（纯内存）
  updateIssue: (id: string, patch: Partial<Issue>) => void
  createIssue: (input: { projectId: string; name: string; priority: Priority; description?: string }) => string
  markNotificationRead: (id: string) => void
  toggleProjectFavorite: (id: string) => void
  updatePageDoc: (id: string, patch: { title?: string; content?: string; emoji?: string }) => void
  setIntakeStatus: (id: string, status: 'pending' | 'accepted' | 'declined' | 'duplicate' | 'snoozed') => void
}

function persist(s: MyStore): void {
  savePrefs({
    theme: s.theme,
    layout: s.layout,
    groupBy: s.groupBy,
    orderBy: s.orderBy,
    customAccent: s.customAccent
  })
}

const defaultFilters: IssueFilters = { priority: [], stateGroup: [], assigneeIds: [], labelIds: [] }

export const useMy = create<MyStore>()((set, get) => ({
  data: dataset,

  theme: prefs.theme ?? 'dark',
  customAccent: prefs.customAccent ?? null,
  setTheme: (t) => {
    set({ theme: t })
    persist(get())
  },
  setCustomAccent: (hex) => {
    set({ customAccent: hex })
    persist(get())
  },

  page: 'your-work',
  activeProjectId: 'p-web',
  navigateWorkspace: (page) => set({ page, activeProjectId: '' }),
  navigateProject: (projectId, page = 'work-items') => set({ page, activeProjectId: projectId }),

  layout: prefs.layout ?? 'list',
  groupBy: prefs.groupBy ?? 'state',
  orderBy: prefs.orderBy ?? 'manual',
  filters: defaultFilters,
  display: { showEmptyGroups: false, showSubIssues: true },
  setLayout: (l) => {
    set({ layout: l })
    persist(get())
  },
  setGroupBy: (g) => {
    set({ groupBy: g })
    persist(get())
  },
  setOrderBy: (o) => {
    set({ orderBy: o })
    persist(get())
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
  createProjectOpen: false,
  setCreateProjectOpen: (v) => set({ createProjectOpen: v }),
  paletteOpen: false,
  setPaletteOpen: (v) => set({ paletteOpen: v }),
  selectedCycleId: null,
  setSelectedCycle: (id) => set({ selectedCycleId: id }),
  selectedModuleId: null,
  setSelectedModule: (id) => set({ selectedModuleId: id }),
  selectedViewId: null,
  setSelectedView: (id) => set({ selectedViewId: id }),
  selectedPageDocId: dataset.pages[0]?.id ?? '',
  setSelectedPageDoc: (id) => set({ selectedPageDocId: id }),
  projectSettingsTab: 'general',
  setProjectSettingsTab: (t) => set({ projectSettingsTab: t }),
  workspaceSettingsTab: 'general',
  setWorkspaceSettingsTab: (t) => set({ workspaceSettingsTab: t }),

  updateIssue: (id, patch) =>
    set((s) => {
      const issues = s.data.issues.map((i) => (i.id === id ? { ...i, ...patch } : i))
      return { data: { ...s.data, issues } }
    }),
  createIssue: (input) => {
    const { data } = get()
    const seq = data.issues.filter((i) => i.projectId === input.projectId).length + 1
    const id = `${input.projectId}-new-${seq}-${Date.now()}`
    const issue: Issue = {
      id,
      projectId: input.projectId,
      sequenceId: seq,
      name: input.name,
      description: input.description ?? '',
      stateId: 'st-todo',
      priority: input.priority,
      assigneeId: 'me',
      labelIds: [],
      cycleId: null,
      moduleId: null,
      startDate: null,
      dueDate: null,
      createdAt: new Date().toISOString().slice(0, 10),
      parentId: null,
      subIssueIds: [],
      activity: [{ id: `${id}-a1`, actorId: 'me', verb: '创建了工作项', at: '刚刚' }],
      comments: [],
      completedAt: null
    }
    set({ data: { ...data, issues: [issue, ...data.issues] } })
    return id
  },
  markNotificationRead: (id) =>
    set((s) => ({
      data: {
        ...s.data,
        notifications: s.data.notifications.map((n) => (n.id === id ? { ...n, read: true } : n))
      }
    })),
  toggleProjectFavorite: (id) =>
    set((s) => ({
      data: {
        ...s.data,
        projects: s.data.projects.map((p) => (p.id === id ? { ...p, favorite: !p.favorite } : p))
      }
    })),
  updatePageDoc: (id, patch) =>
    set((s) => ({
      data: {
        ...s.data,
        pages: s.data.pages.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: '刚刚' } : p))
      }
    })),
  setIntakeStatus: (id, status) =>
    set((s) => ({
      data: {
        ...s.data,
        intake: s.data.intake.map((i) => (i.id === id ? { ...i, status } : i))
      }
    }))
}))

/* ------- 派生选择器（页面复用） ------- */

export function useProject(): MyDataset['projects'][number] {
  const { data, activeProjectId } = useMy()
  return data.projects.find((p) => p.id === activeProjectId) ?? data.projects[0]
}

export const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

export function filterIssues(issues: Issue[], filters: IssueFilters): Issue[] {
  return issues.filter((i) => {
    if (filters.priority.length > 0 && !filters.priority.includes(i.priority)) return false
    const st = dataset.states.find((s) => s.id === i.stateId)
    if (filters.stateGroup.length > 0 && st && !filters.stateGroup.includes(st.group)) return false
    if (filters.assigneeIds.length > 0 && (!i.assigneeId || !filters.assigneeIds.includes(i.assigneeId))) return false
    if (filters.labelIds.length > 0 && !i.labelIds.some((l) => filters.labelIds.includes(l))) return false
    return true
  })
}
