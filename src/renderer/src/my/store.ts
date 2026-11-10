// 应用级外壳状态。路由唯一事实是主 store 的 useApp.page，这里只管
// 视图偏好（布局/分组/排序/筛选）、弹层（peek/命令面板/新建）与数据镜像。
import { create } from 'zustand'
import { api } from '../api'
import { rememberVisit } from './personal-history'
import { useApp, type Page } from '../store'
import { deriveDataset, issueToTaskPatch, todayIso, TRELLIS_PROJECT_ID } from './adapter'
import { getPageNavigation, projectRootKey, type WorkItemsView, type TeamView, type ToolView, type AgentView, type NavigationDomain, type KnowledgeView, type SettingsView } from './navigation'
import { loadProjectPreferences, saveProjectPreferences, type SavedView } from './project-preferences'
import { DEFAULT_SIDEBAR_WIDTH, normalizeCodeFontFamily, normalizeCodeFontSize, normalizeSidebarWidth, normalizeUiFontFamily, normalizeUiFontSize, syncNativeUiFontSize, UI_DENSITY_OPTIONS, UI_PREFERENCES_KEY, type CodeFontFamily, type CodeFontSize, type UiFontFamily, type UiFontSize } from './appearance'
import type { GroupBy, Issue, IssueFilters, OrderBy, Priority, ThemeMode, WorkItemLayout } from './types'
import type { TaskConversationTarget } from '../crux/task-conversation'

export type { SavedView } from './project-preferences'

const STORAGE_KEY = UI_PREFERENCES_KEY

interface PersistedPrefs {
  shellView: 'collaboration' | 'development'
  fontSize: UiFontSize
  fontFamily: UiFontFamily
  codeFontFamily: CodeFontFamily
  codeFontSize: CodeFontSize
  layout: WorkItemLayout
  groupBy: GroupBy
  orderBy: OrderBy
  sidebarCollapsed: boolean
  sidebarWidth: number
}

function loadPrefs(): Partial<PersistedPrefs> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Partial<PersistedPrefs> : {}
  } catch {
    return {}
  }
}

function savePrefs(prefs: Partial<PersistedPrefs>): void {
  try {
    // Retain legacy embedded fields without assigning them to any project.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadPrefs(), ...prefs }))
  } catch {
    // 隐私模式等场景下静默降级
  }
}

const prefs = loadPrefs()
const initialProjectRoot = projectRootKey(useApp.getState().snapshot?.meta.root)
const projectPrefs = loadProjectPreferences(initialProjectRoot)

export interface MyStore {
  taskConversationTarget: TaskConversationTarget | null
  setTaskConversationTarget: (target: TaskConversationTarget | null) => void
  shellView: PersistedPrefs['shellView']
  setShellView: (view: PersistedPrefs['shellView']) => void
  /** 视图模型镜像；快照更新时 syncFromSnapshot() 重建 */
  data: ReturnType<typeof deriveDataset>
  /** Normalized real snapshot root; null is an unbound browser preview. */
  projectRoot: string | null
  canOpenLocalProject: boolean
  syncFromSnapshot: () => void

  theme: ThemeMode
  setTheme: (t: ThemeMode) => void
  fontSize: UiFontSize
  setFontSize: (size: UiFontSize) => void
  fontFamily: UiFontFamily
  setFontFamily: (font: UiFontFamily) => void
  codeFontFamily: CodeFontFamily
  setCodeFontFamily: (font: CodeFontFamily) => void
  codeFontSize: CodeFontSize
  setCodeFontSize: (size: CodeFontSize) => void
  syncFontSizeFromStorage: () => void

