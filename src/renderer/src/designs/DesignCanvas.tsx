import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { GripHorizontal, Maximize, Minus, Move, Plus } from 'lucide-react'
import { designFrameSchema, type DesignFrame, type DesignPage, type DesignSelection } from '@shared/design-workspace'
import { DESIGN_GENERATION_DIMENSION_MIN, DESIGN_GENERATION_DIMENSION_MAX } from '@shared/design-generation'
import { Button } from '../my/ui'
import { useInteractionGuard } from '../utils/interaction-scope'
import { DesignPreview, type DesignCanvasWheel, type DesignPreviewPort } from './DesignPreview'
import type { DesignElementPick } from './preview-bridge'

interface Viewport { x: number; y: number; zoom: number }
interface Gesture { pointerId: number; target: HTMLElement; startX: number; startY: number; viewport: Viewport; autoFit: boolean; frame?: DesignFrame; kind: 'pan' | 'move' | 'size' }
export interface DesignCanvasProps {
  documentId: string; revision: string; pages: DesignPage[]; frames: DesignFrame[]; mode: 'select' | 'interact' | 'read'
  pageId: string | null; disabled: boolean; onFrames(frames: DesignFrame[]): void; onPick(pick: DesignElementPick | null): void
  onNavigate(pageId: string): void; onBack(): void; previewPorts: Map<string, DesignPreviewPort>
  restoreSelection?: DesignSelection; selectedFrameId?: string
  onSelectFrame(frameId: string): void; onFrameGestureStart(frame: DesignFrame): void; onFrameGestureEnd(cancelled: boolean): void
}

