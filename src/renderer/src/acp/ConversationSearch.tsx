import { useEffect, useId, useRef, type Dispatch, type JSX, type ReactNode, type SetStateAction } from 'react'
import { Loader2, Pin, Search, X } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from '../my/ui'

export interface ConversationSearchEntry { id: string; title: string; description?: ReactNode; time?: number; pinned?: boolean }
export interface ConversationSearchProps {
  entries: ConversationSearchEntry[]
  query: string
  selected: number
  loading?: boolean
  error?: string
  hasMore?: boolean
  inputLabel?: string
  footer?: ReactNode
  onQuery(value: string): void
  onSelected: Dispatch<SetStateAction<number>>
  onSelect(id: string): void
  onClose(): void
  onRetry?(): void
  onLoadMore?(): void
}

export function ConversationSearch({ entries, query, selected, loading = false, error, hasMore, inputLabel = '搜索会话标题、角色或任务', footer = '搜索当前项目的标题、角色与任务', onQuery, onSelected, onSelect, onClose, onRetry, onLoadMore }: ConversationSearchProps): JSX.Element {
  const input = useRef<HTMLInputElement>(null), selectedRow = useRef<HTMLButtonElement>(null), composing = useRef(false), listId = useId()
  useEffect(() => { selectedRow.current?.scrollIntoView({ block: 'nearest' }) }, [selected])
  return <section className="acp-search-palette" aria-label="搜索会话">
    <div className="acp-search-input"><Search size={18} aria-hidden="true" /><input autoFocus ref={input} role="combobox" aria-label={inputLabel} aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={entries[selected] ? `${listId}-${selected}` : undefined} value={query} placeholder="搜索会话" onChange={(event) => onQuery(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === 'Escape') event.stopPropagation(); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); onSelected((index) => entries.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length : 0) }
      else if (event.key === 'Enter' && !loading && entries[selected]) { event.preventDefault(); onSelect(entries[selected].id) }
    }} /><button type="button" className="my-icon-control" aria-label={query ? '清空会话搜索' : '关闭会话搜索'} onClick={() => { if (query) { onQuery(''); input.current?.focus() } else onClose() }}><X size={16} /></button></div>
    <div className="acp-search-caption">{query.trim() ? '会话搜索结果' : '最近会话'}</div>
    <div id={listId} role="listbox" aria-label="会话搜索结果" className="acp-search-results my-scrollbar">
      {entries.map((entry, index) => <button key={entry.id} ref={index === selected ? selectedRow : undefined} id={`${listId}-${index}`} type="button" role="option" aria-selected={index === selected} disabled={loading} className={clsx('acp-search-result', index === selected && 'is-selected')} onMouseEnter={() => onSelected(index)} onFocus={() => onSelected(index)} onClick={() => { if (!loading) onSelect(entry.id) }}><span><strong>{entry.title}</strong>{entry.description !== undefined && <small>{entry.description}</small>}</span>{entry.pinned && <Pin size={12} aria-label="已置顶" />}{entry.time !== undefined && <time>{new Date(entry.time).toLocaleDateString([], { month: 'numeric', day: 'numeric' })}</time>}</button>)}
      {!entries.length && !loading && !error && <p className="acp-search-empty">没有找到匹配的会话</p>}
      {loading && <p className="acp-search-empty" role="status">正在搜索…</p>}
      {error && <p className="acp-search-error" role="alert">{error}{onRetry && <button type="button" onClick={onRetry}>重试</button>}</p>}
      {hasMore && <Button size="sm" variant="ghost" className="acp-load-more" disabled={loading} onClick={onLoadMore}>加载更多会话</Button>}
    </div>
    <div className="acp-search-footer"><span>{footer}</span><span>↑↓ 选择　Enter 打开</span></div>
  </section>
}
