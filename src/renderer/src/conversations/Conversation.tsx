import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { ArchiveRestore, ArrowDown, ChevronDown, ChevronRight, CircleAlert, CircleStop, FileText, Folder, ImagePlus, Loader2, Paperclip, Plus, Send, Settings2 } from 'lucide-react'
import type { AcpConfigureInput, TimelineEvent } from '@shared/types'
import { cleanModelDisplayName } from '@shared/model-selection'
import type { PiWebPreviewArtifact } from '@shared/pi-web-preview'
import { ConversationTranscript, type TranscriptActiveSegment } from '../acp/ConversationTranscript'
import { ComposerModelPicker } from '../acp/ComposerModelPicker'
import { ComposerUsageIndicator } from '../acp/ComposerUsageIndicator'
import { HistoryBoundary } from '../acp/ConversationHistoryBoundary'
import { useComposerAutoSize } from '../acp/useComposerAutoSize'
import { useComposerImages } from '../acp/useComposerImages'
import { ImageAttachments } from '../acp/ImageAttachments'
import { describeConnectionError } from '../acp/ConnectionNotice'
import { EventRow } from '../acp/TranscriptRow'
import { captureTranscriptAnchor, restoreTranscriptAnchor, type TranscriptScrollAnchor } from '../acp/transcript-scroll'
import { useDocumentSource } from '../reader/document-source'
import { compileItems } from '../acp/timeline'
import { CurrentTurnStatus } from '../acp/CurrentTurnStatus'
import { projectCurrentTurnActivity, type CurrentTurnActivity } from '../acp/current-turn-activity'
import { Button, Dropdown, DropdownHeader, DropdownItem, SearchInput } from '../my/ui'
import { useMy } from '../my/store'
import { useApp } from '../store'
import { projectNameFromPath, projectRootKey } from '../my/navigation'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { conversationClient, conversationError, conversationValue } from './client'
import { isPrivateEntrySelected } from './source'
import { ConversationGitContext } from './GitContext'
import { acceptConversationSession, acquireConversationConfiguration, actionablePermissions, addFiles, chooseDirectory, controlConversation, conversationNativeOwner, earlierMessages, editDraft, ownsConversationNative, patchEntry, readConversation, requestComposerFocus, respondPermission, saveDraft, sendMessage, sessionRunning, setDraftImages, setDraftModel, setDraftRuntime, updateConversation, useConversations, type WorkspaceEntry } from './workspace'

export function openConversationSettings(): void {
  useMy.getState().setSettingsView('engines'); useApp.getState().setPage('settings')
}

function openModelSettings(): void { useApp.getState().setPage('models') }

export interface PrivateConversationAssistantPort {
  text: string
  onTextChange(text: string): void
  onSend(): void | Promise<unknown>
  pending: boolean
  emptyState: ReactNode
  events: readonly TimelineEvent[]
  context?: ReactNode
}

type FeedbackAction = 'read' | 'save' | 'files' | 'daemon' | 'models' | 'engines' | 'cleanup'
interface FeedbackIssue { source: string; message: string; action?: FeedbackAction }
const daemonVersionFailure = (message: string): boolean => /running daemon build is outdated or unverified|different installed version owns this daemon|running daemon uses the previous role-specific credential format/i.test(message)
const feedbackKey = (message: string): string => daemonVersionFailure(message) ? 'daemon-version' : message.replace(/\s*未自动重发，请核对记录后再发送。$/, '').trim()
const feedbackActionLabel: Record<FeedbackAction, string> = { read: '重新核对会话', save: '重试保存', files: '查看文件', daemon: '检查后台', models: '选择模型', engines: '检查执行引擎', cleanup: '重试结束会话' }