const clampZoom = (value: number): number => Math.min(2, Math.max(.000001, value))
const zoomLabel = (zoom: number): string => {
  const percent = zoom * 100
  return `${percent < .01 ? percent.toFixed(4) : percent < 1 ? percent.toFixed(2) : Math.round(percent)}%`
}
export function DesignCanvas(props: DesignCanvasProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null), gesture = useRef<Gesture | null>(null), autoFit = useRef(true)
  const [viewport, setViewport] = useState<Viewport>({ x: 40, y: 40, zoom: .45 }), [moving, setMoving] = useState<Gesture['kind'] | null>(null)
  const [panMode, setPanMode] = useState(false)
  const canInteract = useInteractionGuard(), latest = useRef(props), viewRef = useRef(viewport)
  latest.current = props; viewRef.current = viewport
  const updateViewport = useCallback((next: Viewport): void => { viewRef.current = next; setViewport(next) }, [])
  const visibleFrames = useMemo(() => props.frames.filter(frame => !props.pageId || frame.pageId === props.pageId), [props.frames, props.pageId])
  // Frame edits also update page dimensions. Keep route identity stable so those
  // edits do not rebuild the iframe document and interrupt the preview.
  const routeKey = JSON.stringify(props.pages.map(page => ({ id: page.id, title: page.title })))
  const routes = useMemo(() => JSON.parse(routeKey) as Array<{ id: string; title: string }>, [routeKey])
  useEffect(() => {
    const cancel = (event: KeyboardEvent): void => {
      const value = gesture.current
      if (event.key !== 'Escape' || !value) return
      event.preventDefault(); event.stopPropagation()
      gesture.current = null; setMoving(null)
      if (value.frame) latest.current.onFrameGestureEnd(true)
      else { autoFit.current = value.autoFit; updateViewport(value.viewport) }
      if (value.target.hasPointerCapture(value.pointerId)) value.target.releasePointerCapture(value.pointerId)
    }
    window.addEventListener('keydown', cancel, true)
    return () => window.removeEventListener('keydown', cancel, true)
  }, [updateViewport])
  const fit = useCallback((): void => {
    const size = root.current?.getBoundingClientRect()
    const frames = latest.current.frames.filter(frame => !latest.current.pageId || frame.pageId === latest.current.pageId)
    autoFit.current = true
    if (!size || size.width <= 0 || size.height <= 0 || !frames.length) return
    const minX = Math.min(...frames.map(frame => frame.x)), minY = Math.min(...frames.map(frame => frame.y))
    const maxX = Math.max(...frames.map(frame => frame.x + frame.width)), maxY = Math.max(...frames.map(frame => frame.y + frame.height))
    const zoom = Math.min(1, clampZoom(Math.min(Math.max(1, size.width - 80) / (maxX - minX), Math.max(1, size.height - 100) / (maxY - minY))))
    updateViewport({ zoom, x: (size.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (size.height - (maxY - minY) * zoom) / 2 - minY * zoom })
  }, [updateViewport])
  useLayoutEffect(() => { fit() }, [props.documentId, props.pageId, fit])
  useLayoutEffect(() => {
    const node = root.current
    if (!node) return
    const observer = new ResizeObserver(() => { if (autoFit.current && !gesture.current) fit() })
    observer.observe(node)
    return () => observer.disconnect()
  }, [fit])
  useLayoutEffect(() => { if (autoFit.current && !gesture.current) fit() }, [visibleFrames.length, fit])
  const applyWheel = useCallback((wheel: DesignCanvasWheel): void => {
    const node = root.current
    if (!node || !canInteract()) return
    if (wheel.deltaX || wheel.deltaY) autoFit.current = false
    const prior = viewRef.current
    if (wheel.zoom) {
      const box = node.getBoundingClientRect(), x = wheel.clientX - box.left, y = wheel.clientY - box.top, zoom = clampZoom(prior.zoom * Math.exp(-wheel.deltaY * .005))
      updateViewport({ zoom, x: x - (x - prior.x) / prior.zoom * zoom, y: y - (y - prior.y) / prior.zoom * zoom })
    } else updateViewport({ ...prior, x: prior.x - wheel.deltaX, y: prior.y - wheel.deltaY })
  }, [canInteract, updateViewport])
  useLayoutEffect(() => {
    const node = root.current
    if (!node) return
    const wheel = (event: WheelEvent): void => {
      if (!canInteract() || !(event.ctrlKey || event.metaKey) && event.target instanceof Element && event.target.closest('button,input')) return
      event.preventDefault()
      applyWheel({ clientX: event.clientX, clientY: event.clientY, deltaX: event.deltaX, deltaY: event.deltaY, zoom: event.ctrlKey || event.metaKey })
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => node.removeEventListener('wheel', wheel)
  }, [canInteract, applyWheel])
  const begin = (event: ReactPointerEvent<HTMLElement>, kind: Gesture['kind'], frame?: DesignFrame): void => {
    if (!canInteract() || event.button !== 0 && event.button !== 1 || kind !== 'pan' && props.disabled) return
    event.preventDefault(); event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = { pointerId: event.pointerId, target: event.currentTarget, startX: event.clientX, startY: event.clientY, viewport: { ...viewRef.current }, autoFit: autoFit.current, frame: frame ? { ...frame } : undefined, kind }
    setMoving(kind)
    if (kind !== 'pan' && frame) { props.onSelectFrame(frame.id); props.onFrameGestureStart(frame); props.onPick(null) }
  }
  const move = (event: ReactPointerEvent<HTMLElement>): void => {
    const value = gesture.current
    if (!value || value.pointerId !== event.pointerId || !canInteract()) return
    const x = event.clientX - value.startX, y = event.clientY - value.startY
    if (value.kind === 'pan') { if (x || y) autoFit.current = false; updateViewport({ ...value.viewport, x: value.viewport.x + x, y: value.viewport.y + y }); return }
    if (!value.frame) return
    const frame = value.kind === 'move'
      ? { ...value.frame, x: Math.max(-100000, Math.min(100000, Math.round(value.frame.x + x / value.viewport.zoom))), y: Math.max(-100000, Math.min(100000, Math.round(value.frame.y + y / value.viewport.zoom))) }
      : { ...value.frame, width: Math.max(DESIGN_GENERATION_DIMENSION_MIN, Math.min(DESIGN_GENERATION_DIMENSION_MAX, Math.round(value.frame.width + x / value.viewport.zoom))), height: Math.max(DESIGN_GENERATION_DIMENSION_MIN, Math.min(DESIGN_GENERATION_DIMENSION_MAX, Math.round(value.frame.height + y / value.viewport.zoom))) }
    latest.current.onFrames(latest.current.frames.map(item => item.id === frame.id ? frame : item))
  }
  const end = (event: ReactPointerEvent<HTMLElement>, cancel = false): void => {
    const value = gesture.current
    if (!value || value.pointerId !== event.pointerId) return
    gesture.current = null; setMoving(null)
    if (value.frame) latest.current.onFrameGestureEnd(cancel)
    else if (cancel) { autoFit.current = value.autoFit; updateViewport(value.viewport) }
  }
  const zoomBy = (factor: number): void => {
    if (!canInteract()) return
    autoFit.current = false
    const rect = root.current?.getBoundingClientRect(), prior = viewRef.current, zoom = clampZoom(prior.zoom * factor)
    const x = (rect?.width ?? 0) / 2, y = (rect?.height ?? 0) / 2
    updateViewport({ zoom, x: x - (x - prior.x) / prior.zoom * zoom, y: y - (y - prior.y) / prior.zoom * zoom })
  }
  return <div className="design-canvas-shell">
    <div ref={root} className={`design-canvas${panMode ? ' is-panning' : ''}${moving ? ' is-dragging' : ''}`} aria-label="设计画布，滚轮平移，Ctrl 加滚轮缩放" role="region" tabIndex={0} onPointerDown={event => { if (event.target === event.currentTarget || event.button === 1 || panMode) begin(event, 'pan') }} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)} onKeyDown={event => {
      if (event.target !== event.currentTarget || event.nativeEvent.isComposing || !canInteract()) return
      const dx = event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0, dy = event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0
      if (dx || dy) { event.preventDefault(); autoFit.current = false; const view = viewRef.current; updateViewport({ ...view, x: view.x + dx, y: view.y + dy }) }
      else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.2) }
      else if (event.key === '-') { event.preventDefault(); zoomBy(1 / 1.2) }
      else if (event.key === '0') { event.preventDefault(); fit() }
    }}>
      <div className="design-canvas-world" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
        {visibleFrames.map(frame => {
          const page = props.pages.find(page => page.id === frame.pageId)
          if (!page) return null
          const style = { left: frame.x, top: frame.y, width: frame.width, height: frame.height, '--design-zoom': viewport.zoom } as CSSProperties
          return <article className={`design-page-frame${props.selectedFrameId === frame.id ? ' is-selected' : ''}${moving && gesture.current?.frame?.id === frame.id ? ' is-moving' : ''}`} style={style} key={frame.id} aria-label={`${page.title} 页面框`}>
            <button type="button" className="design-frame-heading" title="拖动移动页面框；方向键微调" aria-label={`移动 ${page.title} 页面框`} disabled={props.disabled} onFocus={() => props.onSelectFrame(frame.id)} onPointerDown={event => begin(event, 'move', frame)} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)} onKeyDown={event => {
              if (event.nativeEvent.isComposing || props.disabled || !canInteract()) return
              const step = event.shiftKey ? 1 : 10, dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
              if (dx || dy) { event.preventDefault(); props.onFrames(props.frames.map(value => value.id === frame.id ? { ...value, x: Math.max(-100000, Math.min(100000, value.x + dx)), y: Math.max(-100000, Math.min(100000, value.y + dy)) } : value)) }
            }}><GripHorizontal size={14} /><span>{page.title}</span><span className="design-frame-size">{frame.width} × {frame.height}</span></button>
            <DesignPreview documentId={props.documentId} revision={props.revision} frameId={frame.id} page={page} pages={routes} mode={props.mode} onPick={props.onPick} onNavigate={props.onNavigate} onBack={props.onBack} onCanvasWheel={applyWheel} restoreSelection={props.restoreSelection} ref={port => { if (port) props.previewPorts.set(frame.id, port); else props.previewPorts.delete(frame.id) }} />
            {(panMode || moving) && <div className="design-pan-shield" onPointerDown={event => begin(event, 'pan')} />}
            <button type="button" className="design-frame-resize" disabled={props.disabled} aria-label={`调整 ${page.title} 尺寸`} title="拖动调整尺寸；方向键微调" onFocus={() => props.onSelectFrame(frame.id)} onPointerDown={event => begin(event, 'size', frame)} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)} onKeyDown={event => {
              if (event.nativeEvent.isComposing || props.disabled || !canInteract()) return
              const step = event.shiftKey ? 1 : 10, dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
              if (dx || dy) { event.preventDefault(); const changed = designFrameSchema.safeParse({ ...frame, width: frame.width + dx, height: frame.height + dy }); if (changed.success) props.onFrames(props.frames.map(value => value.id === frame.id ? changed.data : value)) }
            }}><Maximize size={12} /></button>
          </article>
        })}
      </div>
    </div>
    <div className="design-viewport-tools" role="toolbar" aria-label="画布视口">
      <Button size="sm" variant="ghost" aria-label="平移模式" aria-pressed={panMode} onClick={() => setPanMode(value => !value)}><Move size={15} /></Button>
      <Button size="sm" variant="ghost" aria-label="缩小画布" onClick={() => zoomBy(1 / 1.2)}><Minus size={15} /></Button><span className="design-zoom" role="status">{zoomLabel(viewport.zoom)}</span>
      <Button size="sm" variant="ghost" aria-label="放大画布" onClick={() => zoomBy(1.2)}><Plus size={15} /></Button><Button size="sm" variant="ghost" title="适合画布" aria-label="适合画布" onClick={fit}><Maximize size={14} /><span>适合</span></Button>
    </div>
  </div>
}
