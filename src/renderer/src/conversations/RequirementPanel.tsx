import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { ArrowRight, FileInput, FolderOpen, Loader2, MoreHorizontal, RefreshCw, Save, Sparkles, X } from 'lucide-react'
import { REQUIREMENT_BODY_BYTES, REQUIREMENT_FILE_BYTES, requirementCommitSchema, requirementSaveSchema, type ConversationRequirementsApi, type RequirementCommit, type RequirementFileSelection, type RequirementReceipt, type RequirementTargetSelection, type RequirementView } from '@shared/conversation-requirements'
import type { Conversation } from '@shared/private-conversations'
import type { ProjectSnapshot } from '@shared/types'
import { confirmDialog } from '../components/Dialogs'
import { Button, Checkbox, Dropdown, DropdownItem } from '../my/ui'
import { projectRootKey } from '../my/navigation'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { statusLabel } from '../utils/labels'
import { conversationClient, conversationError, conversationValue } from './client'
import { isPrivateEntrySelected } from './source'
import { ensureConversation, refreshFiles, sendRequirementMessage, sessionRunning, useConversations, type RequirementMessageSource } from './workspace'

export interface ConversationRequirementPanelProps {
  entryKey: string
  requirementId?: string
  createCommandId: string
  onClose(): void
  onOpenTask(result: { snapshot: ProjectSnapshot; taskDir: string }): void | Promise<void>
}
interface RequirementBuffer {
  conversation: Conversation
  createCommandId: string
  view?: RequirementView
  remote?: RequirementView
  title: string
  body: string
  references: RequirementFileSelection[]
  editVersion: number
  pending?: string
  loading?: Promise<void>
  error?: string
  info?: string
  commandIssue?: string
  command?: RequirementCommit
  receipt?: RequirementReceipt
}
// Text stays in memory across preview closes and Settings detours; image bytes stay in the composer.
const BUFFER_LIMIT = 16, PENDING_LIMIT = 32, FILE_BATCH = 50
const buffers = new Map<string, RequirementBuffer>(), aliases = new Map<string, string>()
const listeners = new Set<() => void>()
const changed = (): void => { for (const listener of listeners) listener() }
const bufferKey = (conversation: Conversation, id: string): string => JSON.stringify([conversation.creatorId, conversation.id, id])
const selections = (view: RequirementView): RequirementFileSelection[] => view.draft.references.map(({ fileId, revision }) => ({ fileId, revision }))
function dirty(value: RequirementBuffer): boolean {
  return Boolean(value.view && (value.title !== value.view.draft.title || value.body !== value.view.draft.body || JSON.stringify(value.references) !== JSON.stringify(selections(value.view))))
}
function bufferFor(conversation: Conversation, requirementId: string | undefined, commandId: string): RequirementBuffer {
  const requested = bufferKey(conversation, requirementId ?? `new:${commandId}`), key = aliases.get(requested) ?? requested
  const existing = buffers.get(key)
  if (existing) return existing
  if (buffers.size >= BUFFER_LIMIT) {
    const candidate = [...buffers].find(([, value]) => !dirty(value) && !value.pending && !value.command)
    if (!candidate) throw new Error('未保存的需求面板已达上限，请先保存已有草稿。')
    buffers.delete(candidate[0])
    for (const [alias, target] of aliases) if (target === candidate[0]) aliases.delete(alias)
  }
  const value: RequirementBuffer = { conversation, createCommandId: commandId, title: '需求草稿', body: '', references: [], editVersion: 0 }
  buffers.set(key, value)
  return value
}
function checkView(value: RequirementBuffer, view: RequirementView): void {
  if (view.draft.conversationId !== value.conversation.id || view.draft.creatorId !== value.conversation.creatorId || value.view && view.draft.id !== value.view.draft.id) throw new Error('需求来源不匹配，未应用返回内容。')
  const receipt = view.draft.handoff
  if (receipt && (receipt.draftId !== view.draft.id || receipt.targetId !== view.draft.target?.id || receipt.task && projectRootKey(receipt.task.root) !== projectRootKey(view.draft.target?.root))) throw new Error('已关联任务的需求来源不匹配，请重新读取。')
}
function acceptView(value: RequirementBuffer, view: RequirementView, saved = false, preserveEditor = false): void {
  checkView(value, view)
  if (!saved && dirty(value)) {
    value.remote = view
    if (view.draft.revision !== value.view?.draft.revision) value.error = '需求已有新版本，本地修改已保留。可放弃本地修改后重新读取。'
    return
  }
  value.view = view; value.remote = undefined
  if (!preserveEditor) { value.title = view.draft.title; value.body = view.draft.body; value.references = selections(view) }
  const canonical = bufferKey(value.conversation, view.draft.id), original = bufferKey(value.conversation, `new:${value.createCommandId}`)
  if (buffers.get(original) === value) buffers.delete(original)
  buffers.set(canonical, value); aliases.set(original, canonical)
}
const commandKey = (value: RequirementBuffer): string => `tpanel.requirement-handoff.v1.${encodeURIComponent(value.conversation.creatorId)}.${value.conversation.id}.${value.view?.draft.id}`
function readCommand(value: RequirementBuffer): RequirementCommit | undefined {
  try {
    const raw = localStorage.getItem(commandKey(value))
    const command = raw ? requirementCommitSchema.parse(JSON.parse(raw)) : undefined
    value.commandIssue = undefined
    return command
  } catch {
    value.commandIssue = '无法读取原交接请求，已保留缓存。请先核对原交接状态。'
    throw new Error(value.commandIssue)
  }
}
function persistCommand(value: RequirementBuffer, command: RequirementCommit): void {
  const key = commandKey(value), prefix = `tpanel.requirement-handoff.v1.${encodeURIComponent(value.conversation.creatorId)}.`
  let count = 0
  for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith(prefix)) count++
  if (localStorage.getItem(key) === null && count >= PENDING_LIMIT) throw new Error('待确认的需求交接已达上限，请先核对已有交接。')
  localStorage.setItem(key, JSON.stringify(command))
  value.command = command
}
function acceptReceipt(value: RequirementBuffer, command: RequirementCommit, receipt: RequirementReceipt): void {
  const draft = value.view?.draft
  if (!draft || receipt.draftId !== draft.id || receipt.commandId !== command.commandId || receipt.draftRevision !== command.expectedRevision || receipt.targetId !== command.targetId || receipt.task && projectRootKey(receipt.task.root) !== projectRootKey(draft.target?.root)) throw new Error('需求交接回执来源不匹配，请核对本次交接。')
  value.receipt = receipt
  if (receipt.state === 'created' && receipt.task) { localStorage.removeItem(commandKey(value)); value.command = undefined }
}
function restoreHandoff(value: RequirementBuffer, view: RequirementView): void {
  value.command = readCommand(value)
  const receipt = view.draft.handoff
  if (!receipt) return
  if (!value.command && (receipt.state !== 'created' || !receipt.task)) persistCommand(value, { commandId: receipt.commandId, expectedRevision: receipt.draftRevision, targetId: receipt.targetId })
  if (value.command) acceptReceipt(value, value.command, receipt)
  else value.receipt = receipt
}
function apiForRequirements(): ConversationRequirementsApi {
  const client = conversationClient()
  if (!client?.requirements) throw new Error('需求接口当前不可用，请重试。')
  return client.requirements
}

