import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { FileText, Search, X } from 'lucide-react'
import { MarkdownView } from '../components/MarkdownView'
import { Button, Modal } from '../my/ui'
import { projectRootKey } from '../my/navigation'
import { api } from '../api'
import { useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { knowledgeBridge, knowledgeError, knowledgeStatusLabel, knowledgeUnavailableFor, onKnowledgeScope, requireKnowledge, useKnowledgeOwner } from '../knowledge/bridge'
import type { KnowledgeSearchResult, KnowledgeSource } from '../../../shared/knowledge-access'

export function KnowledgeReferencePicker({ root, sessionId, isCurrent, onClose, onSelect }: {
  root: string; sessionId: string; isCurrent: () => boolean; onClose: () => void; onSelect: (source: KnowledgeSource) => Promise<boolean>
}): JSX.Element {
  const owner = useKnowledgeOwner(root, sessionId)
  const canInteract = useInteractionGuard()
  const signal = useInteractionSignal()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null)
  const [selected, setSelected] = useState<KnowledgeSource | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [durable, setDurable] = useState(false)
  const request = useRef<string | null>(null)
  const sequence = useRef(0)
  const current = (): boolean => owner.current() && isCurrent() && canInteract() && !signal?.aborted
  const cancel = useCallback((): void => {
    sequence.current++
    const id = request.current
    request.current = null
    const bridge = knowledgeBridge(['cancel'])
    if (id && bridge) void bridge.cancel({ requestId: id }).catch(() => {})
  }, [])

  useEffect(() => () => cancel(), [cancel])
  useEffect(() => {
    const invalidate = (): void => { cancel(); setResult(null); setSelected(null); setSelectedId(null); setDurable(false); setBusy(false); setError('知识范围已改变，请重新检索。') }
    const unsubscribe = onKnowledgeScope((changedRoot, changedSession) => {
      if (projectRootKey(changedRoot) === projectRootKey(root) && changedSession === sessionId) invalidate()
    })
    const unsubscribeIntegrations = api?.integrations?.onChanged?.(invalidate)
    return () => { unsubscribe(); unsubscribeIntegrations?.() }
  }, [root, sessionId, cancel])

  const search = async (): Promise<void> => {
    if (!query.trim() || busy || request.current || !current()) return
    const bridge = knowledgeBridge(['search'])
    if (!bridge) { setError(knowledgeUnavailableFor('知识检索')); return }
    const id = crypto.randomUUID(), token = ++sequence.current
    request.current = id; setBusy(true); setError(''); setSelected(null); setSelectedId(null); setResult(null); setDurable(false)
    try {
      const value = requireKnowledge(await bridge.search({ ...owner.input, requestId: id, query: query.trim(), limit: 10 }))
      if (!current() || token !== sequence.current) return
      if (value.scope.sessionId !== sessionId || value.sources.some((source) => source.sessionId !== sessionId)) throw Error('返回来源不属于当前会话，请重新检索。')
      setResult(value)
    } catch (failure) { if (current() && token === sequence.current) setError(knowledgeError(failure, '知识检索')) }
    finally { if (token === sequence.current) { request.current = null; if (current()) setBusy(false) } }
  }
  const read = async (): Promise<void> => {
    if (!selected || busy || request.current || !current()) return
    const bridge = knowledgeBridge(['read'])
    if (!bridge) { setError(knowledgeUnavailableFor('知识正文读取')); return }
    const id = crypto.randomUUID(), token = ++sequence.current
    request.current = id; setBusy(true); setError('')
    try {
      const value = requireKnowledge(await bridge.read({ ...owner.input, requestId: id, sourceHandle: selected.sourceHandle }))
      if (!current() || token !== sequence.current) return
      if (value.source && value.source.sessionId !== sessionId) throw Error('返回来源不属于当前会话。')
      if (value.source) { setSelected(value.source); setDurable(value.status === 'ok' && value.persistence === 'durable') }
      if (value.status !== 'ok' || value.persistence === 'degraded') setError(`${knowledgeStatusLabel[value.status]}：${value.detail}${value.persistence === 'degraded' ? '；来源保存降级' : ''}`)
    } catch (failure) { if (current() && token === sequence.current) setError(knowledgeError(failure, '知识正文读取')) }
    finally { if (token === sequence.current) { request.current = null; if (current()) setBusy(false) } }
  }

  return <Modal open onClose={onClose} width={760} ariaLabel="查找项目知识">
    <header className="flex items-center gap-3 border-b border-my-line px-4 py-3"><h2 className="min-w-0 flex-1 text-my-md font-semibold">查找项目知识</h2><Button size="sm" variant="ghost" aria-label="关闭知识查找" onClick={onClose}><X size={16} /></Button></header>
    <div className="my-scrollbar max-h-[70vh] space-y-4 overflow-y-auto p-4 text-my-xs">
      <p className="text-my-secondary">选择检索摘录或读取正文后加入当前草稿。</p>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void search() }}><input className="my-input min-w-0 flex-1" aria-label="检索项目知识" placeholder="输入关键词" maxLength={2000} value={query} onChange={(event) => setQuery(event.target.value)} /><Button size="sm" variant="outline" disabled={busy || !query.trim()} onClick={() => void search()}><Search size={14} />{busy ? '处理中…' : '搜索'}</Button></form>
      {result && <><p role="status" className="text-my-tertiary">{knowledgeStatusLabel[result.status]}：{result.detail}{result.persistence === 'degraded' ? ' · 来源保存降级' : ''}</p><div className="my-scrollbar max-h-48 space-y-1 overflow-y-auto">{result.sources.map((source) => <button type="button" key={source.id} disabled={busy} aria-pressed={selectedId === source.id} onClick={() => { setSelected(source); setSelectedId(source.id); setDurable(result.persistence === 'durable'); setError('') }} className="flex w-full items-start gap-2 rounded-my-md border border-my-line px-3 py-2 text-left hover:bg-my-layer-2"><FileText size={13} className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1 break-words">{source.title}<span className="block text-my-2xs text-my-tertiary">{source.kind === 'local' ? source.relativePath : `WeKnora · ${source.collectionId || '库未知'}`} · {source.mode === 'excerpt' ? '摘录' : source.mode === 'full' ? '全文' : '格式不支持'}{source.truncated ? ' · 已截断' : ''}</span></span></button>)}</div></>}
      {selected && <article className="space-y-3 rounded-my-md border border-my-line bg-my-layer-1 p-3" aria-label={`知识来源：${selected.title}`}><h3 className="break-words text-my-sm font-medium">{selected.title}</h3><p className="text-my-2xs text-my-tertiary">{selected.mode === 'full' ? '正文' : selected.mode === 'excerpt' ? '检索摘录' : '格式不支持'}{selected.truncated ? ' · 已截断' : ''} · 仅供阅读</p>{selected.text ? <div className="my-scrollbar max-h-72 overflow-y-auto break-words"><MarkdownView content={selected.text} /></div> : <p className="text-my-secondary">没有可显示的文本。</p>}<Button size="sm" variant="outline" disabled={busy || result?.persistence === 'degraded'} onClick={() => void read()}>读取最新正文</Button><details className="text-my-2xs text-my-tertiary"><summary className="cursor-pointer">来源与版本详情</summary><p className="mt-2 break-all">{selected.kind === 'local' ? selected.relativePath : `${selected.instanceId || '实例未知'} · 库 ${selected.collectionId || '未知'}`} · 文档 {selected.documentId}<br />快照 {selected.contentHash} · {new Date(selected.fetchedAt).toLocaleString()}</p></details></article>}
      {selected && <Button size="sm" variant="primary" disabled={busy || !durable || selected.mode === 'unsupported' || !selected.text} onClick={() => { if (!current()) return; setBusy(true); setError(''); void onSelect(selected).then((added) => { if (!current()) return; if (added) onClose(); else setError('未能加入草稿，请核对当前会话和知识范围后重试。') }).catch((failure) => { if (current()) setError(knowledgeError(failure, '知识引用')) }).finally(() => { if (current()) setBusy(false) }) }}>{busy ? '处理中…' : '加入草稿'}</Button>}
      {error && <p role="alert" className="text-my-warning-text">{error}</p>}
    </div>
  </Modal>
}
