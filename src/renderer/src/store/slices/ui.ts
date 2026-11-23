import type { AppSlice, UiSlice } from '../types'

export const uiSlice: AppSlice<UiSlice> = (set, get) => ({
  navigationRevision: 0,
  page: 'chat',
  privateCodeChat: false,
  personalTaskSource: 'team',
  setPersonalTaskSource: (personalTaskSource) => set({ personalTaskSource }),
  capsuleMode: new URLSearchParams(window.location.search).get('mode') === 'capsule',
  quickTodoMode: new URLSearchParams(window.location.search).get('mode') === 'quicktodo',
  sidebarCollapsed: localStorage.getItem('tpanel.sidebarCollapsed') === 'true',
  intakeOpen: false,
  taskExpandOrigin: null,
  taskMaterialTarget: null,
  setTaskMaterialTarget: (path) => set({ taskMaterialTarget: path }),
  specDocumentTarget: null,
  openSpecDocument: (path) => {
    const projectRoot = get().snapshot?.meta.root
    if (!projectRoot) return
    set({ page: 'spec', specDocumentTarget: { projectRoot, path }, openTaskDir: null, openTaskArchived: false, taskExpandOrigin: null, taskMaterialTarget: null })
  },
  consumeSpecDocumentTarget: () => {
    const target = get().specDocumentTarget
    set({ specDocumentTarget: null })
    return target
  },

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

  setPage: (page, options) => set((state) => ({ page, privateCodeChat: page === 'chat' && options?.privateCodeChat === true, navigationRevision: state.navigationRevision + 1, openTaskDir: null, openTaskArchived: false, taskExpandOrigin: null, taskMaterialTarget: null, specDocumentTarget: null })),

  setIntakeOpen: (on) => set({ intakeOpen: on }),

  /**
   * 预览 → 完整工作区：记录来源但不换路由，来源视图和阅读器保持挂载。
   * 注意不清 openTaskDir（跨域直写，store-conventions 切片组合的预期用法）。
   */
  expandTaskWorkspace: (origin, materialPath) =>
    set({ taskExpandOrigin: origin, openTaskDir: origin.taskDir, openTaskArchived: origin.archived,
      ...(materialPath !== undefined ? { taskMaterialTarget: materialPath } : {}) }),

  /**
   * 工作区 → 预览：回到来源页面并重开当前选中任务的详情抽屉（用户在工作区内
   * 可能已切换任务，以返回时刻的选中为准，不回跳展开时的旧任务）。
   */
  returnFromWorkspace: () => {
    const origin = get().taskExpandOrigin
    set({ taskExpandOrigin: null })
    if (origin === null) return null
    const cur = get().openTaskDir
    const taskDir = cur ?? origin.taskDir
    const archived = cur !== null ? get().openTaskArchived : origin.archived
    set({ page: origin.fromPage, openTaskDir: taskDir, openTaskArchived: archived })
    return { ...origin, taskDir, archived }
  }
})
