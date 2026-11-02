import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { ArchiveRestore, ArrowDown, ChevronDown, CircleStop, FileText, Folder, ImagePlus, Loader2, Paperclip, Plus, Send, Settings2 } from 'lucide-react'
import type { AcpConfigureInput } from '@shared/types'
import type { PiWebPreviewArtifact } from '@shared/pi-web-preview'
import { ConversationTranscript, type TranscriptActiveSegment } from '../acp/ConversationTranscript'
import { ComposerModelPicker } from '../acp/ComposerModelPicker'
import { ComposerUsageIndicator } from '../acp/ComposerUsageIndicator'
import { HistoryBoundary } from '../acp/ConversationHistoryBoundary'
import { useComposerAutoSize } from '../acp/useComposerAutoSize'
import { useComposerImages } from '../acp/useComposerImages'
import { ImageAttachments } from '../acp/ImageAttachments'
import { ConnectionNotice } from '../acp/ConnectionNotice'
import { EventRow } from '../acp/TranscriptRow'
import { captureTranscriptAnchor, restoreTranscriptAnchor, type TranscriptScrollAnchor } from '../acp/transcript-scroll'
import { useDocumentSource } from '../reader/document-source'
import { compileItems } from '../acp/timeline'
import { CurrentTurnStatus } from '../acp/CurrentTurnStatus'
import { projectCurrentTurnActivity, type CurrentTurnActivity } from '../acp/current-turn-activity'
import { Button, Dropdown, DropdownHeader, DropdownItem } from '../my/ui'
import { useMy } from '../my/store'
import { useApp } from '../store'
import { projectNameFromPath, projectRootKey } from '../my/navigation'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { conversationClient, conversationError, conversationValue } from './client'
import { isPrivateEntrySelected } from './source'
import { ConversationGitContext } from './GitContext'
import { acceptConversationSession, acquireConversationConfiguration, actionablePermissions, addFiles, chooseDirectory, controlConversation, conversationNativeOwner, earlierMessages, editDraft, ownsConversationNative, patchEntry, readConversation, requestComposerFocus, respondPermission, saveDraft, sendMessage, sessionRunning, setDraftImages, setDraftRuntime, updateConversation, useConversations, type WorkspaceEntry } from './workspace'

export function openConversationSettings(): void {
  useMy.getState().setSettingsView('engines'); useApp.getState().setPage('settings')
}

function RuntimePicker({ current }: { current: WorkspaceEntry }): JSX.Element {
  const runtimes = useConversations((state) => state.runtimes), modelLabel = useConversations((state) => state.modelLabel)
  const configuredPi = useConversations((state) => state.configuredPi)
  const selected = runtimes.find((runtime) => runtime.id === current.runtimeId)?.name
  return <Dropdown placement="top" align="right" width={256} gap={8} disabled={Boolean(current.action) || Boolean(current.conversation?.nativeRef)} trigger={({ toggle, open }) => <button type="button" className="acp-composer-context acp-model-trigger my-composer-control my-composer-control-label" aria-expanded={open} aria-label="选择执行引擎" onClick={toggle}><span>{current.runtimeId === 'pi' && modelLabel || selected || '选择执行引擎'}</span><ChevronDown size={12} /></button>}>
    {(close) => <><DropdownHeader>执行引擎</DropdownHeader>{runtimes.filter((runtime) => runtime.enabled).map((runtime) => <DropdownItem key={runtime.id} selected={runtime.id === current.runtimeId} disabled={!runtime.available} onClick={() => { setDraftRuntime(current.key, runtime.id); close() }}><span>{runtime.name}</span>{!runtime.available ? <small className="text-my-xs text-my-tertiary">不可用</small> : runtime.id === 'pi' && !configuredPi ? <small className="text-my-xs text-my-tertiary">待配置模型</small> : null}</DropdownItem>)}{!runtimes.length && <p className="px-3 py-2 text-my-sm text-my-tertiary">尚未读取到执行引擎</p>}<DropdownItem icon={<Settings2 size={14} />} onClick={() => { close(); openConversationSettings() }}>管理执行引擎与模型</DropdownItem></>}
  </Dropdown>
}

