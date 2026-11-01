import { type JSX, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { BookOpen, CircleUser, FolderInput, House, ListTodo, MessageCircle, PanelsTopLeft, RotateCw, Settings2, Star, Users, X, Wrench, Activity, FileText } from 'lucide-react'
import { useApp, type Page } from '../../store'
import { useMy } from '../store'
import { NavIcon } from '../icons'
import { SidebarResizeHandle, useSidebarWidthStyle } from './SidebarResizeHandle'
import { contextButtonClass } from './ModuleLinks'
import { SettingsNavigation } from './SettingsNavigation'
import { activeModule, DOMAIN_LABELS, getPageNavigation, hasShellContext, PRIMARY_NAVIGATION, type ModuleId, type TeamView } from '../navigation'

const MODULE_ICONS: Record<ModuleId, ReactNode> = {
  home: <CircleUser className="my-module-icon" aria-hidden="true" />,
  agents: <MessageCircle className="my-module-icon" aria-hidden="true" />,
  tasks: <ListTodo className="my-module-icon" aria-hidden="true" />,
  team: <Users className="my-module-icon" aria-hidden="true" />,
  knowledge: <BookOpen className="my-module-icon" aria-hidden="true" />,
  settings: <Settings2 className="my-module-icon" aria-hidden="true" />
}

export function WorkspaceSidebar(): JSX.Element {
  const page = useApp((state) => state.page)
  const setPage = useApp((state) => state.setPage)
  const collapsed = useMy((state) => state.sidebarCollapsed)
  const current = activeModule(page)
  const railClass = (selected: boolean): string => clsx('my-module-button my-nav-item relative grid shrink-0 place-items-center transition-colors hover:text-my-primary', selected ? 'is-selected text-my-primary' : 'text-my-icon-secondary')
  return <>
    <aside aria-label="模块栏" className="my-module-rail flex h-full shrink-0 flex-col items-center">
      <nav aria-label="项目模块" className="my-scrollbar flex min-h-0 w-full flex-1 flex-col items-center">
        {PRIMARY_NAVIGATION.map((item) => <button key={item.id} type="button" aria-label={item.label} title={item.label} aria-current={current === item.id ? 'page' : undefined} onClick={() => { const remembered = useMy.getState().modulePages; const target = remembered[item.id] ?? (item.id === 'home' ? remembered.tasks : undefined) ?? item.page; if (current !== item.id && useApp.getState().page !== target) setPage(target) }} className={railClass(current === item.id)}>{MODULE_ICONS[item.id]}</button>)}
      </nav>
      <div className="my-module-footer mt-4 flex w-full shrink-0 flex-col items-center">
        <button type="button" aria-label="设置" title="设置" aria-current={current === 'settings' ? 'page' : undefined} onClick={() => setPage(useMy.getState().modulePages.settings ?? 'settings')} className={railClass(current === 'settings')}>{MODULE_ICONS.settings}</button>
      </div>
    </aside>
    {!collapsed && hasShellContext(page) && <ContextSidebar />}
  </>
}

function ContextSidebar(): JSX.Element {
  const sidebarStyle = useSidebarWidthStyle()
  const page = useApp((state) => state.page)
  const setPage = useApp((state) => state.setPage)
  const personalTaskSource = useApp((state) => state.personalTaskSource)
  const { data, workItemsView: view, setWorkItemsView: setView, setWorkItemsTab: setTab, favorites, toggleFavorite, openIssue, savedViews, applyView, removeView, teamView, setTeamView } = useMy()
  const domain = activeModule(page)
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
    {domain === 'settings' ? <SettingsNavigation /> : <div className="my-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
      {domain === 'home' && <>
        {row('all', '任务', page === 'tasks' && (personalTaskSource === 'team' || view === 'items'), <ListTodo size={16} />, () => { setView('items'); setPage('tasks') })}
        {row('creations', '创作', page === 'creations', <PanelsTopLeft size={16} />, () => setPage('creations'))}
        <details key={`${page}:${personalTaskSource}:${view}`} open={page !== 'tasks' && page !== 'creations' || page === 'tasks' && personalTaskSource === 'local' && view === 'iterations' || undefined} className="group pt-3">
          <summary className="cursor-pointer px-3 py-2 text-my-xs text-my-tertiary">更多</summary>
        {row('overview', '概览', page === 'dashboard', <House size={16} />, () => setPage('dashboard'))}
        {row('local-work', '本地工作', page === 'tasks' && personalTaskSource === 'local' && view === 'items', <ListTodo size={16} />, () => localTasks())}
        {row('iterations', '本地版本', page === 'tasks' && personalTaskSource === 'local' && view === 'iterations', <RotateCw size={16} />, () => { localTasks(true); setTab('all') })}
        {row('intake', '接入', page === 'inbox' || page === 'jira', <FolderInput size={16} />, () => setPage('inbox'))}
        {route('archive')}
        {row('tools', '工具', ['devtools', 'architecture', 'studio'].includes(page), <Wrench size={16} />, () => { const tool = useMy.getState().toolView; setPage(tool === 'architecture' || tool === 'studio' ? tool : 'devtools') })}
          {savedViews.length > 0 && <details open className="mt-5">
            <summary className="cursor-pointer px-2.5 pb-1.5 text-my-xs text-my-tertiary">视图</summary>
            {savedViews.map((saved) => <div key={saved.id} className="group/view flex items-center gap-1 rounded-my-md hover:bg-my-layer-transparent-hover">
              <button type="button" className="flex min-h-9 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-my-sm text-my-secondary" onClick={() => { localTasks(); applyView(saved.id) }}>
                <NavIcon name="views" size={16} /><span className="truncate" title={saved.name}>{saved.name}</span>
              </button>
              <button type="button" aria-label={`删除视图 ${saved.name}`} onClick={() => removeView(saved.id)} className="mr-1 p-1 text-my-icon-tertiary opacity-0 group-hover/view:opacity-100 focus:opacity-100"><X size={12} /></button>
            </div>)}
          </details>}
          {data.issues.some((issue) => favorites.includes(issue.id)) && <details open className="mt-5">
            <summary className="cursor-pointer px-2.5 pb-1.5 text-my-xs text-my-tertiary">收藏</summary>
            {data.issues.filter((issue) => favorites.includes(issue.id)).map((issue) => <div key={issue.id} className="group/favorite flex items-center gap-1 rounded-my-md hover:bg-my-layer-transparent-hover">
              <button type="button" onClick={() => { localTasks(); openIssue(issue.id) }} className="flex min-h-9 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-my-sm text-my-secondary">
                <Star size={16} className="shrink-0 text-my-icon-tertiary" /><span className="truncate" title={issue.name}>{issue.name}</span>
              </button>
              <button type="button" aria-label={`取消收藏 ${issue.name}`} onClick={() => toggleFavorite(issue.id)} className="mr-1 p-1 text-my-icon-tertiary opacity-0 group-hover/favorite:opacity-100 focus:opacity-100"><X size={12} /></button>
            </div>)}
          </details>}
        </details>
      </>}
      {domain === 'team' && <>
        {([['overview', '概况', <Users size={16} />], ['members', '成员', <CircleUser size={16} />], ['activity', '动态', <Activity size={16} />]] as Array<[TeamView, string, ReactNode]>).map(([id, label, icon]) => row(id, label, page === 'team' && teamView === id, icon, () => { setTeamView(id); setPage('team') }))}
        {route('analytics')}
        {row('reports', '报告', page === 'team' && teamView === 'reports', <FileText size={16} />, () => { setTeamView('reports'); setPage('team') })}
        {route('hifox')}
        <p className="my-item-description px-3 pt-4 leading-relaxed">当前项目的成员责任、协作记录与交付情况。</p>
      </>}
    </div>}
  </aside>
}
