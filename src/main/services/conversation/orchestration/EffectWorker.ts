import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import * as Effect from 'effect/Effect'
import { DaemonError } from '../../../daemon/errors'
import type { ConversationRunEvidence } from '../../../../shared/conversation/desktop'
import type {
  ConversationLifecycleEvent,
  ConversationNativeTerminalEvidence,
  ConversationProjectedWorkItem,
  ConversationRuntimeRequest,
} from '../../../../shared/conversation/command-runtime'
import * as Schema from 'effect/Schema'
import { OrchestrationV2DomainEventJson, type OrchestrationV2DomainEvent } from '../../../../shared/conversation/contracts'
import { parseArtifactsSlashCommand } from '../../open-artifact/intent'
import type { ConversationEventSink } from './EventSink'
import { lifecycleEvent, type ThreadEffectRow } from './ThreadCommands'
import {
  RESTART_CONTINUATION_EFFECT_TYPE,
  cancelledWorkFromTurnItem,
  hasBlockingRuntimeRequestForRun,
  mergeRestartCancelledBackgroundWork,
  parseRestartContinuationPayload,
  restartContinuationEffectId,
  restartPrepareCommandId,
  serverRecoveryNoticeItemId,
  type RestartCancelledWork,
  type RestartContinuationEffectPayload,
} from './RestartContinuation'

export interface DispatchAttempt {
  readonly attempt_id: string
  readonly phase: 'preparing' | 'dispatching' | 'unknown' | 'settled'
  readonly provider_thread_id: string | null
  readonly native_turn_id: string | null
  readonly stop_requested: number
  readonly foreground_ended: number
  readonly background_running: number
}

export interface RecoveryReconcileOptions {
  readonly continueAfterRestart?: boolean
}

export interface PrepareShutdownOptions {
  readonly continueAfterRestart: boolean
  readonly activeArtifactThreads?: ReadonlySet<string>
}

export class ConversationDeadlineError extends Error {}

export async function awaitDeadline<Result>(operation: Promise<Result>, milliseconds: number, name: string): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ConversationDeadlineError(`引擎操作超时：${name}`)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runBounded<Result>(operation: Effect.Effect<Result, Error>, milliseconds: number, name: string, parentSignal?: AbortSignal): Promise<Result> {
  const controller = new AbortController()
  if (parentSignal?.aborted) throw parentSignal.reason
  const abort = () => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', abort, { once: true })
  try {
    return await awaitDeadline(Effect.runPromise(operation, { signal: controller.signal }), milliseconds, name)
  } catch (error) {
    if (error instanceof ConversationDeadlineError) controller.abort(error)
    throw error
  } finally {
    parentSignal?.removeEventListener('abort', abort)
  }
}

const LEGACY_UNKNOWN_RECOVERY_DETAILS = new Set([
  '引擎派发或本地结算结果待核对。',
  '原运行的引擎结果待按原命令核对。',
])
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)

interface RecoveryEffectRow extends ThreadEffectRow {
  readonly effect_type: string
  readonly phase: DispatchAttempt['phase'] | null
  readonly attempt_id: string | null
  readonly provider_thread_id: string | null
  readonly native_turn_id: string | null
  readonly stop_requested: number | null
  readonly terminal_status: string | null
}

export class ConversationEffectWorker {
  private readonly ownerId = `crux-${process.pid}-${randomUUID()}`

  constructor(private readonly database: DatabaseSync, private readonly sink: ConversationEventSink) {}

  attempt(effectId: string): DispatchAttempt | undefined {
    return this.database.prepare('SELECT * FROM conversation_v2_dispatch_attempts WHERE effect_id = ?').get(effectId) as DispatchAttempt | undefined
  }

