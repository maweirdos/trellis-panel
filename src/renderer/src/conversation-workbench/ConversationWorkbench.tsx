import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, LoaderCircle, PanelLeft, Plus } from 'lucide-react'
import type { ConversationCommandReceipt } from '../../../shared/conversation/desktop'
import { ConversationSidebar } from '../acp/ConversationSidebar'
import { ConversationWorkspaceHeader } from '../acp/ConversationWorkspaceHeader'
import { api, hasIpc } from '../api'
import { Select } from '../components/Select'
import { FeedbackNotice, normalizeFeedbackDiagnostic } from '../my/FeedbackNotice'
import { ContextRegion } from '../my/layout/ContextRegion'
import { ModuleLinks } from '../my/layout/ModuleLinks'
import { useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import { projectRootKey } from '../my/navigation'
import { useMy } from '../my/store'
import { Button, Dropdown } from '../my/ui'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import {
  applyOptimisticUserMessagesAction,
  emptyOptimisticUserMessages,
  reconcileOptimisticUserMessages,
  type OptimisticUserMessage,
} from './optimisticUserMessages'
import { conversationError, useComposerSend, type ComposerModel } from './useComposerSend'
import { isActiveRun, useConversationThread, type ConversationThread, type ThreadReadTarget } from './useConversationThread'
import '../acp/workspace.css'
import './conversation-workbench.css'

type ModelCatalog =
  | { state: 'idle' | 'loading' }
  | { state: 'ready'; models: ComposerModel[] }
  | { state: 'failed'; reason: string }

const selectedThreads = new Map<string, string>()

function Activity({ children }: { children: ReactNode }): JSX.Element {
  return <p className="my-activity-note" role="status"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />{children}</p>
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

export function ConversationWorkbench({ root, source = 'native' }: { root: string; source?: 'code' | 'native' }): JSX.Element {
  const sidebarWidth = useSidebarWidthStyle()
  const collapsed = useMy((state) => state.sidebarCollapsed)
  const rootKey = projectRootKey(root) ?? root
  const code = source === 'code'
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalog>({ state: 'idle' })
  const [modelId, setModelId] = useState('')
  const [threads, setThreads] = useState<readonly ConversationThread[]>()
  const [listError, setListError] = useState('')
  const [listRevision, setListRevision] = useState(0)
  const [target, setTarget] = useState<ThreadReadTarget | null>(() => {
    const threadId = selectedThreads.get(rootKey)
    return threadId ? { threadId } : null
  })
  const [optimistic, setOptimistic] = useState(() => emptyOptimisticUserMessages(''))
  const targetRef = useRef(target)
  const streamRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const composerActions = useRef<HTMLDivElement>(null)
  const catalogRequest = useRef(false)
  const mounted = useRef(false)
  const follow = useRef(true)

  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const { active: read, reload } = useConversationThread(root, target, interactive && hasIpc)
  const projection = read?.projection
  const run = target?.runId
    ? projection?.runs.find((item) => item.id === target.runId)
    : projection?.runs.at(-1)
  const selectedThread = projection?.thread ?? threads?.find((item) => item.id === target?.threadId)

  useEffect(() => {
    if (!interactive || !hasIpc) return
    let cancelled = false
    async function list(): Promise<void> {
      try {
        const result = await api.conversationList(root)
        if (cancelled) return
        if (!result.ok) throw new Error(result.error)
        setThreads(result.threads as ConversationThread[])
        setListError('')
      } catch (error) {
        if (!cancelled) setListError(conversationError(error))
      }
    }
    void list()
    return () => { cancelled = true }
  }, [interactive, listRevision, root])

  function select(next: ThreadReadTarget | null): void {
    if (next) selectedThreads.set(rootKey, next.threadId)
    else selectedThreads.delete(rootKey)
    targetRef.current = next
    follow.current = true
    setTarget(next)
    setSidebarOpen(false)
  }

  function onAccepted(receipt: ConversationCommandReceipt, message: OptimisticUserMessage): void {
    const openThreadId = targetRef.current?.threadId
    if (!openThreadId || openThreadId === receipt.threadId) {
      const fresh = emptyOptimisticUserMessages(receipt.threadId)
      setOptimistic(applyOptimisticUserMessagesAction(fresh, receipt.threadId, (existing) => [...existing, message]))
      select({ threadId: receipt.threadId, runId: receipt.runId })
    }
    setListRevision((value) => value + 1)
  }

  const composer = useComposerSend(root, interactive && hasIpc, onAccepted)
  const submission = composer.state.phase === 'idle' ? undefined : composer.state.submission
  const submitting = composer.state.phase === 'submitting' || composer.state.phase === 'accepted'
  const outcomeUnknown = composer.state.phase === 'unknown'
  const draftMessage = !target && (submitting || outcomeUnknown) ? submission?.message : undefined
  const visibleThreadId = target?.threadId ?? ''
  const acknowledgedIds = new Set<string>(projection?.messages.map((message) => message.id))
  const reconciled = reconcileOptimisticUserMessages(optimistic, visibleThreadId, acknowledgedIds)
  if (reconciled !== optimistic) setOptimistic(reconciled)

  const messages = [...(projection?.messages ?? []), ...reconciled.messages]
  if (draftMessage) messages.push(draftMessage)
  const lastMessage = messages.at(-1)
  const runPending = Boolean(run && isActiveRun(run))
  const draftIsEmpty = !target && !messages.length && composer.state.phase === 'idle'

  useLayoutEffect(() => {
    const element = streamRef.current
    if (element && follow.current) element.scrollTop = element.scrollHeight
  }, [target, lastMessage?.id, lastMessage?.text, run?.status, read?.error, composer.state.phase])

  async function loadCatalog(): Promise<void> {
    if (!hasIpc || !canInteract() || catalogRequest.current || catalog.state === 'ready' && catalog.models.length > 0) return
    catalogRequest.current = true
    setCatalog({ state: 'loading' })
    try {
      const result = await api.conversationModels(root)
      if (!mounted.current) return
      if (!result.ok) throw new Error(result.error)
      setCatalog({ state: 'ready', models: result.models })
    } catch (error) {
      if (mounted.current) setCatalog({ state: 'failed', reason: conversationError(error) })
    } finally {
      catalogRequest.current = false
    }
  }

  const models = catalog.state === 'ready' ? catalog.models : []
  const selectedModel = models.find((model) => model.id === modelId)
  const modelLabel = (id: string): string => models.find((model) => model.id === id)?.displayName ?? id
  const allowSend = Boolean(hasIpc && !target && composer.draft.trim() && selectedModel && !submitting && !outcomeUnknown)

  function send(): void {
    if (allowSend && selectedModel && canInteract()) void composer.send(selectedModel)
  }

  function openDraft(text = ''): void {
    select(null)
    if (text) {
      composer.setDraft((current) => current || text)
      setModelId('')
    }
    requestAnimationFrame(() => {
      if (!targetRef.current && canInteract()) composerRef.current?.focus({ preventScroll: true })
    })
  }

  const runModel = run && modelLabel(run.modelSelection.model)
  const previousPrompt = run && projection?.messages.find((message) => message.id === run.userMessageId)

  return <div className="acp-workspace conversation-workbench" style={sidebarWidth}>
    <ContextRegion collapsed={collapsed && !sidebarOpen}><div className="acp-navigation-host flex min-h-0 shrink-0">
    <ConversationSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} ariaLabel={code ? 'Code 会话历史' : '原生会话历史'}
      title={<Dropdown trigger={({ open, toggle }) => <button type="button" className="acp-module-switch" aria-label="切换对话模块" aria-expanded={open} onClick={toggle}>
        <strong>{code ? '对话' : '原生对话'}</strong><ChevronDown size={13} aria-hidden="true" />
      </button>}>{(close) => <div onClick={close}><ModuleLinks domain="agents" agentView={code ? undefined : 'native'} /></div>}</Dropdown>}
      primaryAction={<button type="button" className="my-nav-item" onClick={() => openDraft()}><Plus size={15} aria-hidden="true" />新建对话</button>}>
      {listError && <ConversationIssue title="无法读取会话列表" reason={listError}
        actions={<Button size="sm" variant="ghost" onClick={() => setListRevision((value) => value + 1)}>重试</Button>} />}
      {(threads ?? []).map((thread) => <button key={thread.id} type="button" className="acp-recent-row my-nav-item"
        aria-current={thread.id === target?.threadId ? 'page' : undefined}
        onClick={() => thread.id === targetRef.current?.threadId ? setSidebarOpen(false) : select({ threadId: thread.id })}>
        <span className="acp-recent-title my-item-title" title={thread.title}>{thread.title}</span>
      </button>)}
    </ConversationSidebar>
    </div></ContextRegion>
    <section className="acp-main my-conversation-frame" aria-label={code ? 'Code 对话' : '原生对话'}>
      <ConversationWorkspaceHeader leading={<button type="button" className="my-icon-control acp-mobile-only"
        aria-label="打开会话导航" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><PanelLeft size={16} aria-hidden="true" /></button>}
        identity={<strong>{selectedThread?.title ?? (target ? '会话' : '新建对话')}</strong>}
        actions={selectedThread && <span className="my-item-description conversation-model-name" title={selectedThread.modelSelection.model}>{modelLabel(selectedThread.modelSelection.model)}</span>} />
      <div className="acp-content" data-empty={draftIsEmpty || undefined}>
        <div ref={streamRef} className="acp-transcript my-scrollbar" aria-label="消息记录" tabIndex={draftIsEmpty ? undefined : 0}
          onScroll={(event) => {
            const scroll = event.currentTarget
            follow.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40
          }}>
          <div className="my-conversation-column acp-transcript-content conversation-messages">
            {!hasIpc && <ConversationIssue title="请在 Crux 桌面端使用原生对话" />}
            {draftIsEmpty && hasIpc && <div className="acp-conversation-start"><h1>开始一段对话</h1></div>}
            {messages.map((message) => <article key={message.id} className={`conversation-message conversation-message-${message.role}`}
              aria-label={message.role === 'user' ? '你的消息' : message.role === 'assistant' ? '模型回复' : '系统消息'}>
              <div className="my-chat-prose conversation-message-body">{message.text}</div>
            </article>)}
            {target && !read && !run && <Activity>{target.runId ? '已受理，正在读取会话…' : '正在读取会话…'}</Activity>}
            {read?.error && <ConversationIssue title="无法读取会话" reason={read.error}
              actions={<Button size="sm" variant="ghost" onClick={reload}>重新读取</Button>} />}
            {!read?.error && runPending && run && <Activity>{run.status === 'queued' || run.status === 'preparing'
              ? '已受理，等待模型…'
              : run.nativeTurnId || run.engineAcceptedAt ? '模型已接收，正在回复…' : '正在连接并发送给模型…'}</Activity>}
            {run?.outcomeUnknown && <ConversationIssue title={`${runModel} 的送达或回复结果待核对`} reason={run.failure} uncertain
              actions={<Button size="sm" variant="ghost" onClick={reload}>刷新结果</Button>} />}
            {run?.status === 'failed' && !run.outcomeUnknown && <ConversationIssue title={`${runModel} 执行失败`} reason={run.failure}
              actions={previousPrompt && !submitting && !outcomeUnknown && <Button size="sm" variant="ghost" onClick={() => openDraft(previousPrompt.text)}>更换模型</Button>} />}
            {submitting && !target && <Activity>正在发送给 Crux…</Activity>}
            {composer.state.phase === 'unknown' && !target && <ConversationIssue
              title={`${composer.state.submission.model.displayName} 的发送结果待核对`} reason={composer.state.reason} uncertain
              actions={<Button size="sm" variant="ghost" disabled={composer.state.checking} onClick={composer.checkReceipt}>
                {composer.state.checking ? '正在查询回执…' : '查询原发送回执'}
              </Button>} />}
            {composer.state.phase === 'rejected' && !target && <ConversationIssue
              title={`${composer.state.submission.model.displayName} 的消息未受理`} reason={composer.state.reason} />}
          </div>
        </div>
        {!target && <div className="my-conversation-column acp-composer-region">
          <form className="acp-composer conversation-composer" onSubmit={(event) => { event.preventDefault(); send() }}>
            <textarea ref={composerRef} className="my-scrollbar" rows={2} value={composer.draft} placeholder="说说你的想法…"
              aria-label="消息" onChange={(event) => composer.setDraft(event.target.value)} onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
                  event.nativeEvent.isComposing || event.keyCode === 229) return
                event.preventDefault()
                send()
              }} />
            <div className="acp-composer-toolbar conversation-composer-toolbar" ref={composerActions}>
              <Select value={modelId} options={models.map((model) => ({ value: model.id, label: model.displayName }))}
                ariaLabel="选择模型" placeholder="选择模型" disabled={!hasIpc || submitting} onChange={setModelId}
                composerAnchor={composerActions} onOpen={() => void loadCatalog()}
                emptyContent={catalog.state === 'loading' || catalog.state === 'idle' ? <Activity>正在读取模型…</Activity>
                  : <ConversationIssue title={catalog.state === 'failed' ? '无法读取 Codex 模型' : '没有可用的 Codex 模型'}
                    reason={catalog.state === 'failed' ? catalog.reason : undefined}
                    actions={<Button size="sm" variant="ghost" onClick={() => void loadCatalog()}>重新读取</Button>} />} />
              <button type="submit" className="my-icon-control" title="发送" aria-label="发送" disabled={!allowSend}>
                <ArrowUp size={16} aria-hidden="true" />
              </button>
            </div>
          </form>
        </div>}
      </div>
    </section>
  </div>
}