function ConversationFeedback({ issues, onAction }: { issues: FeedbackIssue[]; onAction(action: FeedbackAction): void | Promise<void> }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false), [pending, setPending] = useState<FeedbackAction | null>(null), id = useId()
  const canInteract = useInteractionGuard(), mounted = useRef(true), lock = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const groups = new Map<string, FeedbackIssue[]>()
  for (const issue of issues) { const key = feedbackKey(issue.message), group = groups.get(key); if (group) group.push(issue); else groups.set(key, [issue]) }
  if (!groups.size) return null
  const version = issues.some((issue) => daemonVersionFailure(issue.message)), first = issues[0]
  const setup = issues.every((issue) => ['模型配置', '执行引擎配置', '本机接口'].includes(issue.source))
  const described = describeConnectionError(first.message)
  const description = setup ? { title: first.message, hint: '选择实际可用配置后继续。' } : version ? { title: '后台版本需要处理', hint: '当前后台与应用版本不匹配或尚未核实。已有工作保留，请在后台设置中查看状态。' }
    : first.source === '草稿保存' ? { title: '草稿保存尚未确认', hint: '输入仍保留，请核对会话后重试保存。' }
    : described.title === '本次请求未完成' ? { title: first.source === '历史读取' ? '历史读取未完成' : '本次请求未完成', hint: '展开查看原始原因。已有内容和输入仍保留。' } : described
  const primary = version ? 'daemon' : issues.find((issue) => issue.action)?.action
  const secondary = [...new Set(issues.flatMap((issue) => issue.action ? [issue.action] : []))].filter((action) => action !== primary)
  const run = async (action: FeedbackAction): Promise<void> => {
    if (!canInteract() || lock.current) return
    lock.current = true; setPending(action)
    try { await onAction(action) } finally { lock.current = false; if (mounted.current) setPending(null) }
  }
  return <section className="acp-recovery" role={setup ? 'status' : 'alert'} aria-label="会话异常与恢复">
    <div className="acp-recovery-line"><button type="button" className="acp-recovery-status-trigger" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>{!setup && <CircleAlert size={14} aria-hidden="true" />}<strong>{description.title}</strong><ChevronRight size={11} className={expanded ? 'is-open' : ''} aria-hidden="true" /></button>{primary && <Button size="sm" variant="outline" className="acp-recovery-primary" disabled={Boolean(pending)} onClick={() => void run(primary)}>{pending === primary && <Loader2 size={14} className="animate-spin" />}{feedbackActionLabel[primary]}</Button>}</div>
    <div id={id} hidden={!expanded} className="acp-recovery-details my-scrollbar"><p>{description.hint}</p>{[...groups].map(([key, group]) => <div key={key}><p className="my-item-description">{[...new Set(group.map((issue) => issue.source))].join(' · ')}</p>{[...new Set(group.map((issue) => issue.message))].map((message) => <pre key={message}>{message}</pre>)}</div>)}<div className="acp-recovery-secondary">{secondary.map((action) => <Button key={action} size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => void run(action)}>{feedbackActionLabel[action]}</Button>)}</div></div>
  </section>
}

function RuntimePicker({ current, disabled = false }: { current: WorkspaceEntry; disabled?: boolean }): JSX.Element {
  const runtimes = useConversations((state) => state.runtimes)
  const configuredPi = useConversations((state) => state.configuredPi)
  const descriptionId = useId()
  const selected = runtimes.find((runtime) => runtime.id === current.runtimeId)?.name
  const enabledRuntimes = runtimes.filter((runtime) => runtime.enabled)
  return <Dropdown placement="top" align="right" width={256} gap={8} disabled={disabled || Boolean(current.action) || Boolean(current.conversation?.nativeRef)} trigger={({ toggle, open }) => <button type="button" className="acp-composer-context acp-model-trigger my-composer-control my-composer-control-label" aria-expanded={open} aria-label="选择执行引擎" aria-describedby={descriptionId} title={selected} onClick={toggle}><small className="private-draft-picker-label">引擎</small><span>{selected || '选择引擎'}</span><span id={descriptionId} className="sr-only">{selected ? `当前执行引擎：${selected}` : '尚未选择执行引擎'}</span><ChevronDown size={12} /></button>}>
    {(close) => <><DropdownHeader>执行引擎</DropdownHeader>{enabledRuntimes.map((runtime) => <DropdownItem key={runtime.id} selected={runtime.id === current.runtimeId} disabled={!runtime.available} onClick={() => { setDraftRuntime(current.key, runtime.id); close() }}><span>{runtime.name}</span>{!runtime.available ? <small className="text-my-xs text-my-tertiary">不可用</small> : runtime.id === 'pi' && !configuredPi ? <small className="text-my-xs text-my-tertiary">待配置模型</small> : null}</DropdownItem>)}{!enabledRuntimes.length && <p className="px-3 py-2 text-my-sm text-my-tertiary" role="status">{runtimes.length ? '暂无已启用的执行引擎' : '尚未读取到执行引擎'}</p>}<DropdownItem icon={<Settings2 size={14} />} onClick={() => { close(); openConversationSettings() }}>管理执行引擎与模型</DropdownItem></>}
  </Dropdown>
}

function DraftModelOptions({ models, matches, selectedId, modelTooLong, query, setQuery, select, close }: {
  models: Array<{ id: string; label: string; available: boolean }>; matches: Array<{ id: string; label: string; available: boolean }>
  selectedId?: string; modelTooLong?: boolean; query: string; setQuery(value: string): void; select(id: string): void; close(): void
}): JSX.Element {
  const search = useRef<HTMLDivElement>(null), results = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let interrupted = false
    const interrupt = (): void => { interrupted = true }
    document.addEventListener('pointerdown', interrupt, true); document.addEventListener('keydown', interrupt, true)
    const frame = requestAnimationFrame(() => {
      const input = search.current?.querySelector('input'), menu = input?.closest('.my-menu')
      if (!interrupted && input && menu?.contains(document.activeElement) && getComputedStyle(input).visibility === 'visible') input.focus({ preventScroll: true })
      document.removeEventListener('pointerdown', interrupt, true); document.removeEventListener('keydown', interrupt, true)
    })
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointerdown', interrupt, true); document.removeEventListener('keydown', interrupt, true) }
  }, [])
  return <><DropdownHeader>模型</DropdownHeader><div ref={search} className="px-2 pb-2" onKeyDown={(event) => {
    if (!(event.target instanceof HTMLInputElement) || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const choices = matches.filter((model) => model.available)
    if (event.key === 'Enter' && choices.length === 1) { event.preventDefault(); select(choices[0].id); close() }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const buttons = results.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      const target = event.key === 'ArrowDown' ? buttons?.[0] : buttons?.[buttons.length - 1]
      if (target) { event.preventDefault(); target.focus(); target.scrollIntoView({ block: 'nearest' }) }
    }
  }}><SearchInput size="sm" value={query} onChange={setQuery} ariaLabel="搜索模型" placeholder="搜索模型" /></div>
    <div ref={results}>{matches.map((model) => <DropdownItem key={model.id} selected={!modelTooLong && model.id === selectedId} disabled={!model.available} onClick={() => { select(model.id); close() }}><span title={model.label}>{cleanModelDisplayName(model.label, 'pi')}</span></DropdownItem>)}</div>
    {matches.some((model) => !model.available) && <p className="px-3 py-2 text-my-sm text-my-tertiary" role="status">模型 ID 超过 8192 UTF-8 字节时无法选择</p>}{!matches.length && <p className="px-3 py-2 text-my-sm text-my-tertiary" role="status">{models.length ? '没有匹配的模型' : '暂无已启用的模型'}</p>}<DropdownItem icon={<Settings2 size={14} />} onClick={() => { close(); openModelSettings() }}>管理模型</DropdownItem></>
}

