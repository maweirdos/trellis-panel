import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { LegendList, type LegendListRef } from '@legendapp/list/react'
import { ChevronRight, Circle, CircleAlert, CircleCheck, CircleMinus, ListChecks, LoaderCircle } from 'lucide-react'
import { Button } from '../my/ui'
import { ChatMarkdown } from './ChatMarkdown'
import { ConversationTimelineRelationRow, type ConversationThreadTab } from './ConversationRelations'
import { ConversationTurnFileChange } from './ConversationTurnFileChange'
import { AssistantTimelineRow, UserMessageRow, WorkingTimelineRow, type TimelineMessageActions } from './TimelineMessageRows'
import { TimelineMinimap } from './TimelineMinimap'
import {
  deriveTimelineMinimapItems,
  isTimelineMinimapTurnVisible,
  resolveTimelineMinimapCurrentIndex,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHitStripWidth,
  resolveTimelineMinimapVisibleRange,
  TIMELINE_MINIMAP_TARGET_OFFSET,
} from './timelineMinimapLogic'
import { forwardWheelToTimeline } from './timelineMinimapWheel'
import { WorkLogRow } from './WorkLog'
import { resolveListMarkerSansEm } from './listMarker'
import type { ConversationTimelineRow } from './useConversationThread'
import './conversation-timeline-work.css'
import './conversation-timeline.css'

const FOLLOW_THRESHOLD_PX = 40
const SCROLL_RESTORE_STORAGE_PREFIX = 'crux.conversation.readPosition.'
const MAX_RESTORE_PAGES = 12
const ROW_SELECTOR = '[data-conversation-row-id]'
const visiblePosition = { data: true, size: true }
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

export interface ConversationTimelineProps extends TimelineMessageActions {
  readonly threadId: string
  readonly rows: readonly ConversationTimelineRow[]
  readonly working: boolean
  readonly workingLabel?: string
  /** Wall-clock start of the active run so the working line can count up like T3. */
  readonly workingStartedAt?: string | null
  readonly hasOlderHistory: boolean
  readonly loadingEarlier: boolean
  readonly onLoadEarlier: () => void
  readonly onOpenRelatedThread?: (tab: ConversationThreadTab) => void
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
  const { top, bottom } = scroll.getBoundingClientRect()
  let position: ReadingPosition | undefined
  for (const row of scroll.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const box = row.getBoundingClientRect()
    const anchorId = row.dataset.conversationRowId
    const offset = box.top - top
    if (anchorId && box.bottom > top && box.top < bottom && (!position || offset < position.offset)) position = { anchorId, offset }
  }
  return position
}

function restoreAnchor(scroll: HTMLElement, position: ReadingPosition): boolean {
  const anchor = scroll.querySelector<HTMLElement>(`[data-conversation-row-id="${CSS.escape(position.anchorId)}"]`)
  if (!anchor) return false
  const top = scroll.getBoundingClientRect().top
  scroll.scrollTop += anchor.getBoundingClientRect().top - top - position.offset
  return true
}

function keyExtractor(row: ConversationTimelineRow): string {
  return row.id
}

function getItemType(row: ConversationTimelineRow): string {
  if (row.kind !== 'message') return row.kind
  const lengthBucket = Math.max(0, Math.floor(Math.log2(row.message.text.length / 1000)))
  return lengthBucket < 2
    ? `message:${row.message.role}:${lengthBucket}`
    : `message:${row.message.id}`
}

function setsEqual(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value))
}

