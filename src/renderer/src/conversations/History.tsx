import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Archive, ChevronDown, ChevronRight, Folder, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react'
import type { Conversation, ConversationContext } from '@shared/private-conversations'
import { ConversationSidebar } from '../acp/ConversationSidebar'
import { Button, Dropdown, Modal } from '../my/ui'
import { ModuleLinks } from '../my/layout/ModuleLinks'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { conversationError } from './client'
import { contextKey, createProject, refreshWorkspace, scopeKey, selectArchive, useConversations, type ConversationKind, type WorkspaceEntry } from './workspace'

const HISTORY_BATCH = 50
type HistoryRow = { kind: 'conversation'; value: Conversation } | { kind: 'draft'; value: WorkspaceEntry }
interface DisplayBatches { key: string; recent: number; search: number; projects: number; archive: number; groups: Record<string, number> }
const initialBatches = (key: string): DisplayBatches => ({ key, recent: HISTORY_BATCH, search: HISTORY_BATCH, projects: HISTORY_BATCH, archive: HISTORY_BATCH, groups: {} })
const historyRowKey = (item: HistoryRow): string => item.kind === 'conversation' ? `conversation:${item.value.id}` : `draft:${item.value.key}`
const historyRowTitle = (item: HistoryRow): string => item.kind === 'conversation' ? item.value.title : item.value.text.slice(0, 200).split('\n', 1)[0] || '图片草稿'

/** Keep a distant selection reachable without expanding its entire preceding prefix. */
function batchRows<T>(items: readonly T[], limit: number, selected: string | undefined, key: (item: T) => string): { visible: T[]; remaining: number } {
  const visible = items.slice(0, limit)
  if (selected && !visible.some((item) => key(item) === selected)) {
    const selectedItem = items.find((item) => key(item) === selected)
    if (selectedItem) visible.push(selectedItem)
  }
  return { visible, remaining: items.length - visible.length }
}

