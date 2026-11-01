import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { Minus, Square, X, Copy, PictureInPicture2, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { ProjectSwitcher } from '../my/layout/ProjectSwitcher'
import { BrandMark } from '../my/BrandMark'
import { ApplicationPanel } from '../applications/ApplicationPanel'
import { ApplicationRunCenter } from '../applications/ApplicationRunCenter'
import { GitBranchControl } from '../git-workspace/GitBranchControl'
import { closeGitWorkspace } from '../git-workspace/useGitWorkspace'
import { clsx } from 'clsx'
import { getPageNavigation, pageRequiresProject } from '../my/navigation'
import { TeamContextSwitcher } from '../hifox/TeamContextSwitcher'
import { ShellViewSwitcher } from '../my/layout/ShellViewSwitcher'
import { AccountMenu } from '../my/layout/AccountMenu'
import { DevelopmentScopeTag } from '../hifox/development/DevelopmentContextBar'
import { Tooltip } from '../my/ui'
import { InteractionScope } from '../utils/interaction-scope'

function WinButton({ onClick, children, label, danger }: {
  onClick: () => void; children: ReactNode; label: string; danger?: boolean
}): JSX.Element {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}
      className={clsx('my-window-button no-drag grid h-full place-items-center text-my-icon-secondary transition-colors',
        danger ? 'hover:bg-my-danger hover:text-my-on-color' : 'hover:bg-my-layer-1-active hover:text-my-primary')}>
      {children}
    </button>
  )
}

/** Shared main-window header. Native controls are absent in browser preview. */
export function TitleBar(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const page = useApp((s) => s.page)
  const openTaskDir = useApp((s) => s.openTaskDir)
  const teamContext = page === 'hifox' && !openTaskDir
  const development = useMy((s) => s.shellView === 'development')
  const personalTaskSource = useApp((s) => s.personalTaskSource)
  const domain = getPageNavigation(page).domain
  const codeTools = development && (Boolean(openTaskDir) || (
    domain !== 'team' && domain !== 'settings' && page !== 'chat' && page !== 'creations' &&
    (page !== 'tasks' || personalTaskSource !== 'team')
  ))
  const openError = useApp((s) => s.openError)
  const collapsed = useMy((s) => s.sidebarCollapsed)
  const toggleSidebar = useMy((s) => s.toggleSidebar)
  const setPaletteOpen = useMy((s) => s.setPaletteOpen)
  const [maximized, setMaximized] = useState(false)
  useEffect(() => hasIpc ? api.onWindowMaximized(setMaximized) : undefined, [])
  useLayoutEffect(() => { if (!codeTools) closeGitWorkspace() }, [codeTools])
  return (
    <header className="my-window-header relative z-50 flex shrink-0 flex-col">
      <div className={clsx('my-global-header-row', hasIpc && 'drag-region')}>
        <div className="my-module-brand flex h-full shrink-0 items-center justify-center" title="Trellis Panel">
          <BrandMark size={22} className="text-my-primary" />
          <span className="sr-only">Trellis Panel</span>
        </div>
        <ShellViewSwitcher />
        <TeamContextSwitcher variant="global" selectOpensTasks={teamContext} onManageSpaces={() => useApp.getState().setPage('hifox')} />
        <div className="no-drag my-header-collapse flex shrink-0 items-center">
          <Tooltip side="bottom" label={`${collapsed ? '展开' : '收起'}上下文栏 (Ctrl+B)`}>
            <button type="button" aria-label={`${collapsed ? '展开' : '收起'}上下文栏 (Ctrl+B)`}
              aria-expanded={!collapsed} onClick={toggleSidebar}
              className="my-icon-control">
              {collapsed ? <PanelLeftOpen size={18} strokeWidth={1.7} /> : <PanelLeftClose size={18} strokeWidth={1.7} />}
            </button>
          </Tooltip>
        </div>
        <button type="button" disabled={hasIpc && !snapshot && pageRequiresProject(page)} onClick={() => setPaletteOpen(true)}
          className="my-window-search no-drag"
          aria-label="搜索或输入命令 (Ctrl+K)">
          <Search size={15} strokeWidth={1.8} className="shrink-0" /><span className="truncate">搜索或输入命令</span><kbd>Ctrl K</kbd>
        </button>
        <ApplicationRunCenter variant="activity" />
        <AccountMenu />
        {hasIpc && <div className="my-window-controls no-drag flex h-full items-stretch">
          {snapshot && <WinButton label="打开任务悬浮窗" onClick={() => api.setCapsuleMode(true)}><PictureInPicture2 size={14} /></WinButton>}
          <WinButton label="最小化窗口" onClick={() => api.windowMinimize()}><Minus size={14} /></WinButton>
          <WinButton label={maximized ? '还原窗口' : '最大化窗口'} onClick={() => api.windowMaximize()}>{maximized ? <Copy size={12} className="-scale-x-100" /> : <Square size={12} />}</WinButton>
          <WinButton label="关闭窗口" onClick={() => api.windowClose()} danger><X size={15} /></WinButton>
        </div>}
      </div>
      {development && <InteractionScope active={codeTools}><div className="my-shell-code-tools no-drag" hidden={!codeTools} aria-hidden={!codeTools || undefined} ref={(element) => { element?.toggleAttribute('inert', !codeTools) }} role="toolbar" aria-label="Code 工程工具">
        <div className="my-shell-project-controls">
          <ProjectSwitcher />
          <div className="my-shell-development-scope"><DevelopmentScopeTag /></div>
          <GitBranchControl />
          {openError && <Tooltip side="bottom" label={openError} wrap><span role="status" tabIndex={0} className="my-header-project-error text-my-xs text-my-danger-text">工程打开失败</span></Tooltip>}
        </div>
        <ApplicationPanel />
      </div></InteractionScope>}
    </header>
  )
}
