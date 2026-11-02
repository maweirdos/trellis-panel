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

interface KnowledgeMemory { query: string; result?: RequirementKnowledgeSearchResult }
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
  const [pending, setPending] = useState<string>(), [error, setError] = useState('')
  const ticket = useRef(0), mounted = useRef(true), fieldsId = useId()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ticket.current++ } }, [])
  useEffect(() => { setOpen(false); setPending(undefined); setError(''); setConnections(undefined); setCollections(undefined); ticket.current++ }, [identity, signal])
  const execute = async (kind: string, action: (valid: () => boolean, conversationId: string) => Promise<void>): Promise<void> => {
    if (disabled || !canInteract() || !isPrivateEntrySelected(entryKey) || !current?.conversation) return
    const original = latest.current, request = ++ticket.current, conversationId = current.conversation.id
    const valid = (): boolean => mounted.current && latest.current === original && request === ticket.current && canInteract() && isPrivateEntrySelected(entryKey) && useConversations.getState().entries[entryKey]?.conversation?.id === conversationId
    setPending(kind); setError('')
    try { await action(valid, conversationId) }
    catch (cause) { if (valid()) { memory.result = undefined; setResult(undefined); onChange(selection, []); setError(conversationError(cause)) } }
    finally { if (valid()) setPending(undefined) }
  }
  const loadCollections = async (choice: RequirementKnowledgeConnectionChoice, valid: () => boolean, conversationId: string): Promise<void> => {
    const api = conversationClient()?.requirements.knowledge
    if (!api) throw new Error('知识连接接口暂不可用，请重试。')
    const response = conversationValue(await api.collections(conversationId, { connectionId: choice.connectionId, connectionRevision: choice.connectionRevision }))
    if (!valid()) return
    setCollections(response.items); setHasMore(response.hasMore)
    const ids = selection?.connectionId === choice.connectionId && selection.connectionRevision === choice.connectionRevision ? selection.collectionIds : []
    const available = ids.filter(id => response.items.some(item => item.id === id))
    setCollectionIds(available)
    if (available.length !== ids.length) { memory.result = undefined; setResult(undefined); onChange(undefined, []) }
  }
  const load = (): void => { void execute('connections', async (valid, conversationId) => {
    const api = conversationClient()?.requirements.knowledge
    if (!api) throw new Error('知识连接接口暂不可用，请重试。')
    const response = conversationValue(await api.connections(conversationId))
    if (!valid()) return
    setConnections(response)
    const choice = response.find(item => item.connectionId === selection?.connectionId && item.connectionRevision === selection.connectionRevision)
    if (selection && !choice) { memory.result = undefined; setResult(undefined); setCollectionIds([]); onChange(undefined, []) }
    setConnection(choice)
    if (choice) await loadCollections(choice, valid, conversationId)
  }) }
  useEffect(() => {
    if (open && active && !disabled && connections === undefined && !pending && !error) load()
  }, [open, identity, signal, active, disabled, connections, pending, error])
  const choose = (choice: RequirementKnowledgeConnectionChoice): void => {
    ticket.current++; setPending(undefined); setConnection(choice); setCollections(undefined); setCollectionIds([]); setResult(undefined); memory.result = undefined; onChange(undefined, [])
    void execute('collections', async (valid, conversationId) => loadCollections(choice, valid, conversationId))
  }
  const toggleCollection = (id: string, checked: boolean): void => {
    if (!connection || disabled || !canInteract()) return
    ticket.current++; setPending(undefined)
    const ids = collectionIds.filter(value => value !== id)
    if (checked) ids.push(id)
    if (ids.length > 20) { setError('最多选择 20 个知识库。'); return }
    setCollectionIds(ids); setResult(undefined); memory.result = undefined; setError('')
    onChange(ids.length ? { connectionId: connection.connectionId, connectionRevision: connection.connectionRevision, collectionIds: ids } : undefined, [])
  }
  const search = (): void => { void execute('search', async (valid, conversationId) => {
    const api = conversationClient()?.requirements.knowledge
    if (!api || !connection || !collectionIds.length || !query.trim()) return
    const selected = { connectionId: connection.connectionId, connectionRevision: connection.connectionRevision, collectionIds: [...collectionIds] }
    // Failed retrieval must not leave earlier evidence attached to a new query.
    onChange(selected, []); setResult(undefined); memory.result = undefined
    const response = conversationValue(await api.search(conversationId, { selection: selected, query: query.trim(), limit: 6 }))
    if (!valid()) return
    if (JSON.stringify(response.selection) !== JSON.stringify(selected) || response.items.some(item => !response.sources.some(source => source.sourceId === item.sourceId && source.returnedRevision === item.returnedRevision && source.collectionId === item.collectionId && JSON.stringify(source.selection) === JSON.stringify(selected)))) throw new Error('知识结果来源不匹配，请重新检索。')
    memory.query = query; memory.result = response; setResult(response)
    onChange(selected, [])
  }) }
  return <details className="requirement-workbench-knowledge" open={open} onToggle={event => {
    const next = event.currentTarget.open; setOpen(next)
    if (next && !connections && !pending) load()
  }}>
    <summary className="requirement-workbench-disclosure"><BookOpen size={14} aria-hidden="true" /><span className="my-item-title">知识来源</span>{sources.length > 0 && <span className="my-item-description">{sources.length} 项</span>}<ChevronDown size={12} aria-hidden="true" /></summary>
    <div className="requirement-workbench-source-body">
      <div className="requirement-workbench-line">
        <Dropdown align="left" disabled={disabled || Boolean(pending)} trigger={({ toggle, open }) => <Button size="sm" variant="outline" disabled={disabled || Boolean(pending)} aria-expanded={open} onClick={toggle}>{connection?.name ?? '选择知识连接'}<ChevronDown size={12} /></Button>}>{close => <>{connections?.map(choice => <DropdownItem key={choice.connectionId} selected={connection?.connectionId === choice.connectionId} onClick={() => { close(); choose(choice) }}>{choice.name}</DropdownItem>)}{connections?.length === 0 && <p className="my-item-description px-3 py-2">暂无可用知识连接。</p>}</>}</Dropdown>
        <Button size="sm" variant="ghost" aria-label="刷新知识连接" disabled={disabled || Boolean(pending)} onClick={load}><RefreshCw size={14} /></Button>
        {pending && <Loader2 size={14} className="animate-spin" aria-label="读取知识来源中" />}
      </div>
      {collections && <fieldset disabled={disabled || Boolean(pending)} className="requirement-workbench-collection-list"><legend className="my-item-description">选择知识库</legend>{collections.map(item => <label key={item.id} className="requirement-workbench-check"><Checkbox checked={collectionIds.includes(item.id)} onChange={checked => toggleCollection(item.id, checked)} /><span className="my-item-title">{item.name}</span><span className="my-item-description">{item.knowledgeCount}</span></label>)}{collections.length === 0 && <p className="my-item-description">此连接暂无可选知识库。</p>}</fieldset>}
      {hasMore && <p className="my-item-description">仅显示当前返回的知识库。</p>}
      {connection && <form className="requirement-workbench-search" onSubmit={event => { event.preventDefault(); if (!pending) search() }}><label className="sr-only" htmlFor={`${fieldsId}-query`}>检索知识来源</label><input id={`${fieldsId}-query`} className="my-input" placeholder="检索相关资料…" maxLength={2000} value={query} disabled={disabled} onChange={event => { setQuery(event.target.value); memory.query = event.target.value }} /><Button size="sm" variant="outline" type="submit" disabled={disabled || Boolean(pending) || !query.trim() || !collectionIds.length}><Search size={14} />检索</Button></form>}
      {error && <div role="alert" className="requirement-workbench-inline-error"><span className="text-my-danger-text">知识检索未完成</span><Button size="sm" variant="ghost" disabled={disabled || Boolean(pending)} onClick={load}>重试</Button><details><summary className="my-item-description">原因</summary><pre>{error}</pre></details></div>}
      {result && <div className="requirement-workbench-evidence"><p className="my-item-description">{result.items.length ? '选择本次使用的资料' : '未找到匹配资料'}{result.partial ? ' · 结果不完整' : ''}{result.omittedCount ? ` · 另有 ${result.omittedCount} 项未返回` : ''}</p>{result.items.map(item => {
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
