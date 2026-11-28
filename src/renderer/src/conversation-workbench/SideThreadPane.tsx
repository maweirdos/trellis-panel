import { useContext, useEffect, useMemo, useState, type JSX, type ReactNode, type RefObject } from 'react'
import { ArrowUpLeft, GitMerge, Link2, Square } from 'lucide-react'
import type { AssistantCitation } from '../../../shared/conversation/assistantCitations'
import type { ConversationTaskLocator } from '../../../shared/conversation/task-scope'
import { Button } from '../my/ui'
import { FeedbackNotice } from '../my/FeedbackNotice'
import { projectRootKey } from '../my/navigation'
import { ChatProjectFileLinks } from './chatProjectFileLinks'
import { ConversationTimeline, type ConversationCitationNavigation } from './ConversationTimeline'
import type { OpenAssistantCitation } from './AssistantCitationChip'
import { ConversationQueue } from './ConversationQueue'
import { ConversationRuntimeRequests } from './ConversationRuntimeRequests'
import { isActiveRun, queuedRunsWithText, runStartIso, useConversationThread, type ConversationApplyResult, type ConversationThreadController } from './useConversationThread'

export interface ParentDraftThreadReference {
  readonly threadId: string
  readonly label: string
  readonly messageIds?: readonly string[]
}

export interface SideThreadPaneProps {
  readonly root: string
  readonly scopeKey: string
  readonly hostThreadId: string
  readonly threadId: string
  readonly task?: ConversationTaskLocator
  readonly interactive: boolean
  readonly writable?: boolean
  readonly citationRef?: RefObject<ConversationCitationNavigation | null>
  readonly onCitationReady?: (threadId: string, readable: boolean) => void
  readonly onCite?: (citation: AssistantCitation) => void
  readonly onOpenCitation?: OpenAssistantCitation
  readonly onAddToParentDraft?: (reference: ParentDraftThreadReference) => void
  readonly onMergeBackToParent?: (input: { readonly sourceThreadId: string; readonly title: string }) => Promise<ConversationApplyResult>
  readonly onOpenParent?: (threadId: string) => void
  readonly renderComposer?: (input: { readonly threadId: string; readonly controller: ConversationThreadController }) => ReactNode
}