export function ConversationRequirementPanel({ entryKey, requirementId, createCommandId, onClose, onOpenTask }: ConversationRequirementPanelProps): JSX.Element {
  const current = useConversations(state => state.entries[entryKey])
  const active = useInteractionActive(), canInteract = useInteractionGuard(), signal = useInteractionSignal()
  const [buffer, setBuffer] = useState<RequirementBuffer>(), [loadError, setLoadError] = useState(''), [attempt, setAttempt] = useState(0)
  const [, render] = useState(0), [visibleFiles, setVisibleFiles] = useState(FILE_BATCH)
  const fieldsId = useId(), confirmation = useRef<AbortController>(), mounted = useRef(true)
  const identity = JSON.stringify([entryKey, requirementId, createCommandId, current?.owner, current?.conversation?.id, current?.conversation?.workspace.root, current?.conversation?.nativeRef?.sessionId, current?.session?.connectionGeneration, active])
  const live = useRef({ identity, signal })
  if (live.current.identity !== identity || live.current.signal !== signal) live.current = { identity, signal }
  const owner = current?.owner, conversationId = current?.conversation?.id, root = current?.conversation?.workspace.root
  useEffect(() => { const listener = (): void => render(value => value + 1); listeners.add(listener); return () => { listeners.delete(listener) } }, [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; confirmation.current?.abort() } }, [])
  useEffect(() => () => confirmation.current?.abort(), [entryKey, requirementId, createCommandId, active, signal, owner, root, current?.session?.connectionGeneration])
  const capture = (): RequirementMessageSource => {
    const item = useConversations.getState().entries[entryKey], selected = live.current
    if (!item?.conversation || item.locked || !canInteract() || !isPrivateEntrySelected(entryKey)) throw new Error('请返回原会话后继续编辑需求。')
    const source: RequirementMessageSource = { owner: item.owner, conversationId: item.conversation.id, root: item.conversation.workspace.root, sessionId: item.conversation.nativeRef?.sessionId, generation: item.session?.connectionGeneration }
    source.isCurrent = (): boolean => {
      const latest = useConversations.getState().entries[entryKey]
      return mounted.current && live.current === selected && canInteract() && isPrivateEntrySelected(entryKey) && !latest?.locked && latest?.owner === source.owner && latest?.conversation?.id === source.conversationId && projectRootKey(latest.conversation.workspace.root) === projectRootKey(source.root) && latest.conversation.nativeRef?.sessionId === source.sessionId && latest.session?.connectionGeneration === source.generation
    }
    return source
  }
  useEffect(() => {
    let attached = true
    if (!active) return
    setBuffer(undefined); setLoadError(''); setVisibleFiles(FILE_BATCH)
    const load = async (): Promise<void> => {
      if (!current?.conversation) { await ensureConversation(entryKey); return }
      const source = capture(), value = bufferFor(current.conversation, requirementId, createCommandId)
      if (!attached || !source.isCurrent?.()) return
      setBuffer(value)
      if (value.loading) { await value.loading; if (attached && source.isCurrent?.()) await load(); return }
      if (value.pending) return
      value.pending = 'read'; value.error = undefined; changed()
      const operation = async (): Promise<void> => {
        const client = apiForRequirements()
        let view: RequirementView
        const id = requirementId ?? value.view?.draft.id
        if (id) view = conversationValue(await client.read(source.conversationId, id))
        else {
          view = conversationValue(await client.create(source.conversationId, { commandId: createCommandId }))
        }
        checkView(value, view)
        if (id && view.draft.id !== id) throw new Error('需求标识不匹配，未应用返回内容。')
        // A create acknowledgement belongs to its original private buffer even if its preview closed.
        if (!id && !value.view) acceptView(value, view)
        if (!attached || !source.isCurrent?.()) return
        acceptView(value, view)
        restoreHandoff(value, view)
      }
      value.loading = operation()
      try { await value.loading } finally { value.pending = undefined; value.loading = undefined; changed() }
    }
    void load().catch(cause => { if (attached && canInteract()) setLoadError(conversationError(cause)) })
    return () => { attached = false }
  }, [entryKey, owner, conversationId, root, requirementId, createCommandId, active, attempt, current?.session?.connectionGeneration])
  const requestedKey = current?.conversation ? bufferKey(current.conversation, requirementId ?? `new:${createCommandId}`) : undefined
  const validBuffer = requestedKey && buffers.get(aliases.get(requestedKey) ?? requestedKey) === buffer ? buffer : undefined
  const value = validBuffer, view = value?.view, saved = view?.draft
  const receipt = value?.receipt ?? value?.remote?.draft.handoff ?? saved?.handoff, task = receipt?.task
  const unresolved = Boolean(value?.command), unsaved = value ? dirty(value) : false
  const blocked = !active || !value || !saved || Boolean(value.pending) || Boolean(current?.locked) || current?.conversation?.archivedAt !== undefined
  const readOnly = Boolean(task || unresolved || receipt || value?.commandIssue || current?.conversation?.archivedAt !== undefined)
  const run = async (operation: string, action: (value: RequirementBuffer, client: ConversationRequirementsApi, source: RequirementMessageSource) => Promise<unknown>): Promise<void> => {
    if (!value || value.pending) return
    let source: RequirementMessageSource
    try { source = capture() } catch (cause) { value.error = conversationError(cause); changed(); return }
    value.pending = operation; value.error = undefined; value.info = undefined; changed()
    try { await action(value, apiForRequirements(), source) }
    catch (cause) { if (source.isCurrent?.()) value.error = conversationError(cause) }
    finally { value.pending = undefined; changed() }
  }
  const save = async (value: RequirementBuffer, client: ConversationRequirementsApi, source: RequirementMessageSource): Promise<boolean> => {
    if (!value.view || !source.isCurrent?.()) return false
    if (!dirty(value)) return true
    if (value.command || value.receipt || value.view.draft.handoff) throw new Error('需求已交接，请在 Trellis 中继续处理。')
    const version = value.editVersion
    const input = requirementSaveSchema.parse({ expectedRevision: value.view.draft.revision, title: value.title, body: value.body, references: value.references, expectedFileRevision: value.view.fileRevision ?? null })
    const result = conversationValue(await client.save(source.conversationId, value.view.draft.id, input))
    if (!source.isCurrent?.()) return false
    const edited = value.editVersion !== version
    acceptView(value, result, true, edited); changed()
    return !edited
  }
  const edit = (update: Partial<Pick<RequirementBuffer, 'title' | 'body' | 'references'>>): void => {
    if (!value || readOnly || value.command || value.receipt || value.view?.draft.handoff || !canInteract()) return
    if (update.body !== undefined && (update.body.length > 200_000 || new TextEncoder().encode(update.body).byteLength > REQUIREMENT_BODY_BYTES)) { value.error = '需求正文最多 256 KiB，请缩短后再带入。'; changed(); return }
    Object.assign(value, update); value.editVersion++; value.error = undefined; value.info = undefined; changed()
  }
  const reload = (discard = false): void => { void run('read', async (value, client, source) => {
    if (!value.view) return
    if (discard) {
      const controller = new AbortController(); confirmation.current = controller
      const confirmed = await confirmDialog({ title: '放弃本地修改？', message: '将重新读取已保存的需求版本。', confirmText: '放弃并读取' }, controller.signal)
      if (!confirmed || !source.isCurrent?.()) return
    }
    const version = value.editVersion, result = conversationValue(await client.read(source.conversationId, value.view.draft.id))
    if (!source.isCurrent?.()) return
    acceptView(value, result, discard, discard && value.editVersion !== version)
    restoreHandoff(value, result)
  }) }
  const refine = (): void => { void run('prompt', async (value, client, source) => {
    if (!await save(value, client, source) || !source.isCurrent?.() || !value.view) return
    const version = value.editVersion, draft = value.view.draft
    const prompt = conversationValue(await client.prompt(source.conversationId, draft.id, { expectedRevision: draft.revision }))
    if (!source.isCurrent?.() || value.editVersion !== version || dirty(value)) throw new Error('需求已更改，请保存后重新梳理。')
    if (prompt.draftId !== draft.id || prompt.revision !== draft.revision || prompt.bodyRevision !== draft.bodyRevision || prompt.relativePath !== draft.relativePath) throw new Error('梳理提示来源已变化，请重新读取需求。')
    const accepted = await sendRequirementMessage(entryKey, prompt.text, source)
    if (accepted) value.info = '已发送，回应将在原对话中显示。'
    else if (source.isCurrent?.()) throw new Error(useConversations.getState().entries[entryKey]?.error ?? '当前会话暂不可发送，需求草稿已保留。')
  }) }
  const sync = (): void => { void run('sync', async (value, client, source) => {
    if (!value.view || dirty(value) || value.command || value.receipt) return
    const version = value.editVersion, result = conversationValue(await client.read(source.conversationId, value.view.draft.id))
    if (!source.isCurrent?.() || value.editVersion !== version || dirty(value)) return
    acceptView(value, result)
    if (result.fileState !== 'changed' || !result.fileRevision) { value.info = result.detail ?? '没有可同步的文件修改。'; return }
    const synced = conversationValue(await client.sync(source.conversationId, result.draft.id, { expectedRevision: result.draft.revision, fileRevision: result.fileRevision }))
    if (source.isCurrent?.() && value.editVersion === version && !dirty(value)) acceptView(value, synced)
  }) }
  const target = (selection?: RequirementTargetSelection): void => { void run('target', async (value, client, source) => {
    if (!await save(value, client, source) || !source.isCurrent?.() || !value.view || value.command || value.receipt) return
    if (!selection) {
      const transport = conversationClient()
      if (!transport) return
      const grant = conversationValue(await transport.pickDirectory({ purpose: 'trellis-requirement' }))
      if (!grant || !source.isCurrent?.()) return
      selection = { kind: 'directory', grantId: grant.grantId }
    }
    const version = value.editVersion, result = conversationValue(await client.target(source.conversationId, value.view.draft.id, { expectedRevision: value.view.draft.revision, selection }))
    if (source.isCurrent?.()) acceptView(value, result, true, value.editVersion !== version || dirty(value))
  }) }
  const commit = (): void => { void run('commit', async (value, client, source) => {
    if (!value.view || value.commandIssue) return
    const original = value.receipt ?? value.view.draft.handoff
    if (original?.state === 'created' && original.task) return
    if (!value.command && original) persistCommand(value, { commandId: original.commandId, expectedRevision: original.draftRevision, targetId: original.targetId })
    if (!value.command) {
      if (!await save(value, client, source) || !source.isCurrent?.() || !value.view) return
      const draft = value.view.draft, version = value.editVersion
      if (!draft.target || !value.body.trim()) throw new Error('请先填写需求并选择真实 Trellis 工程。')
      const controller = new AbortController(); confirmation.current = controller
      const confirmed = await confirmDialog({ title: '创建 Trellis 需求', message: `${draft.title}\n${draft.target.root}\n以当前已保存版本创建规划中任务，不启动执行。`, confirmText: '确认创建' }, controller.signal)
      if (!confirmed || !source.isCurrent?.()) return
      if (value.editVersion !== version || dirty(value) || value.view.draft.revision !== draft.revision) throw new Error('需求已更改，请保存后重新确认。')
      persistCommand(value, { expectedRevision: draft.revision, commandId: crypto.randomUUID(), targetId: draft.target.id }); changed()
    }
    const command = value.command
    if (!command || !source.isCurrent?.()) return
    const result = conversationValue(await client.commit(source.conversationId, value.view.draft.id, command))
    if (source.isCurrent?.()) acceptReceipt(value, command, result)
  }) }
  const openTask = (): void => { void run('open', async (value, client, source) => {
    const known = (value.receipt ?? value.remote?.draft.handoff ?? value.view?.draft.handoff)?.task
    if (!known || !value.view) return
    const opened = conversationValue(await client.open(source.conversationId, value.view.draft.id))
    if (!source.isCurrent?.()) return
    if (opened.conversationId !== source.conversationId || opened.draftId !== value.view.draft.id || opened.task.taskId !== known.taskId || opened.task.taskDir !== known.taskDir || opened.taskDir !== known.taskDir || projectRootKey(opened.task.root) !== projectRootKey(known.root) || projectRootKey(opened.snapshot.meta.root) !== projectRootKey(known.root)) throw new Error('Trellis 任务来源不匹配，未打开其他工程。')
    await onOpenTask({ snapshot: opened.snapshot, taskDir: opened.taskDir })
  }) }
  const toggleFile = (fileId: string, revision: string, checked: boolean): void => {
    if (!value) return
    const next = value.references.filter(reference => reference.fileId !== fileId)
    if (checked) next.push({ fileId, revision })
    if (next.length > 8) { value.error = '最多引用 8 个文件版本。'; changed(); return }
    edit({ references: next })
  }
  return <section className="acp-document-host" aria-label="需求草稿" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing && canInteract()) { event.preventDefault(); event.stopPropagation(); if (!blocked && !readOnly) void run('save', save) }
  }}>
    <header className="acp-inspector-header"><span className="my-item-title min-w-0 flex-1 truncate">{saved?.title ?? '需求草稿'}</span><span className="shrink-0 text-my-xs text-my-tertiary" role="status" aria-live="polite">{value?.pending === 'save' ? '保存中…' : unsaved ? '未保存' : saved ? '已保存' : '读取中…'}</span>
      <Dropdown align="right" disabled={blocked} trigger={({ open, toggle }) => <Button size="sm" variant="ghost" aria-label="需求选项" aria-expanded={open} disabled={blocked} onClick={toggle}><MoreHorizontal size={15} /></Button>}>{close => <>
        <DropdownItem icon={<FileInput size={14} />} disabled={blocked || readOnly || !current?.text.trim()} onClick={() => { close(); if (value) edit({ body: value.body ? `${value.body}\n\n${current?.text ?? ''}` : current?.text ?? '' }) }}>带入当前输入</DropdownItem>
        <DropdownItem icon={<RefreshCw size={14} />} disabled={blocked} onClick={() => { close(); reload() }}>重新读取</DropdownItem>
        <DropdownItem icon={<RefreshCw size={14} />} disabled={blocked || readOnly || unsaved} onClick={() => { close(); sync() }}>同步文件修改</DropdownItem>
        {current?.kind === 'code' && current.conversation?.workspace.kind === 'directory' && !readOnly && <DropdownItem icon={<FolderOpen size={14} />} disabled={blocked} onClick={() => { close(); target({ kind: 'code' }) }}>使用当前 Code 目录</DropdownItem>}
        {saved?.target && !readOnly && <DropdownItem icon={<FolderOpen size={14} />} disabled={blocked} onClick={() => { close(); target() }}>更换 Trellis 工程</DropdownItem>}
      </>}</Dropdown>
      <Button size="sm" variant="ghost" aria-label="关闭需求面板" onClick={() => { confirmation.current?.abort(); onClose() }}><X size={15} /></Button></header>
    <div className="acp-inspector-body my-scrollbar space-y-4" aria-busy={Boolean(value?.pending)}>
      {(loadError || value?.error) && <div role="alert" className="space-y-2 text-my-sm text-my-danger-text"><p>{loadError || value?.error}</p>{!saved && <Button size="sm" variant="outline" disabled={!active || Boolean(value?.pending)} onClick={() => setAttempt(value => value + 1)}>重新读取</Button>}{value?.remote && <Button size="sm" variant="outline" disabled={blocked} onClick={() => reload(true)}>放弃本地修改并重读</Button>}</div>}
      {!value || !view || !saved ? !loadError && <p className="my-activity-note" role="status"><Loader2 size={14} className="animate-spin" />正在读取需求草稿…</p> : <>
        <label className="block space-y-2" htmlFor={`${fieldsId}-title`}><span className="my-item-title">需求标题</span><input id={`${fieldsId}-title`} className="my-input w-full" value={value.title} maxLength={200} disabled={!active} readOnly={readOnly} onChange={event => edit({ title: event.target.value })} /></label>
        <label className="block space-y-2" htmlFor={`${fieldsId}-body`}><span className="my-item-title">需求正文</span><textarea id={`${fieldsId}-body`} className="my-input w-full resize-y text-my-sm" rows={12} maxLength={200_000} value={value.body} disabled={!active} readOnly={readOnly} spellCheck={false} onChange={event => edit({ body: event.target.value })} /></label>
        {view.fileState === 'changed' ? <div className="flex items-center gap-2"><span className="my-item-description" role="status">需求文件已更新</span><Button size="sm" variant="ghost" disabled={blocked || readOnly || unsaved} onClick={sync}>同步修改</Button></div> : view.fileState !== 'saved' && <p className="my-item-description" role="status">{view.detail ?? (view.fileState === 'missing' ? '需求文件暂不存在。' : '需求文件暂不可读取。')}</p>}
        <details onToggle={event => { if (event.currentTarget.open && !current?.filesLoaded && !current?.filesLoading && canInteract()) void refreshFiles(entryKey) }}><summary className="my-item-title cursor-pointer">引用文件{value.references.length ? ` · ${value.references.length}` : ''}</summary><div className="mt-3 space-y-2">
          {value.references.map(reference => <div key={reference.fileId} className="flex items-center gap-2"><span className="my-item-description min-w-0 flex-1 truncate" title={reference.revision}>{saved.references.find(file => file.fileId === reference.fileId && file.revision === reference.revision)?.name ?? current?.files.find(file => file.id === reference.fileId)?.name ?? reference.fileId} · {reference.revision.slice(0, 8)}</span><Button size="sm" variant="ghost" aria-label="移除文件引用" disabled={blocked || readOnly} onClick={() => toggleFile(reference.fileId, reference.revision, false)}><X size={13} /></Button></div>)}
          <Button size="sm" variant="ghost" disabled={!active || current?.filesLoading} onClick={() => void refreshFiles(entryKey)}><RefreshCw size={13} />刷新文件</Button>
          {current?.fileError && <p role="alert" className="text-my-xs text-my-danger-text">{current.fileError}</p>}
          <fieldset disabled={blocked || readOnly} className="space-y-2">{(current?.files ?? []).slice(0, visibleFiles).filter(file => file.bytes <= REQUIREMENT_FILE_BYTES).map(file => <label key={`${file.id}:${file.revision}`} className="flex items-start gap-2"><Checkbox checked={value.references.some(reference => reference.fileId === file.id && reference.revision === file.revision)} onChange={checked => toggleFile(file.id, file.revision, checked)} /><span className="min-w-0"><span className="my-item-title block truncate">{file.name}</span><span className="my-item-description block break-all">{file.relativePath} · {file.revision.slice(0, 8)}</span></span></label>)}</fieldset>
          {!current?.files.length && !current?.filesLoading && <p className="my-item-description">暂未发现可引用文件。</p>}{(current?.files.length ?? 0) > visibleFiles && <Button size="sm" variant="ghost" onClick={() => setVisibleFiles(value => value + FILE_BATCH)}>显示更多文件</Button>}
        </div></details>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={blocked || readOnly || !unsaved} onClick={() => void run('save', save)}>{value.pending === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}保存草稿</Button><Button size="sm" variant="outline" disabled={blocked || readOnly || Boolean(current?.action) || Boolean(current && sessionRunning(current)) || !value.body.trim()} onClick={refine}>{value.pending === 'prompt' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}AI 梳理</Button></div>
        {value.info && <p className="my-item-description" role="status">{value.info}</p>}
        <section className="space-y-3 border-t border-my-line pt-4" aria-label="Trellis 交接"><p className="my-item-title">Trellis 工程</p>{saved.target && <p className="my-item-description break-all">{saved.target.root}</p>}
          {task && <div className="space-y-1"><p className="my-item-title" title={task.taskDir}>{task.title}</p><p className="my-item-description">{statusLabel(task.status)}</p></div>}
          {receipt?.detail && <p className="my-item-description" role="status">{receipt.detail}</p>}
          {task ? <Button size="sm" variant={receipt?.state === 'created' ? 'primary' : 'outline'} disabled={blocked} onClick={openTask}>{receipt?.state === 'created' ? '进入 Trellis' : '查看 Trellis 任务'}<ArrowRight size={14} /></Button> : !saved.target && !unresolved ? <Button size="sm" variant="primary" disabled={blocked || readOnly} onClick={() => target()}><FolderOpen size={14} />选择 Trellis 工程</Button> : <Button size="sm" variant="primary" disabled={blocked || Boolean(value.commandIssue) || !unresolved && !value.body.trim()} onClick={commit}>{value.pending === 'commit' && <Loader2 size={14} className="animate-spin" />}{unresolved ? '检查并重试本次交接' : '创建 Trellis 需求'}</Button>}
          {task && receipt?.state !== 'created' && <Button size="sm" variant="primary" disabled={blocked || Boolean(value.commandIssue)} onClick={commit}>{value.pending === 'commit' && <Loader2 size={14} className="animate-spin" />}检查并补全交接</Button>}
        </section>
      </>}
    </div>
  </section>
}
