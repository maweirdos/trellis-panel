import { type JSX, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { BookOpen, ChartColumn, CircleUser, FolderInput, House, ListTodo, MessageSquare, Moon, Plus, RotateCw, Settings2, Star, Sun, Users, X } from 'lucide-react'
import { useApp, type Page } from '../../store'
import { useMy } from '../store'
import { Avatar, Dropdown, DropdownItem } from '../ui'
import { NavIcon } from '../icons'
import {
  activeModule, APPLICATION_TOOLS, getPageNavigation, hasShellContext, INTAKE_PAGES,
  PRIMARY_NAVIGATION, PROJECT_TOOLS, type ModuleId
} from '../navigation'

const MODULE_ICONS: Record<ModuleId, ReactNode> = {
  overview: <House size={22} strokeWidth={1.8} />, intake: <FolderInput size={22} strokeWidth={1.8} />, work: <ListTodo size={22} strokeWidth={1.8} />,
  iterations: <RotateCw size={22} strokeWidth={1.8} />, knowledge: <BookOpen size={22} strokeWidth={1.8} />, conversations: <MessageSquare size={22} strokeWidth={1.8} />,
  team: <Users size={22} strokeWidth={1.8} />, analytics: <ChartColumn size={22} strokeWidth={1.8} />, tools: <Settings2 size={22} strokeWidth={1.8} />
}

/** The rail remains fixed; context contains only useful views of its active module. */
export function WorkspaceSidebar(): JSX.Element {
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const snapshot = useApp((s) => s.snapshot)
  const view = useMy((s) => s.workItemsView)
  const setView = useMy((s) => s.setWorkItemsView)
  const collapsed = useMy((s) => s.sidebarCollapsed)
  const theme = useMy((s) => s.theme)
  const toggleTheme = useMy((s) => s.toggleTheme)
  const current = activeModule(page, view)
  const railClass = (selected: boolean): string => clsx('my-module-button relative grid h-10 w-10 shrink-0 place-items-center rounded-my-lg transition-colors',
    selected ? 'bg-my-layer-transparent-selected text-my-primary' : 'text-my-icon-secondary hover:bg-my-layer-transparent-hover hover:text-my-primary')
  return <>
    <aside aria-label="固定模块栏" className="my-module-rail flex h-full w-14 shrink-0 flex-col items-center py-3">
      <nav aria-label="项目模块" className="my-scrollbar flex min-h-0 w-full flex-1 flex-col items-center gap-2">
        {PRIMARY_NAVIGATION.map((item) => (
          <button key={item.id} type="button" aria-label={item.label} title={item.label}
            aria-current={current === item.id ? 'page' : undefined}
            onClick={() => { if (item.view) setView(item.view); setPage(item.page) }} className={railClass(current === item.id)}>
            {MODULE_ICONS[item.id]}
          </button>
        ))}
      </nav>
      <div className="mt-4 flex w-full shrink-0 flex-col items-center gap-3">
        <button type="button" aria-label="工具与设置" title="工具与设置" aria-current={current === 'tools' ? 'page' : undefined}
          onClick={() => setPage('settings')} className={railClass(current === 'tools')}>
          {MODULE_ICONS.tools}
        </button>
        <Dropdown width={210} trigger={({ open, toggle }) => (
          <button type="button" aria-label="用户与主题" title="用户与主题" aria-expanded={open} onClick={toggle}
            className="grid h-10 w-10 place-items-center rounded-my-lg hover:bg-my-layer-transparent-hover">
            <Avatar name={snapshot?.meta.developer ?? '本机用户'} color="var(--my-bg-accent-primary)" size={28} />
          </button>
        )}>
          {(close) => <>
            <div className="px-3 py-2 text-my-sm font-medium text-my-primary">{snapshot?.meta.developer ?? '本机用户'}</div>
            <DropdownItem icon={<CircleUser size={14} />} onClick={() => { setPage('settings'); close() }}>个人与应用设置</DropdownItem>
            <DropdownItem icon={theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />} onClick={() => { toggleTheme(); close() }}>切换{theme === 'dark' ? '亮色' : '深色'}主题</DropdownItem>
          </>}
        </Dropdown>
      </div>
    </aside>
    {!collapsed && hasShellContext(page) && <ContextSidebar />}
  </>
}

function ContextSidebar(): JSX.Element {
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const data = useMy((s) => s.data)
  const view = useMy((s) => s.workItemsView)
  const tab = useMy((s) => s.workItemsTab)
  const setTab = useMy((s) => s.setWorkItemsTab)
  const setView = useMy((s) => s.setWorkItemsView)
  const setCreate = useMy((s) => s.setCreateIssueOpen)
  const favorites = useMy((s) => s.favorites)
  const toggleFavorite = useMy((s) => s.toggleFavorite)
  const openIssue = useMy((s) => s.openIssue)
  const savedViews = useMy((s) => s.savedViews)
  const applyView = useMy((s) => s.applyView)
  const removeView = useMy((s) => s.removeView)
  const domain = getPageNavigation(page).domain
  const title = domain === 'work' ? view === 'iterations' && page === 'tasks' ? '自然周计划' : '工作视图' : domain === 'intake' ? '需求来源' : '工具与设置'
  const buttonClass = (selected: boolean): string => clsx('my-context-button mb-0.5 flex min-h-9 w-full items-center gap-2.5 rounded-my-md px-3 py-2 text-left text-my-lg transition-colors',
    selected ? 'bg-my-layer-transparent-selected text-my-primary font-medium' : 'text-my-secondary hover:bg-my-layer-transparent-hover')
  const routeButton = (target: Page): JSX.Element => <button key={target} type="button" aria-current={page === target ? 'page' : undefined}
    onClick={() => { if (target === 'tasks' || target === 'archive') setView('items'); setPage(target) }} className={buttonClass(page === target)}>
    <NavIcon name={getPageNavigation(target).icon} size={16} />{getPageNavigation(target).title}
  </button>
  return (
    <aside aria-label={`${title}上下文`} className="my-context-sidebar flex h-full w-[224px] shrink-0 flex-col border-r border-my-line">
      <header className="flex h-[52px] shrink-0 items-center gap-2 px-4">
        <h2 className="flex-1 text-my-xl font-semibold text-my-primary">{title}</h2>
        {domain === 'work' && <button type="button" aria-label="新建工作项" title="新建工作项 (C)" onClick={() => setCreate(true)}
          className="grid h-7 w-7 place-items-center rounded-my-md text-my-icon-secondary hover:bg-my-layer-transparent-hover"><Plus size={18} /></button>}
      </header>
      <div className="my-scrollbar min-h-0 flex-1 px-2 pb-4">
        {domain === 'intake' && <>
          {INTAKE_PAGES.map(routeButton)}
          <p className="px-2.5 pt-4 text-my-xs leading-relaxed text-my-tertiary">查看收集的线索或 Jira 粗需求，再整理为可确认的项目工作项。</p>
        </>}
        {domain === 'work' && <>
          {(['all', 'active', 'backlog'] as const).map((id) => <button key={id} type="button" aria-current={page === 'tasks' && tab === id ? 'page' : undefined}
            onClick={() => { setTab(id); setPage('tasks') }} className={buttonClass(page === 'tasks' && tab === id)}>
            <NavIcon name={id === 'all' ? 'work-items' : id === 'active' ? 'cycles' : 'inbox'} size={16} />
            {id === 'all' ? '全部工作项' : id === 'active' ? '进行与待开始' : '未规划'}
          </button>)}
          {page === 'tasks' && view === 'iterations' && <p className="px-2.5 py-3 text-my-xs leading-relaxed text-my-tertiary">按自然周安排与结转。分组说明排期，不代表工作已开始或完成。</p>}
          <div className="mx-3 my-3 border-t border-my-line" />
          {routeButton('archive')}
          {savedViews.length > 0 && <section className="mt-5">
            <h3 className="px-2.5 pb-1.5 text-my-xs text-my-tertiary">保存的视图</h3>
            {savedViews.map((saved) => <div key={saved.id} className="group/view flex items-center gap-1 rounded-my-md hover:bg-my-layer-transparent-hover">
              <button type="button" className="flex min-h-9 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-my-lg text-my-secondary" onClick={() => { applyView(saved.id); setPage('tasks') }}>
                <NavIcon name="views" size={16} /><span className="truncate" title={saved.name}>{saved.name}</span>
              </button>
              <button type="button" aria-label={`删除视图 ${saved.name}`} onClick={() => removeView(saved.id)} className="mr-1 p-1 text-my-icon-tertiary opacity-0 group-hover/view:opacity-100 focus:opacity-100"><X size={12} /></button>
            </div>)}
          </section>}
          {data.issues.some((issue) => favorites.includes(issue.id)) && <section className="mt-5">
            <h3 className="px-2.5 pb-1.5 text-my-xs text-my-tertiary">收藏的工作项</h3>
            {data.issues.filter((issue) => favorites.includes(issue.id)).map((issue) => <div key={issue.id} className="group/favorite flex items-center gap-1 rounded-my-md hover:bg-my-layer-transparent-hover">
              <button type="button" onClick={() => openIssue(issue.id)} className="flex min-h-9 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-my-lg text-my-secondary">
                <Star size={16} className="shrink-0 text-my-icon-tertiary" /><span className="truncate" title={issue.name}>{issue.name}</span>
              </button>
              <button type="button" aria-label={`取消收藏 ${issue.name}`} onClick={() => toggleFavorite(issue.id)} className="mr-1 p-1 text-my-icon-tertiary opacity-0 group-hover/favorite:opacity-100 focus:opacity-100"><X size={12} /></button>
            </div>)}
          </section>}
        </>}
        {domain === 'tools' && <>
          <h3 className="px-2.5 pb-1.5 pt-1 text-my-xs text-my-tertiary">当前项目</h3>
          {PROJECT_TOOLS.map(routeButton)}
          <h3 className="px-2.5 pb-1.5 pt-5 text-my-xs text-my-tertiary">本机与应用</h3>
          {APPLICATION_TOOLS.map(routeButton)}
          <h3 className="px-2.5 pb-1.5 pt-5 text-my-xs text-my-tertiary">应用与项目</h3>
          {routeButton('gateway')}
          <div className="mx-2.5 mt-6 border-t border-my-line pt-3 text-my-xs leading-relaxed text-my-tertiary">
            外部应用将统一接入。现有 Jira 来源可在「需求接入」查看；连接配置仍在设置中管理。
            <p className="mt-2">多项目启动、日志与 Git 查看已列入路线图。</p>
          </div>
        </>}
      </div>
    </aside>
  )
}
