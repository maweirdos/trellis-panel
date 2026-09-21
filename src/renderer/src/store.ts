import { create } from 'zustand'
import { WEKNORA_DEFAULTS } from '../../shared/types'
import type { InboxItem, ProjectSnapshot, Settings, ToastEvent, TodoItem } from '../../shared/types'
import { api } from './api'

/**
 * 新增设置节在"渲染层新代码 + 主进程旧代码"混跑（dev 热更新只刷渲染层）或
 * 旧 settings.json 下会缺失，这里统一补默认值，页面侧不再假设节一定存在。
 */
function normalizeSettings(s: Settings): Settings {
  return { ...s, weknora: { ...WEKNORA_DEFAULTS, ...(s.weknora ?? {}) } }
}

export type Page =
  | 'dashboard'
  | 'inbox'
  | 'tasks'
  | 'knowledge'
  | 'spec'
  | 'archive'
  | 'channels'
  | 'team'
  | 'jira'
  | 'architecture'
  | 'studio'
  | 'models'
  | 'settings'
  | 'gateway'

export interface ToastItem extends ToastEvent {
  id: number
}

/** One open tab in the artifact viewer — VS Code style preview vs pinned */
export interface ViewerTab {
  file: { name: string; path: string; kind: 'file' | 'dir'; size: number; mtime: number; ext: string }
  pinned: boolean
}

export type InboxState = 'pending' | 'accepted' | 'snoozed' | 'dismissed'

export interface InboxEntry extends InboxItem {
  state: InboxState
}

let toastSeq = 1

const INBOX_KEY = 'tpanel.inbox.v2'

function inboxStorageKey(projectRoot: string): string {
  return `${INBOX_KEY}.${encodeURIComponent(projectRoot)}`
}

function loadInbox(projectRoot: string | null): Record<string, InboxEntry> {
  if (!projectRoot) return {}
  try {
    return JSON.parse(localStorage.getItem(inboxStorageKey(projectRoot)) ?? '{}') as Record<string, InboxEntry>
  } catch {
    return {}
  }
}

