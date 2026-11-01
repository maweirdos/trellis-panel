import { useEffect, useRef, useState, type JSX } from 'react'
import { BookOpen, Loader2, Search } from 'lucide-react'
import { Button } from '../my/ui'
import { useInteractionGuard } from '../utils/interaction-scope'
import { knowledgeBridge, knowledgeError, knowledgeStatusLabel, requireKnowledge, useKnowledgeOwner } from './bridge'
import { KnowledgeScopeControl } from './KnowledgeScopeControl'
import { KnowledgeSourceView } from './KnowledgeSourceView'
import { ProductMaterialActions } from './ProductMaterialActions'
import type { KnowledgeSearchResult, KnowledgeSource } from '../../../shared/knowledge-access'

export function KnowledgeWorkbench({ root, sessionId }: { root: string; sessionId?: string }): JSX.Element {
  const owner = useKnowledgeOwner(root, sessionId)
  const canInteract = useInteractionGuard()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null)
  const [selected, setSelected] = useState<KnowledgeSource | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef<string | null>(null)
  useEffect(() => { pending.current = null; setBusy(false); setResult(null); setSelected(null); setError('') }, [owner.current])
  const search = async (): Promise<void> => {
    const bridge = knowledgeBridge(['search'])
    if (!bridge || !query.trim() || pending.current || !owner.current() || !canInteract()) return
    const id = crypto.randomUUID()
    pending.current = id; setBusy(true); setError(''); setResult(null)
    try {
      const data = requireKnowledge(await bridge.search({ ...owner.input, requestId: id, query: query.trim(), limit: 8 }))
      if (!owner.current() || !canInteract() || pending.current !== id) return
      setResult(data); setSelected(null)
    } catch (failure) { if (owner.current() && pending.current === id) setError(knowledgeError(failure)) }
    finally { if (pending.current === id) { pending.current = null; if (owner.current()) setBusy(false) } }
  }
  return <section aria-label="项目知识工作台" className="space-y-4">
    <div className="flex items-center gap-2"><BookOpen size={16} className="text-my-icon-accent" /><h2 className="text-my-md font-semibold">按项目范围使用知识</h2></div>
    <KnowledgeScopeControl root={root} sessionId={sessionId} />
    <div className="flex gap-2"><input className="my-input min-w-0 flex-1" aria-label="检索项目知识" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void search() }} placeholder="查找历史方案、业务规则或接口约定" /><Button size="sm" variant="primary" disabled={!query.trim() || busy || !knowledgeBridge(['search'])} onClick={() => void search()}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}检索</Button>{busy && <Button size="sm" onClick={() => { if (pending.current) void knowledgeBridge(['cancel'])?.cancel({ requestId: pending.current }) }}>取消</Button>}</div>
    {result && <p role="status" className="text-my-xs text-my-tertiary">{knowledgeStatusLabel[result.status]} · {result.sources.length} 个来源 · {result.elapsedMs}ms · {result.detail}{result.persistence === 'degraded' ? ' · 来源保存降级，不保证重开可读' : ''}</p>}
    {error && <p role="alert" className="text-my-xs text-my-danger-text">{error}</p>}
    <div className="grid gap-3 lg:grid-cols-2"><div className="my-scrollbar max-h-96 space-y-2 overflow-y-auto">{result?.sources.map((source) => <button type="button" key={source.id} onClick={() => setSelected(source)} aria-pressed={selected?.id === source.id} className={`w-full rounded-my-md border p-3 text-left ${selected?.id === source.id ? 'border-my-line-accent-subtle bg-my-accent-subtle' : 'border-my-line hover:bg-my-layer-2'}`}><strong className={`my-item-title block${selected?.id === source.id ? ' text-my-primary' : ''}`}>{source.title}</strong><p className={`my-item-description mt-1${selected?.id === source.id ? ' text-my-secondary' : ''}`}>{source.kind === 'weknora' ? 'WeKnora' : '项目材料'} · {source.mode === 'full' ? '全文' : '摘录'}{source.truncated ? ' · 已截断' : ''}</p><p className={`my-item-description mt-2 line-clamp-3 leading-5${selected?.id === source.id ? ' text-my-secondary' : ''}`}>{source.text}</p></button>)}{result?.status === 'empty' && <p className="my-item-description">没有匹配资料；请调整关键词或本次范围。</p>}{!result && <p className="my-item-description rounded-my-md border border-dashed border-my-line p-4">知识按需检索，不在每条对话前预加载。选中结果可阅读实际快照。</p>}</div><div>{selected && <KnowledgeSourceView key={selected.id} root={root} sessionId={sessionId} initial={selected} />}</div></div>
    <ProductMaterialActions root={root} sessionId={sessionId} sources={result?.sources ?? []} />
  </section>
}