export function PrivateConversation({ entryKey, onFiles, onNew, onNewDirectory, directoryPending, directoryFixed = false, composerContext, quickActions, onOpenWebPreview }: {
  entryKey: string; onFiles(): void; onNew(): void; onNewDirectory(): void
  directoryPending: boolean; directoryFixed?: boolean; composerContext: ReactNode; quickActions?: ReactNode
  onOpenWebPreview?: (artifact: PiWebPreviewArtifact, eventId: string) => void
}): JSX.Element | null {
  const current = useConversations((state) => state.entries[entryKey]), initialized = useConversations((state) => state.initialized)
  const managementBusy = useConversations((state) => state.managementBusy[state.entries[entryKey]?.conversation?.id ?? ''])
  const managementError = useConversations((state) => state.managementErrors[state.entries[entryKey]?.conversation?.id ?? ''])
  const runtimes = useConversations((state) => state.runtimes), configuredPi = useConversations((state) => state.configuredPi), runtimeError = useConversations((state) => state.runtimeError)
  const interactive = useInteractionActive(), canInteract = useInteractionGuard(), source = useDocumentSource()
  const [now, setNow] = useState(Date.now), [segment, setSegment] = useState<TranscriptActiveSegment | null>(null), [atBottom, setAtBottom] = useState(true)
  const stream = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null), composing = useRef(false)
  const currentRef = useRef(current); currentRef.current = current
  const focusIntent = useRef<{ key: string; request: string } | null>(null)
  const following = useRef(true), previousKey = useRef(''), pendingAnchor = useRef<{ key: string; snapshot: TranscriptScrollAnchor } | null>(null)
  const font = useMy((state) => state.fontSize)
  const permissions = useMemo(() => current ? actionablePermissions(current, now) : {}, [current?.session, current?.conversation, now])
  const items = useMemo(() => compileItems(current?.events ?? []), [current?.events])
  const owner = conversationNativeOwner(entryKey)
  const currentSource = (): boolean => canInteract() && !currentRef.current?.locked && currentRef.current?.key === entryKey && (!source || source.isCurrent())
  const currentEntry = (): boolean => canInteract() && isPrivateEntrySelected(entryKey)
  const composerImages = useComposerImages({
    root: current?.conversation?.workspace.root ?? '', sessionId: current?.locked ? undefined : entryKey,
    generation: current?.session?.connectionGeneration, isCurrent: currentSource,
    draftSource: {
      identity: JSON.stringify([entryKey, current?.owner]),
      read: (key) => { const value = useConversations.getState().entries[key]; return value && !value.locked && key === entryKey ? value.images ?? [] : [] },
      write: (key, images) => { if (currentSource() && key === entryKey) setDraftImages(key, images, useConversations.getState().entries[key]?.owner) }
    }
  })
  useComposerAutoSize({ textareaRef: composer, value: current?.text ?? '', active: interactive && Boolean(current && !current.locked), ownerKey: entryKey, status: current?.session?.status, fontSize: font })
  useEffect(() => {
    if (!interactive) return
    const visible = (): void => { if (!document.hidden) { setNow(Date.now()); if (currentRef.current?.conversation) void readConversation(currentRef.current.key) } }
    document.addEventListener('visibilitychange', visible)
    const timer = window.setInterval(() => { if (!document.hidden && currentRef.current?.session?.pendingPermissions?.length) setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [interactive])
  useEffect(() => { if (interactive && currentRef.current?.conversation) void readConversation(entryKey) }, [entryKey, interactive])
  useLayoutEffect(() => {
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
  }, [entryKey, current?.composerFocus, current?.loaded, current?.action, current?.locked, interactive])
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
    if (previousKey.current !== entryKey) {
      previousKey.current = entryKey; following.current = value.following ?? true
      element.scrollTop = value.scrollTop ?? element.scrollHeight; setAtBottom(following.current); setSegment(null)
    } else if (pendingAnchor.current?.key === entryKey && !value.earlierLoading) {
      restoreTranscriptAnchor(element, pendingAnchor.current.snapshot); pendingAnchor.current = null
    } else if (following.current || value.submission && value.following) element.scrollTop = element.scrollHeight
  }, [entryKey, current?.events, current?.submission, current?.earlierLoading, current?.session?.status])
  const activity = useMemo(() => projectCurrentTurnActivity({ root: current?.conversation?.workspace.root ?? '', session: current?.session ?? null, events: current?.events ?? [], request: current?.request, interactive }), [current?.conversation?.workspace.root, current?.session, current?.events, current?.request, interactive])
  const displayedActivity = useMemo<CurrentTurnActivity | null>(() => activity ?? (current?.action === 'sending' && interactive ? { phase: 'submitting', label: '正在发送…', spinning: true } : null), [activity, current?.action, interactive])
  if (!current) return null
  if (current.locked) return <div role="status" className="acp-empty">原会话的本机身份尚未核对，请在历史中重新打开。</div>
  const session = current.session, running = sessionRunning(current)
  const ownsPicker = (): boolean => Boolean(owner && currentSource() && ownsConversationNative(entryKey, owner))
  const configureSession = async (configuration: AcpConfigureInput) => {
    const client = conversationClient()
    if (!owner || !client?.configure || !ownsPicker()) return { ok: false, error: '原会话的配置服务当前不可用。' }
    const result = conversationValue(await client.configure(owner.conversationId, { expectedConnectionGeneration: owner.generation, configuration }))
    return { ok: true, session: result }
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
  const missingModel = !current.conversation?.nativeRef && current.runtimeId === 'pi' && !configuredPi
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
  const send = (): void => { if (!currentSource() || composerImages.pending || readOnly) return; following.current = true; setAtBottom(true); void sendMessage(entryKey) }
  const openRecordedArtifact = (file: { path: string }): void => {
    if (!source || !currentSource()) return
    void source.openDocument(file.path).catch((cause) => { if (currentSource()) patchEntry(entryKey, { error: conversationError(cause) }) })
  }
  const older = (): void => { const element = stream.current; if (!element || !currentSource()) return; following.current = false; pendingAnchor.current = { key: entryKey, snapshot: captureTranscriptAnchor(element) }; void earlierMessages(entryKey) }
  const contextActions = (close: () => void): JSX.Element => <>
    <button type="button" className="acp-add-action my-menu-item" disabled={readOnly} onClick={() => { close(); composerImages.choose() }}><ImagePlus size={14} /><span>添加图片</span></button>
    <button type="button" className="acp-add-action my-menu-item" disabled={!nativeAvailable || Boolean(current.action) || missingDirectory || !current.loaded || readOnly} onClick={() => { close(); if (currentSource()) void addFiles(entryKey) }}><Paperclip size={14} /><span>添加本机文件</span></button>
    <button type="button" className="acp-add-action my-menu-item" onClick={() => { close(); onFiles() }}><FileText size={14} /><span>会话文件</span></button>
    {current.kind === 'code' && <button type="button" className="acp-add-action my-menu-item" disabled={!nativeAvailable || Boolean(current.action) || directoryPending || readOnly} title={directory} onClick={() => { close(); void pickCodeDirectory() }}><Folder size={14} /><span>{current.conversation?.nativeRef || directoryFixed ? '为其他工程新建对话' : directory ? '更换工作目录' : '选择工作目录'}</span></button>}
  </>
  const sendAction = running ? <Button variant="outline" size="sm" title="停止当前回合" disabled={!nativeAvailable || Boolean(current.action) || session?.status === 'cancelling'} onClick={() => { if (currentSource()) void controlConversation(entryKey, 'cancel') }}><CircleStop size={14} /><span className="acp-stop-label">{current.action === 'cancel' || session?.status === 'cancelling' ? '正在停止…' : '停止本轮'}</span></Button> : <Button variant="primary" size="sm" title="发送指令" aria-label="发送指令" disabled={!nativeAvailable || !initialized || missingRuntime || missingModel || missingDirectory || !current.loaded || Boolean(current.action) || (!current.text.trim() && !composerImages.images.length) || composerImages.pending || readOnly} onClick={send}>{current.action === 'sending' ? <Loader2 size={14} className="acp-progress-spinner" /> : <Send size={14} />}</Button>
  const error = current.error || current.nativeError || (session?.status === 'error' ? session.error : undefined) || (archived ? managementError : undefined)
  const empty = !current.events.length && !displayedActivity && !current.loadError && !current.loading
  return <section className="acp-content" data-empty={empty && !readOnly || undefined}>
    <div ref={stream} className="acp-transcript my-scrollbar" role="region" aria-label="会话消息" tabIndex={0} onScroll={(event) => {
      const element = event.currentTarget, next = element.scrollHeight - element.scrollTop - element.clientHeight < 48
      if (current.earlierLoading && pendingAnchor.current?.key === entryKey) pendingAnchor.current.snapshot = captureTranscriptAnchor(element)
      following.current = next; setAtBottom(next); patchEntry(entryKey, { scrollTop: element.scrollTop, following: next })
    }}><div className="acp-transcript-content my-conversation-column acp-chat-copy">
      {current.page && (current.page.hasEarlier || current.page.startsMidTurn || current.page.coverage.state !== 'complete') && <HistoryBoundary key={`history:${current.conversation?.workspace.root}:${current.conversation?.nativeRef?.sessionId}`} hasEarlier={current.page.hasEarlier} startsMidTurn={current.page.startsMidTurn} coverage={current.page.coverage.state} loading={Boolean(current.earlierLoading)} onLoadEarlier={older} />}
      {current.loading && !current.loaded && <p className="my-activity-note" role="status"><Loader2 size={14} className="animate-spin" />正在读取对话…</p>}
      {current.loadError && <div className="acp-history-note"><ConnectionNotice message={current.loadError} /><Button size="sm" variant="ghost" disabled={current.loading} onClick={() => void readConversation(entryKey)}>重试加载历史</Button></div>}
      {session && <ConversationTranscript privateConversation session={session} events={current.events} items={items} currentActivity={displayedActivity} onActiveSegmentChange={setSegment} suppressWorkingIndicator={Boolean(displayedActivity)} pendingPerm={permissions} permissionPending={current.permissionPending} permissionErrors={current.permissionErrors} onRespond={(requestId, optionId) => { if (currentSource()) void respondPermission(entryKey, requestId, optionId) }} onOpenArtifact={openRecordedArtifact} onOpenTask={onFiles} onOpenSpec={onFiles} onOpenJira={onFiles} onOpenWebPreview={onOpenWebPreview} />}
      {session && Object.values(permissions).filter((permission) => !items.some((item) => item.type === 'perm' && item.ev.payload?.requestId === permission.requestId)).map((permission) => <EventRow key={`current-permission:${permission.requestId}`} item={{ type: 'perm', key: `current-permission:${permission.requestId}`, ev: { id: `current-permission:${permission.requestId}`, ts: 0, source: session.engine ?? 'acp', kind: 'permission', sessionId: session.sessionId, projectRoot: session.projectRoot, text: permission.toolCall?.title ?? '等待你的授权', payload: { requestId: permission.requestId } } }} session={session} events={current.events} pendingPerm={permissions} permissionPending={current.permissionPending} permissionErrors={current.permissionErrors} onRespond={(requestId, optionId) => { if (currentSource()) void respondPermission(entryKey, requestId, optionId) }} onOpenArtifact={openRecordedArtifact} onOpenTask={onFiles} onOpenSpec={onFiles} onOpenJira={onFiles} />)}
      {empty && !readOnly && <div className="acp-conversation-start"><h1>{current.kind === 'code' ? '从一个想法开始。' : '今天想完成什么？'}</h1><p>{current.kind === 'code' ? '描述要构建、修改或排查的问题。' : '整理资料、梳理需求，或直接开始对话。'}</p></div>}
      <CurrentTurnStatus activity={ownSegment ? null : displayedActivity} />
    </div></div>
    {!atBottom && <div className="acp-scroll-to-bottom-container"><Button size="sm" variant="outline" className="acp-scroll-to-bottom-btn" onClick={(event) => { const element = stream.current; pendingAnchor.current = null; following.current = true; if (element) { if (document.activeElement === event.currentTarget) element.focus({ preventScroll: true }); element.scrollTop = element.scrollHeight }; patchEntry(entryKey, { following: true }); setAtBottom(true) }}><ArrowDown size={12} aria-hidden="true" />回到最新</Button></div>}
    <footer className="acp-composer-region my-conversation-column">
      {!readOnly && <div className="acp-composer-contextbar" aria-label="会话资料与工作上下文">
        {current.kind === 'code' && <Button variant="ghost" size="sm" className="acp-context-action acp-directory-context" disabled={!nativeAvailable || Boolean(current.action) || directoryPending} title={directory} aria-label={current.conversation?.nativeRef || directoryFixed ? '选择其他工程并新建对话' : '选择 Code 工作目录'} onClick={() => void pickCodeDirectory()}><Folder size={14} aria-hidden="true" /><span>{directory ? projectNameFromPath(directory) : '选择工程'}</span><ChevronDown size={12} aria-hidden="true" /></Button>}
        {current.kind === 'code' && <ConversationGitContext entryKey={entryKey} />}
        {composerContext}
      </div>}
      {error && <ConnectionNotice message={error} />}
      {session?.cleanupRequired && <div className="acp-history-note"><Button size="sm" variant="outline" disabled={Boolean(current.action)} onClick={() => void controlConversation(entryKey, 'end')}>重试结束会话</Button><Button size="sm" variant="ghost" onClick={openConversationSettings}>检查执行引擎</Button></div>}
      {current.saveError && <div className="acp-history-note"><ConnectionNotice message={`草稿尚未保存：${current.saveError}`} /><Button variant="ghost" size="sm" onClick={() => void saveDraft(entryKey).catch(() => undefined)}>重试保存</Button></div>}
      {current.fileError && <div className="acp-history-note"><ConnectionNotice message={current.fileError} /><Button size="sm" variant="ghost" onClick={onFiles}>查看文件</Button></div>}
      {readOnly ? <div className="acp-history-note"><p>{archived ? '此对话已归档。' : '此会话仅保留历史记录。'}</p>{archived && current.conversation && <Button size="sm" variant="ghost" disabled={managementBusy} onClick={() => { if (currentSource() && current.conversation) void updateConversation(current.conversation.id, { archived: false }) }}>{managementBusy ? <Loader2 size={14} className="animate-spin" /> : <ArchiveRestore size={14} />}恢复对话</Button>}<Button size="sm" variant="ghost" onClick={onNew}>新建对话</Button>{running && sendAction}</div> : <div className={`acp-composer${composerImages.dragging ? ' acp-composer-dragging' : ''}`} {...composerImages.dragHandlers} onPaste={composerImages.onPaste}>
        {composerImages.fileInput}
        {composerImages.dragging && <div className="acp-image-drop-hint" aria-hidden="true"><ImagePlus size={22} /><span>松开以添加图片</span></div>}
        <ImageAttachments key={entryKey} images={composerImages.images} onRemove={composerImages.remove} />
        {composerImages.pending && <p className="acp-image-status" role="status"><Loader2 size={12} className="animate-spin" />正在添加图片…</p>}
        {composerImages.error && <p className="acp-image-status text-my-danger-text" role="alert">{composerImages.error}</p>}
        {composerImages.images.length > 0 && session && session.capabilities?.promptCapabilities?.image !== true && <p className="acp-image-status text-my-warning-text" role="status">当前执行引擎未声明支持图片输入，图片草稿已保留</p>}
        {current.files.some((file) => file.kind === 'input') && <div className="acp-source-references">{current.files.filter((file) => file.kind === 'input').map((file) => <button type="button" key={file.id} className="acp-source-chip" onClick={onFiles} title={file.relativePath}><Paperclip size={12} /><span>{file.name}</span></button>)}</div>}
        <textarea ref={composer} value={current.text} aria-label={current.kind === 'code' ? 'Code 会话指令' : '会话指令'} title="Enter 发送 · Shift Enter 换行" placeholder="说说你的想法…" maxLength={200_000} disabled={!current.loaded} rows={2} onChange={(event) => editDraft(entryKey, event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); if (!missingRuntime && !missingModel && !missingDirectory && !current.action && !running) send() } }} />
        <div className="acp-composer-toolbar">
          {session && owner ? <ComposerModelPicker
            key={`${owner.sessionId}:${owner.generation}`} session={session} message={error}
            operationPending={Boolean(current.action) || !current.loaded || typeof conversationClient()?.configure !== 'function'}
            acquireConfiguration={() => ownsPicker() ? acquireConversationConfiguration(entryKey, owner) : undefined}
            isCurrent={ownsPicker} configureSession={configureSession}
            onUpdated={(updated) => { if (ownsPicker()) acceptConversationSession(entryKey, updated, owner) }}
            onRecoverModel={recoverModel} contextActions={contextActions}
            usage={<ComposerUsageIndicator session={session} events={current.events} />} sendAction={sendAction}
          /> : <div className="acp-composer-controls">
            <div className="acp-composer-controls-left">
              <Dropdown placement="top" width={290} trigger={({ open, toggle }) => <button type="button" className="acp-composer-add my-composer-control" aria-label="添加与会话选项" aria-expanded={open} onClick={toggle}><Plus size={19} /></button>}>
                {(close) => <div className="acp-add-menu my-scrollbar"><DropdownHeader>添加</DropdownHeader>{contextActions(close)}</div>}
              </Dropdown>
            </div>
            <div className="acp-composer-controls-right"><RuntimePicker current={current} />{sendAction}</div>
          </div>}
        </div>
      </div>}
      {(!nativeAvailable || initialized && (missingRuntime || missingModel) || runtimeError) && <div className="acp-history-note mt-2">{!nativeAvailable ? '本机会话接口当前不可用，输入仍可编辑。' : runtimeError || (missingModel ? '配置模型后即可发送。' : '选择可用执行引擎后即可发送。')}{nativeAvailable && <Button size="sm" variant="ghost" onClick={openConversationSettings}>打开设置</Button>}</div>}
      {empty && !readOnly && quickActions}
    </footer>
  </section>
}
