// 项目工作区：固定模块栏 + 按需上下文 + 稳定的来源页与任务阅读面。
// 路由唯一事实是主 store 的 useApp.page，IPC 事件联动不受换壳影响。
import { useEffect, useLayoutEffect, lazy, Suspense, useState, useRef, type JSX, type ReactNode } from "react"
import { Keyboard, Loader2, X } from 'lucide-react'
import { useApp, type Page } from '../../store'
import { useMy } from '../store'
import { rememberVisit } from '../personal-history'
import { loadNavigationLocation, saveNavigationLocation } from '../navigation-preferences'
import { getPageNavigation, projectRootKey } from '../navigation'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { CommandPalette } from '../CommandPalette'
import { Button, Modal } from '../ui'
import { IssuePeek } from '../pages/IssuePeek'
import { CreateIssueModal } from '../pages/work-items/CreateIssueModal'
import { SpecPage } from '../../pages/Spec'
import { PageFrame } from './PageFrame'
import { PAGE_LAYOUTS, PageLayout } from './PageLayout'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { escLayerCount } from '../../utils/esc-layer'
import { InteractionScope, useInteractionActive } from '../../utils/interaction-scope'
import { StartupContentCommit, StartupContentRegion } from '../../daemon/StartupContext'

function isTextEditingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest('input, textarea, select, [role="textbox"], .monaco-editor, .cm-editor')))
}

