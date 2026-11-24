import { useEffect, useLayoutEffect, useRef, type JSX, type ReactNode } from 'react'
import { ChevronRight, Circle, CircleAlert, CircleCheck, CircleMinus, ListChecks, LoaderCircle, Pencil, Quote } from 'lucide-react'
import { Button } from '../my/ui'
import { MarkdownView } from '../components/MarkdownView'
import type { ConversationMessage, ConversationTimelineRow } from './useConversationThread'
import './conversation-timeline-work.css'

const FOLLOW_THRESHOLD_PX = 40
const SCROLL_RESTORE_STORAGE_PREFIX = 'crux.conversation.readPosition.'
const MAX_RESTORE_PAGES = 12
const ROW_SELECTOR = '[data-conversation-row-id]'
const WORK_STATUS = {
  running: { label: '进行中', icon: LoaderCircle },
  done: { label: '已完成', icon: CircleCheck },
  failed: { label: '失败', icon: CircleAlert },
  cancelled: { label: '已取消', icon: CircleMinus },
} as const
const PLAN_STATUS = {
  pending: { label: '待处理', icon: Circle },
  running: WORK_STATUS.running,
  completed: WORK_STATUS.done,
} as const

export interface ConversationTimelineProps {
  readonly threadId: string
  readonly rows: readonly ConversationTimelineRow[]
  readonly working: boolean
  readonly workingLabel?: string
  readonly hasOlderHistory: boolean
  readonly loadingEarlier: boolean
  readonly onLoadEarlier: () => void
  /** A non-empty selection wins over the full message text. */
  readonly onQuote?: (message: ConversationMessage, text: string) => void
  /** Only offered on the reader's own messages. */
  readonly onEdit?: (message: ConversationMessage) => void
  readonly footer?: ReactNode
  readonly emptyTitle?: string
}

interface ReadingPosition {
  readonly anchorId: string
  readonly offset: number
  readonly atEnd?: boolean
}

const readPositions = new Map<string, ReadingPosition>()

function readPositionKey(threadId: string): string {
  return `${SCROLL_RESTORE_STORAGE_PREFIX}${threadId}`
}

function loadReadingPosition(threadId: string): ReadingPosition | undefined {
  const cached = readPositions.get(threadId)
  if (cached) return cached
  try {
    const raw = window.localStorage.getItem(readPositionKey(threadId))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as ReadingPosition
    if (typeof parsed.anchorId !== 'string' || !Number.isFinite(parsed.offset)) return undefined
    readPositions.set(threadId, parsed)
    return parsed
  } catch {
    return undefined
  }
}

function saveReadingPosition(threadId: string, position: ReadingPosition): void {
  readPositions.delete(threadId)
  readPositions.set(threadId, position)
  while (readPositions.size > 32) {
    const oldest = readPositions.keys().next().value
    if (oldest === undefined) break
    readPositions.delete(oldest)
  }
  try {
    window.localStorage.setItem(readPositionKey(threadId), JSON.stringify(position))
  } catch {
    // A full or unavailable storage keeps the in-memory position only.
  }
}