  /**
   * 对齐 t3code ProviderRuntimeRecoveryService.prepareForShutdown：
   * 在关闭底层引擎进程前，将符合条件的活跃回合续接意图持久化到 outbox（processLossCount = 0），
   * 使正常退出/升级不消耗异常崩溃续接预算。
   */
  prepareForShutdown(options: PrepareShutdownOptions): number {
    if (!options.continueAfterRestart) return 0
    const occurredAt = new Date().toISOString()
    const running = this.database.prepare(`SELECT effect.*, attempt.attempt_id, attempt.phase, attempt.provider_thread_id,
      attempt.native_turn_id, attempt.stop_requested, terminal.status AS terminal_status
      FROM conversation_v2_effect_outbox effect
      LEFT JOIN conversation_v2_dispatch_attempts attempt ON attempt.effect_id = effect.effect_id
      LEFT JOIN conversation_v2_native_terminal_evidence terminal ON terminal.effect_id = effect.effect_id
      WHERE effect.effect_type = 'provider-turn.start' AND effect.status = 'running'`).all() as unknown as RecoveryEffectRow[]
    let prepared = 0
    for (const row of running) {
      const runId = this.runId(row)
      if (!runId) continue
      if (!this.isEligibleForShutdownContinuation(row, runId)) continue
      const artifactEnabled = options.activeArtifactThreads?.has(row.thread_id) || this.threadUsedArtifacts(row.thread_id)
      const payload: RestartContinuationEffectPayload = {
        sourceRunId: runId,
        processLossCount: 0,
        ...(artifactEnabled ? { artifactEnabled: true } : {}),
      }
      const inserted = this.database.prepare(`INSERT OR IGNORE INTO conversation_v2_effect_outbox
        (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(
          restartContinuationEffectId(runId),
          restartPrepareCommandId(runId),
          row.thread_id,
          RESTART_CONTINUATION_EFFECT_TYPE,
          JSON.stringify(payload),
          occurredAt,
          occurredAt,
          occurredAt,
        )
      if (inserted.changes === 1) prepared += 1
    }
    return prepared
  }

  recover(options?: RecoveryReconcileOptions): void {
    this.reconcile('startup', options)
  }

  /**
   * 对齐 t3code ProviderRuntimeRecoveryService.reconcile：
   * - 保留跨进程可重放的 `provider-runtime.continue` 续接意图；
   * - 退休与旧进程绑定的控制类 effect；
   * - 将未送达引擎的回合回退到 held queue 保留用户输入；
   * - 将已在引擎运行/输出中的回合干净结算为 `cancelled`、结束 streaming、写轻量 `system_notice`，
   *   不打 `outcomeUnknown` 告警也不锁死对话队列；
   * - 崩溃/强杀在 startup 时自动兜底写入 `provider-runtime.continue`（累加 processLossCount）。
   */
  reconcile(trigger: 'startup' | 'shutdown', options: RecoveryReconcileOptions = {}): void {
    const continueAfterRestart = options.continueAfterRestart ?? true
    const occurredAt = new Date().toISOString()
    const detail = trigger === 'startup'
      ? 'Crux 在此回合完成前已重启，已保留当前进度。'
      : 'Crux 在此回合完成前已退出，已保留当前进度。'
    const noticeTitle = trigger === 'startup' ? 'Crux 已重启' : 'Crux 已退出'

    const unsettled = this.database.prepare(`SELECT effect.*, attempt.attempt_id, attempt.phase, attempt.provider_thread_id,
      attempt.native_turn_id, attempt.stop_requested, terminal.status AS terminal_status
      FROM conversation_v2_effect_outbox effect
      LEFT JOIN conversation_v2_dispatch_attempts attempt ON attempt.effect_id = effect.effect_id
      LEFT JOIN conversation_v2_native_terminal_evidence terminal ON terminal.effect_id = effect.effect_id
      WHERE effect.status IN ('pending', 'running')`).all() as unknown as RecoveryEffectRow[]

    const continuationRunning = unsettled.filter(row =>
      row.effect_type === RESTART_CONTINUATION_EFFECT_TYPE && row.status === 'running')
    const controlEffects = unsettled.filter(row =>
      row.effect_type !== 'provider-turn.start' && row.effect_type !== RESTART_CONTINUATION_EFFECT_TYPE)
    const runningStarts = unsettled.filter(row =>
      row.effect_type === 'provider-turn.start' && row.status === 'running')

    const stoppedStarts: RecoveryEffectRow[] = []
    const unacceptedStarts: RecoveryEffectRow[] = []
    const interruptedStarts: Array<{ readonly row: RecoveryEffectRow; readonly runId: string; readonly legacyUnknown: boolean }> = []

    for (const row of runningStarts) {
      const runId = this.runId(row)
      if (!runId) {
        controlEffects.push(row)
        continue
      }
      if (row.stop_requested === 1) {
        stoppedStarts.push(row)
        continue
      }
      const isLegacyUnknown = row.phase === 'unknown'
        && row.terminal_status === null
        && row.last_error !== null
        && LEGACY_UNKNOWN_RECOVERY_DETAILS.has(row.last_error)
      if (row.phase === 'unknown' && !isLegacyUnknown) {
        // 保留具有真实终态证据或非退出故障导致的待核对记录，不掩盖本地结算故障。
        continue
      }
      const acceptedByEngine = this.wasAcceptedByEngine(row, runId)
      if (!isLegacyUnknown && (row.phase === 'preparing' || (row.phase === 'dispatching' && !acceptedByEngine))) {
        unacceptedStarts.push(row)
      } else {
        interruptedStarts.push({ row, runId, legacyUnknown: isLegacyUnknown })
      }
    }

    const requestRows = this.database.prepare(`SELECT thread_id, payload_json FROM conversation_v2_projection_runtime_requests
      WHERE status IN ('pending', 'responding')`).all() as Array<{ thread_id: string; payload_json: string }>
    const updatedRequests: Array<{ readonly threadId: string; readonly request: ConversationRuntimeRequest; readonly blocksContinuation: boolean }> = []
    for (const entry of requestRows) {
      const request = JSON.parse(entry.payload_json) as ConversationRuntimeRequest
      if (request.status === 'pending' && request.payload.kind === 'user-input' && request.payload.responseMode === 'message') {
        continue
      }
      // 对齐 t3code：进程丢失后，实时提问转为消息模式保留可回答；审批与响应中的请求标为已过期。
      if (request.status === 'pending' && request.payload.kind === 'user-input' && request.payload.questions.length > 0) {
        updatedRequests.push({
          threadId: entry.thread_id,
          request: {
            ...request,
            payload: { ...request.payload, responseMode: 'message' },
          },
          blocksContinuation: true,
        })
      } else {
        updatedRequests.push({
          threadId: entry.thread_id,
          request: { ...request, status: 'expired' },
          blocksContinuation: true,
        })
      }
    }

    const stalePausedThreadIds = trigger === 'startup'
      ? (this.database.prepare(`SELECT control.thread_id FROM conversation_v2_thread_control control
          WHERE control.paused = 1
            AND NOT EXISTS (
              SELECT 1 FROM conversation_v2_projection_runs run
              WHERE run.thread_id = control.thread_id AND run.status = 'queued'
            )
            AND NOT EXISTS (
              SELECT 1 FROM conversation_v2_effect_outbox effect
              JOIN conversation_v2_dispatch_attempts attempt ON attempt.effect_id = effect.effect_id
              WHERE effect.thread_id = control.thread_id AND effect.status = 'running' AND attempt.phase = 'unknown'
            )`).all() as Array<{ thread_id: string }>).map(row => row.thread_id)
      : []

    if (
      continuationRunning.length === 0
      && controlEffects.length === 0
      && stoppedStarts.length === 0
      && unacceptedStarts.length === 0
      && interruptedStarts.length === 0
      && updatedRequests.length === 0
      && stalePausedThreadIds.length === 0
    ) return

    const events: OrchestrationV2DomainEvent[] = []
    const hostEvents: ConversationLifecycleEvent[] = []
    const runUpdates: Array<{ readonly threadId: string; readonly runId: string; readonly status: string; readonly completedAt: string | null; readonly payloadJson: string }> = []
    const stopStreamingRunIds = new Set<string>()
    const cancelledWorkItems: Array<{ readonly itemId: string; readonly payloadJson: string; readonly updatedAt: string }> = []
    const insertedNotices: Array<{
      readonly id: string
      readonly threadId: string
      readonly runId: string
      readonly ordinal: number
      readonly payloadJson: string
    }> = []
    const pauseThreadIds = new Set<string>()
    const unpauseThreadIds = new Set<string>()
    const continuationEffects: Array<{ readonly effectId: string; readonly commandId: string; readonly threadId: string; readonly payloadJson: string }> = []

    const isPausedStmt = this.database.prepare('SELECT paused FROM conversation_v2_thread_control WHERE thread_id = ?')
    const isThreadPaused = (threadId: string): boolean => (isPausedStmt.get(threadId) as { paused: number } | undefined)?.paused === 1
    const nextOrdinalByThread = new Map<string, number>()
    const allocateOrdinal = (threadId: string): number => {
      let next = nextOrdinalByThread.get(threadId)
      if (next === undefined) {
        next = (this.database.prepare('SELECT COALESCE(MAX(ordinal) + 1, 0) AS ordinal FROM conversation_v2_projection_turn_items WHERE thread_id = ?')
          .get(threadId) as { ordinal: number }).ordinal
      }
      nextOrdinalByThread.set(threadId, next + 1)
      return next
    }

    // 1. 进程绑定控制类 effect：如果是未送达的 steer，同步取消其对应的 run。
    for (const row of controlEffects) {
      if (row.effect_type !== 'provider-turn.steer') continue
      const runId = this.runId(row)
      if (!runId) continue
      const runRow = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_runs WHERE run_id = ? AND thread_id = ?')
        .get(runId, row.thread_id) as { payload_json: string } | undefined
      if (!runRow) continue
      const raw = JSON.parse(runRow.payload_json) as Record<string, unknown>
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(String(raw.status))) continue
      const nextPayload = {
        ...raw,
        status: 'cancelled',
        completedAt: occurredAt,
        outcomeUnknown: undefined,
        outcomeUnknownAt: undefined,
        failure: undefined,
      }
      runUpdates.push({ threadId: row.thread_id, runId, status: 'cancelled', completedAt: occurredAt, payloadJson: JSON.stringify(nextPayload) })
      events.push(decodeEvent({ id: randomUUID(), threadId: row.thread_id, runId, occurredAt, type: 'run.updated', payload: nextPayload }))
    }

    // 2. 用户已主动停止的回合：结算为 cancelled，停止流式与活跃工具，不续接。
    for (const row of stoppedStarts) {
      const runId = this.runId(row)
      if (!runId) continue
      this.planCancelledRun({
        threadId: row.thread_id,
        runId,
        occurredAt,
        addNotice: false,
        noticeTitle,
        noticeMessage: detail,
        allocateOrdinal,
        events,
        hostEvents,
        runUpdates,
        stopStreamingRunIds,
        cancelledWorkItems,
        insertedNotices,
      })
    }

    // 3. 尚未送达引擎的回合：回退到 queued + queueHeld（held queue），不丢用户输入。
    for (const row of unacceptedStarts) {
      const runId = this.runId(row)
      if (!runId) continue
      const runRow = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_runs WHERE run_id = ? AND thread_id = ?')
        .get(runId, row.thread_id) as { payload_json: string } | undefined
      if (runRow) {
        const raw = JSON.parse(runRow.payload_json) as Record<string, unknown>
        const nextPayload = {
          ...raw,
          status: 'queued',
          startedAt: null,
          completedAt: null,
          queueHeld: true,
          outcomeUnknown: undefined,
          outcomeUnknownAt: undefined,
          failure: undefined,
        }
        runUpdates.push({ threadId: row.thread_id, runId, status: 'queued', completedAt: null, payloadJson: JSON.stringify(nextPayload) })
        events.push(decodeEvent({ id: randomUUID(), threadId: row.thread_id, runId, occurredAt, type: 'run.updated', payload: nextPayload }))
      }
      if (!isThreadPaused(row.thread_id)) pauseThreadIds.add(row.thread_id)
    }

    // 4. 已在引擎执行/输出中的回合：按 t3code 干净结算为 cancelled + system_notice + 必要时写入续接意图。
    const blockedRunIds = new Set(updatedRequests.filter(item => item.blocksContinuation).map(item => item.request.runId))
    for (const { row, runId, legacyUnknown } of interruptedStarts) {
      const cancelledWork = this.planCancelledRun({
        threadId: row.thread_id,
        runId,
        occurredAt,
        addNotice: true,
        noticeTitle,
        noticeMessage: detail,
        allocateOrdinal,
        events,
        hostEvents,
        runUpdates,
        stopStreamingRunIds,
        cancelledWorkItems,
        insertedNotices,
      })
      if (legacyUnknown && isThreadPaused(row.thread_id) && !pauseThreadIds.has(row.thread_id)) {
        unpauseThreadIds.add(row.thread_id)
      }
      // 仅在 startup（异常崩溃/强杀未走 prepareForShutdown）且非旧版坏记录迁移时兜底写入续接意图。
      if (
        trigger === 'startup'
        && continueAfterRestart
        && !legacyUnknown
        && !blockedRunIds.has(runId)
        && this.isEligibleForStartupContinuation(row, runId)
      ) {
        const processLossCount = this.nextProcessLossCount(row.thread_id, runId)
        const artifactEnabled = this.threadUsedArtifacts(row.thread_id)
        const payload: RestartContinuationEffectPayload = {
          sourceRunId: runId,
          processLossCount,
          ...(artifactEnabled ? { artifactEnabled: true } : {}),
        }
        continuationEffects.push({
          effectId: restartContinuationEffectId(runId),
          commandId: `command:restart-recover:${runId}`,
          threadId: row.thread_id,
          payloadJson: JSON.stringify(payload),
        })
      }
      void cancelledWork
    }

    for (const threadId of pauseThreadIds) {
      hostEvents.push(lifecycleEvent(threadId, { kind: 'queue', paused: true }, undefined, occurredAt))
    }
    for (const threadId of unpauseThreadIds) {
      if (pauseThreadIds.has(threadId)) continue
      hostEvents.push(lifecycleEvent(threadId, { kind: 'queue', paused: false }, undefined, occurredAt))
    }
    for (const { threadId, request } of updatedRequests) {
      hostEvents.push(lifecycleEvent(threadId, { kind: 'request', request }, request.runId, occurredAt))
    }

    for (const threadId of stalePausedThreadIds) {
      if (pauseThreadIds.has(threadId) || unpauseThreadIds.has(threadId)) continue
      unpauseThreadIds.add(threadId)
      hostEvents.push(lifecycleEvent(threadId, { kind: 'queue', paused: false }, undefined, occurredAt))
    }

    this.sink.commit({ events, hostEvents }, () => {
      for (const row of continuationRunning) {
        this.database.prepare(`UPDATE conversation_v2_effect_outbox
          SET status = 'pending', updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
          WHERE effect_id = ?`).run(occurredAt, row.effect_id)
      }
      for (const row of controlEffects) {
        this.database.prepare(`UPDATE conversation_v2_effect_outbox
          SET status = 'cancelled', last_error = ?, updated_at = ?, completed_at = ?, lease_owner = NULL, lease_expires_at = NULL
          WHERE effect_id = ?`).run(detail, occurredAt, occurredAt, row.effect_id)
        if (row.phase !== null) {
          this.database.prepare("UPDATE conversation_v2_dispatch_attempts SET phase = 'settled' WHERE effect_id = ?").run(row.effect_id)
        }
      }
      for (const row of unacceptedStarts) {
        this.database.prepare('DELETE FROM conversation_v2_dispatch_attempts WHERE effect_id = ?').run(row.effect_id)
        this.database.prepare(`UPDATE conversation_v2_effect_outbox
          SET status = 'pending', last_error = NULL, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
          WHERE effect_id = ?`).run(occurredAt, row.effect_id)
      }
      for (const row of [...stoppedStarts, ...interruptedStarts.map(item => item.row)]) {
        this.database.prepare(`UPDATE conversation_v2_effect_outbox
          SET status = 'cancelled', last_error = ?, updated_at = ?, completed_at = ?, lease_owner = NULL, lease_expires_at = NULL
          WHERE effect_id = ?`).run(detail, occurredAt, occurredAt, row.effect_id)
        if (row.phase !== null) {
          this.database.prepare("UPDATE conversation_v2_dispatch_attempts SET phase = 'settled' WHERE effect_id = ?").run(row.effect_id)
        }
      }
      for (const update of runUpdates) {
        this.database.prepare(`UPDATE conversation_v2_projection_runs
          SET status = ?, completed_at = ?, payload_json = ? WHERE run_id = ?`)
          .run(update.status, update.completedAt, update.payloadJson, update.runId)
        this.database.prepare('UPDATE conversation_v2_projection_threads SET updated_at = ? WHERE thread_id = ?')
          .run(occurredAt, update.threadId)
      }
      for (const runId of stopStreamingRunIds) {
        this.database.prepare(`UPDATE conversation_v2_projection_messages
          SET streaming = 0, updated_at = ?, payload_json = json_patch(payload_json, ?)
          WHERE run_id = ? AND role = 'assistant' AND streaming = 1`)
          .run(occurredAt, JSON.stringify({ streaming: false, updatedAt: occurredAt }), runId)
      }
      for (const item of cancelledWorkItems) {
        this.database.prepare(`UPDATE conversation_v2_projection_turn_items
          SET status = 'cancelled', updated_at = ?, payload_json = ? WHERE turn_item_id = ?`)
          .run(item.updatedAt, item.payloadJson, item.itemId)
      }
      for (const notice of insertedNotices) {
        this.database.prepare(`INSERT OR IGNORE INTO conversation_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, provider_turn_id, ordinal, type, status, updated_at, payload_json)
          VALUES (?, ?, ?, NULL, ?, 'system_notice', 'completed', ?, ?)`)
          .run(notice.id, notice.threadId, notice.runId, notice.ordinal, occurredAt, notice.payloadJson)
      }
      for (const threadId of pauseThreadIds) {
        this.database.prepare(`INSERT INTO conversation_v2_thread_control (thread_id, authority_digest, paused) VALUES (?, '', 1)
          ON CONFLICT(thread_id) DO UPDATE SET paused = 1`).run(threadId)
      }
      for (const threadId of unpauseThreadIds) {
        if (pauseThreadIds.has(threadId)) continue
        this.database.prepare('UPDATE conversation_v2_thread_control SET paused = 0 WHERE thread_id = ?').run(threadId)
      }
      const writeRequest = this.database.prepare(`UPDATE conversation_v2_projection_runtime_requests
        SET status = ?, payload_json = ? WHERE runtime_request_id = ? AND thread_id = ?`)
      for (const { threadId, request } of updatedRequests) {
        writeRequest.run(request.status, JSON.stringify(request), request.requestId, threadId)
      }
      const insertContinuation = this.database.prepare(`INSERT OR IGNORE INTO conversation_v2_effect_outbox
        (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      for (const item of continuationEffects) {
        insertContinuation.run(
          item.effectId,
          item.commandId,
          item.threadId,
          RESTART_CONTINUATION_EFFECT_TYPE,
          item.payloadJson,
          occurredAt,
          occurredAt,
          occurredAt,
        )
      }
    })
  }

