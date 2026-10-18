import type { JSX } from 'react'
import { Bot, BookOpen, Cloud, FileText, Hash, MessageSquare, MessagesSquare } from 'lucide-react'
import { useApp, type Page } from '../../store'
import { useMy } from '../store'
import type { AgentView, KnowledgeView } from '../navigation'

export const contextButtonClass = (selected: boolean): string => `my-context-button my-nav-item flex min-h-9 w-full items-center gap-2.5 rounded-my-md px-3 py-2 text-left text-my-sm transition-colors ${selected ? 'is-selected font-medium text-my-primary' : 'text-my-secondary'}`

/** Embedded in the existing source browser: one sidebar, one route authority. */
export function ModuleLinks({ domain, agentView, onAgentView }: {
  domain: 'agents' | 'knowledge'
  agentView?: AgentView
  onAgentView?: (view: AgentView) => void
}): JSX.Element {
  const page = useApp((state) => state.page)
  const setPage = useApp((state) => state.setPage)
  const knowledgeView = useMy((state) => state.knowledgeView)
  const setKnowledgeView = useMy((state) => state.setKnowledgeView)
  const requestAgentView = useMy((state) => state.requestAgentView)
  const agent = (view: AgentView): void => {
    if (page === 'acp' && onAgentView) onAgentView(view)
    else { requestAgentView(view); setPage('acp') }
  }
  const knowledge = (view: KnowledgeView): void => { setKnowledgeView(view); setPage('knowledge') }
  const row = (key: string, label: string, selected: boolean, icon: JSX.Element, action: () => void): JSX.Element => (
    <button key={key} type="button" className={contextButtonClass(selected)} aria-current={selected ? 'page' : undefined} onClick={action}>{icon}{label}</button>
  )
  const route = (target: Page, label: string, icon: JSX.Element): JSX.Element => row(target, label, page === target, icon, () => setPage(target))
  return <nav aria-label={domain === 'agents' ? '智能体导航' : '知识导航'} className="shrink-0 space-y-0.5 border-b border-my-line px-2 py-2">
    {domain === 'agents' ? <>
      {row('conversation', '对话', page === 'acp' && agentView !== 'roles', <MessageSquare size={16} />, () => agent('conversation'))}
      {row('roles', '角色', page === 'acp' && agentView === 'roles', <Bot size={16} />, () => agent('roles'))}
      {route('channels', '频道', <Hash size={16} />)}
      {route('chat', '问答', <MessagesSquare size={16} />)}
    </> : <>
      {row('materials', '资料', page === 'knowledge' && knowledgeView === 'materials', <FileText size={16} />, () => knowledge('materials'))}
      {route('spec', '规范', <BookOpen size={16} />)}
      {row('company', '公司库', page === 'knowledge' && knowledgeView === 'company', <Cloud size={16} />, () => knowledge('company'))}
    </>}
  </nav>
}