export function SideThreadPane(props: SideThreadPaneProps): JSX.Element {
  const { root, scopeKey, hostThreadId, threadId, task, interactive, writable = interactive,
    citationRef, onCitationReady, onCite, onOpenCitation, onAddToParentDraft, onMergeBackToParent, onOpenParent, renderComposer } = props
  const [merging, setMerging] = useState(false)
  const [mergeFeedback, setMergeFeedback] = useState<{ readonly tone: 'success' | 'error'; readonly message: string } | null>(null)
  useEffect(() => {
    setMerging(false)
    setMergeFeedback(null)
  }, [threadId])
  const hostScope = JSON.stringify([scopeKey, root, hostThreadId])
  const target = useMemo(() => ({ threadId }), [threadId])
  const controller = useConversationThread(root, target, interactive, hostScope, task)
  const result = controller.active
  const projection = result?.projection
  const parentFileLinks = useContext(ChatProjectFileLinks)
  const relation = projection?.relations.parent
  const belongsToHost = relation?.parentThreadId === hostThreadId
  const nativeChild = relation?.kind === 'native-activity'
  const delegated = relation?.kind === 'delegated'
  const childrenReady = projection && belongsToHost
  const fileLinks = childrenReady && !result?.error && parentFileLinks &&
    projectRootKey(projection.thread.worktreePath ?? root) === projectRootKey(parentFileLinks.root) ? parentFileLinks : null
  const canOperate = writable && interactive && Boolean(childrenReady && !nativeChild && !projection.thread.archivedAt && !result?.error)
  const canCompose = canOperate && !delegated
  const title = childrenReady ? projection.thread.title : '侧边会话'
  const queued = childrenReady ? queuedRunsWithText(projection.queuedRuns, projection.messages) : []
  const queuedIds = new Set(queued.map(item => item.run.userMessageId as string))
  const rows = childrenReady ? projection.rows.filter(row => !queuedIds.has(row.id)) : []
  const canReference = canOperate && projection?.messages.some(message => message.role === 'user')
  const hasSettledAssistant = Boolean(projection?.messages.some(message => message.role === 'assistant' && !message.streaming && message.text.trim()))
  const canMergeBack = Boolean(
    canOperate
    && belongsToHost
    && (relation?.kind === 'side-chat' || relation?.kind === 'fork')
    && onMergeBackToParent
    && hasSettledAssistant,
  )
  const activeRun = projection?.activeRun
  const stopRunId = activeRun && relation?.childRunId === activeRun.id && isActiveRun(activeRun) ? activeRun.id : undefined
  const timelineKey = JSON.stringify([controller.scope, projection?.cursor?.storageId])
  const readSettled = Boolean(result)
  const citationReadable = interactive && Boolean(childrenReady && !result?.error)
  useEffect(() => {
    if (readSettled) onCitationReady?.(threadId, citationReadable)
  }, [citationReadable, onCitationReady, readSettled, threadId])

  async function handleMergeBack(): Promise<void> {
    if (!canMergeBack || !onMergeBackToParent || merging) return
    setMerging(true)
    setMergeFeedback(null)
    try {
      const outcome = await onMergeBackToParent({ sourceThreadId: threadId, title })
      if (outcome.ok) {
        setMergeFeedback({ tone: 'success', message: '已将最新结论回并到父会话。' })
      } else {
        setMergeFeedback({ tone: 'error', message: outcome.reason })
      }
    } finally {
      setMerging(false)
    }
  }

  return <section className="my-conversation-frame conversation-side-thread" aria-label={title}>
    <header className="conversation-side-thread-heading">
      <strong className="my-item-title">{title}</strong>
      {relation?.access === 'read-only' && !delegated && <span className="my-item-description">工程只读</span>}
      {belongsToHost && onOpenParent && <Button size="sm" variant="ghost" onClick={() => onOpenParent(hostThreadId)}>
        <ArrowUpLeft size={14} aria-hidden="true" />父会话
      </Button>}
      {belongsToHost && (relation?.kind === 'side-chat' || relation?.kind === 'fork') && onMergeBackToParent && (
        <Button size="sm" variant="ghost" disabled={!canMergeBack || merging} onClick={() => void handleMergeBack()}>
          <GitMerge size={14} aria-hidden="true" />
          {merging ? '回并中…' : relation.mergedBackAt ? '再次回并' : '回并到父会话'}
        </Button>
      )}
      {relation?.kind === 'side-chat' && onAddToParentDraft && <Button size="sm" variant="ghost" disabled={!canReference}
        onClick={() => onAddToParentDraft({ threadId, label: title })}>
        <Link2 size={14} aria-hidden="true" />添加到对话
      </Button>}
    </header>
    {mergeFeedback && (
      <div className="conversation-side-thread-feedback">
        {mergeFeedback.tone === 'error' ? (
          <FeedbackNotice
            variant="bar-compact"
            tone="error"
            title="未能回并到父会话"
            description={mergeFeedback.message}
          />
        ) : (
          <p className="my-item-description m-0" role="status">{mergeFeedback.message}</p>
        )}
      </div>
    )}
    {result?.error && <p className="my-item-description conversation-side-thread-error" role="alert">{result.error}</p>}
    {projection && !belongsToHost && <p className="my-item-description conversation-side-thread-error" role="status">此会话与当前父会话无关联。</p>}
    <ChatProjectFileLinks.Provider value={fileLinks}>
    <ConversationTimeline key={timelineKey} threadId={timelineKey} rows={rows}
      sourceThreadId={citationReadable ? threadId : undefined}
      citationRef={citationRef} onOpenCitation={onOpenCitation}
      onCite={canCompose && relation?.kind === 'side-chat' && onCite ? citation => {
        if (citation.threadId === threadId && projection?.messages.some(message =>
          message.id === citation.messageId && message.role === 'assistant' && !message.streaming)) onCite(citation)
      } : undefined}
      working={!result || Boolean(childrenReady && activeRun && isActiveRun(activeRun) && !result?.error)}
      workingLabel={!result ? '正在读取会话…' : undefined}
      workingStartedAt={runStartIso(activeRun)}
      workingUserMessageId={activeRun?.userMessageId}
      hasOlderHistory={Boolean(childrenReady && projection.hasOlderHistory)} loadingEarlier={controller.loadingEarlier}
      onLoadEarlier={controller.loadEarlier}
      onQuote={canReference && onAddToParentDraft ? message => onAddToParentDraft({ threadId, label: title, messageIds: [message.id] }) : undefined}
      footer={childrenReady && <>
        {canCompose && <ConversationQueue controller={controller} queued={queued} queuePaused={projection.queuePaused} disabled={!canOperate} />}
        {!nativeChild && <ConversationRuntimeRequests controller={controller} requests={delegated
          ? projection.runtimeRequests.filter(request => request.runId === relation.childRunId) : projection.runtimeRequests} disabled={!canOperate}
          cwd={root} threadId={threadId} task={task} />}
      </>} />
    </ChatProjectFileLinks.Provider>
    {childrenReady && nativeChild && <p className="my-item-description conversation-side-thread-bar">{projection.thread.modelSelection.model} · 引擎子会话仅供阅读</p>}
    {childrenReady && delegated && <div className="conversation-side-thread-bar">
      <span className="my-item-description">委派子会话</span>
      {stopRunId && <Button size="sm" variant="ghost" disabled={!canOperate || Boolean(controller.pendingCommands.size)}
        onClick={() => void controller.stop(stopRunId)}><Square size={13} aria-hidden="true" />停止原运行</Button>}
      {controller.commandFailure && <span className="my-item-description" role="status">{controller.commandFailure.reason}</span>}
      {controller.commandFailure?.uncertain && <Button size="sm" variant="ghost" disabled={!canOperate || Boolean(controller.pendingCommands.size)}
        onClick={() => {
          const failure = controller.commandFailure
          if (failure?.uncertain) void controller.checkCommand(failure.commandId)
        }}>查询回执</Button>}
    </div>}
    {canCompose && renderComposer?.({ threadId, controller })}
  </section>
}
