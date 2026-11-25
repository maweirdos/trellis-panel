import { type ReactNode, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type ComposerCommandMenuPosition = {
  bottom: number
  left: number
  maxHeight: number
  width: number
}

function composerCommandMenuPositionsEqual(
  previous: ComposerCommandMenuPosition,
  next: ComposerCommandMenuPosition,
): boolean {
  return previous.bottom === next.bottom && previous.left === next.left &&
    previous.maxHeight === next.maxHeight && previous.width === next.width
}

export function ComposerCommandMenuLayer({ anchor, children }: {
  readonly anchor: HTMLElement | null
  readonly children: ReactNode
}) {
  const [position, setPosition] = useState<ComposerCommandMenuPosition | null>(null)
  const portalRoot = anchor?.closest('.my-root')

  useLayoutEffect(() => {
    if (!anchor) return

    const updatePosition = () => {
      const form = anchor.closest<HTMLElement>('[data-chat-composer-form="true"]')
      const mainSurface = form?.querySelector<HTMLElement>('[data-chat-composer-main-surface="true"]')
      const rect = (mainSurface ?? form ?? anchor).getBoundingClientRect()
      const rootFontSizePx = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16
      const drawerInsetRem = Number.parseFloat(
        window.getComputedStyle(form ?? anchor).getPropertyValue('--chat-composer-drawer-inset'),
      )
      const drawerInset = drawerInsetRem * rootFontSizePx
      const width = rect.width - drawerInset * 2
      if (!Number.isFinite(width) || width <= 0) {
        setPosition(null)
        return
      }
      const composerOverlap = rootFontSizePx + 1
      const spaceAbove = rect.top + composerOverlap
      const bottom = window.innerHeight - spaceAbove
      const floorHeight = Math.max(96, spaceAbove - 24)
      const maxHeight = Math.min(floorHeight, window.innerHeight)
      const next = {
        bottom: Math.min(bottom, window.innerHeight - maxHeight),
        left: rect.left + drawerInset,
        maxHeight,
        width,
      }
      setPosition(current => current && composerCommandMenuPositionsEqual(current, next) ? current : next)
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    const observer = new ResizeObserver(updatePosition)
    for (let element: Element | null = anchor; element; element = element.parentElement) observer.observe(element)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchor])

  if (!anchor || !position || !portalRoot) return null

  return createPortal(
    <div data-composer-drawer-layer="true" style={position}>
      {children}
    </div>,
    portalRoot,
  )
}
