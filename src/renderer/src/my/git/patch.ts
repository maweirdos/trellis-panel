/**
 * Adapted from oil-git src/patch.ts, commit 9e6abfabe63503b5122b1762a8902ecefe9473fc.
 * Copyright (c) 2026 Zhihuang Lin (oil-oil), MIT.
 * Source: https://github.com/oil-oil/oil-git
 * License: resources/licenses/oil-git.txt in this distribution.
 */
export type PatchRow = {
  text: string
  kind: 'meta' | 'hunk' | 'add' | 'remove' | 'context'
  a: number | null
  b: number | null
}

/** Parse ordinary unified hunks. Merge commits are supplied as first-parent diffs. */
export function patchRows(patch: string): PatchRow[] {
  let old = 0
  let next = 0
  let isHunk = false
  const lines = patch.split('\n')
  // The delimiter after the last complete line is not another patch row.
  if (lines.at(-1) === '') lines.pop()
  return lines.map((text): PatchRow => {
    let kind: PatchRow['kind'] = 'meta'
    let a: number | null = null
    let b: number | null = null
    const match = text.match(/^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@/)
    if (text.startsWith('diff ') || text.startsWith('@@@')) {
      isHunk = false
    } else if (match) {
      old = Number(match[1])
      next = Number(match[2])
      isHunk = true
      kind = 'hunk'
    } else if (isHunk && text.startsWith('+')) {
      kind = 'add'
      b = next++
    } else if (isHunk && text.startsWith('-')) {
      kind = 'remove'
      a = old++
    } else if (isHunk && text.startsWith(' ')) {
      kind = 'context'
      a = old++
      b = next++
    }
    return { text, kind, a, b }
  })
}
