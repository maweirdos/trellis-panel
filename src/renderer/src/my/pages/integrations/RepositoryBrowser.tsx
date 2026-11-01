import { useState, type JSX } from 'react'
import type { BindingRequest, ExternalObject, IntegrationBinding, IntegrationConnection, PageResult, RemoteRepository } from '../../../../../shared/integrations'
import { api } from '../../../api'
import { Button } from '../../ui'
import { useIntegrationAction } from './hooks'

export function boundRequest(root: string, binding: IntegrationBinding, connection: IntegrationConnection): BindingRequest {
  return { expectedRoot: root, bindingId: binding.id, bindingRevision: binding.revision, connectionRevision: connection.revision }
}
export function RepositoryBrowser({ root, connection, onSelect }: { root: string; connection: IntegrationConnection; onSelect: (repo: RemoteRepository) => void }): JSX.Element {
  const [page, setPage] = useState<PageResult<RemoteRepository> | null>(null)
  const [filter, setFilter] = useState('')
  const action = useIntegrationAction()
  const load = async (number: number): Promise<void> => {
    const result = await action.run(() => api.integrations.repositories({ expectedRoot: root, connectionId: connection.id, connectionRevision: connection.revision, page: number, query: '' }))
    if (result) setPage(result)
  }
  return <section className="space-y-3 rounded-my-lg border border-my-line p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-my-sm font-medium">选择授权仓库</h3><Button size="sm" disabled={action.busy || !connection.enabled} onClick={() => void load(1)}>加载仓库</Button></div>
    {page && <><input className="my-input w-full" aria-label="筛选本页仓库" placeholder="筛选本页仓库名称" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="divide-y divide-my-line">{page.items.filter((repo) => repo.fullName.toLowerCase().includes(filter.toLowerCase())).map((repo) => <div key={repo.id} className="flex items-center justify-between gap-3 py-2"><span className="my-item-title min-w-0 truncate" title={repo.fullName}>{repo.fullName}</span><Button size="sm" onClick={() => onSelect(repo)}>选择绑定</Button></div>)}</div>
      {page.items.length === 0 && <p className="my-item-description">此页没有可见仓库。</p>}
      <div className="flex items-center gap-2 text-my-xs text-my-tertiary"><Button size="sm" disabled={action.busy || page.page <= 1} onClick={() => void load(page.page - 1)}>上一页</Button><span>第 {page.page} 页 · 每页最多 30 条</span><Button size="sm" disabled={action.busy || !page.hasMore} onClick={() => void load(page.page + 1)}>下一页</Button></div>
    </>}
    {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
  </section>
}
export function PullRequestBrowser({ root, connection, binding, onAttach }: { root: string; connection: IntegrationConnection; binding: IntegrationBinding; onAttach?: (object: ExternalObject) => Promise<void> }): JSX.Element {
  const [page, setPage] = useState<PageResult<ExternalObject> | null>(null)
  const action = useIntegrationAction()
  const load = async (number: number): Promise<void> => {
    const result = await action.run(() => api.integrations.pullRequests({ ...boundRequest(root, binding, connection), page: number }))
    if (result) setPage(result)
  }
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2"><span className="my-item-title">{binding.scope}</span><Button size="sm" disabled={action.busy || !binding.enabled || !connection.enabled} onClick={() => void load(1)}>加载 PR / MR</Button></div>
    {page?.items.map((object) => <div key={object.id} className="flex items-center justify-between gap-2 rounded-my-md border border-my-line p-2"><div className="min-w-0"><p className="my-item-title truncate" title={object.title}>#{object.number} {object.title}</p><p className="my-item-description">{object.state} · {object.sourceBranch} → {object.targetBranch}</p></div><div className="flex shrink-0 gap-1"><Button size="sm" disabled={!object.url} onClick={() => void api.openExternal(object.url)}>来源</Button>{onAttach && <Button size="sm" disabled={action.busy} onClick={() => void action.run(async () => { await onAttach(object); return { ok: true as const, data: null } })}>关联</Button>}</div></div>)}
    {page && page.items.length === 0 && <p className="text-my-xs text-my-tertiary">此页没有可见的 PR / MR。</p>}
    {page && <div className="flex items-center gap-2 text-my-xs text-my-tertiary"><Button size="sm" disabled={action.busy || page.page <= 1} onClick={() => void load(page.page - 1)}>上一页</Button><span>第 {page.page} 页</span><Button size="sm" disabled={action.busy || !page.hasMore} onClick={() => void load(page.page + 1)}>下一页</Button></div>}
    {action.error && <p role="alert" className="text-my-sm text-my-danger-text">{action.error}</p>}
  </div>
}