  private planCancelledRun(input: {
    readonly threadId: string
    readonly runId: string
    readonly occurredAt: string
    readonly addNotice: boolean
    readonly noticeTitle: string
    readonly noticeMessage: string
    readonly allocateOrdinal: (threadId: string) => number
    readonly events: OrchestrationV2DomainEvent[]
    readonly hostEvents: ConversationLifecycleEvent[]
    readonly runUpdates: Array<{ readonly threadId: string; readonly runId: string; readonly status: string; readonly completedAt: string | null; readonly payloadJson: string }>
    readonly stopStreamingRunIds: Set<string>
    readonly cancelledWorkItems: Array<{ readonly itemId: string; readonly payloadJson: string; readonly updatedAt: string }>
    readonly insertedNotices: Array<{ readonly id: string; readonly threadId: string; readonly runId: string; readonly ordinal: number; readonly payloadJson: string }>
  }): readonly RestartCancelledWork[] {
    const { threadId, runId, occurredAt } = input
    const openItems = this.database.prepare(`SELECT turn_item_id, payload_json FROM conversation_v2_projection_turn_items
      WHERE thread_id = ? AND run_id = ? AND status IN ('pending', 'running', 'waiting')`)
      .all(threadId, runId) as Array<{ turn_item_id: string; payload_json: string }>
    const cancelledWork: RestartCancelledWork[] = []
    for (const itemRow of openItems) {
      const raw = JSON.parse(itemRow.payload_json) as Record<string, unknown>
      const work = cancelledWorkFromTurnItem(raw)
      if (work) cancelledWork.push(work)
      const nextItem = {
        ...raw,
        ...('streaming' in raw ? { streaming: false } : {}),
        status: 'cancelled',
        completedAt: occurredAt,
        updatedAt: occurredAt,
      }
      const nextJson = JSON.stringify(nextItem)
      input.cancelledWorkItems.push({ itemId: itemRow.turn_item_id, payloadJson: nextJson, updatedAt: occurredAt })
      try {
        input.events.push(decodeEvent({ id: randomUUID(), threadId, runId, occurredAt, type: 'turn-item.updated', payload: nextItem }))
      } catch {
        // 若旧项结构不兼容 schema，仍保留 SQLite 状态更新，不阻断恢复。
      }
    }

    const streamingMessages = this.database.prepare(`SELECT payload_json FROM conversation_v2_projection_messages
      WHERE thread_id = ? AND run_id = ? AND role = 'assistant' AND streaming = 1`)
      .all(threadId, runId) as Array<{ payload_json: string }>
    if (streamingMessages.length > 0) {
      input.stopStreamingRunIds.add(runId)
      for (const msgRow of streamingMessages) {
        const nextMsg = { ...JSON.parse(msgRow.payload_json), streaming: false, updatedAt: occurredAt }
        input.events.push(decodeEvent({ id: randomUUID(), threadId, runId, occurredAt, type: 'message.updated', payload: nextMsg }))
      }
    }

    const runRow = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_runs WHERE run_id = ? AND thread_id = ?')
      .get(runId, threadId) as { payload_json: string } | undefined
    if (runRow) {
      const raw = JSON.parse(runRow.payload_json) as Record<string, unknown>
      const existingWork = Array.isArray(raw.restartCancelledBackgroundWork)
        ? raw.restartCancelledBackgroundWork as readonly RestartCancelledWork[]
        : []
      const mergedWork = cancelledWork.length > 0
        ? mergeRestartCancelledBackgroundWork(existingWork, cancelledWork)
        : existingWork
      const nextRun: Record<string, unknown> = {
        ...raw,
        status: 'cancelled',
        completedAt: occurredAt,
        outcomeUnknown: undefined,
        outcomeUnknownAt: undefined,
        failure: undefined,
        ...(mergedWork.length > 0 ? { restartCancelledBackgroundWork: mergedWork } : {}),
      }
      input.runUpdates.push({ threadId, runId, status: 'cancelled', completedAt: occurredAt, payloadJson: JSON.stringify(nextRun) })
      input.events.push(decodeEvent({ id: randomUUID(), threadId, runId, occurredAt, type: 'run.updated', payload: nextRun }))
      input.hostEvents.push(lifecycleEvent(threadId, { kind: 'run', phase: 'settled' }, runId, occurredAt))
    }

    if (input.addNotice) {
      const noticeId = serverRecoveryNoticeItemId(runId)
      const exists = this.database.prepare('SELECT 1 FROM conversation_v2_projection_turn_items WHERE turn_item_id = ?').get(noticeId)
      if (!exists) {
        const ordinal = input.allocateOrdinal(threadId)
        const payload: Extract<ConversationProjectedWorkItem, { readonly type: 'system_notice' }> = {
          id: noticeId,
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: 'completed',
          title: input.noticeTitle,
          startedAt: occurredAt,
          completedAt: occurredAt,
          updatedAt: occurredAt,
          type: 'system_notice',
          message: input.noticeMessage,
          level: 'info',
        }
        input.insertedNotices.push({ id: noticeId, threadId, runId, ordinal, payloadJson: JSON.stringify(payload) })
        input.events.push(decodeEvent({ id: randomUUID(), threadId, runId, occurredAt, type: 'turn-item.updated', payload }))
      }
    }

    return cancelledWork
  }

