// 外壳共享基础件。所有页面从本文件取用，勿各自造轮子。
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode, type RefObject, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'
import { Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Search, X } from 'lucide-react'
import type { Label, Member } from './types'
import { useEscLayer } from '../utils/use-esc-layer'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { MOTION_EXIT_MS, MOTION_POP_EXIT_MS, MOTION_TOOLTIP_EXIT_MS, prefersReducedMotion, usePresence } from './motion'

/* ---------------- Avatar ---------------- */

export function Avatar({
  name,
  color,
  src,
  tone = 'color',
  size = 20,
  className
}: {
  name: string
  color: string
  src?: string
  tone?: 'color' | 'accent'
  size?: number
  className?: string
}): JSX.Element {
  return (
    <div
      title={name}
      className={clsx('flex shrink-0 select-none items-center justify-center rounded-full font-medium', tone === 'accent' ? 'text-my-on-accent' : 'text-my-on-color', src && 'overflow-hidden', className)}
      style={{ width: size, height: size, background: color, fontSize: Math.max(9, size * 0.42) }}
    >
      {src ? <img src={src} alt="" draggable={false} className="h-full w-full object-contain" /> : name.slice(0, 1)}
    </div>
  )
}

export function AvatarStack({ members, max = 3, size = 20 }: { members: Member[]; max?: number; size?: number }): JSX.Element {
  const shown = members.slice(0, max)
  const rest = members.length - shown.length
  return (
    <div className="flex items-center">
      {shown.map((m, i) => (
        <div key={m.id} className={clsx(i > 0 && '-ml-1.5')} style={{ zIndex: 10 - i }}>
          <Avatar name={m.name} color={m.avatarColor} size={size} className="ring-2 ring-[var(--my-bg-layer-2)]" />
        </div>
      ))}
      {rest > 0 && (
        <div
          className="-ml-1.5 flex items-center justify-center rounded-full bg-[var(--my-bg-layer-3)] text-my-2xs font-medium text-[var(--my-txt-secondary)] ring-2 ring-[var(--my-bg-layer-2)]"
          style={{ width: size, height: size }}
        >
          +{rest}
        </div>
      )}
    </div>
  )
}

/* ---------------- Button ---------------- */

export type ButtonVariant = 'primary' | 'soft' | 'surface' | 'neutral' | 'ghost' | 'outline' | 'danger'

export function Button({
  children,
  variant = 'neutral',
  size = 'md',
  className,
  onClick,
  disabled,
  title,
  autoFocus,
  type = 'button',
  ...buttonProps
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  children: ReactNode
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  className?: string
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick']
  disabled?: boolean
  title?: string
  autoFocus?: boolean
}): JSX.Element {
  const variants: Record<ButtonVariant, string> = {
    primary: 'my-button-primary',
    soft: 'my-button-soft',
    surface: 'my-button-surface',
    neutral: 'my-button-neutral',
    ghost: 'my-button-ghost',
    outline: 'my-button-outline',
    danger: 'my-button-danger'
  }
  return (
    <button
      {...buttonProps}
      type={type}
      title={title}
      disabled={disabled}
      autoFocus={autoFocus}
      onClick={onClick}
      className={clsx(
        'my-control',
        size === 'sm' && 'my-control-sm',
        size === 'lg' && 'my-control-lg',
        variants[variant],
        disabled && 'pointer-events-none opacity-50',
        className
      )}
    >
      {children}
    </button>
  )
}

/* ---------------- Dropdown（点击外部关闭、固定定位小菜单） ---------------- */

// React ancestry survives portals; DOM ancestry does not. Share ownership so a
// child popup remains inside its parent dropdown/modal for pointer and focus.
const OverlayScope = createContext<{ ids: string[]; modal?: RefObject<HTMLDivElement> }>({ ids: [] })
const CONTROL_SELECTOR = 'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]'
const OPTION_SELECTOR = '.my-menu-item, [role="option"]'

