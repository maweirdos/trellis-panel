import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { FileText, RefreshCw } from 'lucide-react'
import { Button } from '../my/ui'
import { useInteractionGuard } from '../utils/interaction-scope'
import { knowledgeBridge, knowledgeError, knowledgeUnavailableFor, requireKnowledge, useKnowledgeOwner } from './bridge'
import { KnowledgeSourceView } from './KnowledgeSourceView'
import { ProductMaterialActions } from './ProductMaterialActions'
import type { KnowledgeSource } from '../../../shared/knowledge-access'

export function ConversationKnowledge({ root, sessionId, refreshKey }: { root: string; sessionId: string; refreshKey: string }): JSX.Element {
  const owner = useKnowledgeOwner(root, sessionId)
  const canInteract = useInteractionGuard()
  const [tab, setTab] = useState<'sources' | 'materials'>('sources')
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [selected, setSelected] = useState<KnowledgeSource | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const sequence = useRef(0)
  useEffect(() => { sequence.current++; setSources([]); setSelected(null); setError(''); setLoading(false); setTab('sources') }, [owner.current])
  const refresh = useCallback(async (): Promise<void> => {
    if (!owner.current() || !canInteract()) return
    const bridge = knowledgeBridge(['sources'])
    if (!bridge) { setError(knowledgeUnavailableFor('会话来源')); return }
    const token = ++sequence.current
    setLoading(true); setError('')
    try { const items = requireKnowledge(await bridge.sources(owner.input)); if (owner.current() && token === sequence.current) setSources(items.filter((source) => source.sessionId === sessionId)) } catch (failure) { if (owner.current() && token === sequence.current) setError(knowledgeError(failure, '会话来源')) } finally { if (owner.current() && token === sequence.current) setLoading(false) }
  }, [owner.current, owner.input, canInteract, sessionId])
  useEffect(() => { void refresh() }, [refresh, refreshKey])
  return <section className="space-y-4 text-my-xs" aria-label="会话知识与材料">
    <div className="flex flex-wrap gap-2" role="group" aria-label="知识面板视图">
      <Button size="sm" variant={tab === 'sources' ? 'neutral' : 'ghost'} className="whitespace-nowrap" aria-pressed={tab === 'sources'} onClick={() => setTab('sources')}>参考来源{sources.length ? `（${sources.length}）` : ''}</Button>
      <Button size="sm" variant={tab === 'materials' ? 'neutral' : 'ghost'} className="whitespace-nowrap" aria-pressed={tab === 'materials'} onClick={() => setTab('materials')}>需求材料</Button>
    </div>
    <div hidden={tab !== 'sources'} className="space-y-3">
      <div className="flex items-center gap-2"><p className="my-item-description min-w-0 flex-1">会话里每次检索都可直接查看来源；这里汇总已保留的资料。</p><Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()} title="刷新来源快照"><RefreshCw size={12} className={loading ? 'animate-spin' : ''} /></Button></div>
      <div className="my-scrollbar max-h-48 space-y-1 overflow-y-auto">
        {sources.length === 0 && !error && <p className="py-4 text-my-tertiary">{loading ? '正在读取来源…' : '这段会话还没有知识来源。'}</p>}
        {sources.map((source) => <button type="button" key={source.id} onClick={() => setSelected(source)} aria-pressed={selected?.id === source.id} className="flex w-full items-start gap-2 rounded-my-md border border-my-line px-3 py-2 text-left hover:bg-my-layer-2"><FileText size={13} className="mt-0.5 shrink-0" /><span className="my-item-title min-w-0 flex-1 break-words">{source.title}<span className="my-item-description block">{source.suppliedToAgent ? '已提供给 Agent' : '已检索'} · {source.mode === 'full' ? '全文' : source.mode === 'excerpt' ? '摘录' : '格式不支持'}{source.truncated ? ' · 已截断' : ''}</span></span></button>)}
      </div>
      {selected && <KnowledgeSourceView key={`${root}:${sessionId}:${selected.id}`} root={root} sessionId={sessionId} initial={selected} />}
      {error && <p role="alert" className="text-my-danger-text">{error}</p>}
      <details className="text-my-tertiary"><summary className="cursor-pointer">来源记录管理</summary><p className="my-2">保留检索时的文本和版本；提供给 Agent 不等于回答已引用。</p><Button size="sm" variant="ghost" disabled={!knowledgeBridge(['clearHistory'])} onClick={() => {
        const bridge = knowledgeBridge(['clearHistory'])
        if (!bridge || !owner.current() || !canInteract()) return
        void bridge.clearHistory(owner.input).then((response) => { const result = requireKnowledge(response); if (owner.current()) { setSelected(null); setError(`已清理 ${result.removed} 份未关联快照，保留 ${result.retained} 份成果证据。`); void refresh() } }).catch((failure: unknown) => { if (owner.current()) setError(knowledgeError(failure, '来源记录清理')) })
      }}>清理未关联快照</Button></details>
    </div>
    <div hidden={tab !== 'materials'}><ProductMaterialActions root={root} sessionId={sessionId} sources={sources} allowCreate={false} /></div>
  </section>
}
