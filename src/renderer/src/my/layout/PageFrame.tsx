import type { JSX, ReactNode } from 'react'
import { useApp, type Page } from '../../store'
import { AI_MODES, getPageNavigation, navigationScopeLabel } from '../navigation'

/** Page identity belongs here; project identity belongs only to the window header. */
export function PageFrame({ page, children }: { page: Page; children: ReactNode }): JSX.Element {
  const setPage = useApp((s) => s.setPage)
  const navigation = getPageNavigation(page)
  return (
    <div className="flex h-full min-w-0 flex-col bg-my-surface-1">
      <header className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-3 border-b border-my-line px-5 py-2">
        <h1 className="text-my-md font-semibold text-my-primary">{navigation.title}</h1>
        {navigation.scope !== 'project' && <span className="my-chip bg-my-layer-1 text-my-secondary">{navigationScopeLabel(navigation.scope)}</span>}
        {navigation.domain === 'conversations' && <nav aria-label="会话类型" className="ml-auto flex items-center gap-1">
          {AI_MODES.map((target) => <button key={target} type="button" aria-current={page === target ? 'page' : undefined} onClick={() => setPage(target)}
            className={`my-control my-control-sm ${page === target ? 'bg-my-layer-1-active text-my-primary' : 'text-my-tertiary hover:bg-my-layer-transparent-hover'}`}>
            {getPageNavigation(target).title}
          </button>)}
        </nav>}
        {navigation.domain === 'knowledge' && <nav aria-label="知识视图" className="ml-auto flex items-center gap-1">
          {(['knowledge', 'spec'] as const).map((target) => <button key={target} type="button" onClick={() => setPage(target)} aria-current={page === target ? 'page' : undefined}
            className={`my-control my-control-sm ${page === target ? 'bg-my-layer-1-active text-my-primary' : 'text-my-tertiary hover:bg-my-layer-transparent-hover'}`}>
            {target === 'knowledge' ? '检索与阅读' : '规范文档'}
          </button>)}
        </nav>}
      </header>
      {navigation.scopeNote && <p className="shrink-0 border-b border-my-line bg-my-layer-1 px-5 py-2 text-my-xs text-my-tertiary">{navigation.scopeNote}</p>}
      <div className="my-scrollbar min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  )
}
