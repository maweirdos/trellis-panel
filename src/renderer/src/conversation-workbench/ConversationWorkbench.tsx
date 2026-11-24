import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { ArrowLeft, ChevronDown, MoreHorizontal, PanelLeft, Pencil, Plus, Trash2 } from 'lucide-react'
import { conversationThreadCommandSchema, type ConversationThreadCommand } from '../../../shared/conversation/command-runtime'
import type { OrchestrationV2AppThread } from '../../../shared/conversation/contracts'
import type { ConversationTaskScope } from '../../../shared/conversation/task-scope'
import { ConversationListRow } from '../acp/ConversationListRow'
import { ConversationSidebar } from '../acp/ConversationSidebar'
import { ConversationWorkspaceHeader } from '../acp/ConversationWorkspaceHeader'
import { api, hasIpc } from '../api'
import { FeedbackNotice, normalizeFeedbackDiagnostic } from '../my/FeedbackNotice'
import { ContextRegion } from '../my/layout/ContextRegion'
import { ModuleLinks } from '../my/layout/ModuleLinks'
import { useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import { projectRootKey } from '../my/navigation'
import { useMy } from '../my/store'
import { Button, Dropdown, DropdownItem, Modal, SearchInput } from '../my/ui'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import {
  applyOptimisticUserMessagesAction,
  emptyOptimisticUserMessages,
  reconcileOptimisticUserMessages,
  type OptimisticUserMessage,
} from './optimisticUserMessages'
import { ConversationComposer } from './ConversationComposer'
import { ConversationQueue } from './ConversationQueue'
import { ConversationRuntimeRequests } from './ConversationRuntimeRequests'
import { ConversationTimeline } from './ConversationTimeline'
import { CONVERSATION_TEXT_LIMIT, composerDraftKey, updateComposerDraft } from './useComposerDraft'
import { conversationError, useComposerSend, type ComposerReceipt } from './useComposerSend'
import { useConversationModelCatalog } from './useConversationModelCatalog'
import {
  isActiveRun, queuedRunsWithText, useConversationThread,
  type ConversationApplyResult, type ConversationTimelineRow, type ThreadReadTarget,
} from './useConversationThread'
import '../acp/workspace.css'
import './conversation-workbench.css'

type ThreadChange = Extract<ConversationThreadCommand, { type: `thread.${string}` }>
type ThreadChangeIntent = ThreadChange extends infer Change ? Change extends ThreadChange ? Omit<Change, 'commandId'> : never : never

function savedThread(key: string): string | null {
  try { return localStorage.getItem(`crux.conversation.selected:${key}`) } catch { return null }
}

function rememberThread(key: string, threadId: string | null): void {
  try {
    if (threadId) localStorage.setItem(`crux.conversation.selected:${key}`, threadId)
    else localStorage.removeItem(`crux.conversation.selected:${key}`)
  } catch {}
}

function readPendingThreadChange(key: string): ThreadChange | undefined {
  try {
    const saved = localStorage.getItem(`crux.conversation.pendingThreadChange:${key}`)
    if (!saved) return undefined
    const parsed = conversationThreadCommandSchema.safeParse(JSON.parse(saved))
    if (parsed.success && parsed.data.type.startsWith('thread.')) return parsed.data as ThreadChange
  } catch {}
}

function savePendingThreadChange(key: string, command?: ThreadChange): void {
  try {
    const scope = `crux.conversation.pendingThreadChange:${key}`
    if (command) localStorage.setItem(scope, JSON.stringify(command))
    else localStorage.removeItem(scope)
  } catch {}
}

function ConversationIssue({ title, reason, actions, uncertain = false }: {
  title: string
  reason?: string
  actions?: ReactNode
  uncertain?: boolean
}): JSX.Element {
  const summary = reason ? normalizeFeedbackDiagnostic(reason).trim().split('\n')[0]?.slice(0, 240) : undefined
  return <FeedbackNotice variant="inline" title={title} description={summary}
    diagnostic={reason && summary !== reason.trim() ? reason : undefined}
    tone={uncertain ? 'warning' : 'error'} actions={actions} />
}

interface ConversationWorkbenchProps {
  root: string
  source?: 'code' | 'native' | 'work' | 'task'
  taskScope?: ConversationTaskScope
  onBackToTask?: () => void
}

export function ConversationWorkbench({ root, source = 'native', taskScope, onBackToTask }: ConversationWorkbenchProps): JSX.Element {
  const sidebarWidth = useSidebarWidthStyle()
  const collapsed = useMy((state) => state.sidebarCollapsed)
  const task = taskScope?.locator
  const rootKey = taskScope ? JSON.stringify([
    source, taskScope.actorId, taskScope.spaceId, taskScope.locator, taskScope.binding.assigneeGeneration,
    taskScope.materialRevision, projectRootKey(root) ?? root,
  ]) : `${source}:${projectRootKey(root) ?? root}`
  const code = source === 'code'
  const workspaceLabel = taskScope ? '任务对话' : source === 'work' ? 'Work 对话' : code ? 'Code 对话' : '原生对话'
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const writable = interactive && hasIpc && taskScope?.canSend !== false
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [threads, setThreads] = useState<readonly OrchestrationV2AppThread[]>()
  const [query, setQuery] = useState('')
  const [listError, setListError] = useState('')
  const [listRevision, setListRevision] = useState(0)
  const [management, setManagement] = useState<{ thread: OrchestrationV2AppThread; action: 'rename' | 'delete'; title: string }>()
  const [pendingChange, setPendingChange] = useState(() => readPendingThreadChange(rootKey))
  const [managementError, setManagementError] = useState('')
  const [cleanupPending, setCleanupPending] = useState(false)
  const [controlFailure, setControlFailure] = useState<Extract<ConversationApplyResult, { ok: false }>>()
  const [queueEdit, setQueueEdit] = useState<{ threadId: string; runId: string; text: string }>()
  const changingThread = useRef(false)
  const [target, setTarget] = useState<ThreadReadTarget | null>(() => {
    const threadId = savedThread(rootKey)
    return threadId ? { threadId } : null
  })
  const [optimistic, setOptimistic] = useState(() => emptyOptimisticUserMessages(''))
  const targetRef = useRef(target)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const mounted = useRef(false)

  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const controller = useConversationThread(root, target, interactive && hasIpc, rootKey, task)
  const { active: read, reload, loadEarlier, loadingEarlier, stop, queue } = controller
  const projection = read?.projection
  const run = target?.runId
    ? projection?.runs.find((item) => item.id === target.runId)
    : projection?.runs.at(-1)
  const selectedThread = projection?.thread ?? threads?.find((item) => item.id === target?.threadId)
  const activeRun = projection?.runs.slice().reverse().find(item => item.status !== 'queued' && isActiveRun(item))
  const catalog = useConversationModelCatalog(root, writable, rootKey, task)
  const instanceId = selectedThread?.modelSelection.instanceId
  const instance = catalog.instances.find(item => item.instanceId === instanceId)
  const descriptor = instance?.read?.status === 'ready' ? instance.read.descriptor : undefined
  const canSteer = Boolean(activeRun && descriptor?.actions.steer?.state === 'verified')

  useEffect(() => {
    if (!interactive || !hasIpc) return
    let cancelled = false
    async function list(): Promise<void> {
      try {
        const result = await api.conversationList(root, { query, ...(task && { task }) })
        if (cancelled) return
        if (!result.ok) throw new Error(result.error)
        setThreads(result.threads)
        setListError('')
      } catch (error) {
        if (!cancelled) setListError(conversationError(error))
      }
    }
    const timer = window.setTimeout(() => void list(), query ? 160 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [interactive, listRevision, query, root, task])

  function select(next: ThreadReadTarget | null): void {
    rememberThread(rootKey, next?.threadId ?? null)
    targetRef.current = next
    setTarget(next)
    setControlFailure(undefined)
    setQueueEdit(undefined)
    setSidebarOpen(false)
  }

  function changeConfirmed(command: ThreadChange): void {
    savePendingThreadChange(rootKey)
    setPendingChange(undefined)
    setCleanupPending(false)
    setManagement(undefined)
    setManagementError('')
    if (targetRef.current?.threadId === command.threadId) {
      if (command.type === 'thread.delete' || command.type === 'thread.archive' && command.archived) select(null)
      else reload()
    }
    setListRevision(value => value + 1)
  }

  async function applyThreadChange(command: ThreadChange): Promise<void> {
    if (changingThread.current || !writable || !canInteract()) return
    const alreadyAdmitted = cleanupPending && pendingChange?.commandId === command.commandId
    changingThread.current = true
    savePendingThreadChange(rootKey, command)
    setPendingChange(command)
    setManagementError('')
    try {
      const result = await api.conversationApply({ cwd: root, command, ...(task && { task }) })
      if (!mounted.current || !canInteract()) return
      if (result.ok) {
        if (result.receipt.dispatch === 'completed') changeConfirmed(command)
        else {
          setCleanupPending(command.type === 'thread.delete' && result.receipt.dispatch === 'pending-reconciliation')
          setManagementError(result.receipt.detail ?? '原操作尚未确认完成。')
        }
      } else {
        setManagementError(result.error)
        if (!alreadyAdmitted && 'outcome' in result && result.outcome === 'not-admitted') {
          savePendingThreadChange(rootKey)
          setPendingChange(undefined)
          setCleanupPending(false)
        }
      }
    } catch (error) {
      if (mounted.current && canInteract()) setManagementError(conversationError(error))
    } finally { changingThread.current = false }
  }

  function changeThread(intent: ThreadChangeIntent): void {
    if (!pendingChange) void applyThreadChange({ ...intent, commandId: crypto.randomUUID() })
  }

  async function checkThreadChange(): Promise<void> {
    if (!pendingChange || changingThread.current || !canInteract()) return
    const command = pendingChange
    changingThread.current = true
    try {
      const result = await api.conversationThreadCommand({ cwd: root, threadId: command.threadId, commandId: command.commandId, ...(task && { task }) })
      if (!mounted.current || !canInteract()) return
      if (result.ok && result.receipt?.dispatch === 'completed') changeConfirmed(command)
      else {
        if (result.ok && command.type === 'thread.delete' && result.receipt?.dispatch === 'pending-reconciliation') {
          setCleanupPending(true)
        }
        setManagementError(result.ok ? result.receipt?.detail ?? '原操作尚无已完成的回执。' : result.error)
      }
    } catch (error) {
      if (mounted.current && canInteract()) setManagementError(conversationError(error))
    } finally { changingThread.current = false }
  }

  function onAccepted(receipt: ComposerReceipt, message: OptimisticUserMessage): void {
    const openThreadId = targetRef.current?.threadId
    if (!openThreadId || openThreadId === receipt.threadId) {
      setOptimistic(current => applyOptimisticUserMessagesAction(
        current.threadId === receipt.threadId ? current : emptyOptimisticUserMessages(receipt.threadId),
        receipt.threadId,
        existing => [...existing, message],
      ))
      if (openThreadId) reload()
      else select({ threadId: receipt.threadId })
    }
    setListRevision((value) => value + 1)
  }

  const composer = useComposerSend({
    root, threadId: target?.threadId ?? null, scopeKey: rootKey, interactive: writable, task,
    running: Boolean(activeRun), canSteer, onAccepted,
  })
  const selectedModel = composer.model ?? (selectedThread ? {
    instanceId: selectedThread.modelSelection.instanceId,
    id: selectedThread.modelSelection.model,
    options: selectedThread.modelSelection.options,
    displayName: catalog.models.find(model => model.instanceId === selectedThread.modelSelection.instanceId
      && model.id === selectedThread.modelSelection.model)?.displayName ?? selectedThread.modelSelection.model,
  } : null)
  const submission = composer.state.phase === 'idle' ? undefined : composer.state.submission
  const submitting = composer.state.phase === 'submitting' || composer.state.phase === 'accepted'
  const outcomeUnknown = composer.state.phase === 'unknown'
  const draftMessage = submitting || outcomeUnknown ? submission?.message : undefined
  const visibleThreadId = target?.threadId ?? ''
  const acknowledgedIds = new Set<string>(projection?.messages.map((message) => message.id))
  const reconciled = reconcileOptimisticUserMessages(optimistic, visibleThreadId, acknowledgedIds)
  if (reconciled !== optimistic) setOptimistic(reconciled)

  const queued = projection ? queuedRunsWithText(projection.queuedRuns, projection.messages) : []
  const queuedMessageIds = new Set<string>(queued.map(({ run }) => run.userMessageId))
  const rows: ConversationTimelineRow[] = (projection?.rows ?? []).filter(row => !queuedMessageIds.has(row.id))
  const optimisticMessages = [...reconciled.messages]
  if (draftMessage && !acknowledgedIds.has(draftMessage.id) && !optimisticMessages.some(message => message.id === draftMessage.id)) {
    optimisticMessages.push(draftMessage)
  }
  for (const message of optimisticMessages) {
    rows.push({ kind: 'message', id: message.id, message: { ...message, runId: null, streaming: false } })
  }
  const runPending = Boolean(run && isActiveRun(run))
  const loadingThread = Boolean(target && !projection && !read?.error)
  const draftIsEmpty = !target && !rows.length && composer.state.phase === 'idle'

  const modelLabel = (id: string): string => catalog.models.find(model => model.instanceId === instanceId && model.id === id)?.displayName ?? id

  function openDraft(text = ''): void {
    select(null)
    if (text) updateComposerDraft(composerDraftKey(root, null, rootKey), current => ({ ...current, text: current.text || text }))
    requestAnimationFrame(() => {
      if (!targetRef.current && canInteract()) composerRef.current?.focus({ preventScroll: true })
    })
  }

  const runModel = run && modelLabel(run.modelSelection.model)
  const previousPrompt = run && projection?.messages.find((message) => message.id === run.userMessageId)
  const deleteRun = management?.action === 'delete' && management.thread.id === visibleThreadId ? activeRun : undefined

  function focusComposer(): void {
    const threadId = targetRef.current?.threadId
    requestAnimationFrame(() => {
      if (targetRef.current?.threadId === threadId && canInteract()) composerRef.current?.focus({ preventScroll: true })
    })
  }

  function applyControl(operation: ReturnType<typeof stop>): void {
    const originalThread = targetRef.current?.threadId
    void operation.then(result => {
      if (!mounted.current || !canInteract() || targetRef.current?.threadId !== originalThread) return
      setControlFailure(result.ok ? undefined : result)
      if (result.ok && result.source === 'reconcile') setQueueEdit(undefined)
    })
  }

  const controlNotice = controlFailure && <ConversationIssue
    title={controlFailure.uncertain ? '操作结果待核对' : '会话操作未完成'}
    reason={controlFailure.reason} uncertain={controlFailure.uncertain}
    actions={controlFailure.uncertain && <Button size="sm" variant="ghost"
      disabled={controller.pendingCommands.has(controlFailure.commandId)}
      onClick={() => applyControl(controller.checkCommand(controlFailure.commandId))}>查询回执</Button>}
  />
  const threadChangeActions = pendingChange && <>
    <Button type="button" size="sm" variant="ghost" onClick={() => void checkThreadChange()}>查询回执</Button>
    {cleanupPending && writable && <Button type="button" size="sm" variant="ghost"
      onClick={() => void applyThreadChange(pendingChange)}>继续清理</Button>}
  </>

  return <div className="acp-workspace conversation-workbench" style={sidebarWidth}>
    <Modal open={Boolean(queueEdit)} onClose={() => setQueueEdit(undefined)} ariaLabel="编辑排队消息" width={500}>
      {queueEdit && <form className="space-y-4 p-4" onSubmit={event => {
        event.preventDefault()
        if (!queueEdit.text.trim() || targetRef.current?.threadId !== queueEdit.threadId || controller.pendingCommands.size || controlFailure?.uncertain) return
        const edit = queueEdit
        applyControl(queue.edit(edit.runId, edit.text).then(result => {
          if (result.ok && mounted.current) setQueueEdit(current => current === edit ? undefined : current)
          return result
        }))
      }}>
        <h2 className="text-my-lg font-medium">编辑排队消息</h2>
        <textarea className="my-input w-full" rows={5} aria-label="排队消息" maxLength={CONVERSATION_TEXT_LIMIT} value={queueEdit.text}
          onChange={event => setQueueEdit({ ...queueEdit, text: event.target.value })} />
        {controlNotice}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setQueueEdit(undefined)}>取消</Button>
          <Button type="submit" variant="primary"
            disabled={!queueEdit.text.trim() || Boolean(controller.pendingCommands.size) || controlFailure?.uncertain}>保存</Button>
        </div>
      </form>}
    </Modal>
    <Modal open={Boolean(management)} onClose={() => setManagement(undefined)} ariaLabel={management?.action === 'delete' ? '删除会话' : '重命名会话'} width={420}>
      {management && <form className="space-y-4 p-4" onSubmit={event => {
        event.preventDefault()
        const threadId = management.thread.id
        if (management.action === 'rename') {
          if (management.title.trim()) void changeThread({ type: 'thread.rename', threadId, title: management.title })
        } else void changeThread({ type: 'thread.delete', threadId })
      }}>
        <h2 className="text-my-lg font-medium">{management.action === 'delete' ? '删除会话' : '重命名会话'}</h2>
        {management.action === 'rename' ? <input className="my-input w-full" aria-label="会话名称" maxLength={500} value={management.title}
          onChange={event => setManagement({ ...management, title: event.target.value })} />
          : <p className="my-item-description">删除「{management.thread.title}」及其消息记录。</p>}
        {managementError && <ConversationIssue title={pendingChange ? '操作结果待核对' : '未能更新会话'} reason={managementError}
          actions={pendingChange
            ? threadChangeActions
            : management.action === 'delete' && <Button type="button" size="sm" variant="ghost" onClick={() => {
              const threadId = management.thread.id
              setManagement(undefined)
              if (targetRef.current?.threadId !== threadId) select({ threadId })
              else if (deleteRun) applyControl(stop(deleteRun.id))
            }}>{deleteRun ? '停止原回合' : '查看原会话'}</Button>} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setManagement(undefined)}>取消</Button>
          <Button type="submit" variant={management.action === 'delete' ? 'danger' : 'primary'}
            disabled={Boolean(pendingChange) || management.action === 'rename' && !management.title.trim()}>{management.action === 'delete' ? '删除' : '保存'}</Button>
        </div>
      </form>}
    </Modal>
    <ContextRegion collapsed={collapsed && !sidebarOpen}><div className="acp-navigation-host flex min-h-0 shrink-0">
    <ConversationSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} ariaLabel={`${workspaceLabel}历史`}
      title={taskScope ? <strong className="my-item-title truncate" title={taskScope.title}>{taskScope.title}</strong>
        : <Dropdown trigger={({ open, toggle }) => <button type="button" className="acp-module-switch" aria-label="切换对话模块" aria-expanded={open} onClick={toggle}>
        <strong>{source === 'native' ? '原生对话' : '对话'}</strong><ChevronDown size={13} aria-hidden="true" />
      </button>}>{(close) => <div onClick={close}><ModuleLinks domain="agents" agentView={code ? undefined : 'native'} /></div>}</Dropdown>}
      primaryAction={<div className="grid gap-2">{writable && <button type="button" className="my-nav-item" onClick={() => openDraft()}><Plus size={15} aria-hidden="true" />新建对话</button>}
        <SearchInput value={query} onChange={value => setQuery(value.slice(0, 160))} size="sm" placeholder="搜索对话" /></div>}>
      {listError && <ConversationIssue title="无法读取会话列表" reason={listError}
        actions={<Button size="sm" variant="ghost" onClick={() => setListRevision((value) => value + 1)}>重试</Button>} />}
      {!management && (managementError || pendingChange) && <ConversationIssue title={pendingChange ? '操作结果待核对' : '未能更新会话'} reason={managementError}
        actions={threadChangeActions} />}
      {query.trim() && threads?.length === 0 && <p className="my-item-description p-2">没有匹配的会话</p>}
      {(threads ?? []).map(thread => <ConversationListRow key={thread.id} id={thread.id} title={thread.title}
        selected={thread.id === target?.threadId} pinned={Boolean(thread.pinnedAt)}
        onSelect={() => thread.id === targetRef.current?.threadId ? setSidebarOpen(false) : select({ threadId: thread.id })}
        onTogglePin={writable ? () => void changeThread({ type: 'thread.pin', threadId: thread.id, pinned: !thread.pinnedAt }) : undefined}
        onToggleArchive={writable ? () => void changeThread({ type: 'thread.archive', threadId: thread.id, archived: true }) : undefined}
        actions={writable && <Dropdown trigger={({ open, toggle }) => <button type="button" className="acp-recent-action-btn my-icon-control"
          aria-label={`${thread.title}的更多操作`} aria-expanded={open} onClick={toggle}><MoreHorizontal size={16} aria-hidden="true" /></button>}>
          {close => <>
            <DropdownItem icon={<Pencil size={14} aria-hidden="true" />} onClick={() => { close(); setManagement({ thread, action: 'rename', title: thread.title }) }}>重命名</DropdownItem>
            <DropdownItem danger icon={<Trash2 size={14} aria-hidden="true" />} onClick={() => { close(); setManagement({ thread, action: 'delete', title: thread.title }) }}>删除</DropdownItem>
          </>}
        </Dropdown>} />)}
    </ConversationSidebar>
    </div></ContextRegion>
    <section className="acp-main my-conversation-frame" aria-label={workspaceLabel}>
      <ConversationWorkspaceHeader leading={<>
        {onBackToTask && <button type="button" className="my-icon-control" title="返回任务" aria-label="返回任务" onClick={onBackToTask}>
          <ArrowLeft size={16} aria-hidden="true" />
        </button>}
        <button type="button" className="my-icon-control acp-mobile-only"
          aria-label="打开会话导航" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><PanelLeft size={16} aria-hidden="true" /></button>
      </>}
        identity={<strong>{selectedThread?.title ?? taskScope?.title ?? (target ? '会话' : '新建对话')}</strong>}
        actions={selectedThread && <span className="my-item-description conversation-model-name" title={selectedThread.modelSelection.model}>{modelLabel(selectedThread.modelSelection.model)}</span>} />
      <div className="acp-content" data-empty={draftIsEmpty || undefined}>
        <ConversationTimeline key={`timeline:${visibleThreadId}`} threadId={`${rootKey}:${visibleThreadId}`} rows={rows}
          working={submitting || loadingThread || runPending && !read?.error}
          workingLabel={loadingThread ? '正在读取会话…' : submitting && !target ? '正在发送给 Crux…'
            : run?.status === 'queued' || run?.status === 'preparing' ? '已受理，等待模型…'
              : run?.nativeTurnId || run?.engineAcceptedAt ? '模型已接收，正在回复…' : '正在连接并发送给模型…'}
          hasOlderHistory={Boolean(projection?.hasOlderHistory)} loadingEarlier={loadingEarlier}
          onLoadEarlier={() => void loadEarlier()}
          onQuote={writable && projection ? (message, text) => {
            composer.addReference({
              id: crypto.randomUUID(),
              label: message.role === 'user' ? '引用你的消息' : '引用会话回复',
              text,
            })
            focusComposer()
          } : undefined}
          onEdit={writable && projection ? message => {
            if (composer.hasContent) {
              composer.addReference({ id: `edit:${message.id}`, label: '引用原消息', text: message.text })
            } else composer.setDraft(message.text)
            focusComposer()
          } : undefined}
          emptyTitle={target ? '暂无消息' : undefined} footer={<>
            {!hasIpc && <ConversationIssue title="请在 Crux 桌面端使用原生对话" />}
            {read?.error && <ConversationIssue title="无法读取会话" reason={read.error}
              actions={<Button size="sm" variant="ghost" onClick={reload}>重新读取</Button>} />}
            {run?.outcomeUnknown && <ConversationIssue title={`${runModel} 的送达或回复结果待核对`} reason={run.failure} uncertain
              actions={<Button size="sm" variant="ghost" onClick={reload}>刷新结果</Button>} />}
            {run?.status === 'failed' && !run.outcomeUnknown && <ConversationIssue title={`${runModel} 执行失败`} reason={run.failure}
              actions={previousPrompt && !submitting && !outcomeUnknown && <Button size="sm" variant="ghost" onClick={() => openDraft(previousPrompt.text)}>更换模型</Button>} />}
            {!queueEdit && controlNotice}
          </>} />
        {projection && <div className="my-conversation-column conversation-controls">
          <ConversationRuntimeRequests controller={controller} requests={projection.runtimeRequests} disabled={!writable}
            cwd={root} threadId={projection.thread.id} task={task} />
          <ConversationQueue controller={controller} queued={queued} queuePaused={projection.queuePaused} disabled={!writable}
            onEditRequested={controlFailure?.uncertain ? undefined : (queuedRun, text) => {
              setControlFailure(undefined)
              setQueueEdit({ threadId: visibleThreadId, runId: queuedRun.id, text })
            }} />
        </div>}
        {taskScope?.canSend === false ? <div className="my-conversation-column acp-composer-region">
          <p className="my-item-description">{taskScope.reason ?? '当前任务会话仅供阅读。'}</p>
        </div> : <ConversationComposer
          interactive={writable} send={composer} catalog={catalog} model={selectedModel}
          onModelChange={composer.setModel} lockedInstanceId={instanceId}
          running={Boolean(activeRun)} canStop={Boolean(activeRun) && descriptor?.actions.cancel.state !== 'unsupported'}
          onStop={() => { if (activeRun) applyControl(stop(activeRun.id)) }}
          queuePaused={Boolean(projection?.queuePaused)}
          canSteer={canSteer && activeRun?.modelSelection.model === selectedModel?.id}
          disabledReason={target && !projection ? '正在读取原会话。' : undefined}
          textareaRef={composerRef} previousPrompt={previousPrompt?.text}
          mentionableThreads={(threads ?? []).filter(thread => thread.id !== visibleThreadId)
            .map(({ id, title }) => ({ id, title }))}
        />}
      </div>
    </section>
  </div>
}
