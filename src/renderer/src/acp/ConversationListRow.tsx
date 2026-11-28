import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Archive, ArchiveRestore, Loader2, Pin, PinOff } from 'lucide-react'
import { clsx } from 'clsx'
import { Button, Modal } from '../my/ui'
import { useEscLayer } from '../utils/use-esc-layer'
import { useInteractionGuard } from '../utils/interaction-scope'
import { ConversationActivityIndicator } from './ConversationActivityIndicator'
import { formatRelativeTime } from './conversation-selection'

export interface ConversationListRowProps {
  id: string
  title: string
  selected: boolean
  pinned?: boolean
  archived?: boolean
  unread?: boolean
  tags?: readonly string[]
  busy?: boolean
  time?: number
  previewId?: string
  status?: ReactNode
  actions?: ReactNode
  error?: string
  onSelect(): void
  onTogglePin?(): void
  onToggleArchive?(): void
  onPreview?(element: HTMLButtonElement): void
  onDismissPreview?(): void
}

export function ArchiveArrowDown({ size = 13, strokeWidth = 1.5, className }: { size?: number; strokeWidth?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <line x1="2" y1="6" x2="14" y2="6" />
      <path d="M8 8.5v3.5M6 10.5l2 1.8 2-1.8" />
    </svg>
  )
}

export function ConversationListRow({
  id,
  title,
  selected,
  pinned,
  archived,
  unread,
  tags,
  busy,
  time,
  previewId,
  status,
  actions,
  error,
  onSelect,
  onTogglePin,
  onToggleArchive,
  onPreview,
  onDismissPreview
}: ConversationListRowProps): JSX.Element {
  const relativeTime = formatRelativeTime(time)

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey && event.shiftKey && (event.key === 'P' || event.key === 'p')) {
      if (onTogglePin) {
        event.preventDefault()
        event.stopPropagation()
        onTogglePin()
      }
    } else if (event.ctrlKey && event.altKey && (event.key === 'A' || event.key === 'a')) {
      if (onToggleArchive) {
        event.preventDefault()
        event.stopPropagation()
        onToggleArchive()
      }
    }
  }

  return (
    <div
      className={clsx('acp-recent-item', busy && 'is-busy', pinned && 'is-pinned')}
      data-selected={selected || undefined}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        data-acp-session={id}
        className={clsx('acp-recent-row my-nav-item', selected && 'is-selected')}
        aria-current={selected ? 'page' : undefined}
        aria-describedby={previewId}
        onMouseEnter={(event) => onPreview?.(event.currentTarget)}
        onMouseLeave={onDismissPreview}
        onFocus={(event) => onPreview?.(event.currentTarget)}
        onBlur={onDismissPreview}
        onClick={() => {
          onDismissPreview?.()
          onSelect()
        }}
      >
        {unread && !selected && <span className="acp-recent-unread-dot" aria-label="未读" />}
        <span className="acp-recent-title my-item-title" title={title}>
          {title}
        </span>

        {/* 常态下的 Meta 区域：进行时动效、置顶图钉、相对时间 */}
        <span className="acp-recent-meta">
          {busy && <ConversationActivityIndicator />}
          {pinned && <Pin size={12} className="acp-recent-pin shrink-0" aria-label="已置顶" />}
          {tags && tags.slice(0, 2).map(tag => <span key={tag} className="acp-recent-tag-badge" title={tag}>{tag}</span>)}
          {relativeTime && <time className="acp-recent-time">{relativeTime}</time>}
          {status}
        </span>
      </button>

      {/* 悬浮/聚焦/菜单打开时的一体化胶囊快捷工具栏 (对齐图二: 归档 -> 置顶 -> 更多) */}
      <div className="acp-recent-actions" onClick={(e) => e.stopPropagation()}>
        {busy && <ConversationActivityIndicator className="acp-recent-actions-indicator" />}
        {onToggleArchive && (
          <button
            type="button"
            className="acp-recent-action-btn my-icon-control"
            title={archived ? '取消归档 (Ctrl+Alt+A)' : '归档 (Ctrl+Alt+A)'}
            aria-label={archived ? '取消归档' : '归档'}
            onClick={(event) => {
              event.stopPropagation()
              onDismissPreview?.()
              onToggleArchive()
            }}
          >
            {archived ? <ArchiveRestore size={13} strokeWidth={1.5} /> : <ArchiveArrowDown size={13} strokeWidth={1.5} />}
          </button>
        )}
        {onTogglePin && (
          <button
            type="button"
            className="acp-recent-action-btn my-icon-control"
            title={pinned ? '取消置顶 (Alt+Shift+P)' : '置顶 (Alt+Shift+P)'}
            aria-label={pinned ? '取消置顶' : '置顶'}
            onClick={(event) => {
              event.stopPropagation()
              onDismissPreview?.()
              onTogglePin()
            }}
          >
            {pinned ? <PinOff size={13} strokeWidth={1.5} /> : <Pin size={13} />}
          </button>
        )}
        {actions}
      </div>

      {error && <p role="alert" className="acp-session-menu-error">{error}</p>}
    </div>
  )
}

