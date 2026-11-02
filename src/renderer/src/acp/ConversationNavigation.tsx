import { ModuleLinks } from '../my/layout/ModuleLinks'
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ConversationSearch as ConversationSearchView } from './ConversationSearch'
import { ConversationListRow, ConversationListPreview, ConversationRenameDialog, useConversationListPreview } from './ConversationListRow'
import { Archive, ArchiveRestore, ChevronDown, Ellipsis, Loader2, Pencil, Pin, PinOff, Plus, Search, Sparkles, Trash2 } from 'lucide-react'

import { Button, Dropdown, DropdownItem, Modal } from '../my/ui'
import { api, hasIpc } from '../api'
import { useApp } from '../store'
import { projectRootKey } from '../my/navigation'
import { ConversationSidebar } from './ConversationSidebar'

import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { conversationSummary, isDiagnosticConversation } from './conversation-selection'
import { compareConversationSessions, conversationManagement, type ConversationArchive, type ConversationUpdate } from './useConversationHistory'
import type { AcpHistorySummary } from '../../../shared/acp-history'
import type { AcpSessionRecord } from '../../../shared/types'
import type { WorkspaceView } from './view-state'

function ProjectConversationSearch({ sessions, archive, onSelect, onClose }: { sessions: AcpSessionRecord[]; archive: ConversationArchive; onSelect: (id: string) => void; onClose: () => void }): JSX.Element {
  const root = useApp((state) => state.snapshot?.meta.root ?? '')
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AcpSessionRecord[]>(sessions)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(0)

  const request = useRef({ serial: 0, live: true, busy: false })
  const currentQuery = useRef(query)
  currentQuery.current = query

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

  const changeQuery = (value: string): void => {
    currentQuery.current = value; request.current.serial++; request.current.busy = false
    setQuery(value); setResults([]); setCursor(null); setError(''); setSelected(0); setLoading(true)
  }
  const choose = (id: string): void => { if (!canInteract() || loading || projectRootKey(useApp.getState().snapshot?.meta.root ?? '') !== projectRootKey(root)) return; onClose(); onSelect(id) }
  return <ConversationSearchView entries={results.map((session) => ({ id: session.sessionId, title: session.title ?? session.profileSnapshot?.name ?? session.agentName, description: <>{session.profileSnapshot?.name ? session.profileSnapshot.name + ' · ' : ''}{session.agentName}{session.taskDir ? ' · ' + session.taskDir : ''}</>, pinned: !!session.pinnedAt, time: session.startedAt }))} query={query} selected={selected} loading={loading} error={error} hasMore={!!cursor} onQuery={changeQuery} onSelected={setSelected} onSelect={choose} onClose={onClose} onRetry={() => void load()} onLoadMore={() => void load(cursor ?? undefined)} />
}

