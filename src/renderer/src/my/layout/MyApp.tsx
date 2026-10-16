// 项目工作区：固定模块栏 + 按需上下文 + 稳定的来源页与任务阅读面。
// 路由唯一事实是主 store 的 useApp.page，IPC 事件联动不受换壳影响。
import { useEffect, useLayoutEffect, lazy, Suspense, useState, useRef, type JSX, type ReactNode } from "react"
import { Keyboard, Loader2 } from 'lucide-react'
import { useApp, type Page } from '../../store'
import { useMy } from '../store'
import { getPageNavigation, projectRootKey } from '../navigation'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { CommandPalette } from '../CommandPalette'
import { IssuePeek } from '../pages/IssuePeek'
import { CreateIssueModal } from '../pages/work-items/CreateIssueModal'
import { PageFrame } from './PageFrame'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { useEscLayer } from '../../utils/use-esc-layer'
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
const FRAMED_PAGES: Partial<Record<Page, ReactNode>> = {
  knowledge: <KnowledgePage />,
  spec: <SpecPage />,
  archive: <ArchivePage />,
  inbox: <InboxPage />,
  channels: <ChannelsPage />,
  acp: <AcpConsolePage />,
  team: <TeamPage />,
  jira: <JiraPage />,
  architecture: <ArchitecturePage />,
  studio: <StudioPage />,
  models: <ModelsPage />,
  gateway: <GatewayPage />,
  chat: <ChatPage />,
  settings: <SettingsPage />
}

function PageBody(): JSX.Element {
  const page = useApp((s) => s.page)
  const root = useApp((s) => projectRootKey(s.snapshot?.meta.root))
  const scope = getPageNavigation(page).scope
  const contentKey = scope === 'project' || scope === 'mixed' ? `${page}:${root ?? 'preview'}` : page
  const framed = FRAMED_PAGES[page]
  return (
    <Suspense fallback={<PageLoading />}>
      {/* 页面级兜底：单页崩溃只换掉内容区（错误卡片可重试），外壳与侧栏存活；
          项目页面同时按真实 root 重挂，清除旧项目页面状态和错误态 */}
      <ErrorBoundary key={contentKey}>
        {page === 'dashboard' && <YourWorkPage />}
        {page === 'tasks' && <WorkItemsPage />}
        {page === 'analytics' && <AnalyticsPage />}
        {framed && <PageFrame page={page}>{framed}</PageFrame>}
      </ErrorBoundary>
    </Suspense>
  )
}

