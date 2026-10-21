import type { JSX, ReactNode } from 'react'
import { useApp, type Page } from '../../store'
import { useMy } from '../store'
import { getPageNavigation, navigationScopeLabel, type ToolView } from '../navigation'
import { PAGE_LAYOUTS, PageBody, PageContent, PageHeader, PageLayout, PageNotice } from './PageLayout'

const TEAM_TITLES = { overview: '概况', members: '成员', activity: '动态', reports: '报告' }
/** Framed pages that fill the window: fixed bands above one internal scroll owner. */
const LOCKED_PAGES: readonly Page[] = ['team', 'analytics', 'devtools']
const TOOLS: ReadonlyArray<{ id: ToolView; label: string; page: Page }> = [
  { id: 'git', label: 'Git', page: 'devtools' }, { id: 'run', label: '运行', page: 'devtools' },
  { id: 'architecture', label: '架构', page: 'architecture' }, { id: 'studio', label: '定制', page: 'studio' }
]

/** Page identity belongs here; project identity belongs only to the window header. */
export function PageFrame({ page, children }: { page: Page; children: ReactNode }): JSX.Element {
  const setPage = useApp((state) => state.setPage)
  const { teamView, toolView, setToolView, settingsView } = useMy()
  const navigation = getPageNavigation(page)
  const variant = PAGE_LAYOUTS[page]
  const tools = ['devtools', 'architecture', 'studio'].includes(page)
  const intake = page === 'inbox' || page === 'jira'
  const embeddedKnowledgeLayout = navigation.domain === 'knowledge'
  const title = page === 'team' ? TEAM_TITLES[teamView] : tools ? '工具' : page === 'settings' ? settingsView === 'engines' ? '引擎' : '偏好' : navigation.title
  return <PageLayout variant={variant}>
    {!embeddedKnowledgeLayout && <PageHeader>
      <h1 className="text-my-md font-semibold text-my-primary">{title}</h1>
      {navigation.scope !== 'project' && <span className="my-chip bg-my-layer-1 text-my-secondary">{navigationScopeLabel(navigation.scope)}</span>}
      {(tools || intake) && <nav aria-label={tools ? '工具类型' : '接入来源'} className="ml-auto flex flex-wrap items-center gap-1">
        {tools ? TOOLS.map((item) => {
          const selected = page === item.page && (page !== 'devtools' || toolView === item.id)
          return <button key={item.id} type="button" aria-current={selected ? 'page' : undefined} onClick={() => { setToolView(item.id); setPage(item.page) }} className={`my-control my-control-sm ${selected ? 'bg-my-layer-1-active text-my-primary' : 'text-my-tertiary hover:bg-my-layer-transparent-hover'}`}>{item.label}</button>
        }) : (['inbox', 'jira'] as const).map((target) => <button key={target} type="button" aria-current={page === target ? 'page' : undefined} onClick={() => setPage(target)} className={`my-control my-control-sm ${page === target ? 'bg-my-layer-1-active text-my-primary' : 'text-my-tertiary hover:bg-my-layer-transparent-hover'}`}>{target === 'inbox' ? '待办' : 'Jira'}</button>)}
      </nav>}
    </PageHeader>}
    {!embeddedKnowledgeLayout && navigation.scopeNote && <PageNotice>{navigation.scopeNote}</PageNotice>}
    <PageBody className={LOCKED_PAGES.includes(page) ? 'my-locked-body' : undefined}>{variant === 'centered' ? <PageContent>{children}</PageContent> : children}</PageBody>
  </PageLayout>
}
