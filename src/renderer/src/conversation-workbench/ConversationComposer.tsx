import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react'
import { ArrowUp, Archive, ArchiveRestore, File as FileIcon, Image, ListEnd, LoaderCircle, Mic, MicOff, Quote, Square, X } from 'lucide-react'
import { Button, Dropdown, DropdownItem } from '../my/ui'
import { FeedbackNotice, normalizeFeedbackDiagnostic } from '../my/FeedbackNotice'
import type { ConversationDriverSkill } from '../../../shared/conversation/driverCatalog'
import type { OpenAssistantCitation } from './AssistantCitationChip'
import { ComposerAddMenu, type ComposerTaskSection } from './ComposerAddMenu'
import { ComposerPromptEditorTiptap, type ComposerPromptEditorHandle, type ComposerPromptSnapshot } from './ComposerPromptEditorTiptap'
import { ComposerSurface } from './ComposerSurface'
import { composerSuggestionOptionId, ConversationComposerMenu } from './ConversationComposerMenu'
import { ConversationModelPicker } from './ConversationModelPicker'
import { shouldAttachPastedText } from './useComposerAttachments'
import { CONVERSATION_TEXT_LIMIT } from './useComposerDraft'
import { unavailableModelReason, type ConversationModelCatalog } from './useConversationModelCatalog'
import { detectComposerTrigger, useComposerMenuItems, type ComposerMentionableThread, type ComposerMenuItem } from './useComposerMenuItems'
import { conversationError, type ComposerModel, type useComposerSend } from './useComposerSend'
import { useComposerSpeech } from './speech/useComposerSpeech'
import { useComposerProjectPaths, type ComposerProjectPathTarget } from './useComposerProjectPaths'
import { formatComposerFileLink } from './chatProjectFileLinks'

export type { ComposerMentionableThread } from './useComposerMenuItems'

const noThreads: readonly ComposerMentionableThread[] = []
const noSkills: readonly ConversationDriverSkill[] = []

export interface ConversationComposerProps {
  readonly interactive: boolean
  /** Project root scoping the model picker's favorites and recents. */
  readonly root: string
  readonly send: ReturnType<typeof useComposerSend>
  readonly catalog: ConversationModelCatalog
  readonly model: ComposerModel | null
  readonly onModelChange: (model: ComposerModel | null) => void
  readonly lockedInstanceId?: string
  readonly running: boolean
  readonly canStop: boolean
  readonly onStop: () => void
  readonly queuePaused: boolean
  readonly canSteer: boolean
  readonly disabledReason?: string | null
  readonly editorRef?: RefObject<ComposerPromptEditorHandle | null>
  readonly leadingControls?: ReactNode
  readonly taskSection?: ComposerTaskSection
  readonly draftReferences?: ReactNode
  readonly onPaste?: React.ClipboardEventHandler<HTMLDivElement>
  readonly onDrop?: React.DragEventHandler<HTMLFormElement>
  readonly onDragOver?: React.DragEventHandler<HTMLFormElement>
  readonly previousPrompt?: string
  readonly mentionableThreads?: readonly ComposerMentionableThread[]
  readonly onOpenCitation?: OpenAssistantCitation
  readonly projectPaths?: ComposerProjectPathTarget
}

function resolveComposerDispatchMode(running: boolean, canSteer: boolean, alternateModifier: boolean): 'auto' | 'steer' {
  if (!running || !canSteer) return 'auto'
  return alternateModifier ? 'steer' : 'auto'
}

