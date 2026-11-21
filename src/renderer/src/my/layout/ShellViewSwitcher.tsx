import { Briefcase, ChevronDown, Code2, Users } from 'lucide-react'
import { clsx } from 'clsx'
import { useMy } from '../store'
import { Button, Dropdown, DropdownHeader, DropdownItem, Tooltip } from '../ui'

/** Presentation preference only: changing it never navigates or controls Runtime. */
export function ShellViewSwitcher({ host = 'desktop' }: { host?: 'desktop' | 'web' }): JSX.Element {
  const view = useMy((state) => state.shellView)
  const setView = useMy((state) => state.setShellView)
  if (host === 'desktop') {
    const development = view === 'development'
    const name = development ? 'Code' : 'Work'
    const description = development ? '工程、变更与运行' : '需求、设计与资料'
    return <Dropdown className="no-drag my-desktop-view-switcher" placement="bottom" width={240} trigger={({ open, toggle }) => <Tooltip side="bottom" label={`${name} · ${description}`}>
      <Button variant="ghost" className="my-desktop-view-trigger" aria-label={`工作视图：${name}`} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        {development ? <Code2 size={15} strokeWidth={1.7} aria-hidden="true" /> : <Briefcase size={15} strokeWidth={1.7} aria-hidden="true" />}
        <span className="my-item-title">{name}</span>
        <ChevronDown size={12} strokeWidth={1.7} className={clsx('my-trigger-chevron shrink-0 text-my-icon-tertiary transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </Button>
    </Tooltip>}>
      {(close) => <div className="my-shell-view-menu">
        <DropdownHeader>工作视图</DropdownHeader>
        <DropdownItem
          icon={<Briefcase size={16} strokeWidth={1.7} />}
          selected={!development}
          description="需求、设计与资料"
          onClick={() => { setView('collaboration'); close() }}
        >
          Work
        </DropdownItem>
        <DropdownItem
          icon={<Code2 size={16} strokeWidth={1.7} />}
          selected={development}
          description="工程、变更与运行"
          onClick={() => { setView('development'); close() }}
        >
          Code
        </DropdownItem>
      </div>}
    </Dropdown>
  }
  return <div className="no-drag my-shell-view-switcher flex shrink-0 items-center gap-1 rounded-my-md bg-my-layer-1 p-1" role="group" aria-label="工作视图">
    <Tooltip side="bottom" label="协作视图"><Button size="sm" variant={view === 'collaboration' ? 'neutral' : 'ghost'} aria-label="协作视图" aria-pressed={view === 'collaboration'} onClick={() => setView('collaboration')}><Users size={14} /><span>协作</span></Button></Tooltip>
    <Tooltip side="bottom" label={host === 'web' ? '开发视图 · 本机执行需使用桌面端' : '开发视图'}><Button size="sm" variant={view === 'development' ? 'neutral' : 'ghost'} aria-label="开发视图" aria-pressed={view === 'development'} onClick={() => setView('development')}><Code2 size={14} /><span>开发</span></Button></Tooltip>
  </div>
}
