const HIGHLIGHT_ALL_KEY = 'crux-thread-find'
const HIGHLIGHT_ACTIVE_KEY = 'crux-thread-find-active'
const MAX_HIGHLIGHT_RANGES = 400

function supportsCustomHighlights(): boolean {
  return (
    typeof window !== 'undefined'
    && typeof Highlight !== 'undefined'
    && typeof CSS !== 'undefined'
    && 'highlights' in CSS
    && CSS.highlights !== undefined
  )
}

function isSkippableTextNode(node: Text): boolean {
  const parent = node.parentElement
  if (!parent) return true
  if (parent.closest('button, input, textarea, select, script, style, .sr-only, .conversation-sr-only, [aria-hidden="true"]')) {
    return true
  }
  return false
}

export function clearThreadFindHighlights(): void {
  if (!supportsCustomHighlights()) return
  CSS.highlights.delete(HIGHLIGHT_ALL_KEY)
  CSS.highlights.delete(HIGHLIGHT_ACTIVE_KEY)
}

export function collectThreadFindRanges(
  container: HTMLElement,
  query: string,
  activeRowId: string | null,
): { readonly allRanges: Range[]; readonly activeRanges: Range[] } {
  const needle = query.trim().toLowerCase()
  if (!needle) return { allRanges: [], activeRanges: [] }

  const allRanges: Range[] = []
  const activeRanges: Range[] = []
  const rows = container.querySelectorAll<HTMLElement>('[data-conversation-row-id]')

  for (const row of rows) {
    if (allRanges.length + activeRanges.length >= MAX_HIGHLIGHT_RANGES) break
    const isActive = activeRowId !== null && row.dataset.conversationRowId === activeRowId
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    let current = walker.nextNode()
    while (current) {
      if (allRanges.length + activeRanges.length >= MAX_HIGHLIGHT_RANGES) break
      const textNode = current as Text
      const value = textNode.nodeValue
      if (value && !isSkippableTextNode(textNode)) {
        const lower = value.toLowerCase()
        let start = lower.indexOf(needle)
        while (start !== -1 && allRanges.length + activeRanges.length < MAX_HIGHLIGHT_RANGES) {
          const range = document.createRange()
          range.setStart(textNode, start)
          range.setEnd(textNode, start + needle.length)
          if (isActive) activeRanges.push(range)
          else allRanges.push(range)
          start = lower.indexOf(needle, start + needle.length)
        }
      }
      current = walker.nextNode()
    }
  }

  return { allRanges, activeRanges }
}

export function applyThreadFindHighlights(
  container: HTMLElement | null,
  query: string,
  activeRowId: string | null,
): number {
  if (!supportsCustomHighlights()) return 0
  if (!container || !query.trim()) {
    clearThreadFindHighlights()
    return 0
  }
  const { allRanges, activeRanges } = collectThreadFindRanges(container, query, activeRowId)
  if (allRanges.length > 0) CSS.highlights.set(HIGHLIGHT_ALL_KEY, new Highlight(...allRanges))
  else CSS.highlights.delete(HIGHLIGHT_ALL_KEY)
  if (activeRanges.length > 0) CSS.highlights.set(HIGHLIGHT_ACTIVE_KEY, new Highlight(...activeRanges))
  else CSS.highlights.delete(HIGHLIGHT_ACTIVE_KEY)
  return allRanges.length + activeRanges.length
}

/** 自动展开命中的折叠 `<details>` 容器，让查找跳转后的命中词立即可见。 */
export function unfoldRowDetails(container: HTMLElement | null, rowId: string | null): void {
  if (!container || !rowId) return
  const row = container.querySelector<HTMLElement>(`[data-conversation-row-id="${CSS.escape(rowId)}"]`)
  if (!row) return
  for (const details of row.querySelectorAll<HTMLDetailsElement>('details:not([open])')) {
    details.open = true
  }
}