const YourWorkPage = lazy(() => import('../pages/YourWorkPage').then((m) => ({ default: m.YourWorkPage })))
const AnalyticsPage = lazy(() => import('../pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })))
const WorkItemsPage = lazy(() => import('../pages/WorkItemsPage').then((m) => ({ default: m.WorkItemsPage })))

const KnowledgePage = lazy(() => import('../../pages/Knowledge').then((m) => ({ default: m.KnowledgePage })))
const ArchivePage = lazy(() => import('../../pages/Archive').then((m) => ({ default: m.ArchivePage })))
const InboxPage = lazy(() => import('../../pages/Inbox').then((m) => ({ default: m.InboxPage })))
const ChannelsPage = lazy(() => import('../../pages/Channels').then((m) => ({ default: m.ChannelsPage })))
const TeamPage = lazy(() => import('../../pages/Team').then((m) => ({ default: m.TeamPage })))
const JiraPage = lazy(() => import('../../pages/Jira').then((m) => ({ default: m.JiraPage })))
const SettingsPage = lazy(() => import('../../pages/Settings').then((m) => ({ default: m.SettingsPage })))
const IntegrationsPage = lazy(() => import('../pages/integrations/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })))
const StudioPage = lazy(() => import('../../pages/Studio').then((m) => ({ default: m.StudioPage })))
const ArchitecturePage = lazy(() => import('../../pages/Architecture').then((m) => ({ default: m.ArchitecturePage })))
const ModelsPage = lazy(() => import('../../pages/Models').then((m) => ({ default: m.ModelsPage })))
const GatewayPage = lazy(() => import('../../pages/Gateway').then((m) => ({ default: m.GatewayPage })))
const ChatPage = lazy(() => import('../../pages/Chat').then((m) => ({ default: m.ChatPage })))
const AcpConsolePage = lazy(() => import('../../pages/AcpConsole').then((m) => ({ default: m.AcpConsolePage })))
const DevToolsPage = lazy(() => import('../pages/DevToolsPage').then((m) => ({ default: m.DevToolsPage })))
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
  analytics: <AnalyticsPage />,
  jira: <JiraPage />,
  architecture: <ArchitecturePage />,
  studio: <StudioPage />,
  models: <ModelsPage />,
  gateway: <GatewayPage />,
  chat: <ChatPage />,
  devtools: <DevToolsPage />,
  settings: <SettingsPage />,
  integrations: <IntegrationsPage />
}

export function PageBody(): JSX.Element {
  const outerInteractive = useInteractionActive()
  const page = useApp((s) => s.page)
  const root = useApp((s) => projectRootKey(s.snapshot?.meta.root))
  const scope = getPageNavigation(page).scope
  const contentKey = scope === 'project' || scope === 'mixed' ? `${page}:${root ?? 'preview'}` : page
  const framed = FRAMED_PAGES[page]
  const [rootGeneration, setRootGeneration] = useState(0)
  const sequence = useRef(0)
  const [acpSource, setAcpSource] = useState<{ root: string | null; generation: number; owner: number } | null>(() => page === 'acp' ? { root, generation: rootGeneration, owner: ++sequence.current } : null)
  const sourceRef = useRef<HTMLDivElement | null>(null)
  const sourceFocus = useRef<HTMLElement | null>(null)
  const sourceScroll = useRef<Array<{ element: HTMLElement; top: number; left: number }>>([])
  const wasDetour = useRef(false)
  // Finite prop-derived state: React retries this component before committing a replacement owner.
  const sameOwner = acpSource?.root === root && acpSource.generation === rootGeneration
  if (acpSource && (!sameOwner || (page !== 'acp' && page !== 'settings'))) setAcpSource(null)
  else if (page === 'acp' && !acpSource) setAcpSource({ root, generation: rootGeneration, owner: ++sequence.current })
  const acpActive = page === 'acp'
  const retained = acpSource !== null && sameOwner && (acpActive || page === 'settings')

  useLayoutEffect(() => {
    const rememberFocus = (event: FocusEvent): void => {
      const source = sourceRef.current
      if (source && !source.hidden && !source.inert && event.target instanceof HTMLElement && source.contains(event.target)) sourceFocus.current = event.target
    }
    document.addEventListener('focusin', rememberFocus)
    const off = useApp.subscribe((state, previous) => {
      const sameRoot = projectRootKey(state.snapshot?.meta.root) === projectRootKey(previous.snapshot?.meta.root)
      if (!sameRoot) {
        setRootGeneration((generation) => generation + 1)
        setAcpSource(null)
        sourceFocus.current = null; sourceScroll.current = []
      } else if (previous.page === 'acp' && state.page === 'settings') {
        const source = sourceRef.current
        if (!source) return
        sourceScroll.current = [source, ...source.querySelectorAll<HTMLElement>('.my-scrollbar,[data-page-scroll],.acp-document__body,textarea')]
          .map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft }))
        // A native sidebar opener receives focus before its click changes the route.
        // Retain the last source focus rather than replacing it with that outside target.
        if (document.activeElement instanceof HTMLElement && source.contains(document.activeElement)) sourceFocus.current = document.activeElement
      } else if (state.page !== 'acp' && state.page !== 'settings') {
        setAcpSource(null)
        sourceFocus.current = null; sourceScroll.current = []
      }
    })
    return () => { off(); document.removeEventListener('focusin', rememberFocus) }
  }, [])
  useLayoutEffect(() => {
    if (sourceRef.current) sourceRef.current.inert = !acpActive || !outerInteractive
    if (outerInteractive && acpActive && wasDetour.current) {
      for (const saved of sourceScroll.current) if (saved.element.isConnected) { saved.element.scrollTop = saved.top; saved.element.scrollLeft = saved.left }
      if (sourceFocus.current?.isConnected) sourceFocus.current.focus({ preventScroll: true })
    }
    wasDetour.current = retained && !acpActive
  }, [acpActive, outerInteractive, retained, acpSource?.owner])
  return (
    <>
      <StartupContentRegion identity={`acp:${root}:${acpSource?.owner ?? 'empty'}`} active={outerInteractive && acpActive}>
      <Suspense fallback={acpActive && outerInteractive ? <PageLoading /> : null}>
      <InteractionScope key={acpSource?.owner ?? 'empty'} active={acpActive}>
        {retained && <div ref={(element) => { sourceRef.current = element; if (element) element.inert = !acpActive || !outerInteractive }} data-acp-source-owner={acpSource.owner} hidden={!acpActive} aria-hidden={!acpActive || undefined} className="h-full min-h-0 min-w-0">
          <ErrorBoundary key={`acp:${acpSource.root ?? 'preview'}:${acpSource.owner}`}><PageLayout variant={PAGE_LAYOUTS.acp}><AcpConsolePage /><StartupContentCommit active={acpActive} /></PageLayout></ErrorBoundary>
        </div>}
      </InteractionScope>
      </Suspense>
      </StartupContentRegion>
      {/* 页面级兜底：单页崩溃只换掉内容区（错误卡片可重试），外壳与侧栏存活；
          项目页面同时按真实 root 重挂，清除旧项目页面状态和错误态 */}
      {!acpActive && <StartupContentRegion identity={contentKey} active={outerInteractive}><Suspense fallback={<PageLoading />}><ErrorBoundary key={contentKey}>
        {page === 'dashboard' && <YourWorkPage />}
        {page === 'tasks' && <WorkItemsPage />}
        {framed && <PageFrame page={page}>{framed}</PageFrame>}
        <StartupContentCommit />
      </ErrorBoundary></Suspense></StartupContentRegion>}
    </>
  )
}

