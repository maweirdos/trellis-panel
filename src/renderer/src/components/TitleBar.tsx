import { useEffect, useState, type ReactNode } from 'react'
import { Minus, Square, X, Copy, PictureInPicture2, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { ProjectSwitcher } from '../my/layout/ProjectSwitcher'
import { BrandMark } from '../my/BrandMark'
import { clsx } from 'clsx'

function WinButton({ onClick, children, label, danger }: {
  onClick: () => void; children: ReactNode; label: string; danger?: boolean
}): JSX.Element {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}
      className={clsx('no-drag grid h-full w-11 place-items-center text-my-icon-secondary transition-colors',
        danger ? 'hover:bg-my-danger hover:text-my-on-color' : 'hover:bg-my-layer-1-active hover:text-my-primary')}>
      {children}
    </button>
  )
}

/** Shared main-window header. Native controls are absent in browser preview. */
export function TitleBar(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const openError = useApp((s) => s.openError)
  const collapsed = useMy((s) => s.sidebarCollapsed)
  const toggleSidebar = useMy((s) => s.toggleSidebar)
  const setPaletteOpen = useMy((s) => s.setPaletteOpen)
  const [maximized, setMaximized] = useState(false)
  useEffect(() => hasIpc ? api.onWindowMaximized(setMaximized) : undefined, [])
  return (
    <header className={clsx('my-window-header relative z-50 flex h-my-header shrink-0 items-center', hasIpc && 'drag-region')}>
      <div className="my-module-brand flex h-full shrink-0 items-center justify-center" title="Trellis Panel">
        <BrandMark size={22} className="text-my-primary" />
        <span className="sr-only">Trellis Panel</span>
      </div>
      <ProjectSwitcher />
      {openError && <span role="status" title={openError} className="ml-2 shrink-0 text-my-xs text-my-danger-text">项目打开失败</span>}
      {!snapshot && <span className="ml-2 shrink-0 text-my-xs text-my-tertiary">{hasIpc ? '选择本地项目' : '演示预览'}</span>}
      <div className="no-drag ml-1 flex shrink-0 items-center">
        <button type="button" aria-label={`${collapsed ? '展开' : '收起'}上下文栏 (Ctrl+B)`}
          title="收起 / 展开上下文栏 (Ctrl+B)" onClick={toggleSidebar}
          className="my-icon-control">
          {collapsed ? <PanelLeftOpen size={18} strokeWidth={1.7} /> : <PanelLeftClose size={18} strokeWidth={1.7} />}
        </button>
      </div>
      <button type="button" disabled={hasIpc && !snapshot} onClick={() => setPaletteOpen(true)}
        className="my-window-search no-drag ml-auto mr-3 flex h-my-icon min-w-0 items-center gap-2.5 rounded-my-md px-2.5 text-my-secondary transition-colors hover:bg-my-layer-transparent-hover hover:text-my-primary disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="搜索或输入命令 (Ctrl+K)">
        <Search size={16} strokeWidth={1.8} /><span className="truncate text-left text-my-md">搜索或输入命令</span><kbd className="ml-2 whitespace-nowrap font-sans text-my-xs text-my-tertiary">Ctrl K</kbd>
      </button>
      {hasIpc && <div className="no-drag flex h-full items-stretch">
            {snapshot && <WinButton label="打开任务悬浮窗" onClick={() => api.setCapsuleMode(true)}><PictureInPicture2 size={14} /></WinButton>}
        <WinButton label="最小化窗口" onClick={() => api.windowMinimize()}><Minus size={14} /></WinButton>
        <WinButton label={maximized ? '还原窗口' : '最大化窗口'} onClick={() => api.windowMaximize()}>{maximized ? <Copy size={12} className="-scale-x-100" /> : <Square size={12} />}</WinButton>
        <WinButton label="关闭窗口" onClick={() => api.windowClose()} danger><X size={15} /></WinButton>
      </div>}
    </header>
  )
}
