import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { clsx } from 'clsx'
import type { JSX, ReactNode } from 'react'

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  icon?: ReactNode
  dot?: string
}

export function Select<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = '请选择',
  className,
  size = 'md',
  disabled = false
}: {
  value: T
  onChange: (value: T) => void
  options: Array<SelectOption<T> | string>
  placeholder?: string
  className?: string
  size?: 'sm' | 'md'
  disabled?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const normalizedOptions: SelectOption<T>[] = options.map((opt) =>
    typeof opt === 'string' ? { value: opt as T, label: opt } : opt
  )

  const selectedOption = normalizedOptions.find((o) => o.value === value)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  return (
    <div className={clsx('relative inline-block text-left', className)} ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'flex w-full items-center justify-between gap-1.5 rounded-my-md border bg-my-surface-1 px-2.5 text-left text-my-sm transition-colors cursor-pointer select-none outline-none',
          size === 'sm' ? 'h-7 py-1' : 'h-8 py-1.5',
          open
            ? 'border-my-line-accent text-my-primary'
            : 'border-my-line text-my-primary hover:border-my-line-strong hover:bg-my-layer-1-hover',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {selectedOption?.dot && (
            <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', selectedOption.dot)} />
          )}
          {selectedOption?.icon && (
            <span className="shrink-0 text-my-icon-tertiary">{selectedOption.icon}</span>
          )}
          <span className="truncate">
            {selectedOption ? selectedOption.label : placeholder}
          </span>
        </span>
        <ChevronDown
          size={12}
          className={clsx(
            'shrink-0 text-my-icon-tertiary transition-transform duration-150',
            open && 'rotate-180 text-my-icon-accent'
          )}
        />
      </button>

      {open && (
        <div className="my-pop absolute left-0 top-full z-50 mt-1 max-h-60 min-w-full w-max overflow-y-auto rounded-my-lg border border-my-line bg-my-layer-2 p-1 shadow-[var(--my-shadow-overlay-200)]">
          {normalizedOptions.map((opt) => {
            const isSelected = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-my-sm px-2.5 py-1.5 text-left text-my-sm transition-colors cursor-pointer',
                  isSelected
                    ? 'bg-my-accent-subtle font-medium text-my-accent-text'
                    : 'text-my-secondary hover:bg-my-layer-1-hover hover:text-my-primary'
                )}
              >
                {opt.dot && (
                  <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', opt.dot)} />
                )}
                {opt.icon && (
                  <span className="shrink-0 text-my-icon-tertiary">{opt.icon}</span>
                )}
                <span className="flex-1 truncate">{opt.label}</span>
                {isSelected && <Check size={12} className="shrink-0 text-my-accent-text" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
