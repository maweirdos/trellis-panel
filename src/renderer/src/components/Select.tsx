import { useRef, useId, type JSX, type ReactNode, type RefObject, type KeyboardEvent, type FocusEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import { Dropdown } from '../my/ui'

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  icon?: ReactNode
  dot?: string
  disabled?: boolean
}

export interface SelectProps<T extends string = string> {
  id?: string
  value: T
  onChange: (value: T) => void
  options: Array<SelectOption<T> | string>
  placeholder?: string
  className?: string
  size?: 'sm' | 'md'
  disabled?: boolean
  autoFocus?: boolean
  ariaLabel?: string
  'aria-label'?: string
  'aria-describedby'?: string
  title?: string
  onBlur?: () => void
  onOpen?: () => void
  emptyContent?: ReactNode
  composerAnchor?: RefObject<HTMLElement>
}

/** Theme-aware replacement for platform-native select menus. */
export function Select<T extends string = string>({
  id: idProp,
  value,
  onChange,
  options,
  placeholder = '请选择',
  className,
  size = 'md',
  disabled = false,
  autoFocus = false,
  ariaLabel,
  title,
  onBlur,
  onOpen,
  emptyContent,
  composerAnchor,
  ...restProps
}: SelectProps<T>): JSX.Element {
  const autoId = useId()
  const id = idProp ?? autoId
  const finalAriaLabel = ariaLabel ?? restProps['aria-label']
  const finalAriaDescribedBy = restProps['aria-describedby']
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef({ text: '', at: 0 })
  const normalizedOptions: SelectOption<T>[] = options.map((option) =>
    typeof option === 'string' ? { value: option as T, label: option } : option
  )
  const selectedOption = normalizedOptions.find((option) => option.value === value)
  const fill = /(^|\s)(w-full|flex-1)(\s|$)/.test(className ?? '')
  const triggerLayoutClasses = (className ?? '').split(/\s+/).filter((name) => /^(?:[a-z]+:)?(?:h-|w-|min-w-|max-w-|flex-1)/.test(name))
  const hostClasses = (className ?? '').split(/\s+/).filter((name) => name && name !== 'my-input').join(' ')

  const searchOptions = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey || event.key.length !== 1 || event.key === ' ') return
    const now = performance.now()
    const previous = searchRef.current
    const text = (now - previous.at > 700 ? '' : previous.text) + event.key.toLocaleLowerCase()
    searchRef.current = { text, at: now }
    const query = [...text].every((key) => key === text[0]) ? text[0] : text
    const current = Number((document.activeElement as HTMLElement | null)?.dataset.selectIndex ?? -1)
    const indexes = normalizedOptions.map((_, index) => (index + current + 1) % normalizedOptions.length)
    const target = indexes.find((index) => !normalizedOptions[index].disabled && normalizedOptions[index].label.trim().toLocaleLowerCase().startsWith(query))
    if (target === undefined) return
    event.preventDefault()
    const option = menuRef.current?.querySelector<HTMLButtonElement>(`[data-select-index="${target}"]`)
    option?.focus({ preventScroll: true })
    option?.scrollIntoView({ block: 'nearest' })
  }

  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget
    if (!(next instanceof Node) || (!triggerRef.current?.contains(next) && !menuRef.current?.contains(next))) onBlur?.()
  }

  return (
    <div className="contents" onBlur={onBlur ? handleBlur : undefined}>
    <Dropdown
      disabled={disabled}
      className={clsx('my-select-host min-w-0', fill && 'w-full', hostClasses)}
      align={composerAnchor ? 'right' : undefined}
      placement={composerAnchor ? 'top' : undefined}
      gap={composerAnchor ? 8 : undefined}
      width={composerAnchor ? 340 : undefined}
      positionAnchorRef={composerAnchor}
      trigger={({ open, toggle }) => {
        return (
          <button
            ref={triggerRef}
            id={id}
            type="button"
            autoFocus={autoFocus}
            disabled={disabled}
            title={title}
            aria-label={composerAnchor && finalAriaLabel && selectedOption ? `${finalAriaLabel}，当前 ${selectedOption.label}` : finalAriaLabel}
            aria-describedby={finalAriaDescribedBy}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? `${id}-options` : undefined}
            onClick={() => {
              searchRef.current = { text: '', at: 0 }
              if (!open) onOpen?.()
              toggle()
            }}
            className={clsx(composerAnchor ? 'my-composer-control acp-composer-context acp-model-trigger px-1.5 py-1' : 'my-select-trigger', fill && 'w-full', triggerLayoutClasses, size === 'sm' && !composerAnchor && 'my-select-trigger-sm')}
          >
            <span className="my-select-value">
              {selectedOption?.dot && <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', selectedOption.dot)} />}
              {selectedOption?.icon && <span className="shrink-0 text-my-icon-tertiary">{selectedOption.icon}</span>}
              <span className="truncate">{selectedOption?.label ?? placeholder}</span>
            </span>
            <ChevronDown size={13} className={clsx('my-select-chevron shrink-0 transition-transform', open && 'rotate-180')} />
          </button>
        )
      }}
    >
      {(close) => normalizedOptions.length === 0 && emptyContent ? (
        <div id={`${id}-options`} className="px-3 py-1">{emptyContent}</div>
      ) : (
        <div
          ref={menuRef}
          id={`${id}-options`}
          role="listbox"
          aria-label={finalAriaLabel ?? title ?? '选择一项'}
          className="my-select-menu my-scrollbar max-h-60 overflow-y-auto"
          onKeyDown={searchOptions}
        >
          {normalizedOptions.map((option, index) => {
            const selected = option.value === value
            return (
              <button
                key={`${option.value}-${index}`}
                type="button"
                role="option"
                data-select-index={index}
                aria-selected={selected}
                disabled={option.disabled}
                onClick={() => {
                  onChange(option.value)
                  close()
                }}
                className={clsx('my-select-option', selected && 'is-selected')}
              >
                {option.dot && <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', option.dot)} />}
                {option.icon && <span className="shrink-0 text-my-icon-tertiary">{option.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {selected && <Check size={13} className="shrink-0" />}
              </button>
            )
          })}
        </div>
      )}
    </Dropdown>
    </div>
  )
}