  layout: WorkItemLayout
  teamView: TeamView
  setTeamView: (view: TeamView) => void
  toolView: ToolView
  setToolView: (view: ToolView) => void
  agentSessionTarget: string | null
  setAgentSessionTarget: (id: string | null) => void
  agentTarget: AgentView | null
  requestAgentView: (view: AgentView | null) => void
  knowledgeView: KnowledgeView
  setKnowledgeView: (view: KnowledgeView) => void
  settingsView: SettingsView
  setSettingsView: (view: SettingsView) => void
  modulePages: Partial<Record<NavigationDomain, Page>>
  rememberModulePage: (page: Page) => void
  workItemsView: WorkItemsView
  workItemsTab: 'all' | 'active' | 'backlog'
  itemsGroupBy: GroupBy
  setWorkItemsView: (view: WorkItemsView) => void
  setWorkItemsTab: (tab: 'all' | 'active' | 'backlog') => void
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
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
  toggleSidebar: () => void
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
  taskConversationTarget: null,
  setTaskConversationTarget: (taskConversationTarget) => set({ taskConversationTarget }),
  shellView: prefs.shellView === 'development' ? 'development' : 'collaboration',
  setShellView: (shellView) => {
    set({ shellView })
    savePrefs({ shellView })
  },
  data: currentDataset(),
  projectRoot: initialProjectRoot,
  canOpenLocalProject: Boolean(api),
  syncFromSnapshot: () => {
    const projectRoot = projectRootKey(useApp.getState().snapshot?.meta.root)
    const previousRoot = get().projectRoot
    const changed = projectRoot !== previousRoot
    set({
      data: currentDataset(),
      ...(changed ? {
        projectRoot,
        ...loadProjectPreferences(projectRoot),
        filters: { ...defaultFilters },
        groupBy: 'state' as const,
        itemsGroupBy: 'state' as const,
        teamView: 'overview' as const,
        toolView: 'git' as const,
        agentSessionTarget: null,
        taskConversationTarget: null,
        agentTarget: null,
        knowledgeView: 'materials' as const,
        settingsView: 'preferences' as const,
        modulePages: {},
        workItemsView: 'items' as const,
        workItemsTab: 'all' as const,
        orderBy: 'manual' as const,
        peekIssueId: null,
        createIssueOpen: false,
        paletteOpen: false
      } : {})
    })
    // A first bootstrap/deep link may already have selected a task in this root.
    if (changed && previousRoot !== null) {
      useApp.getState().showTask(null)
      useApp.setState({ taskExpandOrigin: null, taskMaterialTarget: null, specDocumentTarget: null })
    }
  },

