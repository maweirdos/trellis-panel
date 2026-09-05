import { create } from 'zustand'
import type { ProjectSnapshot, Settings, ToastEvent } from '../../shared/types'
import { api } from './api'

export type Page =
  | 'dashboard'
  | 'tasks'
  | 'spec'
  | 'workspace'
  | 'archive'
  | 'team'
  | 'jira'
  | 'cli'
  | 'settings'

export interface ToastItem extends ToastEvent {
  id: number
}

let toastSeq = 1

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

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))
