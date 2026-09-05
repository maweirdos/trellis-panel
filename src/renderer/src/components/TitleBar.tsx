import { useEffect, useState } from 'react'
import { Leaf, Minus, Square, X, Copy } from 'lucide-react'
import { api } from '../api'
import { useApp } from '../store'
import { clsx } from 'clsx'

function WinButton({
  onClick,
  children,
  danger
}: {
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'no-drag grid h-full w-11 place-items-center text-mist-300 transition-colors',
        danger ? 'hover:bg-red-600 hover:text-white' : 'hover:bg-ink-700 hover:text-mist-100'
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
    <header className="drag-region relative z-50 flex h-10 shrink-0 items-center border-b border-ink-700 bg-ink-850">
      <div className="flex items-center gap-2 px-3.5">
        <Leaf size={15} className="text-leaf" strokeWidth={2.4} />
        <span className="text-[13px] font-semibold tracking-wide text-mist-100">Trellis Panel</span>
      </div>
      {snapshot && (
        <div className="ml-2 flex min-w-0 items-center gap-1.5 rounded-md bg-ink-800 px-2 py-0.5 text-[11px] text-mist-300">
          <span className="max-w-[260px] truncate" title={snapshot.meta.root}>
            {snapshot.meta.name}
          </span>
          {snapshot.meta.version && (
            <span className="rounded bg-ink-750 px-1 font-mono text-[10px] text-mist-400">
              v{snapshot.meta.version}
            </span>
          )}
        </div>
      )}
      <div className="ml-auto flex h-full items-stretch">
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
