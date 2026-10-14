// 外壳共享基础件。所有页面从本文件取用，勿各自造轮子。
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { ChevronDown, Search } from 'lucide-react'
import type { Label, Member } from './types'

/* ---------------- Avatar ---------------- */

export function Avatar({
  name,
  color,
  size = 20,
  className
}: {
  name: string
  color: string
  size?: number
  className?: string
}): JSX.Element {
  return (
    <div
      title={name}
      className={clsx('flex shrink-0 select-none items-center justify-center rounded-full font-medium text-white', className)}
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
          className="-ml-1.5 flex items-center justify-center rounded-full bg-[var(--my-bg-layer-3)] text-[10px] font-medium text-[var(--my-txt-secondary)] ring-2 ring-[var(--my-bg-layer-2)]"
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
  title
}: {
  children: ReactNode
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  className?: string
  onClick?: () => void
  disabled?: boolean
  title?: string
}): JSX.Element {
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-[var(--my-bg-accent-primary)] text-[var(--my-txt-on-color)] hover:bg-[var(--my-bg-accent-primary-hover)]',
    neutral:
      'bg-[var(--my-bg-layer-1)] text-[var(--my-txt-secondary)] hover:bg-[var(--my-bg-layer-1-hover)] border border-[var(--my-border-subtle)]',
    ghost: 'text-[var(--my-txt-secondary)] hover:bg-[var(--my-bg-layer-transparent-hover)]',
    outline:
      'border border-[var(--my-border-subtle)] text-[var(--my-txt-secondary)] hover:bg-[var(--my-bg-layer-transparent-hover)]',
    danger: 'bg-[var(--my-bg-danger-primary)] text-white hover:bg-[var(--my-bg-danger-primary-hover)]'
  }
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
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
  className
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  width?: number
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const place = (): void => {
    const anchor = anchorRef.current
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const below = r.bottom + 4
    const top = below + 240 > window.innerHeight ? Math.max(8, r.top - 244) : below
    const left = align === 'right' ? r.right - (width ?? 200) - 4 : r.left
    setPos({ top, left: Math.max(8, left) })
  }

  const toggle = (): void => {
    if (!open) place()
    setOpen((v) => !v)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onScroll = (): void => setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  return (
    <div ref={anchorRef} className={clsx('relative', className)}>
      {trigger({ open, toggle })}
      {open && (
        <div
          ref={menuRef}
          style={{ top: pos.top, left: pos.left, width }}
          className="my-pop fixed z-[80] overflow-hidden rounded-lg border border-[var(--my-border-subtle)] bg-[var(--my-bg-layer-2)] py-1 shadow-[var(--my-shadow-overlay-200)]"
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
  icon
}: {
  children: ReactNode
  onClick?: () => void
  selected?: boolean
  danger?: boolean
  icon?: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-[var(--my-txt-secondary)] hover:bg-[var(--my-bg-layer-1-hover)]',
        selected && 'text-[var(--my-txt-accent-primary)]',
        danger && 'text-[var(--my-txt-danger-primary)]'
      )}
    >
      {icon && <span className="flex h-4 w-4 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}

export function DropdownHeader({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-[var(--my-txt-tertiary)]">
      {children}
    </div>
  )
}

/* ---------------- Tooltip（纯 CSS hover） ---------------- */

export function Tooltip({ label, children, side = 'top' }: { label: string; children: ReactNode; side?: 'top' | 'bottom' }): JSX.Element {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        className={clsx(
          'pointer-events-none absolute left-1/2 z-[90] hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--my-border-subtle)] bg-[var(--my-bg-layer-2)] px-2 py-1 text-[11px] text-[var(--my-txt-secondary)] shadow-[var(--my-shadow-raised-200)] group-hover/tt:block',
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
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="my-fade fixed inset-0 z-[70] flex items-start justify-center bg-[var(--my-bg-backdrop)] pt-[12vh]" onMouseDown={onClose}>
      <div
        style={{ width }}
        className="my-peek-in max-h-[76vh] overflow-hidden rounded-xl border border-[var(--my-border-subtle)] bg-[var(--my-bg-layer-2)] shadow-[var(--my-shadow-overlay-200)]"
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
        'flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[3px] border transition-colors',
        checked
          ? 'border-[var(--my-bg-accent-primary)] bg-[var(--my-bg-accent-primary)] text-white'
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

/* ---------------- 标签 Pill（上游令牌包 label 色系） ---------------- */

export function LabelPill({ label, onClick }: { label: Label; onClick?: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex h-[22px] max-w-[140px] items-center gap-1 rounded-[4px] border border-[var(--my-label-border,var(--my-border-subtle))] px-1.5 text-[11px] font-medium',
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
        className="h-8 w-full rounded-md border border-[var(--my-border-subtle)] bg-[var(--my-bg-surface-1)] pl-7 pr-2 text-[12.5px] text-[var(--my-txt-primary)] outline-none placeholder:text-[var(--my-txt-placeholder)] focus:border-[var(--my-border-accent-strong)]"
      />
    </div>
  )
}

/* ---------------- 页签（参考 顶栏 tabs） ---------------- */

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
            'my-control my-control-sm rounded-md',
            active === t.id
              ? 'bg-[var(--my-bg-layer-transparent-active)] text-[var(--my-txt-primary)]'
              : 'text-[var(--my-txt-tertiary)] hover:bg-[var(--my-bg-layer-transparent-hover)]'
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="text-[11px] opacity-70">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

/* ---------------- 空状态 ---------------- */

export function EmptyState({ title, description }: { title: string; description?: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-14 text-center">
      <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--my-bg-layer-2)] text-[var(--my-txt-tertiary)]">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M2.5 6h11M6 6v7.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </div>
      <div className="text-[13px] font-medium text-[var(--my-txt-primary)]">{title}</div>
      {description && <div className="max-w-[320px] text-[12px] text-[var(--my-txt-tertiary)]">{description}</div>}
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
