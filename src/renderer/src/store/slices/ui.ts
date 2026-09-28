import type { AppSlice, UiSlice } from '../types'

export const uiSlice: AppSlice<UiSlice> = (set) => ({
  page: 'dashboard',
  capsuleMode: new URLSearchParams(window.location.search).get('mode') === 'capsule',
  quickTodoMode: new URLSearchParams(window.location.search).get('mode') === 'quicktodo',
  sidebarCollapsed: localStorage.getItem('tpanel.sidebarCollapsed') === 'true',
  intakeOpen: false,

  toggleSidebar: () => {
    set((s) => {
      const next = !s.sidebarCollapsed
      try {
        localStorage.setItem('tpanel.sidebarCollapsed', String(next))
      } catch {}
      return { sidebarCollapsed: next }
    })
  },

  setSidebarCollapsed: (collapsed) => {
    try {
      localStorage.setItem('tpanel.sidebarCollapsed', String(collapsed))
    } catch {}
    set({ sidebarCollapsed: collapsed })
  },

  setPage: (page) => set({ page, openTaskDir: null, openTaskArchived: false }),

  setIntakeOpen: (on) => set({ intakeOpen: on })
})
