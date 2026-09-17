import { useEffect } from 'react'
import { useApp } from './store'
import { api } from './api'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { Onboarding } from './components/Onboarding'
import { Toasts } from './components/Toasts'
import { CapsuleView } from './components/CapsuleView'
import { ArtifactViewer } from './components/ArtifactViewer'
import { Dashboard } from './pages/Dashboard'
import { TasksPage } from './pages/Tasks'
import { TaskDetail } from './pages/TaskDetail'
import { SpecPage } from './pages/Spec'
import { ArchivePage } from './pages/Archive'
import { TeamPage } from './pages/Team'
import { JiraPage } from './pages/Jira'
import { InboxPage } from './pages/Inbox'
import { SettingsPage } from './pages/Settings'
import { IntakeModal } from './components/IntakeModal'
import { clsx } from 'clsx'

function MainApp(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const page = useApp((s) => s.page)
  const openTaskDir = useApp((s) => s.openTaskDir)
  const viewerTabs = useApp((s) => s.viewerTabs)
  const showTask = useApp((s) => s.showTask)
  const pushToast = useApp((s) => s.pushToast)
  const inboxAdd = useApp((s) => s.inboxAdd)
  const projectRoot = snapshot?.meta.root

  useEffect(() => {
    const off = api.onSnapshotUpdated((snap) => useApp.setState({ snapshot: snap }))
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
              page === 'tasks' || page === 'spec' || page === 'jira' || page === 'inbox'
                ? 'overflow-hidden'
                : 'overflow-y-auto'
              )}
            >
              {page === 'dashboard' && <Dashboard />}
              {page === 'inbox' && <InboxPage />}
              {page === 'tasks' && <TasksPage />}
              {page === 'spec' && <SpecPage />}
              {page === 'archive' && <ArchivePage />}
              {page === 'team' && <TeamPage />}
              {page === 'jira' && <JiraPage />}
              {page === 'settings' && <SettingsPage />}
            </div>

            {/* 任务详情：右侧悬浮层，宽度由抽屉自身控制（可拖拽调宽） */}
            {(detailOpen && (page === 'tasks' || page === 'dashboard' || page === 'archive' || page === 'inbox')) && (
              <div className="absolute inset-y-0 right-0 z-20 flex shadow-[-12px_0_40px_rgba(0,0,0,0.45)]">
                <TaskDetail />
              </div>
            )}

            {/* 产物多标签查看器 */}
            {viewerTabs.length > 0 && <ArtifactViewer projectName={snapshot.meta.name} />}

            {/* 需求 Intake 向导 */}
            <IntakeModal />
          </main>
        </div>
      )}
      <Toasts />
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
  }, [settings?.theme])

  if (capsuleMode) {
    return (
      <div className="h-full">
        <CapsuleView />
        <Toasts />
      </div>
    )
  }
  return <MainApp />
}
