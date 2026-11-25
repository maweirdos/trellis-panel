import { ChevronRight, FileCode2 } from 'lucide-react'
import type { ConversationProjectedWorkItem } from '../../../shared/conversation/command-runtime'
import { patchRows } from '../my/git/patch'
import { UnifiedDiff } from '../my/git/UnifiedDiff'

export function ConversationTurnFileChange({ item }: {
  readonly item: Extract<ConversationProjectedWorkItem, { readonly type: 'file_change' }>
}) {
  const paths = item.changes?.map(change => change.path) ?? [item.fileName]
  const rows = item.diffStr ? patchRows(item.diffStr) : []
  const added = rows.filter(row => row.kind === 'add').length
  const removed = rows.filter(row => row.kind === 'remove').length
  return <details className="conversation-turn-files">
    <summary>
      <FileCode2 size={15} aria-hidden="true" />
      <span>{paths.length === 1 ? paths[0] : `${paths.length} 个文件已更改`}</span>
      {item.diffStr && <span className="conversation-turn-file-stats" role="group" aria-label={`新增 ${added} 行，删除 ${removed} 行`}>
        <span aria-hidden="true">+{added}</span><span aria-hidden="true">−{removed}</span>
      </span>}
      <ChevronRight size={14} className="conversation-timeline-plan-arrow" aria-hidden="true" />
    </summary>
    <div className="conversation-turn-files-content">
      {paths.length > 1 && <ul>{paths.map((path, index) => <li key={`${path}:${index}`}>{path}</li>)}</ul>}
      {item.diffStr
        ? <UnifiedDiff value={{ diff: item.diffStr, added, removed, binary: false, truncated: false }} />
        : <p className="my-item-description">此回合未保留文本差异。</p>}
    </div>
  </details>
}