  theme: useApp.getState().settings?.theme === 'light' ? 'light' : 'dark',
  setTheme: (t) => {
    set({ theme: t })
    if (api) void useApp.getState().saveSettings({ theme: t })
  },
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    get().setTheme(next)
  },

  fontSize: normalizeUiFontSize(prefs.fontSize),
  fontFamily: normalizeUiFontFamily(prefs.fontFamily),
  codeFontFamily: normalizeCodeFontFamily(prefs.codeFontFamily),
  codeFontSize: normalizeCodeFontSize(prefs.codeFontSize),
  setCodeFontFamily: (value) => {
    const codeFontFamily = normalizeCodeFontFamily(value)
    set({ codeFontFamily })
    savePrefs({ codeFontFamily })
  },
  setCodeFontSize: (value) => {
    const codeFontSize = normalizeCodeFontSize(value)
    set({ codeFontSize })
    savePrefs({ codeFontSize })
  },
  setFontFamily: (value) => {
    const fontFamily = normalizeUiFontFamily(value)
    set({ fontFamily })
    savePrefs({ fontFamily })
  },
  setFontSize: (value) => {
    const fontSize = normalizeUiFontSize(value)
    const sidebarWidth = UI_DENSITY_OPTIONS.find((option) => option.value === fontSize)?.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH
    set({ fontSize, sidebarWidth })
    savePrefs({ fontSize, sidebarWidth })
    syncNativeUiFontSize(api?.bootstrap, fontSize)
  },
  syncFontSizeFromStorage: () => {
    const stored = loadPrefs()
    set({ fontSize: normalizeUiFontSize(stored.fontSize), fontFamily: normalizeUiFontFamily(stored.fontFamily), codeFontFamily: normalizeCodeFontFamily(stored.codeFontFamily), codeFontSize: normalizeCodeFontSize(stored.codeFontSize), sidebarWidth: normalizeSidebarWidth(stored.sidebarWidth), sidebarCollapsed: stored.sidebarCollapsed === true, shellView: stored.shellView === 'development' ? 'development' : 'collaboration' })
  },

  layout: prefs.layout ?? 'list',
  teamView: 'overview',
  setTeamView: (teamView) => set({ teamView }),
  toolView: 'git',
  setToolView: (toolView) => set({ toolView }),
  agentSessionTarget: null,
  setAgentSessionTarget: (agentSessionTarget) => set({ agentSessionTarget }),
  agentTarget: null,
  requestAgentView: (agentTarget) => set({ agentTarget }),
  knowledgeView: 'materials',
  setKnowledgeView: (knowledgeView) => set({ knowledgeView }),
  settingsView: 'preferences',
  setSettingsView: (settingsView) => set({ settingsView }),
  modulePages: {},
  rememberModulePage: (page) => {
    const domain = getPageNavigation(page).domain
    if (get().modulePages[domain] !== page) set({ modulePages: { ...get().modulePages, [domain]: page }, ...(page === 'architecture' || page === 'studio' ? { toolView: page } : {}) })
  },
  workItemsView: 'items',
  workItemsTab: 'all',
  itemsGroupBy: 'state',
  setWorkItemsView: (view) => set({
    workItemsView: view,
    groupBy: view === 'iterations' ? 'cycle' : get().itemsGroupBy
  }),
  setWorkItemsTab: (tab) => set({ workItemsTab: tab }),
  groupBy: 'state',
  orderBy: prefs.orderBy ?? 'manual',
  filters: defaultFilters,
  display: { showEmptyGroups: false, showSubIssues: true },
  setLayout: (l) => {
    set({ layout: l })
    savePrefs({ fontSize: get().fontSize, layout: l, groupBy: get().groupBy, orderBy: get().orderBy, sidebarCollapsed: get().sidebarCollapsed, sidebarWidth: get().sidebarWidth })
  },
  setGroupBy: (g) => {
    set({ groupBy: g, ...(get().workItemsView === 'items' ? { itemsGroupBy: g } : {}) })
    savePrefs({ fontSize: get().fontSize, layout: get().layout, groupBy: g, orderBy: get().orderBy, sidebarCollapsed: get().sidebarCollapsed, sidebarWidth: get().sidebarWidth })
  },
  setOrderBy: (o) => {
    set({ orderBy: o })
    savePrefs({ fontSize: get().fontSize, layout: get().layout, groupBy: get().groupBy, orderBy: o, sidebarCollapsed: get().sidebarCollapsed, sidebarWidth: get().sidebarWidth })
  },
  toggleFilter: (key, value) => {
    const cur = get().filters[key] as unknown[]
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
    set({ filters: { ...get().filters, [key]: next } })
  },
  clearFilters: () => set({ filters: defaultFilters }),
  setDisplay: (patch) => set({ display: { ...get().display, ...patch } }),

  peekIssueId: null,
  openIssue: (id) => {
    const issue = get().data.issues.find((item) => item.id === id)
    if (issue) rememberVisit({ kind: 'task', target: id, title: issue.name })
    set({ peekIssueId: id })
  },
  closeIssue: () => set({ peekIssueId: null }),
  createIssueOpen: false,
  setCreateIssueOpen: (v) => set({ createIssueOpen: v }),
  paletteOpen: false,
  setPaletteOpen: (v) => set({ paletteOpen: v }),

  sidebarCollapsed: prefs.sidebarCollapsed === true,
  sidebarWidth: normalizeSidebarWidth(prefs.sidebarWidth),
  setSidebarWidth: (value) => {
    const sidebarWidth = normalizeSidebarWidth(value)
    if (get().sidebarWidth === sidebarWidth) return
    set({ sidebarWidth })
    savePrefs({ fontSize: get().fontSize, layout: get().layout, groupBy: get().groupBy, orderBy: get().orderBy, sidebarCollapsed: get().sidebarCollapsed, sidebarWidth })
  },
  toggleSidebar: () => {
    const collapsed = !get().sidebarCollapsed
    set({ sidebarCollapsed: collapsed })
    savePrefs({
      fontSize: get().fontSize,
      layout: get().layout,
      groupBy: get().groupBy,
      orderBy: get().orderBy,
      sidebarCollapsed: collapsed,
      sidebarWidth: get().sidebarWidth
    })
  },
  favorites: projectPrefs.favorites,
  toggleFavorite: (id) => {
    const cur = get().favorites
    const next = cur.includes(id) ? cur.filter((f) => f !== id) : [id, ...cur]
    set({ favorites: next })
    saveProjectPreferences(get().projectRoot, { favorites: next, savedViews: get().savedViews })
  },
  savedViews: projectPrefs.savedViews,
  saveView: (name, filters, groupBy) => {
    const view: SavedView = { id: `v-${Date.now()}`, name: name.trim(), filters: { ...filters }, groupBy, createdAt: Date.now() }
    if (!view.name) return
    const next = [view, ...get().savedViews].slice(0, 30)
    set({ savedViews: next })
    saveProjectPreferences(get().projectRoot, { favorites: get().favorites, savedViews: next })
  },
  applyView: (id) => {
    const view = get().savedViews.find((v) => v.id === id)
    if (!view) return
    set({ filters: { ...defaultFilters, ...view.filters }, groupBy: view.groupBy, itemsGroupBy: view.groupBy, workItemsView: 'items', workItemsTab: 'all' })
  },
  removeView: (id) => {
    const next = get().savedViews.filter((v) => v.id !== id)
    set({ savedViews: next })
    saveProjectPreferences(get().projectRoot, { favorites: get().favorites, savedViews: next })
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
        } else if (result && result.ignored && result.ignored.length > 0) {
          // 白名单外字段未写入：如实告知，不冒充保存成功
          useApp.getState().pushToast({
            kind: 'warn',
            title: '部分字段未保存',
            body: `${issue.name}：${result.ignored.join('、')} 由 Trellis 工作流管理，面板不直接修改`
          })
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

export { todayIso, TRELLIS_PROJECT_ID }
