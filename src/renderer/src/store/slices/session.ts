import type { AppSlice, SessionSlice } from '../types'
import type { Settings, ProjectSnapshot } from '../../../../shared/types'
import { WEKNORA_DEFAULTS } from '../../../../shared/types'
import { api } from '../../api'
import { loadInbox, reconcileInbox } from '../inbox-storage'

/**
 * 新增设置节在"渲染层新代码 + 主进程旧代码"混跑（dev 热更新只刷渲染层）或
 * 旧 settings.json 下会缺失，这里统一补默认值，页面侧不再假设节一定存在。
 */
const PROXY_DEFAULTS = { enabled: false, url: '' }

export function normalizeSettings(s: Settings): Settings {
  return {
    ...s,
    weknora: { ...WEKNORA_DEFAULTS, ...(s.weknora ?? {}) },
    proxy: { ...PROXY_DEFAULTS, ...(s.proxy ?? {}) }
  }
}

export const sessionSlice: AppSlice<SessionSlice> = (set, get) => ({
  snapshot: null,
  settings: null,
  openError: null,
  starting: true,
  bootstrapped: false,
  pendingFocusDir: null,
  openTaskDir: null,
  openTaskArchived: false,

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
    // 胶囊 / 速记窗口与主窗口共享主进程的项目状态，只需拉取当前快照。
    if (get().capsuleMode || get().quickTodoMode) {
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
      const rootPath = (res.snapshot as ProjectSnapshot).meta.root
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

  showTask: (dirName, archived = false) => set({ openTaskDir: dirName, openTaskArchived: archived })
})
