import { useId, useMemo, type JSX } from 'react'
import type { ConversationProjectedWorkItem } from '../../../shared/conversation/command-runtime'
import { patchRows, type PatchRow } from '../my/git/patch'

type FileChangeItem = Extract<ConversationProjectedWorkItem, { readonly type: 'file_change' }>

/** Upstream hides the patch envelope and the `@@` hunk headers; only lines are shown. */
function visibleRows(rows: readonly PatchRow[]): PatchRow[] {
  return rows.filter(row => row.kind !== 'meta' && row.kind !== 'hunk')
}

/**
 * Ported from t3code@28c58b1 apps/web/src/components/chat: a turn's file change
 * reads as one header row (file glyph, path, red/green line counts) followed by the
 * changed lines themselves. Nothing is collapsed behind a disclosure.
 */
export function ConversationTurnFileChange({ item }: { readonly item: FileChangeItem }): JSX.Element {
  const labelId = useId()
  const paths = item.changes?.map(change => change.path) ?? [item.fileName]
  const rows = useMemo(() => (item.diffStr ? visibleRows(patchRows(item.diffStr)) : []), [item.diffStr])
  const added = rows.filter(row => row.kind === 'add').length
  const removed = rows.filter(row => row.kind === 'remove').length
  const title = paths.length === 1 ? paths[0] : `${paths.length} 个文件已更改`
  return (
    <section className="conversation-turn-file" aria-labelledby={labelId}>
      <div className="conversation-turn-file-header">
        <span className="conversation-turn-file-glyph" aria-hidden="true" />
        <span id={labelId} className="conversation-turn-file-path" title={paths.length > 1 ? paths.join('\n') : undefined}>
          {title}
        </span>
        {item.diffStr && <span className="conversation-turn-file-stats" role="group" aria-label={`新增 ${added} 行，删除 ${removed} 行`}>
          <span data-kind="remove" aria-hidden="true">-{removed}</span>
          <span data-kind="add" aria-hidden="true">+{added}</span>
        </span>}
      </div>
      {item.diffStr
        ? (rows.length > 0
          ? <div className="conversation-turn-file-diff" tabIndex={0} role="region" aria-label="文件差异，左侧为原行号，右侧为新行号">
              {rows.map((row, index) => (
                <div key={index} className="conversation-turn-file-line" data-kind={row.kind}>
                  <span className="conversation-turn-file-gutter" aria-hidden="true">{row.a ?? row.b ?? ''}</span>
                  <code>{row.text.slice(1) || ' '}</code>
                </div>
              ))}
            </div>
          : <p className="my-item-description">此回合未保留文本差异。</p>)
        : <p className="my-item-description">此回合未保留文本差异。</p>}
    </section>
  )
}