function DraftModelPicker({ current, disabled = false }: { current: WorkspaceEntry; disabled?: boolean }): JSX.Element | null {
  const models = useConversations((state) => state.piModels), defaultModelId = useConversations((state) => state.defaultPiModelId)
  const [query, setQuery] = useState('')
  const descriptionId = useId()
  if (current.runtimeId !== 'pi') return <span className="private-draft-model-unavailable text-my-xs text-my-tertiary" title="连接后可使用引擎实际提供的模型选项">模型：连接后提供</span>
  const selectedId = current.modelId ?? defaultModelId
  const selected = models.find((model) => model.id === selectedId)
  const term = query.trim().toLocaleLowerCase()
  const matches = models.filter((model) => `${model.label} ${model.id}`.toLocaleLowerCase().includes(term))
  const rawCaption = current.modelTooLong ? '所选模型 ID 超出长度限制' : selected?.label ?? (selectedId ? '所选模型不可用' : '选择模型')
  const caption = selected?.label ? cleanModelDisplayName(selected.label, 'pi') : rawCaption
  return <Dropdown placement="top" align="right" width={256} gap={8} disabled={disabled || Boolean(current.action) || Boolean(current.conversation?.nativeRef)} trigger={({ toggle, open }) => <button type="button" className="acp-composer-context acp-model-trigger my-composer-control my-composer-control-label" aria-expanded={open} aria-label="选择模型" aria-describedby={descriptionId} title={caption} onClick={() => { if (!open) setQuery(''); toggle() }}><small className="private-draft-picker-label">模型</small><span>{caption}</span><span id={descriptionId} className="sr-only">当前模型：{caption}</span><ChevronDown size={12} /></button>}>
    {(close) => <div className="acp-model-menu acp-model-choices my-scrollbar"><DraftModelOptions models={models} matches={matches} selectedId={selectedId} modelTooLong={current.modelTooLong} query={query} setQuery={setQuery} select={(id) => setDraftModel(current.key, id)} close={close} /></div>}
  </Dropdown>
}