  private wasAcceptedByEngine(row: RecoveryEffectRow, runId: string): boolean {
    if (row.native_turn_id || row.provider_thread_id) return true
    const runRow = this.database.prepare('SELECT provider_thread_id, payload_json FROM conversation_v2_projection_runs WHERE run_id = ?')
      .get(runId) as { provider_thread_id: string | null; payload_json: string } | undefined
    if (!runRow) return false
    if (runRow.provider_thread_id) return true
    const raw = JSON.parse(runRow.payload_json) as { engineAcceptedAt?: string; firstOutputAt?: string; nativeTurnId?: string }
    return Boolean(raw.engineAcceptedAt || raw.firstOutputAt || raw.nativeTurnId)
  }

  private isEligibleForShutdownContinuation(row: RecoveryEffectRow, runId: string): boolean {
    if (row.stop_requested === 1 || row.phase !== 'dispatching' || row.terminal_status !== null) return false
    if (!this.wasAcceptedByEngine(row, runId)) return false
    return this.checkCommonContinuationGuards(row, runId)
  }

  private isEligibleForStartupContinuation(row: RecoveryEffectRow, runId: string): boolean {
    if (row.stop_requested === 1 || row.terminal_status !== null) return false
    if (!this.wasAcceptedByEngine(row, runId)) return false
    return this.checkCommonContinuationGuards(row, runId)
  }

