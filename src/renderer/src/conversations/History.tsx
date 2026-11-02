import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { Archive, ChevronDown, ChevronRight, Ellipsis, Folder, Loader2, Pencil, Pin, PinOff, Plus, RefreshCw, Search } from 'lucide-react'
import { clsx } from 'clsx'
import type { Conversation } from '@shared/private-conversations'
import { ConversationSidebar } from '../acp/ConversationSidebar'
import { ConversationListRow, ConversationListPreview, ConversationRenameDialog, useConversationListPreview } from '../acp/ConversationListRow'
import { ConversationSearch } from '../acp/ConversationSearch'
import { Button, Dropdown, DropdownItem, Modal } from '../my/ui'
import { ModuleLinks } from '../my/layout/ModuleLinks'
import { useMy } from '../my/store'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { conversationError } from './client'
import { createProject, refreshWorkspace, scopeKey, updateConversation, useConversations, type ConversationKind, type WorkspaceEntry } from './workspace'

const HISTORY_BATCH = 50
type HistoryRow = { kind: 'conversation'; value: Conversation } | { kind: 'draft'; value: WorkspaceEntry }
interface DisplayBatches { key: string; recent: number; search: number; projects: number; groups: Record<string, number> }
const initialBatches = (key: string): DisplayBatches => ({ key, recent: HISTORY_BATCH, search: HISTORY_BATCH, projects: HISTORY_BATCH, groups: {} })
const historyRowKey = (item: HistoryRow): string => item.kind === 'conversation' ? 'conversation:' + item.value.id : 'draft:' + item.value.key
const historyRowTitle = (item: HistoryRow): string => item.kind === 'conversation' ? item.value.title : item.value.text.slice(0, 200).split('\n', 1)[0] || '图片草稿'
const historyPreview = (conversation: Conversation): string => conversation.conversationPreview?.trim() || (conversation.nativeRef ? '摘要尚未读取' : '草稿')

/** Keep a distant selection reachable without expanding its entire preceding prefix. */
function batchRows<T>(items: readonly T[], limit: number, selected: string | undefined, key: (item: T) => string): { visible: T[]; remaining: number } {
  const visible = items.slice(0, limit)
  if (selected && !visible.some((item) => key(item) === selected)) {
    const selectedItem = items.find((item) => key(item) === selected)
    if (selectedItem) visible.push(selectedItem)
  }
  return { visible, remaining: items.length - visible.length }
}

