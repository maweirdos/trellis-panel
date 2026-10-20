import { ModuleLinks } from '../my/layout/ModuleLinks'
import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { Archive, ArchiveRestore, ChevronDown, Ellipsis, Loader2, Pencil, Pin, PinOff, Plus, Search, X } from 'lucide-react'
import { clsx } from 'clsx'
import { Button, Dropdown, DropdownItem, Modal } from '../my/ui'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import { projectRootKey } from '../my/navigation'
import { SidebarResizeHandle } from '../my/layout/SidebarResizeHandle'
import { useEscLayer } from '../utils/use-esc-layer'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { conversationSummary, isDiagnosticConversation } from './conversation-selection'
import { compareConversationSessions, conversationManagement, type ConversationArchive, type ConversationUpdate } from './useConversationHistory'
import type { AcpHistorySummary } from '../../../shared/acp-history'
import type { AcpSessionRecord } from '../../../shared/types'
import type { WorkspaceView } from './view-state'

interface HoverPreview { session: AcpSessionRecord; left: number; top: number; host: Element }

function ConversationSearch({ sessions, archive, onSelect, onClose }: { sessions: AcpSessionRecord[]; archive: ConversationArchive; onSelect: (id: string) => void; onClose: () => void }): JSX.Element {
  const root = useApp((state) => state.snapshot?.meta.root ?? '')
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AcpSessionRecord[]>(sessions)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const request = useRef({ serial: 0, live: true, busy: false })
  const currentQuery = useRef(query)
  currentQuery.current = query
  const composing = useRef(false)
  const listId = useId()
  const valid = (serial: number): boolean => request.current.live && serial === request.current.serial && currentQuery.current === query && canInteract() && projectRootKey(useApp.getState().snapshot?.meta.root ?? '') === projectRootKey(root)
  const load = async (after?: string): Promise<void> => {
    if (!interactive || (after && request.current.busy)) return
    const serial = after ? request.current.serial : ++request.current.serial
    request.current.busy = true; setLoading(true); setError('')
    try {
      if (hasIpc && typeof api.acpHistoryList === 'function') {
        const result = await api.acpHistoryList({ query: query.trim(), cursor: after, limit: 30, archive })
        if (!valid(serial)) return
        if (!result.ok) { setError(result.error); setCursor(null); if (after) setResults([]); return }
        const incoming = result.sessions.filter((session) => projectRootKey(session.projectRoot) === projectRootKey(root)).map((session) => ({ ...session, events: [] }))
        setResults((prior) => after ? [...prior, ...incoming.filter((session) => !prior.some((existing) => existing.sessionId === session.sessionId))] : incoming)
        setCursor(result.nextCursor)
      } else {
        const normalized = query.trim().toLocaleLowerCase()
        setResults(sessions.filter((session) => [session.title, session.agentName, session.agentId, session.profileSnapshot?.name, session.taskDir].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalized)))
        setCursor(null)
      }
      if (!after) setSelected(0)
    } catch (cause) { if (valid(serial)) { setError(cause instanceof Error ? cause.message : '搜索暂时不可用，请重试。'); setCursor(null); if (after) setResults([]) } }
    finally { if (valid(serial)) { request.current.busy = false; setLoading(false) } }
  }
  useEffect(() => { request.current.live = true; return () => { request.current.live = false; request.current.serial++ } }, [])
  useEffect(() => {
    request.current.serial++
    if (!query.trim()) { setResults(sessions); setError(''); setCursor(null); setLoading(false); setSelected(0) }
    else { setResults([]); setError(''); setCursor(null); setLoading(true) }
    const timer = window.setTimeout(() => { void load() }, query ? 120 : 0)
    return () => { window.clearTimeout(timer); request.current.serial++; request.current.busy = false }
  }, [query, root, interactive, archive])
  useEffect(() => {
    setResults((previous) => previous.map((session) => {
      const updated = sessions.find((candidate) => candidate.sessionId === session.sessionId)
      return updated ? { ...session, ...conversationManagement(updated) } : session
    }).filter((session) => archive === 'archived' ? !!session.archivedAt : !session.archivedAt).sort(compareConversationSessions))
  }, [sessions, archive])
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: 'nearest' }) }, [selected])
  const changeQuery = (value: string): void => {
    currentQuery.current = value; request.current.serial++; request.current.busy = false
    setQuery(value); setResults([]); setCursor(null); setError(''); setSelected(0); setLoading(true)
  }
  const choose = (id: string): void => { if (!canInteract() || loading || projectRootKey(useApp.getState().snapshot?.meta.root ?? '') !== projectRootKey(root)) return; onClose(); onSelect(id) }
  return <section className="acp-search-palette" aria-label="搜索会话">
    <div className="acp-search-input"><Search size={18} aria-hidden="true" /><input autoFocus ref={inputRef} role="combobox" aria-label="搜索会话标题、角色或任务" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={results[selected] ? `${listId}-${selected}` : undefined} value={query} placeholder="搜索会话" onChange={(event) => changeQuery(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === 'Escape') event.stopPropagation(); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((index) => results.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length : 0) }
      else if (event.key === 'Enter' && !loading && results[selected]) { event.preventDefault(); choose(results[selected].sessionId) }
    }} /><button type="button" className="my-icon-control" aria-label={query ? '清空会话搜索' : '关闭会话搜索'} onClick={() => { if (query) { changeQuery(''); inputRef.current?.focus() } else onClose() }}><X size={16} /></button></div>
    <div className="acp-search-caption">{query.trim() ? '会话搜索结果' : '最近会话'}</div>
    <div id={listId} role="listbox" aria-label="会话搜索结果" className="acp-search-results my-scrollbar">
      {results.map((session, index) => <button key={session.sessionId} ref={index === selected ? selectedRef : undefined} id={`${listId}-${index}`} type="button" role="option" aria-selected={index === selected} disabled={loading} className={clsx('acp-search-result', index === selected && 'is-selected')} onMouseEnter={() => setSelected(index)} onFocus={() => setSelected(index)} onClick={() => choose(session.sessionId)}><span><strong>{session.title ?? session.profileSnapshot?.name ?? session.agentName}</strong><small>{session.profileSnapshot?.name ? `${session.profileSnapshot.name} · ` : ''}{session.agentName}{session.taskDir ? ` · ${session.taskDir}` : ''}</small></span>{session.pinnedAt && <Pin size={12} aria-label="已置顶" />}<time>{new Date(session.startedAt).toLocaleDateString([], { month: 'numeric', day: 'numeric' })}</time></button>)}
      {!results.length && !loading && !error && <p className="acp-search-empty">没有找到匹配的会话</p>}
      {loading && <p className="acp-search-empty" role="status">正在搜索…</p>}
      {error && <p className="acp-search-error" role="alert">{error}<button type="button" onClick={() => void load()}>重试</button></p>}
      {cursor && <Button size="sm" variant="ghost" className="acp-load-more" disabled={loading} onClick={() => void load(cursor)}>加载更多会话</Button>}
    </div>
    <div className="acp-search-footer"><span>搜索当前项目的标题、角色与任务</span><span>↑↓ 选择　Enter 打开</span></div>
  </section>
}

