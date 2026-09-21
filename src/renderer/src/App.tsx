import { useEffect, useState, lazy, Suspense } from 'react'
import { useApp } from './store'
import { api } from './api'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { Onboarding } from './components/Onboarding'
import { Toasts } from './components/Toasts'
import { DialogHost } from './components/Dialogs'
import { CapsuleView } from './components/CapsuleView'
import { ArtifactViewer } from './components/ArtifactViewer'
import { CommandPalette } from './components/CommandPalette'
import { IntakeModal } from './components/IntakeModal'
import { clsx } from 'clsx'
import { Loader2 } from 'lucide-react'

// 页面级按需代码分割（开源标准 React.lazy + Suspense），避免启动和主面板一次性加载重型依赖（Mermaid/Cytoscape/KaTeX等）
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })))
const TasksPage = lazy(() => import('./pages/Tasks').then((m) => ({ default: m.TasksPage })))
const TaskDetail = lazy(() => import('./pages/TaskDetail').then((m) => ({ default: m.TaskDetail })))
const SpecPage = lazy(() => import('./pages/Spec').then((m) => ({ default: m.SpecPage })))
const ArchivePage = lazy(() => import('./pages/Archive').then((m) => ({ default: m.ArchivePage })))
const TeamPage = lazy(() => import('./pages/Team').then((m) => ({ default: m.TeamPage })))
const JiraPage = lazy(() => import('./pages/Jira').then((m) => ({ default: m.JiraPage })))
const InboxPage = lazy(() => import('./pages/Inbox').then((m) => ({ default: m.InboxPage })))
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })))
const StudioPage = lazy(() => import('./pages/Studio').then((m) => ({ default: m.StudioPage })))
const KnowledgePage = lazy(() => import('./pages/Knowledge').then((m) => ({ default: m.KnowledgePage })))
const ChannelsPage = lazy(() => import('./pages/Channels').then((m) => ({ default: m.ChannelsPage })))
const ArchitecturePage = lazy(() => import('./pages/Architecture').then((m) => ({ default: m.ArchitecturePage })))
const ModelsPage = lazy(() => import('./pages/Models').then((m) => ({ default: m.ModelsPage })))
const GatewayPage = lazy(() => import('./pages/Gateway').then((m) => ({ default: m.GatewayPage })))

function PageLoading(): JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center text-mist-500">
      <Loader2 size={20} className="animate-spin text-mist-400" />
    </div>
  )
}

function MainApp(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const page = useApp((s) => s.page)
  const openTaskDir = useApp((s) => s.openTaskDir)
  const viewerTabs = useApp((s) => s.viewerTabs)
  const showTask = useApp((s) => s.showTask)
  const pushToast = useApp((s) => s.pushToast)
  const inboxAdd = useApp((s) => s.inboxAdd)
  const projectRoot = snapshot?.meta.root
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
      // 桥接任务尚未进入快照（AI 刚创建）时先补一次扫描
      const known = snap && [...snap.tasks, ...snap.archived].some((t) => t.dirName === taskDir || t.path === taskDir)
      if (!known) void st.refresh()
      useApp.setState({ page: 'tasks', openTaskArchived: false })
      showTask(taskDir)
      pushToast({ kind: 'info', title: '已跳转到桥接任务', body: taskDir })
    })
    const offInbox = api.onInboxNew((e) => {
      const currentRoot = useApp.getState().snapshot?.meta.root
      if (currentRoot && currentRoot !== e.projectRoot) return
      inboxAdd(e.items)
      useApp.setState({ page: 'inbox' })
    })
    return () => {
      off()
      offToast()
      offFocus()
      offInbox()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 深链切换项目时（主进程直接打开，不经过 openProjectPath）同步收件箱与项目状态
  useEffect(() => {
    if (projectRoot && useApp.getState().inboxProjectRoot !== projectRoot) {
      useApp.getState().setInboxProject(projectRoot)
    }
  }, [projectRoot])

  const detailOpen = openTaskDir !== null

  return (
    <div className="flex h-full flex-col bg-ink-900 text-mist-100">
      <TitleBar />
      {!snapshot ? (
        <Onboarding />
      ) : (
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* 页面层：详情打开时保持看板全宽，不再挤压 */}
            <div
              className={clsx(
                'min-h-0 flex-1',
              page === 'tasks' || page === 'spec' || page === 'jira' || page === 'inbox' || page === 'knowledge' || page === 'channels' || page === 'studio' || page === 'models' || page === 'gateway'
                ? 'overflow-hidden'
                : 'overflow-y-auto'
              )}
            >
              <Suspense fallback={<PageLoading />}>
                {page === 'dashboard' && <Dashboard />}
                {page === 'inbox' && <InboxPage />}
                {page === 'tasks' && <TasksPage />}
                {page === 'knowledge' && <KnowledgePage />}
                {page === 'spec' && <SpecPage />}
                {page === 'archive' && <ArchivePage />}
                {page === 'channels' && <ChannelsPage />}
                {page === 'team' && <TeamPage />}
                {page === 'jira' && <JiraPage />}
                {page === 'architecture' && <ArchitecturePage />}
                {page === 'studio' && <StudioPage />}
                {page === 'models' && <ModelsPage />}
                {page === 'gateway' && <GatewayPage />}
                {page === 'settings' && <SettingsPage />}
              </Suspense>
            </div>

            {/* 任务详情：右侧悬浮层（dashboard/archive/inbox等页面使用；tasks页已一体化内置，不再弹抽屉遮挡） */}
            {(detailOpen && (page === 'dashboard' || page === 'archive' || page === 'inbox')) && (
              <div className="absolute inset-y-0 right-0 z-20 flex shadow-[-12px_0_40px_rgba(0,0,0,0.45)]">
                <Suspense fallback={<PageLoading />}>
                  <TaskDetail />
                </Suspense>
              </div>
            )}

            {/* 产物多标签查看器 */}
            {viewerTabs.length > 0 && <ArtifactViewer projectName={snapshot.meta.name} />}

            {/* 需求 Intake 向导 */}
            <IntakeModal />

            {/* 全局命令面板 */}
            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
          </main>
        </div>
      )}
      <Toasts />
      <DialogHost />
    </div>
  )
}

export default function App(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const bootstrap = useApp((s) => s.bootstrap)
  const capsuleMode = useApp((s) => s.capsuleMode)

  useEffect(() => {
    void bootstrap()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings?.theme !== 'light')
    document.documentElement.classList.toggle('is-capsule', capsuleMode)
  }, [settings?.theme, capsuleMode])

  if (capsuleMode) {
    return (
      <div className="h-full w-full bg-transparent p-0 overflow-hidden">
        <CapsuleView />
        <Toasts />
      </div>
    )
  }
  return <MainApp />
}
