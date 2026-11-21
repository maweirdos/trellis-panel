import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { ArchiveRestore, ArrowDown, ArrowUp, ChevronDown, FileText, Folder, ImagePlus, Loader2, Paperclip, Plus, ShieldCheck, Sparkles, Square, X } from 'lucide-react'
import type { AcpConfigureInput, TimelineEvent } from '@shared/types'
import type { ConversationTaskTurn } from '@shared/conversation-task'
import { api } from '../api'
import type { PiWebPreviewArtifact } from '@shared/pi-web-preview'
import { ConversationTranscript } from '../acp/ConversationTranscript'
import { isRecordedTurnFailure, type TranscriptOwner } from '../acp/conversation-transcript'
import { ComposerModelPicker } from '../acp/ComposerModelPicker'
import { ComposerUsageIndicator } from '../acp/ComposerUsageIndicator'
import { HistoryBoundary } from '../acp/ConversationHistoryBoundary'
import { useComposerAutoSize } from '../acp/useComposerAutoSize'
import { useComposerImages } from '../acp/useComposerImages'
import { ImageAttachments } from '../acp/ImageAttachments'
import { ConnectionActionStrip, describeConnectionError } from '../acp/ConnectionNotice'
import { getModelRecovery } from '../acp/model-recovery'
import { FeedbackNotice, normalizeFeedbackDiagnostic } from '../my/FeedbackNotice'
import { EventRow } from '../acp/TranscriptRow'
import { captureTranscriptAnchor, restoreTranscriptAnchor, type TranscriptScrollAnchor } from '../acp/transcript-scroll'
import { useDocumentSource } from '../reader/document-source'
import { compileItems } from '../acp/timeline'
import { CurrentTurnStatus } from '../acp/CurrentTurnStatus'
import { projectCurrentTurnActivity, type CurrentTurnActivity } from '../acp/current-turn-activity'
import { Button, Dropdown, DropdownHeader } from '../my/ui'
import { useMy } from '../my/store'
import { useApp } from '../store'
import { projectNameFromPath, projectRootKey } from '../my/navigation'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { conversationClient, conversationError, conversationValue } from './client'
import { isPrivateEntrySelected } from './source'
import { UnifiedModelPicker } from './UnifiedModelPicker'
import { ConversationGitContext } from './GitContext'
import { acceptConversationSession, acquireConversationConfiguration, actionablePermissions, addFiles, canRetryFailedSubmission, chooseDirectory, controlConversation, conversationNativeOwner, dismissFailedSubmission, earlierMessages, editDraft, ownsConversationNative, patchEntry, readConversation, reconnectConversation, reconcileSubmittedMessage, retainConversationDrafts, submittedMessageRecorded, refreshWorkspace, requestComposerFocus, respondPermission, saveDraft, selectedInputFiles, referenceInputFile, sendMessage, sessionRunning, setDraftImages, updateConversation, useConversations } from './workspace'

export function openConversationSettings(): void {
  useMy.getState().setSettingsView('engines'); useApp.getState().setPage('settings')
}

export function openModelSettings(): void { useApp.getState().setPage('models') }

export interface PrivateConversationAssistantPort {
  hasSourceInput?: boolean
  text: string
  onTextChange(text: string): void
  onSend(): void | Promise<unknown>
  pending: boolean
  emptyState: ReactNode
  events: readonly TimelineEvent[]
  context?: ReactNode
}

type FeedbackAction = 'read' | 'save' | 'files' | 'daemon' | 'restart' | 'models' | 'engines' | 'reconnect' | 'cleanup'
interface FeedbackIssue { source: string; message: string; action?: FeedbackAction }
const daemonVersionFailure = (message: string): boolean => /running daemon build is outdated or unverified|different installed version owns this daemon|running daemon uses the previous role-specific credential format/i.test(message)
const feedbackKey = (message: string): string => daemonVersionFailure(message) ? 'daemon-version' : message.trim()
const feedbackActionLabel: Record<FeedbackAction, string> = { read: '核对会话状态', save: '重试保存', files: '查看文件', daemon: '检查后台', restart: '重启并继续', models: '选择模型', engines: '检查执行引擎', reconnect: '重试连接', cleanup: '重试结束会话' }
const taskTurnEvent = 'conversation-task-turn-updated'

