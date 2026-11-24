import { useLayoutEffect, useRef, useState } from 'react'
import type { ConversationThreadCommand } from '../../../shared/conversation/command-runtime'
import type { ConversationTaskLocator } from '../../../shared/conversation/task-scope'
import { conversationThreadSurface, type ConversationThreadSurface } from './conversationRightPanelStore'
import { applyConversationCommand, commandResult, readConversationCommandState, type ConversationApplyResult, type ConversationThreadController } from './useConversationThread'
import type { ComposerModel } from './useComposerSend'

type ForkCommand = Extract<ConversationThreadCommand, { type: 'thread.fork' }>
type FirstMessage = Extract<ConversationThreadCommand, { type: 'message.dispatch' }>
type Failure = Extract<ConversationApplyResult, { ok: false }>

export interface SideChatInput {
  readonly text?: string
  readonly selection?: ForkCommand['selection']
  readonly sourcePoint?: ForkCommand['sourcePoint']
  readonly title?: string
}

export interface CompareModelsInput {
  readonly runId: string
  readonly text: string
  readonly models: readonly ComposerModel[]
}

interface PendingSideChat {
  readonly fork: ForkCommand
  readonly firstMessage?: FirstMessage
  phase: 'fork' | 'first-message'
  inFlight: boolean
  failure?: Failure
  cleanup?: { readonly commandId: string; readonly sendFailure: Failure }
}

const pendingByScope = new Map<string, PendingSideChat>()
const comparisonsByScope = new Map<string, readonly PendingSideChat[]>()

export function closeUnusedSideThread({ root, task, threadId, commandId, check }: {
  readonly root: string
  readonly task?: ConversationTaskLocator
  readonly threadId: string
  readonly commandId: string
  readonly check?: boolean
}): Promise<ConversationApplyResult> {
  return check
    ? readConversationCommandState(root, threadId, commandId, task).then(receipt => commandResult(commandId, receipt, 'reconcile'))
    : applyConversationCommand(root, { type: 'thread.delete', threadId, commandId, onlyIfUnused: true }, task)
}

