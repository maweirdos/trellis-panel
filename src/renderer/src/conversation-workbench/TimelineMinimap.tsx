import { useEffect, useRef, useState, type JSX, type MouseEvent } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import {
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapNavigationInteractive,
  resolveTimelineMinimapTopPercent,
  TIMELINE_MINIMAP_MIN_ITEMS,
  type TimelineMinimapItem,
} from './timelineMinimapLogic'

interface TimelineMinimapProps {
  readonly hasPersistentGutter: boolean
  readonly hitStripWidth: number
  readonly currentIndex: number | null
  readonly atEnd: boolean
  readonly items: readonly TimelineMinimapItem[]
  /** Turn start indices whose strip should read as in view (the parent measures them). */
  readonly inViewRowIndices: ReadonlySet<number>
  readonly onWheel: (event: WheelEvent) => void
  readonly onSelect: (item: TimelineMinimapItem) => void
}

/** A release outside the window can skip mouseup, so the next button-free mousemove also counts. */
function onMouseButtonsReleased(onRelease: () => void): () => void {
  const check = (event: globalThis.MouseEvent): void => {
    if (event.buttons !== 0) return
    stop()
    onRelease()
  }
  const stop = (): void => {
    window.removeEventListener('mouseup', check)
    window.removeEventListener('mousemove', check)
  }
  window.addEventListener('mouseup', check)
  window.addEventListener('mousemove', check)
  return stop
}

/**
 * Ported from t3code@28c58b1 apps/web/src/components/chat/TimelineMinimap.tsx.
 * Strips sit in the lane's side gutter; the hovered turn opens a preview and the
 * wheel scrolls the timeline from the minimap.
 */
export function TimelineMinimap({
  hasPersistentGutter, hitStripWidth, currentIndex, atEnd, items, inViewRowIndices, onWheel, onSelect,
}: TimelineMinimapProps): JSX.Element | null {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [passThrough, setPassThrough] = useState(false)
  const pressedOnStrip = useRef(false)
  const stopWatchingPress = useRef<() => void>()
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => () => stopWatchingPress.current?.(), [])
  useEffect(() => {
    const node = rootRef.current
    if (!node) return
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [onWheel])

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) return null

  const resolvedActiveIndex = activeIndex !== null && activeIndex < items.length ? activeIndex : null
  const activeItem = resolvedActiveIndex === null ? null : items[resolvedActiveIndex] ?? null
  const railInteractive = hitStripWidth > 0 && !passThrough
  const navigationInteractive = resolveTimelineMinimapNavigationInteractive(hitStripWidth) && !passThrough
  const activeTopPercent = resolvedActiveIndex === null ? 0 : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length)
  const resolvedCurrentIndex = currentIndex !== null && currentIndex >= 0 && currentIndex < items.length ? currentIndex : null
  const previousItem = resolvedCurrentIndex === null ? null : items[resolvedCurrentIndex - 1] ?? null
  const nextItem = resolvedCurrentIndex === null || atEnd ? null : items[resolvedCurrentIndex + 1] ?? null

  const resolveActiveIndexFromPointer = (event: MouseEvent<HTMLElement>): number | null => {
    const rect = event.currentTarget.getBoundingClientRect()
    return resolveTimelineMinimapIndexFromPointer({
      itemCount: items.length, railTop: rect.top, railHeight: rect.height, pointerY: event.clientY,
    })
  }
  const moveActiveIndex = (delta: number): void => {
    setActiveIndex(current => Math.max(0, Math.min(items.length - 1, (current ?? 0) + delta)))
  }
  const watchRelease = (onRelease: () => void): void => {
    stopWatchingPress.current?.()
    stopWatchingPress.current = onMouseButtonsReleased(() => {
      stopWatchingPress.current = undefined
      onRelease()
    })
  }

  return (
    <div ref={rootRef} className="conversation-minimap" data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? 'true' : 'false'}>
      <div className="conversation-minimap-inner">
        <div className="conversation-minimap-rail" data-interactive={railInteractive ? 'true' : 'false'}
          style={{ height: resolveTimelineMinimapHeightStyle(items.length), width: hitStripWidth }}
          onMouseDown={() => {
            if (pressedOnStrip.current) return
            pressedOnStrip.current = true
            watchRelease(() => { pressedOnStrip.current = false })
          }}
          onMouseMove={event => {
            if (event.buttons === 0 || pressedOnStrip.current || passThrough) return
            setPassThrough(true)
            watchRelease(() => setPassThrough(false))
          }}>
          <MinimapNavButton direction="previous" disabled={previousItem === null} interactive={navigationInteractive}
            onClick={() => { if (previousItem) onSelect(previousItem) }} />
          <button type="button" className="conversation-minimap-hit"
            tabIndex={railInteractive ? 0 : -1}
            aria-label={`跳到消息：${activeItem?.userText ?? '用户消息'}`}
            onBlur={() => setActiveIndex(null)}
            onClick={event => {
              const index = resolveActiveIndexFromPointer(event)
              const selected = index === null ? null : items[index] ?? null
              if (selected) onSelect(selected)
              event.currentTarget.blur()
            }}
            onFocus={() => setActiveIndex(current => current ?? resolvedCurrentIndex ?? 0)}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') { event.preventDefault(); moveActiveIndex(1) }
              else if (event.key === 'ArrowUp') { event.preventDefault(); moveActiveIndex(-1) }
              else if (event.key === 'Home') { event.preventDefault(); setActiveIndex(0) }
              else if (event.key === 'End') { event.preventDefault(); setActiveIndex(items.length - 1) }
              else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (activeItem) onSelect(activeItem) }
            }}
            onMouseLeave={() => setActiveIndex(null)}
            onMouseMove={event => {
              if (event.buttons !== 0 && !pressedOnStrip.current) return
              const index = resolveActiveIndexFromPointer(event)
              if (index !== null) setActiveIndex(index)
            }}
            onMouseDown={event => event.preventDefault()}>
            {items.map((item, index) => {
              const distance = resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex)
              return <span key={item.id} aria-hidden="true" className="conversation-minimap-strip"
                data-in-view={inViewRowIndices.has(item.rowIndex) ? 'true' : 'false'}
                data-active={distance === null ? 'none' : distance > 2 ? 'far' : String(distance)}
                style={{ top: `${resolveTimelineMinimapTopPercent(index, items.length)}%` }} />
            })}
            {activeItem && <span className="conversation-minimap-preview" style={{ top: `${activeTopPercent}%` }}>
              <strong>{activeItem.userText ?? '用户消息'}</strong>
              {activeItem.assistantText && <span>{activeItem.assistantText}</span>}
            </span>}
          </button>
          <MinimapNavButton direction="next" disabled={nextItem === null} interactive={navigationInteractive}
            onClick={() => { if (nextItem) onSelect(nextItem) }} />
        </div>
      </div>
    </div>
  )
}

function MinimapNavButton({ direction, disabled, interactive, onClick }: {
  readonly direction: 'previous' | 'next'
  readonly disabled: boolean
  readonly interactive: boolean
  readonly onClick: () => void
}): JSX.Element {
  const previous = direction === 'previous'
  const Icon = previous ? ChevronUp : ChevronDown
  return <span className="conversation-minimap-nav" data-direction={direction} data-interactive={interactive ? 'true' : 'false'}
    title={previous ? '上一轮' : '下一轮'}>
    <button type="button" className="my-icon-control" aria-label={previous ? '上一轮' : '下一轮'}
      tabIndex={interactive ? 0 : -1} disabled={disabled} onClick={onClick}>
      <Icon aria-hidden="true" />
    </button>
  </span>
}
