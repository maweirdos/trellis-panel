// 外壳共享基础件。所有页面从本文件取用，勿各自造轮子。
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type ReactNode, type RefObject, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'
import { Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Search, X } from 'lucide-react'
import type { Label, Member } from './types'
import { useEscLayer } from '../utils/use-esc-layer'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'

/* ---------------- Avatar ---------------- */

export function Avatar({
  name,
  color,
  tone = 'color',
  size = 20,
  className
}: {
  name: string
  color: string
  tone?: 'color' | 'accent'
  size?: number
  className?: string
}): JSX.Element {
  return (
    <div
      title={name}
      className={clsx('flex shrink-0 select-none items-center justify-center rounded-full font-medium', tone === 'accent' ? 'text-my-on-accent' : 'text-my-on-color', className)}
      style={{ width: size, height: size, background: color, fontSize: Math.max(9, size * 0.42) }}
    >
      {name.slice(0, 1)}
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

type ButtonVariant = 'primary' | 'neutral' | 'ghost' | 'outline' | 'danger'

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
  for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    const clip = parent.getBoundingClientRect()
    if (style.overflowX !== 'visible' && (rect.right <= clip.left || rect.left >= clip.right)) return false
    if (style.overflowY !== 'visible' && (rect.bottom <= clip.top || rect.top >= clip.bottom)) return false
  }
  return true
}

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
  className
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  width?: number
  layoutKey?: string | number
  positionAnchorRef?: RefObject<HTMLElement | null>
  placement?: 'auto' | 'top' | 'bottom'
  gap?: number
  disabled?: boolean
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const parentScope = useContext(OverlayScope)
  const interactive = useInteractionActive() && !disabled
  const canInteract = useInteractionGuard()
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number; minWidth: number; above: boolean } | null>(null)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const escId = useId()
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const entryRef = useRef<'last' | 'selected' | null>('selected')
  const lastMenuFocusRef = useRef<HTMLElement | null>(null)
  const interactionSignal = useInteractionSignal()
  const focusGeneration = useRef(0)
  const focusFrame = useRef<number | null>(null)
  const cancelFocusReturn = useCallback((): void => {
    focusGeneration.current++
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = null
  }, [])
  useLayoutEffect(() => cancelFocusReturn, [interactive, interactionSignal, cancelFocusReturn])

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
    const update = (): void => {
      const trigger = returnFocusRef.current ?? anchor
      const r = trigger.getBoundingClientRect()
      if (!anchorIsVisible(trigger, r)) {
        close(false)
        return
      }
      const alignment = positionAnchorRef?.current?.getBoundingClientRect() ?? r
      const topEdge = Math.min(alignment.top, r.top)
      const bottomEdge = Math.max(alignment.bottom, r.bottom)
      const roomAbove = Math.max(0, topEdge - gap - 8)
      const roomBelow = Math.max(0, innerHeight - bottomEdge - gap - 8)
      const naturalHeight = menu.scrollHeight + menu.offsetHeight - menu.clientHeight
      const above = placement === 'top'
        ? naturalHeight <= roomAbove || roomAbove >= roomBelow
        : naturalHeight > roomBelow && (naturalHeight <= roomAbove || roomAbove > roomBelow)
      const maxHeight = Math.max(0, Math.min(innerHeight - 16, above ? roomAbove : roomBelow))
      const h = Math.min(menu.offsetHeight, maxHeight)
      const w = menu.offsetWidth
      const next = {
        top: Math.max(8, Math.min(above ? topEdge - h - gap : bottomEdge + gap, innerHeight - h - 8)),
        left: Math.max(8, Math.min(align === 'right' ? alignment.right - w : alignment.left, innerWidth - w - 8)),
        maxHeight,
        minWidth: width === undefined ? Math.min(r.width, innerWidth - 16) : 0,
        above
      }
      setPos((old) => old && Object.keys(next).every((key) => old[key as keyof typeof next] === next[key as keyof typeof next]) ? old : next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(menu)
    observer.observe(anchor)
    if (returnFocusRef.current) observer.observe(returnFocusRef.current)
    if (positionAnchorRef?.current) observer.observe(positionAnchorRef.current)
    const onScroll = (event: Event): void => {
      if (!ownsOverlay(menu, event.target, escId)) update()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', update)
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
      {trigger({ open: open && interactive, toggle })}
      {open && interactive && portalRoot && createPortal(
        <OverlayScope.Provider value={{ ...parentScope, ids: [...parentScope.ids, escId] }}>
        <div
          ref={menuRef}
          data-my-layer={[...parentScope.ids, escId].join(' ')}
          data-placement={pos ? (pos.above ? 'top' : 'bottom') : undefined}
          data-align={align}
          style={{
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            width: width ?? 'max-content',
            maxHeight: pos?.maxHeight,
            minWidth: pos?.minWidth,
            visibility: pos ? 'visible' : 'hidden'
          }}
          className={clsx(pos && 'my-pop', 'my-menu my-scrollbar no-drag fixed')}
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
        </OverlayScope.Provider>, portalRoot
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

export function Tooltip({ label, children, side = 'top', align = 'center', wrap = false }: { label: string; children: ReactNode; side?: 'top' | 'bottom'; align?: 'center' | 'right'; wrap?: boolean }): JSX.Element {
  const id = useId()
  const parentScope = useContext(OverlayScope)
  const interactive = useInteractionActive()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const suppressRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null)
  const hide = (): void => { suppressRef.current = true; setOpen(false) }
  useEscLayer(open, { kind: 'modal', id: `tooltip-${id}`, onClose: hide })

  useEffect(() => { if (!interactive) { setOpen(false); suppressRef.current = false } }, [interactive])

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
    setPlace({ top: Math.round(top), left: Math.round(left) })
  }, [open, portalRoot, label, side, align, wrap])

  useEffect(() => {
    if (!open || !interactive) return
    const hide = () => setOpen(false)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [open, interactive])

  return (
    <span
      ref={anchorRef}
      className="my-tooltip-anchor relative inline-flex"
      onMouseEnter={() => { if (interactive && !suppressRef.current) setOpen(true) }}
      onMouseLeave={() => { suppressRef.current = false; setOpen(false) }}
      onPointerDown={() => { suppressRef.current = true; setOpen(false) }}
      onFocus={(e) => { if (interactive && !suppressRef.current && e.target instanceof HTMLElement && e.target.matches(':focus-visible')) setOpen(true) }}
      onBlur={() => { suppressRef.current = false; setOpen(false) }}
      onKeyDown={guardComposingEscape}
      onClick={hide}
    >
      {children}
      {open && interactive && portalRoot && createPortal(
        <span
          ref={tipRef}
          role="tooltip"
          id={id}
          data-my-layer={parentScope.ids.join(' ')}
          style={{
            ...(place ?? { visibility: 'hidden' as const }),
            ...(wrap ? { width: 'max-content', maxWidth: 'min(360px, calc(100vw - 24px))', whiteSpace: 'normal' as const } : {})
          }}
          className="my-tooltip my-fade no-drag pointer-events-none fixed left-0 top-0 whitespace-nowrap border border-my-line px-2 py-1 text-my-xs text-my-secondary"
        >
          {label}
        </span>,
        portalRoot
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
  fullScreen = false
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  width?: number | string
  ariaLabel?: string
  placement?: 'top' | 'center'
  fullScreen?: boolean
}): JSX.Element | null {
  const escId = useId()
  const parentScope = useContext(OverlayScope)
  const interactive = useInteractionActive()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const canInteract = useInteractionGuard()
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)
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
      {open && interactive && portalRoot && createPortal(
        <OverlayScope.Provider value={{ ids: [...parentScope.ids, escId], modal: panelRef }}>
        <div
          data-my-layer={[...parentScope.ids, escId].join(' ')}
          className={clsx('my-fade my-modal-backdrop no-drag fixed inset-0 flex justify-center', fullScreen ? 'my-modal-fullscreen-backdrop items-stretch' : clsx('px-[var(--my-page-inset)]', placement === 'center' ? 'items-center' : 'items-start pt-[var(--my-modal-top-inset)]'))}
          onKeyDown={guardComposingEscape}
          onMouseDown={(e) => { e.stopPropagation(); if (e.button === 0 && e.target === e.currentTarget) onClose() }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            tabIndex={-1}
            style={{ width: fullScreen ? '100%' : width ?? 'var(--my-modal-width)' }}
            className={clsx('my-modal-panel overflow-hidden', fullScreen ? 'my-modal-fullscreen-panel h-full max-h-none' : 'my-peek-in max-h-[var(--my-modal-max-height)]')}
            onKeyDown={(e) => {
              if (e.key !== 'Tab' || e.defaultPrevented) return
              if (topModal(portalRoot)?.panel !== panelRef.current) return
              const controls = controlsIn(portalRoot).filter((el) => ownsOverlay(panelRef.current, el, escId))
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
        portalRoot
      )}
    </>
  )
}

/* ---------------- Switch / Checkbox ---------------- */

export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }): JSX.Element {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!checked)} className="my-switch"><span /></button>
}

export function Checkbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={clsx(
        'my-checkbox flex shrink-0 items-center justify-center border transition-colors',
        checked
          ? 'border-my-line-accent bg-my-accent text-my-on-accent'
          : 'border-[var(--my-border-strong)] hover:border-[var(--my-border-accent-strong)]'
      )}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
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

/* ---------------- 页签（顶栏 tabs） ---------------- */

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
  return (
    <div className={clsx("flex items-center gap-1", className)} role="tablist" aria-label={ariaLabel}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={clsx(
            'my-control my-control-sm rounded-my-md font-medium transition-colors select-none',
            active === t.id
              ? 'bg-[var(--my-bg-layer-transparent-active)] text-[var(--my-txt-primary)]'
              : 'text-[var(--my-txt-tertiary)] hover:bg-[var(--my-bg-layer-transparent-hover)] hover:text-[var(--my-txt-primary)]'
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
  action
}: {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-14 text-center">
      <div
        className="mb-1 flex h-10 w-10 items-center justify-center rounded-my-lg border border-[var(--my-border-subtle)] bg-[var(--my-bg-layer-2)] text-[var(--my-txt-tertiary)]"
        style={{ boxShadow: 'var(--my-surface-rim), var(--my-shadow-raised-100)' }}
      >
        {icon ?? (
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
            <path d="M2.5 6h11M6 6v7.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </div>
      <div className="my-item-title">{title}</div>
      {description && <div className="my-item-description max-w-[320px]">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
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
