import { useId, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { PanelRightOpen } from 'lucide-react'
import { Button } from '../my/ui'
import { useInteractionGuard } from '../utils/interaction-scope'
import { usePointerResize } from '../utils/use-pointer-resize'
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
export function ConversationPreviewLayout({ ownerKey, children, preview, expanded, onExpandedChange, collapsed = false, onCollapsedChange, previewCount = 1 }: ConversationPreviewLayoutProps): JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLElement>(null)
  const reopen = useRef<HTMLDivElement>(null)
  const previewFocused = useRef(false)
  const reopenRequested = useRef(false)
  const previous = useRef({ ownerKey, collapsed })
  const canInteract = useInteractionGuard()
  const panelId = useId()
  const [available, setAvailable] = useState(0)
  const [widths, setWidths] = useState<Record<string, number>>({})
  const visible = Boolean(preview) && !collapsed
  useLayoutEffect(() => {
    const prior = previous.current
    previous.current = { ownerKey, collapsed }
    if (prior.ownerKey !== ownerKey || prior.collapsed === collapsed || !canInteract()) return
    if (collapsed && previewFocused.current) reopen.current?.querySelector('button')?.focus({ preventScroll: true })
    else if (!collapsed && reopenRequested.current) pane.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true })
    reopenRequested.current = false
  }, [ownerKey, collapsed, canInteract])
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = (): void => setAvailable(element.getBoundingClientRect().width)
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
  return <div ref={container} className="acp-conversation-preview-layout" data-preview-open={visible} data-preview-collapsed={Boolean(preview) && collapsed} onFocusCapture={event => { previewFocused.current = Boolean(pane.current?.contains(event.target)) }}>
    <div className="acp-conversation-preview-main" tabIndex={-1}>{children}</div>
    {Boolean(preview) && collapsed && <div ref={reopen} className="acp-preview-reopen">
      <Button size="sm" variant="ghost" aria-label={`展开预览栏，${previewCount} 个标签页`} aria-controls={panelId} aria-expanded={false} title="展开预览栏" onClick={() => { if (canInteract()) { reopenRequested.current = true; onCollapsedChange?.(false) } }}><PanelRightOpen size={16} /><span>预览</span><span className="acp-preview-count">{previewCount}</span></Button>
    </div>}
    {Boolean(preview) && <aside ref={pane} id={panelId} hidden={collapsed} aria-hidden={collapsed} {...{ inert: collapsed ? '' : undefined }} aria-label="产物预览面板" className={`acp-web-preview-pane${resizing ? ' is-resizing' : ''}`} style={{ width: available ? width : '50%' }}>
      <div {...bindings} role="separator" aria-label="调整网页预览宽度" aria-orientation="vertical" aria-controls={panelId} aria-valuemin={Math.round(minimum)} aria-valuemax={Math.round(maximum)} aria-valuenow={Math.round(width)} tabIndex={0} className="acp-web-preview-resize" title="拖动调整宽度，双击恢复；方向键微调" onDoubleClick={() => resize(available / 2)} onKeyDown={event => {
        if (!canInteract() || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
        const step = event.shiftKey ? 40 : 10
        const next = event.key === 'ArrowLeft' ? width + step : event.key === 'ArrowRight' ? width - step : event.key === 'Home' ? minimum : event.key === 'End' ? maximum : null
        if (next === null) return
        event.preventDefault(); event.stopPropagation(); resize(next)
      }} />
      {preview}
    </aside>}
  </div>
}