export function MyApp(): JSX.Element {
  const setTheme = useMy((s) => s.setTheme)
  const syncFromSnapshot = useMy((s) => s.syncFromSnapshot)
  const setPaletteOpen = useMy((s) => s.setPaletteOpen)
  const panelTheme = useApp((s) => (s.settings?.theme === 'light' ? 'light' : 'dark'))
  const openTaskDir = useApp((s) => s.openTaskDir)
  const root = useApp((s) => projectRootKey(s.snapshot?.meta.root))
  const theme = useMy((s) => s.theme)
  const toggleSidebar = useMy((s) => s.toggleSidebar)
  const setCreateIssueOpen = useMy((s) => s.setCreateIssueOpen)
  const [helpOpen, setHelpOpen] = useState(false)
  const workspace = useApp((s) => s.taskExpandOrigin !== null)
  const sourceRef = useRef<HTMLDivElement>(null)
  const sourceFocus = useRef<HTMLElement | null>(null)
  const sourceScroll = useRef<Array<{ element: HTMLElement; top: number; left: number }>>([])
  const wasWorkspace = useRef(false)

  useLayoutEffect(() => {
    const rememberFocus = (event: FocusEvent): void => {
      if (event.target instanceof HTMLElement && sourceRef.current?.contains(event.target)) sourceFocus.current = event.target
    }
    document.addEventListener('focusin', rememberFocus)
    const off = useApp.subscribe((state, previous) => {
      if (state.taskExpandOrigin !== null && previous.taskExpandOrigin === null) {
        const source = sourceRef.current
        if (source) sourceScroll.current = [source, ...Array.from(source.querySelectorAll<HTMLElement>('.my-scrollbar, [data-page-scroll]'))]
          .map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft }))
      }
      if (projectRootKey(state.snapshot?.meta.root) !== projectRootKey(previous.snapshot?.meta.root)) {
        sourceFocus.current = null
        sourceScroll.current = []
      }
    })
    return () => { document.removeEventListener('focusin', rememberFocus); off() }
  }, [])

  useLayoutEffect(() => {
    if (sourceRef.current) sourceRef.current.inert = workspace
    if (wasWorkspace.current && !workspace) {
      for (const saved of sourceScroll.current) if (saved.element.isConnected) {
        saved.element.scrollTop = saved.top
        saved.element.scrollLeft = saved.left
      }
      const focusTarget = sourceFocus.current?.isConnected ? sourceFocus.current : sourceRef.current
      focusTarget?.focus({ preventScroll: true })
    }
    wasWorkspace.current = workspace
  }, [workspace])

  useEffect(() => {
    if (panelTheme !== theme) setTheme(panelTheme)
    // 主题以面板设置为准，此处仅在漂移时校正
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelTheme])

  useLayoutEffect(() => {
    // Bootstrap may have supplied the first snapshot before this shell mounted.
    syncFromSnapshot()
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

  // 全局快捷键：C 新建 / / 面板 / ? 帮助 / Ctrl+B 折叠侧栏（输入态不拦截）
  useEffect(() => {
    const isTyping = (t: EventTarget | null): boolean =>
      t instanceof HTMLElement &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'c' || e.key === 'C') {
        setCreateIssueOpen(true)
      } else if (e.key === '/') {
        e.preventDefault()
        setPaletteOpen(true)
      } else if (e.key === '?') {
        setHelpOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setCreateIssueOpen, setPaletteOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <WorkspaceSidebar />
      <main className="my-workspace-center relative flex min-w-0 flex-1 flex-col overflow-hidden bg-my-surface-1">
        {/* Keep the source instance mounted, with its local tabs/filter/scroll intact. */}
        <div ref={sourceRef} data-page-scroll tabIndex={-1} aria-label="来源工作视图" aria-hidden={workspace || undefined}
          className={`my-scrollbar min-h-0 min-w-0 flex-1 ${workspace ? 'invisible pointer-events-none absolute inset-0' : ''}`}>
          <PageBody />
        </div>
        {openTaskDir !== null && (
          <div data-task-presentation={workspace ? 'workspace' : 'preview'}
            className={`my-task-surface absolute inset-y-0 right-0 z-20 flex max-w-full bg-my-surface-1 ${workspace ? 'left-0' : 'border-l border-my-line-strong shadow-[var(--my-shadow-overlay-200)]'}`}>
            <Suspense fallback={<PageLoading />}>
              <ErrorBoundary key={`${root}:${openTaskDir}`}>
                <TaskDetail presentation={workspace ? 'workspace' : 'preview'} />
              </ErrorBoundary>
            </Suspense>
          </div>
        )}
      </main>
      <IssuePeek key={`peek:${root}`} />
      <CreateIssueModal key={`create:${root}`} />
      <CommandPalette key={`palette:${root}`} />
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

/** 快捷键帮助浮层（? 呼出，Esc 或点击遮罩关闭） */
const SHORTCUTS: Array<[string, string]> = [
  ['C', '新建工作项'],
  ['/', '打开命令面板'],
  ['Ctrl+K', '命令面板（同 /）'],
  ['Ctrl+B', '收起 / 展开上下文栏'],
  ['↑ ↓', '列表导航'],
  ['Enter', '打开聚焦的工作项'],
  ['?', '显示本帮助']
]

function HelpOverlay({ onClose }: { onClose: () => void }): JSX.Element {
  useEscLayer(true, { kind: 'modal', id: 'keyboard-help', onClose })
  return (
    <div className="p-fade fixed inset-0 z-[88] flex items-center justify-center bg-my-backdrop" onMouseDown={onClose}>
      <div
        className="w-[380px] rounded-my-xl border border-my-line bg-my-layer-2 p-4 shadow-[var(--my-shadow-overlay-200)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-my-md font-semibold text-my-primary">
            <Keyboard size={15} className="text-my-icon-secondary" />
            键盘快捷键
          </span>
          <span className="my-kbd">Esc 关闭</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {SHORTCUTS.map(([keys, label]) => (
            <div key={keys} className="flex items-center justify-between text-my-sm">
              <span className="text-my-secondary">{label}</span>
              <span className="my-kbd">{keys}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
