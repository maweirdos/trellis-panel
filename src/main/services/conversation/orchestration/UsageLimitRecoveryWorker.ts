import { DaemonError } from '../../../daemon/errors'
import type { ConversationUsageLimitRecovery } from '../../../../shared/conversation/command-runtime'
import type { ConversationFailureClass } from '../../../../shared/conversation/failure-taxonomy'
import type { ConversationProjectionStore } from '../persistence/ProjectionStore'
import type { ConversationEventSink } from './EventSink'
import { lifecycleEvent } from './ThreadCommands'

export const MIN_RECOVERY_DELAY_MS = 1_000
export const MAX_RECOVERY_DELAY_MS = 24 * 60 * 60 * 1000
export const MAX_AUTO_RECOVERY_ATTEMPTS = 3

export interface UsageLimitRecoveryHost<TAuthority> {
  isClosing(): boolean
  assertOwner(): void
  hasActiveTurn(threadId: string): boolean
  isArchived(threadId: string): boolean
  hasBlockingRuntimeRequest(threadId: string): boolean
  dispatchAutoRetry(input: {
    readonly threadId: string
    readonly failedRunId: string
    readonly commandId: string
    readonly authority: TAuthority
  }): void
}

/**
 * 限流自动倒计时恢复调度器（M6）：
 * 当个人会话因 `usage_limit` 且附带冷却等待时间失败时，持久化恢复计划并启动有界定时器；
 * 冷却结束自动重新派发续跑，用户手动停止/改发/取消始终具有最高覆盖优先级。
 */
export class UsageLimitRecoveryWorker<TAuthority> {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly authorities = new Map<string, TAuthority>()

  constructor(
    private readonly projections: ConversationProjectionStore,
    private readonly eventSink: ConversationEventSink,
    private readonly host: UsageLimitRecoveryHost<TAuthority>,
  ) {}

  readScheduled(threadId: string): ConversationUsageLimitRecovery | null {
    return this.projections.readScheduledUsageLimitRecovery(threadId)
  }

  reconcileOnStartup(): void {
    const nowMs = Date.now()
    for (const entry of this.projections.listScheduledUsageLimitRecoveries()) {
      const resumeMs = Date.parse(entry.resumeAt)
      const latestRun = this.projections.readLatestRunRecord(entry.threadId)
      const stale = !Number.isFinite(resumeMs)
        || nowMs - resumeMs > MAX_RECOVERY_DELAY_MS
        || this.host.isArchived(entry.threadId)
        || !latestRun
        || latestRun.run_id !== entry.runId
        || latestRun.status !== 'failed'
      if (stale) {
        this.markCancelled(entry, '重启核对发现限流恢复条件已过期。')
      }
    }
  }

  scheduleOnFailure(input: {
    readonly threadId: string
    readonly runId: string
    readonly failureClass: ConversationFailureClass
    readonly retryAfterMs?: number
    readonly reason?: string
    readonly authority?: TAuthority
    readonly isPersonal: boolean
  }): ConversationUsageLimitRecovery | null {
    if (
      this.host.isClosing()
      || !input.isPersonal
      || input.failureClass !== 'usage_limit'
      || input.retryAfterMs === undefined
      || !Number.isFinite(input.retryAfterMs)
      || this.host.isArchived(input.threadId)
      || this.host.hasBlockingRuntimeRequest(input.threadId)
    ) {
      return null
    }

    const previous = this.projections.readUsageLimitRecovery(input.threadId)
    const attempt = previous?.status === 'triggered' && previous.runId !== input.runId
      ? previous.attempt + 1
      : 1
    if (attempt > MAX_AUTO_RECOVERY_ATTEMPTS) return null

    const delayMs = Math.min(Math.max(Math.round(input.retryAfterMs), MIN_RECOVERY_DELAY_MS), MAX_RECOVERY_DELAY_MS)
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    const recovery: ConversationUsageLimitRecovery = {
      threadId: input.threadId,
      runId: input.runId,
      resumeAt: new Date(nowMs + delayMs).toISOString(),
      retryAfterMs: delayMs,
      attempt,
      maxAttempts: MAX_AUTO_RECOVERY_ATTEMPTS,
      status: 'scheduled',
      ...(input.reason ? { reason: input.reason } : {}),
      updatedAt: now,
    }

    this.clearTimer(input.threadId)
    this.eventSink.commit({
      hostEvents: [lifecycleEvent(input.threadId, { kind: 'usage-limit-recovery', recovery }, input.runId, now)],
    }, () => {
      this.projections.upsertUsageLimitRecovery(recovery)
    })

    if (input.authority) {
      this.authorities.set(input.threadId, input.authority)
      this.armTimer(recovery, delayMs)
    }
    return recovery
  }