export interface ConversationPreviewContent {
  id: string
  title: string
  summary: string
  time: number
  metadata: ReactNode
}
export interface ConversationListPreviewState extends ConversationPreviewContent { left: number; top: number; host: Element }

export function useConversationListPreview(owner: string, enabled: boolean): {
  id: string
  preview: ConversationListPreviewState | null
  schedule(value: ConversationPreviewContent, element: HTMLButtonElement): void
  dismiss(): void
} {
  const canInteract = useInteractionGuard()
  const [preview, setPreview] = useState<ConversationListPreviewState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), hovered = useRef<string | null>(null)
  const latest = useRef({ owner, enabled }); latest.current = { owner, enabled }
  const id = useId()
  const dismiss = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null; hovered.current = null; setPreview(null)
  }
  useEscLayer(preview !== null && enabled, { kind: 'modal', id: `acp-hover-${id}`, onClose: dismiss })
  useEffect(() => {
    window.addEventListener('scroll', dismiss, true); window.addEventListener('resize', dismiss)
    return () => { if (timer.current) clearTimeout(timer.current); window.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss) }
  }, [])
  useEffect(dismiss, [owner, enabled])
  const schedule = (value: ConversationPreviewContent, element: HTMLButtonElement): void => {
    if (!canInteract() || !enabled) return
    dismiss(); hovered.current = value.id
    const rect = element.getBoundingClientRect(), host = element.closest('.my-root') ?? document.body
    timer.current = setTimeout(() => {
      if (!canInteract() || latest.current.owner !== owner || !latest.current.enabled || hovered.current !== value.id || !element.isConnected) return
      const width = 260, height = 110, gap = 10
      const left = rect.right + gap + width <= window.innerWidth - gap ? rect.right + gap : Math.max(gap, rect.left - width - gap)
      setPreview({ ...value, left, top: Math.max(gap, Math.min(rect.top - 4, window.innerHeight - height - gap)), host })
    }, 350)
  }
  return { id, preview: enabled ? preview : null, schedule, dismiss }
}

export function ConversationListPreview({ id, preview }: { id: string; preview: ConversationListPreviewState | null }): JSX.Element | null {
  return preview ? createPortal(<div role="tooltip" id={id} className="acp-recent-tooltip" style={{ left: preview.left, top: preview.top }}><div><strong>{preview.title}</strong><time>{new Date(preview.time).toLocaleString([], { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div><p>{preview.summary}</p><small>{preview.metadata}</small></div>, preview.host) : null
}

export function ConversationRenameDialog({ open, title, error, busy, onTitle, onClose, onSave }: {
  open: boolean; title: string; error?: string; busy?: boolean
  onTitle(value: string): void; onClose(): void; onSave(): void
}): JSX.Element {
  const composing = useRef(false), inputId = useId(), errorId = useId()
  useEffect(() => { composing.current = false }, [open])
  return <Modal open={open} onClose={onClose} width={440} ariaLabel="重命名会话" placement="center">
    <form className="p-5" onSubmit={(event) => { event.preventDefault(); if (!composing.current) onSave() }}>
      <h2 className="mb-4 text-my-lg font-medium text-my-primary">重命名会话</h2>
      <label htmlFor={inputId} className="mb-2 block text-my-sm text-my-secondary">会话标题</label>
      <input id={inputId} autoFocus className="my-input w-full" aria-label="会话标题" aria-invalid={!!error} aria-describedby={errorId} value={title} onChange={(event) => onTitle(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => { if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); if (event.key === 'Escape' && (composing.current || event.nativeEvent.isComposing)) event.stopPropagation() }} />
      <p id={errorId} role={error ? 'alert' : undefined} className="mt-2 text-my-sm text-my-danger-text">{error}</p>
      <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>取消</Button><Button onClick={onSave} variant="primary" disabled={busy}>{busy && <Loader2 size={14} className="animate-spin" />}保存</Button></div>
    </form>
  </Modal>
}
