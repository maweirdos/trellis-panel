import { randomUUID } from 'node:crypto'
import * as Schema from 'effect/Schema'
import { DaemonError } from '../../../daemon/errors'
import { OrchestrationV2DomainEventJson } from '../../../../shared/conversation/contracts'
import type { ConversationAuthority, ConversationCommandState } from '../../../../shared/conversation/desktop'
import type { ConversationThreadCommand, ConversationThreadCommandState } from '../../../../shared/conversation/command-runtime'
import type { ConversationDriverSession, ConversationDriverTurnEvent } from '../providers/registry'
import type { ConversationProjectionStore } from '../persistence/ProjectionStore'
import { ConversationEffectWorker, runBounded, type DispatchAttempt } from './EffectWorker'
import type { ConversationEventSink } from './EventSink'
import type { ProviderSessionManager } from './ProviderSessionManager'
import type { RuntimeRequestService } from './RuntimeRequestService'
import { lifecycleEvent, type ThreadCommands, type ThreadEffectRow } from './ThreadCommands'
import type { ThreadRelations } from './ThreadRelations'

const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)

export interface ControlledTurn {
  readonly row: ThreadEffectRow
  readonly runId: string
  readonly ordinal: number
  readonly attemptId: string
  readonly driver: ConversationDriverSession
  readonly nativeThreadId: string
  readonly authority: ConversationAuthority
  readonly writerSlot?: string
  signalControlTurn?: (turnId?: string) => void
  backgroundTimeout?: ReturnType<typeof setTimeout>
  terminal?: Extract<ConversationDriverTurnEvent, { type: 'turn-completed' }>
}

export interface ProviderTurnControlHost<
  TTurn extends ControlledTurn,
  TAuthority extends ConversationAuthority,
> {
  readonly deadlines: { readonly control: number }
  readonly shutdownSignal: AbortSignal
  readonly sessions: ProviderSessionManager
  readonly projections: ConversationProjectionStore
  readonly commands: ThreadCommands
  readonly relations: ThreadRelations
  readonly worker: ConversationEffectWorker
  readonly runtimeRequests: RuntimeRequestService<TTurn>
  readonly eventSink: ConversationEventSink
  assertOwner(): void
  isClosing(): boolean
  getActiveTurn(threadId: string): TTurn | undefined
  listActiveTurns(): IterableIterator<TTurn>
  deleteActiveTurn(threadId: string): void
  clearAuthorization(commandId: string): void
  abortWorktreePreparation(threadId: string): void
  cancelUsageLimitRecovery(threadId: string, reason?: string): void
  acceptInterrupt(
    command: Extract<ConversationThreadCommand, { type: 'run.interrupt' }>,
    authority: TAuthority,
    turn?: TTurn,
  ): ConversationThreadCommandState
  settleOutcome(
    row: ThreadEffectRow,
    threadId: string,
    runId: string,
    status: string,
    detail: string | undefined,
    outboxStatus: 'succeeded' | 'failed' | 'cancelled',
    settled: string,
    turn?: TTurn,
  ): void
  cancelPendingRun(input: {
    readonly threadId: string
    readonly runId: string
    readonly effect: ThreadEffectRow
    readonly occurredAt: string
    readonly reason: string
  }): void
  retireWorktreeWriter(slot?: string, turn?: TTurn): Promise<void>
  scheduleNext(threadId: string, authority: TAuthority): void
}

/**
 * 负责回合高阶强制止损（`thread.stop`）与单个委派子代理精准停止（`subagent.stop`），
 * 解决底层驱动忽略常规 interrupt 时对话永久卡在 running 的死锁问题。
 */
export class ProviderTurnControlService<
  TTurn extends ControlledTurn,
  TAuthority extends ConversationAuthority,
