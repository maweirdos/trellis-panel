import type { AppSlice, SessionSlice } from '../types'
import type { Settings, ProjectSnapshot } from '../../../../shared/types'
import { WEKNORA_DEFAULTS } from '../../../../shared/types'
import { api } from '../../api'
import { loadInbox, reconcileInbox } from '../inbox-storage'
import { loadLastNavigationLocation, loadStartupNavigationLocation } from '../../my/navigation-preferences'
import { projectRootKey } from '../../my/navigation'

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

export const sessionSlice: AppSlice<SessionSlice> = (set, get) => {
  let projectOpenRevision = 0
  const openProject = async (root: string, resetNavigation: boolean): Promise<void> => {
    const revision = ++projectOpenRevision
    set({ openError: null })
    const res = await api.openProject(root)
    if (revision !== projectOpenRevision) return
    if (res.ok && res.snapshot) {
      const rootPath = (res.snapshot as ProjectSnapshot).meta.root
      const rawInbox = loadInbox(rootPath)
      const reconciled = reconcileInbox(rawInbox, res.snapshot, rootPath)
      set({
        snapshot: res.snapshot,
        ...(resetNavigation ? { page: 'dashboard' as const, privateCodeChat: false } : {}),
        openTaskDir: null,
        taskExpandOrigin: null,
        inboxProjectRoot: rootPath,
        inbox: reconciled,
        // S0 G2：切换项目清空全部阅读会话（主进程同步清空变更信号桥监听）；
        // S0 G3：观测 scope 缓冲与健康状态一并清空（主进程 generation 兜底取消订阅）
        readingSessions: {},
        observationScopes: {},
        observationStatus: null
      })
      void get().loadTodos()
      // Main persists recents while opening. Refresh only that setting after the
      // snapshot is visible, without overwriting theme edits or a newer project.
      void api.getSettings().then((settings) => {
        if (revision !== projectOpenRevision || get().snapshot?.meta.root !== rootPath) return
        const refreshed = normalizeSettings(settings)
        set((state) => ({
          settings: state.settings ? { ...state.settings, recentProjects: refreshed.recentProjects } : refreshed
        }))
      }).catch(() => {
        // A failed history refresh must not turn a successful project open into a failure.
      })
    } else {
      set({ openError: res.error ?? '打开失败' })
    }
  }
  return {
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
      const initialNavigation = get().navigationRevision
      const initialPage = get().page
      const settings = normalizeSettings(await api.getSettings())
      set({ settings, starting: false })
      // 胶囊 / 速记窗口与主窗口共享主进程的项目状态，只需拉取当前快照。
      if (get().capsuleMode || get().quickTodoMode) {
        const snap = await api.getSnapshot()
        if (snap) get().setSnapshot(snap)
        return
      }
      const saved = loadLastNavigationLocation()
      const last = saved ? saved.projectRoot : settings.recentProjects[0]
      if (last) {
        // Automatic project attachment must not replace the default personal conversation.
        await openProject(last, false)
      }
      void get().loadTodos()
      // 冷启动深链兜底：live 推送若早于 bootstrap 到达会被 openProjectPath 重置，
      // 所以这里统一兜底消费一次（live 已消费时 pull 返回 null，用暂存的 dir 补上）
      const pending = await api.pullPendingFocus()
      const focusDir = pending?.taskDir ?? get().pendingFocusDir
      const focusRoot = pending?.root ?? null
      if (focusDir) {
        if (focusRoot && projectRootKey(get().snapshot?.meta.root) !== projectRootKey(focusRoot)) {
          await get().openProjectPath(focusRoot)
        } else if (!focusRoot && !get().snapshot) {
          // A live focus may already have consumed the pull receipt. Read its actual
          // main-process project rather than assigning the task to a recent directory.
          const snapshot = await api.getSnapshot()
          if (snapshot) get().setSnapshot(snapshot)
        }
        if (get().snapshot && (!focusRoot || projectRootKey(get().snapshot?.meta.root) === projectRootKey(focusRoot))) {
          set({ page: 'tasks' })
          get().showTask(focusDir)
        }
        set({ pendingFocusDir: null })
      } else {
        const app = get()
        if (initialNavigation === 0 && initialPage === 'chat' && app.navigationRevision === initialNavigation && app.page === initialPage && !app.openTaskDir && !app.specDocumentTarget && !app.taskExpandOrigin) {
          const location = loadStartupNavigationLocation(app.snapshot?.meta.root ?? null, app.snapshot?.meta.developer)
          set({ page: location?.page ?? 'chat' })
        }
      }
      set({ bootstrapped: true })
    },

    openProjectPath: (root, options) => openProject(root, options?.keepPage !== true),

    pickAndOpen: async (options) => {
      const root = await api.pickProject()
      if (root) await get().openProjectPath(root, options)
    },

    closeProject: async () => {
      const revision = ++projectOpenRevision
      await api.closeProject()
      if (revision !== projectOpenRevision) return
      // S0 G2：关闭项目同样清空全部阅读会话（快照不跨项目/重启）；
      // S0 G3：观测 scope/健康状态同步清空（停读）
      set({ snapshot: null, openTaskDir: null, taskExpandOrigin: null, inboxProjectRoot: null, inbox: {}, todos: [], readingSessions: {}, observationScopes: {}, observationStatus: null })
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

    showTask: (dirName, archived = false) => set({
      openTaskDir: dirName,
      openTaskArchived: dirName === null ? false : archived,
      ...(dirName === null ? { taskExpandOrigin: null, taskMaterialTarget: null } : {})
    })
  }
}
