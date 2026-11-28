import { useEffect, useState, type MutableRefObject } from 'react'
import type { ConversationUsageLimitRecovery } from '../../../shared/conversation/command-runtime'
import { presentFailedRunIssue, type FailedRunIssuePresentation } from '../../../shared/conversation/failure-taxonomy'
import type { ComposerModel } from './useComposerSend'
import {
  canResumeThread,
  deriveResumableRunId,
  type ConversationApplyResult,
  type ConversationMessage,
  type ConversationRun,
  type ConversationThreadController,
  type ConversationThreadProjection,
  type ThreadReadTarget,
} from './useConversationThread'

export interface UseThreadRecoveryActionsInput {
  readonly controller: ConversationThreadController
  readonly projection: ConversationThreadProjection | undefined
  readonly visibleThreadId: string | undefined
  readonly selectedModel: ComposerModel | null | undefined
  readonly latestRun: ConversationRun | undefined
  readonly latestRunModelLabel: string | undefined
  readonly previousPrompt: ConversationMessage | undefined
  readonly writable: boolean
  readonly submitting: boolean
  readonly archivedThread: boolean
  readonly isTaskThread: boolean
  readonly outcomeUnknown: boolean
  readonly controlFailureUncertain: boolean
  readonly mountedRef: MutableRefObject<boolean>
  readonly targetRef: MutableRefObject<ThreadReadTarget | null | undefined>
  readonly onApplyControl: (operation: Promise<ConversationApplyResult>) => void
  readonly onClearControlFailure: () => void
  readonly onBumpListRevision: () => void
  readonly onReload: () => void
}

export interface ThreadRecoveryActionsState {
  readonly resumableRunId: string | null
  readonly hasHeldQueuedRuns: boolean
  readonly canResume: boolean
  readonly resumeLabel: string
  readonly isResuming: boolean
  readonly recoveringRunId: string | null
  readonly isForceStopping: boolean
  readonly stoppingSubagentId: string | null
  readonly usageLimitRecovery: ConversationUsageLimitRecovery | null
  readonly usageLimitRemainingSeconds: number | null
  readonly usageLimitActionPending: boolean
  readonly failedRunIssue: FailedRunIssuePresentation | undefined
  readonly handleResume: () => void
  readonly handleForceStop: (runId?: string) => void
  readonly handleStopSubagent: (childThreadId: string, force?: boolean) => void
  readonly handleCancelUsageLimitRecovery: () => void
  readonly handleRetryUsageLimitRecoveryNow: () => void
  readonly handleFailedRunAction: (runId: string) => void
}

function computeRemainingSeconds(resumeAt: string, nowMs: number): number {
  const targetMs = Date.parse(resumeAt)
  if (!Number.isFinite(targetMs)) return 0
  return Math.max(0, Math.ceil((targetMs - nowMs) / 1_000))
}

/**
 * 收口会话恢复、强制止损、单停子代理、限流倒计时恢复与失败原地接力控制逻辑。
 */