function useConversationTaskTurn(entryKey: string, conversationId: string | undefined): ConversationTaskTurn | undefined {
  const [turn, setTurn] = useState<ConversationTaskTurn | undefined>()
  useEffect(() => {
    if (!conversationId) return
    let live = true
    const onTaskTurnUpdated = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return
      const detail = event.detail as { conversationId?: string; turn?: ConversationTaskTurn }
      if (detail.conversationId === conversationId) setTurn(detail.turn)
    }
    window.addEventListener(taskTurnEvent, onTaskTurnUpdated)
    const run = async (): Promise<void> => {
      const client = conversationClient()
      if (!client?.taskAction) return
      const result = conversationValue(await client.taskAction(conversationId, { action: 'status' }))
      if (live) setTurn(result.state === 'idle' ? undefined : result.turn)
    }
    setTurn(undefined)
    void run().catch(() => { if (live) setTurn(undefined) })
    return () => { live = false; window.removeEventListener(taskTurnEvent, onTaskTurnUpdated) }
  }, [entryKey, conversationId])
  return turn
}

function taskTurnSource(turn: ConversationTaskTurn, session: { engine?: string }): TimelineEvent['source'] {
  return session.engine === 'pi' || session.engine === 'trellis' ? session.engine : 'acp'
}


function ConversationFeedback({ issues, connectionAction, modelConfirmed, onAction }: {
  issues: FeedbackIssue[]
  connectionAction?: FeedbackAction
  modelConfirmed?: boolean
  onAction(action: FeedbackAction): void | Promise<void>
}): JSX.Element | null {
  const [pending, setPending] = useState<FeedbackAction | null>(null), [result, setResult] = useState('')
  const [build, setBuild] = useState<'current' | 'changed' | 'unknown'>('unknown')
  const hasVersionIssue = issues.some(issue => daemonVersionFailure(issue.message))
  useEffect(() => {
    let current = true
    setBuild('unknown')
    if (hasVersionIssue && api.daemon?.inspectRecovery) void api.daemon.inspectRecovery().then(result => {
      if (current && result.ok) setBuild(result.data.build)
    }).catch(() => { if (current) setBuild('unknown') })
    return () => { current = false }
  }, [hasVersionIssue])
  const canInteract = useInteractionGuard(), mounted = useRef(true), lock = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const groups = new Map<string, FeedbackIssue[]>()
  for (const issue of issues) { const key = feedbackKey(issue.message), group = groups.get(key); if (group) group.push(issue); else groups.set(key, [issue]) }
  const run = async (action: FeedbackAction): Promise<void> => {
    if (!canInteract() || lock.current) return
    lock.current = true; setPending(action); setResult('')
    try { await onAction(action); if (mounted.current) setResult(action === 'read' ? '会话状态已核对。' : action === 'save' ? '草稿保存已核对。' : '') } catch (cause) { if (mounted.current) setResult(conversationError(cause)) } finally { lock.current = false; if (mounted.current) setPending(null) }
  }
  const first = issues[0]
  if (!first) return connectionAction ? <ConnectionActionStrip>
    <Button size="sm" variant="outline" disabled={Boolean(pending)} onClick={() => void run(connectionAction)}>{feedbackActionLabel[connectionAction]}</Button>
    {result && <span role="status">{normalizeFeedbackDiagnostic(result)}</span>}
  </ConnectionActionStrip> : null
  const version = issues.some((issue) => daemonVersionFailure(issue.message))
  const setup = issues.every((issue) => ['模型配置', '执行引擎配置', '本机接口'].includes(issue.source))
  const described = describeConnectionError(first.message)
  const description = setup ? { title: first.message, hint: undefined } : version ? build === 'changed'
    ? { title: '需要重启完成更新', hint: '应用组件已更新。重启后可回到当前会话；运行中的任务会先核对并由你决定。' }
    : { title: '连接需要恢复', hint: '当前连接状态尚未核实，原会话仍保留。请重新核对连接或查看后台状态。' }
    : modelConfirmed && ['原生连接', '当前连接'].includes(first.source) ? { title: '模型已确认，连接仍失败', hint: '请重试连接，恢复后可手动发送。' }
    : first.source === '草稿保存' ? { title: '草稿保存尚未确认', hint: '输入仍保留，请核对会话后重试保存。' }
    : described.title === '本次请求未完成' ? { title: first.source === '历史读取' ? '历史读取未完成' : first.message.startsWith('发送失败') ? '发送失败' : '本次请求未完成', hint: '展开查看原始原因。已有内容和输入仍保留。' } : described
  const primary: FeedbackAction | undefined = version ? build === 'changed' ? 'restart' : 'read' : issues.find((issue) => issue.action)?.action
  const secondary = [...new Set<FeedbackAction>([...(version ? ['daemon' as const] : []), ...issues.flatMap((issue) => issue.action ? [issue.action] : []), ...(connectionAction ? [connectionAction] : [])])].filter((action) => action !== primary)
  const diagnostic = !setup
    ? [...groups.values()].map(group => [
      `[${[...new Set(group.map((issue) => issue.source))].join(' · ')}]`,
      ...[...new Set(group.map((issue) => issue.message))].map(message => `- ${message}`)
    ].join('\n')).join('\n')
    : undefined
  return <section className="acp-recovery" aria-label="会话异常与恢复">
    <FeedbackNotice
      title={description.title}
      description={(description.hint || result) && <>{description.hint}{result && <span className="my-feedback-result" role="status">{normalizeFeedbackDiagnostic(result)}</span>}</>}
      diagnostic={diagnostic}
      variant="compact"
      announcement={!setup}
      actions={<>
        {primary && <Button size="sm" variant="outline" className="my-feedback-button" disabled={Boolean(pending)} title={primary === 'read' ? '只读取原会话状态，不重发消息、不删除附件或清空草稿' : undefined} onClick={() => void run(primary)}>{pending === primary && <Loader2 size={14} className="animate-spin" />}{feedbackActionLabel[primary]}</Button>}
        {secondary.map((action) => <Button key={action} size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => void run(action)}>{feedbackActionLabel[action]}</Button>)}
      </>}
    />
  </section>
}