function controlsIn(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter((el) =>
    el.tabIndex >= 0 && !el.matches(':disabled, [aria-disabled="true"]') &&
    !el.closest('[hidden], [inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  )
}

function ownsOverlay(root: HTMLElement | null, target: EventTarget | null, id: string): boolean {
  return target instanceof Node && (Boolean(root?.contains(target)) ||
    (target instanceof Element && Boolean(target.closest<HTMLElement>('[data-my-layer]')?.dataset.myLayer?.split(' ').includes(id))))
}

function guardComposingEscape(event: ReactKeyboardEvent): void {
  if (event.key === 'Escape' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.stopPropagation()
}

function anchorIsVisible(anchor: HTMLElement, rect: DOMRect): boolean {
  if (!anchor.getClientRects().length || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return false
  let current: HTMLElement | null = anchor
  while (current) {
    // A fixed-position overlay escapes ancestor overflow clipping; stop checking above it.
    if (getComputedStyle(current).position === 'fixed') break
    const parent: HTMLElement | null = current.parentElement
    if (!parent) break
    const style = getComputedStyle(parent)
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      const clip = parent.getBoundingClientRect()
      if (style.overflowX !== 'visible' && (rect.right <= clip.left || rect.left >= clip.right)) return false
      if (style.overflowY !== 'visible' && (rect.bottom <= clip.top || rect.top >= clip.bottom)) return false
    }
    current = parent
  }
  return true
}

type DropdownPlacement = 'auto' | 'top' | 'bottom' | 'left' | 'right'
type DropdownSide = 'top' | 'bottom' | 'left' | 'right'

export function Dropdown({
  trigger,
  children,
  align = 'left',
  width,
  layoutKey,
  positionAnchorRef,
  placement = 'auto',
  gap = 4,
  disabled = false,
  onOpenChange,
  className
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  width?: number
  layoutKey?: string | number
  positionAnchorRef?: RefObject<HTMLElement | null>
  placement?: DropdownPlacement
  gap?: number
  disabled?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const parentScope = useContext(OverlayScope)
  const interactive = useInteractionActive() && !disabled
  const canInteract = useInteractionGuard()
  const activeOpen = open && interactive
  const presence = usePresence(activeOpen, MOTION_POP_EXIT_MS)
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number; minWidth: number; side: DropdownSide } | null>(null)
  const lastPosRef = useRef<{ top: number; left: number; maxHeight: number; minWidth: number; side: DropdownSide } | null>(null)
  const lastRootRef = useRef<HTMLElement | null>(null)
  const lockedSideRef = useRef<DropdownSide | null>(null)
  if (pos) lastPosRef.current = pos
  if (portalRoot) lastRootRef.current = portalRoot
  const renderedPos = activeOpen ? pos : lastPosRef.current
  const renderedRoot = activeOpen ? portalRoot : lastRootRef.current
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const escId = useId()
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const entryRef = useRef<'last' | 'selected' | null>('selected')
  const lastMenuFocusRef = useRef<HTMLElement | null>(null)
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const prevActiveOpenRef = useRef(activeOpen)
  const interactionSignal = useInteractionSignal()
  const focusGeneration = useRef(0)
  const focusFrame = useRef<number | null>(null)
  const cancelFocusReturn = useCallback((): void => {
    focusGeneration.current++
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = null
  }, [])
  useLayoutEffect(() => cancelFocusReturn, [interactive, interactionSignal, cancelFocusReturn])
  useEffect(() => {
    if (prevActiveOpenRef.current !== activeOpen) {
      prevActiveOpenRef.current = activeOpen
      onOpenChangeRef.current?.(activeOpen)
    }
  }, [activeOpen])
  useEffect(() => () => {
    if (prevActiveOpenRef.current) onOpenChangeRef.current?.(false)
  }, [])

  const close = (restore = true): void => {
    cancelFocusReturn()
    setOpen(false)
    const anchor = anchorRef.current
    const menu = menuRef.current
    const target = returnFocusRef.current
    if (!restore || !canInteract() || !anchor || !menu || !target) return
    const ticket = focusGeneration.current
    // Let removal and any new modal autofocus commit before reclaiming abandoned focus.
    queueMicrotask(() => {
      if (ticket !== focusGeneration.current || interactionSignal?.aborted || !canInteract()) return
      focusFrame.current = requestAnimationFrame(() => {
        focusFrame.current = null
        if (ticket !== focusGeneration.current || interactionSignal?.aborted || !canInteract() ||
          anchorRef.current !== anchor || !anchor.isConnected || !target.isConnected || !anchor.contains(target) ||
          target.matches(':disabled') || target.closest('[hidden], [inert], [aria-hidden="true"]') ||
          !target.getClientRects().length || getComputedStyle(target).visibility !== 'visible') return
        const active = document.activeElement
        if (active && active !== document.body && active !== document.documentElement && !ownsOverlay(menu, active, escId)) return
        const root = anchor.closest<HTMLElement>('.my-root')
        const dialog = root ? topModal(root) : undefined
        if (dialog && !ownsOverlay(dialog.panel, target, dialog.id)) return
        target.focus({ preventScroll: true })
      })
    })
  }
  useEscLayer(open && interactive, {
    kind: 'modal',
    id: `dropdown-${escId}`,
    onClose: () => close()
  })

  useLayoutEffect(() => {
    if (!open || !interactive) {
      lockedSideRef.current = null
      setPos(null)
      setPortalRoot(null)
      return
    }
    const anchor = anchorRef.current
    returnFocusRef.current = anchor?.querySelector<HTMLElement>('button, [tabindex]') ?? null
    setPortalRoot(anchor?.closest<HTMLElement>('.my-root') ?? null)
  }, [open, interactive])

  // Re-measure actual content, fonts and anchors, including custom model views.
  useLayoutEffect(() => {
    if (!open || !interactive || !portalRoot) return
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return
    const update = (allowReFlip: boolean): void => {
      const trigger = returnFocusRef.current ?? anchor
      const r = trigger.getBoundingClientRect()
      if (!anchorIsVisible(trigger, r)) {
        close(false)
        return
      }
      const alignment = positionAnchorRef?.current?.getBoundingClientRect() ?? r
      const inHeader = Boolean(anchor.closest('.my-window-header'))
      const headerEl = inHeader ? null : portalRoot.querySelector<HTMLElement>('.my-window-header')
      const headerBottom = headerEl ? Math.ceil(headerEl.getBoundingClientRect().bottom) : 0
      const safeTop = headerBottom > 0 ? Math.max(8, headerBottom + 8) : 8

      const isSidePreference = placement === 'left' || placement === 'right'
      const topEdge = isSidePreference ? r.top : Math.min(alignment.top, r.top)
      const bottomEdge = isSidePreference ? r.bottom : Math.max(alignment.bottom, r.bottom)
      const roomAbove = Math.max(0, topEdge - gap - safeTop)
      const roomBelow = Math.max(0, innerHeight - bottomEdge - gap - 8)
      const naturalHeight = menu.scrollHeight + menu.offsetHeight - menu.clientHeight
      const w = menu.offsetWidth
      const menuW = Math.min(w || (width ?? 0), Math.max(0, innerWidth - 16))

      const chooseVertical = (): 'top' | 'bottom' => {
        if (placement === 'top') {
          return naturalHeight <= roomAbove || roomAbove >= roomBelow ? 'top' : 'bottom'
        }
        if (placement === 'bottom') {
          const comfortableBelow = roomBelow >= Math.min(naturalHeight, 260)
          return !comfortableBelow && roomAbove > roomBelow ? 'top' : 'bottom'
        }
        return naturalHeight > roomBelow && (naturalHeight <= roomAbove || roomAbove > roomBelow) ? 'top' : 'bottom'
      }

      const chooseSide = (): DropdownSide => {
        if (placement === 'left' || placement === 'right') {
          const roomLeft = Math.max(0, alignment.left - gap - 8)
          const roomRight = Math.max(0, innerWidth - alignment.right - gap - 8)
          if (placement === 'left') {
            if (roomLeft >= menuW) return 'left'
            if (roomRight >= menuW) return 'right'
          } else {
            if (roomRight >= menuW) return 'right'
            if (roomLeft >= menuW) return 'left'
          }
          return roomAbove >= roomBelow ? 'top' : 'bottom'
        }
        return chooseVertical()
      }

      let side = lockedSideRef.current
      if (!side) {
        side = chooseSide()
        lockedSideRef.current = side
      } else if (allowReFlip) {
        if (side === 'left' || side === 'right') {
          const roomLeft = Math.max(0, alignment.left - gap - 8)
          const roomRight = Math.max(0, innerWidth - alignment.right - gap - 8)
          if ((side === 'left' && roomLeft < menuW) || (side === 'right' && roomRight < menuW)) {
            side = chooseSide()
            lockedSideRef.current = side
          }
        } else {
          const lockedRoom = side === 'top' ? roomAbove : roomBelow
          const otherRoom = side === 'top' ? roomBelow : roomAbove
          if (lockedRoom < Math.min(naturalHeight, 220) && otherRoom > lockedRoom + 40) {
            side = chooseVertical()
            lockedSideRef.current = side
          }
        }
      }

      let maxHeight: number
      let h: number
      let top: number
      let left: number
      if (side === 'left' || side === 'right') {
        maxHeight = Math.max(0, innerHeight - safeTop - 8)
        h = Math.min(menu.offsetHeight, maxHeight)
        const preferredTop = align === 'right' ? alignment.bottom - h : alignment.top
        top = Math.max(safeTop, Math.min(preferredTop, innerHeight - h - 8))
        const preferredLeft = side === 'left' ? alignment.left - w - gap : alignment.right + gap
        left = Math.max(8, Math.min(preferredLeft, innerWidth - w - 8))
      } else {
        const above = side === 'top'
        maxHeight = Math.max(0, Math.min(innerHeight - safeTop - 8, above ? roomAbove : roomBelow))
        h = Math.min(menu.offsetHeight, maxHeight)
        top = Math.max(safeTop, Math.min(above ? topEdge - h - gap : bottomEdge + gap, innerHeight - h - 8))
        left = Math.max(8, Math.min(align === 'right' ? alignment.right - w : alignment.left, innerWidth - w - 8))
      }

      const next = {
        top,
        left,
        maxHeight,
        minWidth: width === undefined ? Math.min(r.width, innerWidth - 16) : 0,
        side
      }
      setPos((old) => old && Object.keys(next).every((key) => old[key as keyof typeof next] === next[key as keyof typeof next]) ? old : next)
    }
    update(false)
    const onResizeContent = (): void => update(false)
    const onViewportChange = (): void => update(true)
    const observer = new ResizeObserver(onResizeContent)
    observer.observe(menu)
    observer.observe(anchor)
    if (returnFocusRef.current) observer.observe(returnFocusRef.current)
    if (positionAnchorRef?.current) observer.observe(positionAnchorRef.current)
    const onScroll = (event: Event): void => {
      if (!ownsOverlay(menu, event.target, escId)) update(true)
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onViewportChange)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [open, portalRoot, align, interactive, width, layoutKey, positionAnchorRef, placement, gap])

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!open || !interactive || !menu || !pos) return
    const lostSubviewFocus = lastMenuFocusRef.current && !lastMenuFocusRef.current.isConnected && document.activeElement === document.body
    if (!entryRef.current && !lostSubviewFocus) return
    const controls = controlsIn(menu)
    const target = entryRef.current === 'last' ? controls.at(-1)
      : entryRef.current === 'selected' ? controls.find((el) => el.matches('[aria-selected="true"], [data-selected="true"]')) ?? controls[0]
        : controls[0]
    if (!target) return
    entryRef.current = null
    // Honor input autofocus supplied by an interactive custom view.
    if (!menu.contains(document.activeElement)) {
      target?.focus({ preventScroll: true })
      target?.scrollIntoView({ block: 'nearest' })
    }
  })

  const toggle = (): void => {
    if (!canInteract() || disabled) return
    if (open) close()
    else { cancelFocusReturn(); entryRef.current ??= 'selected'; lastMenuFocusRef.current = null; setOpen(true) }
  }
  useEffect(() => { if (!interactive) setOpen(false) }, [interactive])

  useEffect(() => {
    if (!open || !interactive) return
    const onDown = (e: PointerEvent): void => {
      if (ownsOverlay(anchorRef.current, e.target, escId) || ownsOverlay(menuRef.current, e.target, escId)) return
      cancelFocusReturn()
      setOpen(false)
    }
    const onFocus = (e: FocusEvent): void => {
      if (!ownsOverlay(anchorRef.current, e.target, escId) && !ownsOverlay(menuRef.current, e.target, escId)) {
        cancelFocusReturn()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('focusin', onFocus)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('focusin', onFocus)
    }
  }, [open, interactive, cancelFocusReturn])

  return (
    <div ref={anchorRef} className={clsx('relative', className)} onKeyDown={(event) => {
      guardComposingEscape(event)
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || menuRef.current?.contains(event.target as Node)) return
      const trigger = anchorRef.current?.querySelector<HTMLElement>('button, [tabindex]')
      if (!trigger?.contains(event.target as Node) || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      entryRef.current = event.key === 'ArrowUp' ? 'last' : 'selected'
      if (!open) trigger.click()
      else {
        const controls = menuRef.current ? controlsIn(menuRef.current) : []
        ;(event.key === 'ArrowUp' ? controls.at(-1) : controls[0])?.focus()
      }
    }}>
      {trigger({ open: activeOpen, toggle })}
      {presence.mounted && renderedRoot && createPortal(
        <OverlayScope.Provider value={{ ...parentScope, ids: [...parentScope.ids, escId] }}>
        <div
          ref={menuRef}
          data-my-layer={[...parentScope.ids, escId].join(' ')}
          data-placement={renderedPos?.side}
          data-align={align}
          data-state={presence.state}
          aria-hidden={presence.state === 'closing' || undefined}
          style={{
            top: renderedPos?.top ?? -9999,
            left: renderedPos?.left ?? -9999,
            width: width ?? 'max-content',
            maxHeight: renderedPos?.maxHeight,
            minWidth: renderedPos?.minWidth,
            visibility: renderedPos ? 'visible' : 'hidden'
          }}
          className={clsx(renderedPos && 'my-pop', 'my-menu my-scrollbar no-drag fixed')}
          onFocusCapture={(event) => { if (event.target instanceof HTMLElement) lastMenuFocusRef.current = event.target }}
          onKeyDown={(event) => {
            guardComposingEscape(event)
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || !(event.target instanceof HTMLElement)) return
            if (event.target.closest('.my-menu') !== event.currentTarget) return
            if (event.key === 'Tab') {
              const menuControls = controlsIn(event.currentTarget)
              const indexInMenu = menuControls.indexOf(event.target)
              const choicesOnly = menuControls.every((el) => el.matches(OPTION_SELECTOR))
              // Interactive popovers keep ordinary Tab traversal through their
              // fields, back controls and subviews. Only leave at a boundary.
              if (!choicesOnly && (event.shiftKey ? indexInMenu > 0 : indexInMenu < menuControls.length - 1)) return
              const trigger = returnFocusRef.current
              const modal = parentScope.modal?.current
              const modalId = modal?.closest<HTMLElement>('[data-my-layer]')?.dataset.myLayer?.split(' ').at(-1)
              const controls = controlsIn(document).filter((el) => !ownsOverlay(menuRef.current, el, escId) &&
                (!modal || !modalId || ownsOverlay(modal, el, modalId)))
              const index = trigger ? controls.indexOf(trigger) : -1
              const target = event.shiftKey ? trigger : controls[index + 1] ?? (parentScope.modal ? controls[0] : null)
              if (target) { event.preventDefault(); event.stopPropagation(); close(false); target.focus({ preventScroll: true }) }
              else close(false)
              return
            }
            // Form fields, radiogroups and custom subviews retain their own keys.
            if (!event.target.matches(OPTION_SELECTOR) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            const group = event.target.closest('[role="listbox"]') ?? event.currentTarget
            const options = controlsIn(group).filter((el) => el.matches(OPTION_SELECTOR) && el.closest('.my-menu') === event.currentTarget)
            const index = options.indexOf(event.target)
            const next = event.key === 'Home' ? options[0] : event.key === 'End' ? options.at(-1)
              : options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]
            event.preventDefault()
            event.stopPropagation()
            next?.focus({ preventScroll: true })
            next?.scrollIntoView({ block: 'nearest' })
          }}
        >
          {children(() => close())}
        </div>
        </OverlayScope.Provider>, renderedRoot
      )}
    </div>
  )
}

export function DropdownItem({
  children,
  description,
  onClick,
  selected,
  danger,
  icon,
  disabled,
  shortcut,
  hasSubmenu,
  trailing,
  className,
  holdToConfirm = false,
  holdDurationMs = 420
}: {
  children: ReactNode
  description?: ReactNode
  onClick?: () => void
  selected?: boolean
  danger?: boolean
  icon?: ReactNode
  disabled?: boolean
  shortcut?: string
  hasSubmenu?: boolean
  trailing?: ReactNode
  className?: string
  holdToConfirm?: boolean
  holdDurationMs?: number
}): JSX.Element {
  const multiline = Boolean(description)
  const [pressing, setPressing] = useState(false)
  const timerRef = useRef<number | null>(null)
  const onClickRef = useRef(onClick)
  onClickRef.current = onClick

  const cancel = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setPressing(false)
  }, [])

  const start = useCallback((): void => {
    if (disabled || !onClickRef.current) return
    cancel()
    setPressing(true)
    timerRef.current = window.setTimeout(() => {
      setPressing(false)
      onClickRef.current?.()
    }, holdDurationMs)
  }, [disabled, holdDurationMs, cancel])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>): void => {
    if (disabled) return
    if (!holdToConfirm) {
      onClick?.()
    } else {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  return (
    <button
      type="button"
      disabled={disabled}
      data-selected={selected || undefined}
      aria-pressed={selected}
      data-danger={danger || undefined}
      onClick={handleClick}
      onPointerDown={holdToConfirm ? start : undefined}
      onPointerUp={holdToConfirm ? cancel : undefined}
      onPointerLeave={holdToConfirm ? cancel : undefined}
      onPointerCancel={holdToConfirm ? cancel : undefined}
      className={clsx(
        'my-menu-item',
        multiline && 'my-menu-item-multiline',
        disabled && 'cursor-default',
        holdToConfirm && 'my-menu-item-hold',
        pressing && 'is-pressing',
        className
      )}
    >
      {icon && <span className="my-menu-icon" aria-hidden="true">{icon}</span>}
      <span className={clsx('min-w-0 flex-1', !multiline && 'truncate')}>
        {multiline ? (
          <>
            <span className="my-item-title block truncate">{children}</span>
            <span className="my-item-description mt-0.5 block truncate">{description}</span>
          </>
        ) : children}
      </span>
      {holdToConfirm && <span className="my-menu-shortcut select-none text-my-tertiary">{pressing ? '蓄能中…' : '长按确认'}</span>}
      {!holdToConfirm && shortcut && <span className="my-menu-shortcut">{shortcut}</span>}
      {hasSubmenu && <ChevronRight size={13} className="my-menu-chevron shrink-0" aria-hidden="true" />}
      {trailing}
      {selected && <Check size={14} className="my-menu-check shrink-0 text-my-primary" aria-hidden="true" />}
    </button>
  )
}

export function DropdownDivider(): JSX.Element {
  return <div className="my-menu-divider" role="separator" />
}

export function DropdownHeader({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="my-menu-header">
      {children}
    </div>
  )
}

/* ---------------- Tooltip（portal 渲染 + 视口碰撞规避） ---------------- */

const TOOLTIP_GAP = 6
let lastTooltipClosedAt = 0

export function Tooltip({ label, children, side = 'top', align = 'center', wrap = false }: { label: string; children: ReactNode; side?: 'top' | 'bottom'; align?: 'center' | 'right'; wrap?: boolean }): JSX.Element {
  const id = useId()
  const parentScope = useContext(OverlayScope)
  const interactive = useInteractionActive()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const suppressRef = useRef(false)
  const delayTimerRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const activeOpen = open && interactive
  const presence = usePresence(activeOpen, MOTION_TOOLTIP_EXIT_MS)
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)
  const [place, setPlace] = useState<{ top: number; left: number; side: 'top' | 'bottom' } | null>(null)
  const lastPlaceRef = useRef<{ top: number; left: number; side: 'top' | 'bottom' } | null>(null)
  const lastRootRef = useRef<HTMLElement | null>(null)
  if (place) lastPlaceRef.current = place
  if (portalRoot) lastRootRef.current = portalRoot
  const renderedPlace = activeOpen ? place : lastPlaceRef.current
  const renderedRoot = activeOpen ? portalRoot : lastRootRef.current

  const clearDelay = useCallback((): void => {
    if (delayTimerRef.current !== null) {
      window.clearTimeout(delayTimerRef.current)
      delayTimerRef.current = null
    }
  }, [])

  const closeTip = useCallback((): void => {
    clearDelay()
    setOpen((prev) => {
      if (prev) lastTooltipClosedAt = Date.now()
      return false
    })
  }, [clearDelay])

  const hide = (): void => { suppressRef.current = true; closeTip() }
  useEscLayer(open, { kind: 'modal', id: `tooltip-${id}`, onClose: hide })

  useEffect(() => clearDelay, [clearDelay])
  useEffect(() => { if (!interactive) { clearDelay(); setOpen(false); suppressRef.current = false } }, [interactive, clearDelay])

  useLayoutEffect(() => {
    if (!open || !interactive) { setPortalRoot(null); setPlace(null); return }
    // 挂到 owning theme root：脱离页面 overflow 裁剪与标题栏等层叠上下文，悬浮层才不会被壳层遮挡。
    setPortalRoot(anchorRef.current?.closest<HTMLElement>('.my-root') ?? null)
  }, [open, interactive])

  useLayoutEffect(() => {
    if (!open || !interactive) return
    const anchor = anchorRef.current
    const target = anchor?.querySelector<HTMLElement>(CONTROL_SELECTOR)
    if (!target) return
    const previous = target.getAttribute('aria-describedby')
    target.setAttribute('aria-describedby', [previous, id].filter(Boolean).join(' '))
    return () => {
      const remaining = target.getAttribute('aria-describedby')?.split(' ').filter((value) => value !== id).join(' ')
      if (remaining) target.setAttribute('aria-describedby', remaining)
      else target.removeAttribute('aria-describedby')
    }
  }, [open, interactive, id])

  useLayoutEffect(() => {
    if (!open || !portalRoot) return
    const anchor = anchorRef.current
    const tip = tipRef.current
    if (!anchor || !tip) return
    const a = anchor.getBoundingClientRect()
    const t = tip.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth
    const spaceTop = a.top - TOOLTIP_GAP
    const spaceBottom = vh - a.bottom - TOOLTIP_GAP
    const fits = { top: spaceTop >= t.height, bottom: spaceBottom >= t.height }
    // 首选 side 放不下时翻转到另一侧；两侧都放不下则保持首选方向，最后统一夹取进视口。
    const useTop = side === 'top' ? fits.top || !fits.bottom : !fits.bottom && fits.top
    let top = useTop ? a.top - t.height - TOOLTIP_GAP : a.bottom + TOOLTIP_GAP
    top = Math.min(Math.max(top, 8), Math.max(8, vh - t.height - 8))
    let left = align === 'right' ? a.right - t.width : a.left + a.width / 2 - t.width / 2
    left = Math.min(Math.max(left, 8), Math.max(8, vw - t.width - 8))
    setPlace({ top: Math.round(top), left: Math.round(left), side: useTop ? 'top' : 'bottom' })
  }, [open, portalRoot, label, side, align, wrap])

  useEffect(() => {
    if (!open || !interactive) return
    const dismissOnMove = (): void => closeTip()
    window.addEventListener('scroll', dismissOnMove, true)
    window.addEventListener('resize', dismissOnMove)
    return () => {
      window.removeEventListener('scroll', dismissOnMove, true)
      window.removeEventListener('resize', dismissOnMove)
    }
  }, [open, interactive, closeTip])

  return (
    <span
      ref={anchorRef}
      className="my-tooltip-anchor relative inline-flex"
      onMouseEnter={() => {
        if (!interactive || suppressRef.current) return
        clearDelay()
        // 同组连续探索 450ms 内免等待直显，首个悬停轻延 160ms 防划过误闪
        if (Date.now() - lastTooltipClosedAt < 450) {
          setOpen(true)
          return
        }
        delayTimerRef.current = window.setTimeout(() => {
          delayTimerRef.current = null
          setOpen(true)
        }, 160)
      }}
      onMouseLeave={() => { suppressRef.current = false; closeTip() }}
      onPointerDown={() => { suppressRef.current = true; closeTip() }}
      onFocus={(e) => { if (interactive && !suppressRef.current && e.target instanceof HTMLElement && e.target.matches(':focus-visible')) { clearDelay(); setOpen(true) } }}
      onBlur={() => { suppressRef.current = false; closeTip() }}
      onKeyDown={guardComposingEscape}
      onClick={hide}
    >
      {children}
      {presence.mounted && renderedRoot && createPortal(
        <span
          ref={tipRef}
          role="tooltip"
          id={id}
          data-my-layer={parentScope.ids.join(' ')}
          data-side={renderedPlace?.side ?? side}
          data-state={renderedPlace ? presence.state : undefined}
          style={{
            ...(renderedPlace ? { top: renderedPlace.top, left: renderedPlace.left } : { visibility: 'hidden' as const }),
            ...(wrap ? { width: 'max-content', maxWidth: 'min(360px, calc(100vw - 24px))', whiteSpace: 'normal' as const } : {})
          }}
          className="my-tooltip no-drag pointer-events-none fixed left-0 top-0 whitespace-nowrap border border-my-line px-2 py-1 text-my-xs text-my-secondary"
        >
          {label}
        </span>,
        renderedRoot
      )}
    </span>
  )
}

