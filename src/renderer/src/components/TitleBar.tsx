import { useEffect, useState, type ReactNode } from 'react'
import { Leaf, Minus, Square, X, Copy, PictureInPicture2 } from 'lucide-react'
import { api } from '../api'
import { useApp } from '../store'
import { clsx } from 'clsx'

function WinButton({
  onClick,
  children,
  danger
}: {
  onClick: () => void
  children: ReactNode
  danger?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'no-drag grid h-full w-11 place-items-center text-my-icon-secondary transition-colors',
        danger ? 'hover:bg-my-danger hover:text-my-on-color' : 'hover:bg-my-layer-1-active hover:text-my-primary'
      )}
    >
      {children}
    </button>
  )
}

export function TitleBar(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => api.onWindowMaximized(setMaximized), [])

  return (
    <header className="drag-region relative z-50 flex h-10 shrink-0 items-center border-b border-my-line bg-my-canvas">
      <div className="flex items-center gap-2 px-3.5">
        <Leaf size={15} className="text-my-icon-accent" strokeWidth={2.4} />
        <span className="text-my-md font-semibold tracking-wide text-my-primary">Trellis Panel</span>
      </div>
      {snapshot && (
        <div className="ml-2 flex min-w-0 items-center gap-1.5 rounded-my-md border border-my-line bg-my-layer-1 px-2 py-0.5 text-my-xs text-my-secondary">
          <span className="max-w-[260px] truncate" title={snapshot.meta.root}>
            {snapshot.meta.name}
          </span>
          {snapshot.meta.version && (
            <span className="rounded-my-sm border border-my-line bg-my-layer-2 px-1 font-mono text-my-2xs text-my-tertiary">
              v{snapshot.meta.version}
            </span>
          )}
        </div>
      )}
      <div className="ml-auto flex h-full items-stretch">
        {snapshot && (
          <button
            onClick={() => api.setCapsuleMode(true)}
            className="no-drag grid h-full w-10 place-items-center text-my-icon-secondary transition-colors hover:bg-my-layer-1-active hover:text-my-primary"
            title="切换到胶囊模式（置顶小卡片）"
          >
            <PictureInPicture2 size={13.5} />
          </button>
        )}
        <WinButton onClick={() => api.windowMinimize()}>
          <Minus size={14} />
        </WinButton>
        <WinButton onClick={() => api.windowMaximize()}>
          {maximized ? <Copy size={12} className="-scale-x-100" /> : <Square size={12} />}
        </WinButton>
        <WinButton onClick={() => api.windowClose()} danger>
          <X size={15} />
        </WinButton>
      </div>
    </header>
  )
}
