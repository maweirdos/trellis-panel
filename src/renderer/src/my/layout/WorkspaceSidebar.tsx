import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Activity, Blocks, BookOpen, ChevronRight, CircleHelp, CircleUser, Cpu, FileText, FolderInput, House, ListTodo, MessageCircle, PanelsTopLeft, RotateCw, Settings2, Star, Users, Workflow, Wrench, X } from 'lucide-react'
import { api, hasIpc } from '../../api'
import { getRuntimeInventorySnapshot, subscribeRuntimeInventory } from '../../acp/useRuntimeInventoryRefresh'
import { useApp, type Page } from '../../store'
import { inboxGroups, useCrux } from '../../crux/store'
import { useMy } from '../store'
import { NavIcon } from '../icons'
import { SidebarResizeHandle, useSidebarWidthStyle } from './SidebarResizeHandle'
import { contextButtonClass } from './ModuleLinks'
import { SettingsNavigation } from './SettingsNavigation'
import { AccountMenu } from './AccountMenu'
import { ContextRegion } from './ContextRegion'
import { activeModule, DOMAIN_LABELS, getPageNavigation, hasShellContext, pageRequiresProject, PRIMARY_NAVIGATION, type ModuleId, type TeamView } from '../navigation'
import type { AcpAgentStatus } from '../../../../shared/types'

const MODULE_ICONS: Record<ModuleId, ReactNode> = {
  home: <CircleUser className="my-module-icon" aria-hidden="true" />,
  agents: <MessageCircle className="my-module-icon" aria-hidden="true" />,
  tasks: <ListTodo className="my-module-icon" aria-hidden="true" />,
  team: <House className="my-module-icon" aria-hidden="true" />,
  knowledge: <BookOpen className="my-module-icon" aria-hidden="true" />,
  machines: <Cpu className="my-module-icon" aria-hidden="true" />,
  integrations: <Blocks className="my-module-icon" aria-hidden="true" />,
  automations: <Workflow className="my-module-icon" aria-hidden="true" />,
  settings: <Settings2 className="my-module-icon" aria-hidden="true" />
}

function countReadyRuntimes(agents: readonly AcpAgentStatus[]): number {
  return agents.filter((agent) => agent.launchKind !== 'custom' && agent.id !== 'opencode' && agent.available && !agent.setupRequired).length
}

