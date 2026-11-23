import { useContext, useEffect, useLayoutEffect, useRef, useState, lazy, Suspense } from 'react'
import { useApp } from './store'
import { api, hasIpc } from './api'
import { useMy } from './my/store'
import { UI_PREFERENCES_KEY } from './my/appearance'
import { TitleBar } from './components/TitleBar'
import { ApplicationDock } from './applications/ApplicationDock'
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
import { BrandMotion } from './my/BrandMotion'
import { pageRequiresProject, projectRootKey } from './my/navigation'
import { StartupContext, StartupContentCommit } from './daemon/StartupContext'
import { DaemonSettingsDialog } from './daemon/DaemonSettingsDialog'
import { Modal } from './my/ui'
const OnboardingWizard = lazy(() => import('./onboarding/OnboardingWizard').then((module) => ({ default: module.OnboardingWizard })))

function PageLoading(): JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center text-my-tertiary" role="status" aria-label="正在载入">
      <BrandMotion state="loading" size={32} />
    </div>
  )
}

function MainApp(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const page = useApp((s) => s.page)
  const viewerTabs = useApp((s) => s.viewerTabs)
  const showTask = useApp((s) => s.showTask)
  const pushToast = useApp((s) => s.pushToast)
  const inboxAdd = useApp((s) => s.inboxAdd)
  const projectRoot = snapshot?.meta.root
  const bootstrapped = useApp((s) => s.bootstrapped)
  const taskConversation = useMy((s) => s.taskConversationTarget)
  useEffect(() => {
    const bridge = api as typeof api & { onDaemonRuntimeUnavailable?: (callback: (event: { projectRoot: string; error: string }) => void) => () => void }
    return bridge.onDaemonRuntimeUnavailable?.(event => {
      if (projectRootKey(useApp.getState().snapshot?.meta.root ?? '') === projectRootKey(event.projectRoot)) useApp.getState().pushToast({ kind: 'warn', title: '后台 Runtime 连接中断', body: event.error })
    })
  }, [])

  // 文档会话集线器：定向变更事件 → 各阅读会话
  useEffect(() => {
    attachDocumentChangedSource((cb) => api.onDocumentChanged(cb))
  }, [])

  useEffect(() => {
    const off = api.onSnapshotUpdated((snap) => useApp.getState().setSnapshot(snap))
    const offToast = api.onToast((t) => useApp.getState().pushToast(t))
    const offDocumentReturn = api.onDocumentOriginReturn((origin) => {
      const state = useApp.getState()
      if (projectRootKey(state.snapshot?.meta.root ?? '') !== projectRootKey(origin.projectRoot)) {
        state.pushToast({ kind: 'error', title: '来源项目尚未就绪', body: '请重新点击文档窗口的返回来源' })
        return
      }
      if (origin.sessionId) {
        useMy.getState().setAgentSessionTarget(origin.sessionId)
        useMy.getState().requestAgentView(null)
        state.setPage('acp')
      } else if (origin.taskDir) {
        const snapshot = state.snapshot
        const task = snapshot && [...snapshot.tasks, ...snapshot.archived].find((item) => item.dirName === origin.taskDir || item.path === origin.taskDir)
        if (task && snapshot) { state.showTask(task.dirName, snapshot.archived.includes(task)); state.setPage('tasks') }
        else state.pushToast({ kind: 'error', title: '来源任务已不可用', body: origin.taskDir })
      }
    })
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
      offDocumentReturn()
      offFocus()
      offInbox()
      offFocusReading()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The subscriptions above and project bootstrap must both be complete before
  // main drains cold/queued/inbox task-focus actions.
  useEffect(() => {
    if (!hasIpc || !bootstrapped || !api.bootstrap) return
    let current = true
    void api.bootstrap.attached().then(result => {
      if (current && !result.ok) pushToast({ kind: 'warn', title: '桌面事件连接未完成', body: result.error })
    }).catch(() => { if (current) pushToast({ kind: 'warn', title: '桌面事件连接未完成', body: '请重载桌面以重新连接启动事件' }) })
    return () => { current = false; void api.bootstrap.detached().catch(() => undefined) }
  }, [bootstrapped, pushToast])

  // 深链切换项目时（主进程直接打开，不经过 openProjectPath）同步收件箱与项目状态
  useEffect(() => {
    if (projectRoot && useApp.getState().inboxProjectRoot !== projectRoot) {
      useApp.getState().setInboxProject(projectRoot)
    }
  }, [projectRoot])

  if (hasIpc && !bootstrapped) return <PageLoading />

  if (!snapshot && pageRequiresProject(page) && !(page === 'acp' && taskConversation)) {
    return <><Onboarding /><StartupContentCommit /></>
  }

  return (
    <div className="flex min-h-0 flex-1">
      <Suspense fallback={<PageLoading />}>
        <MyApp />
      </Suspense>
      {snapshot && viewerTabs.length > 0 && <ArtifactViewer projectName={snapshot.meta.name} />}
      {snapshot && <IntakeModal />}
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
  const fontFamily = useMy((s) => s.fontFamily)
  const codeFontFamily = useMy((s) => s.codeFontFamily)
  const codeFontSize = useMy((s) => s.codeFontSize)
  const development = useMy((s) => s.shellView === 'development')
  const startup = useContext(StartupContext)
  const bootstrapped = useApp((s) => s.bootstrapped)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingNeedsCompletion, setOnboardingNeedsCompletion] = useState(false)
  const [onboardingStorageUnavailable, setOnboardingStorageUnavailable] = useState(false)
  const onboardingFinishLock = useRef(false)
  const [bootstrapFailure, setBootstrapFailure] = useState<{ error: unknown } | null>(null)
  const docMode = new URLSearchParams(window.location.search).get('mode') === 'doc'
  const [windowTheme, setWindowTheme] = useState<'light' | 'dark' | 'system'>(() => {
    const value = new URLSearchParams(window.location.search).get('theme')
    return value === 'light' || value === 'system' ? value : 'dark'
  })
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const hasWindowTheme = new URLSearchParams(window.location.search).has('theme')
  const themePreference = settings?.theme ?? (hasWindowTheme || docMode || capsuleMode || quickTodoMode ? windowTheme : startup?.initialTheme ?? theme)
  const effectiveTheme = themePreference === 'system' ? (systemDark ? 'dark' : 'light') : themePreference

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => setSystemDark(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!hasIpc || !bootstrapped || docMode || capsuleMode || quickTodoMode || !api.onboarding) return
    let current = true
    void api.onboarding.status().then((result) => {
      if (!current || !result.ok) return
      const unavailable = result.data.profile === 'new' && result.data.state === 'unavailable'
      if (result.data.shouldShow || unavailable) { setOnboardingStorageUnavailable(unavailable); setOnboardingNeedsCompletion(true); setOnboardingOpen(true) }
    }).catch(() => undefined)
    return () => { current = false }
  }, [bootstrapped, docMode, capsuleMode, quickTodoMode])

  useEffect(() => {
    const open = (): void => setOnboardingOpen(true)
    window.addEventListener('trellis-open-onboarding', open)
    return () => window.removeEventListener('trellis-open-onboarding', open)
  }, [])

  const finishOnboarding = async (outcome: 'completed' | 'skipped'): Promise<void> => {
    if (onboardingFinishLock.current) return
    onboardingFinishLock.current = true
    try {
      if (onboardingNeedsCompletion) {
        const result = await api.onboarding.complete(outcome)
        if (!result.ok) throw new Error(result.error)
        setOnboardingNeedsCompletion(false)
        setOnboardingStorageUnavailable(false)
      }
      setOnboardingOpen(false)
    } finally {
      onboardingFinishLock.current = false
    }
  }

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === UI_PREFERENCES_KEY || event.key === null) useMy.getState().syncFontSizeFromStorage()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    let current = true
    if (hasIpc && !docMode) void bootstrap().catch(error => { if (current) setBootstrapFailure({ error }) })
    return () => { current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!hasIpc || typeof api.onThemeChanged !== 'function') return
    return api.onThemeChanged((nextTheme) => {
      // Keep every renderer in sync without persisting the same setting again.
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
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat) return
      if (e.key === 'Escape' && dispatchEscKey()) e.preventDefault()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') document.documentElement.dataset.altHeld = 'true'
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') delete document.documentElement.dataset.altHeld
    }
    const onBlur = (): void => {
      delete document.documentElement.dataset.altHeld
    }
    window.addEventListener('keydown', onEsc)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onEsc)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      delete document.documentElement.dataset.altHeld
    }
  }, [docMode, capsuleMode, quickTodoMode])

  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', effectiveTheme !== 'light')
    document.documentElement.style.colorScheme = effectiveTheme
    document.documentElement.classList.toggle('is-capsule', capsuleMode || quickTodoMode)
    if (useMy.getState().theme !== effectiveTheme) useMy.setState({ theme: effectiveTheme })
  }, [effectiveTheme, capsuleMode, quickTodoMode])

  // React boundaries cannot catch asynchronous effect rejections. Rethrow on
  // render so the restricted outer recovery remains usable, even for falsy errors.
  if (bootstrapFailure) throw bootstrapFailure.error

  if (docMode) {
    return <div data-my-theme={effectiveTheme} data-my-font-size={fontSize} data-my-font={fontFamily} data-my-code-font={codeFontFamily} data-my-code-size={codeFontSize} className="my-root flex h-full w-full flex-col bg-my-canvas text-my-md text-my-primary"><DocWindowApp /></div>
  }

  if (quickTodoMode) {
    return (
      <div data-my-theme={effectiveTheme} data-my-font-size={fontSize} data-my-font={fontFamily} data-my-code-font={codeFontFamily} data-my-code-size={codeFontSize} className="my-root h-full w-full overflow-hidden bg-transparent p-0">
        <QuickTodoView />
      </div>
    )
  }

  if (capsuleMode) {
    return (
      <div data-my-theme={effectiveTheme} data-my-font-size={fontSize} data-my-font={fontFamily} data-my-code-font={codeFontFamily} data-my-code-size={codeFontSize} className="my-root h-full w-full bg-transparent p-0 overflow-hidden">
        <Suspense fallback={null}><CapsuleLazy /></Suspense>
        <Toasts />
      </div>
    )
  }

  // 预览入口：?my=1 且无 IPC 环境（浏览器）时直接渲染外壳，便于界面级验证
  if (!hasIpc && window.location.protocol === 'http:' && new URLSearchParams(window.location.search).get('my') === '1') {
    return (
      <div data-my-theme={effectiveTheme} data-my-font-size={fontSize} data-my-font={fontFamily} data-my-code-font={codeFontFamily} data-my-code-size={codeFontSize} className="my-root my-app-window flex h-full w-full flex-col text-my-md text-my-primary">
        <TitleBar />
        <Suspense fallback={null}>
          <MyApp />
        </Suspense>
        {development && <ApplicationDock />}
      </div>
    )
  }

  return (
    <ErrorBoundary>
      <div data-my-theme={effectiveTheme} data-my-font-size={fontSize} data-my-font={fontFamily} data-my-code-font={codeFontFamily} data-my-code-size={codeFontSize} className="my-root my-app-window flex h-full flex-col text-my-md text-my-primary">
        <TitleBar />
        <MainApp />
        {development && <ApplicationDock />}
        <Toasts />
        <DialogHost />
        <DaemonSettingsDialog />
        <Modal open={onboardingOpen} fullScreen ariaLabel="首次设置" onClose={() => undefined}>
          <Suspense fallback={<PageLoading />}><OnboardingWizard storageUnavailable={onboardingStorageUnavailable} onDefer={() => setOnboardingOpen(false)} onFinish={finishOnboarding} /></Suspense>
        </Modal>
      </div>
    </ErrorBoundary>
  )
}

const CapsuleLazy = lazy(() => import('./components/CapsuleView').then((m) => ({ default: m.CapsuleView })))