function visibleAnchor(scroll: HTMLElement): ReadingPosition | undefined {
  const rows = [...scroll.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
  const top = scroll.getBoundingClientRect().top
  for (const row of rows) {
    const box = row.getBoundingClientRect()
    if (box.bottom > top) return { anchorId: row.dataset.conversationRowId ?? '', offset: box.top - top }
  }
  return rows.at(-1)
    ? { anchorId: rows.at(-1)?.dataset.conversationRowId ?? '', offset: 0 }
    : undefined
}

function restoreAnchor(scroll: HTMLElement, position: ReadingPosition): boolean {
  const anchor = scroll.querySelector<HTMLElement>(`[data-conversation-row-id="${CSS.escape(position.anchorId)}"]`)
  if (!anchor) return false
  const top = scroll.getBoundingClientRect().top
  scroll.scrollTop += anchor.getBoundingClientRect().top - top - position.offset
  return true
}

function selectedTextWithin(control: HTMLElement): string | undefined {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return undefined
  const text = selection.toString().trim()
  if (!text) return undefined
  const body = control.closest(ROW_SELECTOR)?.querySelector('.conversation-message-body')
  const nodes = [selection.anchorNode, selection.focusNode]
  return body && nodes.every((node) => node && body.contains(node)) ? text : undefined
}

/**
 * The timeline renders the projection's rows and owns reading position only. Streamed text
 * updates the same row id, so the browser's own scroll anchoring keeps the reader's line still;
 * the follow-end behaviour is disabled whenever the reader scrolls up or restores a position.
 */
export function ConversationTimeline({
  threadId,
  rows,
  working,
  workingLabel = '模型正在回复…',
  hasOlderHistory,
  loadingEarlier,
  onLoadEarlier,
  onQuote,
  onEdit,
  footer,
  emptyTitle,
}: ConversationTimelineProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const restoring = useRef<ReadingPosition | null>(null)
  const historyAnchor = useRef<ReadingPosition | null>(null)
  const wasLoadingEarlier = useRef(false)
  const restorePages = useRef(0)
  const restoreThrough = useRef<string | undefined>()

  useLayoutEffect(() => {
    const remembered = loadReadingPosition(threadId)
    restoring.current = remembered && !remembered.atEnd ? remembered : null
    follow.current = restoring.current === null
    restorePages.current = 0
    restoreThrough.current = undefined
    historyAnchor.current = null
    wasLoadingEarlier.current = false
  }, [threadId])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || !rows.length) return
    const finishedPage = wasLoadingEarlier.current && !loadingEarlier
    wasLoadingEarlier.current = loadingEarlier
    if (restoring.current && restoreAnchor(element, restoring.current)) {
      restoring.current = null
      historyAnchor.current = null
      return
    }
    if (restoring.current && (!hasOlderHistory || restorePages.current >= MAX_RESTORE_PAGES)) {
      restoring.current = null
    }
    if (finishedPage && historyAnchor.current) {
      restoreAnchor(element, historyAnchor.current)
      historyAnchor.current = null
    }
    if (follow.current) element.scrollTop = element.scrollHeight
  }, [threadId, rows, loadingEarlier, hasOlderHistory])

  useEffect(() => {
    const earliestRow = rows[0]?.id
    if (!restoring.current || !earliestRow || loadingEarlier || !hasOlderHistory ||
      restoreThrough.current === earliestRow || restorePages.current >= MAX_RESTORE_PAGES) return
    restoreThrough.current = earliestRow
    restorePages.current += 1
    onLoadEarlier()
  }, [threadId, rows, loadingEarlier, hasOlderHistory, onLoadEarlier])

  const loadEarlier = (): void => {
    const element = scrollRef.current
    restoring.current = null
    if (element) historyAnchor.current = visibleAnchor(element) ?? null
    follow.current = false
    onLoadEarlier()
  }

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const onScroll = (): void => {
      if (restoring.current) return
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight
      follow.current = distance < FOLLOW_THRESHOLD_PX
      const position = visibleAnchor(element)
      if (position?.anchorId) saveReadingPosition(threadId, { ...position, atEnd: follow.current })
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [threadId])

  return (
    <div
      ref={scrollRef}
      className="acp-transcript my-scrollbar conversation-timeline"
      aria-label="消息记录"
      tabIndex={0}
      data-following-end={follow.current ? 'true' : 'false'}
    >
      <div className="my-conversation-column acp-transcript-content conversation-timeline-content">
        {hasOlderHistory && (
          <div className="conversation-timeline-history">
            <Button size="sm" variant="ghost" disabled={loadingEarlier} onClick={loadEarlier}>
              {loadingEarlier ? '正在读取…' : '读取更早的消息'}
            </Button>
          </div>
        )}
        {!rows.length && !working && (
          <div className="acp-conversation-start">
            <h1>{emptyTitle ?? '开始一段对话'}</h1>
          </div>
        )}
        {rows.map((row) => (
          <ConversationRow key={row.id} row={row} onQuote={onQuote} onEdit={onEdit} />
        ))}
        {working && (
          <p className="my-activity-note conversation-working" role="status">
            <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
            {workingLabel}
          </p>
        )}
        {footer}
      </div>
    </div>
  )
}