/* ---------------- Modal ---------------- */

type ModalLayer = { panel: HTMLElement; id: string }
type ModalIsolation = { layers: ModalLayer[]; held: Map<HTMLElement, boolean>; observer: MutationObserver }
const modalRoots = new Map<HTMLElement, ModalIsolation>()

function topModal(root: HTMLElement): ModalLayer | undefined { return modalRoots.get(root)?.layers.at(-1) }

function syncModalIsolation(root: HTMLElement, state: ModalIsolation): void {
  const top = state.layers.at(-1)
  for (const [element, previous] of state.held) {
    if (!top || !element.isConnected || element.dataset.myLayer?.split(' ').includes(top.id)) {
      element.inert = previous
      state.held.delete(element)
    }
  }
  if (!top) return
  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLElement) || child.dataset.myLayer?.split(' ').includes(top.id) || state.held.has(child)) continue
    state.held.set(child, child.inert)
    child.inert = true
  }
}

function registerModal(root: HTMLElement, layer: ModalLayer): () => void {
  let state = modalRoots.get(root)
  if (!state) {
    state = { layers: [], held: new Map(), observer: new MutationObserver(() => {
      const current = modalRoots.get(root)
      if (current) syncModalIsolation(root, current)
    }) }
    modalRoots.set(root, state)
    state.observer.observe(root, { childList: true })
  }
  const current = state
  current.layers.push(layer)
  syncModalIsolation(root, current)
  return () => {
    current.layers = current.layers.filter((item) => item !== layer)
    syncModalIsolation(root, current)
    if (!current.layers.length) { current.observer.disconnect(); modalRoots.delete(root) }
  }
}

