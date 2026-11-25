import { useMemo, type JSX } from 'react'
import { computeInlineLineDiffs, InlineDiffText } from './inline-diff'
import { patchRows } from './patch'

type TextDiff = { diff: string; added: number; removed: number; binary: boolean; truncated: boolean }

export function UnifiedDiff({ value }: { value: TextDiff }): JSX.Element {
  const { rows, inlineSegments } = useMemo(() => {
    const parsed = patchRows(value.diff)
    const segments = computeInlineLineDiffs(
      parsed.map((row) => ({
        kind: row.kind === 'add' ? 'add' : row.kind === 'remove' ? 'remove' : 'other',
        text: row.kind === 'add' || row.kind === 'remove' ? row.text.slice(1) : row.text
      }))
    )
    return { rows: parsed, inlineSegments: segments }
  }, [value.diff])

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-my-2xs tabular-nums">
        {value.binary ? (
          <span className="text-my-tertiary">二进制文件，不展示文本差异</span>
        ) : (
          <>
            <span className="rounded-my-full bg-my-success-subtle px-1.5 py-0.5 text-my-success-text">+{value.added}</span>
            <span className="rounded-my-full bg-my-danger-subtle px-1.5 py-0.5 text-my-danger-text">−{value.removed}</span>
          </>
        )}
      </div>
      {value.truncated && <p className="mb-2 text-my-xs text-my-warning-text" role="status">差异达到读取上限，以下内容不完整。</p>}
      {!value.binary && (rows.length > 0 ? (
        <div className="my-git-diff my-scrollbar" tabIndex={0} role="region" aria-label="文本差异，左侧为原行号，右侧为新行号">
          <div className="my-git-diff-content">
            {rows.map((row, i) => {
              const prefix = row.kind === 'add' || row.kind === 'remove' ? row.text.slice(0, 1) : ''
              const content = prefix ? row.text.slice(1) : row.text
              const segments = inlineSegments[i]
              return (
                <div key={i} className={`my-git-diff-row my-git-diff-${row.kind}`}>
                  <span className="my-git-line-number" aria-label={row.a === null ? undefined : `原行 ${row.a}`}>{row.a}</span>
                  <span className="my-git-line-number" aria-label={row.b === null ? undefined : `新行 ${row.b}`}>{row.b}</span>
                  <code>
                    {prefix}
                    {row.kind === 'add' || row.kind === 'remove' ? (
                      <InlineDiffText segments={segments} fallback={content || ' '} tone={row.kind} />
                    ) : (
                      row.text || ' '
                    )}
                  </code>
                </div>
              )
            })}
          </div>
        </div>
      ) : <p className="text-my-sm text-my-tertiary">无文本差异内容（可能仅文件名、权限或类型发生变化）。</p>)}
    </div>
  )
}