export function ConversationTimeline({
  threadId,
  rows,
  working,
  workingLabel = '模型正在回复…',
  workingStartedAt,
  hasOlderHistory,
  loadingEarlier,
  onLoadEarlier,
  onQuote,
  onEdit,
  onOpenRelatedThread,
  onForkFromRun,
  footer,
  emptyTitle,
}: ConversationTimelineProps): JSX.Element {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const [follow, setFollow] = useState(() => loadReadingPosition(threadId)?.atEnd !== false)
  const [minimapGutter, setMinimapGutter] = useState(false)
  const [minimapHitWidth, setMinimapHitWidth] = useState(0)
  const [minimapCurrent, setMinimapCurrent] = useState<number | null>(null)
  const [minimapInView, setMinimapInView] = useState<ReadonlySet<number>>(() => new Set())
  const [minimapAtEnd, setMinimapAtEnd] = useState(true)
  const listRef = useRef<LegendListRef>(null)
  const restoring = useRef<ReadingPosition | null>(null)
  const seeking = useRef<ReadingPosition | null>(null)
  const restorePages = useRef(0)
  const restoreThrough = useRef<string | undefined>()
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows])
  const minimapRowIndices = useMemo(() => minimapItems.map(item => item.rowIndex), [minimapItems])

  const refreshMinimap = useCallback((): void => {
    const state = listRef.current?.getState?.()
    if (restoring.current || seeking.current || !state || state.data !== rows || minimapItems.length === 0) return
    const viewport = listRef.current?.getScrollableNode() ?? undefined
    const firstIndex = state.startBuffered
    const firstRow = firstIndex == null ? undefined : state.elementAtIndex(firstIndex)
    const firstTop = firstIndex == null ? undefined : state.positionAtIndex(firstIndex)
    // Cached row positions exclude the header and pending scroll adjustments.
    const scroll = firstRow && viewport && firstTop !== undefined
      ? firstTop + viewport.getBoundingClientRect().top - firstRow.getBoundingClientRect().top
      : state.scroll
    const visible = resolveTimelineMinimapVisibleRange({ ...state, scroll })
    const next = new Set<number>()
    for (const [index, item] of minimapItems.entries()) {
      if (isTimelineMinimapTurnVisible(item.rowIndex, minimapItems[index + 1]?.rowIndex, visible.start, visible.end)) {
        next.add(item.rowIndex)
      }
    }
    setMinimapInView(current => setsEqual(current, next) ? current : next)
    // Ignore rows ending within the offset the navigation leaves above its target.
    const inset = TIMELINE_MINIMAP_TARGET_OFFSET + 1
    const currentRange = resolveTimelineMinimapVisibleRange({
      ...state, scroll: scroll + inset, scrollLength: state.scrollLength - inset,
    })
    const nextCurrent = resolveTimelineMinimapCurrentIndex({
      visibleStart: currentRange.start, visibleEnd: currentRange.end, rowIndices: minimapRowIndices,
    })
    setMinimapCurrent(current => current === nextCurrent ? current : nextCurrent)
    setMinimapAtEnd(viewport !== undefined &&
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1)
  }, [minimapItems, minimapRowIndices, rows])

  const minimapFrame = useRef<number | null>(null)
  const scheduleMinimapRefresh = useCallback((): void => {
    if (minimapFrame.current !== null) return
    // LegendList recycles row containers before React commits their positions.
    minimapFrame.current = requestAnimationFrame(() => {
      minimapFrame.current = null
      refreshMinimap()
    })
  }, [refreshMinimap])

  useEffect(() => () => {
    if (minimapFrame.current !== null) cancelAnimationFrame(minimapFrame.current)
  }, [])

  const measureGutter = useCallback((viewport: HTMLElement): void => {
    const marker = resolveListMarkerSansEm(getComputedStyle(viewport).fontFamily)
    if (marker) viewport.style.setProperty('--list-marker-sans', marker)
    const viewportWidth = viewport.getBoundingClientRect().width
    const contentWidth = viewport.querySelector<HTMLElement>('[data-timeline-root]')?.getBoundingClientRect().width
      ?? viewportWidth
    setMinimapGutter(resolveTimelineMinimapHasPersistentGutter(viewportWidth, contentWidth))
    setMinimapHitWidth(resolveTimelineMinimapHitStripWidth(viewportWidth, contentWidth))
  }, [])

  useLayoutEffect(() => {
    if (!scrollElement) return
    measureGutter(scrollElement)
    if (!restoring.current) scheduleMinimapRefresh()
    let frame: number | undefined
    const observer = new ResizeObserver(() => {
      // Measure on the next frame: reading layout inside the observer callback re-enters it.
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = undefined
        measureGutter(scrollElement)
        scheduleMinimapRefresh()
      })
    })
    observer.observe(scrollElement)
    return () => {
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [scrollElement, rows, measureGutter, scheduleMinimapRefresh])

  useLayoutEffect(() => {
    const remembered = loadReadingPosition(threadId)
    restoring.current = remembered && !remembered.atEnd ? remembered : null
    setFollow(restoring.current === null)
    restorePages.current = 0
    restoreThrough.current = undefined
    return () => { restoring.current = null; seeking.current = null }
  }, [threadId])

  function restoreReadingPosition(): void {
    const position = restoring.current
    if (!position || !scrollElement || !listRef.current || seeking.current) return
    const index = rows.findIndex(row => row.id === position.anchorId)
    if (index < 0) {
      if (!hasOlderHistory || restorePages.current >= MAX_RESTORE_PAGES) restoring.current = null
      return
    }
    if (restoreAnchor(scrollElement, position)) {
      restoring.current = null
      return
    }
    seeking.current = position
    void listRef.current.scrollToIndex({ index, viewOffset: position.offset, animated: false }).then(() => {
      if (restoring.current !== position) return
      restoreAnchor(scrollElement, position)
    }).finally(() => {
      if (seeking.current === position) seeking.current = null
      if (restoring.current === position) restoring.current = null
    }).catch(() => undefined)
  }

  useEffect(() => {
    const earliestRow = rows[0]?.id
    restoreReadingPosition()
    if (!restoring.current || seeking.current || !earliestRow || loadingEarlier || !hasOlderHistory ||
      restoreThrough.current === earliestRow || restorePages.current >= MAX_RESTORE_PAGES) return
    restoreThrough.current = earliestRow
    restorePages.current += 1
    onLoadEarlier()
  }, [threadId, rows, loadingEarlier, hasOlderHistory, onLoadEarlier, scrollElement])

  const releaseFollow = (): void => {
    if (follow || restoring.current) listRef.current?.cancelScroll()
    restoring.current = null
    setFollow(false)
  }

  const loadEarlier = (): void => {
    releaseFollow()
    onLoadEarlier()
  }

  useEffect(() => {
    if (!scrollElement) return
    let frame: number | undefined
    const save = (retry: boolean): void => {
      frame = undefined
      if (restoring.current) return
      const distance = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight
      const position = visibleAnchor(scrollElement)
      if (position) saveReadingPosition(threadId, { ...position, atEnd: distance < FOLLOW_THRESHOLD_PX })
      else if (retry) frame = requestAnimationFrame(() => save(false))
    }
    const onScroll = (): void => {
      if (restoring.current) return
      const distance = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight
      setFollow(distance < FOLLOW_THRESHOLD_PX)
      scheduleMinimapRefresh()
      if (frame === undefined) frame = requestAnimationFrame(() => save(true))
    }
    scrollElement.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scrollElement.removeEventListener('scroll', onScroll)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [threadId, scrollElement, scheduleMinimapRefresh])

  return (
    <div
      ref={setScrollElement}
      className="acp-transcript my-scrollbar conversation-timeline"
      aria-label="消息记录"
      tabIndex={0}
      data-following-end={follow ? 'true' : 'false'}
      onWheel={event => { if (event.deltaY < 0) releaseFollow() }}
      onTouchMove={releaseFollow}
      onKeyDown={event => {
        if (event.target === event.currentTarget && ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) releaseFollow()
      }}
    >
      <div className="my-conversation-column acp-transcript-content conversation-timeline-content" data-timeline-root>
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
        {rows.length > 0 && <LegendList<ConversationTimelineRow>
          key={threadId}
          ref={listRef}
          scrollElement={scrollElement}
          data={rows}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          estimatedItemSize={90}
          initialScrollAtEnd={follow}
          maintainScrollAtEnd={follow}
          maintainScrollAtEndThreshold={1}
          maintainVisibleContentPosition={visiblePosition}
          onScroll={scheduleMinimapRefresh}
          onItemSizeChanged={scheduleMinimapRefresh}
          onReady={restoreReadingPosition}
          renderItem={({ item }) => <div data-conversation-row-id={item.id} data-timeline-row-kind={item.kind}>
            <ConversationRow row={item} onQuote={onQuote} onEdit={onEdit}
              onOpenRelatedThread={onOpenRelatedThread} onForkFromRun={onForkFromRun} />
          </div>}
        />}
        {working && <WorkingTimelineRow startedAt={workingStartedAt ?? undefined}
          label={workingStartedAt ? undefined : workingLabel} />}
        {footer}
      </div>
      <TimelineMinimap
        items={minimapItems}
        hasPersistentGutter={minimapGutter}
        hitStripWidth={minimapHitWidth}
        currentIndex={minimapCurrent}
        atEnd={minimapAtEnd}
        inViewRowIndices={minimapInView}
        onWheel={event => { if (scrollElement) forwardWheelToTimeline(event, scrollElement) }}
        onSelect={item => {
          releaseFollow()
          void listRef.current?.scrollToIndex({
            index: item.rowIndex,
            animated: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            viewOffset: TIMELINE_MINIMAP_TARGET_OFFSET,
          })
        }}
      />
    </div>
  )
}

