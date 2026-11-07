import type { JSX } from 'react'
import { ArrowUpRight, Link2, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '../my/ui'
import { useCrux } from '../crux/store'
import { useCreationList } from './hooks'
import { openCreation, type CreationLocation } from './navigation'
import './creation-workspace.css'

export function TaskCreationReferences({ taskId, spaceId, onOpen }: {
  taskId: string; spaceId: string; onOpen?: (location: CreationLocation) => void
}): JSX.Element {
  const context = useCrux((state) => state.workspaceContext)
  const { data, error, busy, refresh, loadMore } = useCreationList({ scope: 'team', taskId, spaceId })
  const references = data?.items.flatMap((creation) => {
    const adoption = creation.adoptions.filter((entry) => entry.taskId === taskId).at(-1)
    return adoption ? [{ creation, adoption }] : []
  }) ?? []
  return <section className="creation-task-references" aria-label="采用的创作">
    <div className="creation-section-heading"><h3><Link2 size={14} />创作引用</h3>{busy && <Loader2 size={13} className="creation-spinner" aria-label="正在读取引用" />}</div>
    {error && <div className="creation-error" role="alert"><span className="creation-grow">{error.error}</span><Button size="sm" variant="ghost" onClick={() => void refresh()}><RefreshCw size={13} />重试</Button></div>}
    {data && !error && references.length === 0 && <p className="creation-meta">暂无已采用的创作</p>}
    {references.map(({ creation, adoption }) => <Button key={adoption.adoptionId} variant="ghost" size="sm" className="creation-task-reference" disabled={!context.actorId} onClick={() => {
      if (!context.actorId) return
      const location: CreationLocation = { workspaceKey: context.key, actorId: context.actorId, creationId: creation.creationId, revisionId: adoption.revisionId, scope: 'team', spaceId }
      if (onOpen) onOpen(location)
      else openCreation(location)
    }}><span className="creation-truncate creation-grow">{adoption.title}</span><span className="my-chip">R{adoption.revisionNumber}</span><span className="creation-meta">{adoption.confirmedRules.length} 条规则</span><ArrowUpRight size={13} /></Button>)}
    {data?.hasMore && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void loadMore()}>加载更多创作引用</Button>}
  </section>
}
