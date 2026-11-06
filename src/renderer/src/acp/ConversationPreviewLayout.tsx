import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { useInteractionGuard } from '../utils/interaction-scope'
import { usePointerResize } from '../utils/use-pointer-resize'
import { ConversationPreviewContext } from './ConversationWorkspaceHeader'
import './conversation-preview.css'

export interface ConversationPreviewLayoutProps {
  ownerKey: string
  children: ReactNode
  preview: ReactNode
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  previewCount?: number
}

/** A desktop split at every width; only the right pane owns its resize gesture. */
export function ConversationPreviewLayout({ ownerKey, children, preview, expanded, onExpandedChange, collapsed = false, onCollapsedChange }: ConversationPreviewLayoutProps): JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const previewFocused = useRef(false)
  const previous = useRef({ ownerKey, collapsed })
  const canInteract = useInteractionGuard()
  const panelId = useId()
  const [available, setAvailable] = useState(0)
  const [widths, setWidths] = useState<Record<string, number>>({})
  const hasPreview = Boolean(preview)
  const visible = hasPreview && !collapsed
  useLayoutEffect(() => {
    const prior = previous.current
    previous.current = { ownerKey, collapsed }
    if (prior.ownerKey === ownerKey && prior.collapsed !== collapsed && collapsed && previewFocused.current && canInteract()) {
      toggle.current?.focus({ preventScroll: true })
    }
  }, [ownerKey, collapsed, canInteract])
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      // Keep the last usable size when a retained workspace is temporarily hidden.
      if (rect.width > 0 && rect.height > 0) setAvailable(rect.width)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const minimum = Math.min(320, available * .45)
  const maximum = Math.max(minimum, available - Math.min(360, available * .45))
  const clamp = (width: number): number => Math.min(maximum, Math.max(minimum, width))
  const width = clamp(expanded ? maximum : widths[ownerKey] ?? available / 2)
  const resize = (next: number): void => {
    onExpandedChange(false)
    setWidths(current => ({ ...current, [ownerKey]: clamp(next) }))
  }
  const { resizing, bindings } = usePointerResize({
    axis: 'x', direction: -1, owner: ownerKey, enabled: visible,
    getValue: () => pane.current?.getBoundingClientRect().width ?? width,
    onChange: resize,
    onCancel: () => {
      setWidths(current => {
        const next = { ...current }
        if (widths[ownerKey] === undefined) delete next[ownerKey]
        else next[ownerKey] = widths[ownerKey]
        return next
      })
      onExpandedChange(expanded)
    }
  })
  const controls = hasPreview && onCollapsedChange ? {
    panelId, collapsed, toggleRef: toggle,
    onToggle: (): void => { if (canInteract()) onCollapsedChange(!collapsed) }
  } : null
  return <div ref={container} className="acp-conversation-preview-layout" data-preview-open={visible} data-preview-collapsed={hasPreview && collapsed} onFocusCapture={event => { previewFocused.current = Boolean(pane.current?.contains(event.target)) }}>
    <ConversationPreviewContext.Provider value={controls}><div className="acp-conversation-preview-main" tabIndex={-1}>{children}</div></ConversationPreviewContext.Provider>
    <div className={`acp-conversation-preview-region${!hasPreview || collapsed ? ' is-collapsed' : ''}${resizing ? ' is-resizing' : ''}`} style={{ '--acp-preview-pane-width': `${width}px` } as CSSProperties}>
      {hasPreview && available > 0 && <aside ref={pane} id={panelId} aria-hidden={collapsed || undefined} {...{ inert: collapsed ? '' : undefined }} aria-label="预览面板" className={`acp-web-preview-pane${resizing ? ' is-resizing' : ''}`}>
        <div {...bindings} role="separator" aria-label="调整预览宽度" aria-orientation="vertical" aria-controls={panelId} aria-valuemin={Math.round(minimum)} aria-valuemax={Math.round(maximum)} aria-valuenow={Math.round(width)} tabIndex={0} className="acp-web-preview-resize" title="拖动调整宽度，双击恢复；方向键微调" onDoubleClick={() => resize(available / 2)} onKeyDown={event => {
          if (!canInteract() || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
          const step = event.shiftKey ? 40 : 10
          const next = event.key === 'ArrowLeft' ? width + step : event.key === 'ArrowRight' ? width - step : event.key === 'Home' ? minimum : event.key === 'End' ? maximum : null
          if (next === null) return
          event.preventDefault(); event.stopPropagation(); resize(next)
        }} />
        {preview}
      </aside>}
    </div>
  </div>
}