export function Modal({
  open,
  onClose,
  children,
  width,
  ariaLabel,
  placement = 'top',
  fullScreen = false,
  bare = false
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  width?: number | string
  ariaLabel?: string
  placement?: 'top' | 'center'
  fullScreen?: boolean
  /** 仅保留弹窗遮罩、进退场、焦点与 Esc 托管，移除默认外框底色，供分离式命令面板+悬浮预览卡组合布局使用。 */
  bare?: boolean
}): JSX.Element | null {
  const escId = useId()
  const parentScope = useContext(OverlayScope)
  const interactive = useInteractionActive()
  const activeOpen = open && interactive
  const presence = usePresence(activeOpen, MOTION_EXIT_MS)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const canInteract = useInteractionGuard()
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)
  const lastRootRef = useRef<HTMLElement | null>(null)
  if (portalRoot) lastRootRef.current = portalRoot
  const renderedRoot = activeOpen ? portalRoot : lastRootRef.current
  useEscLayer(open, { kind: 'modal', id: `modal-${escId}`, onClose, retainUntilInactive: true })

  useLayoutEffect(() => {
    // Stay inside the owning theme root, but outside page animations, clipping
    // and stacking contexts. React context (including InteractionScope) survives.
    if (open && interactive) returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPortalRoot(open && interactive ? anchorRef.current?.closest<HTMLElement>('.my-root') ?? null : null)
  }, [open, interactive])

  useLayoutEffect(() => {
    if (!open || !interactive || !portalRoot) return
    const panel = panelRef.current
    if (!panel) return
    const unregister = registerModal(portalRoot, { panel, id: escId })
    const containFocus = (event: FocusEvent): void => {
      // A newly mounted sibling DialogHost may autofocus before its layout
      // effect registers it. Let that focus enter the emerging top dialog.
      const candidate = event.target instanceof Element ? event.target.closest<HTMLElement>('.my-modal-panel') : null
      if (candidate && !modalRoots.get(portalRoot)?.layers.some((layer) => layer.panel === candidate)) return
      if (topModal(portalRoot)?.panel === panel && canInteract() && !ownsOverlay(panel, event.target, escId)) panel.focus({ preventScroll: true })
    }
    document.addEventListener('focusin', containFocus)
    if (!ownsOverlay(panel, document.activeElement, escId)) panel.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('focusin', containFocus)
      unregister()
      const previousFocus = returnFocusRef.current
      const remaining = topModal(portalRoot)
      if (canInteract() && previousFocus?.isConnected && !previousFocus.closest('[inert]') &&
        (!remaining || ownsOverlay(remaining.panel, previousFocus, remaining.id)) &&
        (ownsOverlay(panel, document.activeElement, escId) || document.activeElement === document.body)) previousFocus.focus({ preventScroll: true })
    }
  }, [open, interactive, portalRoot, canInteract])

  return (
    <>
      <span ref={anchorRef} hidden />
      {presence.mounted && renderedRoot && createPortal(
        <OverlayScope.Provider value={{ ids: [...parentScope.ids, escId], modal: panelRef }}>
        <div
          data-my-layer={[...parentScope.ids, escId].join(' ')}
          data-state={presence.state}
          aria-hidden={presence.state === 'closing' || undefined}
          className={clsx('my-modal-backdrop no-drag fixed inset-0 flex justify-center', fullScreen ? 'my-modal-fullscreen-backdrop items-stretch' : clsx('px-[var(--my-page-inset)]', placement === 'center' ? 'items-center' : 'items-start pt-[var(--my-modal-top-inset)]'))}
          onKeyDown={guardComposingEscape}
          onMouseDown={(e) => { e.stopPropagation(); if (presence.state === 'open' && e.button === 0 && e.target === e.currentTarget) onClose() }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            tabIndex={-1}
            data-placement={placement}
            data-state={presence.state}
            style={{ width: fullScreen ? '100%' : bare ? width : width ?? 'var(--my-modal-width)' }}
            className={clsx(
              'my-modal-panel',
              bare ? 'my-modal-panel-bare overflow-visible' : 'overflow-hidden',
              fullScreen ? 'my-modal-fullscreen-panel h-full max-h-none' : 'max-h-[var(--my-modal-max-height)]'
            )}
            onKeyDown={(e) => {
              if (e.key !== 'Tab' || e.defaultPrevented) return
              if (topModal(renderedRoot)?.panel !== panelRef.current) return
              const controls = controlsIn(renderedRoot).filter((el) => ownsOverlay(panelRef.current, el, escId))
              const first = controls[0]
              const last = controls[controls.length - 1]
              if (!first) { e.preventDefault(); e.currentTarget.focus(); return }
              if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) {
                e.preventDefault(); last.focus()
              } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === e.currentTarget)) {
                e.preventDefault(); first.focus()
              }
            }}
          >
            {children}
          </div>
        </div>
        </OverlayScope.Provider>,
        renderedRoot
      )}
    </>
  )
}