function saveInbox(map: Record<string, InboxEntry>, projectRoot: string | null): void {
  if (!projectRoot) return
  try {
    // cap stored entries — keep newest 200
    const entries = Object.entries(map).sort((a, b) => b[1].ts - a[1].ts).slice(0, 200)
    localStorage.setItem(inboxStorageKey(projectRoot), JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // persistence is best-effort
  }
}

/**
 * 将收件箱数据与项目最新快照进行对齐（Reconciliation）：
 * 1. 物理删除的任务（既不在 tasks 也不在 archived 中）：彻底从 inbox 剔除并持久化
 * 2. 已归档任务：从 inbox 剔除（无需在待确认中展示）
 * 3. 外部已推进任务（状态非 planning，如 in_progress/review/completed）：自动标记为 accepted
 */
export function reconcileInbox(
  inbox: Record<string, InboxEntry>,
  snapshot: ProjectSnapshot | null,
  projectRoot: string | null
): Record<string, InboxEntry> {
  if (!snapshot || !projectRoot) return inbox
  const activeDirs = new Set(snapshot.tasks.map((t) => t.dirName))
  const archivedDirs = new Set(snapshot.archived.map((t) => t.dirName))

  let changed = false
  const next: Record<string, InboxEntry> = {}

  for (const [dir, entry] of Object.entries(inbox)) {
    // 1. 磁盘上已被删除或已被归档：直接移除
    if (!activeDirs.has(dir) || archivedDirs.has(dir)) {
      changed = true
      continue
    }

    // 2. 外部已推进到非 planning 状态：自动标记为已确认
    const task = snapshot.tasks.find((t) => t.dirName === dir)
    const st = (task?.record?.status ?? '').toLowerCase()
    if (st && st !== 'planning' && entry.state === 'pending') {
      next[dir] = { ...entry, state: 'accepted' }
      changed = true
      continue
    }

    next[dir] = entry
  }

  if (changed) {
    saveInbox(next, projectRoot)
  }
  return next
}

interface AppState {
  snapshot: ProjectSnapshot | null
  setSnapshot: (snapshot: ProjectSnapshot) => void
  settings: Settings | null
  page: Page
  openError: string | null
  starting: boolean
  /** bootstrap 完成（项目已打开）——之前的桥接聚焦先暂存，避免被 openProjectPath 重置 */
  bootstrapped: boolean
  pendingFocusDir: string | null
  openTaskDir: string | null
  openTaskArchived: boolean
  capsuleMode: boolean
  toasts: ToastItem[]
  /** artifact viewer tabs (multi-file, preview-tab model) */
  viewerTabs: ViewerTab[]
  viewerActive: string | null
  intakeOpen: boolean
  inboxProjectRoot: string | null
  inbox: Record<string, InboxEntry>
  todos: TodoItem[]
  loadTodos: () => Promise<void>
  saveTodo: (input: Parameters<typeof api.todoSave>[0]) => Promise<boolean>
  deleteTodo: (id: string) => Promise<boolean>
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setPage: (p: Page) => void
  bootstrap: () => Promise<void>
  openProjectPath: (root: string) => Promise<void>
  pickAndOpen: () => Promise<void>
  closeProject: () => Promise<void>
  setInboxProject: (projectRoot: string | null) => void
  refresh: () => Promise<void>
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  toggleTheme: () => void
  showTask: (dirName: string | null, archived?: boolean) => void
  pushToast: (t: ToastEvent) => void
  dismissToast: (id: number) => void
  openArtifact: (f: ViewerTab['file'], pinned?: boolean) => void
  closeArtifact: (path: string) => void
  pinArtifact: (path: string, pinned: boolean) => void
  setViewerActive: (path: string) => void
  setIntakeOpen: (on: boolean) => void
  inboxAdd: (items: InboxItem[]) => void
  inboxSetState: (dirName: string, state: InboxState) => void
  inboxRemove: (dirName: string) => void
  inboxAcceptAll: () => void
}

export const useApp = create<AppState>((set, get) => ({
  snapshot: null,
  settings: null,
  page: 'dashboard',
  openError: null,
  starting: true,
  bootstrapped: false,
  pendingFocusDir: null,
  openTaskDir: null,
  openTaskArchived: false,
  capsuleMode: new URLSearchParams(window.location.search).get('mode') === 'capsule',
  toasts: [],
  viewerTabs: [],
  viewerActive: null,
  intakeOpen: false,
  inboxProjectRoot: null,
  inbox: loadInbox(null),
  todos: [],

  loadTodos: async () => {
    const res = await api.todoList()
    if (res.ok && res.todos) {
      set({ todos: res.todos })
    }
  },

  saveTodo: async (input) => {
    const res = await api.todoSave(input)
    if (res.ok && res.todo) {
      await get().loadTodos()
      get().pushToast({ kind: 'success', title: '待办已保存', body: res.todo.filePath })
      return true
    } else {
      get().pushToast({ kind: 'error', title: '保存待办失败', body: res.error })
      return false
    }
  },

  deleteTodo: async (id) => {
    const res = await api.todoDelete(id)
    if (res.ok) {
      await get().loadTodos()
      get().pushToast({ kind: 'success', title: '待办已删除', body: id })
      return true
    } else {
      get().pushToast({ kind: 'error', title: '删除待办失败', body: res.error })
      return false
    }
  },

  sidebarCollapsed: localStorage.getItem('tpanel.sidebarCollapsed') === 'true',

  toggleSidebar: () => {
    const next = !get().sidebarCollapsed
    try {
      localStorage.setItem('tpanel.sidebarCollapsed', String(next))
    } catch {}
    set({ sidebarCollapsed: next })
  },

  setSidebarCollapsed: (collapsed) => {
    try {
      localStorage.setItem('tpanel.sidebarCollapsed', String(collapsed))
    } catch {}
    set({ sidebarCollapsed: collapsed })
  },

  setPage: (page) => set({ page, openTaskDir: null, openTaskArchived: false }),

  setSnapshot: (snapshot) => {
    set((s) => {
      const root = snapshot.meta.root
      const nextInbox = reconcileInbox(s.inbox, snapshot, root)
      return {
        snapshot,
        inbox: nextInbox,
        inboxProjectRoot: root
      }
    })
    void get().loadTodos()
  },

  bootstrap: async () => {
    const settings = normalizeSettings(await api.getSettings())
    set({ settings, starting: false })
    // 胶囊窗口与主窗口共享主进程的项目状态，只需拉取当前快照。
    if (get().capsuleMode) {
      const snap = await api.getSnapshot()
      if (snap) get().setSnapshot(snap)
      return
    }
    const last = settings.recentProjects[0]
    if (last) {
      await get().openProjectPath(last)
    }
    void get().loadTodos()
    // 冷启动深链兜底：live 推送若早于 bootstrap 到达会被 openProjectPath 重置，
    // 所以这里统一兜底消费一次（live 已消费时 pull 返回 null，用暂存的 dir 补上）
    const pending = await api.pullPendingFocus()
    const focusDir = pending?.taskDir ?? get().pendingFocusDir
    const focusRoot = pending?.root ?? null
    if (focusDir) {
      if (focusRoot && get().snapshot?.meta.root !== focusRoot) {
        await get().openProjectPath(focusRoot)
      }
      if (get().snapshot) {
        set({ page: 'tasks' })
        get().showTask(focusDir)
      }
      set({ pendingFocusDir: null })
    }
    set({ bootstrapped: true })
  },

  openProjectPath: async (root) => {
    set({ openError: null })
    const res = await api.openProject(root)
    if (res.ok && res.snapshot) {
      const rootPath = res.snapshot.meta.root
      const rawInbox = loadInbox(rootPath)
      const reconciled = reconcileInbox(rawInbox, res.snapshot, rootPath)
      set({
        snapshot: res.snapshot,
        page: 'dashboard',
        openTaskDir: null,
        inboxProjectRoot: rootPath,
        inbox: reconciled
      })
      void get().loadTodos()
    } else {
      set({ openError: res.error ?? '打开失败' })
    }
  },

  pickAndOpen: async () => {
    const root = await api.pickProject()
    if (root) await get().openProjectPath(root)
  },

  closeProject: async () => {
    await api.closeProject()
    set({ snapshot: null, openTaskDir: null, inboxProjectRoot: null, inbox: {}, todos: [] })
  },

  setInboxProject: (projectRoot) => {
    const raw = loadInbox(projectRoot)
    const reconciled = reconcileInbox(raw, get().snapshot, projectRoot)
    set({ inboxProjectRoot: projectRoot, inbox: reconciled })
  },

  refresh: async () => {
    const snap = await api.getSnapshot()
    if (snap) get().setSnapshot(snap)
  },

  saveSettings: async (patch) => {
    const next = normalizeSettings(await api.setSettings(patch))
    set({ settings: next })
  },

  toggleTheme: () => {
    const cur = get().settings
    if (cur) void get().saveSettings({ theme: cur.theme === 'dark' ? 'light' : 'dark' })
  },

  showTask: (dirName, archived = false) => set({ openTaskDir: dirName, openTaskArchived: archived }),

  pushToast: (t) => {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }))
    setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 9000 : 5000)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  /** VS Code preview-tab model: a new unpinned file replaces the existing preview tab */
  openArtifact: (file, pinned = false) => {
    set((s) => {
      const existing = s.viewerTabs.find((t) => t.file.path === file.path)
      let tabs = s.viewerTabs
      if (existing) {
        tabs = s.viewerTabs.map((t) => (t.file.path === file.path ? { ...t, pinned: t.pinned || pinned } : t))
      } else if (pinned) {
        tabs = [...s.viewerTabs, { file, pinned: true }]
      } else {
        const previewIdx = s.viewerTabs.findIndex((t) => !t.pinned)
        if (previewIdx >= 0) {
          tabs = s.viewerTabs.map((t, i) => (i === previewIdx ? { file, pinned: false } : t))
        } else {
          tabs = [...s.viewerTabs, { file, pinned: false }]
        }
      }
      return { viewerTabs: tabs, viewerActive: file.path }
    })
  },

  closeArtifact: (path) => {
    set((s) => {
      const idx = s.viewerTabs.findIndex((t) => t.file.path === path)
      const tabs = s.viewerTabs.filter((t) => t.file.path !== path)
      const active =
        s.viewerActive === path ? (tabs[Math.min(idx, tabs.length - 1)]?.file.path ?? null) : s.viewerActive
      return { viewerTabs: tabs, viewerActive: active }
    })
  },

  pinArtifact: (path, pinned) =>
    set((s) => ({ viewerTabs: s.viewerTabs.map((t) => (t.file.path === path ? { ...t, pinned } : t)) })),

  setViewerActive: (path) => set({ viewerActive: path }),

  setIntakeOpen: (on) => set({ intakeOpen: on }),

  inboxAdd: (items) => {
    set((s) => {
      const next = { ...s.inbox }
      for (const it of items) {
        if (!next[it.dirName]) next[it.dirName] = { ...it, state: 'pending' }
      }
      const reconciled = reconcileInbox(next, s.snapshot, s.inboxProjectRoot)
      return { inbox: reconciled }
    })
  },

  inboxSetState: (dirName, state) => {
    set((s) => {
      const cur = s.inbox[dirName]
      if (!cur) return s
      const next = { ...s.inbox, [dirName]: { ...cur, state } }
      saveInbox(next, s.inboxProjectRoot)
      return { inbox: next }
    })
  },

  inboxRemove: (dirName) => {
    set((s) => {
      if (!s.inbox[dirName]) return s
      const next = { ...s.inbox }
      delete next[dirName]
      saveInbox(next, s.inboxProjectRoot)
      return { inbox: next }
    })
  },

  inboxAcceptAll: () => {
    set((s) => {
      const next: Record<string, InboxEntry> = {}
      for (const [k, v] of Object.entries(s.inbox)) {
        next[k] = v.state === 'pending' ? { ...v, state: 'accepted' } : v
      }
      saveInbox(next, s.inboxProjectRoot)
      return { inbox: next }
    })
  }
}))
