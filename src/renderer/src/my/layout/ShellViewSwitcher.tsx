import { Code2, Users } from 'lucide-react'
import { useMy } from '../store'
import { Button, Tooltip } from '../ui'

/** Presentation preference only: changing it never navigates or controls Runtime. */
export function ShellViewSwitcher({ host = 'desktop' }: { host?: 'desktop' | 'web' }): JSX.Element {
  const view = useMy((state) => state.shellView)
  const setView = useMy((state) => state.setShellView)
  return <div className="no-drag my-shell-view-switcher flex shrink-0 items-center gap-1 rounded-my-md bg-my-layer-1 p-1" role="group" aria-label="工作视图">
    <Tooltip side="bottom" label="协作视图"><Button size="sm" variant={view === 'collaboration' ? 'neutral' : 'ghost'} aria-label="协作视图" aria-pressed={view === 'collaboration'} onClick={() => setView('collaboration')}><Users size={14} /><span>协作</span></Button></Tooltip>
    <Tooltip side="bottom" label={host === 'web' ? '开发视图 · 本机执行需使用桌面端' : '开发视图'}><Button size="sm" variant={view === 'development' ? 'neutral' : 'ghost'} aria-label="开发视图" aria-pressed={view === 'development'} onClick={() => setView('development')}><Code2 size={14} /><span>开发</span></Button></Tooltip>
  </div>
}
