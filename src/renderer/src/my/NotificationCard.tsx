import { useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { Check, TriangleAlert, Info, CircleX, X, ChevronDown, ChevronUp } from 'lucide-react'
import type { ToastEvent } from '@shared/types'

const ICONS = { success: Check, warn: TriangleAlert, info: Info, error: CircleX }

/** Shared notification surface; semantic color belongs to the icon, never its frame. */
export function NotificationCard({ notification, onDismiss, action, onExpandedChange }: {
  notification: ToastEvent
  onDismiss?: () => void
  action?: { label: string; onClick: () => void }
  onExpandedChange?: (expanded: boolean) => void
}): JSX.Element {
  const Icon = ICONS[notification.kind]
  const contentId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    if (expanded) return
    const measure = (): void => {
      setOverflowing([bodyRef.current, titleRef.current].some((element) => element && element.scrollHeight > element.clientHeight + 1))
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (bodyRef.current) observer.observe(bodyRef.current)
    if (titleRef.current) observer.observe(titleRef.current)
    return () => observer.disconnect()
  }, [notification.title, notification.body, expanded])

  const toggle = (): void => {
    const next = !expanded
    setExpanded(next)
    onExpandedChange?.(next)
  }

  return <article className="my-notification" data-kind={notification.kind} data-expanded={expanded}>
    <span className="my-notification-icon" aria-hidden="true"><Icon /></span>
    <div className="my-notification-content">
      <div id={contentId} className="my-notification-message my-scrollbar" role={notification.kind === 'error' ? 'alert' : 'status'} aria-atomic="true" tabIndex={expanded ? 0 : undefined}>
        <div ref={titleRef} className="my-notification-title my-item-title">{notification.title}</div>
        {notification.body && <div ref={bodyRef} className="my-notification-body my-item-description">{notification.body}</div>}
      </div>
      {(action || overflowing || expanded) && <div className="my-notification-actions">
        {action && <button type="button" className="my-notification-action" onClick={action.onClick}>{action.label}</button>}
        {(overflowing || expanded) && <button type="button" className="my-notification-action" aria-expanded={expanded} aria-controls={contentId} onClick={toggle}>
          {expanded ? '收起' : '展开详情'}{expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>}
      </div>}
    </div>
    {onDismiss && <button type="button" className="my-notification-dismiss" aria-label="关闭通知" onClick={onDismiss}><X aria-hidden="true" /></button>}
  </article>
}
