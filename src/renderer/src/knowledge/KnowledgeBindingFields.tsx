import { useEffect, useState, type JSX } from 'react'
import type { IntegrationConnection } from '../../../shared/integrations'
import type { KnowledgeCollection } from '../../../shared/knowledge-access'
import { Button } from '../my/ui'
import { CollectionChoices } from './KnowledgeScopeControl'
import { knowledgeBridge, knowledgeError, knowledgeUnavailable, requireKnowledge, useKnowledgeOwner, useProjectKnowledge } from './bridge'

export function KnowledgeBindingFields({ root, connection, selected, onChange }: { root: string; connection: IntegrationConnection; selected: string[]; onChange: (ids: string[]) => void }): JSX.Element {
  const owner = useKnowledgeOwner(root)
  const [collections, setCollections] = useState<KnowledgeCollection[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [more, setMore] = useState(false)
  useEffect(() => {
    let disposed = false
    const bridge = knowledgeBridge(['collections'])
    if (!bridge) { setError(knowledgeUnavailable); return }
    setLoading(true)
    void bridge.collections({ ...owner.input, connectionId: connection.id, connectionRevision: connection.revision }).then((response) => {
      if (disposed || !owner.current()) return
      const data = requireKnowledge(response)
      setCollections(data.items); setMore(data.hasMore)
    }).catch((failure: unknown) => { if (!disposed && owner.current()) setError(knowledgeError(failure)) }).finally(() => { if (!disposed && owner.current()) setLoading(false) })
    return () => { disposed = true }
  }, [connection.id, connection.revision, owner.input, owner.current])
  return <div className="space-y-2"><p className="text-my-sm">项目默认知识库</p><p className="text-my-xs leading-relaxed text-my-tertiary">每个项目只启用一个知识连接，可选多个库。启用后其他知识绑定停用；选择范围不授予远端权限。空范围不会查询全部库。</p>{loading ? <p role="status" className="text-my-xs text-my-tertiary">读取可访问知识库…</p> : <CollectionChoices items={collections} selected={selected} onChange={onChange} />}{selected.filter((id) => !collections.some((item) => item.id === id)).map((id) => <label key={id} className="flex gap-2 text-my-xs text-my-warning-text"><input type="checkbox" checked onChange={() => onChange(selected.filter((item) => item !== id))} /><span className="break-all">已选但当前未列出：{id}（未确认可访问）</span></label>)}{more && <p className="text-my-xs text-my-warning-text">只显示服务返回的首批库，未列出的库不会自动选中。</p>}{error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}</div>
}

export function KnowledgeLegacyImport({ root, onSaved }: { root: string; onSaved: () => Promise<void> }): JSX.Element | null {
  const state = useProjectKnowledge(root)
  const [bind, setBind] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!state.context?.legacyImportAvailable) return null
  return <section className="space-y-3 rounded-my-lg border border-my-line-warning p-4 text-my-sm"><h4 className="font-medium">导入原有 WeKnora 配置</h4><p className="text-my-xs leading-relaxed text-my-tertiary">仅由主进程迁移凭证，不显示明文；不会导入自动上传开关，也不会绑定其他项目。原有规范同步保留独立配置。</p><label className="flex gap-2 text-my-xs"><input type="checkbox" checked={bind} disabled={busy} onChange={(event) => setBind(event.target.checked)} />同时绑定当前项目及原选中知识库</label><Button size="sm" disabled={busy} onClick={() => {
    const bridge = knowledgeBridge(['importLegacy'])
    if (!bridge || busy || !state.current()) return
    setBusy(true); setError('')
    void bridge.importLegacy({ ...state.input, bindProject: bind }).then(async (response) => { requireKnowledge(response); if (state.current()) { await state.refresh(); await onSaved() } }).catch((failure: unknown) => { if (state.current()) setError(knowledgeError(failure)) }).finally(() => { if (state.current()) setBusy(false) })
  }}>{busy ? '导入中…' : '明确导入原有配置'}</Button>{error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}</section>
}
