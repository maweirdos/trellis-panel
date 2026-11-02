import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ArchiveRestore, ChevronDown, Loader2, RefreshCw, X } from 'lucide-react'
import type { Conversation } from '@shared/private-conversations'
import type { ChatSessionMeta } from '@shared/types'
import { api, hasIpc } from '../api'
import { ConversationListPreview, ConversationListRow, useConversationListPreview } from '../acp/ConversationListRow'
import { Button, Dropdown, DropdownItem, Modal, SearchInput } from '../my/ui'
import { useMy } from '../my/store'
import { useApp } from '../store'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { conversationClient, conversationError, conversationValue } from './client'
import { selectArchive, selectConversation, updateConversation, useConversations } from './workspace'
import '../acp/workspace.css'

const ARCHIVE_PAGE_SIZE = 50
type ArchiveSource = 'conversations' | 'legacy'

export function ConversationArchiveManager({ open, onClose }: { open: boolean; onClose(): void }): JSX.Element {
  const client = conversationClient(), interactive = useInteractionActive(), canInteract = useInteractionGuard(), signal = useInteractionSignal()
  const managementBusy = useConversations((state) => state.managementBusy), managementErrors = useConversations((state) => state.managementErrors)
  const [source, setSource] = useState<ArchiveSource>('conversations'), [query, setQuery] = useState(''), [page, setPage] = useState(0)
  const [conversations, setConversations] = useState<Conversation[]>([]), [legacy, setLegacy] = useState<ChatSessionMeta[]>([])
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [legacyError, setLegacyError] = useState('')
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const request = useRef(0), lifetime = useRef(0), restored = useRef(new Set<string>()), restoring = useRef(new Set<string>())
  const previewHost = useRef<Element | null>(null)
  const active = useRef(false); active.current = open && interactive && !signal?.aborted
  const hover = useConversationListPreview(JSON.stringify([open, interactive, source, query, page]), open && interactive)

  const refresh = useCallback(async (): Promise<void> => {
    if (!active.current || !canInteract()) return
    const ticket = ++request.current
    if (!client) { setError('连接桌面应用后可管理归档。'); return }
    setLoading(true); setError(''); setLegacyError('')
    const [records, oldRecords] = await Promise.allSettled([client.list({ archive: 'archived' }), hasIpc ? api.chatList() : Promise.resolve(null)])
    if (ticket !== request.current || !active.current || !canInteract()) return
    if (records.status === 'fulfilled') {
      try { setConversations(conversationValue(records.value).filter((item) => item.archivedAt !== undefined && !restored.current.has(item.id))) }
      catch (cause) { setError(conversationError(cause)) }
    } else setError(conversationError(records.reason))
    if (oldRecords.status === 'fulfilled' && oldRecords.value?.ok) {
      const values = oldRecords.value.sessions ?? []
      setLegacy(values)
      useConversations.setState({ archives: values, archiveError: undefined })
      if (!values.length) setSource('conversations')
    } else if (oldRecords.status === 'rejected' || oldRecords.value && !oldRecords.value.ok) {
      setLegacyError(oldRecords.status === 'rejected' ? conversationError(oldRecords.reason) : oldRecords.value?.error || '旧版记录无法读取。')
    }
    setLoading(false)
  }, [client, canInteract])

  useEffect(() => {
    lifetime.current++
    if (open && interactive) {
      restored.current.clear(); setSource('conversations'); setQuery(''); setPage(0); setActionErrors({})
      setConversations([]); setLegacy([]); void refresh()
    }
    return () => { request.current++; lifetime.current++ }
  }, [open, interactive, signal, refresh])

  const search = query.trim().toLocaleLowerCase()
  const matches = useMemo(() => conversations.filter((item) => !search || `${item.title} ${item.conversationPreview ?? ''}`.toLocaleLowerCase().includes(search))
    .sort((left, right) => (right.archivedAt ?? 0) - (left.archivedAt ?? 0) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)), [conversations, search])
  const legacyMatches = useMemo(() => legacy.filter((item) => !search || item.title.toLocaleLowerCase().includes(search)).sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)), [legacy, search])
  const count = source === 'legacy' ? legacyMatches.length : matches.length
  const lastPage = Math.max(0, Math.ceil(count / ARCHIVE_PAGE_SIZE) - 1), currentPage = Math.min(page, lastPage), start = currentPage * ARCHIVE_PAGE_SIZE
  const visible = matches.slice(start, start + ARCHIVE_PAGE_SIZE), legacyVisible = legacyMatches.slice(start, start + ARCHIVE_PAGE_SIZE)
  const sourceError = source === 'legacy' ? legacyError : error
  const choose = (conversation: Conversation): void => {
    if (!active.current || !canInteract() || loading || useConversations.getState().managementBusy[conversation.id]) return
    hover.dismiss(); selectConversation(conversation)
    useMy.getState().setShellView(conversation.kind === 'code' ? 'development' : 'collaboration')
    onClose(); useApp.getState().setPage('chat')
  }
  const chooseLegacy = (id: string): void => {
    if (!active.current || !canInteract() || loading) return
    hover.dismiss(); selectArchive(id, 'work')
    useConversations.setState((state) => ({ projectScopes: { ...state.projectScopes, work: null } }))
    useMy.getState().setShellView('collaboration')
    onClose(); useApp.getState().setPage('chat')
  }
  const restore = async (id: string): Promise<void> => {
    if (!active.current || !canInteract() || restoring.current.has(id) || useConversations.getState().managementBusy[id]) return
    const owner = lifetime.current
    restoring.current.add(id); hover.dismiss(); setActionErrors((previous) => ({ ...previous, [id]: '' }))
    try {
      const result = await updateConversation(id, { archived: false })
      if (result && result.archivedAt === undefined) {
        restored.current.add(id)
        if (owner === lifetime.current && active.current && canInteract()) setConversations((previous) => previous.filter((item) => item.id !== id))
      } else if (owner === lifetime.current && active.current && canInteract()) setActionErrors((previous) => ({ ...previous, [id]: useConversations.getState().managementErrors[id] || '恢复未确认，请重试。' }))
    } catch (cause) { if (owner === lifetime.current && active.current && canInteract()) setActionErrors((previous) => ({ ...previous, [id]: conversationError(cause) })) }
    finally { restoring.current.delete(id) }
  }
  const changeSource = (value: ArchiveSource): void => { hover.dismiss(); setSource(value); setQuery(''); setPage(0) }

  return <>
    <Modal open={open && interactive} onClose={onClose} width={720} ariaLabel="归档会话" placement="center">
      <section className="flex min-h-0 flex-col p-5">
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-my-lg font-medium text-my-primary">归档会话</h2>
          <div className="flex items-center gap-2">
            {legacy.length > 0 && <Dropdown align="right" trigger={({ open: expanded, toggle }) => <Button size="sm" variant="ghost" aria-label="归档记录类型" aria-expanded={expanded} onClick={toggle}>{source === 'legacy' ? '旧版记录' : '会话归档'}<ChevronDown size={13} /></Button>}>{(close) => <>
              <DropdownItem selected={source === 'conversations'} onClick={() => { changeSource('conversations'); close() }}>会话归档</DropdownItem>
              <DropdownItem selected={source === 'legacy'} onClick={() => { changeSource('legacy'); close() }}>旧版记录 · 只读</DropdownItem>
            </>}</Dropdown>}
            <Button size="sm" variant="ghost" disabled={loading} aria-label="刷新归档" onClick={() => void refresh()}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></Button>
            <Button size="sm" variant="ghost" aria-label="关闭归档管理" onClick={onClose}><X size={15} /></Button>
          </div>
        </header>
        <SearchInput value={query} onChange={(value) => { hover.dismiss(); setQuery(value); setPage(0) }} placeholder={source === 'legacy' ? '搜索旧版记录标题' : '搜索归档标题或摘要'} />
        <div className="acp-search-palette mt-3">
          <div className="acp-search-results my-scrollbar" aria-label={source === 'legacy' ? '旧版记录' : '归档会话列表'}>
            {loading && <p className="acp-search-empty" role="status">正在读取归档…</p>}
            {sourceError && <p className="acp-search-error" role="alert">{sourceError}<button type="button" disabled={loading} onClick={() => void refresh()}>重试</button></p>}
            {!loading && !sourceError && count === 0 && <p className="acp-search-empty">{search ? '没有找到匹配的记录' : source === 'legacy' ? '暂无旧版记录' : '暂无归档会话'}</p>}
            {source === 'legacy' ? legacyVisible.map((item) => <ConversationListRow key={item.id} id={item.id} title={item.title} selected={false} onSelect={() => chooseLegacy(item.id)}
              status={<time className="my-item-description shrink-0" dateTime={new Date(item.updatedAt).toISOString()} title={new Date(item.updatedAt).toLocaleString()}>{new Date(item.updatedAt).toLocaleDateString()}</time>}
              actions={<Button size="sm" variant="ghost" disabled={loading} aria-label={'读取旧版记录：' + item.title} onClick={() => chooseLegacy(item.id)}>读取</Button>} />) : visible.map((item) => <ConversationListRow key={item.id} id={item.id} title={item.title} selected={false}
              previewId={hover.preview?.id === item.id ? hover.id : undefined} onPreview={(element) => { previewHost.current = element.closest('.my-modal-backdrop'); hover.schedule({ id: item.id, title: item.title, summary: item.conversationPreview?.trim() || (item.nativeRef ? '摘要尚未读取' : '草稿'), time: item.archivedAt ?? item.updatedAt, metadata: item.kind === 'code' ? 'Code 会话' : '对话' }, element) }} onDismissPreview={hover.dismiss} onSelect={() => choose(item)}
              status={<time className="my-item-description shrink-0" dateTime={new Date(item.archivedAt ?? item.updatedAt).toISOString()} title={new Date(item.archivedAt ?? item.updatedAt).toLocaleString()}>{new Date(item.archivedAt ?? item.updatedAt).toLocaleDateString()}</time>}
              error={actionErrors[item.id] || managementErrors[item.id]}
              actions={<div className="flex shrink-0 items-center gap-1"><Button size="sm" variant="ghost" disabled={loading || managementBusy[item.id]} aria-label={'读取归档：' + item.title} onClick={() => choose(item)}>读取</Button><Button size="sm" variant="ghost" disabled={loading || managementBusy[item.id]} aria-label={'恢复会话：' + item.title} onClick={() => void restore(item.id)}>{managementBusy[item.id] ? <Loader2 size={14} className="animate-spin" /> : <ArchiveRestore size={14} />}恢复</Button></div>} />)}
          </div>
        </div>
        {source !== 'legacy' && legacyError && <p className="mt-2 text-my-sm text-my-danger-text" role="alert">{legacyError}<Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>重试</Button></p>}
        <footer className="mt-3 flex items-center justify-between gap-3">
          <span className="my-item-description" role="status">{loading ? '读取中…' : sourceError ? '读取失败' : `${count} 条记录`}</span>
          <div className="flex items-center gap-2"><Button size="sm" variant="ghost" disabled={loading || currentPage === 0} onClick={() => { hover.dismiss(); setPage(currentPage - 1) }}>上一页</Button><span className="my-item-description">{currentPage + 1} / {lastPage + 1}</span><Button size="sm" variant="ghost" disabled={loading || currentPage >= lastPage} onClick={() => { hover.dismiss(); setPage(currentPage + 1) }}>下一页</Button></div>
        </footer>
      </section>
    </Modal>
    <ConversationListPreview id={hover.id} preview={hover.preview && previewHost.current?.isConnected ? { ...hover.preview, host: previewHost.current } : null} />
  </>
}
