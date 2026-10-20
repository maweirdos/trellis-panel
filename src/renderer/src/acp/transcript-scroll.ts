interface RowAnchor { key: string; top: number; bottom: number; text: string }
interface TextAnchor { row: RowAnchor; offset: number; context: string; contextOffset: number; top: number }
export interface TranscriptScrollAnchor {
  rows: RowAnchor[]
  text?: TextAnchor
  scrollHeight: number
}

const rowsIn = (stream: HTMLElement): Element[] => [...stream.querySelectorAll('[data-acp-item]')]

function characterRange(row: Element, offset: number): Range | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode(), remaining = offset
  while (node) {
    const length = node.textContent?.length ?? 0
    if (length > 0 && remaining <= length) {
      const range = document.createRange()
      range.setStart(node, Math.min(remaining, length))
      range.setEnd(node, Math.min(remaining + 1, length))
      return range
    }
    remaining -= length
    node = walker.nextNode()
  }
  return null
}

function textRange(row: Element, needle: string, offset: number): Range | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const value = node.textContent ?? '', at = value.indexOf(needle)
    if (at >= 0 && at + offset <= value.length) {
      const range = document.createRange()
      range.setStart(node, at + offset)
      range.setEnd(node, Math.min(at + offset + 1, value.length))
      return range
    }
    node = walker.nextNode()
  }
  return null
}

/** A text witness survives Markdown row replacement and prefix/append merging. */
export function captureTranscriptAnchor(stream: HTMLElement): TranscriptScrollAnchor {
  const viewport = stream.getBoundingClientRect()
  const elements = rowsIn(stream).filter((row) => row.getBoundingClientRect().bottom > viewport.top).slice(0, 4)
  const rows = elements.map((row) => {
    const rect = row.getBoundingClientRect()
    return { key: row.getAttribute('data-acp-item') ?? '', top: rect.top, bottom: rect.bottom, text: row.textContent ?? '' }
  })
  const anchor: TranscriptScrollAnchor = { rows, scrollHeight: stream.scrollHeight }
  const row = elements[0]
  if (!row) return anchor
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    if (node.textContent?.trim()) {
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = [...range.getClientRects()].find((line) => line.height > 0 && line.bottom > viewport.top + 1 && line.top < viewport.bottom)
      if (rect) {
        const caret = document.caretRangeFromPoint(Math.max(viewport.left + 2, rect.left + 2), Math.min(viewport.bottom - 2, Math.max(viewport.top + 2, rect.top + rect.height / 2)))
        if (caret && row.contains(caret.startContainer)) {
          const localText = caret.startContainer.nodeType === Node.TEXT_NODE ? caret.startContainer.textContent ?? '' : ''
          const localOffset = caret.startContainer.nodeType === Node.TEXT_NODE ? caret.startOffset : 0
          const contextStart = Math.max(0, localOffset - 48)
          const context = localText.slice(contextStart, localOffset + 96)
          const witness = localText && context ? textRange(row, context, localOffset - contextStart) : null
          if (witness) {
            const nodes = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
            let current = nodes.nextNode(), offset = localOffset
            while (current && current !== caret.startContainer) { offset += current.textContent?.length ?? 0; current = nodes.nextNode() }
            anchor.text = { row: rows[0], offset, context, contextOffset: localOffset - contextStart, top: witness.getBoundingClientRect().top }
            return anchor
          }
        }
      }
    }
    node = walker.nextNode()
  }
  return anchor
}

export function restoreTranscriptAnchor(stream: HTMLElement, anchor: TranscriptScrollAnchor): void {
  const elements = rowsIn(stream)
  const text = anchor.text
  if (text) {
    const keyed = elements.find((row) => row.getAttribute('data-acp-item') === text.row.key)
    const rowsWithText = (needle: string): Array<{ row: Element; offset: number }> => elements.flatMap((row) => {
      const content = row.textContent ?? '', offset = content.indexOf(needle)
      if (offset < 0) return []
      const duplicate = content.indexOf(needle, offset + needle.length)
      return duplicate < 0 ? [{ row, offset }] : [{ row, offset }, { row, offset: duplicate }]
    })
    const fullMatches = rowsWithText(text.row.text)
    const contextMatches = rowsWithText(text.context)
    const keyedOffset = keyed ? (keyed.textContent ?? '').indexOf(text.row.text) : -1
    const fullMatch = keyed && keyedOffset >= 0 ? { row: keyed, offset: keyedOffset } : fullMatches.length === 1 ? fullMatches[0] : undefined
    const candidate = fullMatch ? { row: fullMatch.row, offset: fullMatch.offset + text.offset } : contextMatches.length === 1 ? { row: contextMatches[0].row, offset: contextMatches[0].offset + text.contextOffset } : undefined
    if (candidate && candidate.offset >= 0) {
      const witness = textRange(candidate.row, text.context, text.contextOffset) ?? characterRange(candidate.row, candidate.offset)
      if (witness) { stream.scrollTop += witness.getBoundingClientRect().top - text.top; return }
    }
  }
  // Stable following rows keep image/tool boundaries usable without retaining
  // detached DOM elements. Exclude changed rows from the top-edge fallback.
  for (const old of anchor.rows) {
    const row = elements.find((candidate) => candidate.getAttribute('data-acp-item') === old.key && candidate.textContent === old.text)
    if (row) { stream.scrollTop += row.getBoundingClientRect().top - old.top; return }
  }
  const merged = anchor.rows[0] && elements.find((row) => row.getAttribute('data-acp-item') === anchor.rows[0].key)
  stream.scrollTop += merged ? merged.getBoundingClientRect().bottom - anchor.rows[0].bottom : stream.scrollHeight - anchor.scrollHeight
}
