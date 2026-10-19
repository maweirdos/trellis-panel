import { useEffect, useLayoutEffect, useState, lazy, Suspense } from 'react'
import { useApp } from './store'
import { api, hasIpc } from './api'
import { useMy } from './my/store'
import { UI_PREFERENCES_KEY } from './my/appearance'
import { TitleBar } from './components/TitleBar'
import { Onboarding } from './components/Onboarding'
import { Toasts } from './components/Toasts'
import { DialogHost } from './components/Dialogs'
import { ErrorBoundary } from './components/ErrorBoundary'
import { getReading } from './utils/reading'
import { QuickTodoView } from './components/QuickTodoView'
import { ArtifactViewer } from './components/ArtifactViewer'
import { IntakeModal } from './components/IntakeModal'
import { attachDocumentChangedSource } from './reader/document-session-hub'
import { dispatchEscKey } from './utils/esc-layer'
import { MyApp } from './my/layout/MyApp'
import { DocWindowApp } from './my/pages/DocWindow'
import { Loader2 } from 'lucide-react'

function PageLoading(): JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center text-my-tertiary">
      <Loader2 size={20} className="animate-spin text-my-icon-tertiary" />
    </div>
  )
}

function MainApp(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const viewerTabs = useApp((s) => s.viewerTabs)
  const showTask = useApp((s) => s.showTask)
  const pushToast = useApp((s) => s.pushToast)
  const inboxAdd = useApp((s) => s.inboxAdd)
  const projectRoot = snapshot?.meta.root

  // 文档会话集线器：定向变更事件 → 各阅读会话
  useEffect(() => {
    attachDocumentChangedSource((cb) => api.onDocumentChanged(cb))
  }, [])

  useEffect(() => {
    const off = api.onSnapshotUpdated((snap) => useApp.getState().setSnapshot(snap))
    const offToast = api.onToast((t) => useApp.getState().pushToast(t))
    const offFocus = api.onBridgeTaskFocus((taskDir) => {
      const st = useApp.getState()
      // bootstrap 未完成时先暂存，否则随后 openProjectPath 会把 page/openTaskDir 重置掉
      if (!st.bootstrapped) {
        useApp.setState({ pendingFocusDir: taskDir })
        return
      }
      const snap = st.snapshot
      const known = snap && [...snap.tasks, ...snap.archived].some((t) => t.dirName === taskDir || t.path === taskDir)
      if (!known) void st.refresh()
      useApp.setState({ page: 'tasks', openTaskArchived: false })
      showTask(taskDir)
      pushToast({ kind: 'info', title: '已跳转到该任务', body: taskDir })
    })
    const offInbox = api.onInboxNew((e) => {
      const currentRoot = useApp.getState().snapshot?.meta.root
      if (currentRoot && currentRoot !== e.projectRoot) return
      inboxAdd(e.items)
      useApp.setState({ page: 'inbox' })
    })
    // 任务材料更新（主进程按任务防抖合并）——正在阅读的任务给轻提示，其余正常提醒
    const offMaterial = api.onMaterialUpdated((e) => {
      const st = useApp.getState()
      const readingIt = st.openTaskDir === e.dirName
      pushToast({
        kind: 'info',
        title: readingIt ? '当前阅读任务有更新' : `任务更新：${e.title}`,
        body: `${e.count} 个文件：${e.files.join('、')}${e.count > e.files.length ? ' 等' : ''}`
      })
    })
    // 全局热键唤起 → 回到上次阅读位置（不新开、不跳最新）
    const offFocusReading = api.onFocusLastReading(() => {
      useApp.getState().setPage('tasks')
      const fresh = useApp.getState()
      const snap = fresh.snapshot
      if (!snap) return
      const saved = getReading(snap.meta.root)
      if (saved && [...snap.tasks, ...snap.archived].some((t) => t.dirName === saved.dirName)) {
        fresh.showTask(saved.dirName, snap.archived.some((t) => t.dirName === saved.dirName))
      }
    })
    return () => {
      off()
      offToast()
      offFocus()
      offInbox()
      offMaterial()
      offFocusReading()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 深链切换项目时（主进程直接打开，不经过 openProjectPath）同步收件箱与项目状态
  useEffect(() => {
    if (projectRoot && useApp.getState().inboxProjectRoot !== projectRoot) {
      useApp.getState().setInboxProject(projectRoot)
    }
  }, [projectRoot])

  if (!snapshot) {
    return <Onboarding />
  }

  return (
    <div className="flex min-h-0 flex-1">
      <Suspense fallback={<PageLoading />}>
        <MyApp />
      </Suspense>
      {viewerTabs.length > 0 && <ArtifactViewer projectName={snapshot.meta.name} />}
      <IntakeModal />
    </div>
  )
}

export default function App(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const bootstrap = useApp((s) => s.bootstrap)
  const capsuleMode = useApp((s) => s.capsuleMode)
  const quickTodoMode = useApp((s) => s.quickTodoMode)
  const theme = useMy((s) => s.theme)
  const fontSize = useMy((s) => s.fontSize)
  const docMode = new URLSearchParams(window.location.search).get('mode') === 'doc'
  const [windowTheme, setWindowTheme] = useState<'light' | 'dark'>(() => new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark')
  const effectiveTheme = settings?.theme ?? (docMode || capsuleMode || quickTodoMode ? windowTheme : theme)

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === UI_PREFERENCES_KEY || event.key === null) useMy.getState().syncFontSizeFromStorage()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    if (hasIpc && !docMode) void bootstrap()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!hasIpc || typeof api.onThemeChanged !== 'function') return
    return api.onThemeChanged((nextTheme) => {
      // Keep every renderer in sync without persisting the same setting again.
      useMy.setState({ theme: nextTheme })
      setWindowTheme(nextTheme)
      const current = useApp.getState().settings
      if (current) useApp.setState({ settings: { ...current, theme: nextTheme } })
    })
  }, [])

  // One dispatcher for the ordinary shell, including no-IPC preview. Independent
  // Floating utilities and document windows keep their own key behavior.
  useEffect(() => {
    if (docMode || capsuleMode || quickTodoMode) return
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && dispatchEscKey()) e.preventDefault()
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [docMode, capsuleMode, quickTodoMode])

  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', effectiveTheme !== 'light')
    document.documentElement.style.colorScheme = effectiveTheme
    document.documentElement.classList.toggle('is-capsule', capsuleMode || quickTodoMode)
    if (useMy.getState().theme !== effectiveTheme) useMy.setState({ theme: effectiveTheme })
  }, [effectiveTheme, capsuleMode, quickTodoMode])

  if (docMode) {
    return <div data-my-theme={effectiveTheme} data-my-font-size={fontSize} className="my-root flex h-full w-full flex-col bg-my-canvas text-my-md text-my-primary"><DocWindowApp /></div>
  }

  if (quickTodoMode) {
    return (
      <div data-my-theme={effectiveTheme} data-my-font-size={fontSize} className="my-root h-full w-full overflow-hidden bg-transparent p-0">
        <QuickTodoView />
      </div>
    )
  }

  if (capsuleMode) {
    return (
      <div data-my-theme={effectiveTheme} data-my-font-size={fontSize} className="my-root h-full w-full bg-transparent p-0 overflow-hidden">
        <Suspense fallback={null}><CapsuleLazy /></Suspense>
        <Toasts />
      </div>
    )
  }

  // 预览入口：?my=1 且无 IPC 环境（浏览器）时直接渲染外壳，便于界面级验证
  if (!hasIpc && window.location.protocol === 'http:' && new URLSearchParams(window.location.search).get('my') === '1') {
    return (
      <div data-my-theme={effectiveTheme} data-my-font-size={fontSize} className="my-root my-app-window flex h-full w-full flex-col text-my-md text-my-primary">
        <TitleBar />
        <Suspense fallback={null}>
          <MyApp />
        </Suspense>
      </div>
    )
  }

  return (
    <ErrorBoundary>
      <div data-my-theme={effectiveTheme} data-my-font-size={fontSize} className="my-root my-app-window flex h-full flex-col text-my-md text-my-primary">
        <TitleBar />
        <MainApp />
        <Toasts />
        <DialogHost />
      </div>
    </ErrorBoundary>
  )
}

const CapsuleLazy = lazy(() => import('./components/CapsuleView').then((m) => ({ default: m.CapsuleView })))