  private checkCommonContinuationGuards(row: RecoveryEffectRow, runId: string): boolean {
    const thread = this.database.prepare(`SELECT default_provider, archived_at, deleted_at
      FROM conversation_v2_projection_threads WHERE thread_id = ?`)
      .get(row.thread_id) as { default_provider: string; archived_at: string | null; deleted_at: string | null } | undefined
    if (!thread || thread.archived_at !== null || thread.deleted_at !== null) return false

    const runRow = this.database.prepare('SELECT provider_instance_id, payload_json FROM conversation_v2_projection_runs WHERE run_id = ?')
      .get(runId) as { provider_instance_id: string; payload_json: string } | undefined
    if (!runRow || runRow.provider_instance_id !== thread.default_provider) return false

    const effectPayload = JSON.parse(row.payload_json) as { compaction?: unknown; delegatedCompletion?: unknown }
    const runPayload = JSON.parse(runRow.payload_json) as { compaction?: unknown }
    if (effectPayload.compaction || runPayload.compaction || effectPayload.delegatedCompletion) return false

    // 必须具备强原生会话绑定，才能在重启后通过 resumeThread 续接同一上下文。
    const binding = this.database.prepare(`SELECT instance_id, native_thread_id
      FROM conversation_v2_native_bindings WHERE thread_id = ?`)
      .get(row.thread_id) as { instance_id: string; native_thread_id: string } | undefined
    if (!binding || binding.instance_id !== runRow.provider_instance_id || !binding.native_thread_id) return false

    // 用户曾主动提交停止命令的回合不得自动续接。
    const stopSubmitted = this.database.prepare(`SELECT 1 FROM conversation_v2_effect_outbox
      WHERE thread_id = ? AND effect_type = 'provider-turn.interrupt'
        AND json_extract(payload_json, '$.runId') = ? LIMIT 1`).get(row.thread_id, runId)
    if (stopSubmitted) return false

    // 等待审批或用户提问的回合不得跳过交互自动续接。
    const requestRows = this.database.prepare(`SELECT payload_json FROM conversation_v2_projection_runtime_requests
      WHERE thread_id = ?`).all(row.thread_id) as Array<{ payload_json: string }>
    const requests = requestRows.map(entry => JSON.parse(entry.payload_json) as ConversationRuntimeRequest)
    if (hasBlockingRuntimeRequestForRun(requests, runId)) return false

    return true
  }