export function useSideChat({ controller, root, task, threadId, enabled, onOpenRelatedThread }: {
  readonly controller: ConversationThreadController
  readonly root: string
  readonly task?: ConversationTaskLocator
  readonly threadId?: string | null
  readonly enabled: boolean
  readonly onOpenRelatedThread: (tab: ConversationThreadSurface) => void
}) {
  const { scope } = controller
  const activeScope = useRef<string | null>(null)
  const [state, setState] = useState<{ scope: string; pending: boolean; failure?: Failure }>()
  useLayoutEffect(() => {
    activeScope.current = enabled ? scope : null
    return () => { activeScope.current = null }
  }, [enabled, scope])

  async function settle(operation: PendingSideChat, checkReceipt: boolean, publish = true): Promise<boolean> {
    if (operation.inFlight || activeScope.current !== scope) return false
    operation.inFlight = true
    if (publish) setState({ scope, pending: true })
    let failure: Failure | undefined
    try {
      const { fork, firstMessage } = operation
      const child = fork.targetThreadId
      if (operation.cleanup) {
        const cleanup = await closeUnusedSideThread({ root, task, threadId: child, commandId: operation.cleanup.commandId, check: true })
        failure = cleanup.ok || !cleanup.uncertain ? operation.cleanup.sendFailure : cleanup
        if (!cleanup.ok && activeScope.current === scope) onOpenRelatedThread(conversationThreadSurface(child))
        return false
      }
      if (operation.phase === 'fork') {
        const result = checkReceipt ? await controller.checkCommand(fork.commandId) : await controller.apply(fork)
        if (!result.ok) {
          failure = result
          return false
        }
        if (result.receipt.childThreadId !== child) {
          failure = { ok: false, reason: '侧会话身份待核对。', uncertain: true, commandId: fork.commandId, source: result.source }
          return false
        }
        if (!firstMessage || activeScope.current !== scope) {
          if (activeScope.current === scope) {
            onOpenRelatedThread(conversationThreadSurface(child))
            return true
          }
          return false
        }
        operation.phase = 'first-message'
        checkReceipt = false
      }
      if (!firstMessage) return false
      const result = checkReceipt ? commandResult(firstMessage.commandId,
        await readConversationCommandState(root, child, firstMessage.commandId, task), 'reconcile')
        : await applyConversationCommand(root, firstMessage, task)
      if (!result.ok) {
        failure = result
        if (fork.sideChat && !result.uncertain && !result.receipt) {
          const commandId = crypto.randomUUID()
          const cleanup = await closeUnusedSideThread({ root, task, threadId: child, commandId })
          if (!cleanup.ok && cleanup.uncertain) {
            operation.cleanup = { commandId, sendFailure: result }
            failure = cleanup
          }
          if (!cleanup.ok && activeScope.current === scope) onOpenRelatedThread(conversationThreadSurface(child))
        } else if (activeScope.current === scope) {
          onOpenRelatedThread(conversationThreadSurface(child))
        }
        return false
      }
      if (activeScope.current !== scope) return false
      onOpenRelatedThread(conversationThreadSurface(child))
      return true
    } finally {
      operation.inFlight = false
      operation.failure = failure
      if (publish) {
        if (!failure?.uncertain) pendingByScope.delete(scope)
        if (activeScope.current === scope) setState({ scope, pending: false, failure })
      }
    }
  }

  async function open(input: SideChatInput = {}): Promise<boolean> {
    if (!threadId || activeScope.current !== scope || comparisonsByScope.has(scope)) return false
    const text = input.text?.trim() ? input.text : undefined
    const current = controller.active?.projection?.thread.modelSelection
    const selection = input.selection ?? (current && {
      instanceId: current.instanceId, model: current.model,
      ...(current.options?.length && { options: [...current.options] }),
    })
    const pending = pendingByScope.get(scope)
    if (pending) {
      const samePrompt = pending.firstMessage?.text === text && (
        !text || JSON.stringify(pending.fork.selection) === JSON.stringify(selection)
      )
      return await settle(pending, true) && samePrompt
    }
    if (text && !selection) {
      setState({ scope, pending: false, failure: { ok: false, uncertain: false, source: 'apply', reason: '请选择具体模型。' } })
      return false
    }
    const targetThreadId = crypto.randomUUID()
    const fork: ForkCommand = {
      type: 'thread.fork', commandId: crypto.randomUUID(), threadId, targetThreadId,
      sourcePoint: input.sourcePoint ?? { type: 'latest_stable' }, sideChat: !input.sourcePoint || input.sourcePoint.type === 'latest_stable',
      title: input.title ?? (input.sourcePoint?.type === 'run' ? '会话分支' : '侧聊'), ...(selection && { selection }),
    }
    const firstMessage = text && selection ? {
      type: 'message.dispatch' as const, threadId: targetThreadId, commandId: crypto.randomUUID(), messageId: crypto.randomUUID(),
      text, ...selection,
    } : undefined
    const operation: PendingSideChat = { fork, firstMessage, phase: 'fork', inFlight: false }
    pendingByScope.set(scope, operation)
    return settle(operation, false)
  }

  function check(): Promise<boolean> {
    const comparison = comparisonsByScope.get(scope)
    if (comparison) return settleComparison(comparison, true)
    const operation = pendingByScope.get(scope)
    return operation ? settle(operation, true) : Promise.resolve(false)
  }

  async function settleComparison(operations: readonly PendingSideChat[], checkReceipt: boolean): Promise<boolean> {
    if (activeScope.current !== scope || operations.some(operation => operation.inFlight)) return false
    setState({ scope, pending: true })
    const results = await Promise.all(operations.map(operation => settle(operation, checkReceipt, false)))
    const uncertain = operations.filter(operation => operation.failure?.uncertain)
    if (uncertain.length) comparisonsByScope.set(scope, uncertain)
    else comparisonsByScope.delete(scope)
    if (activeScope.current === scope) setState({ scope, pending: false,
      failure: uncertain[0]?.failure ?? operations.find(operation => operation.failure)?.failure })
    return results.every(Boolean)
  }

  function compare({ runId, text, models }: CompareModelsInput): Promise<boolean> {
    if (!threadId || !text.trim() || activeScope.current !== scope || pendingByScope.has(scope)) return Promise.resolve(false)
    const prior = comparisonsByScope.get(scope)
    if (prior) return settleComparison(prior, true)
    const unique = [...new Map(models.map(model => [JSON.stringify([model.instanceId, model.id]), model])).values()]
    if (unique.length < 2 || unique.length > 4) return Promise.resolve(false)
    const operations = unique.map((model): PendingSideChat => {
      const targetThreadId = crypto.randomUUID()
      const selection = { instanceId: model.instanceId, model: model.id,
        ...(model.options?.length && { options: [...model.options] }) }
      const fork: ForkCommand = {
        type: 'thread.fork', threadId, targetThreadId, commandId: crypto.randomUUID(), readOnly: true,
        sourcePoint: { type: 'run', runId }, title: [...model.displayName].slice(0, 160).join('').trim() || '只读比较', selection,
      }
      const firstMessage: FirstMessage = {
        type: 'message.dispatch', threadId: targetThreadId, commandId: crypto.randomUUID(), messageId: crypto.randomUUID(), text, ...selection,
      }
      return { fork, firstMessage, phase: 'fork', inFlight: false }
    })
    comparisonsByScope.set(scope, operations)
    return settleComparison(operations, false)
  }

  const retained = pendingByScope.get(scope) ?? comparisonsByScope.get(scope)?.[0]
  return { open, check, compare, pending: state?.scope === scope && state.pending,
    failure: state?.scope === scope ? state.failure : retained?.failure }
}
