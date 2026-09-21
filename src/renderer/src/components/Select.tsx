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
          'flex w-full items-center justify-between gap-1.5 rounded-lg border border-ink-700/80 bg-ink-850 px-2.5 text-left text-xs transition-all cursor-pointer select-none',
          size === 'sm' ? 'h-7 py-1' : 'h-8 py-1.5',
          open
            ? 'border-leaf/60 ring-2 ring-leaf/20 shadow-xs text-mist-50'
            : 'text-mist-100 hover:border-ink-500 hover:bg-ink-800',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {selectedOption?.dot && (
            <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', selectedOption.dot)} />
          )}
          {selectedOption?.icon && (
            <span className="shrink-0 text-mist-400">{selectedOption.icon}</span>
          )}
          <span className="truncate">
            {selectedOption ? selectedOption.label : placeholder}
          </span>
        </span>
        <ChevronDown
          size={12}
          className={clsx(
            'shrink-0 text-mist-400 transition-transform duration-150',
            open && 'rotate-180 text-leaf'
          )}
        />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-60 min-w-full w-max overflow-y-auto rounded-lg border border-ink-700/80 bg-ink-800/95 p-1 shadow-xl backdrop-blur-md animate-fade-in">
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
                  'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer',
                  isSelected
                    ? 'bg-leaf-dim/15 font-medium text-leaf-soft'
                    : 'text-mist-200 hover:bg-ink-700/60 hover:text-mist-50'
                )}
              >
                {opt.dot && (
                  <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', opt.dot)} />
                )}
                {opt.icon && (
                  <span className="shrink-0 text-mist-400">{opt.icon}</span>
                )}
                <span className="flex-1 truncate">{opt.label}</span>
                {isSelected && <Check size={12} className="shrink-0 text-leaf-soft" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
