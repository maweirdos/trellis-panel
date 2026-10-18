import { useRef, type CSSProperties, type JSX } from 'react'
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../appearance'
import { useMy } from '../store'

/** Use on each module's context owner; presentation never owns a separate width. */
export function useSidebarWidthStyle(): CSSProperties {
  const width = useMy((state) => state.sidebarWidth)
  return { '--my-sidebar-width': `${width}px` } as CSSProperties
}

export function SidebarResizeHandle({ label = '调整左侧栏宽度' }: { label?: string }): JSX.Element {
  const width = useMy((state) => state.sidebarWidth)
  const setWidth = useMy((state) => state.setSidebarWidth)
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const viewportMax = (): number => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 360))
  const resize = (value: number): void => setWidth(Math.min(viewportMax(), value))

  return <div
    className="my-sidebar-resize-handle"
    role="separator"
    aria-label={label}
    aria-orientation="vertical"
    aria-valuemin={MIN_SIDEBAR_WIDTH}
    aria-valuemax={MAX_SIDEBAR_WIDTH}
    aria-valuenow={width}
    aria-valuetext={`${width} 像素`}
    tabIndex={0}
    title="拖动调整宽度，双击恢复默认；方向键微调"
    onPointerDown={(event) => {
      if (event.button !== 0) return
      const owner = event.currentTarget.parentElement
      if (!owner) return
      event.preventDefault()
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: owner.getBoundingClientRect().width }
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={(event) => {
      if (drag.current?.pointerId === event.pointerId) resize(drag.current.startWidth + event.clientX - drag.current.startX)
    }}
    onPointerUp={(event) => {
      if (drag.current?.pointerId !== event.pointerId) return
      drag.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }}
    onPointerCancel={() => { drag.current = null }}
    onLostPointerCapture={() => { drag.current = null }}
    onDoubleClick={() => setWidth(DEFAULT_SIDEBAR_WIDTH)}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 40 : 10
      const next = event.key === 'ArrowLeft' ? width - step : event.key === 'ArrowRight' ? width + step
        : event.key === 'Home' ? MIN_SIDEBAR_WIDTH : event.key === 'End' ? viewportMax() : null
      if (next === null) return
      event.preventDefault()
      event.stopPropagation()
      resize(next)
    }}
  />
}
