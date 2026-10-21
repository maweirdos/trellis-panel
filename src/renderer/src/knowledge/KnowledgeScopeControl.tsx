import { useEffect, useState, type JSX } from 'react'
import { Cloud, RefreshCw } from 'lucide-react'
import { Button } from '../my/ui'
import { useApp } from '../store'
import { useInteractionGuard } from '../utils/interaction-scope'
import { knowledgeBridge, knowledgeError, knowledgeStatusLabel, knowledgeUnavailableFor, notifyKnowledgeScope, requireKnowledge, useProjectKnowledge } from './bridge'
import type { KnowledgeCollection, KnowledgeScope } from '../../../shared/knowledge-access'

export function CollectionChoices({ items, selected, onChange, disabled = false }: { items: KnowledgeCollection[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }): JSX.Element {
  return <div className="my-scrollbar max-h-48 space-y-2 overflow-y-auto rounded-my-md border border-my-line p-3">{items.map((item) => <label key={item.id} className="flex items-start gap-2 text-my-xs"><input type="checkbox" disabled={disabled} checked={selected.includes(item.id)} onChange={(event) => onChange(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} /><span className="min-w-0"><span className="block break-words">{item.name}</span><span className="break-all text-my-tertiary">{item.id} · {item.knowledgeCount} 篇</span></span></label>)}{items.length === 0 && <p className="text-my-xs text-my-tertiary">没有可选择的知识库；不会查询全部库。</p>}</div>
}

export function KnowledgeScopeControl({ root, sessionId, busy = false, onScope }: { root: string; sessionId?: string; busy?: boolean; onScope?: (scope: KnowledgeScope) => void }): JSX.Element {
  const state = useProjectKnowledge(root, sessionId)
  const canInteract = useInteractionGuard()
  const [editing, setEditing] = useState(false)
  const [collections, setCollections] = useState<KnowledgeCollection[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [bindImported, setBindImported] = useState(false)
  const scope = state.context?.scope
  useEffect(() => { if (scope) { setSelected(scope.collectionIds); onScope?.(scope) } }, [scope, onScope])
  useEffect(() => { setEditing(false); setCollections([]); setError(''); setWorking(false); setImporting(false); setBindImported(false) }, [root, sessionId, state.current])
  const edit = async (): Promise<void> => {
    const bridge = knowledgeBridge(['collections'])
    if (!state.current() || !canInteract() || working) return
    if (!bridge) { setError(knowledgeUnavailableFor('知识库选择')); return }
    setWorking(true); setError('')
    try {
      const result = requireKnowledge(await bridge.collections(state.input))
      if (!state.current() || !canInteract()) return
      setCollections(result.items); setEditing(true)
      if (result.hasMore) setError('仅显示服务返回的首批知识库；未列出的库不会自动纳入范围。')
    } catch (failure) { if (state.current()) setError(knowledgeError(failure)) }
    finally { if (state.current()) setWorking(false) }
  }
  const apply = async (ids: string[] | null): Promise<void> => {
    const bridge = knowledgeBridge(['updateScope'])
    if (!state.current() || !canInteract() || working) return
    if (!bridge) { setError(knowledgeUnavailableFor('知识范围调整')); return }
    setWorking(true); setError('')
    try {
      requireKnowledge(await bridge.updateScope({ ...state.input, collectionIds: ids }))
      if (!state.current() || !canInteract()) return
      setEditing(false); notifyKnowledgeScope(root, sessionId)
    } catch (failure) { if (state.current()) setError(knowledgeError(failure)) }
    finally { if (state.current()) setWorking(false) }
  }
  const importLegacy = async (): Promise<void> => {
    if (!state.current() || !canInteract() || working) return
    const bridge = knowledgeBridge(['importLegacy'])
    if (!bridge) { setError(knowledgeUnavailableFor('旧连接导入')); return }
    setWorking(true); setError('')
    try {
      requireKnowledge(await bridge.importLegacy({ expectedRoot: root, bindProject: bindImported }))
      if (!state.current()) return
      setImporting(false); notifyKnowledgeScope(root); if (sessionId) notifyKnowledgeScope(root, sessionId); await state.refresh()
    } catch (failure) { if (state.current()) setError(knowledgeError(failure, '旧连接导入')) }
    finally { if (state.current()) setWorking(false) }
  }
  return <section aria-label="项目知识范围" className="space-y-2 rounded-my-md border border-my-line bg-my-layer-1 p-3">
    <div className="flex flex-wrap items-center gap-2 text-my-xs"><Cloud size={13} /><strong className="font-medium">{scope?.connectionName || '项目知识'}</strong><span className="text-my-tertiary">{state.loading ? '读取范围…' : scope ? `${knowledgeStatusLabel[scope.status]} · ${scope.collectionIds.length} 个库${scope.overridden ? ' · 本次调整' : ' · 项目默认'}` : '不可用'}</span><Button className="ml-auto" size="sm" variant="ghost" disabled={state.loading || working} onClick={() => void state.refresh()} title="刷新知识范围"><RefreshCw size={12} /></Button></div>
    <p role="status" className="break-words text-my-xs leading-relaxed text-my-tertiary">{state.error || scope?.detail || '知识范围未配置。'}{busy && ' 本轮范围已固定；调整仅作用于后续轮次。'}</p>
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!scope?.connectionId || working} onClick={() => void edit()}>调整本次范围</Button>{scope?.overridden && <Button size="sm" disabled={working} onClick={() => void apply(null)}>恢复项目默认</Button>}<Button size="sm" variant="ghost" onClick={() => useApp.getState().setPage('integrations')}>管理连接与项目默认</Button></div>
    {state.context?.legacyImportAvailable && scope?.status === 'not_configured' && <div className="space-y-2"><Button size="sm" disabled={working} onClick={() => setImporting((value) => !value)}>导入旧连接</Button>{importing && <div className="space-y-2 rounded-my-md border border-my-line p-3"><p className="text-my-xs text-my-secondary">导入已有 WeKnora 连接，并选择是否用于当前项目。</p><label className="flex items-start gap-2 text-my-xs"><input type="checkbox" disabled={working} checked={bindImported} onChange={(event) => setBindImported(event.target.checked)} />同时绑定当前项目及原选中知识库</label><Button size="sm" variant="primary" disabled={working} onClick={() => void importLegacy()}>确认导入</Button></div>}</div>}
    {editing && <div className="space-y-2"><p className="text-my-xs text-my-secondary">选择只约束检索范围，不授予远端权限。空选表示本次不使用远端知识。</p><CollectionChoices items={collections} selected={selected} onChange={setSelected} disabled={working} /><div className="flex gap-2"><Button size="sm" variant="primary" disabled={working} onClick={() => void apply(selected)}>应用到后续使用</Button><Button size="sm" disabled={working} onClick={() => setEditing(false)}>取消</Button></div></div>}
    {error && <p role="alert" className="text-my-xs text-my-warning-text">{error}</p>}
  </section>
}
