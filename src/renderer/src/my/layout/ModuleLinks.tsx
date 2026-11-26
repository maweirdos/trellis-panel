import type { JSX } from 'react'
import { Bot, BookOpen, Cloud, FileText, FolderOpen, Hash, MessageSquare, MessagesSquare, PanelsTopLeft, Sparkles } from 'lucide-react'
import { useApp, type Page } from '../../store'
import { useMy } from '../store'
import type { AgentView, KnowledgeView } from '../navigation'

export const contextButtonClass = (selected: boolean): string => `my-context-button my-nav-item flex min-h-8 w-full items-center gap-2 rounded-my-md px-2.5 py-1.5 text-left text-my-sm transition-colors ${selected ? 'is-selected font-medium text-my-primary' : 'text-my-secondary'}`

/** Embedded in the existing source browser: one sidebar, one route authority. */
export function ModuleLinks({ domain, agentView }: {
  domain: 'agents' | 'knowledge'
  agentView?: AgentView
}): JSX.Element {
  const page = useApp((state) => state.page)
  const setPage = useApp((state) => state.setPage)
  const hasProject = useApp((state) => Boolean(state.snapshot?.meta.root))
  const knowledgeView = useMy((state) => state.knowledgeView)
  const setKnowledgeView = useMy((state) => state.setKnowledgeView)
  const requestAgentView = useMy((state) => state.requestAgentView)
  const agent = (view: AgentView): void => {
    useMy.getState().setTaskConversationTarget(null)
    requestAgentView(view)
    if (useApp.getState().page !== 'acp') setPage('acp')
  }
  const knowledge = (view: KnowledgeView): void => {
    if (useMy.getState().knowledgeView !== view) setKnowledgeView(view)
    if (useApp.getState().page !== 'knowledge') setPage('knowledge')
  }
  const row = (key: string, label: string, selected: boolean, icon: JSX.Element, action: () => void): JSX.Element => (
    <button key={key} type="button" className={contextButtonClass(selected)} aria-current={selected ? 'page' : undefined} onClick={action}>{icon}{label}</button>
  )
  const route = (target: Page, label: string, icon: JSX.Element): JSX.Element => row(target, label, page === target, icon, () => {
    const app = useApp.getState()
    if (app.page !== target || target === 'chat' && app.privateCodeChat) setPage(target)
  })
  return <nav aria-label={domain === 'agents' ? '对话导航' : '资料空间导航'} className="flex shrink-0 flex-col gap-0.5 border-b border-my-line px-2 py-2">
    {domain === 'agents' ? <>
      {route('chat', '对话', <MessagesSquare size={16} />)}
      {hasProject && <>
      {row('conversation', '工程对话', page === 'acp' && (agentView === 'conversation' || !agentView), <MessageSquare size={16} />, () => agent('conversation'))}
      {row('native', '原生对话', page === 'acp' && agentView === 'native', <Sparkles size={16} />, () => agent('native'))}
      {row('roles', '角色', page === 'acp' && agentView === 'roles', <Bot size={16} />, () => agent('roles'))}
      {route('channels', '频道', <Hash size={16} />)}
      </>}
    </> : <>
      {row('team', '空间文档库', page === 'knowledge' && knowledgeView === 'team', <FileText size={16} />, () => knowledge('team'))}
      {row('personal', '我的文档与产物', page === 'knowledge' && knowledgeView === 'personal', <PanelsTopLeft size={16} />, () => knowledge('personal'))}
      {row('company', '企业知识库', page === 'knowledge' && knowledgeView === 'company', <Cloud size={16} />, () => knowledge('company'))}
      {hasProject ? <>
        {row('project', '当前目录资料', page === 'knowledge' && knowledgeView === 'project', <FolderOpen size={16} />, () => knowledge('project'))}
        {route('spec', '项目规范', <BookOpen size={16} />)}
      </> : row('project', '本机目录资料', page === 'knowledge' && knowledgeView === 'project', <FolderOpen size={16} />, () => knowledge('project'))}
    </>}
  </nav>
}
