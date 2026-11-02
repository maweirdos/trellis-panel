import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Pin } from 'lucide-react'
import { clsx } from 'clsx'
import { Button, Modal } from '../my/ui'
import { useEscLayer } from '../utils/use-esc-layer'
import { useInteractionGuard } from '../utils/interaction-scope'

export interface ConversationListRowProps {
  id: string
  title: string
  selected: boolean
  pinned?: boolean
  previewId?: string
  status?: ReactNode
  actions?: ReactNode
  error?: string
  onSelect(): void
  onPreview?(element: HTMLButtonElement): void
  onDismissPreview?(): void
}

export function ConversationListRow({ id, title, selected, pinned, previewId, status, actions, error, onSelect, onPreview, onDismissPreview }: ConversationListRowProps): JSX.Element {
  return <div className="acp-recent-item" data-selected={selected || undefined}>
    <button type="button" data-acp-session={id} className={clsx('acp-recent-row my-nav-item', selected && 'is-selected')} aria-current={selected ? 'page' : undefined} aria-describedby={previewId}
      onMouseEnter={(event) => onPreview?.(event.currentTarget)} onMouseLeave={onDismissPreview} onFocus={(event) => onPreview?.(event.currentTarget)} onBlur={onDismissPreview} onClick={() => { onDismissPreview?.(); onSelect() }}>
      <span className="my-item-title">{title}</span>
      {pinned && <Pin size={12} className="acp-recent-pin" aria-label="已置顶" />}
      {status}
    </button>
    {actions}
    {error && <p role="alert" className="acp-session-menu-error">{error}</p>}
  </div>
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
