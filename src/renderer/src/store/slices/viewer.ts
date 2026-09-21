import type { AppSlice, ViewerSlice } from '../types'

export const viewerSlice: AppSlice<ViewerSlice> = (set) => ({
  viewerTabs: [],
  viewerActive: null,

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

  setViewerActive: (path) => set({ viewerActive: path })
})