  cancel(threadId: string, reason = '用户已取消限流自动恢复。'): ConversationUsageLimitRecovery | null {
    this.clearTimer(threadId)
    this.authorities.delete(threadId)
    const current = this.projections.readScheduledUsageLimitRecovery(threadId)
    if (!current) return null
    return this.markCancelled(current, reason)
  }

  retryNow(threadId: string, authority: TAuthority): { readonly runId: string; readonly commandId: string } {
    const current = this.projections.readScheduledUsageLimitRecovery(threadId)
    if (!current) {
      throw new DaemonError('E_CONFLICT', '当前会话没有待恢复的限流任务。')
    }
    this.clearTimer(threadId)
    this.authorities.delete(threadId)
    const commandId = `ulr:${current.runId}:${current.attempt}`
    this.markTriggered(current)
    this.host.dispatchAutoRetry({
      threadId,
      failedRunId: current.runId,
      commandId,
      authority,
    })
    return { runId: current.runId, commandId }
  }

  shutdown(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.authorities.clear()
  }

  private armTimer(recovery: ConversationUsageLimitRecovery, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(recovery.threadId)
      this.fire(recovery.threadId, recovery.runId, recovery.attempt)
    }, delayMs)
    timer.unref()
    this.timers.set(recovery.threadId, timer)
  }

  private fire(threadId: string, expectedRunId: string, expectedAttempt: number): void {
    if (this.host.isClosing()) return
    try {
      this.host.assertOwner()
    } catch {
      return
    }
    const authority = this.authorities.get(threadId)
    this.authorities.delete(threadId)
    const current = this.projections.readScheduledUsageLimitRecovery(threadId)
    if (!current || current.runId !== expectedRunId || current.attempt !== expectedAttempt) return
    const latestRun = this.projections.readLatestRunRecord(threadId)
    if (
      this.host.hasActiveTurn(threadId)
      || this.host.isArchived(threadId)
      || this.host.hasBlockingRuntimeRequest(threadId)
      || !latestRun
      || latestRun.run_id !== expectedRunId
      || latestRun.status !== 'failed'
    ) {
      this.markCancelled(current, '会话状态已变更，已取消自动限流重试。')
      return
    }
    if (!authority) return
    const commandId = `ulr:${current.runId}:${current.attempt}`
    this.markTriggered(current)
    try {
      this.host.dispatchAutoRetry({
        threadId,
        failedRunId: current.runId,
        commandId,
        authority,
      })
    } catch (error) {
      process.emitWarning(
        `Usage limit recovery retry failed for thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'CRUX_USAGE_LIMIT_RECOVERY' },
      )
    }
  }

  private markTriggered(current: ConversationUsageLimitRecovery): ConversationUsageLimitRecovery {
    const now = new Date().toISOString()
    const next: ConversationUsageLimitRecovery = { ...current, status: 'triggered', updatedAt: now }
    this.eventSink.commit({
      hostEvents: [lifecycleEvent(current.threadId, { kind: 'usage-limit-recovery', recovery: null }, current.runId, now)],
    }, () => {
      this.projections.upsertUsageLimitRecovery(next)
    })
    return next
  }

  private markCancelled(current: ConversationUsageLimitRecovery, reason: string): ConversationUsageLimitRecovery {
    const now = new Date().toISOString()
    const next: ConversationUsageLimitRecovery = { ...current, status: 'cancelled', reason, updatedAt: now }
    this.eventSink.commit({
      hostEvents: [lifecycleEvent(current.threadId, { kind: 'usage-limit-recovery', recovery: null }, current.runId, now)],
    }, () => {
      this.projections.upsertUsageLimitRecovery(next)
    })
    return next
  }

  private clearTimer(threadId: string): void {
    const timer = this.timers.get(threadId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(threadId)
    }
  }
}
