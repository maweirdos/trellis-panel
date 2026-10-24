// 外壳共享基础件。所有页面从本文件取用，勿各自造轮子。
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type ReactNode, type RefObject, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'
import { Check, ChevronDown, Search } from 'lucide-react'
import type { Label, Member } from './types'
import { useEscLayer } from '../utils/use-esc-layer'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'

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
  ...buttonProps
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'onClick'> & {
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
      type="button"
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
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number; minWidth: number } | null>(null)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const escId = useId()
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const entryRef = useRef<'last' | 'selected' | null>('selected')
  const lastMenuFocusRef = useRef<HTMLElement | null>(null)

  const close = (restore = true): void => {
    if (restore && canInteract() && ownsOverlay(menuRef.current, document.activeElement, escId)) {
      returnFocusRef.current?.focus({ preventScroll: true })
    }
    setOpen(false)
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
        minWidth: width === undefined ? Math.min(r.width, innerWidth - 16) : 0
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
    else { entryRef.current ??= 'selected'; lastMenuFocusRef.current = null; setOpen(true) }
  }
  useEffect(() => { if (!interactive) setOpen(false) }, [interactive])

  useEffect(() => {
    if (!open || !interactive) return
    const onDown = (e: PointerEvent): void => {
      if (ownsOverlay(anchorRef.current, e.target, escId) || ownsOverlay(menuRef.current, e.target, escId)) return
      setOpen(false)
    }
    const onFocus = (e: FocusEvent): void => {
      if (!ownsOverlay(anchorRef.current, e.target, escId) && !ownsOverlay(menuRef.current, e.target, escId)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('focusin', onFocus)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('focusin', onFocus)
    }
  }, [open, interactive])

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
          style={{
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            width: width ?? 'max-content',
            maxHeight: pos?.maxHeight,
            minWidth: pos?.minWidth,
            visibility: pos ? 'visible' : 'hidden'
          }}
          className="my-pop my-menu my-scrollbar no-drag fixed"
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
  onClick,
  selected,
  danger,
  icon,
  disabled
}: {
  children: ReactNode
  onClick?: () => void
  selected?: boolean
  danger?: boolean
  icon?: ReactNode
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      data-selected={selected || undefined}
      aria-pressed={selected}
      data-danger={danger || undefined}
      onClick={disabled ? undefined : onClick}
      className={clsx(
        'my-menu-item',
        disabled && 'cursor-default'
      )}
    >
      {icon && <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected && <Check size={13} className="shrink-0" aria-hidden="true" />}
    </button>
  )
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
  placement = 'top'
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  width?: number | string
  ariaLabel?: string
  placement?: 'top' | 'center'
}): JSX.Element | null {
  const escId = useId()
  const parentScope = useContext(OverlayScope)
  const interactive = useInteractionActive()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const canInteract = useInteractionGuard()
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)
  useEscLayer(open, { kind: 'modal', id: `modal-${escId}`, onClose })

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
          className={clsx('my-fade my-modal-backdrop no-drag fixed inset-0 flex justify-center px-[var(--my-page-inset)]', placement === 'center' ? 'items-center' : 'items-start pt-[var(--my-modal-top-inset)]')}
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
            style={{ width: width ?? 'var(--my-modal-width)' }}
            className="my-peek-in my-modal-panel max-h-[var(--my-modal-max-height)] overflow-hidden"
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
  return (
    <div className={clsx('relative', className)}>
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--my-txt-tertiary)]" />
      <input
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder ?? '搜索'}
        className={clsx('my-input my-search-input', size === 'sm' && 'my-search-input-sm')}
      />
    </div>
  )
}

/* ---------------- 页签（顶栏 tabs） ---------------- */

export function Tabs<T extends string>({
  tabs,
  active,
  onChange
}: {
  tabs: Array<{ id: T; label: string; count?: number }>
  active: T
  onChange: (id: T) => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={clsx(
            'my-control my-control-sm rounded-my-md',
            active === t.id
              ? 'bg-[var(--my-bg-layer-transparent-active)] text-[var(--my-txt-primary)]'
              : 'text-[var(--my-txt-tertiary)] hover:bg-[var(--my-bg-layer-transparent-hover)]'
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="text-my-xs opacity-70">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

/* ---------------- 空状态 ---------------- */

export function EmptyState({ title, description }: { title: string; description?: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-14 text-center">
      <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-my-lg bg-[var(--my-bg-layer-2)] text-[var(--my-txt-tertiary)]">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M2.5 6h11M6 6v7.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </div>
      <div className="text-my-md font-medium text-[var(--my-txt-primary)]">{title}</div>
      {description && <div className="max-w-[320px] text-my-sm text-[var(--my-txt-tertiary)]">{description}</div>}
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
