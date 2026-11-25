import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Check, Copy, GitFork, Pencil, Reply, TriangleAlert } from 'lucide-react'
import { useCopyFeedback } from '../utils/use-copy-feedback'
import { ChatMarkdown } from './ChatMarkdown'
import type { ConversationMessage, ConversationTimelineRow } from './useConversationThread'
import { formatDayAwareTimestamp } from './chatTimestamp'

export interface TimelineMessageActions {
  readonly onQuote?: (message: ConversationMessage, text: string) => void
  readonly onEdit?: (message: ConversationMessage) => void
  readonly onForkFromRun?: (runId: string) => void
}

type MessageRowProps = TimelineMessageActions & {
  readonly row: Extract<ConversationTimelineRow, { kind: 'message' }>
}

function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="conversation-message-author">{children}</h3>
}

function TimelineRowTimestamp({ createdAt }: { createdAt: ConversationMessage['createdAt'] }) {
  const iso = toIso(createdAt)
  if (!iso) return null
  return <span className="conversation-message-time" title={new Date(iso).toLocaleString('zh-CN')}>
    {formatDayAwareTimestamp(iso)}
  </span>
}

function toIso(createdAt: ConversationMessage['createdAt']): string | undefined {
  if (!createdAt) return undefined
  const date = new Date(typeof createdAt === 'string' ? createdAt : createdAt.epochMilliseconds)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function selectedTextWithin(control: HTMLElement): string | undefined {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return undefined
  const body = control.closest('article')?.querySelector('.conversation-message-body')
  const nodes = [selection.anchorNode, selection.focusNode]
  return body && nodes.every(node => node && body.contains(node)) ? selection.toString().trim() || undefined : undefined
}

function MessageCopyButton({ message, user }: { message: ConversationMessage; user: boolean }) {
  const copy = useCopyFeedback(message)
  const label = user ? '复制这条消息' : '复制这段回复'
  const copying = copy.status === 'copying'
  return <>
    <button type="button" className="my-icon-control" title={label}
      aria-label={copy.status === 'error' ? `重试${label}` : label} aria-disabled={copying}
      onClick={() => { if (!copying) void copy.copy(message.text) }}>
      {copy.status === 'copied' ? <Check size={13} aria-hidden="true" />
        : copy.status === 'error' ? <TriangleAlert size={13} aria-hidden="true" />
          : <Copy size={13} aria-hidden="true" />}
    </button>
    <span role="status" className={copy.status === 'error' ? 'conversation-message-copy-error' : 'conversation-sr-only'}>
      {copy.status === 'error' ? '复制失败，请重试或选择文字复制' : copy.status === 'copied' ? '已复制' : ''}
    </span>
  </>
}

function MessageReplyButton({ message, onQuote, label }: {
  message: ConversationMessage
  onQuote: NonNullable<TimelineMessageActions['onQuote']>
  label: string
}) {
  return <button type="button" className="my-icon-control" title={label} aria-label={label}
    onMouseDown={event => { if (selectedTextWithin(event.currentTarget)) event.preventDefault() }}
    onClick={event => onQuote(message, selectedTextWithin(event.currentTarget) ?? message.text)}>
    <Reply size={13} aria-hidden="true" />
  </button>
}

function MessageBody({ children }: { children: ReactNode }) {
  return <div className="conversation-message-body">{children}</div>
}

/** Upstream actions cluster: time first, then a gap-0.5 group of ghost icon buttons. */
function MessageActions({ children }: { children: ReactNode }) {
  return <div className="conversation-message-actions">{children}</div>
}

export function UserMessageRow({ row, onQuote, onEdit }: MessageRowProps) {
  const { message } = row
  return (
    <article className="conversation-message conversation-message-user" data-user-message-row>
      <div className="conversation-message-bubble" data-user-message-bubble>
        <MessageAuthorHeading>你的消息</MessageAuthorHeading>
        <MessageBody>
          <ChatMarkdown text={message.text} user />
        </MessageBody>
      </div>
      <MessageActions>
        <TimelineRowTimestamp createdAt={message.createdAt} />
        <span className="conversation-action-group">
          <MessageCopyButton message={message} user />
          {onQuote && <MessageReplyButton message={message} onQuote={onQuote} label="引用这条消息" />}
          {onEdit && <button type="button" className="my-icon-control" title="编辑这条消息" aria-label="编辑这条消息"
            onClick={() => onEdit(message)}><Pencil size={12} aria-hidden="true" /></button>}
        </span>
      </MessageActions>
    </article>
  )
}

export function AssistantTimelineRow({ row, onQuote, onForkFromRun }: MessageRowProps) {
  const { message, forkRunId } = row
  return (
    <article className="conversation-message conversation-message-assistant" data-assistant-message-row>
      <div className="conversation-message-bubble">
        <MessageAuthorHeading>{message.role === 'system' ? '系统消息' : '模型回复'}</MessageAuthorHeading>
        <MessageBody><ChatMarkdown text={message.text} isStreaming={message.streaming} /></MessageBody>
      </div>
      <MessageActions>
        {message.text && <MessageCopyButton message={message} user={false} />}
        {forkRunId && onForkFromRun && <button type="button" className="my-icon-control" title="从此回合创建分支"
          aria-label="从此回合创建分支" onClick={() => onForkFromRun(forkRunId)}>
          <GitFork size={12} aria-hidden="true" />
        </button>}
        {message.text && onQuote && <MessageReplyButton message={message} onQuote={onQuote} label="引用这段回复" />}
        {!message.streaming && <TimelineRowTimestamp createdAt={message.updatedAt ?? message.createdAt} />}
      </MessageActions>
    </article>
  )
}

/**
 * Upstream WorkingTimelineRow: a muted 24px line with a live elapsed timer and a
 * sweeping focus band while the model runs. Reduced motion hides the band.
 */
export function WorkingTimelineRow({ startedAt, label }: { readonly startedAt?: string; readonly label?: string }) {
  const elapsed = useElapsedLabel(startedAt)
  const text = label ?? (startedAt ? `工作了 ${elapsed}` : '正在工作…')
  return (
    <div className="conversation-working" role="status" aria-live="polite">
      <span className="conversation-live-label" aria-hidden="true">
        {text}
        <span className="conversation-live-focus"><span>{text}</span></span>
      </span>
      <span className="conversation-sr-only">{text}</span>
    </div>
  )
}

const SECOND = 1000
const MINUTE = 60 * SECOND

/** Upstream formatDuration: "12.3s" under 10s, "45s", "1m 02s", "1h 03m 04s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < SECOND) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 10 * SECOND) return `${Math.round(ms / 100) / 10}s`
  const total = Math.round(ms / SECOND)
  if (total < 60) return `${total}s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours === 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  if (minutes > 0) return `${hours}h ${minutes}m ${seconds}s`
  return seconds > 0 ? `${hours}h ${seconds}s` : `${hours}h`
}

function useElapsedLabel(startedAt?: string): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt) return
    const started = Date.parse(startedAt)
    if (!Number.isFinite(started)) return
    const delay = Math.max(250, SECOND - ((Date.now() - started) % SECOND))
    const timer = window.setTimeout(() => setNow(Date.now()), delay)
    return () => window.clearTimeout(timer)
  }, [startedAt, now])
  if (!startedAt) return '0s'
  const started = Date.parse(startedAt)
  return Number.isFinite(started) ? formatDuration(Math.max(0, now - started)) : '0s'
}
