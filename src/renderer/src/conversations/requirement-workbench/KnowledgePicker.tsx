import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { BookOpen, ChevronDown, Loader2, RefreshCw, Search, X } from 'lucide-react'
import type {
  RequirementKnowledgeCollection, RequirementKnowledgeConnectionChoice, RequirementKnowledgeSearchResult,
  RequirementKnowledgeSelection, RequirementKnowledgeSourceRef
} from '@shared/conversation-requirement-knowledge'
import { Button, Checkbox, Dropdown, DropdownItem } from '../../my/ui'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../../utils/interaction-scope'
import { conversationClient, conversationError, conversationValue } from '../client'
import { isPrivateEntrySelected } from '../source'
import { useConversations } from '../workspace'

interface KnowledgeMemory { query: string; result?: RequirementKnowledgeSearchResult; lastCount?: number }
const memories = new Map<string, KnowledgeMemory>()
function memoryFor(key: string): KnowledgeMemory {
  const existing = memories.get(key)
  if (existing) return existing
  if (memories.size >= 16) { const first = memories.keys().next().value; if (first) memories.delete(first) }
  const memory: KnowledgeMemory = { query: '' }; memories.set(key, memory); return memory
}
export interface KnowledgePickerProps {
  entryKey: string
  requirementId: string
  selection?: RequirementKnowledgeSelection
  sources: RequirementKnowledgeSourceRef[]
  disabled?: boolean
  onChange(selection: RequirementKnowledgeSelection | undefined, sources: RequirementKnowledgeSourceRef[]): void
}
export function KnowledgePicker({ entryKey, requirementId, selection, sources, disabled, onChange }: KnowledgePickerProps): JSX.Element {
  const current = useConversations(state => state.entries[entryKey]), active = useInteractionActive(), signal = useInteractionSignal(), canInteract = useInteractionGuard()
  const key = JSON.stringify([current?.conversation?.creatorId, current?.conversation?.id, requirementId]), memory = memoryFor(key)
  const identity = JSON.stringify([key, current?.owner, current?.session?.connectionGeneration, active]), latest = useRef({ identity, signal })
  if (latest.current.identity !== identity || latest.current.signal !== signal) latest.current = { identity, signal }
  const [open, setOpen] = useState(false), [connections, setConnections] = useState<RequirementKnowledgeConnectionChoice[]>(), [collections, setCollections] = useState<RequirementKnowledgeCollection[]>()
  const [connection, setConnection] = useState<RequirementKnowledgeConnectionChoice>(), [collectionIds, setCollectionIds] = useState<string[]>(selection?.collectionIds ?? [])
  const [hasMore, setHasMore] = useState(false), [query, setQuery] = useState(memory.query), [result, setResult] = useState(memory.result)
  const [visibleCount, setVisibleCount] = useState(50)
  const [scopeVerified, setScopeVerified] = useState(false)
  const [lastCount, setLastCount] = useState(memory.lastCount)
  const [scopeChange, setScopeChange] = useState<{ choice: RequirementKnowledgeConnectionChoice } | { ids: string[] }>()
  const [pending, setPending] = useState<string>(), [error, setError] = useState('')
  const ticket = useRef(0), mounted = useRef(true), fieldsId = useId()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ticket.current++ } }, [])
  useEffect(() => { setOpen(false); setPending(undefined); setError(''); setConnections(undefined); setCollections(undefined); setScopeVerified(false); setScopeChange(undefined); ticket.current++ }, [identity, signal])
  const execute = async (kind: string, action: (valid: () => boolean, conversationId: string) => Promise<void>): Promise<void> => {
    if (disabled || !canInteract() || !isPrivateEntrySelected(entryKey) || !current?.conversation) return
    const original = latest.current, request = ++ticket.current, conversationId = current.conversation.id
    const valid = (): boolean => mounted.current && latest.current === original && request === ticket.current && canInteract() && isPrivateEntrySelected(entryKey) && useConversations.getState().entries[entryKey]?.conversation?.id === conversationId
    setPending(kind); setError('')
    try { await action(valid, conversationId) }
    catch (cause) { if (valid()) { setScopeVerified(false); setError(conversationError(cause)) } }
    finally { if (valid()) setPending(undefined) }
  }
  const loadCollections = async (choice: RequirementKnowledgeConnectionChoice, valid: () => boolean, conversationId: string): Promise<void> => {
    const api = conversationClient()?.requirements.knowledge
    if (!api) throw new Error('知识连接接口暂不可用，请重试。')
    const response = conversationValue(await api.collections(conversationId, { connectionId: choice.connectionId, connectionRevision: choice.connectionRevision }))
    if (!valid()) return
    setCollections(response.items); setHasMore(response.hasMore); setVisibleCount(50)
    const ids = selection?.connectionId === choice.connectionId && selection.connectionRevision === choice.connectionRevision ? selection.collectionIds : []
    setCollectionIds(ids)
    setScopeVerified(ids.every(id => response.items.some(item => item.id === id)))
    if (ids.some(id => !response.items.some(item => item.id === id))) setError(response.hasMore ? '部分已选知识库尚未核实，选择已保留。' : '部分已选知识库当前不可访问，选择已保留；请检查权限或调整范围。')
  }
  const load = (): void => { void execute('connections', async (valid, conversationId) => {
    const api = conversationClient()?.requirements.knowledge
    if (!api) throw new Error('知识连接接口暂不可用，请重试。')
    const response = conversationValue(await api.connections(conversationId))
    if (!valid()) return
    setConnections(response)
    const choice = response.find(item => item.connectionId === selection?.connectionId && item.connectionRevision === selection.connectionRevision)
    if (selection && !choice) { setScopeVerified(false); setError('已选知识连接已变化或不可访问，选择已保留；请检查连接或切换范围。') }
    setConnection(choice)
    if (choice) await loadCollections(choice, valid, conversationId)
  }) }
  useEffect(() => {
    if (open && active && !disabled && connections === undefined && !pending && !error) load()
  }, [open, identity, signal, active, disabled, connections, pending, error])
  const applyConnection = (choice: RequirementKnowledgeConnectionChoice): void => {
    ticket.current++; setPending(undefined); setConnection(choice); setCollections(undefined); setCollectionIds([]); setScopeVerified(false); setResult(undefined); setLastCount(undefined); memory.result = undefined; memory.lastCount = undefined; onChange(undefined, [])
    void execute('collections', async (valid, conversationId) => loadCollections(choice, valid, conversationId))
  }
  const choose = (choice: RequirementKnowledgeConnectionChoice): void => {
    if (choice.connectionId === selection?.connectionId && choice.connectionRevision === selection.connectionRevision) return
    if (selection || sources.length) { setScopeChange({ choice }); return }
    applyConnection(choice)
  }
  const applyCollections = (ids: string[]): void => {
    if (!connection) return
    setCollectionIds(ids); setResult(undefined); setLastCount(undefined); memory.result = undefined; memory.lastCount = undefined; setError('')
    setScopeVerified(ids.every(id => collections?.some(item => item.id === id)))
    onChange(ids.length ? { connectionId: connection.connectionId, connectionRevision: connection.connectionRevision, collectionIds: ids } : undefined, [])
  }
  const toggleCollection = (id: string, checked: boolean): void => {
    if (!connection || disabled || !canInteract()) return
    ticket.current++; setPending(undefined)
    const ids = collectionIds.filter(value => value !== id)
    if (checked) ids.push(id)
    if (ids.length > 20) { setError('最多选择 20 个知识库。'); return }
    if (sources.length) { setScopeChange({ ids }); return }
    applyCollections(ids)
  }
  const search = (): void => { void execute('search', async (valid, conversationId) => {
    const api = conversationClient()?.requirements.knowledge
    if (!api || !connection || !collectionIds.length || !query.trim()) return
    const selected = { connectionId: connection.connectionId, connectionRevision: connection.connectionRevision, collectionIds: [...collectionIds] }
    const response = conversationValue(await api.search(conversationId, { selection: selected, query: query.trim(), limit: 6 }))
    if (!valid()) return
    if (JSON.stringify(response.selection) !== JSON.stringify(selected) || response.items.some(item => !response.sources.some(source => source.sourceId === item.sourceId && source.returnedRevision === item.returnedRevision && source.collectionId === item.collectionId && JSON.stringify(source.selection) === JSON.stringify(selected)))) throw new Error('知识结果来源不匹配，请重新检索。')
    const retained = result?.items.filter(item => sources.some(source => source.sourceId === item.sourceId && source.returnedRevision === item.returnedRevision)) ?? []
    const merged = { ...response, items: [...retained, ...response.items], sources: [...(result?.sources.filter(source => retained.some(item => item.sourceId === source.sourceId && item.returnedRevision === source.returnedRevision)) ?? []), ...response.sources] }
    memory.query = query; memory.result = merged; memory.lastCount = response.items.length; setResult(merged); setLastCount(response.items.length)
  }) }
  return <details className="requirement-workbench-knowledge" open={open} onToggle={event => {
    const next = event.currentTarget.open; setOpen(next)
    if (next && connections && !pending) load()
    if (!next) setScopeVerified(false)
  }}>
    <summary className="requirement-workbench-disclosure"><BookOpen size={14} aria-hidden="true" /><span className="my-item-title">知识来源</span>{sources.length > 0 && <span className="my-item-description">{sources.length} 项</span>}<ChevronDown size={12} aria-hidden="true" /></summary>
    <div className="requirement-workbench-source-body">
      <div className="requirement-workbench-line">
        <Dropdown align="left" disabled={disabled || Boolean(pending)} trigger={({ toggle, open }) => <Button size="sm" variant="outline" disabled={disabled || Boolean(pending)} aria-expanded={open} onClick={toggle}>{connection?.name ?? '选择知识连接'}<ChevronDown size={12} /></Button>}>{close => <>{connections?.map(choice => <DropdownItem key={choice.connectionId} selected={connection?.connectionId === choice.connectionId} onClick={() => { close(); choose(choice) }}>{choice.name}</DropdownItem>)}{connections?.length === 0 && <p className="my-item-description px-3 py-2">暂无可用知识连接。</p>}</>}</Dropdown>
        <Button size="sm" variant="ghost" aria-label="刷新知识连接" disabled={disabled || Boolean(pending)} onClick={load}><RefreshCw size={14} /></Button>
        {pending && <Loader2 size={14} className="animate-spin" aria-label="读取知识来源中" />}
      </div>
      {scopeChange && <div role="status" className="requirement-workbench-inline-error"><span>更改知识范围将清除已选资料，是否继续？</span><Button size="sm" variant="outline" disabled={disabled || Boolean(pending)} onClick={() => { const change = scopeChange; setScopeChange(undefined); if ('choice' in change) applyConnection(change.choice); else applyCollections(change.ids) }}>确认更改</Button><Button size="sm" variant="ghost" onClick={() => setScopeChange(undefined)}>取消</Button></div>}
      {collections && <fieldset disabled={disabled || Boolean(pending) || Boolean(scopeChange)} className="requirement-workbench-collection-list"><legend className="my-item-description">选择知识库 · 已选 {collectionIds.length} 项</legend>{[...collections].sort((a, b) => Number(collectionIds.includes(b.id)) - Number(collectionIds.includes(a.id))).slice(0, visibleCount).map(item => <label key={item.id} className="requirement-workbench-check"><Checkbox checked={collectionIds.includes(item.id)} onChange={checked => toggleCollection(item.id, checked)} /><span className="my-item-title">{item.name}</span><span className="my-item-description">{item.knowledgeCount}</span></label>)}{collectionIds.filter(id => !collections.some(item => item.id === id)).map(id => <label key={id} className="requirement-workbench-check"><Checkbox checked onChange={checked => toggleCollection(id, checked)} /><span className="my-item-description">不可核实的已选知识库：{id}</span></label>)}{collections.length === 0 && !hasMore && <p className="my-item-description">此连接暂无可选知识库。</p>}</fieldset>}
      {collections && visibleCount < collections.length && <Button size="sm" variant="ghost" disabled={disabled || Boolean(pending)} onClick={() => setVisibleCount(count => count + 50)}>加载更多知识库（剩余 {collections.length - visibleCount}）</Button>}
      {hasMore && <p className="my-item-description">知识库列表不完整，尚有未返回的内容。</p>}
      {connection && <form className="requirement-workbench-search" onSubmit={event => { event.preventDefault(); if (!pending && !scopeChange) search() }}><label className="sr-only" htmlFor={`${fieldsId}-query`}>检索知识来源</label><input id={`${fieldsId}-query`} className="my-input" placeholder="检索相关资料…" maxLength={2000} value={query} disabled={disabled} onChange={event => { setQuery(event.target.value); memory.query = event.target.value }} /><Button size="sm" variant="outline" type="submit" disabled={disabled || Boolean(pending) || Boolean(scopeChange) || !query.trim() || !collectionIds.length}><Search size={14} />检索</Button></form>}
      {error && <div role="alert" className="requirement-workbench-inline-error"><span className="text-my-danger-text">知识来源未能完成读取</span><Button size="sm" variant="ghost" disabled={disabled || Boolean(pending)} onClick={load}>刷新连接</Button><details><summary className="my-item-description">原因</summary><pre>{error}</pre></details></div>}
      {sources.length > 0 && (!result || !scopeVerified) && <p className="my-item-description">已保留 {sources.length} 项资料选择；核实来源权限后可查看，或清除选择。</p>}
      {result && scopeVerified && <div className="requirement-workbench-evidence"><p className="my-item-description">{lastCount === 0 ? '本次未返回匹配资料' : '已选资料及检索结果'}{result.partial ? ' · 结果不完整' : ''}{result.omittedCount ? ` · 另有 ${result.omittedCount} 项未返回` : ''}</p>{result.items.map(item => {
        const checked = sources.some(source => source.sourceId === item.sourceId && source.returnedRevision === item.returnedRevision), snapshot = result.sources.find(source => source.sourceId === item.sourceId && source.returnedRevision === item.returnedRevision)
        return <div key={`${item.sourceId}:${item.returnedRevision}`} className="requirement-workbench-evidence-row"><label className="requirement-workbench-check"><Checkbox checked={checked} onChange={selected => {
          if (!canInteract() || disabled || !selection) return
          const next = sources.filter(source => source.sourceId !== item.sourceId)
          if (selected) next.push({ sourceId: item.sourceId, returnedRevision: item.returnedRevision })
          if (next.length > 8) { setError('最多引用 8 项知识资料。'); return }
          onChange(selection, next)
        }} /><span className="my-item-title">{item.title}</span></label><p className="my-item-description">{item.summary}{item.truncated ? ' · 摘录' : ''}</p>{snapshot && <details><summary className="my-item-description">查看返回摘录</summary><blockquote>{snapshot.excerpt}</blockquote><p className="my-item-description">{snapshot.returnedRevision.slice(0, 12)}</p></details>}</div>
      })}</div>}
      {sources.length > 0 && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { if (canInteract()) onChange(selection, []) }}><X size={13} />清除资料选择</Button>}
    </div>
  </details>
}
