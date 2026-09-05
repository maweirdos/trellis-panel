import { create } from 'zustand'
import type { ProjectSnapshot, Settings } from '../../shared/types'
import { api } from './api'

export type Page = 'dashboard' | 'tasks' | 'spec' | 'workspace' | 'archive' | 'cli' | 'settings'

interface AppState {
  snapshot: ProjectSnapshot | null
  settings: Settings | null
  page: Page
  openError: string | null
  starting: boolean
  openTaskDir: string | null
  openTaskArchived: boolean
  setPage: (p: Page) => void
  bootstrap: () => Promise<void>
  openProjectPath: (root: string) => Promise<void>
  pickAndOpen: () => Promise<void>
  closeProject: () => Promise<void>
  refresh: () => Promise<void>
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  showTask: (dirName: string | null, archived?: boolean) => void
}

export const useApp = create<AppState>((set, get) => ({
  snapshot: null,
  settings: null,
  page: 'dashboard',
  openError: null,
  starting: true,
  openTaskDir: null,
  openTaskArchived: false,

  setPage: (page) => set({ page }),

  bootstrap: async () => {
    const settings = await api.getSettings()
    set({ settings, starting: false })
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

  showTask: (dirName, archived = false) => set({ openTaskDir: dirName, openTaskArchived: archived })
}))