export function PrivateConversation({ entryKey, onFiles, onNew, onNewDirectory, directoryPending, directoryFixed = false, composerContext, quickActions, onOpenWebPreview, assistantPort, transcriptHeader, transcriptFooter, renderTurnArtifacts, composerReferences, onSendMessage }: {
  entryKey: string; onFiles(): void; onNew(): void; onNewDirectory(): void
  directoryPending: boolean; directoryFixed?: boolean; composerContext: ReactNode; quickActions?: ReactNode
  onOpenWebPreview?: (artifact: PiWebPreviewArtifact, eventId: string) => void
  assistantPort?: PrivateConversationAssistantPort
  transcriptHeader?: ReactNode; renderTurnArtifacts?: (owner: TranscriptOwner) => ReactNode; transcriptFooter?: ReactNode; composerReferences?: ReactNode; onSendMessage?(): Promise<unknown>
}): JSX.Element | null {
  const current = useConversations((state) => state.entries[entryKey]), initialized = useConversations((state) => state.initialized)
  const managementBusy = useConversations((state) => state.managementBusy[state.entries[entryKey]?.conversation?.id ?? ''])
  const managementError = useConversations((state) => state.managementErrors[state.entries[entryKey]?.conversation?.id ?? ''])
  const runtimes = useConversations((state) => state.runtimes), configuredPi = useConversations((state) => state.configuredPi), runtimeError = useConversations((state) => state.runtimeError)
  const piModels = useConversations((state) => state.piModels)
  const interactive = useInteractionActive(), canInteract = useInteractionGuard(), source = useDocumentSource()
  const [now, setNow] = useState(Date.now), [atBottom, setAtBottom] = useState(true)
  const stream = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null), composing = useRef(false)
  const modelTrigger = useRef<HTMLButtonElement>(null)
  const draftControlsRight = useRef<HTMLDivElement>(null)
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
  const readingAnchor = useRef<TranscriptScrollAnchor | null>(null)
  const font = useMy((state) => state.fontSize)
  const session = current?.session
  const permissions = useMemo(() => current ? actionablePermissions(current, now) : {}, [current?.session, current?.conversation, now])
  const transcriptEvents = useMemo(() => assistantPort ? assistantPort.events.filter((event) => current?.conversation?.nativeRef?.sessionId && event.sessionId === current.conversation.nativeRef.sessionId && projectRootKey(event.projectRoot) === projectRootKey(current.conversation.workspace.root)) : current?.events ?? [], [assistantPort?.events, Boolean(assistantPort), current?.events, current?.conversation?.nativeRef?.sessionId, current?.conversation?.workspace.root])
  const items = useMemo(() => compileItems(transcriptEvents), [transcriptEvents])
  const taskTurn = useConversationTaskTurn(entryKey, current?.conversation?.id)
  const suppressedTaskTurns = useMemo<readonly TranscriptOwner[] | undefined>(() => {
    if (!taskTurn || !session || taskTurn.sessionId !== session.sessionId) return undefined
    return [{ source: taskTurnSource(taskTurn, session), projectRoot: current?.conversation?.workspace.root ?? session.projectRoot, sessionId: taskTurn.sessionId, connectionGeneration: taskTurn.connectionGeneration, turnId: taskTurn.turnId }]
  }, [Boolean(taskTurn), Boolean(session), current?.conversation?.workspace.root, session?.engine, session?.projectRoot, taskTurn?.sessionId, taskTurn?.connectionGeneration, taskTurn?.turnId])
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
      readingAnchor.current = null
      previousKey.current = scrollOwner; following.current = assistantPort ? true : value.following ?? true
      element.scrollTop = assistantPort ? element.scrollHeight : value.scrollTop ?? element.scrollHeight; setAtBottom(following.current)
    } else if (!assistantPort && pendingAnchor.current?.key === entryKey && !value.earlierLoading) {
      restoreTranscriptAnchor(element, pendingAnchor.current.snapshot); pendingAnchor.current = null
    } else if (!following.current && readingAnchor.current) {
      restoreTranscriptAnchor(element, readingAnchor.current)
      readingAnchor.current = captureTranscriptAnchor(element)
    } else if (following.current || value.submission && value.following) element.scrollTop = element.scrollHeight
  }, [entryKey, transcriptEvents, transcriptFooter, current?.submission, current?.earlierLoading, current?.session?.status, Boolean(assistantPort)])
  const activity = useMemo(() => projectCurrentTurnActivity({ root: current?.conversation?.workspace.root ?? '', session: current?.session ?? null, events: transcriptEvents, request: current?.request, interactive }), [current?.conversation?.workspace.root, current?.session, transcriptEvents, current?.request, interactive])
  const displayedActivity = useMemo<CurrentTurnActivity | null>(() => current?.nativeError ? null : activity ?? (current?.action === 'sending' && interactive ? { phase: 'submitting', label: '正在发送…', spinning: true } : null), [activity, current?.action, current?.nativeError, interactive])
  if (!current) return null
  if (current.locked) return <div role="status" className="acp-empty">原会话的本机身份尚未核对，请在历史中重新打开。</div>
  const running = sessionRunning(current), assistantPending = Boolean(assistantPort && (assistantPort.pending || assistantSending))
  const ownsPicker = (): boolean => Boolean(owner && currentSource() && !assistantRef.current?.pending && !assistantLock.current && (!assistantRef.current || !currentRef.current || !sessionRunning(currentRef.current)) && ownsConversationNative(entryKey, owner))
  const configureSession = async (configuration: AcpConfigureInput) => {
    const client = conversationClient()
    if (!owner || !client?.configure || !ownsPicker()) return { ok: false, error: '原会话的配置服务当前不可用。' }
    try {
      const result = conversationValue(await client.configure(owner.conversationId, { expectedConnectionGeneration: owner.generation, configuration }))
      return { ok: true, session: result }
    } finally { void readConversation(entryKey) }
  }
  const recoverModel = async (modelId: string): Promise<boolean> => {
    const client = conversationClient()
    if (!owner || !client?.recoverModel || !ownsPicker()) throw new Error('原会话的模型恢复服务当前不可用。')
    const release = acquireConversationConfiguration(entryKey, owner, true)
    if (!release) throw new Error('原会话正在执行其他操作，请稍后重试。')
    try {
      const result = conversationValue(await client.recoverModel(owner.conversationId, { expectedConnectionGeneration: owner.generation, modelId }))
      if (!currentSource() || !release.isCurrent()) return false
      if (!acceptConversationSession(entryKey, result, owner, true, release.isCurrent)) throw new Error('原会话连接已改变，请核对后再选择模型。')
      return result.status === 'ready'
    } finally { release(); void readConversation(entryKey) }
  }
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
      if (!currentEntry() || assistantRef.current?.pending || assistantLock.current || running || current.action || (!assistantPort.text.trim() && !assistantPort.hasSourceInput)) return
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
    <button type="button" className="acp-composer-action acp-composer-stop" title={current.action === 'cancel' || session?.status === 'cancelling' ? '正在停止…' : '停止当前回合'} aria-label={current.action === 'cancel' || session?.status === 'cancelling' ? '正在停止' : '停止当前回合'} disabled={!nativeAvailable || Boolean(current.action) || session?.status === 'cancelling'} onClick={() => { if (currentSource()) void controlConversation(entryKey, 'cancel') }}><Square size={11} fill="currentColor" strokeWidth={0} aria-hidden="true" /></button>
  ) : (
    <button type="button" className="acp-composer-action acp-composer-send" title="发送指令" aria-label="发送指令" disabled={!nativeAvailable || !initialized || missingRuntime || missingModel || current.modelConfirmationRequired || missingDirectory || !current.loaded || Boolean(current.action) || (assistantPort ? (!assistantPort.text.trim() && !assistantPort.hasSourceInput) || assistantPending : (!current.text.trim() && !composerImages.images.length) || composerImages.pending) || readOnly} onClick={send}>{<ArrowUp size={18} aria-hidden="true" />}</button>
  )
  const nativeError = current.nativeError
  const sessionError = session?.error
  const error = (assistantPort ? assistantFailure?.owner === assistantOwner ? assistantFailure.message : undefined : current.error) || nativeError || (session?.status === 'error' ? sessionError : undefined) || (archived ? managementError : undefined)
  const recovery = session ? getModelRecovery(session, error) : undefined
  const canChooseRecoveryModel = Boolean(owner && recovery?.canRecoverModel && conversationClient()?.recoverModel && !readOnly)
  const reconnect = current.conversation?.nativeRef && conversationClient()?.connect && !readOnly
    ? () => currentSource() ? reconnectConversation(entryKey) : Promise.resolve()
    : undefined
  const canReconnect = Boolean(reconnect && session?.canResume && !session.cleanupRequired
    && ['disconnected', 'error'].includes(session.status) && !recovery?.environmentRequired && !recovery?.modelFailure)
  const connectionAction: FeedbackAction = canChooseRecoveryModel ? 'models' : canReconnect ? 'reconnect' : 'engines'
  const turnReportedConnectionFailure = !session?.cleanupRequired && !session?.recovery && isRecordedTurnFailure(transcriptEvents, session, sessionError)
  const feedbackIssues: FeedbackIssue[] = []
  const issue = (source: string, message: string | undefined, action?: FeedbackAction): void => { if (message) feedbackIssues.push({ source, message, action }) }
  if (assistantPort) issue('需求助手', assistantFailure?.owner === assistantOwner ? assistantFailure.message : undefined)
  else issue('会话操作', current.error)
  issue('原生连接', nativeError, connectionAction)
  issue('当前连接', session?.status === 'error' && !turnReportedConnectionFailure ? sessionError : undefined, connectionAction)
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
    if (action === 'read') { await readConversation(entryKey); const latest = useConversations.getState().entries[entryKey]; if (latest?.loadError) throw new Error(latest.loadError) }
    else if (action === 'restart') {
      patchEntry(entryKey, { action: 'connect' })
      try {
        retainConversationDrafts()
        const result = await api.daemon?.restart()
        if (!result?.ok) throw new Error(result?.error ?? '当前版本未提供重启入口，请完整退出后重新打开')
        await refreshWorkspace()
        await readConversation(entryKey)
        patchEntry(entryKey, { action: undefined })
        if (conversationClient()?.connect) await reconnectConversation(entryKey)
      } catch (cause) { patchEntry(entryKey, { nativeError: cause instanceof Error ? cause.message : '连接恢复未完成，请重新核对' }) }
      finally { if (useConversations.getState().entries[entryKey]?.action === 'connect') patchEntry(entryKey, { action: undefined }) }
    }
    else if (action === 'save') await saveDraft(entryKey).catch(() => undefined)
    else if (action === 'files') onFiles()
    else if (action === 'cleanup') await controlConversation(entryKey, 'end')
    else if (action === 'models') {
      const trigger = modelTrigger.current
      if (!trigger) openModelSettings()
      else if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
    }
    else if (action === 'reconnect') await reconnect?.()
    else if (action === 'daemon') { useMy.getState().setSettingsView('daemon'); useApp.getState().setPage('settings') }
    else openConversationSettings()
  }
  const submission = !assistantPort && !submittedMessageRecorded(current) ? current.submission : undefined
  const submittedText = submission?.draftText.trim() || (submission?.images?.length ? '' : '图片消息')
  const empty = !transcriptEvents.length && !submission && !displayedActivity && Boolean(assistantPort || !current.loadError && !current.loading)
  return <section className="acp-content" data-empty={empty && !readOnly || undefined}>
    <div ref={stream} className="acp-transcript my-scrollbar" role="region" aria-label="会话消息" tabIndex={0} onWheelCapture={event => {
      if (event.deltaY < 0) { following.current = false; setAtBottom(false); if (!assistantPort) patchEntry(entryKey, { following: false }) }
    }} onKeyDownCapture={event => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) { following.current = false; setAtBottom(false); if (!assistantPort) patchEntry(entryKey, { following: false }) }
    }} onScroll={(event) => {
      const element = event.currentTarget, next = element.scrollHeight - element.scrollTop - element.clientHeight <= 2
      if (!assistantPort && current.earlierLoading && pendingAnchor.current?.key === entryKey) pendingAnchor.current.snapshot = captureTranscriptAnchor(element)
      following.current = next; setAtBottom(next); if (!assistantPort) patchEntry(entryKey, { scrollTop: element.scrollTop, following: next })
      readingAnchor.current = next ? null : captureTranscriptAnchor(element)
    }}><div className="acp-transcript-content my-conversation-column acp-chat-copy">
      {!assistantPort && current.page && (current.page.hasEarlier || current.page.startsMidTurn || current.page.coverage.state !== 'complete') && <HistoryBoundary key={`history:${current.conversation?.workspace.root}:${current.conversation?.nativeRef?.sessionId}`} hasEarlier={current.page.hasEarlier} startsMidTurn={current.page.startsMidTurn} coverage={current.page.coverage.state} loading={Boolean(current.earlierLoading)} onLoadEarlier={older} />}
      {current.loading && !current.loaded && <p className="my-activity-note" role="status"><Loader2 size={14} className="animate-spin" />正在读取对话…</p>}
      {!assistantPort && transcriptHeader}
      {session && <ConversationTranscript renderTurnArtifacts={!assistantPort ? renderTurnArtifacts : undefined} privateConversation session={session} events={transcriptEvents} items={items} currentActivity={null} suppressWorkingIndicator={Boolean(displayedActivity) || Boolean(current.nativeError)} pendingPerm={permissions} permissionPending={current.permissionPending} permissionErrors={current.permissionErrors} onRespond={(requestId, optionId) => { if (currentSource()) void respondPermission(entryKey, requestId, optionId) }} onOpenArtifact={openRecordedArtifact} onOpenTask={onFiles} onOpenSpec={onFiles} onOpenJira={onFiles} onOpenWebPreview={onOpenWebPreview} suppressedTaskTurns={suppressedTaskTurns} />}
      {session && Object.values(permissions).filter((permission) => !items.some((item) => item.type === 'perm' && item.ev.payload?.requestId === permission.requestId)).map((permission) => <EventRow key={`current-permission:${permission.requestId}`} item={{ type: 'perm', key: `current-permission:${permission.requestId}`, ev: { id: `current-permission:${permission.requestId}`, ts: 0, source: session.engine ?? 'acp', kind: 'permission', sessionId: session.sessionId, projectRoot: session.projectRoot, text: permission.toolCall?.title ?? '等待你的授权', payload: { requestId: permission.requestId } } }} session={session} events={current.events} pendingPerm={permissions} permissionPending={current.permissionPending} permissionErrors={current.permissionErrors} onRespond={(requestId, optionId) => { if (currentSource()) void respondPermission(entryKey, requestId, optionId) }} onOpenArtifact={openRecordedArtifact} onOpenTask={onFiles} onOpenSpec={onFiles} onOpenJira={onFiles} />)}
      {empty && !readOnly && (assistantPort ? assistantPort.emptyState : <div className="acp-conversation-start"><h1>今天想完成什么？</h1><p>整理资料、梳理需求，或直接开始对话。</p></div>)}
      {!assistantPort && transcriptFooter}
      {submission && <div key={submission.id} data-acp-item={`pending:${submission.id}`} className="acp-turn-start flex justify-end">
        <div className="acp-user-message max-w-[88%]">
          {submission.images && <ImageAttachments images={submission.images} />}
          {submittedText && <div className="acp-user-bubble acp-chat-copy whitespace-pre-wrap break-words">{submittedText}</div>}
          <div className="my-activity-note">
            <span role="status">{({ pending: '正在发送…', accepted: '已接收', unknown: '发送状态未确认', failed: '发送失败' })[submission.state]}</span>
            {submission.state === 'failed' && <>
              {canRetryFailedSubmission(submission) && <Button size="sm" variant="ghost" disabled={readOnly || running || Boolean(current.action)} onClick={() => { if (currentSource()) void sendMessage(entryKey, submission.id) }}>重新发送</Button>}
              <Button size="sm" variant="ghost" aria-label="移除未发送的消息" disabled={readOnly || Boolean(current.action)} onClick={() => { if (currentSource()) dismissFailedSubmission(entryKey, submission.id) }}>移除</Button>
            </>}
            {submission.state === 'unknown' && <Button size="sm" variant="ghost" onClick={() => { if (currentSource()) void reconcileSubmittedMessage(entryKey) }}>检查发送状态</Button>}
          </div>
        </div>
      </div>}
      <CurrentTurnStatus activity={submission && displayedActivity?.phase === 'submitting' ? null : displayedActivity} />
    </div></div>
    {!atBottom && <div className="acp-scroll-to-bottom-container"><Button size="sm" variant="outline" className="acp-scroll-to-bottom-btn" onClick={(event) => { const element = stream.current; pendingAnchor.current = null; following.current = true; if (element) { if (document.activeElement === event.currentTarget) element.focus({ preventScroll: true }); element.scrollTop = element.scrollHeight }; if (!assistantPort) patchEntry(entryKey, { following: true }); setAtBottom(true) }}><ArrowDown size={12} aria-hidden="true" />回到最新</Button></div>}
    <footer className="acp-composer-region my-conversation-column">
      {!readOnly && (
        <div className="acp-composer-contextbar" aria-label="会话资料与工作上下文">
          {assistantPort ? (assistantPort.context && <fieldset disabled={assistantPending || running || Boolean(current.action)} className="acp-composer-context-actions border-0" aria-label="需求助手上下文">{assistantPort.context}</fieldset>) : (
            <div className="acp-composer-context-actions">
              {current.kind === 'code' && <Button variant="ghost" size="sm" className="acp-context-action acp-directory-context" disabled={!nativeAvailable || Boolean(current.action) || directoryPending} title={directory} aria-label={current.conversation?.nativeRef || directoryFixed ? '选择其他工程并新建对话' : '选择 Code 工作目录'} onClick={() => void pickCodeDirectory()}><Folder size={14} aria-hidden="true" /><span>{directory ? projectNameFromPath(directory) : '选择工程'}</span><ChevronDown size={12} aria-hidden="true" /></Button>}
              {current.kind === 'code' && <ConversationGitContext entryKey={entryKey} />}
              {composerContext}
            </div>
          )}
          <ConversationFeedback key={JSON.stringify([assistantOwner, current.session?.connectionGeneration])} issues={feedbackIssues}
            connectionAction={turnReportedConnectionFailure && ['error', 'disconnected', 'closed'].includes(session?.status ?? '') ? connectionAction : undefined}
            modelConfirmed={session?.recovery?.modelConfirmed} onAction={recoverFeedback} />
        </div>
      )}
      {!assistantPort && !readOnly && composerReferences}
      {readOnly ? <div className="acp-history-note"><p>{archived ? '此对话已归档。' : '此会话仅保留历史记录。'}</p>{archived && current.conversation && <Button size="sm" variant="ghost" disabled={managementBusy} onClick={() => { if (currentSource() && current.conversation) void updateConversation(current.conversation.id, { archived: false }) }}>{managementBusy ? <Loader2 size={14} className="animate-spin" /> : <ArchiveRestore size={14} />}恢复对话</Button>}<Button size="sm" variant="ghost" onClick={onNew}>新建对话</Button>{running && sendAction}</div> : <div className={`acp-composer${!assistantPort && composerImages.dragging ? ' acp-composer-dragging' : ''}`} {...(!assistantPort ? composerImages.dragHandlers : {})} onPaste={!assistantPort ? composerImages.onPaste : undefined}>
        {!assistantPort && <>{composerImages.fileInput}
        {composerImages.dragging && <div className="acp-image-drop-hint" aria-hidden="true"><ImagePlus size={22} /><span>松开以添加图片</span></div>}
        <ImageAttachments key={entryKey} images={composerImages.images} onRemove={composerImages.remove} />
        {composerImages.pending && <p className="acp-image-status" role="status"><Loader2 size={12} className="animate-spin" />正在添加图片…</p>}
        {composerImages.error && <p className="acp-image-status text-my-danger-text" role="alert">{composerImages.error}</p>}
        {composerImages.images.length > 0 && session && session.capabilities?.promptCapabilities?.image !== true && <p className="acp-image-status text-my-warning-text" role="status">当前执行引擎未声明支持图片输入，图片草稿已保留</p>}
        {selectedInputFiles(current).length > 0 && <div className="acp-source-references" aria-label="下条消息引用文件">{selectedInputFiles(current).map(file => <div key={file.id} className="acp-source-chip"><button type="button" className="acp-source-name" onClick={onFiles} title={file.name}><Paperclip size={12} /><span>{file.name}</span></button><button type="button" className="my-icon-control" aria-label={`取消引用 ${file.name}`} title="取消下条消息的引用，原文件保留在会话文件中" onClick={() => referenceInputFile(entryKey, file.id, false)}><X size={12} /></button></div>)}</div>}
        </>}
        <textarea ref={composer} value={assistantPort?.text ?? current.text} aria-label={assistantPort ? '需求助手指令' : current.kind === 'code' ? 'Code 会话指令' : '会话指令'} title="Enter 发送 · Shift Enter 换行" placeholder="说说你的想法…" maxLength={200_000} disabled={!current.loaded} rows={2} onChange={(event) => assistantPort ? assistantPort.onTextChange(event.target.value) : editDraft(entryKey, event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); if (!missingRuntime && !missingModel && !current.modelConfirmationRequired && !missingDirectory && !current.action && !running) send() } }} />
        <div className="acp-composer-toolbar">
          {session ? <ComposerModelPicker
            key={JSON.stringify([entryKey, session.sessionId, session.connectionGeneration])} session={session} message={error} requireModelConfirmation={current.modelConfirmationRequired}
            operationPending={!owner || assistantPending || Boolean(assistantPort && running) || Boolean(current.action) || !current.loaded || typeof conversationClient()?.configure !== 'function'}
            acquireConfiguration={() => owner && ownsPicker() ? acquireConversationConfiguration(entryKey, owner) : undefined}
            isCurrent={ownsPicker} configureSession={configureSession}
            onUpdated={(updated) => { if (owner && ownsPicker()) acceptConversationSession(entryKey, updated, owner) }}
            onRecoverModel={conversationClient()?.recoverModel ? recoverModel : undefined} onReconnect={reconnect} contextActions={contextActions}
            triggerRef={modelTrigger} onOpenModelSettings={openModelSettings} onOpenRuntimeSettings={openConversationSettings}
            usage={<ComposerUsageIndicator session={session} events={current.events} />} sendAction={sendAction}
          /> : <div className="acp-composer-controls private-draft-controls">
            <div className="acp-composer-controls-left">
              <Dropdown placement="top" width={290} trigger={({ open, toggle }) => <button type="button" className="acp-composer-add my-composer-control" aria-label="添加与会话选项" aria-expanded={open} onClick={toggle}><Plus size={19} /></button>}>
                {(close) => <div className="acp-add-menu my-scrollbar"><DropdownHeader>添加</DropdownHeader>{contextActions(close)}</div>}
              </Dropdown>
            </div>
            <div ref={draftControlsRight} className="acp-composer-controls-right">
              <UnifiedModelPicker current={current} disabled={assistantPending} triggerRef={modelTrigger} positionAnchorRef={draftControlsRight} onOpenModelSettings={openModelSettings} onOpenRuntimeSettings={openConversationSettings} />
              {sendAction}
            </div>
          </div>}
        </div>
      </div>}
            {current.modelConfirmationRequired && <div className="acp-history-note mt-2" role="status">模型变更结果尚未确认，请重新选择当前模型或其他模型后发送。</div>}
      {empty && !readOnly && !assistantPort && quickActions}
    </footer>
  </section>
}
