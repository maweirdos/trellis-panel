import { diffWordsWithSpace } from 'diff'
import type { JSX } from 'react'

export type InlineDiffSegment = {
  text: string
  changed: boolean
}

export type InlineDiffLineInput = {
  kind: 'add' | 'remove' | 'other'
  text: string
}

const MAX_INLINE_DIFF_LENGTH = 800
const MAX_INLINE_DIFF_PAIRS = 120

function coalesceSegments(segments: InlineDiffSegment[]): InlineDiffSegment[] {
  const merged: InlineDiffSegment[] = []
  for (const segment of segments) {
    if (!segment.text) continue
    const last = merged.at(-1)
    if (last && last.changed === segment.changed) {
      last.text += segment.text
    } else {
      merged.push({ ...segment })
    }
  }
  return merged
}

/**
 * Compute word-level inline diff segments for contiguous remove/add pairs
 * so code and document diffs can highlight exact changed tokens inside lines.
 */
export function computeInlineLineDiffs<T extends InlineDiffLineInput>(
  items: readonly T[]
): Array<InlineDiffSegment[] | undefined> {
  const result: Array<InlineDiffSegment[] | undefined> = new Array(items.length).fill(undefined)
  let index = 0
  let totalPairs = 0

  while (index < items.length) {
    if (items[index].kind !== 'remove') {
      index += 1
      continue
    }
    const removeStart = index
    while (index < items.length && items[index].kind === 'remove') index += 1
    const removeEnd = index

    const addStart = index
    while (index < items.length && items[index].kind === 'add') index += 1
    const addEnd = index

    const pairCount = Math.min(removeEnd - removeStart, addEnd - addStart)
    for (let offset = 0; offset < pairCount; offset += 1) {
      if (totalPairs >= MAX_INLINE_DIFF_PAIRS) return result
      const oldText = items[removeStart + offset].text
      const newText = items[addStart + offset].text
      if (!oldText || !newText) continue
      if (oldText.length > MAX_INLINE_DIFF_LENGTH || newText.length > MAX_INLINE_DIFF_LENGTH) continue
      totalPairs += 1

      const parts = diffWordsWithSpace(oldText, newText)
      const removedSegments: InlineDiffSegment[] = []
      const addedSegments: InlineDiffSegment[] = []

      for (const part of parts) {
        if (!part.added) {
          removedSegments.push({ text: part.value, changed: Boolean(part.removed) })
        }
        if (!part.removed) {
          addedSegments.push({ text: part.value, changed: Boolean(part.added) })
        }
      }

      const mergedRemoved = coalesceSegments(removedSegments)
      const mergedAdded = coalesceSegments(addedSegments)
      if (mergedRemoved.some((segment) => segment.changed)) {
        result[removeStart + offset] = mergedRemoved
      }
      if (mergedAdded.some((segment) => segment.changed)) {
        result[addStart + offset] = mergedAdded
      }
    }
  }

  return result
}

export function InlineDiffText({
  segments,
  fallback,
  tone
}: {
  segments: InlineDiffSegment[] | undefined
  fallback: string
  tone: 'add' | 'remove'
}): JSX.Element {
  if (!segments) return <>{fallback}</>
  const markClass = tone === 'add' ? 'my-diff-token my-diff-token-add' : 'my-diff-token my-diff-token-remove'
  return (
    <>
      {segments.map((segment, index) =>
        segment.changed ? (
          <mark key={index} className={markClass}>
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  )
}