  private nextProcessLossCount(threadId: string, runId: string): number {
    const runRow = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_runs WHERE run_id = ? AND thread_id = ?')
      .get(runId, threadId) as { payload_json: string } | undefined
    const previousRunId = runRow
      ? (JSON.parse(runRow.payload_json) as { restartContinuationOfRunId?: string }).restartContinuationOfRunId
      : undefined
    if (!previousRunId) return 1
    const previousEffect = this.database.prepare('SELECT payload_json FROM conversation_v2_effect_outbox WHERE effect_id = ?')
      .get(restartContinuationEffectId(previousRunId)) as { payload_json: string } | undefined
    const previousCount = previousEffect ? parseRestartContinuationPayload(previousEffect.payload_json)?.processLossCount ?? 0 : 0
    return previousCount + 1
  }

  private threadUsedArtifacts(threadId: string): boolean {
    const rows = this.database.prepare(`SELECT json_extract(payload_json, '$.text') AS text
      FROM conversation_v2_projection_messages WHERE thread_id = ? AND role = 'user'`).all(threadId) as Array<{ text: string | null }>
    return rows.some(entry => typeof entry.text === 'string' && parseArtifactsSlashCommand(entry.text) !== null)
  }

  runId(row: ThreadEffectRow): string | undefined {
    return (JSON.parse(row.payload_json) as { runId?: string }).runId
  }

