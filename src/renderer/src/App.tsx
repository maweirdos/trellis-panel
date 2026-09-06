import { useEffect, useState } from 'react'
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
import { WorkspacePage } from './pages/Workspace'
import { ArchivePage } from './pages/Archive'
import { TeamPage } from './pages/Team'
import { ChannelPage } from './pages/Channel'
import { JiraPage } from './pages/Jira'
import { CliPage } from './pages/Cli'
import { SettingsPage } from './pages/Settings'
import { clsx } from 'clsx'
import type { FileEntry } from '../../shared/types'

function MainApp(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const page = useApp((s) => s.page)
  const openTaskDir = useApp((s) => s.openTaskDir)
  const showTask = useApp((s) => s.showTask)
  const pushToast = useApp((s) => s.pushToast)
  const [artifact, setArtifact] = useState<FileEntry | null>(null)

  useEffect(() => {
    const off = api.onSnapshotUpdated((snap) => useApp.setState({ snapshot: snap }))
    const offToast = api.onToast((t) => useApp.getState().pushToast(t))
    const offFocus = api.onBridgeTaskFocus((taskDir) => {
      useApp.setState({ page: 'tasks', openTaskArchived: false })
      showTask(taskDir)
      pushToast({ kind: 'info', title: '已跳转到桥接任务', body: taskDir })
    })
    return () => {
      off()
      offToast()
      offFocus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
              page === 'tasks' || page === 'spec' || page === 'workspace' || page === 'jira' || page === 'channel'
                ? 'overflow-hidden'
                : 'overflow-y-auto'
              )}
            >
              {page === 'dashboard' && <Dashboard />}
              {page === 'tasks' && <TasksPage />}
              {page === 'spec' && <SpecPage />}
              {page === 'workspace' && <WorkspacePage />}
              {page === 'archive' && <ArchivePage />}
              {page === 'team' && <TeamPage />}
              {page === 'channel' && <ChannelPage />}
              {page === 'jira' && <JiraPage />}
              {page === 'cli' && <CliPage />}
              {page === 'settings' && <SettingsPage />}
            </div>

            {/* 任务详情：右侧悬浮层，不挤压看板布局 */}
            {(detailOpen && (page === 'tasks' || page === 'dashboard' || page === 'archive')) && (
              <div className="absolute inset-y-0 right-0 z-20 flex w-[460px] max-w-[85%] shadow-[-12px_0_40px_rgba(0,0,0,0.45)]">
                <TaskDetail onOpenArtifact={setArtifact} />
              </div>
            )}

            {/* 产物全屏查看器 */}
            {artifact && (
              <ArtifactViewer file={artifact} projectName={snapshot.meta.name} onClose={() => setArtifact(null)} />
            )}
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
