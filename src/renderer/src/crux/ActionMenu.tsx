import type { JSX, ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Dropdown, DropdownDivider, DropdownHeader, DropdownItem } from '../my/ui'

export type ActionMenuEntry =
  | {
      readonly kind: 'item'
      readonly id: string
      readonly label: string
      readonly icon?: ReactNode
      readonly shortcut?: string
      readonly selected?: boolean
      readonly danger?: boolean
      readonly disabled?: boolean
      readonly onSelect: () => void
    }
  | { readonly kind: 'divider'; readonly id: string }
  | { readonly kind: 'header'; readonly id: string; readonly label: string }

/**
 * Crux 公共规范动作菜单组件：
 * 直接复用设计系统唯一的 DropdownItem / DropdownHeader / DropdownDivider（.my-menu-*），
 * 确保全站所有下拉菜单在行高、字号、内边距、圆角、分割线与悬停反馈上 100% 统一。
 */
export function ActionMenu({
  items,
  align = 'right',
  width = 180,
  ariaLabel = '更多操作',
  trigger
}: {
  items: readonly ActionMenuEntry[]
  align?: 'left' | 'right'
  width?: number
  ariaLabel?: string
  trigger?: (props: { open: boolean; toggle: () => void }) => ReactNode
}): JSX.Element {
  const hasAnyIcon = items.some((entry) => entry.kind === 'item' && Boolean(entry.icon))

  return (
    <Dropdown
      align={align}
      width={width}
      trigger={
        trigger ??
        (({ open, toggle }) => (
          <button
            type="button"
            aria-label={ariaLabel}
            aria-expanded={open}
            onClick={toggle}
            className="grid h-7 w-7 place-items-center rounded-my-base text-my-icon-secondary transition-colors hover:bg-my-layer-1 hover:text-my-primary"
          >
            <MoreHorizontal size={15} />
          </button>
        ))
      }
    >
      {(close) => (
        <>
          {items.map((entry) => {
            if (entry.kind === 'divider') {
              return <DropdownDivider key={entry.id} />
            }
            if (entry.kind === 'header') {
              return <DropdownHeader key={entry.id}>{entry.label}</DropdownHeader>
            }
            return (
              <DropdownItem
                key={entry.id}
                icon={entry.icon ?? (hasAnyIcon ? <span className="inline-block h-3.5 w-3.5" aria-hidden="true" /> : undefined)}
                selected={entry.selected}
                danger={entry.danger}
                disabled={entry.disabled}
                shortcut={entry.shortcut}
                onClick={() => {
                  close()
                  entry.onSelect()
                }}
              >
                {entry.label}
              </DropdownItem>
            )
          })}
        </>
      )}
    </Dropdown>
  )
}