export function ConversationHistory({ kind, selected, projectId, open, onProject, onSelect, onNew, onClose }: {
  kind: ConversationKind; selected: string; projectId?: string; open: boolean
  onProject(projectId?: string): void; onSelect(conversation: Conversation): void; onNew(projectId?: string): void; onClose(): void
}): JSX.Element {
  const state = useConversations(), canInteract = useInteractionGuard(), interactive = useInteractionActive(), signal = useInteractionSignal()
  const sidebarCollapsed = useMy((value) => value.sidebarCollapsed)
  const [query, setQuery] = useState(''), [searchOpen, setSearchOpen] = useState(false), [searchIndex, setSearchIndex] = useState(0)
  const [projectOpen, setProjectOpen] = useState(false), [name, setName] = useState(''), [saving, setSaving] = useState(false), [projectError, setProjectError] = useState('')
  const projectComposing = useRef(false), projectLock = useRef(false), projectInputId = useId()
  const [rename, setRename] = useState<{ id: string; owner: object } | null>(null), [renameTitle, setRenameTitle] = useState(''), [renameError, setRenameError] = useState('')
  const renameLock = useRef(false)
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const search = query.trim().toLocaleLowerCase()
  const owner = useMemo(() => ({}), [kind, projectId, selected, interactive, signal])
  const ownerRef = useRef(owner); ownerRef.current = owner
  const hover = useConversationListPreview(JSON.stringify([kind, projectId, selected, open, interactive, sidebarCollapsed]), interactive && (!sidebarCollapsed || open))
  const filterKey = JSON.stringify([kind, projectId ?? null, search]), expansionKey = kind
  const [display, setDisplay] = useState<DisplayBatches>(() => initialBatches(filterKey))
  const [expanded, setExpanded] = useState<{ key: string; choices: Record<string, boolean> }>({ key: expansionKey, choices: {} })
  const batches = display.key === filterKey ? display : initialBatches(filterKey)
  const openChoices = expanded.key === expansionKey ? expanded.choices : {}
  const updateBatches = (update: (previous: DisplayBatches) => DisplayBatches): void => setDisplay((previous) => update(previous.key === filterKey ? previous : initialBatches(filterKey)))
  const entries = useMemo(() => Object.values(state.entries), [state.entries])
  const entryByConversation = useMemo(() => {
    const result = new Map<string, WorkspaceEntry>()
    for (const item of entries) if (!item.locked && item.conversation) result.set(item.conversation.id, item)
    return result
  }, [entries])
  const projects = state.projects
  const projectIds = useMemo(() => new Set(projects.map((project) => project.id)), [projects])
  const conversations = useMemo(() => state.conversations.filter((conversation) => conversation.kind === kind && conversation.archivedAt === undefined).sort((left, right) =>
    Number(right.pinnedAt !== undefined) - Number(left.pinnedAt !== undefined) || right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
  ), [state.conversations, kind])
  const localDrafts = useMemo(() => entries.filter((item) => !item.locked && !item.conversation && item.kind === kind && (item.text || item.images?.length)), [entries, kind])
  const rows = useMemo<HistoryRow[]>(() => [...localDrafts.map((value): HistoryRow => ({ kind: 'draft', value })), ...conversations.map((value): HistoryRow => ({ kind: 'conversation', value }))], [localDrafts, conversations])
  const grouped = useMemo(() => {
    const recent: HistoryRow[] = [], projects = new Map<string, HistoryRow[]>()
    for (const item of rows) {
      const id = item.value.projectId
      if (!id || !projectIds.has(id)) recent.push(item)
      else { const group = projects.get(id); if (group) group.push(item); else projects.set(id, [item]) }
    }
    return { recent, projects }
  }, [rows, projectIds])
  const matches = useMemo(() => rows.filter((item) => !search || (historyRowTitle(item) + ' ' + (item.kind === 'conversation' ? item.value.conversationPreview ?? '' : item.value.text)).toLocaleLowerCase().includes(search)), [rows, search])
  const selectedEntry = state.entries[selected], selectedConversationId = selectedEntry?.locked ? undefined : selectedEntry?.conversation?.id
  const selectedRow = selectedConversationId ? 'conversation:' + selectedConversationId : selectedEntry && !selectedEntry.locked ? 'draft:' + selected : undefined
  const selectedGroup = selectedEntry?.locked ? undefined : selectedEntry?.projectId ?? projectId
  const recent = batchRows(grouped.recent, batches.recent, selectedRow, historyRowKey)
  const searchRows = batchRows(matches, batches.search, undefined, historyRowKey)
  const projectRows = batchRows(projects, batches.projects, selectedGroup, (item) => item.id)
  const groupOpen = (id: string): boolean => openChoices['project:' + id] ?? id === selectedGroup
  const setGroupOpen = (id: string, value: boolean): void => setExpanded((previous) => {
    const choices = previous.key === expansionKey ? previous.choices : {}
    const current = choices[id] ?? id === 'project:' + selectedGroup
    return current === value ? previous : { key: expansionKey, choices: { ...choices, [id]: value } }
  })
  useEffect(() => { setProjectOpen(false); setName(''); setProjectError(''); setSearchOpen(false); setQuery(''); setSearchIndex(0) }, [kind])
  useEffect(() => { if (!interactive) { setSearchOpen(false); setProjectOpen(false) } }, [interactive])
  useEffect(() => { setRename(null); setRenameError('') }, [owner])
  useEffect(() => { if (selectedGroup) setGroupOpen('project:' + selectedGroup, true) }, [selectedGroup, expansionKey])
  const choose = (conversation: Conversation): void => { if (canInteract()) { setSearchOpen(false); onSelect(conversation) } }
  const chooseRow = (item: HistoryRow): void => {
    if (!canInteract()) return
    if (item.kind === 'conversation') { choose(item.value); return }
    const draft = useConversations.getState().entries[item.value.key]
    if (!draft || draft.locked || draft.kind !== kind) return
    setSearchOpen(false); onProject(draft.projectId)
    useConversations.setState((current) => ({ selected: { ...current.selected, [scopeKey(kind, draft.projectId)]: draft.key } }))
  }
  const openRename = (conversation: Conversation): void => {
    if (!canInteract() || state.managementBusy[conversation.id]) return
    hover.dismiss(); setRename({ id: conversation.id, owner }); setRenameTitle(conversation.title); setRenameError('')
  }
  const saveRename = async (): Promise<void> => {
    if (!rename || rename.owner !== ownerRef.current || !canInteract() || state.managementBusy[rename.id] || renameLock.current) return
    const title = renameTitle.trim()
    if (!title || title.length > 200) { setRenameError('请输入 1–200 个字符的会话标题。'); return }
    const currentRename = rename
    renameLock.current = true; setRenameError('')
    try {
      const result = await updateConversation(rename.id, { title })
      if (ownerRef.current !== currentRename.owner || !canInteract()) return
      if (result) setRename((current) => current === currentRename ? null : current)
      else setRenameError(useConversations.getState().managementErrors[rename.id] || '保存失败，请重试。')
    } catch (cause) { if (ownerRef.current === currentRename.owner && canInteract()) setRenameError(conversationError(cause)) }
    finally { renameLock.current = false }
  }
  const manage = async (id: string, patch: { pinned?: boolean; archived?: boolean }): Promise<void> => {
    if (!canInteract() || state.managementBusy[id]) return
    const currentOwner = owner
    hover.dismiss(); setActionErrors((previous) => ({ ...previous, [id]: '' }))
    try { await updateConversation(id, patch) }
    catch (cause) { if (ownerRef.current === currentOwner && canInteract()) setActionErrors((previous) => ({ ...previous, [id]: conversationError(cause) })) }
  }
  const row = (item: HistoryRow): JSX.Element => {
    if (item.kind === 'draft') return <ConversationListRow key={historyRowKey(item)} id={item.value.key} title={historyRowTitle(item)} selected={selected === item.value.key} status={<small className="text-my-xs text-my-tertiary">草稿</small>} onSelect={() => chooseRow(item)} />
    const conversation = item.value, local = entryByConversation.get(conversation.id), busy = state.managementBusy[conversation.id]
    const waiting = local?.session?.connectionOwned && local.session.status === 'awaiting_permission'
    const running = local?.action === 'sending' || local?.session?.connectionOwned && ['busy', 'starting', 'cancelling'].includes(local.session.status)
    return <ConversationListRow key={historyRowKey(item)} id={conversation.id} title={conversation.title} selected={selectedConversationId === conversation.id} pinned={conversation.pinnedAt !== undefined}
      previewId={hover.preview?.id === conversation.id ? hover.id : undefined} onPreview={(element) => hover.schedule({ id: conversation.id, title: conversation.title, summary: historyPreview(conversation), time: conversation.updatedAt, metadata: conversation.kind === 'code' ? 'Code 会话' : '对话' }, element)} onDismissPreview={hover.dismiss} onSelect={() => choose(conversation)}
      status={waiting ? <small className="text-my-xs text-my-warning-text">待授权</small> : running ? <Loader2 size={12} className="animate-spin" aria-label="处理中" /> : !conversation.nativeRef ? <small className="text-my-xs text-my-tertiary">草稿</small> : null}
      error={rename?.id === conversation.id ? undefined : actionErrors[conversation.id] || state.managementErrors[conversation.id]}
      actions={<Dropdown align="right" width={192} className="acp-recent-menu" trigger={({ open: expanded, toggle }) => <button type="button" data-session-id={conversation.id} className="acp-recent-menu-trigger my-icon-control" aria-label={'会话操作：' + conversation.title} aria-expanded={expanded} aria-haspopup="menu" aria-busy={busy || undefined} disabled={busy} onFocus={hover.dismiss} onMouseEnter={hover.dismiss} onClick={() => { hover.dismiss(); toggle() }}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Ellipsis size={15} />}</button>}>{(close) => <>
        <DropdownItem icon={<Pencil size={14} />} disabled={busy} onClick={() => { close(); openRename(conversation) }}>重命名</DropdownItem>
        <DropdownItem icon={conversation.pinnedAt !== undefined ? <PinOff size={14} /> : <Pin size={14} />} disabled={busy} onClick={() => { close(); void manage(conversation.id, { pinned: conversation.pinnedAt === undefined }) }}>{conversation.pinnedAt !== undefined ? '取消置顶' : '置顶'}</DropdownItem>
        <DropdownItem icon={<Archive size={14} />} disabled={busy} onClick={() => { close(); void manage(conversation.id, { archived: true }) }}>归档</DropdownItem>
      </>}</Dropdown>}
    />
  }
  const more = (remaining: number, onMore: () => void, label = '加载更多对话', unit = '条'): JSX.Element | null => remaining > 0 ? <Button size="sm" variant="ghost" className="acp-load-more" onClick={() => { if (canInteract()) onMore() }}>{label}（还有 {remaining} {unit}）</Button> : null
  const saveProject = async (): Promise<void> => {
    if (!name.trim() || projectLock.current || !canInteract()) return
    const currentOwner = owner
    projectLock.current = true; setSaving(true); setProjectError('')
    try { await createProject(name.trim()); if (canInteract() && ownerRef.current === currentOwner) { setName(''); setProjectOpen(false) } }
    catch (cause) { if (canInteract() && ownerRef.current === currentOwner) setProjectError(conversationError(cause)) }
    finally { projectLock.current = false; setSaving(false) }
  }
  const openSearch = (): void => { if (!canInteract()) return; hover.dismiss(); setQuery(''); setSearchIndex(0); setSearchOpen(true) }
  const searchEntries = searchRows.visible.map((item) => ({
    id: historyRowKey(item), title: historyRowTitle(item), description: item.kind === 'conversation' ? historyPreview(item.value) : '草稿', pinned: item.kind === 'conversation' && item.value.pinnedAt !== undefined, time: item.kind === 'conversation' ? item.value.updatedAt : item.value.localUpdatedAt
  }))
  return <>
    <ConversationSidebar title={<Dropdown trigger={({ open: expanded, toggle }) => <button type="button" className="acp-module-switch" aria-label="切换对话模块" aria-expanded={expanded} onClick={toggle}><strong>对话</strong><ChevronDown size={13} /></button>}>{(close) => <div onClick={close}><ModuleLinks domain="agents" /></div>}</Dropdown>} open={open} onClose={onClose} ariaLabel="对话历史" resizeLabel="调整对话历史宽度"
      actions={<><button type="button" className="my-icon-control" aria-label="搜索对话" title="搜索对话" aria-expanded={searchOpen} onClick={openSearch}><Search size={15} /></button><button type="button" className="my-icon-control" aria-label="刷新对话历史" title="刷新对话历史" disabled={state.loading} onClick={() => void refreshWorkspace()}><RefreshCw size={14} className={state.loading ? 'animate-spin' : ''} /></button></>}
      primaryAction={<button type="button" className="my-nav-item" onClick={() => { if (canInteract()) onNew() }}><Plus size={15} />新建对话</button>}
      label={<><button type="button" aria-pressed={!projectId} onClick={() => onProject()}>会话</button><Dropdown align="right" trigger={({ open: expanded, toggle }) => <button type="button" className="acp-list-filter" aria-label="会话分组管理" aria-expanded={expanded} onClick={toggle}>分组<ChevronDown size={11} /></button>}>{(close) => <div className="acp-list-filter-options">
        <DropdownItem icon={<Folder size={14} />} onClick={() => { hover.dismiss(); setProjectOpen(true); close() }}>新建分组</DropdownItem>
      </div>}</Dropdown></>}>
      {state.error && <div role="alert" className="acp-search-error">{state.error}<button type="button" onClick={() => void refreshWorkspace()}>重试</button></div>}
        {recent.visible.map(row)}
        {more(recent.remaining, () => updateBatches((previous) => ({ ...previous, recent: previous.recent + HISTORY_BATCH })))}
        {!rows.length && <p className="px-3 py-3 text-my-sm text-my-tertiary">{state.loading && !state.initialized ? '正在读取对话…' : '暂无匹配的会话'}</p>}
        {projectRows.visible.map((project) => {
          const isOpen = groupOpen(project.id)
          const children = isOpen ? batchRows(grouped.projects.get(project.id) ?? [], batches.groups[project.id] ?? HISTORY_BATCH, selectedRow, historyRowKey) : null
          return <details key={project.id} className="private-project-group" open={isOpen} onToggle={(event) => setGroupOpen('project:' + project.id, event.currentTarget.open)}><summary className={clsx('acp-recent-row my-nav-item', projectId === project.id && 'is-selected')} onClick={(event) => { event.preventDefault(); setGroupOpen('project:' + project.id, !isOpen); if (!isOpen) onProject(project.id) }}><ChevronRight size={12} className="private-project-chevron" /><Folder size={14} /><span>{project.name}</span></summary>{children && <div className="private-project-conversations">{children.visible.map(row)}{more(children.remaining, () => updateBatches((previous) => ({ ...previous, groups: { ...previous.groups, [project.id]: (previous.groups[project.id] ?? HISTORY_BATCH) + HISTORY_BATCH } })))}<button type="button" className="acp-recent-row my-nav-item" onClick={() => onNew(project.id)}><Plus size={13} /><span>新对话</span></button></div>}</details>
        })}
        {more(projectRows.remaining, () => updateBatches((previous) => ({ ...previous, projects: previous.projects + HISTORY_BATCH })), '加载更多分组', '个')}
    </ConversationSidebar>
    <Modal open={projectOpen && interactive} onClose={() => setProjectOpen(false)} width={440} ariaLabel="新建分组" placement="center"><form className="p-5" onSubmit={(event) => { event.preventDefault(); if (!projectComposing.current) void saveProject() }}><h2 className="mb-4 text-my-lg font-medium text-my-primary">新建分组</h2><label htmlFor={projectInputId} className="mb-2 block text-my-sm text-my-secondary">分组名称</label><input id={projectInputId} className="my-input w-full" maxLength={200} value={name} onChange={(event) => { setName(event.target.value); setProjectError('') }} onCompositionStart={() => { projectComposing.current = true }} onCompositionEnd={() => { projectComposing.current = false }} onKeyDown={(event) => { if (event.key === 'Enter' && (projectComposing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); if (event.key === 'Escape' && (projectComposing.current || event.nativeEvent.isComposing)) event.stopPropagation() }} autoFocus /><p className="mt-2 text-my-sm text-my-danger-text" role={projectError ? 'alert' : undefined}>{projectError}</p><div className="mt-5 flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setProjectOpen(false)}>取消</Button><Button size="sm" variant="primary" type="submit" disabled={saving || !name.trim()}>{saving ? '保存中' : '创建'}</Button></div></form></Modal>
    <Modal open={searchOpen} onClose={() => setSearchOpen(false)} width={620} ariaLabel="搜索对话" placement="center"><ConversationSearch entries={searchEntries} query={query} selected={searchIndex} onSelected={setSearchIndex} onQuery={(value) => { setQuery(value); setSearchIndex(0) }} inputLabel="搜索对话标题或摘要" footer="搜索对话标题与摘要" loading={state.loading && !state.initialized} error={state.error}
      hasMore={searchRows.remaining > 0} onLoadMore={() => updateBatches((previous) => ({ ...previous, search: previous.search + HISTORY_BATCH }))} onRetry={() => void refreshWorkspace()} onClose={() => setSearchOpen(false)} onSelect={(id) => { if (!canInteract()) return; const item = matches.find((item) => historyRowKey(item) === id); if (item) chooseRow(item) }} /></Modal>
    <ConversationRenameDialog open={!!rename && rename.owner === owner && interactive} title={renameTitle} error={renameError || (rename ? state.managementErrors[rename.id] : undefined)} busy={!!rename && state.managementBusy[rename.id]} onTitle={(value) => { setRenameTitle(value); setRenameError('') }} onClose={() => setRename(null)} onSave={() => void saveRename()} />
    <ConversationListPreview id={hover.id} preview={hover.preview} />
  </>
}
