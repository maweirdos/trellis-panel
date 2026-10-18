// 外壳共享基础件。所有页面从本文件取用，勿各自造轮子。
import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { clsx } from 'clsx'
import { ChevronDown, Search } from 'lucide-react'
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

export function Dropdown({
  trigger,
  children,
  align = 'left',
  width,
  layoutKey,
  className
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  width?: number
  layoutKey?: string | number
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const escId = useId()
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEscLayer(open, {
    kind: 'modal',
    id: `dropdown-${escId}`,
    onClose: () => setOpen(false),
    returnFocusRef
  })

  // 渲染后按菜单实际尺寸定位：优先贴触发器下缘，空间不足则贴上缘，并收进视口
  useLayoutEffect(() => {
    if (!open || !interactive) {
      setPos(null)
      return
    }
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return
    returnFocusRef.current = anchor.querySelector<HTMLElement>('button, [tabindex]')
    const r = anchor.getBoundingClientRect()
    const h = menu.offsetHeight
    const w = menu.offsetWidth
    const spaceBelow = window.innerHeight - r.bottom
    const flip = h + 8 > spaceBelow && r.top - 8 > h
    const top = flip ? Math.max(8, r.top - h - 4) : Math.min(r.bottom + 4, window.innerHeight - h - 8)
    const left = align === 'right' ? r.right - w : r.left
    setPos({ top, left: Math.min(Math.max(8, left), window.innerWidth - w - 8) })
  }, [open, align, interactive, width, layoutKey])

  const toggle = (): void => { if (canInteract()) setOpen((v) => !v) }
  useEffect(() => { if (!interactive) setOpen(false) }, [interactive])

  useEffect(() => {
    if (!open || !interactive) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, interactive])

  return (
    <div ref={anchorRef} className={clsx('relative', className)}>
      {trigger({ open: open && interactive, toggle })}
      {open && interactive && (
        <div
          ref={menuRef}
          style={{
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            width,
            visibility: pos ? 'visible' : 'hidden'
          }}
          className="my-pop my-menu fixed"
        >
          {children(() => setOpen(false))}
        </div>
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
      data-danger={danger || undefined}
      onClick={disabled ? undefined : onClick}
      className={clsx(
        'my-menu-item',
        disabled && 'cursor-default'
      )}
    >
      {icon && <span className="flex h-4 w-4 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
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

/* ---------------- Tooltip（纯 CSS hover） ---------------- */

export function Tooltip({ label, children, side = 'top', align = 'center', wrap = false }: { label: string; children: ReactNode; side?: 'top' | 'bottom'; align?: 'center' | 'right'; wrap?: boolean }): JSX.Element {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        style={wrap ? { width: 'max-content', maxWidth: 'min(360px, calc(100vw - 24px))', whiteSpace: 'normal' } : undefined}
        className={clsx(
          'my-tooltip pointer-events-none absolute hidden whitespace-nowrap border border-my-line px-2 py-1 text-my-xs text-my-secondary group-hover/tt:block group-focus-within/tt:block',
          align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2',
          side === 'top' ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]'
        )}
      >
        {label}
      </span>
    </span>
  )
}

/* ---------------- Modal ---------------- */

export function Modal({
  open,
  onClose,
  children,
  width = 560
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  width?: number
}): JSX.Element | null {
  const escId = useId()
  const interactive = useInteractionActive()
  useEscLayer(open, { kind: 'modal', id: `modal-${escId}`, onClose })

  if (!open || !interactive) return null
  return (
    <div className="my-fade my-modal-backdrop fixed inset-0 flex items-start justify-center pt-[12vh]" onMouseDown={onClose}>
      <div
        style={{ width }}
        className="my-peek-in my-modal-panel max-h-[76vh] overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

/* ---------------- Checkbox ---------------- */

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
  autoFocus
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
}): JSX.Element {
  return (
    <div className="relative">
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--my-txt-tertiary)]" />
      <input
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="my-input my-search-input"
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