export function WorkspaceSidebar(): JSX.Element {
  const page = useApp((state) => state.page)
  const setPage = useApp((state) => state.setPage)
  const collapsed = useMy((state) => state.sidebarCollapsed)
  const hasProject = useApp((state) => Boolean(state.snapshot?.meta.root))
  const cruxSnapshot = useCrux((state) => state.snapshot)
  const [readyRuntimeCount, setReadyRuntimeCount] = useState<number>(() => countReadyRuntimes(getRuntimeInventorySnapshot()))

  useEffect(() => {
    const unsubscribe = subscribeRuntimeInventory((agents) => setReadyRuntimeCount(countReadyRuntimes(agents)))
    if (hasIpc && getRuntimeInventorySnapshot().length === 0) {
      void api.acpAgents().then((reply) => {
        if (reply.ok && reply.agents) setReadyRuntimeCount(countReadyRuntimes(reply.agents))
      }).catch(() => undefined)
    }
    return unsubscribe
  }, [])

  const unreadInbox = cruxSnapshot ? (() => {
    const groups = inboxGroups(cruxSnapshot.inbox, Date.now())
    return groups.unread.important + groups.unread.other
  })() : 0
  const current = activeModule(page)
  const activeRail: ModuleId = page === 'creations'
    ? 'knowledge'
    : current === 'home'
      ? 'team'
      : current
  const railClass = (selected: boolean): string => clsx('my-module-button my-nav-item relative grid shrink-0 place-items-center transition-colors hover:text-my-primary', selected ? 'is-selected text-my-primary' : 'text-my-icon-secondary')

  return <>
    <aside aria-label="模块栏" className="my-module-rail flex h-full shrink-0 flex-col items-center">
      <nav aria-label="应用模块" className="my-scrollbar flex min-h-0 w-full flex-1 flex-col items-center">
        {PRIMARY_NAVIGATION.map((item) => {
          const badge = item.id === 'team' ? unreadInbox : 0
          return <button key={item.id} type="button" aria-label={item.label} title={item.label} aria-current={activeRail === item.id ? 'page' : undefined} onClick={() => {
            const app = useApp.getState()
            if (item.id === 'team') {
              if (app.page !== 'crux') setPage('crux')
              return
            }
            const remembered = useMy.getState().modulePages
            const saved = remembered[item.id]
            const opensRoot = item.id === 'agents' || item.id === 'knowledge'
            const target = opensRoot || !saved || pageRequiresProject(saved) && !hasProject ? item.page : saved
            if ((activeRail !== item.id || opensRoot) && (app.page !== target || target === 'chat' && app.privateCodeChat)) setPage(target)
          }} className={railClass(activeRail === item.id)}>
            {MODULE_ICONS[item.id]}
            {badge > 0 && <span className="my-module-badge" aria-label={`${badge} 条未读`}>{badge > 99 ? '99+' : badge}</span>}
          </button>
        })}
      </nav>
      <div className="my-module-footer mt-4 flex w-full shrink-0 flex-col items-center">
        <div className="my-module-divider" aria-hidden="true" />
        <button
          type="button"
          aria-label="机器与 Runtime 中心"
          title={readyRuntimeCount > 0 ? `机器与 Runtime 中心（${readyRuntimeCount} 个本机引擎就绪）` : '机器与 Runtime 中心（待探测或配置引擎）'}
          aria-current={page === 'machines' ? 'page' : undefined}
          onClick={() => { if (useApp.getState().page !== 'machines') setPage('machines') }}
          className={railClass(page === 'machines')}
        >
          {MODULE_ICONS.machines}
          <span
            className="my-module-status-dot"
            data-status={readyRuntimeCount > 0 ? 'ready' : 'warn'}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          aria-label="应用集成"
          title="应用集成"
          aria-current={page === 'integrations' ? 'page' : undefined}
          onClick={() => { if (useApp.getState().page !== 'integrations') setPage('integrations') }}
          className={railClass(page === 'integrations')}
        >
          {MODULE_ICONS.integrations}
        </button>
        <button
          type="button"
          aria-label="帮助与指引"
          title="帮助与指引 (?)"
          onClick={() => useMy.getState().setHelpOpen(true)}
          className={railClass(false)}
        >
          <CircleHelp className="my-module-icon" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="设置"
          title="设置"
          aria-current={page === 'settings' || page === 'models' || page === 'gateway' ? 'page' : undefined}
          onClick={() => {
            useMy.getState().setSettingsView('preferences')
            if (useApp.getState().page !== 'settings') setPage('settings')
          }}
          className={railClass(page === 'settings' || page === 'models' || page === 'gateway')}
        >
          {MODULE_ICONS.settings}
        </button>
        <AccountMenu />
      </div>
    </aside>
    {hasShellContext(page) && <ContextRegion collapsed={collapsed}><ContextSidebar /></ContextRegion>}
  </>
}