> {
  constructor(private readonly host: ProviderTurnControlHost<TTurn, TAuthority>) {}

  async forceStopThread(
    command: Extract<ConversationThreadCommand, { type: 'thread.stop' }>,
    authority: TAuthority,
  ): Promise<ConversationThreadCommandState> {
    this.host.assertOwner()
    const { threadId } = command
    const now = new Date().toISOString()
    this.host.cancelUsageLimitRecovery(threadId, '用户已强制停止当前会话。')

    const active = this.host.getActiveTurn(threadId)
    if (active && (!command.runId || active.runId === command.runId)) {
      return this.forceStopActiveTurn(command, authority, active, now)
    }

    const pendingRow = this.findPendingStartEffect(threadId, command.runId)
    if (pendingRow) {
      const targetRunId = command.runId ?? this.host.worker.runId(pendingRow)
      if (targetRunId) {
        this.host.abortWorktreePreparation(threadId)
        this.host.cancelPendingRun({
          threadId,
          runId: targetRunId,
          effect: pendingRow,
          occurredAt: now,
          reason: '已强制取消待派发回合。',
        })
        this.host.clearAuthorization(pendingRow.command_id)
        return this.host.commands.commit(command, authority, {
          target: { run_id: targetRunId, detail: '已强制取消待派发回合。' },
          hostEvents: [lifecycleEvent(threadId, { kind: 'run', phase: 'settled' }, targetRunId, now)],
          apply: () => {},
        })
      }
    }

    const targetRun = command.runId
      ? this.host.commands.run(threadId, command.runId)
      : this.host.projections.readLatestRunRecord(threadId)
    if (targetRun && ['preparing', 'starting', 'running', 'waiting'].includes(targetRun.status)) {
      const fallbackDetail = '已强制结束孤立活动回合，请核对后继续。'
      const effect = this.host.commands.effectForRun(threadId, targetRun.run_id)
      const parsed = JSON.parse(targetRun.payload_json) as Record<string, unknown>
      const cancelledPayload = { ...parsed, status: 'cancelled', completedAt: now, failure: fallbackDetail }
      return this.host.commands.commit(command, authority, {
        target: { run_id: targetRun.run_id, detail: fallbackDetail },
        events: [decodeEvent({
          type: 'run.updated',
          id: randomUUID(),
          threadId,
          runId: targetRun.run_id,
          occurredAt: now,
          payload: cancelledPayload,
        })],
        hostEvents: [lifecycleEvent(threadId, { kind: 'run', phase: 'settled' }, targetRun.run_id, now)],
        apply: () => {
          this.host.projections.settleRunProjection(threadId, targetRun.run_id, 'cancelled', now, cancelledPayload)
          if (effect && this.host.worker.isOwned(effect)) {
            this.host.worker.releaseClaim(effect, now, 'cancelled', fallbackDetail)
          }
        },
      })
    }

    return this.host.commands.commit(command, authority, {
      target: { run_id: command.runId ?? targetRun?.run_id ?? null, detail: '当前没有可强制停止的活动回合。' },
      hostEvents: [lifecycleEvent(threadId, { kind: 'run', phase: 'settled' }, command.runId ?? targetRun?.run_id, now)],
      apply: () => {},
    })
  }

  private async forceStopActiveTurn(
    command: Extract<ConversationThreadCommand, { type: 'thread.stop' }>,
    authority: TAuthority,
    turn: TTurn,
    now: string,
  ): Promise<ConversationThreadCommandState> {
    const { threadId } = command
    const { row, runId, driver } = turn

    if (turn.backgroundTimeout) clearTimeout(turn.backgroundTimeout)
    turn.signalControlTurn?.()
    this.host.abortWorktreePreparation(threadId)

    // 先从活动表中移除，使后续 closeOwned 与 drainOne 清理检查不再把当前驱动视作仍在执行此回合。
    this.host.deleteActiveTurn(threadId)

    const hasOtherActiveTurnOnDriver = [...this.host.listActiveTurns()].some(
      other => other !== turn && other.row.thread_id !== threadId && other.driver === driver,
    )

    let detail: string
    if (hasOtherActiveTurnOnDriver) {
      // 多会话共享同一引擎进程时，不可强杀进程以免误伤其他并行线程，改为温和解绑当前线程句柄。
      if (driver.detachThread) {
        await runBounded(
          driver.detachThread({ nativeThreadId: turn.nativeThreadId, assertCurrent: () => undefined }),
          Math.min(this.host.deadlines.control, 2_500),
          '解绑强制停止会话',
          this.host.shutdownSignal,
        ).catch(() => undefined)
      }
      this.host.sessions.loadedThreads.delete(threadId)
      detail = '已强制结束当前回合（底层引擎进程与其他运行中会话共享，未关闭进程）。'
    } else {
      const slotEntry = [...this.host.sessions.processes.entries()].find(([, slot]) => slot.driver === driver)
      if (slotEntry) {
        const [slotKey, owned] = slotEntry
        try {
          await this.host.sessions.closeOwned(slotKey, owned)
        } catch {
          this.host.sessions.uncertainDrivers.add(driver)
          this.host.sessions.loadedThreads.delete(threadId)
        }
      } else {
        this.host.sessions.loadedThreads.delete(threadId)
      }
      detail = '已强制停止当前回合。'
    }

    const hasQueuedRuns = this.host.projections.hasQueuedRuns(threadId)
    const expiredRequests = this.host.runtimeRequests.expiringRequests(turn)
    this.host.runtimeRequests.clearRequestBindings(turn)
    this.host.clearAuthorization(row.command_id)

    if (this.host.worker.isOwned(row)) {
      this.host.settleOutcome(row, threadId, runId, 'cancelled', detail, 'cancelled', now, turn)
    }

    const receipt = this.host.commands.commit(command, authority, {
      target: { run_id: runId, detail },
      hostEvents: [
        ...(hasQueuedRuns ? [lifecycleEvent(threadId, { kind: 'queue', paused: true }, runId, now)] : []),
        ...expiredRequests.map(request => lifecycleEvent(threadId, { kind: 'request', request }, runId, now)),
        lifecycleEvent(threadId, { kind: 'run', phase: 'settled' }, runId, now),
      ],
      apply: () => {
        if (hasQueuedRuns) this.host.commands.setPaused(threadId, true)
        for (const request of expiredRequests) this.host.commands.writeRequest(threadId, request, null)
      },
    })

    if (turn.writerSlot) {
      await this.host.retireWorktreeWriter(turn.writerSlot, turn).catch(() => undefined)
    }
    return receipt
  }

  async stopSubagent(
    command: Extract<ConversationThreadCommand, { type: 'subagent.stop' }>,
    authority: TAuthority,
  ): Promise<ConversationThreadCommandState> {
    this.host.assertOwner()
    const { threadId, childThreadId } = command
    const relation = this.host.relations.read(threadId).children.find(
      child => child.kind === 'delegated' && child.childThreadId === childThreadId,
    )
    if (!relation || !relation.childThreadId || !this.host.commands.hasThread(childThreadId, authority)) {
      throw new DaemonError('E_CONFLICT', '找不到属于当前会话的委派子代理。')
    }

    const childTurn = this.host.getActiveTurn(childThreadId)
    const childCommandId = `subagent-stop:${command.commandId}`
    let detail = '已请求停止子代理。'

    if (childTurn) {
      const attempt: DispatchAttempt | undefined = this.host.worker.attempt(childTurn.row.effect_id)
      const shouldForce = Boolean(command.force) || attempt?.stop_requested === 1
      if (shouldForce) {
        await this.forceStopActiveTurn(
          { type: 'thread.stop', commandId: childCommandId, threadId: childThreadId, runId: childTurn.runId },
          authority,
          childTurn,
          new Date().toISOString(),
        )
        detail = '已强制停止子代理。'
      } else {
        this.host.acceptInterrupt(
          { type: 'run.interrupt', commandId: childCommandId, threadId: childThreadId, runId: childTurn.runId },
          authority,
          childTurn,
        )
      }
    } else if (relation.childRunId) {
      const pendingEffect = this.findPendingStartEffect(childThreadId, relation.childRunId)
      if (pendingEffect) {
        this.host.abortWorktreePreparation(childThreadId)
        this.host.cancelPendingRun({
          threadId: childThreadId,
          runId: relation.childRunId,
          effect: pendingEffect,
          occurredAt: new Date().toISOString(),
          reason: '父会话已停止该子代理。',
        })
        this.host.clearAuthorization(pendingEffect.command_id)
        detail = '已取消待执行的子代理任务。'
      } else {
        const childRun = this.host.commands.run(childThreadId, relation.childRunId)
        if (childRun && ['preparing', 'starting', 'running', 'waiting'].includes(childRun.status)) {
          await this.forceStopThread(
            { type: 'thread.stop', commandId: childCommandId, threadId: childThreadId, runId: relation.childRunId },
            authority,
          )
          detail = '已强制停止子代理。'
        } else {
          detail = '子代理已结束。'
        }
      }
    }

    return this.host.commands.commit(command, authority, {
      target: { run_id: relation.childRunId ?? null, detail },
      hostEvents: [lifecycleEvent(threadId, { kind: 'relation', relation }, relation.parentRunId)],
      apply: () => {},
    })
  }

  private findPendingStartEffect(threadId: string, runId?: string): ThreadEffectRow | undefined {
    if (runId) {
      const row = this.host.commands.effectForRun(threadId, runId)
      return row?.status === 'pending' ? row : undefined
    }
    const row = this.host.projections.readLatestRunRecord(threadId)
    if (!row || !['queued', 'preparing'].includes(row.status)) return undefined
    const effect = this.host.commands.effectForRun(threadId, row.run_id)
    return effect?.status === 'pending' ? effect : undefined
  }
}
