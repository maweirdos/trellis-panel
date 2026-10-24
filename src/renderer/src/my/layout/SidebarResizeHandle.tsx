import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../appearance'
import { useMy } from '../store'
import { usePointerResize } from '../../utils/use-pointer-resize'

const viewportMax = (): number => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 360))

/** Use on each module's context owner; presentation never owns a separate width. */
export function useSidebarWidthStyle(): CSSProperties {
  const width = useMy((state) => state.sidebarWidth)
  return { '--my-sidebar-width': `${width}px` } as CSSProperties
}

export function SidebarResizeHandle({ label = '调整左侧栏宽度' }: { label?: string }): JSX.Element {
  const width = useMy((state) => state.sidebarWidth)
  const setWidth = useMy((state) => state.setSidebarWidth)
  const handle = useRef<HTMLDivElement>(null)
  const [maximum, setMaximum] = useState(viewportMax)
  useEffect(() => {
    const update = (): void => setMaximum(viewportMax())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const effectiveWidth = Math.min(width, maximum)
  const resize = (value: number): void => setWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(viewportMax(), value)))
  const { bindings } = usePointerResize({
    axis: 'x', getValue: () => handle.current?.parentElement?.getBoundingClientRect().width ?? effectiveWidth,
    onChange: resize, onCancel: () => setWidth(width)
  })

  return <div
    ref={handle}
    {...bindings}
    className="my-sidebar-resize-handle"
    role="separator"
    aria-label={label}
    aria-orientation="vertical"
    aria-valuemin={MIN_SIDEBAR_WIDTH}
    aria-valuemax={maximum}
    aria-valuenow={effectiveWidth}
    aria-valuetext={`${effectiveWidth} 像素`}
    tabIndex={0}
    title="拖动调整宽度，双击恢复默认；方向键微调"
    onDoubleClick={() => resize(DEFAULT_SIDEBAR_WIDTH)}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 40 : 10
      if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
      const next = event.key === 'ArrowLeft' ? effectiveWidth - step : event.key === 'ArrowRight' ? effectiveWidth + step
        : event.key === 'Home' ? MIN_SIDEBAR_WIDTH : event.key === 'End' ? viewportMax() : null
      if (next === null) return
      event.preventDefault()
      event.stopPropagation()
      resize(next)
    }}
  />
}
