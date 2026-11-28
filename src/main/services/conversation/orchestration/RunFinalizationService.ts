import type { ConversationFailureClass } from '../../../../shared/conversation/failure-taxonomy'
import type { ThreadRelations } from './ThreadRelations'
import type { UsageLimitRecoveryWorker } from './UsageLimitRecoveryWorker'

export interface TurnFinalizationDelegationHost<TTurn> {
  hasDelegatedCompletionSource(turn: TTurn): boolean
  registerDelegatedCompletionParent(threadId: string, turn: TTurn): void
  offerDelegatedCompletionDelivery(threadId: string, parentRunId?: string): void
}

export interface TurnFinalizedInput<TTurn, TAuthority> {
  readonly turn?: TTurn
  readonly threadId: string
  readonly runId: string
  readonly status: string
  readonly detail?: string
  readonly failureClass?: ConversationFailureClass
  readonly retryAfterMs?: number
  readonly authority?: TAuthority
  readonly isPersonal: boolean
  readonly delegated?: ReturnType<ThreadRelations['delegatedParent']>
}

/**
 * M5 回合终态统一收尾服务：
 * 集中编排限流恢复计划入队、委派子代理完成通知递送，以及后续阶段扩展的后置钩子（如结束检查点、自动标题）。
 */
export class RunFinalizationService<
  TTurn extends { readonly completion?: unknown },
  TAuthority,
> {
  constructor(
    private readonly relations: ThreadRelations,
    private readonly usageLimitRecovery: UsageLimitRecoveryWorker<TAuthority>,
    private readonly delegationHost: TurnFinalizationDelegationHost<TTurn>,
    private readonly onIdleCompactionCheck?: (threadId: string, authority: TAuthority) => void,
    private readonly onFirstTurnSettled?: (threadId: string) => void,
  ) {}

  onTurnSettled(input: TurnFinalizedInput<TTurn, TAuthority>): void {
    if (input.status === 'failed' && input.failureClass === 'usage_limit' && input.retryAfterMs !== undefined) {
      this.usageLimitRecovery.scheduleOnFailure({
        threadId: input.threadId,
        runId: input.runId,
        failureClass: input.failureClass,
        retryAfterMs: input.retryAfterMs,
        reason: input.detail,
        authority: input.authority,
        isPersonal: input.isPersonal && !this.relations.restrictedParent(input.threadId),
      })
    }

    if (input.status === 'completed' && input.isPersonal && input.authority && !this.relations.restrictedParent(input.threadId)) {
      this.onIdleCompactionCheck?.(input.threadId, input.authority)
    }

    if (input.status === 'completed' && input.isPersonal && !this.relations.restrictedParent(input.threadId) && this.onFirstTurnSettled) {
      const hook = this.onFirstTurnSettled
      queueMicrotask(() => {
        try {
          hook(input.threadId)
        } catch {
          // 自动标题提炼失败不影响主会话完成态
        }
      })
    }

    if (
      input.turn
      && !input.turn.completion
      && input.status === 'completed'
      && this.delegationHost.hasDelegatedCompletionSource(input.turn)
      && this.relations.read(input.threadId).children.some(child => child.parentRunId === input.runId && child.completionWake)
    ) {
      this.delegationHost.registerDelegatedCompletionParent(input.threadId, input.turn)
      this.delegationHost.offerDelegatedCompletionDelivery(input.threadId, input.runId)
    }

    if (input.delegated?.childRunId === input.runId) {
      this.delegationHost.offerDelegatedCompletionDelivery(input.delegated.parentThreadId, input.delegated.parentRunId)
    }
  }
}
