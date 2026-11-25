import { useLayoutEffect, useRef, type JSX, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { Bot, MessageSquare, MessagesSquare, Package, Paperclip, Sparkles } from 'lucide-react'
import type { ComposerMenuItem } from './useComposerMenuItems'

interface ComposerMenuProps {
  readonly id: string
  readonly anchor: RefObject<HTMLTextAreaElement>
  readonly items: readonly ComposerMenuItem[]
  readonly activeIndex: number
  readonly onHighlight: (index: number) => void
  readonly onSelect: (item: ComposerMenuItem) => void
}

/** Upstream ComposerCommandMenuItem: every row leads with the kind's icon. */
function MenuItemIcon({ item }: { readonly item: ComposerMenuItem }): JSX.Element {
  const Icon = item.type === 'model' ? Bot
    : item.type === 'side' ? MessagesSquare
      : item.type === 'thread' ? MessageSquare
        : item.type === 'attachment' ? Paperclip
          : item.id.startsWith('slash:') ? Sparkles : Package
  return <Icon aria-hidden="true" />
}

export function ConversationComposerMenu({
  id, anchor, items, activeIndex, onHighlight, onSelect,
}: ComposerMenuProps): JSX.Element | null {
  const menuRef = useRef<HTMLDivElement>(null)
  const portalRoot = anchor.current?.closest('.my-root')
  useLayoutEffect(() => {
    const input = anchor.current
    const menu = menuRef.current
    if (!input || !menu) return
    let current = true
    const stop = autoUpdate(input, menu, () => {
      void computePosition(input, menu, {
        placement: 'top-start',
        strategy: 'fixed',
        middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 }), size({
          padding: 8,
          apply({ availableHeight, availableWidth, rects }) {
            if (!current) return
            menu.style.width = `${Math.max(0, Math.min(320, availableWidth, rects.reference.width))}px`
            menu.style.maxHeight = `${Math.max(0, Math.min(320, availableHeight))}px`
          },
        })],
      }).then(({ x, y }) => {
        if (current) Object.assign(menu.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
      })
    })
    return () => { current = false; stop() }
  }, [anchor, portalRoot])
  useLayoutEffect(() => {
    menuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, items])
  if (!portalRoot) return null
  return createPortal(<div ref={menuRef} className="my-menu" id={id} role="listbox" aria-label="输入建议"
    style={{ position: 'fixed', visibility: 'hidden', top: 0, left: 0 }}>
    <div className="my-scrollbar overflow-auto">
      {items.map((item, index) => <button key={item.id} id={`${id}-${index}`} type="button" role="option" tabIndex={-1}
        aria-selected={index === activeIndex} className="my-menu-item"
        onMouseDown={event => event.preventDefault()} onMouseMove={() => onHighlight(index)} onClick={() => onSelect(item)}>
        <span className="my-menu-icon"><MenuItemIcon item={item} /></span>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.description && <span className="my-item-description truncate">{item.description}</span>}
      </button>)}
    </div>
  </div>, portalRoot)
}