export function ConversationHistory({ context, kind, selected, projectId, open, onProject, onSelect, onNew, onClose }: {
  context: ConversationContext; kind: ConversationKind; selected: string; projectId?: string; open: boolean
  onProject(projectId?: string): void; onSelect(conversation: Conversation): void; onNew(projectId?: string): void; onClose(): void
}): JSX.Element {
  const state = useConversations(), canInteract = useInteractionGuard(), interactive = useInteractionActive()
  const [query, setQuery] = useState(''), [searchOpen, setSearchOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false), [name, setName] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const searchResults = useRef<HTMLDivElement>(null)
  const scope = contextKey(context), search = query.trim().toLocaleLowerCase(), groupLabel = context.kind === 'personal' ? '项目' : '专项'
  const filterKey = JSON.stringify([scope, kind, projectId ?? null, search]), expansionKey = JSON.stringify([scope, kind])
  const [display, setDisplay] = useState<DisplayBatches>(() => initialBatches(filterKey))
  const [expanded, setExpanded] = useState<{ key: string; choices: Record<string, boolean> }>({ key: expansionKey, choices: {} })
  const batches = display.key === filterKey ? display : initialBatches(filterKey)
  const openChoices = expanded.key === expansionKey ? expanded.choices : {}
  const updateBatches = (update: (previous: DisplayBatches) => DisplayBatches): void => setDisplay((previous) => update(previous.key === filterKey ? previous : initialBatches(filterKey)))
  const entries = useMemo(() => Object.values(state.entries), [state.entries])
  const entryByConversation = useMemo(() => {
    const result = new Map<string, WorkspaceEntry>()
    for (const item of entries) { const conversation = item.conversation; if (!item.locked && conversation) result.set(conversation.id, item) }
    return result
  }, [entries])
  const projects = useMemo(() => state.projects.filter((project) => contextKey(project.context) === scope), [state.projects, scope])
  const projectIds = useMemo(() => new Set(projects.map((project) => project.id)), [projects])
  const conversations = useMemo(() => state.conversations.filter((conversation) => contextKey(conversation.context) === scope && conversation.kind === kind), [state.conversations, scope, kind])
  const localDrafts = useMemo(() => entries.filter((item) => !item.locked && !item.conversation && item.kind === kind && contextKey(item.context) === scope && (item.text || item.images?.length)), [entries, scope, kind])
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
  const matches = useMemo(() => rows.filter((item) => !search || historyRowTitle(item).toLocaleLowerCase().includes(search)), [rows, search])
  const selectedEntry = state.entries[selected], selectedConversationId = selectedEntry?.locked ? undefined : selectedEntry?.conversation?.id
  const selectedRow = selectedConversationId ? `conversation:${selectedConversationId}` : selectedEntry && !selectedEntry.locked ? `draft:${selected}` : undefined
  const selectedGroup = selectedEntry?.locked ? undefined : selectedEntry?.projectId ?? projectId
  const recent = batchRows(grouped.recent, batches.recent, selectedRow, historyRowKey)
  const searchRows = batchRows(matches, batches.search, selectedRow, historyRowKey)
  const projectRows = batchRows(projects, batches.projects, selectedGroup, (item) => item.id)
  const archiveRows = batchRows(state.archives, batches.archive, selected.startsWith('archive:') ? selected.slice(8) : undefined, (item) => item.id)
  const archiveOpen = openChoices.archive ?? selected.startsWith('archive:')
  const groupOpen = (id: string): boolean => openChoices[`project:${id}`] ?? id === selectedGroup
  const setGroupOpen = (id: string, value: boolean): void => setExpanded((previous) => {
    const choices = previous.key === expansionKey ? previous.choices : {}
    const current = choices[id] ?? (id === 'archive' ? selected.startsWith('archive:') : id === `project:${selectedGroup}`)
    return current === value ? previous : { key: expansionKey, choices: { ...choices, [id]: value } }
  })
  useEffect(() => { setProjectOpen(false); setName(''); setError(''); setSearchOpen(false); setQuery('') }, [scope])
  useEffect(() => { if (!interactive) setSearchOpen(false) }, [interactive])
  useEffect(() => { if (selected.startsWith('archive:')) setGroupOpen('archive', true); else if (selectedGroup) setGroupOpen(`project:${selectedGroup}`, true) }, [selected, selectedGroup, expansionKey])
  const choose = (conversation: Conversation): void => { if (canInteract()) { setSearchOpen(false); onSelect(conversation) } }
  const chooseRow = (item: HistoryRow): void => {
    if (!canInteract()) return
    if (item.kind === 'conversation') { choose(item.value); return }
    const draft = useConversations.getState().entries[item.value.key]
    if (!draft || draft.locked || draft.kind !== kind || contextKey(draft.context) !== scope) return
    setSearchOpen(false); onProject(draft.projectId)
    useConversations.setState((current) => ({ selected: { ...current.selected, [scopeKey(context, kind, draft.projectId)]: draft.key } }))
  }
  const row = (item: HistoryRow): JSX.Element => {
    if (item.kind === 'draft') {
      const draft = item.value
      return <div className="acp-recent-item" key={historyRowKey(item)}><button type="button" className={`acp-recent-row my-nav-item${selected === draft.key ? ' is-selected' : ''}`} aria-current={selected === draft.key ? 'page' : undefined} onClick={() => chooseRow(item)}><span>{historyRowTitle(item)}</span><small className="text-my-xs text-my-tertiary">草稿</small></button></div>
    }
    const conversation = item.value, local = entryByConversation.get(conversation.id), active = selectedConversationId === conversation.id
    const waiting = local?.session?.connectionOwned && local.session.status === 'awaiting_permission'
    const running = local?.action === 'sending' || local?.session?.connectionOwned && ['busy', 'starting', 'cancelling'].includes(local.session.status)
    return <div key={historyRowKey(item)} className="acp-recent-item"><button type="button" className={`acp-recent-row my-nav-item${active ? ' is-selected' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => choose(conversation)} title={conversation.title}><span>{conversation.title}</span>{waiting ? <small className="text-my-xs text-my-warning-text">待授权</small> : running ? <Loader2 size={12} className="animate-spin" aria-label="处理中" /> : !conversation.nativeRef ? <small className="text-my-xs text-my-tertiary">草稿</small> : null}</button></div>
  }
  const more = (remaining: number, onMore: () => void, label = '加载更多对话', unit = '条'): JSX.Element | null => remaining > 0 ? <Button size="sm" variant="ghost" className="acp-load-more" onClick={() => { if (canInteract()) onMore() }}>{label}（还有 {remaining} {unit}）</Button> : null
  const saveProject = async (): Promise<void> => {
    if (!name.trim() || saving || !canInteract()) return
    const ownedScope = scope
    setSaving(true); setError('')
    try { await createProject(name.trim(), context); if (canInteract() && contextKey(useConversations.getState().context) === ownedScope) { setName(''); setProjectOpen(false) } }
    catch (cause) { if (canInteract() && contextKey(useConversations.getState().context) === ownedScope) setError(conversationError(cause)) }
    finally { if (canInteract()) setSaving(false) }
  }
  return <>
    <ConversationSidebar title={<Dropdown trigger={({ open: expanded, toggle }) => <button type="button" className="acp-module-switch" aria-label="切换对话模块" aria-expanded={expanded} onClick={toggle}><strong>对话</strong><ChevronDown size={13} /></button>}>{(close) => <div onClick={close}><ModuleLinks domain="agents" /></div>}</Dropdown>} open={open} onClose={onClose} ariaLabel="对话历史" resizeLabel="调整对话历史宽度"
      actions={<><button type="button" className="my-icon-control" aria-label="搜索对话" title="搜索对话" onClick={() => setSearchOpen(true)}><Search size={15} /></button><button type="button" className="my-icon-control" aria-label="刷新对话历史" title="刷新对话历史" disabled={state.loading} onClick={() => void refreshWorkspace()}><RefreshCw size={14} className={state.loading ? 'animate-spin' : ''} /></button></>}
      primaryAction={<button type="button" className="my-nav-item" onClick={() => onNew()}><Plus size={15} />新建对话</button>}
      label={<button type="button" aria-pressed={!projectId} onClick={() => onProject()}>最近对话</button>}
      footer={<p className="acp-navigation-bottom my-item-description">{context.kind === 'team' ? '此空间中的对话仅你可见' : '个人对话仅你可见'}</p>}>
      {state.error && <div role="alert" className="acp-search-error">{state.error}<button type="button" onClick={() => void refreshWorkspace()}>重试</button></div>}
      {recent.visible.map(row)}
      {more(recent.remaining, () => updateBatches((previous) => ({ ...previous, recent: previous.recent + HISTORY_BATCH })))}
      {!rows.length && <p className="px-3 py-3 text-my-sm text-my-tertiary">{state.loading && !state.initialized ? '正在读取对话…' : '暂无对话'}</p>}
      <div className="acp-navigation-label"><span>{groupLabel}</span><button type="button" className="my-icon-control" aria-label={`新建${groupLabel}`} title={`新建${groupLabel}`} onClick={() => setProjectOpen((value) => !value)}><Plus size={13} /></button></div>
      {projectOpen && <form className="private-project-form" onSubmit={(event) => { event.preventDefault(); void saveProject() }}><label htmlFor="private-project-name" className="sr-only">{groupLabel}名称</label><input id="private-project-name" className="my-input" placeholder={`${groupLabel}名称`} maxLength={200} value={name} onChange={(event) => setName(event.target.value)} autoFocus /><div className="flex justify-end gap-1"><Button size="sm" variant="ghost" disabled={saving} onClick={() => setProjectOpen(false)}>取消</Button><Button size="sm" variant="primary" type="submit" disabled={saving || !name.trim()}>{saving ? '保存中' : '创建'}</Button></div>{error && <p role="alert" className="my-item-description text-my-danger-text">{error}</p>}</form>}
      {projectRows.visible.map((project) => {
        const expanded = groupOpen(project.id)
        const children = expanded ? batchRows(grouped.projects.get(project.id) ?? [], batches.groups[project.id] ?? HISTORY_BATCH, selectedRow, historyRowKey) : null
        return <details key={project.id} className="private-project-group" open={expanded} onToggle={(event) => setGroupOpen(`project:${project.id}`, event.currentTarget.open)}><summary className={`acp-recent-row my-nav-item${projectId === project.id ? ' is-selected' : ''}`} onClick={(event) => { event.preventDefault(); setGroupOpen(`project:${project.id}`, !expanded); if (!expanded) onProject(project.id) }}><ChevronRight size={12} className="private-project-chevron" /><Folder size={14} /><span>{project.name}</span></summary>{children && <div className="private-project-conversations">{children.visible.map(row)}{more(children.remaining, () => updateBatches((previous) => ({ ...previous, groups: { ...previous.groups, [project.id]: (previous.groups[project.id] ?? HISTORY_BATCH) + HISTORY_BATCH } })))}<button type="button" className="acp-recent-row my-nav-item" onClick={() => onNew(project.id)}><Plus size={13} /><span>新对话</span></button></div>}</details>
      })}
      {more(projectRows.remaining, () => updateBatches((previous) => ({ ...previous, projects: previous.projects + HISTORY_BATCH })), `加载更多${groupLabel}`, '个')}
      {context.kind === 'personal' && <details className="private-archive-group" open={archiveOpen} onToggle={(event) => setGroupOpen('archive', event.currentTarget.open)}><summary className="acp-recent-row my-nav-item"><Archive size={14} /><span>旧问答 · 只读归档</span><ChevronRight size={12} /></summary>{archiveOpen && <>{state.archiveError && <p role="alert" className="acp-search-error">{state.archiveError}</p>}{archiveRows.visible.map((item) => <div key={item.id} className="acp-recent-item"><button type="button" className={`acp-recent-row my-nav-item${selected === `archive:${item.id}` ? ' is-selected' : ''}`} aria-current={selected === `archive:${item.id}` ? 'page' : undefined} onClick={() => selectArchive(item.id, context, kind, projectId)} title={item.title}><span>{item.title}</span></button></div>)}{more(archiveRows.remaining, () => updateBatches((previous) => ({ ...previous, archive: previous.archive + HISTORY_BATCH })), '加载更多归档')}{!state.archives.length && !state.archiveError && <p className="px-3 py-3 text-my-sm text-my-tertiary">没有旧问答记录</p>}</>}</details>}
    </ConversationSidebar>
    <Modal open={searchOpen} onClose={() => setSearchOpen(false)} width={620} ariaLabel="搜索对话" placement="center"><section className="acp-search-palette" aria-label="搜索对话"><div className="acp-search-input"><Search size={18} /><input autoFocus aria-label="按已加载对话标题搜索" placeholder="搜索对话" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'ArrowDown') { event.preventDefault(); searchResults.current?.querySelector<HTMLButtonElement>('button')?.focus() } else if (event.key === 'Enter' && searchRows.visible[0]) { event.preventDefault(); chooseRow(searchRows.visible[0]) } }} /><button type="button" className="my-icon-control" aria-label="关闭搜索" onClick={() => setSearchOpen(false)}><X size={16} /></button></div><p className="acp-search-caption">按已加载对话的标题搜索</p><div ref={searchResults} className="acp-search-results my-scrollbar" onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const options = Array.from(searchResults.current?.querySelectorAll<HTMLButtonElement>('button') ?? []), currentIndex = options.findIndex((option) => option === document.activeElement)
      if (!options.length) return
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      options[next]?.focus()
    }}>{searchRows.visible.map(row)}{more(searchRows.remaining, () => updateBatches((previous) => ({ ...previous, search: previous.search + HISTORY_BATCH })))}{!matches.length && <p className="acp-search-empty">没有匹配的对话</p>}</div></section></Modal>
  </>
}
