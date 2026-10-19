import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react'
import { clsx } from 'clsx'

/** Shared chrome for transparent desktop utilities; only the header is draggable. */
export function FloatingFrame({ children, strip = false }: { children: ReactNode; strip?: boolean }): JSX.Element {
  return <div className="my-floating-window"><section className={clsx('my-floating-surface', strip && 'my-floating-surface--strip')}>{children}</section></div>
}

export function FloatingIconButton({ label, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }): JSX.Element {
  return <button {...props} type="button" title={label} aria-label={label} className={clsx('no-drag my-floating-icon', className)} />
}

export function readFloatingPreference(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

export function writeFloatingPreference(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* The utility remains usable without storage. */ }
}