export function ConversationNavigation({ sessions, activeId, view, onView, onSelect, onNew, open, onClose, collapsed = false, query = '', onQuery, hasMore = false, loadingMore = false, onLoadMore, archive = 'active', onArchive, canManage = false, mutationBusy = {}, mutationErrors = {}, onUpdate }: {
  sessions: AcpSessionRecord[]; activeId: string | null; view: WorkspaceView
  onView: (view: WorkspaceView) => void; onSelect: (sessionId: string) => void; onNew: () => void
  open: boolean; onClose: () => void
  collapsed?: boolean
  query?: string; onQuery?: (query: string) => void
  hasMore?: boolean; loadingMore?: boolean; onLoadMore?: () => void
  archive?: ConversationArchive; onArchive?: (archive: ConversationArchive) => void
  canManage?: boolean; mutationBusy?: Record<string, boolean>; mutationErrors?: Record<string, string>
  onUpdate?: (id: string, patch: ConversationUpdate) => Promise<AcpHistorySummary | null>
}): JSX.Element {
  const root = useApp((state) => state.snapshot?.meta.root ?? '')
  const [searchOpen, setSearchOpen] = useState(false)
  const [diagnostics, setDiagnostics] = useState(false)
  const searchTriggerRef = useRef<HTMLButtonElement>(null)
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const interactionSignal = useInteractionSignal()
  const owner = useMemo(() => ({ root, activeId, view, interactive, interactionSignal }), [root, activeId, view, interactive, interactionSignal])
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const [rename, setRename] = useState<{ sessionId: string; owner: typeof owner } | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [renameError, setRenameError] = useState('')
  const renameComposing = useRef(false)
  const renameInputId = useId()
  const renameErrorId = useId()
  const [preview, setPreview] = useState<HoverPreview | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hovered = useRef<string | null>(null)
  const tooltipId = useId()
  const dismiss = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null; hovered.current = null; setPreview(null)
  }
  useEscLayer(preview !== null && (!collapsed || open), { kind: 'modal', id: `acp-hover-${tooltipId}`, onClose: dismiss })
  useEffect(() => {
    window.addEventListener('scroll', dismiss, true); window.addEventListener('resize', dismiss)
    return () => { if (timer.current) clearTimeout(timer.current); window.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss) }
  }, [])
  useEffect(dismiss, [activeId, view, open, interactive, collapsed, archive, root])
  useEffect(() => { if (!interactive) setSearchOpen(false) }, [interactive])
  useEffect(() => { setRename(null); setRenameError('') }, [owner])
  const openRename = (session: AcpSessionRecord): void => {
    if (!canInteract() || mutationBusy[session.sessionId]) return
    dismiss()
    renameComposing.current = false
    const title = session.title ?? session.profileSnapshot?.name ?? `${session.agentName} 会话`
    setRename({ sessionId: session.sessionId, owner }); setRenameTitle(title); setRenameError('')
  }
  const saveRename = async (): Promise<void> => {
    if (!rename || rename.owner !== ownerRef.current || !canInteract() || mutationBusy[rename.sessionId] || !onUpdate) return
    const title = renameTitle.trim()
    if (!title || title.length > 200) { setRenameError('请输入 1–200 个字符的会话标题。'); return }
    setRenameError('')
    const result = await onUpdate(rename.sessionId, { title })
    if (result && rename.owner === ownerRef.current && canInteract()) setRename((current) => current === rename ? null : current)
  }
  const closeSearch = (): void => { if (!canInteract()) return; setSearchOpen(false) }
  const schedule = (session: AcpSessionRecord, element: HTMLButtonElement): void => {
    if (!canInteract() || (collapsed && !open)) return
    dismiss(); hovered.current = session.sessionId
    const rect = element.getBoundingClientRect(), host = element.closest('.my-root') ?? document.body
    timer.current = setTimeout(() => {
      if (!canInteract() || (collapsed && !open) || hovered.current !== session.sessionId || !element.isConnected) return
      const width = 260, height = 110, gap = 10
      const left = rect.right + gap + width <= window.innerWidth - gap ? rect.right + gap : Math.max(gap, rect.left - width - gap)
      setPreview({ session, left, top: Math.max(gap, Math.min(rect.top - 4, window.innerHeight - height - gap)), host })
    }, 350)
  }
  const recent = sessions.filter((session) => (archive === 'archived' ? !!session.archivedAt : !session.archivedAt) && (diagnostics ? isDiagnosticConversation(session) : !isDiagnosticConversation(session))).sort(compareConversationSessions)
  const row = (session: AcpSessionRecord): JSX.Element => <div key={session.sessionId} className="acp-recent-item">
    <button type="button" data-acp-session={session.sessionId} className={clsx('acp-recent-row my-nav-item', activeId === session.sessionId && view === 'conversation' && 'is-selected')} aria-current={activeId === session.sessionId && view === 'conversation' ? 'page' : undefined} aria-describedby={preview?.session.sessionId === session.sessionId ? tooltipId : undefined} onMouseEnter={(event) => schedule(session, event.currentTarget)} onMouseLeave={dismiss} onFocus={(event) => schedule(session, event.currentTarget)} onBlur={dismiss} onClick={() => { dismiss(); onSelect(session.sessionId) }}>
    <span>{session.title ?? session.profileSnapshot?.name ?? `${session.agentName} 会话`}</span>
    {session.pinnedAt && <Pin size={12} className="acp-recent-pin" aria-label="已置顶" />}
    </button>
    {canManage && onUpdate && <Dropdown align="right" width={192} className="acp-recent-menu" trigger={({ open: expanded, toggle }) => <button type="button" data-session-id={session.sessionId} className="acp-recent-menu-trigger my-icon-control" aria-label={`会话操作：${session.title ?? session.profileSnapshot?.name ?? `${session.agentName} 会话`}`} aria-expanded={expanded} aria-haspopup="menu" aria-busy={mutationBusy[session.sessionId] || undefined} disabled={mutationBusy[session.sessionId]} onFocus={dismiss} onMouseEnter={dismiss} onClick={() => { dismiss(); toggle() }}>{mutationBusy[session.sessionId] ? <Loader2 size={15} className="animate-spin" /> : <Ellipsis size={15} />}</button>}>{(close) => <>
      <DropdownItem icon={<Pencil size={14} />} disabled={mutationBusy[session.sessionId]} onClick={() => { close(); openRename(session) }}>重命名</DropdownItem>
      <DropdownItem icon={session.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />} disabled={mutationBusy[session.sessionId]} onClick={() => { close(); void onUpdate(session.sessionId, { pinned: !session.pinnedAt }) }}>{session.pinnedAt ? '取消置顶' : '置顶'}</DropdownItem>
      <DropdownItem icon={session.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />} disabled={mutationBusy[session.sessionId]} onClick={() => { close(); void onUpdate(session.sessionId, { archived: !session.archivedAt }) }}>{session.archivedAt ? '取消归档' : '归档'}</DropdownItem>
    </>}</Dropdown>}
    {mutationErrors[session.sessionId] && rename?.sessionId !== session.sessionId && <p role="alert" className="acp-session-menu-error">{mutationErrors[session.sessionId]}</p>}
  </div>
  return <>
    {open && <button className="acp-sidebar-scrim" aria-label="关闭会话导航" onClick={onClose} />}
    <aside className={clsx('my-context-sidebar acp-navigation', open && 'is-open')} aria-label="角色与会话导航">
      <div className="acp-navigation-title"><Dropdown trigger={({ open: expanded, toggle }) => <button type="button" className="acp-module-switch" aria-label="切换智能体模块" aria-expanded={expanded} onClick={toggle}><strong>{view === 'agents' ? '角色' : '对话'}</strong><ChevronDown size={13} /></button>}>{(close) => <div onClick={close}><ModuleLinks domain="agents" agentView={view === 'agents' ? 'roles' : 'conversation'} onAgentView={(next) => { dismiss(); onView(next === 'roles' ? 'agents' : 'conversation') }} /></div>}</Dropdown><div className="flex-1" /><button ref={searchTriggerRef} type="button" className="my-icon-control" aria-label="搜索全部会话" title="搜索会话标题、角色与任务" aria-expanded={searchOpen} onClick={() => setSearchOpen(true)}><Search size={15} /></button><Button size="sm" variant="ghost" className="acp-mobile-only" title="关闭会话导航" onClick={onClose}><X size={14} /></Button></div>
      <div className="acp-navigation-primary"><button className="my-nav-item" onClick={onNew}><Plus size={15} />新建对话</button></div>
      <div className="acp-navigation-label"><span>{diagnostics ? '诊断记录' : archive === 'archived' ? '已归档会话' : '会话'}</span><Dropdown align="right" trigger={({ open: expanded, toggle }) => <button type="button" className="acp-list-filter" aria-label="会话列表筛选" aria-expanded={expanded} onClick={toggle}>{diagnostics ? '诊断' : archive === 'archived' ? '已归档' : '全部'}<ChevronDown size={11} /></button>}>{(close) => <div className="acp-list-filter-options"><DropdownItem selected={!diagnostics && archive === 'active'} onClick={() => { dismiss(); setDiagnostics(false); onArchive?.('active'); close() }}>全部对话</DropdownItem>{onArchive && <DropdownItem selected={!diagnostics && archive === 'archived'} icon={<Archive size={14} />} onClick={() => { dismiss(); setDiagnostics(false); onArchive('archived'); close() }}>已归档</DropdownItem>}<DropdownItem selected={diagnostics} onClick={() => { dismiss(); setDiagnostics(true); onArchive?.('active'); close() }}>诊断记录</DropdownItem></div>}</Dropdown></div>
      <div className="acp-navigation-scroll my-scrollbar" onScroll={dismiss}>{recent.map(row)}{recent.length === 0 && <p className="px-3 py-3 text-my-sm text-my-tertiary">暂无匹配的会话</p>}
        {hasMore && <Button size="sm" variant="ghost" className="acp-load-more" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? '正在加载…' : '加载更早的会话'}</Button>}
      </div>
      <SidebarResizeHandle label="调整会话侧栏宽度" />
    </aside>
    <Modal open={searchOpen} onClose={closeSearch} width={620} ariaLabel="搜索会话" placement="center"><ConversationSearch sessions={sessions.filter((session) => archive === 'archived' ? !!session.archivedAt : !session.archivedAt)} archive={archive} onSelect={onSelect} onClose={closeSearch} /></Modal>
    <Modal open={!!rename && rename.owner === owner && interactive} onClose={() => setRename(null)} width={440} ariaLabel="重命名会话" placement="center">
      <form className="p-5" onSubmit={(event) => { event.preventDefault(); if (!renameComposing.current) void saveRename() }}>
        <h2 className="mb-4 text-my-lg font-medium text-my-primary">重命名会话</h2>
        <label htmlFor={renameInputId} className="mb-2 block text-my-sm text-my-secondary">会话标题</label>
        <input id={renameInputId} autoFocus className="my-input w-full" aria-label="会话标题" aria-invalid={!!(renameError || (rename && mutationErrors[rename.sessionId]))} aria-describedby={renameErrorId} value={renameTitle} onChange={(event) => { setRenameTitle(event.target.value); setRenameError('') }} onCompositionStart={() => { renameComposing.current = true }} onCompositionEnd={() => { renameComposing.current = false }} onKeyDown={(event) => { if (event.key === 'Enter' && (renameComposing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); if (event.key === 'Escape' && (renameComposing.current || event.nativeEvent.isComposing)) event.stopPropagation() }} />
        <p id={renameErrorId} role={renameError || (rename && mutationErrors[rename.sessionId]) ? 'alert' : undefined} className="mt-2 text-my-sm text-my-danger-text">{renameError || (rename && mutationErrors[rename.sessionId])}</p>
        <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onClick={() => setRename(null)}>取消</Button><Button onClick={() => void saveRename()} variant="primary" disabled={!!rename && mutationBusy[rename.sessionId]}>{rename && mutationBusy[rename.sessionId] && <Loader2 size={14} className="animate-spin" />}保存</Button></div>
      </form>
    </Modal>
    {preview && interactive && (!collapsed || open) && createPortal(<div role="tooltip" id={tooltipId} className="acp-recent-tooltip" style={{ left: preview.left, top: preview.top }}><div><strong>{preview.session.title ?? preview.session.agentName}</strong><time>{new Date(preview.session.startedAt).toLocaleString([], { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div><p>{conversationSummary(preview.session)}</p><small>{preview.session.profileSnapshot?.name ? `${preview.session.profileSnapshot.name} · ` : ''}{preview.session.agentName}{preview.session.taskDir ? ` · ${preview.session.taskDir}` : ' · 未关联任务'}</small></div>, preview.host)}
  </>
}
