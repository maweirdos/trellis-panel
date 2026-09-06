import { create } from 'zustand'
import type { AiRunInfo, InboxItem, ProjectSnapshot, Settings, ToastEvent } from '../../shared/types'
import { api } from './api'

export type Page =
  | 'dashboard'
  | 'inbox'
  | 'tasks'
  | 'ai'
  | 'spec'
  | 'workspace'
  | 'archive'
  | 'team'
  | 'jira'
  | 'settings'

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

/** AI background run card in the workbench */
export interface AiRunCard extends AiRunInfo {
  status: 'running' | 'done' | 'failed' | 'aborted'
  lines: Array<{ text: string; err: boolean }>
  endedAt?: number
  code?: number | null
}

let toastSeq = 1

const INBOX_KEY = 'tpanel.inbox.v1'

function loadInbox(): Record<string, InboxEntry> {
  try {
    return JSON.parse(localStorage.getItem(INBOX_KEY) ?? '{}') as Record<string, InboxEntry>
  } catch {
    return {}
  }
}

function saveInbox(map: Record<string, InboxEntry>): void {
  try {
    // cap stored entries — keep newest 200
    const entries = Object.entries(map).sort((a, b) => b[1].ts - a[1].ts).slice(0, 200)
    localStorage.setItem(INBOX_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // persistence is best-effort
  }
}

interface AppState {
  snapshot: ProjectSnapshot | null
  settings: Settings | null
  page: Page
  openError: string | null
  starting: boolean
  openTaskDir: string | null
  openTaskArchived: boolean
  capsuleMode: boolean
  toasts: ToastItem[]
  /** artifact viewer tabs (multi-file, preview-tab model) */
  viewerTabs: ViewerTab[]
  viewerActive: string | null
  intakeOpen: boolean
  inbox: Record<string, InboxEntry>
  aiRuns: AiRunCard[]
  setPage: (p: Page) => void
  bootstrap: () => Promise<void>
  openProjectPath: (root: string) => Promise<void>
  pickAndOpen: () => Promise<void>
  closeProject: () => Promise<void>
  refresh: () => Promise<void>
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  showTask: (dirName: string | null, archived?: boolean) => void
  pushToast: (t: ToastEvent) => void
  dismissToast: (id: number) => void
  openArtifact: (f: ViewerTab['file'], pinned?: boolean) => void
  closeArtifact: (path: string) => void
  pinArtifact: (path: string, pinned: boolean) => void
  setViewerActive: (path: string) => void
  setIntakeOpen: (on: boolean) => void
  aiAddRun: (run: AiRunInfo) => void
  aiAppendLog: (runId: number, stream: 'stdout' | 'stderr', data: string) => void
  aiFinishRun: (runId: number, code: number | null, aborted: boolean) => void
  inboxAdd: (items: InboxItem[]) => void
  inboxSetState: (dirName: string, state: InboxState) => void
  inboxAcceptAll: () => void
}

export const useApp = create<AppState>((set, get) => ({
  snapshot: null,
  settings: null,
  page: 'dashboard',
  openError: null,
  starting: true,
  openTaskDir: null,
  openTaskArchived: false,
  capsuleMode: new URLSearchParams(window.location.search).get('mode') === 'capsule',
  toasts: [],
  viewerTabs: [],
  viewerActive: null,
  intakeOpen: false,
  inbox: loadInbox(),
  aiRuns: [],

  setPage: (page) => set({ page }),

  bootstrap: async () => {
    const settings = await api.getSettings()
    set({ settings, starting: false })
    // 胶囊窗口与主窗口共享主进程的项目状态，只需拉取当前快照。
    if (get().capsuleMode) {
      const snap = await api.getSnapshot()
      if (snap) set({ snapshot: snap })
      return
    }
    const last = settings.recentProjects[0]
    if (last) {
      await get().openProjectPath(last)
    }
  },

  openProjectPath: async (root) => {
    set({ openError: null })
    const res = await api.openProject(root)
    if (res.ok && res.snapshot) {
      set({ snapshot: res.snapshot, page: 'dashboard', openTaskDir: null })
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
    set({ snapshot: null, openTaskDir: null })
  },

  refresh: async () => {
    const snap = await api.getSnapshot()
    if (snap) set({ snapshot: snap })
  },

  saveSettings: async (patch) => {
    const next = await api.setSettings(patch)
    set({ settings: next })
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

  aiAddRun: (run: AiRunInfo) =>
    set((s) => ({
      aiRuns: [{ ...run, status: 'running' as const, lines: [] }, ...s.aiRuns].slice(0, 30)
    })),

  aiAppendLog: (runId: number, stream: 'stdout' | 'stderr', data: string) => {
    set((s) => ({
      aiRuns: s.aiRuns.map((r) =>
        r.runId === runId
          ? {
              ...r,
              lines: [...r.lines, ...data.split('\n').filter((l) => l !== '').map((text) => ({ text, err: stream === 'stderr' }))].slice(-800)
            }
          : r
      )
    }))
  },

  aiFinishRun: (runId: number, code: number | null, aborted: boolean) => {
    set((s) => ({
      aiRuns: s.aiRuns.map((r) =>
        r.runId === runId
          ? { ...r, status: aborted ? 'aborted' : code === 0 ? 'done' : 'failed', code, endedAt: Date.now() }
          : r
      )
    }))
  },

  inboxAdd: (items) => {
    set((s) => {
      const next = { ...s.inbox }
      for (const it of items) {
        if (!next[it.dirName]) next[it.dirName] = { ...it, state: 'pending' }
      }
      saveInbox(next)
      return { inbox: next }
    })
  },

  inboxSetState: (dirName, state) => {
    set((s) => {
      const cur = s.inbox[dirName]
      if (!cur) return s
      const next = { ...s.inbox, [dirName]: { ...cur, state } }
      saveInbox(next)
      return { inbox: next }
    })
  },

  inboxAcceptAll: () => {
    set((s) => {
      const next: Record<string, InboxEntry> = {}
      for (const [k, v] of Object.entries(s.inbox)) {
        next[k] = v.state === 'pending' ? { ...v, state: 'accepted' } : v
      }
      saveInbox(next)
      return { inbox: next }
    })
  }
}))
