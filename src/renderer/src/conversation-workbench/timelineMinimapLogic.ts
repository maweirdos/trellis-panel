import type { ConversationTimelineRow } from './useConversationThread'

/**
 * Ported from t3code@28c58b1 apps/web/src/components/chat:
 * timelineMinimapItems.ts and the resolveTimelineMinimap* helpers in
 * MessagesTimeline.logic.ts. One strip per user turn; the final assistant text
 * of that turn is the hover preview.
 */
export interface TimelineMinimapItem {
  readonly id: string
  readonly rowIndex: number
  readonly userText: string | null
  readonly assistantText: string | null
}

export const TIMELINE_MINIMAP_MIN_ITEMS = 2
export const TIMELINE_MINIMAP_TARGET_OFFSET = 24
const ITEM_SPACING = 8
const MAX_HEIGHT_CSS = 'max(4rem, calc(100% - 14.75rem))'
const PERSISTENT_GUTTER = 48
const HIT_STRIP_LEFT = 12
const HIT_STRIP_MAX_WIDTH = 40
const NAVIGATION_REACH = 14

export function deriveTimelineMinimapItems(rows: readonly ConversationTimelineRow[]): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row?.kind !== 'message' || row.message.role !== 'user') continue
    items.push({
      id: row.id,
      rowIndex: index,
      userText: plainText(row.message.text),
      assistantText: finalAssistantText(rows, index),
    })
  }
  return items
}

function finalAssistantText(rows: readonly ConversationTimelineRow[], userRowIndex: number): string | null {
  let text: string | null = null
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index]
    if (row?.kind !== 'message') continue
    if (row.message.role === 'user') break
    if (row.message.role === 'assistant') text = row.message.text
  }
  return text === null ? null : plainText(text)
}

/** Markdown reduced to the text it renders, bounded for long or streaming replies. */
function plainText(markdown: string): string | null {
  const compact = markdown
    .slice(0, 1500)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return compact.length > 0 ? compact : null
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const natural = Math.max(1, (itemCount - 1) * ITEM_SPACING)
  return `min(${natural}px, ${MAX_HEIGHT_CSS})`
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) return 0
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number
  readonly railTop: number
  readonly railHeight: number
  readonly pointerY: number
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) return null
  if (input.itemCount === 1) return 0
  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight))
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))))
}

/** Recheck the rendered buffer: LegendList's unbuffered range can lag while scrolling. */
export function resolveTimelineMinimapVisibleRange(state: {
  readonly startBuffered: number | null | undefined
  readonly endBuffered: number | null | undefined
  readonly scroll: number
  readonly scrollLength: number
  readonly positionAtIndex: (index: number) => number
  readonly sizeAtIndex: (index: number) => number
}): { start: number | null; end: number | null } {
  let start: number | null = null
  let end: number | null = null
  if (state.startBuffered == null || state.endBuffered == null || state.startBuffered < 0) return { start, end }
  const bottom = state.scroll + state.scrollLength
  for (let index = state.startBuffered; index <= state.endBuffered; index += 1) {
    const top = state.positionAtIndex(index)
    const height = state.sizeAtIndex(index)
    if (top < bottom && top + Math.max(1, height > 0 ? height : 1) > state.scroll) {
      start ??= index
      end = index
    }
  }
  return { start, end }
}

/** A turn spans its user message up to the next, so a long reply keeps its strip lit. */
export function isTimelineMinimapTurnVisible(
  turnStartRowIndex: number,
  nextTurnStartRowIndex: number | undefined,
  visibleStart: number | null | undefined,
  visibleEnd: number | null | undefined,
): boolean {
  return visibleStart != null && visibleEnd != null &&
    turnStartRowIndex <= visibleEnd &&
    (nextTurnStartRowIndex === undefined || nextTurnStartRowIndex > visibleStart)
}

export function resolveTimelineMinimapCurrentIndex(input: {
  readonly visibleStart: number | null | undefined
  readonly visibleEnd: number | null | undefined
  readonly rowIndices: readonly number[]
}): number | null {
  if (input.visibleStart == null || input.visibleEnd == null) return null
  let precedingIndex: number | null = null
  for (const [index, rowIndex] of input.rowIndices.entries()) {
    if (rowIndex >= input.visibleStart) return rowIndex <= input.visibleEnd ? index : precedingIndex
    precedingIndex = index
  }
  return precedingIndex
}

function sideGutter(viewportWidth: number, contentWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(contentWidth)) return 0
  return Math.max(0, (viewportWidth - Math.min(viewportWidth, contentWidth)) / 2)
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number, contentWidth: number): boolean {
  return sideGutter(viewportWidth, contentWidth) >= PERSISTENT_GUTTER
}

export function resolveTimelineMinimapHitStripWidth(viewportWidth: number, contentWidth: number): number {
  return Math.max(0, Math.min(HIT_STRIP_MAX_WIDTH, Math.floor(sideGutter(viewportWidth, contentWidth)) - HIT_STRIP_LEFT))
}

export function resolveTimelineMinimapNavigationInteractive(collapsedWidth: number): boolean {
  return collapsedWidth >= NAVIGATION_REACH
}
