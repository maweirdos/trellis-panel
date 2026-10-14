// 应用外壳：工作区侧边栏 + 项目侧边栏 + 内容路由 + 全局弹层。
// 路由唯一事实是主 store 的 useApp.page，IPC 事件联动不受换壳影响。
import { useEffect, lazy, Suspense, type JSX, type ReactNode } from "react"
import { Loader2 } from 'lucide-react'
import { useApp } from '../../store'
import { useMy, isProjectPage } from '../store'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { ProjectSidebar } from './ProjectSidebar'
import { CommandPalette } from '../CommandPalette'
import { IssuePeek } from '../pages/IssuePeek'
import { CreateIssueModal } from '../pages/work-items/CreateIssueModal'
import { PageFrame } from './PageFrame'
import '@fontsource-variable/inter'
import '../my.css'

const YourWorkPage = lazy(() => import('../pages/YourWorkPage').then((m) => ({ default: m.YourWorkPage })))
const AnalyticsPage = lazy(() => import('../pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })))
const WorkItemsPage = lazy(() => import('../pages/WorkItemsPage').then((m) => ({ default: m.WorkItemsPage })))

const KnowledgePage = lazy(() => import('../../pages/Knowledge').then((m) => ({ default: m.KnowledgePage })))
const SpecPage = lazy(() => import('../../pages/Spec').then((m) => ({ default: m.SpecPage })))
const ArchivePage = lazy(() => import('../../pages/Archive').then((m) => ({ default: m.ArchivePage })))
const InboxPage = lazy(() => import('../../pages/Inbox').then((m) => ({ default: m.InboxPage })))
const ChannelsPage = lazy(() => import('../../pages/Channels').then((m) => ({ default: m.ChannelsPage })))
const TeamPage = lazy(() => import('../../pages/Team').then((m) => ({ default: m.TeamPage })))
const JiraPage = lazy(() => import('../../pages/Jira').then((m) => ({ default: m.JiraPage })))
const SettingsPage = lazy(() => import('../../pages/Settings').then((m) => ({ default: m.SettingsPage })))
const StudioPage = lazy(() => import('../../pages/Studio').then((m) => ({ default: m.StudioPage })))
const ArchitecturePage = lazy(() => import('../../pages/Architecture').then((m) => ({ default: m.ArchitecturePage })))
const ModelsPage = lazy(() => import('../../pages/Models').then((m) => ({ default: m.ModelsPage })))
const GatewayPage = lazy(() => import('../../pages/Gateway').then((m) => ({ default: m.GatewayPage })))
const ChatPage = lazy(() => import('../../pages/Chat').then((m) => ({ default: m.ChatPage })))
const AcpConsolePage = lazy(() => import('../../pages/AcpConsole').then((m) => ({ default: m.AcpConsolePage })))
const TaskDetail = lazy(() => import('../../pages/TaskDetail').then((m) => ({ default: m.TaskDetail })))

function PageLoading(): JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center text-my-tertiary">
      <Loader2 size={18} className="animate-spin text-my-icon-tertiary" />
    </div>
  )
}

/** 保留功能、按外壳规范重绘的页面：框架提供顶栏，页面内部只输出内容 */
const FRAMED_PAGES: Record<string, { title: string; parent: string; element: ReactNode }> = {
  knowledge: { title: '知识库', parent: '文档', element: <KnowledgePage /> },
  spec: { title: '规范文档', parent: '文档', element: <SpecPage /> },
  archive: { title: '归档', parent: '文档', element: <ArchivePage /> },
  inbox: { title: '待办池', parent: '接收', element: <InboxPage /> },
  channels: { title: 'AI 频道', parent: '协作', element: <ChannelsPage /> },
  acp: { title: 'Agent 会话', parent: '协作', element: <AcpConsolePage /> },
  team: { title: '团队协作', parent: '协作', element: <TeamPage /> },
  jira: { title: 'Jira 任务', parent: '协作', element: <JiraPage /> },
  architecture: { title: '架构图', parent: '系统', element: <ArchitecturePage /> },
  studio: { title: '定制中心', parent: '系统', element: <StudioPage /> },
  models: { title: '模型管理', parent: '系统', element: <ModelsPage /> },
  gateway: { title: 'MCP 网关', parent: '系统', element: <GatewayPage /> },
  chat: { title: '会话', parent: '协作', element: <ChatPage /> },
  settings: { title: '设置', parent: '系统', element: <SettingsPage /> }
}

function PageBody(): JSX.Element {
  const page = useApp((s) => s.page)
  const framed = FRAMED_PAGES[page]
  return (
    <Suspense fallback={<PageLoading />}>
      {page === 'dashboard' && <YourWorkPage />}
      {page === 'tasks' && <WorkItemsPage />}
      {page === 'analytics' && <AnalyticsPage />}
      {framed && <PageFrame title={framed.title} parent={framed.parent}>{framed.element}</PageFrame>}
    </Suspense>
  )
}

export function MyApp(): JSX.Element {
  const setTheme = useMy((s) => s.setTheme)
  const syncFromSnapshot = useMy((s) => s.syncFromSnapshot)
  const setPaletteOpen = useMy((s) => s.setPaletteOpen)
  const panelTheme = useApp((s) => (s.settings?.theme === 'light' ? 'light' : 'dark'))
  const page = useApp((s) => s.page)
  const openTaskDir = useApp((s) => s.openTaskDir)
  const theme = useMy((s) => s.theme)
  const inProject = isProjectPage(page)

  useEffect(() => {
    if (panelTheme !== theme) setTheme(panelTheme)
    // 主题以面板设置为准，此处仅在漂移时校正
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelTheme])

  useEffect(() => {
    const off = useApp.subscribe((state, prev) => {
      if (state.snapshot !== prev.snapshot) syncFromSnapshot()
    })
    return () => off()
  }, [syncFromSnapshot])

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
    <div className="flex h-full min-w-0 flex-1">
      <WorkspaceSidebar />
      {inProject && <ProjectSidebar />}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="my-scrollbar min-h-0 flex-1">
          <PageBody />
        </div>
        {openTaskDir !== null && (
          <div className="absolute inset-y-0 right-0 z-20 flex border-l border-my-line bg-my-canvas shadow-[-12px_0_40px_rgba(0,0,0,0.35)]">
            <Suspense fallback={<PageLoading />}>
              <TaskDetail />
            </Suspense>
          </div>
        )}
      </main>
      <IssuePeek />
      <CreateIssueModal />
      <CommandPalette />
    </div>
  )
}