export function useThreadRecoveryActions(input: UseThreadRecoveryActionsInput): ThreadRecoveryActionsState {
  const {
    controller, projection, visibleThreadId, selectedModel, latestRun, latestRunModelLabel, previousPrompt,
    writable, submitting, archivedThread, isTaskThread, outcomeUnknown, controlFailureUncertain,
    mountedRef, targetRef, onApplyControl, onClearControlFailure, onBumpListRevision, onReload,
  } = input

  const [resumingThreadId, setResumingThreadId] = useState<string | null>(null)
  const [recoveringRunId, setRecoveringRunId] = useState<string | null>(null)
  const [forceStoppingThreadId, setForceStoppingThreadId] = useState<string | null>(null)
  const [stoppingSubagentId, setStoppingSubagentId] = useState<string | null>(null)
  const [usageLimitActionPending, setUsageLimitActionPending] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const rawRecovery = projection?.usageLimitRecovery ?? null
  const usageLimitRecovery = rawRecovery?.status === 'scheduled' ? rawRecovery : null

  useEffect(() => {
    if (!usageLimitRecovery) return undefined
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [usageLimitRecovery?.resumeAt, usageLimitRecovery?.runId])

  const usageLimitRemainingSeconds = usageLimitRecovery
    ? computeRemainingSeconds(usageLimitRecovery.resumeAt, nowMs)
    : null

  const resumableRunId = deriveResumableRunId(projection)
  const hasHeldQueuedRuns = Boolean(projection?.queuePaused && projection.queuedRuns.length > 0)
  const canResume = Boolean(
    writable && !submitting && !outcomeUnknown && !controlFailureUncertain
    && canResumeThread(projection, resumableRunId)
    && (resumableRunId === null || Boolean(selectedModel)),
  )
  const resumeLabel = resumableRunId !== null ? '继续对话' : '继续排队消息'
  const isResuming = resumingThreadId !== null && resumingThreadId === visibleThreadId
  const isForceStopping = forceStoppingThreadId !== null && forceStoppingThreadId === visibleThreadId

  const failedRunPrompt = latestRun?.status === 'failed' && projection
    ? projection.messages.find(message => message.id === latestRun.userMessageId && message.role === 'user') ?? previousPrompt
    : previousPrompt
  const failedPromptText = failedRunPrompt?.text.trim() ?? ''
  const activeRun = projection?.activeRun
  const hasHandoffHistory = Boolean(
    projection?.runs.some(candidate =>
      Boolean(candidate.startedAt) && !candidate.outcomeUnknown
      && ['completed', 'cancelled', 'interrupted'].includes(candidate.status)),
  )
  const canHandoffFailedRun = Boolean(
    writable && projection && selectedModel && !archivedThread && !isTaskThread && !activeRun
    && !submitting && !outcomeUnknown && !controlFailureUncertain && !projection.relations.parent
    && hasHandoffHistory && !hasHeldQueuedRuns,
  )
  const canRetryFailedRun = Boolean(
    writable && projection && selectedModel && !archivedThread && !activeRun
    && !submitting && !outcomeUnknown && !controlFailureUncertain && Boolean(failedPromptText)
    && (selectedModel.instanceId === projection.thread.modelSelection.instanceId || canHandoffFailedRun),
  )

  const suppressFailedBannerForScheduledRecovery = Boolean(
    usageLimitRecovery && latestRun && usageLimitRecovery.runId === latestRun.id,
  )

  const failedRunIssue = !suppressFailedBannerForScheduledRecovery
    && latestRun && (latestRun.outcomeUnknown || latestRun.status === 'failed')
    ? presentFailedRunIssue({
      modelLabel: latestRunModelLabel || '当前模型',
      failure: latestRun.failure,
      failureClass: latestRun.failureClass,
      outcomeUnknown: latestRun.outcomeUnknown,
      canHandoff: canHandoffFailedRun,
      canRetry: canRetryFailedRun,
    })
    : undefined

  function handleResume(): void {
    if (!canResume || isResuming || !projection) return
    const threadId = projection.thread.id
    setResumingThreadId(threadId)
    const operation = resumableRunId !== null && selectedModel
      ? controller.resume({
        sourceRunId: resumableRunId,
        instanceId: selectedModel.instanceId,
        model: selectedModel.id,
        options: selectedModel.options,
      })
      : controller.resume()
    onApplyControl(operation.finally(() => {
      setResumingThreadId(current => current === threadId ? null : current)
    }))
  }

  function handleForceStop(runId?: string): void {
    if (!writable || isForceStopping || !projection) return
    const threadId = projection.thread.id
    setForceStoppingThreadId(threadId)
    onClearControlFailure()
    onApplyControl(controller.forceStop(runId).then(result => {
      if (result.ok && mountedRef.current && targetRef.current?.threadId === threadId) {
        controller.reload()
      }
      return result
    }).finally(() => {
      setForceStoppingThreadId(current => current === threadId ? null : current)
    }))
  }

  function handleStopSubagent(childThreadId: string, force?: boolean): void {
    if (!writable || stoppingSubagentId || !projection) return
    const originalThread = projection.thread.id
    setStoppingSubagentId(childThreadId)
    onClearControlFailure()
    onApplyControl(controller.stopSubagent(childThreadId, force).then(result => {
      if (result.ok && mountedRef.current && targetRef.current?.threadId === originalThread) {
        controller.reload()
      }
      return result
    }).finally(() => {
      setStoppingSubagentId(current => current === childThreadId ? null : current)
    }))
  }

  function handleCancelUsageLimitRecovery(): void {
    if (!writable || usageLimitActionPending || !projection) return
    const originalThread = projection.thread.id
    setUsageLimitActionPending(true)
    onClearControlFailure()
    onApplyControl(controller.cancelUsageLimitRecovery().then(result => {
      if (result.ok && mountedRef.current && targetRef.current?.threadId === originalThread) {
        controller.reload()
      }
      return result
    }).finally(() => {
      if (mountedRef.current) setUsageLimitActionPending(false)
    }))
  }

  function handleRetryUsageLimitRecoveryNow(): void {
    if (!writable || usageLimitActionPending || !projection) return
    const originalThread = projection.thread.id
    setUsageLimitActionPending(true)
    onClearControlFailure()
    onApplyControl(controller.retryUsageLimitRecoveryNow().then(result => {
      if (result.ok && mountedRef.current && targetRef.current?.threadId === originalThread) {
        controller.reload()
      }
      return result
    }).finally(() => {
      if (mountedRef.current) setUsageLimitActionPending(false)
    }))
  }

  function handleHandoffFailedRun(runId: string): void {
    if (!canHandoffFailedRun || !projection || !selectedModel || recoveringRunId) return
    const originalThread = projection.thread.id
    const text = failedPromptText || '继续'
    setRecoveringRunId(runId)
    onClearControlFailure()
    const operation = controller.apply({
      type: 'thread.handoff',
      commandId: crypto.randomUUID(),
      threadId: originalThread,
      messageId: crypto.randomUUID(),
      text,
      instanceId: selectedModel.instanceId,
      model: selectedModel.id,
      ...(selectedModel.options?.length ? { options: [...selectedModel.options] } : {}),
    })
    onApplyControl(operation.then(result => {
      if (result.ok && mountedRef.current && targetRef.current?.threadId === originalThread) {
        onBumpListRevision()
        controller.reload()
      }
      return result
    }).finally(() => {
      setRecoveringRunId(current => current === runId ? null : current)
    }))
  }

  function handleRetryFailedRun(runId: string): void {
    if (!canRetryFailedRun || !projection || !selectedModel || recoveringRunId) return
    if (selectedModel.instanceId !== projection.thread.modelSelection.instanceId) {
      handleHandoffFailedRun(runId)
      return
    }
    const originalThread = projection.thread.id
    setRecoveringRunId(runId)
    onClearControlFailure()
    const operation = controller.apply({
      type: 'message.dispatch',
      commandId: crypto.randomUUID(),
      threadId: originalThread,
      messageId: crypto.randomUUID(),
      text: failedPromptText,
      instanceId: selectedModel.instanceId,
      model: selectedModel.id,
      ...(selectedModel.options?.length ? { options: [...selectedModel.options] } : {}),
    })
    onApplyControl(operation.then(result => {
      if (result.ok && mountedRef.current && targetRef.current?.threadId === originalThread) {
        controller.reload()
      }
      return result
    }).finally(() => {
      setRecoveringRunId(current => current === runId ? null : current)
    }))
  }

  function handleFailedRunAction(runId: string): void {
    if (!failedRunIssue) return
    if (failedRunIssue.actionKind === 'refresh') {
      onReload()
      return
    }
    if (failedRunIssue.actionKind === 'handoff') {
      handleHandoffFailedRun(runId)
      return
    }
    if (failedRunIssue.actionKind === 'retry') {
      handleRetryFailedRun(runId)
    }
  }

  return {
    resumableRunId,
    hasHeldQueuedRuns,
    canResume,
    resumeLabel,
    isResuming,
    recoveringRunId,
    isForceStopping,
    stoppingSubagentId,
    usageLimitRecovery,
    usageLimitRemainingSeconds,
    usageLimitActionPending,
    failedRunIssue,
    handleResume,
    handleForceStop,
    handleStopSubagent,
    handleCancelUsageLimitRecovery,
    handleRetryUsageLimitRecoveryNow,
    handleFailedRunAction,
  }
}
