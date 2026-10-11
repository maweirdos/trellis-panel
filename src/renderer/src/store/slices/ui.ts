import type { AppSlice, UiSlice } from '../types'

export const uiSlice: AppSlice<UiSlice> = (set, get) => ({
  page: 'dashboard',
  capsuleMode: new URLSearchParams(window.location.search).get('mode') === 'capsule',
  quickTodoMode: new URLSearchParams(window.location.search).get('mode') === 'quicktodo',
  sidebarCollapsed: localStorage.getItem('tpanel.sidebarCollapsed') === 'true',
  intakeOpen: false,
  taskExpandOrigin: null,

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

  setPage: (page) => set({ page, openTaskDir: null, openTaskArchived: false, taskExpandOrigin: null }),

  setIntakeOpen: (on) => set({ intakeOpen: on }),

  /**
   * 预览 → 完整工作区（AC1）：记录来源页面与滚动位置后进入 tasks 页并选中任务。
   * 注意不清 openTaskDir（跨域直写，store-conventions 切片组合的预期用法）。
   */
  expandTaskWorkspace: (origin) =>
    set({ taskExpandOrigin: origin, page: 'tasks', openTaskDir: origin.taskDir, openTaskArchived: origin.archived }),

  /**
   * 工作区 → 预览：回到来源页面并重开当前选中任务的详情抽屉（用户在工作区内
   * 可能已切换任务，以返回时刻的选中为准，不回跳展开时的旧任务）。
   */
  returnFromWorkspace: () => {
    const origin = get().taskExpandOrigin
    set({ taskExpandOrigin: null })
    if (origin === null) {
      set({ openTaskDir: null, openTaskArchived: false })
      return null
    }
    const cur = get().openTaskDir
    const taskDir = cur ?? origin.taskDir
    const archived = cur !== null ? get().openTaskArchived : origin.archived
    set({ page: origin.fromPage, openTaskDir: taskDir, openTaskArchived: archived })
    return { ...origin, taskDir, archived }
  }
})