/* ---------------- Switch / Checkbox ---------------- */

export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }): JSX.Element {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!checked)} className="my-switch"><span /></button>
}

export function Checkbox({
  checked,
  onChange,
  ariaLabel,
  disabled = false
}: {
  checked: boolean
  onChange: (v: boolean) => void
  ariaLabel?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'my-checkbox flex shrink-0 items-center justify-center border transition-colors',
        disabled && 'opacity-50',
        checked
          ? 'border-my-line-accent bg-my-accent text-my-on-accent'
          : 'border-[var(--my-border-strong)] hover:border-[var(--my-border-accent-strong)]'
      )}
    >
      {checked && (
        <svg className="my-checkbox-mark" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 5.2 4.1 7.3 8 3.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  )
}

/* ---------------- 进度条（三段：completed/started/backlog） ---------------- */

export function TriProgressBar({ done, started, total }: { done: number; started: number; total: number }): JSX.Element {
  const safeTotal = Math.max(total, 1)
  const wDone = (done / safeTotal) * 100
  const wStarted = (started / safeTotal) * 100
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--my-bg-layer-3)]">
      <div style={{ width: `${wDone}%` }} className="bg-[var(--my-txt-icon-states-completed)]" />
      <div style={{ width: `${wStarted}%` }} className="bg-[var(--my-txt-icon-states-started)]" />
    </div>
  )
}