export function ConversationNavigation({ sessions, activeId, view, onView, onSelect, onNew, open, onClose, collapsed = false, query = '', onQuery, hasMore = false, loadingMore = false, onLoadMore, archive = 'active', onArchive, canManage = false, mutationBusy = {}, mutationErrors = {}, onUpdate, onDelete, onRegenerateTitle }: {
  sessions: AcpSessionRecord[]; activeId: string | null; view: WorkspaceView
  onView: (view: WorkspaceView) => void; onSelect: (sessionId: string) => void; onNew: () => void
  open: boolean; onClose: () => void
  collapsed?: boolean
  query?: string; onQuery?: (query: string) => void
  hasMore?: boolean; loadingMore?: boolean; onLoadMore?: () => void
  archive?: ConversationArchive; onArchive?: (archive: ConversationArchive) => void
  canManage?: boolean; mutationBusy?: Record<string, boolean>; mutationErrors?: Record<string, string>
  onUpdate?: (id: string, patch: ConversationUpdate) => Promise<AcpHistorySummary | null>
  onDelete?: (id: string) => Promise<boolean>
  onRegenerateTitle?: (id: string) => Promise<AcpHistorySummary | null>
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

  const hover = useConversationListPreview(JSON.stringify([root, activeId, view, open, interactive, collapsed, archive]), interactive && (!collapsed || open))
  const dismiss = hover.dismiss
  useEffect(() => { if (!interactive) setSearchOpen(false) }, [interactive])
  useEffect(() => { setRename(null); setRenameError('') }, [owner])
  const openRename = (session: AcpSessionRecord): void => {
    if (!canInteract() || mutationBusy[session.sessionId]) return
    dismiss()

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

  const recent = sessions.filter((session) => (archive === 'archived' ? !!session.archivedAt : !session.archivedAt) && (diagnostics ? isDiagnosticConversation(session) : !isDiagnosticConversation(session))).sort(compareConversationSessions)
  const row = (session: AcpSessionRecord): JSX.Element => <ConversationListRow key={session.sessionId} id={session.sessionId} title={session.title ?? session.profileSnapshot?.name ?? session.agentName + ' 会话'} selected={activeId === session.sessionId && view === 'conversation'} pinned={!!session.pinnedAt} previewId={hover.preview?.id === session.sessionId ? hover.id : undefined} onPreview={(element) => hover.schedule({ id: session.sessionId, title: session.title ?? session.agentName, summary: conversationSummary(session), time: session.startedAt, metadata: <>{session.profileSnapshot?.name ? session.profileSnapshot.name + ' · ' : ''}{session.agentName}{session.taskDir ? ' · ' + session.taskDir : ' · 未关联任务'}</> }, element)} onDismissPreview={dismiss} onSelect={() => onSelect(session.sessionId)} error={rename?.sessionId === session.sessionId ? undefined : mutationErrors[session.sessionId]} actions={<>{canManage && onUpdate && <Dropdown align="right" width={192} className="acp-recent-menu" trigger={({ open: expanded, toggle }) => <button type="button" data-session-id={session.sessionId} className="acp-recent-menu-trigger my-icon-control" aria-label={`会话操作：${session.title ?? session.profileSnapshot?.name ?? `${session.agentName} 会话`}`} aria-expanded={expanded} aria-haspopup="menu" aria-busy={mutationBusy[session.sessionId] || undefined} disabled={mutationBusy[session.sessionId]} onFocus={dismiss} onMouseEnter={dismiss} onClick={() => { dismiss(); toggle() }}>{mutationBusy[session.sessionId] ? <Loader2 size={15} className="animate-spin" /> : <Ellipsis size={15} />}</button>}>{(close) => <>
      <DropdownItem icon={<Pencil size={14} />} disabled={mutationBusy[session.sessionId] || !!session.deletionState} onClick={() => { close(); openRename(session) }}>重命名</DropdownItem>
      {onRegenerateTitle && <DropdownItem icon={<Sparkles size={14} />} disabled={mutationBusy[session.sessionId] || !!session.customTitle || !!session.deletionState} onClick={() => { close(); if (canInteract()) void onRegenerateTitle(session.sessionId) }}>{session.customTitle ? '手动标题' : '重新生成标题'}</DropdownItem>}
      <DropdownItem icon={session.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />} disabled={mutationBusy[session.sessionId]} onClick={() => { close(); void onUpdate(session.sessionId, { pinned: !session.pinnedAt }) }}>{session.pinnedAt ? '取消置顶' : '置顶'}</DropdownItem>
      <DropdownItem icon={session.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />} disabled={mutationBusy[session.sessionId]} onClick={() => { close(); void onUpdate(session.sessionId, { archived: !session.archivedAt }) }}>{session.archivedAt ? '取消归档' : '归档'}</DropdownItem>
      {onDelete && <DropdownItem danger icon={<Trash2 size={14} />} disabled={mutationBusy[session.sessionId]} onClick={() => { close(); dismiss(); if (canInteract()) void onDelete(session.sessionId) }}>{session.deletionState ? '重试永久删除' : '永久删除…'}</DropdownItem>}
    </>}</Dropdown>}</>} />
  return <>
    <ConversationSidebar open={open} onClose={onClose} onScroll={dismiss}
      title={<Dropdown trigger={({ open: expanded, toggle }) => <button type="button" className="acp-module-switch" aria-label="切换对话模块" aria-expanded={expanded} onClick={toggle}><strong>{view === 'agents' ? '角色' : '对话'}</strong><ChevronDown size={13} /></button>}>{(close) => <div onClick={close}><ModuleLinks domain="agents" agentView={view === 'agents' ? 'roles' : 'conversation'} onAgentView={(next) => { dismiss(); onView(next === 'roles' ? 'agents' : 'conversation') }} /></div>}</Dropdown>}
      actions={<button ref={searchTriggerRef} type="button" className="my-icon-control" aria-label="搜索全部会话" title="搜索会话标题、角色与任务" aria-expanded={searchOpen} onClick={() => setSearchOpen(true)}><Search size={15} /></button>}
      primaryAction={<button className="my-nav-item" onClick={onNew}><Plus size={15} />新建对话</button>}
      label={<><span>{diagnostics ? '诊断记录' : archive === 'archived' ? '已归档会话' : '会话'}</span><Dropdown align="right" trigger={({ open: expanded, toggle }) => <button type="button" className="acp-list-filter" aria-label="会话列表筛选" aria-expanded={expanded} onClick={toggle}>{diagnostics ? '诊断' : archive === 'archived' ? '已归档' : '全部'}<ChevronDown size={11} /></button>}>{(close) => <div className="acp-list-filter-options"><DropdownItem selected={!diagnostics && archive === 'active'} onClick={() => { dismiss(); setDiagnostics(false); onArchive?.('active'); close() }}>全部对话</DropdownItem>{onArchive && <DropdownItem selected={!diagnostics && archive === 'archived'} icon={<Archive size={14} />} onClick={() => { dismiss(); setDiagnostics(false); onArchive('archived'); close() }}>已归档</DropdownItem>}<DropdownItem selected={diagnostics} onClick={() => { dismiss(); setDiagnostics(true); onArchive?.('active'); close() }}>诊断记录</DropdownItem></div>}</Dropdown></>}
    >
      {recent.map(row)}{recent.length === 0 && <p className="px-3 py-3 text-my-sm text-my-tertiary">暂无匹配的会话</p>}
      {hasMore && <Button size="sm" variant="ghost" className="acp-load-more" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? '正在加载…' : '加载更早的会话'}</Button>}
    </ConversationSidebar>
    <Modal open={searchOpen} onClose={closeSearch} width={620} ariaLabel="搜索会话" placement="center"><ProjectConversationSearch sessions={sessions.filter((session) => archive === 'archived' ? !!session.archivedAt : !session.archivedAt)} archive={archive} onSelect={onSelect} onClose={closeSearch} /></Modal>
    <ConversationRenameDialog open={!!rename && rename.owner === owner && interactive} title={renameTitle} error={renameError || (rename ? mutationErrors[rename.sessionId] : undefined)} busy={!!rename && mutationBusy[rename.sessionId]} onTitle={(value) => { setRenameTitle(value); setRenameError('') }} onClose={() => setRename(null)} onSave={() => void saveRename()} />
    <ConversationListPreview id={hover.id} preview={hover.preview} />
  </>
}