export function PrivateConversation({ entryKey, onFiles, onNew, onNewDirectory, directoryPending, directoryFixed = false, composerContext, quickActions, onOpenWebPreview, assistantPort, transcriptFooter, composerReferences, onSendMessage }: {
  entryKey: string; onFiles(): void; onNew(): void; onNewDirectory(): void
  directoryPending: boolean; directoryFixed?: boolean; composerContext: ReactNode; quickActions?: ReactNode
  onOpenWebPreview?: (artifact: PiWebPreviewArtifact, eventId: string) => void
  assistantPort?: PrivateConversationAssistantPort
  transcriptFooter?: ReactNode; composerReferences?: ReactNode; onSendMessage?(): Promise<unknown>
}): JSX.Element | null {
  const current = useConversations((state) => state.entries[entryKey]), initialized = useConversations((state) => state.initialized)
  const managementBusy = useConversations((state) => state.managementBusy[state.entries[entryKey]?.conversation?.id ?? ''])
  const managementError = useConversations((state) => state.managementErrors[state.entries[entryKey]?.conversation?.id ?? ''])
  const runtimes = useConversations((state) => state.runtimes), configuredPi = useConversations((state) => state.configuredPi), runtimeError = useConversations((state) => state.runtimeError)
  const piModels = useConversations((state) => state.piModels)
  const interactive = useInteractionActive(), canInteract = useInteractionGuard(), source = useDocumentSource()
  const [now, setNow] = useState(Date.now), [segment, setSegment] = useState<TranscriptActiveSegment | null>(null), [atBottom, setAtBottom] = useState(true)
  const stream = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null), composing = useRef(false)
  const currentRef = useRef(current); currentRef.current = current
  const assistantRef = useRef(assistantPort); assistantRef.current = assistantPort
  const assistantOwner = JSON.stringify([entryKey, current?.owner, Boolean(assistantPort)])
  const assistantOwnerRef = useRef(assistantOwner); assistantOwnerRef.current = assistantOwner
  const [assistantFailure, setAssistantFailure] = useState<{ owner: string; message: string } | null>(null), [assistantSending, setAssistantSending] = useState(false)
  const assistantLock = useRef<symbol | null>(null), mounted = useRef(true)
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; assistantLock.current = null } }, [])
  useEffect(() => { assistantLock.current = null; setAssistantSending(false); setAssistantFailure(null) }, [assistantOwner])
  const focusIntent = useRef<{ key: string; request: string } | null>(null)
  const following = useRef(true), previousKey = useRef(''), pendingAnchor = useRef<{ key: string; snapshot: TranscriptScrollAnchor } | null>(null)
  const font = useMy((state) => state.fontSize)
  const permissions = useMemo(() => current ? actionablePermissions(current, now) : {}, [current?.session, current?.conversation, now])
  const transcriptEvents = useMemo(() => assistantPort ? assistantPort.events.filter((event) => current?.conversation?.nativeRef?.sessionId && event.sessionId === current.conversation.nativeRef.sessionId && projectRootKey(event.projectRoot) === projectRootKey(current.conversation.workspace.root)) : current?.events ?? [], [assistantPort?.events, Boolean(assistantPort), current?.events, current?.conversation?.nativeRef?.sessionId, current?.conversation?.workspace.root])
  const items = useMemo(() => compileItems(transcriptEvents), [transcriptEvents])
  const owner = conversationNativeOwner(entryKey)
  const currentSource = (): boolean => canInteract() && !currentRef.current?.locked && currentRef.current?.key === entryKey && (!source || source.isCurrent())
  const currentEntry = (): boolean => canInteract() && isPrivateEntrySelected(entryKey)
  const composerImages = useComposerImages({
    root: current?.conversation?.workspace.root ?? '', sessionId: current?.locked ? undefined : entryKey,
    generation: current?.session?.connectionGeneration, isCurrent: () => !assistantRef.current && currentSource(),
    draftSource: {
      identity: JSON.stringify([entryKey, current?.owner]),
      read: (key) => { const value = useConversations.getState().entries[key]; return value && !value.locked && key === entryKey ? value.images ?? [] : [] },
      write: (key, images) => { if (!assistantRef.current && currentSource() && key === entryKey) setDraftImages(key, images, useConversations.getState().entries[key]?.owner) }
    }
  })
  useComposerAutoSize({ textareaRef: composer, value: assistantPort?.text ?? current?.text ?? '', active: interactive && Boolean(current && !current.locked), ownerKey: assistantPort ? `assistant:${entryKey}` : entryKey, status: current?.session?.status, fontSize: font })
  useEffect(() => {
    if (!interactive) return
    const visible = (): void => { if (!document.hidden) { setNow(Date.now()); if (currentRef.current?.conversation) void readConversation(currentRef.current.key) } }
    document.addEventListener('visibilitychange', visible)
    const timer = window.setInterval(() => { if (!document.hidden && currentRef.current?.session?.pendingPermissions?.length) setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [interactive])
  useEffect(() => { if (interactive && currentRef.current?.conversation) void readConversation(entryKey) }, [entryKey, interactive])
  useLayoutEffect(() => {
    if (assistantPort) { focusIntent.current = null; return }
    const request = current?.composerFocus
    if (!request) { focusIntent.current = null; return }
    const intent = { key: entryKey, request }
    focusIntent.current = intent
    const cancel = (): void => {
      if (useConversations.getState().entries[entryKey]?.composerFocus === request) patchEntry(entryKey, { composerFocus: undefined })
      if (focusIntent.current === intent) focusIntent.current = null
    }
    if (!interactive || current.locked || !currentEntry() || document.hidden || document.querySelector('[role="dialog"]')) { cancel(); return }
    if (!current.loaded || current.action === 'directory' || !composer.current) return
    const frame = requestAnimationFrame(() => {
      const field = composer.current, focused = document.activeElement
      if (focusIntent.current !== intent || useConversations.getState().entries[entryKey]?.composerFocus !== request || !currentEntry() || !field?.isConnected || !field.checkVisibility() || field.disabled || document.hidden || document.querySelector('[role="dialog"]')) { cancel(); return }
      cancel()
      if (focused instanceof HTMLElement && focused !== field && (focused.matches('input,textarea,select,[contenteditable="true"]') || focused.closest('.acp-inspector,.acp-transcript'))) return
      field.focus({ preventScroll: true })
    })
    return () => { cancelAnimationFrame(frame); if (currentRef.current?.key !== entryKey || !currentEntry()) cancel() }
  }, [entryKey, current?.composerFocus, current?.loaded, current?.action, current?.locked, interactive, Boolean(assistantPort)])
  useEffect(() => {
    const cancel = (): void => {
      const intent = focusIntent.current
      if (!intent) return
      if (useConversations.getState().entries[intent.key]?.composerFocus === intent.request) patchEntry(intent.key, { composerFocus: undefined })
      focusIntent.current = null
    }
    document.addEventListener('pointerdown', cancel, true); document.addEventListener('keydown', cancel, true)
    return () => { document.removeEventListener('pointerdown', cancel, true); document.removeEventListener('keydown', cancel, true) }
  }, [])
  useLayoutEffect(() => {
    const element = stream.current, value = currentRef.current
    if (!element || !value) return
    const scrollOwner = assistantPort ? `assistant:${entryKey}` : entryKey
    if (previousKey.current !== scrollOwner) {
      previousKey.current = scrollOwner; following.current = assistantPort ? true : value.following ?? true
      element.scrollTop = assistantPort ? element.scrollHeight : value.scrollTop ?? element.scrollHeight; setAtBottom(following.current); setSegment(null)
    } else if (!assistantPort && pendingAnchor.current?.key === entryKey && !value.earlierLoading) {
      restoreTranscriptAnchor(element, pendingAnchor.current.snapshot); pendingAnchor.current = null
    } else if (following.current || value.submission && value.following) element.scrollTop = element.scrollHeight
  }, [entryKey, transcriptEvents, transcriptFooter, current?.submission, current?.earlierLoading, current?.session?.status, Boolean(assistantPort)])
  const activity = useMemo(() => projectCurrentTurnActivity({ root: current?.conversation?.workspace.root ?? '', session: current?.session ?? null, events: transcriptEvents, request: current?.request, interactive }), [current?.conversation?.workspace.root, current?.session, transcriptEvents, current?.request, interactive])
  const displayedActivity = useMemo<CurrentTurnActivity | null>(() => activity ?? (current?.action === 'sending' && interactive ? { phase: 'submitting', label: '正在发送…', spinning: true } : null), [activity, current?.action, interactive])
  if (!current) return null
  if (current.locked) return <div role="status" className="acp-empty">原会话的本机身份尚未核对，请在历史中重新打开。</div>
  const session = current.session, running = sessionRunning(current), assistantPending = Boolean(assistantPort && (assistantPort.pending || assistantSending))
  const ownsPicker = (): boolean => Boolean(owner && currentSource() && !assistantRef.current?.pending && !assistantLock.current && (!assistantRef.current || !currentRef.current || !sessionRunning(currentRef.current)) && ownsConversationNative(entryKey, owner))
  const configureSession = async (configuration: AcpConfigureInput) => {
    const client = conversationClient()
    if (!owner || !client?.configure || !ownsPicker()) return { ok: false, error: '原会话的配置服务当前不可用。' }
    try {
      const result = conversationValue(await client.configure(owner.conversationId, { expectedConnectionGeneration: owner.generation, configuration }))
      return { ok: true, session: result }
    } finally { void readConversation(entryKey) }
  }
  const recoverModel = async (modelId: string): Promise<void> => {
    const client = conversationClient()
    if (!owner || !client?.recoverModel || !ownsPicker()) throw new Error('原会话的模型恢复服务当前不可用。')
    const release = acquireConversationConfiguration(entryKey, owner, true)
    if (!release) throw new Error('原会话正在执行其他操作，请稍后重试。')
    try {
      const result = conversationValue(await client.recoverModel(owner.conversationId, { expectedConnectionGeneration: owner.generation, modelId }))
      if (!currentSource() || !release.isCurrent()) return
      if (!acceptConversationSession(entryKey, result, owner, true, release.isCurrent)) throw new Error('原会话连接已改变，请核对后再选择模型。')
    } finally { release(); void readConversation(entryKey) }
  }
  const ownSegment = Boolean(segment && segment.owner.sessionId === session?.sessionId && segment.owner.connectionGeneration === session?.connectionGeneration && segment.owner.turnId === session?.turnId && projectRootKey(segment.owner.projectRoot) === projectRootKey(session?.projectRoot))
  const missingRuntime = !current.conversation?.nativeRef && (!current.runtimeId || !runtimes.some((runtime) => runtime.id === current.runtimeId && runtime.enabled && runtime.available))
  const missingModel = !current.conversation?.nativeRef && current.runtimeId === 'pi' && (!configuredPi || current.modelTooLong || !piModels.some((model) => model.id === (current.modelId ?? useConversations.getState().defaultPiModelId) && model.available))
  const missingDirectory = current.kind === 'code' && !current.directory && !current.conversation
  const archived = current.conversation?.archivedAt !== undefined
  const readOnly = archived || session?.historyKind === 'transcript' || session?.historyKind === 'legacy'
  const directory = current.conversation?.workspace.root ?? current.directory?.path
  const nativeAvailable = Boolean(conversationClient())
  const pickCodeDirectory = async (): Promise<void> => {
    if (!currentEntry()) return
    if (current.conversation?.nativeRef || directoryFixed) { onNewDirectory(); return }
    if (await chooseDirectory(entryKey) && currentEntry() && currentRef.current?.key === entryKey) requestComposerFocus(entryKey)
  }
  const send = (): void => {
    if (!currentSource() || readOnly) return
    if (assistantPort) {
      if (!currentEntry() || assistantRef.current?.pending || assistantLock.current || running || current.action || !assistantPort.text.trim()) return
      const token = Symbol(entryKey), expectedOwner = assistantOwner, port = assistantPort
      assistantLock.current = token; setAssistantSending(true); setAssistantFailure(null); following.current = true; setAtBottom(true)
      void Promise.resolve().then(() => mounted.current && assistantRef.current && assistantOwnerRef.current === expectedOwner && currentSource() ? port.onSend() : undefined).catch((cause) => { if (mounted.current && assistantOwnerRef.current === expectedOwner && currentSource()) setAssistantFailure({ owner: expectedOwner, message: conversationError(cause) }) }).finally(() => { if (assistantLock.current === token) { assistantLock.current = null; if (mounted.current) setAssistantSending(false) } })
      return
    }
    if (composerImages.pending) return
    if (onSendMessage) {
      const expectedOwner = current.owner
      following.current = true; setAtBottom(true)
      void onSendMessage().catch(cause => { if (currentSource() && currentRef.current?.owner === expectedOwner) patchEntry(entryKey, { error: conversationError(cause) }) })
      return
    }
    following.current = true; setAtBottom(true); void sendMessage(entryKey)
  }
  const openRecordedArtifact = (file: { path: string }): void => {
    if (!source || !currentSource()) return
    void source.openDocument(file.path).catch((cause) => { if (currentSource()) patchEntry(entryKey, { error: conversationError(cause) }) })
  }
  const older = (): void => { const element = stream.current; if (!element || !currentSource()) return; following.current = false; pendingAnchor.current = { key: entryKey, snapshot: captureTranscriptAnchor(element) }; void earlierMessages(entryKey) }
  const contextActions = (close: () => void): JSX.Element => <>
    {!assistantPort && <button type="button" className="acp-add-action my-menu-item" disabled={readOnly} onClick={() => { close(); composerImages.choose() }}><ImagePlus size={14} /><span>添加图片</span></button>}
    {!assistantPort && <button type="button" className="acp-add-action my-menu-item" disabled={!nativeAvailable || Boolean(current.action) || missingDirectory || !current.loaded || readOnly} onClick={() => { close(); if (currentSource()) void addFiles(entryKey) }}><Paperclip size={14} /><span>添加本机文件</span></button>}
    <button type="button" className="acp-add-action my-menu-item" onClick={() => { close(); onFiles() }}><FileText size={14} /><span>会话文件</span></button>
    {!assistantPort && current.kind === 'code' && <button type="button" className="acp-add-action my-menu-item" disabled={!nativeAvailable || Boolean(current.action) || directoryPending || readOnly} title={directory} onClick={() => { close(); void pickCodeDirectory() }}><Folder size={14} /><span>{current.conversation?.nativeRef || directoryFixed ? '为其他工程新建对话' : directory ? '更换工作目录' : '选择工作目录'}</span></button>}
  </>
  const sendAction = running ? (
    <button type="button" className="acp-composer-action acp-composer-stop my-composer-control" title={current.action === 'cancel' || session?.status === 'cancelling' ? '正在停止…' : '停止当前回合'} aria-label={current.action === 'cancel' || session?.status === 'cancelling' ? '正在停止' : '停止当前回合'} disabled={!nativeAvailable || Boolean(current.action) || session?.status === 'cancelling'} onClick={() => { if (currentSource()) void controlConversation(entryKey, 'cancel') }}><CircleStop size={15} aria-hidden="true" /></button>
  ) : (
    <button type="button" className="acp-composer-action acp-composer-send my-composer-control" title="发送指令" aria-label="发送指令" disabled={!nativeAvailable || !initialized || missingRuntime || missingModel || current.modelConfirmationRequired || missingDirectory || !current.loaded || Boolean(current.action) || (assistantPort ? !assistantPort.text.trim() || assistantPending : (!current.text.trim() && !composerImages.images.length) || composerImages.pending) || readOnly} onClick={send}>{current.action === 'sending' || assistantPending ? <Loader2 size={15} className="acp-progress-spinner" /> : <Send size={15} />}</button>
  )
  const error = (assistantPort ? assistantFailure?.owner === assistantOwner ? assistantFailure.message : undefined : current.error) || current.nativeError || (session?.status === 'error' ? session.error : undefined) || (archived ? managementError : undefined)
  const feedbackIssues: FeedbackIssue[] = []
  const issue = (source: string, message: string | undefined, action?: FeedbackAction): void => { if (message) feedbackIssues.push({ source, message, action }) }
  if (assistantPort) issue('需求助手', assistantFailure?.owner === assistantOwner ? assistantFailure.message : undefined)
  else issue('会话操作', current.error)
  issue('原生连接', current.nativeError, 'read'); issue('当前连接', session?.status === 'error' ? session.error : undefined, 'engines')
  issue('历史读取', current.loadError, 'read')
  if (!assistantPort) { issue('草稿保存', current.saveError, /原生会话已绑定/.test(current.saveError ?? '') ? 'read' : 'save'); issue('会话文件', current.fileError, 'files') }
  issue('执行引擎目录', runtimeError, 'engines')
  if (archived) issue('归档管理', managementError)
  if (session?.cleanupRequired) issue('连接清理', session.error || '会话尚未完全结束，请重试释放原连接。', 'cleanup')
  if (!nativeAvailable) issue('本机接口', '本机会话接口当前不可用，输入仍可编辑。')
  else if (initialized && missingModel) issue('模型配置', '请选择可用模型后发送。', 'models')
  else if (initialized && missingRuntime) issue('执行引擎配置', '选择可用执行引擎后即可发送。', 'engines')
  const recoverFeedback = async (action: FeedbackAction): Promise<void> => {
    if (!currentSource()) return
    if (action === 'read') await readConversation(entryKey)
    else if (action === 'save') await saveDraft(entryKey).catch(() => undefined)
    else if (action === 'files') onFiles()
    else if (action === 'cleanup') await controlConversation(entryKey, 'end')
    else if (action === 'models') openModelSettings()
    else if (action === 'daemon') { useMy.getState().setSettingsView('daemon'); useApp.getState().setPage('settings') }
    else openConversationSettings()
  }
  const empty = !transcriptEvents.length && !displayedActivity && Boolean(assistantPort || !current.loadError && !current.loading)
  return <section className="acp-content" data-empty={empty && !readOnly || undefined}>
    <div ref={stream} className="acp-transcript my-scrollbar" role="region" aria-label="会话消息" tabIndex={0} onScroll={(event) => {
      const element = event.currentTarget, next = element.scrollHeight - element.scrollTop - element.clientHeight < 48
      if (!assistantPort && current.earlierLoading && pendingAnchor.current?.key === entryKey) pendingAnchor.current.snapshot = captureTranscriptAnchor(element)
      following.current = next; setAtBottom(next); if (!assistantPort) patchEntry(entryKey, { scrollTop: element.scrollTop, following: next })
    }}><div className="acp-transcript-content my-conversation-column acp-chat-copy">
      {!assistantPort && current.page && (current.page.hasEarlier || current.page.startsMidTurn || current.page.coverage.state !== 'complete') && <HistoryBoundary key={`history:${current.conversation?.workspace.root}:${current.conversation?.nativeRef?.sessionId}`} hasEarlier={current.page.hasEarlier} startsMidTurn={current.page.startsMidTurn} coverage={current.page.coverage.state} loading={Boolean(current.earlierLoading)} onLoadEarlier={older} />}
      {current.loading && !current.loaded && <p className="my-activity-note" role="status"><Loader2 size={14} className="animate-spin" />正在读取对话…</p>}
      {session && <ConversationTranscript privateConversation session={session} events={transcriptEvents} items={items} currentActivity={displayedActivity} onActiveSegmentChange={setSegment} suppressWorkingIndicator={Boolean(displayedActivity)} pendingPerm={permissions} permissionPending={current.permissionPending} permissionErrors={current.permissionErrors} onRespond={(requestId, optionId) => { if (currentSource()) void respondPermission(entryKey, requestId, optionId) }} onOpenArtifact={openRecordedArtifact} onOpenTask={onFiles} onOpenSpec={onFiles} onOpenJira={onFiles} onOpenWebPreview={onOpenWebPreview} />}
      {session && Object.values(permissions).filter((permission) => !items.some((item) => item.type === 'perm' && item.ev.payload?.requestId === permission.requestId)).map((permission) => <EventRow key={`current-permission:${permission.requestId}`} item={{ type: 'perm', key: `current-permission:${permission.requestId}`, ev: { id: `current-permission:${permission.requestId}`, ts: 0, source: session.engine ?? 'acp', kind: 'permission', sessionId: session.sessionId, projectRoot: session.projectRoot, text: permission.toolCall?.title ?? '等待你的授权', payload: { requestId: permission.requestId } } }} session={session} events={current.events} pendingPerm={permissions} permissionPending={current.permissionPending} permissionErrors={current.permissionErrors} onRespond={(requestId, optionId) => { if (currentSource()) void respondPermission(entryKey, requestId, optionId) }} onOpenArtifact={openRecordedArtifact} onOpenTask={onFiles} onOpenSpec={onFiles} onOpenJira={onFiles} />)}
      {empty && !readOnly && (assistantPort ? assistantPort.emptyState : <div className="acp-conversation-start"><h1>{current.kind === 'code' ? '从一个想法开始。' : '今天想完成什么？'}</h1><p>{current.kind === 'code' ? '描述要构建、修改或排查的问题。' : '整理资料、梳理需求，或直接开始对话。'}</p></div>)}
      {!assistantPort && transcriptFooter}
      <CurrentTurnStatus activity={ownSegment ? null : displayedActivity} />
    </div></div>
    {!atBottom && <div className="acp-scroll-to-bottom-container"><Button size="sm" variant="outline" className="acp-scroll-to-bottom-btn" onClick={(event) => { const element = stream.current; pendingAnchor.current = null; following.current = true; if (element) { if (document.activeElement === event.currentTarget) element.focus({ preventScroll: true }); element.scrollTop = element.scrollHeight }; if (!assistantPort) patchEntry(entryKey, { following: true }); setAtBottom(true) }}><ArrowDown size={12} aria-hidden="true" />回到最新</Button></div>}
    <footer className="acp-composer-region my-conversation-column">
      {!readOnly && (assistantPort ? assistantPort.context && <fieldset disabled={assistantPending || running || Boolean(current.action)} className="acp-composer-contextbar border-0" aria-label="需求助手上下文">{assistantPort.context}</fieldset> : <div className="acp-composer-contextbar" aria-label="会话资料与工作上下文">
        {current.kind === 'code' && <Button variant="ghost" size="sm" className="acp-context-action acp-directory-context" disabled={!nativeAvailable || Boolean(current.action) || directoryPending} title={directory} aria-label={current.conversation?.nativeRef || directoryFixed ? '选择其他工程并新建对话' : '选择 Code 工作目录'} onClick={() => void pickCodeDirectory()}><Folder size={14} aria-hidden="true" /><span>{directory ? projectNameFromPath(directory) : '选择工程'}</span><ChevronDown size={12} aria-hidden="true" /></Button>}
        {current.kind === 'code' && <ConversationGitContext entryKey={entryKey} />}
        {composerContext}
      </div>)}
      <ConversationFeedback key={JSON.stringify([assistantOwner, current.session?.connectionGeneration])} issues={feedbackIssues} onAction={recoverFeedback} />
      {!assistantPort && !readOnly && composerReferences}
      {readOnly ? <div className="acp-history-note"><p>{archived ? '此对话已归档。' : '此会话仅保留历史记录。'}</p>{archived && current.conversation && <Button size="sm" variant="ghost" disabled={managementBusy} onClick={() => { if (currentSource() && current.conversation) void updateConversation(current.conversation.id, { archived: false }) }}>{managementBusy ? <Loader2 size={14} className="animate-spin" /> : <ArchiveRestore size={14} />}恢复对话</Button>}<Button size="sm" variant="ghost" onClick={onNew}>新建对话</Button>{running && sendAction}</div> : <div className={`acp-composer${!assistantPort && composerImages.dragging ? ' acp-composer-dragging' : ''}`} {...(!assistantPort ? composerImages.dragHandlers : {})} onPaste={!assistantPort ? composerImages.onPaste : undefined}>
        {!assistantPort && <>{composerImages.fileInput}
        {composerImages.dragging && <div className="acp-image-drop-hint" aria-hidden="true"><ImagePlus size={22} /><span>松开以添加图片</span></div>}
        <ImageAttachments key={entryKey} images={composerImages.images} onRemove={composerImages.remove} />
        {composerImages.pending && <p className="acp-image-status" role="status"><Loader2 size={12} className="animate-spin" />正在添加图片…</p>}
        {composerImages.error && <p className="acp-image-status text-my-danger-text" role="alert">{composerImages.error}</p>}
        {composerImages.images.length > 0 && session && session.capabilities?.promptCapabilities?.image !== true && <p className="acp-image-status text-my-warning-text" role="status">当前执行引擎未声明支持图片输入，图片草稿已保留</p>}
        {current.files.some((file) => file.kind === 'input') && <div className="acp-source-references">{current.files.filter((file) => file.kind === 'input').map((file) => <button type="button" key={file.id} className="acp-source-chip" onClick={onFiles} title={file.relativePath}><Paperclip size={12} /><span>{file.name}</span></button>)}</div>}
        </>}
        <textarea ref={composer} value={assistantPort?.text ?? current.text} aria-label={assistantPort ? '需求助手指令' : current.kind === 'code' ? 'Code 会话指令' : '会话指令'} title="Enter 发送 · Shift Enter 换行" placeholder="说说你的想法…" maxLength={200_000} disabled={!current.loaded} rows={2} onChange={(event) => assistantPort ? assistantPort.onTextChange(event.target.value) : editDraft(entryKey, event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); if (!missingRuntime && !missingModel && !current.modelConfirmationRequired && !missingDirectory && !current.action && !running) send() } }} />
        <div className="acp-composer-toolbar">
          {session && owner ? <ComposerModelPicker
            key={`${owner.sessionId}:${owner.generation}`} session={session} message={error} requireModelConfirmation={current.modelConfirmationRequired}
            operationPending={assistantPending || Boolean(assistantPort && running) || Boolean(current.action) || !current.loaded || typeof conversationClient()?.configure !== 'function'}
            acquireConfiguration={() => ownsPicker() ? acquireConversationConfiguration(entryKey, owner) : undefined}
            isCurrent={ownsPicker} configureSession={configureSession}
            onUpdated={(updated) => { if (ownsPicker()) acceptConversationSession(entryKey, updated, owner) }}
            onRecoverModel={recoverModel} contextActions={contextActions}
            usage={<ComposerUsageIndicator session={session} events={current.events} />} sendAction={sendAction}
          /> : <div className="acp-composer-controls private-draft-controls">
            <div className="acp-composer-controls-left">
              <Dropdown placement="top" width={290} trigger={({ open, toggle }) => <button type="button" className="acp-composer-add my-composer-control" aria-label="添加与会话选项" aria-expanded={open} onClick={toggle}><Plus size={19} /></button>}>
                {(close) => <div className="acp-add-menu my-scrollbar"><DropdownHeader>添加</DropdownHeader>{contextActions(close)}</div>}
              </Dropdown>
            </div>
            <div className="acp-composer-controls-right"><RuntimePicker current={current} disabled={assistantPending} /><DraftModelPicker current={current} disabled={assistantPending} />{sendAction}</div>
          </div>}
        </div>
      </div>}
      {current.modelConfirmationRequired && <div className="acp-history-note mt-2" role="status">模型变更结果尚未确认，请重新选择当前模型或其他模型后发送。</div>}
      {empty && !readOnly && !assistantPort && quickActions}
    </footer>
  </section>
}