export function ConversationComposer({
  interactive, root, send, catalog, model, onModelChange, lockedInstanceId, running, canStop, onStop, queuePaused,
  canSteer, disabledReason, editorRef, leadingControls, draftReferences, onPaste, onDrop, onDragOver, previousPrompt,
  taskSection, mentionableThreads = noThreads, onOpenCitation, projectPaths,
}: ConversationComposerProps): JSX.Element {
  const toolbar = useRef<HTMLDivElement>(null)
  const localEditor = useRef<ComposerPromptEditorHandle>(null)
  const promptRef = editorRef ?? localEditor
  const menuAnchorRef = useRef<HTMLDivElement>(null)
  const modelTrigger = useRef<HTMLButtonElement>(null)
  const restoredSelection = useRef<{ key: string; start: number; end: number }>()
  const speechDraftRead = useRef<{ key: string; text: string }>()
  const pasteInline = useRef(false)
  const diagnosticId = useId()
  const menuId = useId()
  const [caret, setCaret] = useState<{ key: string; position: number }>()
  const [dismissedTrigger, dismissTrigger] = useState('')
  const [highlight, setHighlight] = useState<{ triggerKey: string; itemId: string }>()
  const [referenceRequest, setReferenceRequest] = useState<{ key: string }>()
  const [referenceError, setReferenceError] = useState<{ key: string; message: string }>()
  const latestDraftKey = useRef(send.draftKey)
  latestDraftKey.current = send.draftKey
  const state = send.state
  const [copyFailure, setCopyFailure] = useState<string>()
  const speech = useComposerSpeech({
    ownerKey: send.draftKey,
    disabled: !interactive,
    readDraft: () => {
      const input = promptRef.current
      if (!input) return null
      const text = send.readDraft()
      speechDraftRead.current = { key: send.draftKey, text }
      const { start, end } = input.readSnapshot().selection
      return { text, selection: { start: Math.min(start, text.length), end: Math.min(end, text.length) } }
    },
    commitDraft: (text, selection) => {
      const expected = speechDraftRead.current
      if (expected?.key !== send.draftKey) return
      send.setDraft(current => {
        if (current !== expected.text) return current
        restoredSelection.current = { key: send.draftKey, ...selection }
        return text
      })
    },
  })
  useLayoutEffect(() => {
    const selection = restoredSelection.current
    if (!selection) return
    restoredSelection.current = undefined
    if (selection.key === send.draftKey) promptRef.current?.setSelectionRange(selection.start, selection.end)
  }, [promptRef, send.draft, send.draftKey])
  const speechPhase = speech.state.phase
  const speechBusy = speechPhase === 'preparing' || speechPhase === 'transcribing' || speechPhase === 'installing'
  const recording = speechPhase === 'recording'
  const intake = send.attachmentIntake
  const attachmentPending = intake.state.pending
  const staleAttachment = send.attachments.some(item => item.expiresAt <= Date.now())
  const attachmentAvailable = interactive && intake.available && intake.canEdit
  const trigger = interactive && caret?.key === send.draftKey
    ? detectComposerTrigger(send.draft, caret.position) : null
  const triggerKey = trigger ? JSON.stringify([send.draftKey, trigger.kind, trigger.rangeStart, trigger.query]) : ''
  const findingReference = referenceRequest?.key === send.draftKey
  const activeTrigger = !findingReference && triggerKey !== dismissedTrigger ? trigger : null
  const selectedInstanceId = model?.instanceId
  const describeForSkill = catalog.scopeAllowsSkills && Boolean(activeTrigger &&
    (activeTrigger.kind === 'skill' || activeTrigger.kind === 'slash-command' && activeTrigger.query !== 'model'))
  const selectedInstance = catalog.instances.find(item => item.instanceId === selectedInstanceId)
  const { ensure, refresh, status: catalogStatus } = catalog
  useEffect(() => {
    if (!describeForSkill || !selectedInstanceId) return
    if (catalogStatus === 'idle') void refresh()
    else if (selectedInstance && !selectedInstance.read) void ensure(selectedInstanceId)
  }, [catalogStatus, describeForSkill, ensure, refresh, selectedInstance, selectedInstanceId])
  const skills = catalog.scopeAllowsSkills && selectedInstanceId
    ? catalog.suggestionSkills?.(selectedInstanceId) ?? noSkills : noSkills
  const files = useComposerProjectPaths(projectPaths, activeTrigger)
  const menuItems = useComposerMenuItems(activeTrigger, skills, mentionableThreads, attachmentAvailable && !attachmentPending,
    { available: interactive && send.sideChatAvailable }, files)
  const menuOpen = activeTrigger !== null
  const activeIndex = highlight?.triggerKey === triggerKey
    ? Math.max(0, menuItems.findIndex(item => item.id === highlight.itemId)) : 0
  const selectedMenuItem = menuItems[activeIndex]
  const isSearchingSkills = describeForSkill && Boolean(selectedInstance) && (!selectedInstance?.read || selectedInstance.read.status === 'loading')
  const canSteerDraft = canSteer && send.attachments.length === 0 && !model?.options?.length
  const missingModel = model && lockedInstanceId && model.instanceId !== lockedInstanceId
    ? '请选择此会话所用实例中的模型。'
    : model ? unavailableModelReason(catalog, model) : undefined
  const overLimit = send.outgoingLength > CONVERSATION_TEXT_LIMIT
  const allowSend = Boolean(interactive && !disabledReason && !missingModel && !overLimit && !attachmentPending && !findingReference && !staleAttachment &&
    model && send.hasSendableContent &&
    (state.phase === 'idle' || (state.phase === 'rejected' && state.restored)))
  const sendLabel = running || queuePaused ? '加入队列' : '发送'
  const submit = (alternate = false): void => {
    if (!allowSend || !model) return
    void send.send(model, { deliveryIntent: resolveComposerDispatchMode(running, canSteerDraft, alternate) })
  }
  const reason = disabledReason || (overLimit ? `消息最多 ${CONVERSATION_TEXT_LIMIT.toLocaleString('zh-CN')} 字符。` : missingModel)
    || (staleAttachment ? '有附件已过期，请移除后重新添加。' : undefined)
  const diagnostic = state.phase === 'unknown' || state.phase === 'rejected' ? state.reason : undefined
  const summary = diagnostic?.trim().split('\n')[0]?.slice(0, 240)
  const trackCaret = ({ selection }: ComposerPromptSnapshot): void => {
    setCaret(selection.start === selection.end ? { key: send.draftKey, position: selection.start } : undefined)
  }
  const pickMenuItem = async (item: ComposerMenuItem): Promise<void> => {
    if (!activeTrigger || send.readDraft() !== send.draft) return
    const source = send.draft
    const { rangeStart, rangeEnd } = activeTrigger
    const replacement = item.type === 'skill' ? `$${item.name} `
      : item.type === 'file' ? item.kind === 'directory' ? `@${item.path}/` : `${formatComposerFileLink(item.path)} `
      : item.type === 'side' ? `/${item.name} ` : ''
    const end = replacement.endsWith(' ') && source[rangeEnd] === ' ' ? rangeEnd + 1 : rangeEnd
    const next = source.slice(0, rangeStart) + replacement + source.slice(end)
    const position = rangeStart + replacement.length
    dismissTrigger(triggerKey)
    setReferenceError(undefined)
    if (item.type === 'thread') {
      if (!mentionableThreads.some(thread => thread.id === item.threadId)) return
      const key = send.draftKey
      const request = { key }
      setReferenceRequest(request)
      try {
        if (await send.quoteThread(item.threadId, source, next)) requestAnimationFrame(() => {
          const input = promptRef.current
          if (latestDraftKey.current === key && input && input.readSnapshot().value === next && document.activeElement === input.element) {
            input.setSelectionRange(position, position)
          }
        })
      } catch (error) {
        if (latestDraftKey.current === key) {
          setReferenceError({ key, message: normalizeFeedbackDiagnostic(conversationError(error)) })
        }
      } finally {
        setReferenceRequest(current => current === request ? undefined : current)
      }
      return
    }
    if (item.type === 'attachment' && !await intake.pick()) return
    send.setDraft(current => {
      if (current !== source) return current
      restoredSelection.current = { key: send.draftKey, start: position, end: position }
      return next
    })
    if (item.type === 'model') modelTrigger.current?.click()
  }
  return <ComposerSurface.Shell>
    {state.phase === 'unknown' && <FeedbackNotice variant="inline" tone="warning" title="发送结果待核对" description={summary}
      diagnostic={summary !== diagnostic ? diagnostic : undefined}
      actions={<Button size="sm" variant="ghost" disabled={!interactive || state.checking} onClick={() => void send.checkReceipt()}>
        {state.checking ? '正在查询…' : '查询回执'}
      </Button>} />}
    {state.phase === 'rejected' && <FeedbackNotice variant="inline" tone="error" title="消息未受理" description={summary}
      diagnostic={summary !== diagnostic ? diagnostic : undefined}
      actions={!state.restored && <>
        <Button size="sm" variant="ghost"
          disabled={!interactive || attachmentPending || Boolean(send.hasContent && send.stash)}
          onClick={() => { send.restore(send.hasContent); promptRef.current?.focus() }}>
          {send.hasContent ? '暂存当前草稿并取回原稿' : '取回原稿'}
        </Button>
        {send.hasContent && state.submission.sourceText && <Button size="sm" variant="ghost" disabled={!interactive} onClick={() => {
          setCopyFailure(undefined)
          void send.copyRejectedDraft().catch(() => setCopyFailure(state.submission.commandId))
        }}>复制原稿文字</Button>}
      </>} />}
    {state.phase === 'rejected' && state.submission.commandId === copyFailure &&
      <p className="my-activity-note" role="alert">无法复制原稿。暂存当前草稿后可以取回。</p>}
    {speech.state.error && <FeedbackNotice variant="inline" title="语音输入失败" description={speech.state.error}
      actions={speech.state.errorCode === 'missing-model' && <>
        <Button type="button" variant="ghost" size="sm" disabled={!interactive} onClick={() => void speech.downloadModel()}>
          下载转写模型（约 46 MB）
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={!interactive} onClick={() => void speech.importModel()}>导入转写模型</Button>
      </>} />}
    <ComposerSurface.Host onSubmit={event => { event.preventDefault(); submit() }}
      onDragOver={event => {
        onDragOver?.(event)
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = attachmentAvailable && !attachmentPending ? 'copy' : 'none'
        }
      }}
      onDrop={event => {
        onDrop?.(event)
        if (event.defaultPrevented || !event.dataTransfer.files.length) return
        event.preventDefault()
        if (attachmentAvailable && !attachmentPending) void intake.addFiles(Array.from(event.dataTransfer.files))
      }}>
      {draftReferences}
      {(send.references.length > 0 || send.attachments.length > 0) && <div className="acp-source-references">
        {send.attachments.map(attachment => <div className="acp-source-chip conversation-context-chip" data-kind="file" key={attachment.id}>
          {attachment.type === 'image' ? <Image size={14} aria-hidden="true" /> : <FileIcon size={14} aria-hidden="true" />}
          <span title={attachment.name}>{attachment.name}</span>
          <button type="button" className="my-icon-control" aria-label={`移除附件 ${attachment.name}`}
            disabled={!attachmentAvailable || attachmentPending}
            onClick={() => void intake.remove(attachment.id)}><X size={13} aria-hidden="true" /></button>
        </div>)}
        {send.references.map(reference => <div className="acp-source-chip conversation-context-chip" data-kind="citation" key={reference.id}>
          <Quote size={14} aria-hidden="true" />
          <span title={reference.text}>{reference.label}</span>
          <button type="button" className="my-icon-control" aria-label={`移除${reference.label}`} disabled={!interactive}
            onClick={() => send.removeReference(reference.id)}><X size={13} aria-hidden="true" /></button>
        </div>)}
      </div>}
      {attachmentPending && <p className="my-activity-note px-4 pt-2" role="status">
        <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />正在准备附件…
      </p>}
      {intake.state.error && <div className="px-4 pt-2">
        <FeedbackNotice variant="inline" title="未能准备附件" description={intake.state.error}
          actions={intake.state.retry && <Button type="button" size="sm" variant="ghost"
            disabled={!attachmentAvailable} onClick={intake.state.retry}>重试</Button>} />
      </div>}
      {referenceError?.key === send.draftKey && <div className="px-4 pt-2">
        <FeedbackNotice variant="inline" title="未能引用会话" description={referenceError.message} />
      </div>}
      <ComposerPromptEditorTiptap editorRef={promptRef} anchorRef={menuAnchorRef} draftKey={send.draftKey}
        value={send.draft} skills={skills} disabled={!interactive}
        placeholder="想问什么都可以。@ 引用来源，$ 使用技能，/ 输入命令"
        describedBy={reason ? diagnosticId : undefined} invalid={overLimit}
        onOpenCitation={onOpenCitation}
        suggestionListId={menuOpen && menuItems.length ? menuId : undefined}
        activeSuggestionId={menuOpen && selectedMenuItem ? composerSuggestionOptionId(menuId, selectedMenuItem.id) : undefined}
        onChange={(snapshot, textChanged) => {
          if (document.activeElement === promptRef.current?.element) trackCaret(snapshot)
          if (!textChanged) return
          setReferenceError(undefined)
          send.setDraft(snapshot.value)
        }}
        onFocus={snapshot => { dismissTrigger(''); trackCaret(snapshot) }}
        onBlur={() => setCaret(undefined)}
        onPaste={event => {
          const inline = pasteInline.current
          pasteInline.current = false
          onPaste?.(event)
          if (event.defaultPrevented || !attachmentAvailable || attachmentPending) return
          const files = Array.from(event.clipboardData.files)
          if (files.length) {
            event.preventDefault()
            void intake.addFiles(files)
            return
          }
          const text = event.clipboardData.getData('text/plain')
          const selection = promptRef.current?.readSnapshot().selection
          const inlineLength = send.outgoingLength + text.length - (selection ? selection.end - selection.start : 0)
          if (inline || !shouldAttachPastedText(text, inlineLength, CONVERSATION_TEXT_LIMIT)) return
          event.preventDefault()
          void intake.addPastedText(text)
        }}
        onCommandKeyDown={event => {
          pasteInline.current = Boolean(event.shiftKey && event.ctrlKey && !event.altKey && !event.metaKey &&
            (event.code === 'KeyV' || event.key.toLowerCase() === 'v'))
          if (event.isComposing || event.keyCode === 229) return
          if (menuOpen && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              dismissTrigger(triggerKey)
              return
            }
            if (selectedMenuItem && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              const direction = event.key === 'ArrowDown' ? 1 : -1
              const next = menuItems[(activeIndex + direction + menuItems.length) % menuItems.length]
              setHighlight({ triggerKey, itemId: next.id })
              return
            }
            if (selectedMenuItem && (event.key === 'Enter' || event.key === 'Tab')) {
              event.preventDefault()
              void pickMenuItem(selectedMenuItem)
              return
            }
          }
          if (event.key === 'ArrowUp' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
            !send.hasContent && previousPrompt && interactive) {
            event.preventDefault()
            send.setDraft(previousPrompt)
            return
          }
          if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey) return
          if (!interactive || (event.altKey && (!running || !canSteerDraft))) return
          event.preventDefault()
          submit(event.altKey)
        }} />
      {menuOpen && <ConversationComposerMenu id={menuId} anchor={menuAnchorRef} items={menuItems} activeIndex={activeIndex}
        triggerKind={activeTrigger.kind} isLoading={activeTrigger.kind === 'path' ? files.pending : isSearchingSkills}
        emptyStateText={files.error ?? undefined}
        onHighlight={index => { if (index !== activeIndex) setHighlight({ triggerKey, itemId: menuItems[index].id }) }}
        onSelect={item => void pickMenuItem(item)} />}
      {reason && <div id={diagnosticId} className="px-4 pb-2 text-my-xs text-my-secondary break-words" role="status">{reason}</div>}
      <div className="acp-composer-toolbar conversation-composer-toolbar" ref={toolbar}>
        <ComposerAddMenu interactive={interactive}
          attachment={{
            available: attachmentAvailable && !attachmentPending,
            disabledReason: attachmentPending ? '正在准备附件…' : intake.state.error ?? (attachmentAvailable ? undefined : '当前会话无法添加附件。'),
            pick: () => void intake.pick(),
          }}
          taskSection={taskSection} />
        {leadingControls}
        {(send.hasContent || send.stash) && <Dropdown disabled={!interactive} placement="top"
          trigger={({ open, toggle }) => <button type="button" className="my-icon-control" aria-label="草稿暂存"
            aria-expanded={open} onClick={toggle} disabled={!interactive}>
            <Archive size={15} aria-hidden="true" />
          </button>}>
          {close => <>
            <DropdownItem icon={<Archive size={14} />} disabled={!send.hasContent || Boolean(send.stash)}
              onClick={() => { send.stashDraft(); close() }}>暂存草稿</DropdownItem>
            <DropdownItem icon={<ArchiveRestore size={14} />} disabled={send.hasContent || !send.stash}
              onClick={() => { send.restoreStash(); close() }}>取回草稿</DropdownItem>
          </>}
        </Dropdown>}
        <div className="spacer" />
        {canStop && <button type="button" className="my-icon-control" title="停止当前回合" aria-label="停止当前回合"
          disabled={!interactive} onClick={onStop}><Square size={15} aria-hidden="true" /></button>}
        <ConversationModelPicker anchor={toolbar} triggerRef={modelTrigger} catalog={catalog} value={model} lockedInstanceId={lockedInstanceId} root={root}
          onChange={onModelChange} disabled={!interactive} />
        {speech.available && <button type="button" className="my-icon-control shrink-0"
          title={recording ? '停止录音' : '语音输入'} aria-label={recording ? '停止录音' : '语音输入'}
          aria-pressed={recording} disabled={!interactive || speechBusy}
          onClick={() => { if (recording) void speech.stop(); else void speech.start() }}>
          {speechBusy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" size={15} aria-hidden="true" />
            : recording ? <MicOff size={15} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}
        </button>}
        {(speechBusy || recording) && <button type="button" className="my-icon-control shrink-0" aria-label="取消语音输入"
          disabled={!interactive} onClick={() => void speech.cancel()}><X size={14} aria-hidden="true" /></button>}
        {running && canSteerDraft && <button type="button" className="my-composer-control shrink-0 px-1.5 py-1 text-my-xs"
          title="插话（Alt+Enter）" disabled={!allowSend} onClick={() => submit(true)}>插话</button>}
        <button type="submit" className="my-icon-control shrink-0" title={sendLabel} aria-label={sendLabel} disabled={!allowSend}>
          {sendLabel === '加入队列' ? <ListEnd size={16} aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />}
        </button>
      </div>
    </ComposerSurface.Host>
    <span className="sr-only" role="status">{state.phase === 'submitting' ? '正在提交消息' : findingReference ? '正在读取所选会话' :
      recording ? '正在录音' : speechPhase === 'transcribing' ? '正在转写' : speechPhase === 'preparing' ? '正在准备录音'
        : speechPhase === 'installing' ? '正在安装转写模型' : ''}</span>
  </ComposerSurface.Shell>
}