function ContextSidebar(): JSX.Element {
  const sidebarStyle = useSidebarWidthStyle()
  const page = useApp((state) => state.page)
  const setPage = useApp((state) => state.setPage)
  const personalTaskSource = useApp((state) => state.personalTaskSource)
  const { data, workItemsView: view, setWorkItemsView: setView, setWorkItemsTab: setTab, favorites, toggleFavorite, openIssue, savedViews, applyView, removeView, teamView, setTeamView } = useMy()
  const domain = activeModule(page)
  const moreRef = useRef<HTMLDetailsElement>(null)
  const moreContainsCurrent = page !== 'tasks' && page !== 'creations' || page === 'tasks' && personalTaskSource === 'local' && view === 'iterations'
  useLayoutEffect(() => {
    if (domain === 'home' && moreContainsCurrent && moreRef.current) moreRef.current.open = true
  }, [domain, moreContainsCurrent, page, personalTaskSource, view])
  const localTasks = (iterations = false): void => {
    useApp.getState().setPersonalTaskSource('local')
    setView(iterations ? 'iterations' : 'items')
    setPage('tasks')
  }
  const buttonClass = contextButtonClass
  const row = (key: string, label: string, selected: boolean, icon: ReactNode, action: () => void): JSX.Element => <button key={key} type="button" aria-current={selected ? 'page' : undefined} onClick={action} className={buttonClass(selected)}>{icon}{label}</button>
  const route = (target: Page): JSX.Element => row(target, getPageNavigation(target).title, page === target, <NavIcon name={getPageNavigation(target).icon} size={16} />, () => { if (useApp.getState().page !== target) setPage(target) })
  return <aside aria-label={`${DOMAIN_LABELS[domain]}导航`} style={sidebarStyle} className="my-context-sidebar flex h-full shrink-0 flex-col border-r border-my-line">
    <SidebarResizeHandle />
    <header className="flex h-my-header shrink-0 items-center gap-2 px-4">
      <h2 className="my-sidebar-heading flex-1 font-medium text-my-primary">{DOMAIN_LABELS[domain]}</h2>
    </header>
    {domain === 'settings' ? <SettingsNavigation /> : <div className="my-scrollbar my-fade-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
      {domain === 'home' && <>
        {row('all', '任务', page === 'tasks' && (personalTaskSource === 'team' || view === 'items'), <ListTodo size={16} />, () => { setView('items'); setPage('tasks') })}
        {row('creations', getPageNavigation('creations').title, page === 'creations', <PanelsTopLeft size={16} />, () => setPage('creations'))}
        <details ref={moreRef} className="my-navigation-group pt-3">
          <summary className="my-navigation-summary"><span>更多</span><ChevronRight aria-hidden="true" size={14} /></summary>
          <div className="my-navigation-children">
            {row('overview', '概览', page === 'dashboard', <House size={16} />, () => setPage('dashboard'))}
            {row('local-work', '本地工作', false, <ListTodo size={16} />, () => localTasks())}
            {row('iterations', '本地版本', page === 'tasks' && personalTaskSource === 'local' && view === 'iterations', <RotateCw size={16} />, () => { localTasks(true); setTab('all') })}
            {row('intake', '接入', page === 'inbox' || page === 'jira', <FolderInput size={16} />, () => setPage('inbox'))}
            {route('archive')}
            {row('tools', '工具', ['devtools', 'architecture', 'studio'].includes(page), <Wrench size={16} />, () => { const tool = useMy.getState().toolView; setPage(tool === 'architecture' || tool === 'studio' ? tool : 'devtools') })}
          {savedViews.length > 0 && <details open className="my-navigation-group mt-5">
            <summary className="my-navigation-summary"><span>视图</span><ChevronRight aria-hidden="true" size={14} /></summary>
            <div className="mt-0.5 flex flex-col gap-0.5">
            {savedViews.map((saved) => <div key={saved.id} className="group/view flex items-center gap-1 rounded-my-md transition-colors hover:bg-my-layer-transparent-hover">
              <button type="button" className="flex min-h-9 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-my-sm text-my-secondary hover:text-my-primary" onClick={() => { localTasks(); applyView(saved.id) }}>
                <NavIcon name="views" size={16} /><span className="truncate" title={saved.name}>{saved.name}</span>
              </button>
              <button type="button" aria-label={`删除视图 ${saved.name}`} onClick={() => removeView(saved.id)} className="my-hover-reveal-target mr-1 rounded-my-sm p-1 text-my-icon-tertiary opacity-0 transition-all hover:bg-my-layer-transparent-hover hover:text-my-primary group-hover/view:opacity-100 group-focus-within/view:opacity-100 focus-visible:opacity-100"><X size={12} /></button>
            </div>)}
            </div>
          </details>}
          {data.issues.some((issue) => favorites.includes(issue.id)) && <details open className="my-navigation-group mt-5">
            <summary className="my-navigation-summary"><span>收藏</span><ChevronRight aria-hidden="true" size={14} /></summary>
            <div className="mt-0.5 flex flex-col gap-0.5">
            {data.issues.filter((issue) => favorites.includes(issue.id)).map((issue) => <div key={issue.id} className="group/favorite flex items-center gap-1 rounded-my-md transition-colors hover:bg-my-layer-transparent-hover">
              <button type="button" onClick={() => { localTasks(); openIssue(issue.id) }} className="flex min-h-9 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-my-sm text-my-secondary hover:text-my-primary">
                <Star size={16} className="shrink-0 text-my-icon-tertiary" /><span className="truncate" title={issue.name}>{issue.name}</span>
              </button>
              <button type="button" aria-label={`取消收藏 ${issue.name}`} onClick={() => toggleFavorite(issue.id)} className="my-hover-reveal-target mr-1 rounded-my-sm p-1 text-my-icon-tertiary opacity-0 transition-all hover:bg-my-layer-transparent-hover hover:text-my-primary group-hover/favorite:opacity-100 group-focus-within/favorite:opacity-100 focus-visible:opacity-100"><X size={12} /></button>
            </div>)}
            </div>
          </details>}
          </div>
        </details>
      </>}
      {domain === 'team' && <>
        {([['overview', '概况', <Users size={16} />], ['members', '成员', <CircleUser size={16} />], ['activity', '动态', <Activity size={16} />]] as Array<[TeamView, string, ReactNode]>).map(([id, label, icon]) => row(id, label, page === 'team' && teamView === id, icon, () => { setTeamView(id); setPage('team') }))}
        {route('analytics')}
        {row('reports', '报告', page === 'team' && teamView === 'reports', <FileText size={16} />, () => { setTeamView('reports'); setPage('team') })}
        {route('crux')}
        <p className="my-item-description px-3 pt-4 leading-relaxed">当前项目的成员责任、协作记录与交付情况。</p>
      </>}
    </div>}
  </aside>
}