  configurationFingerprint(row: ThreadEffectRow): string | undefined {
    return (JSON.parse(row.payload_json) as { configurationFingerprint?: string }).configurationFingerprint
  }

  claim(row: ThreadEffectRow): string | undefined {
    const runId = this.runId(row)
    const occurredAt = new Date().toISOString()
    const attemptId = randomUUID()
    return this.sink.commit({
      commandId: row.command_id,
      hostEvents: [lifecycleEvent(row.thread_id, { kind: 'dispatch', status: 'preparing' }, runId, occurredAt)],
    }, () => {
      const claimed = this.database.prepare(`UPDATE conversation_v2_effect_outbox SET status = 'running', lease_owner = ?,
        attempt_count = attempt_count + 1, updated_at = ? WHERE effect_id = ? AND status = 'pending'`)
        .run(this.ownerId, occurredAt, row.effect_id)
      if (claimed.changes !== 1) throw new DaemonError('E_CONFLICT', '此派发已由另一个工作器持有。')
      this.database.prepare(`INSERT INTO conversation_v2_dispatch_attempts (effect_id, attempt_id, phase) VALUES (?, ?, 'preparing')`)
        .run(row.effect_id, attemptId)
      return attemptId
    })
  }

  assertAttempt(row: ThreadEffectRow, attemptId: string): DispatchAttempt {
    const attempt = this.attempt(row.effect_id)
    if (!attempt || attempt.attempt_id !== attemptId || attempt.stop_requested || attempt.phase === 'settled') {
      throw new DaemonError('E_CONFLICT', '原运行已停止或代次已失效。')
    }
    return attempt
  }