/* ---------------- 标签 Pill（label 色系） ---------------- */

export function LabelPill({ label, onClick }: { label: Label; onClick?: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex h-[22px] max-w-[140px] items-center gap-1 rounded-my-sm border border-[var(--my-label-border,var(--my-border-subtle))] px-1.5 text-my-xs font-medium',
        onClick && 'hover:brightness-110'
      )}
      style={{
        background: `var(--my-label-${label.color}-bg)`,
        color: `var(--my-label-${label.color}-text)`,
        borderColor: `var(--my-label-${label.color}-border)`
      }}
    >
      <span className="truncate">{label.name}</span>
    </button>
  )
}

/* ---------------- 搜索输入 ---------------- */

export function SearchInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  ariaLabel,
  className,
  size = 'md'
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  ariaLabel?: string
  className?: string
  size?: 'sm' | 'md'
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  return (
    <div className={clsx('relative', className)}>
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--my-txt-tertiary)]" />
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder ?? '搜索'}
        className={clsx('my-input my-search-input', size === 'sm' && 'my-search-input-sm', value && 'pr-7')}
      />
      {value && (
        <button
          type="button"
          aria-label="清除搜索"
          onClick={() => {
            onChange('')
            inputRef.current?.focus({ preventScroll: true })
          }}
          className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-my-md text-[var(--my-txt-tertiary)] transition-colors hover:bg-[var(--my-bg-layer-transparent-hover)] hover:text-[var(--my-txt-primary)]"
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

/* ---------------- 页签（顶栏 tabs，带平滑滑动选中底托） ---------------- */

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  className,
  ariaLabel
}: {
  tabs: Array<{ id: T; label: string; count?: number }>
  active: T
  onChange: (id: T) => void
  className?: string
  ariaLabel?: string
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const measuredOnce = useRef(false)
  const [pill, setPill] = useState<{ x: number; w: number; ready: boolean; instant: boolean }>({ x: 0, w: 0, ready: false, instant: true })

  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const sync = (instantOverride?: boolean): void => {
      const selected = track.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      if (!selected) {
        setPill((prev) => prev.ready ? { ...prev, ready: false } : prev)
        return
      }
      const x = selected.offsetLeft
      const w = selected.offsetWidth
      const instant = instantOverride ?? !measuredOnce.current
      measuredOnce.current = true
      setPill((prev) => (prev.x === x && prev.w === w && prev.ready && prev.instant === instant ? prev : { x, w, ready: true, instant }))
    }
    sync()
    const observer = new ResizeObserver(() => sync(true))
    observer.observe(track)
    return () => observer.disconnect()
  }, [active, tabs])

  return (
    <div ref={trackRef} className={clsx('my-tabs-track', className)} role="tablist" aria-label={ariaLabel}>
      <span
        className="my-tabs-indicator"
        data-ready={pill.ready || undefined}
        data-instant={pill.instant || undefined}
        style={{ '--my-tab-x': `${pill.x}px`, '--my-tab-w': `${pill.w}px` } as CSSProperties}
        aria-hidden="true"
      />
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={clsx(
            'my-control my-control-sm rounded-my-md transition-colors select-none',
            active === t.id
              ? 'font-medium text-[var(--my-txt-primary)]'
              : 'font-normal text-[var(--my-txt-tertiary)] hover:bg-[var(--my-bg-layer-transparent-hover)] hover:text-[var(--my-txt-primary)]'
          )}
        >
          <span>{t.label}</span>
          {t.count !== undefined && <span className={clsx('ml-1 text-my-xs tabular-nums', active === t.id ? 'text-[var(--my-txt-secondary)]' : 'text-[var(--my-txt-tertiary)]')}>{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

/* ---------------- 空状态 ---------------- */

export function EmptyState({
  title,
  description,
  icon,
  action,
  size = 'page',
  className
}: {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
  size?: 'page' | 'compact'
  className?: string
}): JSX.Element {
  return (
    <div className={clsx('my-empty-state', size === 'compact' && 'my-empty-state--compact', className)}>
      <div className="my-empty-state-icon">
        {icon ?? (
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
            <path d="M2.5 6h11M6 6v7.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </div>
      <div className="my-item-title">{title}</div>
      {description && <div className="my-item-description my-empty-state-description">{description}</div>}
      {action && <div className="my-empty-state-actions">{action}</div>}
    </div>
  )
}

/* ---------------- 日期格式化 ---------------- */

export function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(`${iso}T12:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useLayoutEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  return now
}


/* ---------------- Card 06: 长按蓄能确认按钮 (Hold to Confirm) ---------------- */

export function HoldToConfirmButton({
  children,
  onConfirm,
  holdDurationMs = 420,
  variant = 'danger',
  size = 'md',
  className,
  disabled,
  title,
  confirmHint = '按住 0.4s 确认'
}: {
  children: ReactNode
  onConfirm: () => void
  holdDurationMs?: number
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  className?: string
  disabled?: boolean
  title?: string
  confirmHint?: string
}): JSX.Element {
  const [pressing, setPressing] = useState(false)
  const [committed, setCommitted] = useState(false)
  const timerRef = useRef<number | null>(null)
  const commitTimerRef = useRef<number | null>(null)
  const onConfirmRef = useRef(onConfirm)
  onConfirmRef.current = onConfirm

  const cancel = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setPressing(false)
  }, [])

  const start = useCallback((): void => {
    if (disabled || committed) return
    cancel()
    setPressing(true)
    timerRef.current = window.setTimeout(() => {
      setPressing(false)
      setCommitted(true)
      onConfirmRef.current()
      commitTimerRef.current = window.setTimeout(() => {
        setCommitted(false)
      }, 300)
    }, holdDurationMs)
  }, [disabled, committed, holdDurationMs, cancel])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current)
    }
  }, [])

  const strokeDashoffset = committed ? 0 : pressing ? 0 : 260

  return (
    <Button
      variant={variant}
      size={size}
      disabled={disabled}
      title={title ?? confirmHint}
      className={clsx(
        'my-hold-confirm-btn',
        pressing && 'is-pressing',
        committed && 'is-committed',
        className
      )}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(event) => {
        if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
          start()
        }
      }}
      onKeyUp={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          cancel()
        }
      }}
    >
      <svg className="my-hold-confirm-ring" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <rect
          x="2"
          y="2"
          width="96"
          height="96"
          rx="10"
          pathLength="260"
          strokeDasharray="260"
          style={{
            strokeDashoffset,
            transition: pressing ? `stroke-dashoffset ${holdDurationMs}ms linear` : 'stroke-dashoffset 150ms ease-out'
          }}
        />
      </svg>
      {children}
    </Button>
  )
}

/* ---------------- Card 23: 敏感信息窥视 (Secret Peek) ---------------- */

export function SecretPeek({
  value,
  label,
  className,
  revealOnAlt = true
}: {
  value: string
  label?: string
  className?: string
  revealOnAlt?: boolean
}): JSX.Element {
  const [revealed, setRevealed] = useState(false)
  const [altHeld, setAltHeld] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!revealOnAlt) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Alt') setAltHeld(true)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Alt') setAltHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', () => setAltHeld(false))
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [revealOnAlt])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // ignore
    }
  }

  const isPeeking = revealed || altHeld

  return (
    <div
      className={clsx('my-secret-row', isPeeking && 'is-peeking', className)}
      title="悬停、点击右侧眼睛或按住 Alt 查看明文"
    >
      {label && <span className="text-my-tertiary select-none">{label}</span>}
      <span className="my-secret-val select-all">{value}</span>
      <button
        type="button"
        className="my-icon-control my-secret-action text-my-tertiary hover:text-my-primary"
        aria-label={isPeeking ? '隐藏明文' : '显示明文 (支持 Alt 键)'}
        onClick={() => setRevealed((prev) => !prev)}
      >
        {isPeeking ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
      <button
        type="button"
        className="my-icon-control my-secret-action text-my-tertiary hover:text-my-primary"
        aria-label="复制到剪贴板"
        onClick={() => void copy()}
      >
        {copied ? <Check size={13} className="text-my-success-text" /> : <Copy size={13} />}
      </button>
    </div>
  )
}

/* ---------------- Card 12: 同心波轻叩指示器 (Knock Indicator) ---------------- */

export function KnockIndicator({
  children,
  active = true,
  className
}: {
  children?: ReactNode
  active?: boolean
  className?: string
}): JSX.Element {
  return (
    <span className={clsx('my-knock-wrap', className)}>
      {active && <span className="my-knock-wave" aria-hidden="true" />}
      {children ?? <span className="my-knock-dot" aria-hidden="true" />}
    </span>
  )
}

/* ---------------- 三段信号 / 质量指示微条 (Signal Meter) ---------------- */

export function SignalMeter({
  level,
  tone = 'success',
  label,
  className
}: {
  level: 0 | 1 | 2 | 3
  tone?: 'success' | 'warning' | 'danger' | 'neutral'
  label?: string
  className?: string
}): JSX.Element {
  const activeColor =
    tone === 'success'
      ? 'bg-[var(--my-txt-success-primary)]'
      : tone === 'warning'
        ? 'bg-[var(--my-txt-warning-primary)]'
        : tone === 'danger'
          ? 'bg-[var(--my-txt-danger-primary)]'
          : 'bg-[var(--my-txt-secondary)]'
  return (
    <span
      className={clsx('inline-flex items-end gap-0.5', className)}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
    >
      {(['h-1.5', 'h-2', 'h-2.5'] as const).map((heightClass, index) => (
        <span
          key={index}
          className={clsx(
            'w-0.5 rounded-full transition-colors',
            heightClass,
            index < level ? activeColor : 'bg-[var(--my-border-strong)]'
          )}
        />
      ))}
    </span>
  )
}

/* ---------------- 纵向折叠展开（CSS Grid 0fr ↔ 1fr，支持中途打断与大列表直切降级） ---------------- */

const DISCLOSURE_EXIT_MS = 185

export function DisclosureGrid({
  open,
  animated = true,
  className,
  innerClassName,
  children
}: {
  open: boolean
  /** 列表分组超过 40 行时传 false，自动降级为无高度动画直切以保 60/120Hz 满帧。 */
  animated?: boolean
  className?: string
  innerClassName?: string
  children: ReactNode
}): JSX.Element | null {
  const shouldAnimate = animated && !prefersReducedMotion()
  const presence = usePresence(open, shouldAnimate ? DISCLOSURE_EXIT_MS : 0)
  const [expanded, setExpanded] = useState(open)
  const [settled, setSettled] = useState(open)
  const rootRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const wasMountedRef = useRef(open)

  useLayoutEffect(() => {
    innerRef.current?.toggleAttribute('inert', !open)
  }, [open, presence.mounted])

  useLayoutEffect(() => {
    if (!shouldAnimate) {
      setExpanded(open)
      setSettled(open)
      wasMountedRef.current = presence.mounted
      return
    }
    let raf: number | null = null
    let settleTimer: number | null = null
    if (open) {
      if (!wasMountedRef.current && presence.mounted) {
        setExpanded(false)
        setSettled(false)
        // Flush initial 0fr layout before flipping to 1fr on next frame so height transitions cleanly.
        void rootRef.current?.getBoundingClientRect()
        raf = requestAnimationFrame(() => {
          raf = null
          setExpanded(true)
        })
      } else {
        setExpanded(true)
      }
      settleTimer = window.setTimeout(() => {
        settleTimer = null
        setSettled(true)
      }, DISCLOSURE_EXIT_MS)
    } else {
      setSettled(false)
      setExpanded(false)
    }
    wasMountedRef.current = presence.mounted
    return () => {
      if (raf !== null) cancelAnimationFrame(raf)
      if (settleTimer !== null) window.clearTimeout(settleTimer)
    }
  }, [open, presence.mounted, shouldAnimate])

  if (!presence.mounted) return null
  if (!shouldAnimate) {
    return (
      <div className={className}>
        <div className={innerClassName}>{children}</div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={clsx('my-disclosure', className)}
      data-open={expanded ? 'true' : 'false'}
      data-animated="true"
      data-settled={settled ? 'true' : undefined}
    >
      <div ref={innerRef} className={clsx('my-disclosure-inner', innerClassName)} aria-hidden={!open || undefined}>
        {children}
      </div>
    </div>
  )
}

/* ---------------- 分段选择器（带测量式弹簧滑动底托） ---------------- */

export function Segmented({
  value,
  size = 'md',
  ariaLabel,
  className,
  children
}: {
  /** 当前选中标识，变化时平滑滑移选中底托。 */
  value: string
  size?: 'sm' | 'md'
  ariaLabel?: string
  className?: string
  children: ReactNode
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const measuredOnce = useRef(false)
  const [pill, setPill] = useState<{ x: number; y: number; w: number; h: number; ready: boolean; instant: boolean }>({
    x: 0,
    y: 2,
    w: 0,
    h: 0,
    ready: false,
    instant: true
  })

  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const sync = (instantOverride?: boolean): void => {
      const selected = track.querySelector<HTMLElement>('.my-segment[aria-pressed="true"], .my-segment[aria-selected="true"]')
      if (!selected) {
        setPill((prev) => (prev.ready ? { ...prev, ready: false } : prev))
        return
      }
      const trackRect = track.getBoundingClientRect()
      const selRect = selected.getBoundingClientRect()
      if (trackRect.width <= 0 || selRect.width <= 0) return
      // Divide out any ancestor transform scale (e.g. during modal enter animation) so local CSS coordinates stay exact.
      const scaleX = track.offsetWidth > 0 ? trackRect.width / track.offsetWidth : 1
      const scaleY = track.offsetHeight > 0 ? trackRect.height / track.offsetHeight : 1
      const x = Math.round(((selRect.left - trackRect.left) / scaleX) * 10) / 10
      const y = Math.round(((selRect.top - trackRect.top) / scaleY) * 10) / 10
      const w = Math.round((selRect.width / scaleX) * 10) / 10
      const h = Math.round((selRect.height / scaleY) * 10) / 10
      const instant = instantOverride ?? !measuredOnce.current
      measuredOnce.current = true
      setPill((prev) =>
        prev.x === x && prev.y === y && prev.w === w && prev.h === h && prev.ready && prev.instant === instant
          ? prev
          : { x, y, w, h, ready: true, instant }
      )
    }
    sync()
    const observer = new ResizeObserver(() => sync(true))
    observer.observe(track)
    const selected = track.querySelector<HTMLElement>('.my-segment[aria-pressed="true"], .my-segment[aria-selected="true"]')
    if (selected) observer.observe(selected)
    return () => observer.disconnect()
  }, [value, size])

  return (
    <div
      ref={trackRef}
      role="group"
      aria-label={ariaLabel}
      data-sliding="true"
      data-indicator-ready={pill.ready || undefined}
      className={clsx('my-segmented', size === 'sm' && 'my-segmented-sm', className)}
    >
      <span
        className="my-segmented-indicator"
        data-ready={pill.ready || undefined}
        data-instant={pill.instant || undefined}
        style={
          {
            '--my-seg-x': `${pill.x}px`,
            '--my-seg-y': `${pill.y}px`,
            '--my-seg-w': `${pill.w}px`,
            '--my-seg-h': `${pill.h}px`
          } as CSSProperties
        }
        aria-hidden="true"
      />
      {children}
    </div>
  )
}