export function MyApp(): JSX.Element {
  const syncFromSnapshot = useMy((s) => s.syncFromSnapshot)
  const setPaletteOpen = useMy((s) => s.setPaletteOpen)
  const openTaskDir = useApp((s) => s.openTaskDir)
  const root = useApp((s) => projectRootKey(s.snapshot?.meta.root))
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

  useLayoutEffect(() => {
    // Bootstrap may have supplied the first snapshot before this shell mounted.
    syncFromSnapshot()
    const off = useApp.subscribe((state, prev) => {
      if (state.snapshot !== prev.snapshot) syncFromSnapshot()
    })
    return () => off()
  }, [syncFromSnapshot])

  // Restore presentation once at startup; explicit task/document links win.
  // Opening a different project keeps the main store's existing reset behavior.
  const navigationRestored = useRef(false)
  useLayoutEffect(() => {
    const app = useApp.getState()
    const snapshot = app.snapshot
    if (navigationRestored.current || !snapshot) return
    navigationRestored.current = true
    const saved = loadNavigationLocation(snapshot.meta.root, snapshot.meta.developer)
    if (saved && app.page === 'dashboard' && !app.openTaskDir && !app.pendingFocusDir && !app.specDocumentTarget && !app.taskExpandOrigin) {
      const { page: savedPage, ...views } = saved
      useMy.setState({ ...views, groupBy: views.workItemsView === 'iterations' ? 'cycle' : useMy.getState().itemsGroupBy })
      if (savedPage !== app.page) app.setPage(savedPage)
    }
  }, [root])
  useEffect(() => {
    const persist = (): void => {
      const app = useApp.getState()
      const snapshot = app.snapshot
      if (!snapshot || !navigationRestored.current || useMy.getState().projectRoot !== projectRootKey(snapshot.meta.root)) return
      saveNavigationLocation(snapshot.meta.root, snapshot.meta.developer, app.page, useMy.getState())
    }
    const offApp = useApp.subscribe((state, previous) => {
      if (state.page !== previous.page) {
        useMy.getState().rememberModulePage(state.page)
        if (state.page !== 'acp') {
          useMy.getState().requestAgentView(null)
          useMy.getState().setAgentSessionTarget(null)
        }
      }
      persist()
    })
    const offMy = useMy.subscribe((state, previous) => {
      if (state.modulePages !== previous.modulePages || state.workItemsView !== previous.workItemsView || state.workItemsTab !== previous.workItemsTab || state.teamView !== previous.teamView || state.toolView !== previous.toolView || state.knowledgeView !== previous.knowledgeView || state.settingsView !== previous.settingsView) persist()
    })
    useMy.getState().rememberModulePage(useApp.getState().page)
    persist()
    return () => { offApp(); offMy() }
  }, [])

  useEffect(() => useApp.subscribe((state, previous) => {
    if (projectRootKey(state.snapshot?.meta.root) !== projectRootKey(previous.snapshot?.meta.root)) return
    if (state.openTaskDir && (state.openTaskDir !== previous.openTaskDir || state.openTaskArchived !== previous.openTaskArchived)) {
      const tasks = state.openTaskArchived ? state.snapshot?.archived : state.snapshot?.tasks
      const task = tasks?.find((item) => item.dirName === state.openTaskDir || item.path === state.openTaskDir)
      if (task) rememberVisit({ kind: 'task', target: state.openTaskDir, archived: state.openTaskArchived, title: task.record?.title || task.dirName })
    }
    if (state.specDocumentTarget && state.specDocumentTarget !== previous.specDocumentTarget) {
      const path = state.specDocumentTarget.path
      rememberVisit({ kind: 'document', target: path, title: path.replace(/\\/g, '/').split('/').pop() || path })
    }
  }), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || document.querySelector('[aria-modal="true"]')) return
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
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || escLayerCount() > 0 || document.querySelector('[aria-modal="true"]') || isTextEditingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
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
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || document.querySelector('[aria-modal="true"]') || isTextEditingTarget(e.target)) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar])

  return (
    <div className="my-shell-layout flex h-full min-h-0 min-w-0 flex-1">
      <WorkspaceSidebar />
      <main className="my-workspace-center relative flex min-w-0 flex-1 flex-col overflow-hidden bg-my-surface-1">
        {/* Keep the source instance mounted, with its local tabs/filter/scroll intact. */}
        <div ref={sourceRef} data-page-scroll tabIndex={-1} aria-label="来源工作视图" aria-hidden={workspace || undefined}
          className={`min-h-0 min-w-0 flex-1 overflow-hidden ${workspace ? 'invisible pointer-events-none absolute inset-0' : ''}`}>
          <InteractionScope active={!workspace}><PageBody /></InteractionScope>
        </div>
        {openTaskDir !== null && (
          <div data-task-presentation={workspace ? 'workspace' : 'preview'}
            className={`my-task-surface absolute inset-y-0 right-0 z-20 flex max-w-full bg-my-surface-1 ${workspace ? 'left-0' : 'border-l border-my-line-strong shadow-[var(--my-shadow-overlay-200)]'}`}>
            <StartupContentRegion identity={`task:${root}:${openTaskDir}:${workspace}`}>
              <Suspense fallback={<PageLoading />}>
                <ErrorBoundary key={`${root}:${openTaskDir}`}>
                  <TaskDetail presentation={workspace ? 'workspace' : 'preview'} />
                  <StartupContentCommit />
                </ErrorBoundary>
              </Suspense>
            </StartupContentRegion>
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
  return (
    <Modal open onClose={onClose} width={380} placement="center" ariaLabel="键盘快捷键">
      <div className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-my-md font-semibold text-my-primary">
            <Keyboard size={15} className="text-my-icon-secondary" />
            键盘快捷键
          </span>
          <Button variant="ghost" aria-label="关闭快捷键帮助" onClick={onClose}>
            <X size={14} />
          </Button>
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
    </Modal>
  )
}