function ConversationRow({
  row,
  onQuote,
  onEdit,
}: {
  readonly row: ConversationTimelineRow
  readonly onQuote?: ConversationTimelineProps['onQuote']
  readonly onEdit?: ConversationTimelineProps['onEdit']
}): JSX.Element {
  if (row.kind === 'work') {
    const { label, icon: Icon } = WORK_STATUS[row.state]
    return (
      <div
        className="conversation-work-row"
        data-conversation-row-id={row.id}
        data-state={row.state}
        role="group"
        aria-label={`${row.text}，${label}`}
      >
        <Icon size={14} aria-hidden="true" className={row.state === 'running' ? 'animate-spin' : undefined} />
        <span className="conversation-work-text">{row.text}</span>
      </div>
    )
  }
  if (row.kind === 'plan') {
    const item = row.item
    return (
      <details className="conversation-timeline-plan" data-conversation-row-id={row.id}>
        <summary className="my-item-title">
          <ListChecks size={15} aria-hidden="true" />
          {item.type === 'proposed_plan' ? '计划建议' : '计划'}
          <ChevronRight className="conversation-timeline-plan-arrow" size={14} aria-hidden="true" />
        </summary>
        <div className="conversation-timeline-plan-content">
          {item.type === 'proposed_plan' ? (
            <div className="my-chat-prose"><MarkdownView content={item.markdown} /></div>
          ) : (
            <>
              {item.explanation && <p className="my-item-description">{item.explanation}</p>}
              <ol className="conversation-timeline-plan-steps">
                {item.steps.map((step) => {
                  const { label, icon: Icon } = PLAN_STATUS[step.status]
                  return <li key={step.id}>
                    <Icon size={14} aria-hidden="true" className={step.status === 'running' ? 'animate-spin' : undefined} />
                    <span className="sr-only">{label}，</span>{step.text}
                  </li>
                })}
              </ol>
            </>
          )}
        </div>
      </details>
    )
  }
  const user = row.message.role === 'user'
  return (
    <article
      className={`conversation-message conversation-message-${row.message.role}`}
      data-conversation-row-id={row.id}
      aria-label={user ? '你的消息' : row.message.role === 'assistant' ? '模型回复' : '系统消息'}
    >
      {(onQuote || (user && onEdit)) && (
        <div className="conversation-message-actions">
          {onQuote && (
            <button
              type="button"
              className="my-icon-control"
              title="引用"
              aria-label={user ? '引用这条消息' : '引用这段回复'}
              onMouseDown={(event) => { if (selectedTextWithin(event.currentTarget)) event.preventDefault() }}
              onClick={(event) => onQuote(row.message, selectedTextWithin(event.currentTarget) ?? row.message.text)}
            >
              <Quote size={13} aria-hidden="true" />
            </button>
          )}
          {user && onEdit && (
            <button
              type="button"
              className="my-icon-control"
              title="编辑"
              aria-label="编辑这条消息"
              onClick={() => onEdit(row.message)}
            >
              <Pencil size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      <div className="my-chat-prose conversation-message-body">
        {row.message.role === 'assistant' || row.message.text.includes('`') || row.message.text.includes('\n')
          ? <MarkdownView content={row.message.text} />
          : row.message.text}
      </div>
      {row.message.streaming && (
        <span className="conversation-streaming" role="status" aria-label="正在回复">
          <LoaderCircle size={11} className="animate-spin" aria-hidden="true" />
        </span>
      )}
    </article>
  )
}
