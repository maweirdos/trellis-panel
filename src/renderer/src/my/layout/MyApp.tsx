// 参考 克隆模块壳：工作区侧边栏 + 项目侧边栏 + 内容路由 + 全局弹层宿主。
import { useEffect, lazy, Suspense, type JSX } from 'react'
import { clsx } from 'clsx'
import { Loader2 } from 'lucide-react'
import { useMy } from '../store'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { ProjectSidebar } from './ProjectSidebar'
import { CommandPalette } from '../CommandPalette'
import { IssuePeek } from '../pages/IssuePeek'
import { CreateIssueModal } from '../pages/work-items/CreateIssueModal'
import { CreateProjectModal } from './CreateProjectModal'
import '@fontsource-variable/inter'
import '../my.css'

const WorkItemsPage = lazy(() => import('../pages/WorkItemsPage').then((m) => ({ default: m.WorkItemsPage })))
const CyclesPage = lazy(() => import('../pages/CyclesPage').then((m) => ({ default: m.CyclesPage })))
const ModulesPage = lazy(() => import('../pages/ModulesPage').then((m) => ({ default: m.ModulesPage })))
const ViewsPage = lazy(() => import('../pages/ViewsPage').then((m) => ({ default: m.ViewsPage })))
const PagesPage = lazy(() => import('../pages/PagesPage').then((m) => ({ default: m.PagesPage })))
const IntakePage = lazy(() => import('../pages/IntakePage').then((m) => ({ default: m.IntakePage })))
const YourWorkPage = lazy(() => import('../pages/YourWorkPage').then((m) => ({ default: m.YourWorkPage })))
const AnalyticsPage = lazy(() => import('../pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })))
const ProjectsPage = lazy(() => import('../pages/ProjectsPage').then((m) => ({ default: m.ProjectsPage })))
const InboxPage = lazy(() => import('../pages/InboxPage').then((m) => ({ default: m.InboxPage })))
const SettingsPage = lazy(() => import('../pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))

function PageLoading(): JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center text-my-tertiary">
      <Loader2 size={18} className="animate-spin text-my-icon-tertiary" />
    </div>
  )
}

const PROJECT_PAGES: Record<string, boolean> = {
  'work-items': true,
  cycles: true,
  modules: true,
  views: true,
  pages: true,
  intake: true,
  'project-settings': true
}

function PageBody(): JSX.Element {
  const page = useMy((s) => s.page)
  return (
    <Suspense fallback={<PageLoading />}>
      {page === 'your-work' && <YourWorkPage />}
      {page === 'inbox' && <InboxPage />}
      {page === 'analytics' && <AnalyticsPage />}
      {page === 'projects' && <ProjectsPage />}
      {page === 'workspace-settings' && <SettingsPage scope="workspace" />}
      {page === 'profile' && <SettingsPage scope="profile" />}
      {page === 'work-items' && <WorkItemsPage />}
      {page === 'cycles' && <CyclesPage />}
      {page === 'modules' && <ModulesPage />}
      {page === 'views' && <ViewsPage />}
      {page === 'pages' && <PagesPage />}
      {page === 'intake' && <IntakePage />}
      {page === 'project-settings' && <SettingsPage scope="project" />}
    </Suspense>
  )
}

export function MyApp(): JSX.Element {
  const theme = useMy((s) => s.theme)
  const customAccent = useMy((s) => s.customAccent)
  const page = useMy((s) => s.page)
  const setPaletteOpen = useMy((s) => s.setPaletteOpen)
  const inProject = PROJECT_PAGES[page] === true

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setPaletteOpen])

  return (
    <div
      data-my-theme={theme}
      data-custom-accent={customAccent ?? undefined}
      style={customAccent ? { ['--my-bg-accent-primary' as string]: customAccent } : undefined}
      className="my-root flex h-full w-full bg-my-canvas text-[13px] text-my-primary"
    >
      <WorkspaceSidebar />
      {inProject && <ProjectSidebar />}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="my-scrollbar min-h-0 flex-1">
          <PageBody />
        </div>
      </main>
      <IssuePeek />
      <CreateIssueModal />
      <CreateProjectModal />
      <CommandPalette />
    </div>
  )
}

export { clsx }
