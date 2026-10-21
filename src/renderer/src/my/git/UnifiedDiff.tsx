import { useMemo, type JSX } from 'react'
import { patchRows } from './patch'

type TextDiff = { diff: string; added: number; removed: number; binary: boolean; truncated: boolean }

export function UnifiedDiff({ value }: { value: TextDiff }): JSX.Element {
  const rows = useMemo(() => patchRows(value.diff), [value.diff])
  return (
    <div className="min-w-0">
      <p className="mb-1 text-my-xs text-my-tertiary">
        {value.binary ? '二进制文件，不展示文本差异' : `+${value.added} / -${value.removed}`}
      </p>
      {value.truncated && <p className="mb-2 text-my-xs text-my-warning-text" role="status">差异达到读取上限，以下内容不完整。</p>}
      {!value.binary && (rows.length > 0 ? (
        <div className="my-git-diff my-scrollbar" tabIndex={0} role="region" aria-label="文本差异，左侧为原行号，右侧为新行号">
          <div className="my-git-diff-content">
            {rows.map((row, i) => (
              <div key={i} className={`my-git-diff-row my-git-diff-${row.kind}`}>
                <span className="my-git-line-number" aria-label={row.a === null ? undefined : `原行 ${row.a}`}>{row.a}</span>
                <span className="my-git-line-number" aria-label={row.b === null ? undefined : `新行 ${row.b}`}>{row.b}</span>
                <code>{row.text || ' '}</code>
              </div>
            ))}
          </div>
        </div>
      ) : <p className="text-my-sm text-my-tertiary">无文本差异内容（可能仅文件名、权限或类型发生变化）。</p>)}
    </div>
  )
}