function ConversationRow({
  row,
  onQuote,
  onEdit,
  onOpenRelatedThread,
  onForkFromRun,
}: {
  readonly row: ConversationTimelineRow
  readonly onQuote?: ConversationTimelineProps['onQuote']
  readonly onEdit?: ConversationTimelineProps['onEdit']
  readonly onOpenRelatedThread?: ConversationTimelineProps['onOpenRelatedThread']
  readonly onForkFromRun?: ConversationTimelineProps['onForkFromRun']
}): JSX.Element {
  if (row.kind === 'relation') return <ConversationTimelineRelationRow item={row.item} onOpenRelatedThread={onOpenRelatedThread} />
  if (row.kind === 'file-change') return <ConversationTurnFileChange item={row.item} />
  if (row.kind === 'work') {
    const { label, icon: Icon } = WORK_STATUS[row.state]
    return (
      <WorkLogRow
        data-state={row.state}
        role="group"
        aria-label={`${row.text}，${label}`}
        label={row.text}
        icon={<Icon size={14} aria-hidden="true" className={row.state === 'running' ? 'animate-spin motion-reduce:animate-none' : undefined} />}
        wrapLabel
      />
    )
  }
  if (row.kind === 'plan') {
    const item = row.item
    return (
      <details className="conversation-timeline-plan">
        <summary className="my-item-title">
          <ListChecks size={15} aria-hidden="true" />
          {item.type === 'proposed_plan' ? '计划建议' : '计划'}
          <ChevronRight className="conversation-timeline-plan-arrow" size={14} aria-hidden="true" />
        </summary>
        <div className="conversation-timeline-plan-content">
          {item.type === 'proposed_plan' ? (
            <div className="conversation-message-body"><ChatMarkdown text={item.markdown} /></div>
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
  return row.message.role === 'user'
    ? <UserMessageRow row={row} onQuote={onQuote} onEdit={onEdit} />
    : <AssistantTimelineRow row={row} onQuote={onQuote} onForkFromRun={onForkFromRun} />
}
