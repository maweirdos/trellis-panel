import { useEffect } from 'react'
import { useApp } from './store'
import { api } from './api'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { Onboarding } from './components/Onboarding'
import { Dashboard } from './pages/Dashboard'
import { TasksPage } from './pages/Tasks'
import { TaskDetail } from './pages/TaskDetail'
import { SpecPage } from './pages/Spec'
import { WorkspacePage } from './pages/Workspace'
import { ArchivePage } from './pages/Archive'
import { CliPage } from './pages/Cli'
import { SettingsPage } from './pages/Settings'
import { clsx } from 'clsx'

export default function App(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const settings = useApp((s) => s.settings)
  const page = useApp((s) => s.page)
  const openTaskDir = useApp((s) => s.openTaskDir)
  const bootstrap = useApp((s) => s.bootstrap)
  const showTask = useApp((s) => s.showTask)

  useEffect(() => {
    void bootstrap()
    const off = api.onSnapshotUpdated((snap) => useApp.setState({ snapshot: snap }))
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings?.theme !== 'light')
  }, [settings?.theme])

  return (
    <div className="flex h-full flex-col bg-ink-900 text-mist-100">
      <TitleBar />
      {!snapshot ? (
        <Onboarding />
      ) : (
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main
            className={clsx(
              'flex min-w-0 flex-1 flex-col',
              page === 'tasks' || page === 'spec' || page === 'workspace' ? 'overflow-hidden' : 'overflow-y-auto'
            )}
          >
            {page === 'dashboard' && (
              <div className="flex min-h-0 flex-1">
                <Dashboard />
                {openTaskDir && <TaskDetail />}
              </div>
            )}
            {page === 'tasks' && (
              <div className="flex min-h-0 flex-1">
                <div className="min-w-0 flex-1">
                  <TasksPage />
                </div>
                {openTaskDir && <TaskDetail />}
              </div>
            )}
            {page === 'spec' && <SpecPage />}
            {page === 'workspace' && <WorkspacePage />}
            {page === 'archive' && (
              <div className="flex min-h-0 flex-1">
                <div className="min-w-0 flex-1">
                  <ArchivePage />
                </div>
                {openTaskDir && <TaskDetail />}
              </div>
            )}
            {page === 'cli' && <CliPage />}
            {page === 'settings' && <SettingsPage />}
          </main>
        </div>
      )}
    </div>
  )
}
