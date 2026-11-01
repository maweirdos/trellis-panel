import type { JSX, ReactNode, UIEventHandler } from 'react'
import { X } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from '../my/ui'
import { SidebarResizeHandle } from '../my/layout/SidebarResizeHandle'

export interface ConversationSidebarProps {
  title: ReactNode
  actions?: ReactNode
  primaryAction?: ReactNode
  label?: ReactNode
  children: ReactNode
  footer?: ReactNode
  open: boolean
  onClose: () => void
  onScroll?: UIEventHandler<HTMLDivElement>
  ariaLabel?: string
  resizable?: boolean
  resizeLabel?: string
}

export function ConversationSidebar({ title, actions, primaryAction, label, children, footer, open, onClose, onScroll, ariaLabel = '角色与会话导航', resizable = true, resizeLabel = '调整会话侧栏宽度' }: ConversationSidebarProps): JSX.Element {
  return <>
    {open && <button className="acp-sidebar-scrim" aria-label="关闭会话导航" onClick={onClose} />}
    <aside className={clsx('my-context-sidebar acp-navigation', open && 'is-open')} aria-label={ariaLabel}>
      <div className="acp-navigation-title">{title}<div className="flex-1" />{actions}<Button size="sm" variant="ghost" className="acp-mobile-only" title="关闭会话导航" onClick={onClose}><X size={14} /></Button></div>
      {primaryAction && <div className="acp-navigation-primary">{primaryAction}</div>}
      {label && <div className="acp-navigation-label">{label}</div>}
      <div className="acp-navigation-scroll my-scrollbar" onScroll={onScroll}>{children}</div>
      {footer}
      {resizable && <SidebarResizeHandle label={resizeLabel} />}
    </aside>
  </>
}
