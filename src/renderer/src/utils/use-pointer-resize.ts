import { useId, useLayoutEffect, useRef, useState, type PointerEventHandler } from 'react'
import { useEscLayer } from './use-esc-layer'
import { useInteractionActive } from './interaction-scope'

interface PointerResizeOptions {
  axis: 'x' | 'y'
  direction?: 1 | -1
  enabled?: boolean
  owner?: unknown
  getValue: () => number
  onChange: (value: number) => void
  onCancel: (initialValue: number) => void
}

interface PointerResizeBindings {
  onPointerDown: PointerEventHandler<HTMLDivElement>
  onPointerMove: PointerEventHandler<HTMLDivElement>
  onPointerUp: PointerEventHandler<HTMLDivElement>
  onPointerCancel: PointerEventHandler<HTMLDivElement>
  onLostPointerCapture: PointerEventHandler<HTMLDivElement>
}

/** Pointer completion commits; every interrupted drag restores its original owner. */
export function usePointerResize(options: PointerResizeOptions): { resizing: boolean; bindings: PointerResizeBindings } {
  const interactive = useInteractionActive()
  const enabled = options.enabled !== false && interactive
  const id = useId()
  const [resizing, setResizing] = useState(false)
  const drag = useRef<{
    pointer: number; start: number; value: number; target: HTMLDivElement
    restore: () => void; cancel: () => void
  } | null>(null)

  const finish = (cancel: boolean): void => {
    const current = drag.current
    if (!current) return
    drag.current = null
    if (cancel) current.cancel()
    current.restore()
    if (current.target.hasPointerCapture(current.pointer)) current.target.releasePointerCapture(current.pointer)
    setResizing(false)
  }
  useEscLayer(resizing, { kind: 'modal', id: `resize-${id}`, onClose: () => finish(true) })

  useLayoutEffect(() => {
    const cancel = (): void => finish(true)
    const hidden = (): void => { if (document.visibilityState === 'hidden') cancel() }
    if (!enabled) cancel()
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', hidden)
      cancel()
    }
  }, [enabled, options.owner])

  const interrupted: PointerEventHandler<HTMLDivElement> = (event) => {
    if (drag.current?.pointer === event.pointerId) finish(true)
  }
  return { resizing, bindings: {
    onPointerDown: (event) => {
      if (!enabled || drag.current || event.button !== 0 || !event.isPrimary) return
      const target = event.currentTarget
      const surface = target.parentElement
      if (!surface) return
      event.preventDefault()
      target.focus({ preventScroll: true })
      const value = options.getValue()
      const transition = surface.style.getPropertyValue('transition')
      const priority = surface.style.getPropertyPriority('transition')
      const selection = surface.style.userSelect
      surface.style.setProperty('transition', 'none', 'important')
      surface.style.userSelect = 'none'
      drag.current = {
        pointer: event.pointerId, start: options.axis === 'x' ? event.clientX : event.clientY, value, target,
        cancel: () => options.onCancel(value),
        restore: () => {
          if (transition) surface.style.setProperty('transition', transition, priority)
          else surface.style.removeProperty('transition')
          surface.style.userSelect = selection
        }
      }
      try { target.setPointerCapture(event.pointerId) } catch { finish(true); return }
      setResizing(true)
    },
    onPointerMove: (event) => {
      const current = drag.current
      if (current?.pointer !== event.pointerId) return
      const position = options.axis === 'x' ? event.clientX : event.clientY
      options.onChange(current.value + (position - current.start) * (options.direction ?? 1))
    },
    onPointerUp: (event) => { if (drag.current?.pointer === event.pointerId) finish(false) },
    onPointerCancel: interrupted,
    onLostPointerCapture: interrupted
  } }
}