  canObserve(row: ThreadEffectRow, attemptId: string): boolean {
    const attempt = this.attempt(row.effect_id)
    return attempt?.attempt_id === attemptId && attempt.phase !== 'settled' && this.isOwned(row)
  }

  isOwned(row: ThreadEffectRow): boolean {
    return this.database.prepare("SELECT 1 FROM conversation_v2_effect_outbox WHERE effect_id = ? AND lease_owner = ? AND status = 'running'")
      .get(row.effect_id, this.ownerId) !== undefined
  }

  markDispatched(row: ThreadEffectRow, attemptId: string, nativeThreadId: string, apply: () => void, nativeTurnId?: string,
    events?: readonly OrchestrationV2DomainEvent[], hostEvents: readonly ConversationLifecycleEvent[] = []): void {
    this.assertAttempt(row, attemptId)
    this.sink.commit({
      commandId: row.command_id,
      events,
      hostEvents: [lifecycleEvent(row.thread_id, { kind: 'dispatch', status: 'dispatching' }, this.runId(row)), ...hostEvents],
    }, () => {
      this.database.prepare("UPDATE conversation_v2_dispatch_attempts SET phase = 'dispatching', provider_thread_id = ?, native_turn_id = ? WHERE effect_id = ?")
        .run(nativeThreadId, nativeTurnId ?? null, row.effect_id)
      apply()
    })
  }

  recordNativeTurn(row: ThreadEffectRow, turnId: string): void {
    this.database.prepare('UPDATE conversation_v2_dispatch_attempts SET native_turn_id = COALESCE(native_turn_id, ?) WHERE effect_id = ?')
      .run(turnId, row.effect_id)
  }

  recordNativeTerminal(row: ThreadEffectRow, evidence: ConversationNativeTerminalEvidence): void {
    this.database.prepare(`INSERT OR IGNORE INTO conversation_v2_native_terminal_evidence (effect_id, status, observed_at, native_turn_id)
      VALUES (?, ?, ?, ?)`).run(row.effect_id, evidence.status, evidence.observedAt, evidence.nativeTurnId ?? null)
  }

  requestStop(row: ThreadEffectRow): void {
    this.database.prepare('UPDATE conversation_v2_dispatch_attempts SET stop_requested = 1 WHERE effect_id = ?').run(row.effect_id)
  }

  releaseClaim(row: ThreadEffectRow, occurredAt: string, status: 'succeeded' | 'failed' | 'cancelled', detail?: string): void {
    const updated = this.database.prepare(`UPDATE conversation_v2_effect_outbox SET status = ?, last_error = ?, completed_at = ?,
      updated_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE effect_id = ? AND lease_owner = ? AND status = 'running'`)
      .run(status, detail ?? null, occurredAt, occurredAt, row.effect_id, this.ownerId)
    if (updated.changes !== 1) throw new DaemonError('E_CONFLICT', '此派发已离开原工作器。')
    this.database.prepare("UPDATE conversation_v2_dispatch_attempts SET phase = 'settled' WHERE effect_id = ?").run(row.effect_id)
  }

  markUnknown(row: ThreadEffectRow, occurredAt: string, detail: string): void {
    const updated = this.database.prepare(`UPDATE conversation_v2_effect_outbox SET last_error = ?, updated_at = ?, lease_expires_at = NULL
      WHERE effect_id = ? AND lease_owner = ? AND status = 'running'`).run(detail, occurredAt, row.effect_id, this.ownerId)
    if (updated.changes !== 1) throw new DaemonError('E_CONFLICT', '此派发已离开原工作器。')
    this.database.prepare("UPDATE conversation_v2_dispatch_attempts SET phase = 'unknown' WHERE effect_id = ?").run(row.effect_id)
  }
}
