import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import * as Effect from 'effect/Effect'
import { DaemonError } from '../../../daemon/errors'
import type { ConversationRunEvidence } from '../../../../shared/conversation/desktop'
import type { ConversationLifecycleEvent, ConversationNativeTerminalEvidence, ConversationRuntimeRequest } from '../../../../shared/conversation/command-runtime'
import * as Schema from 'effect/Schema'
import { OrchestrationV2DomainEventJson, type OrchestrationV2DomainEvent } from '../../../../shared/conversation/contracts'
import type { ConversationEventSink } from './EventSink'
import { lifecycleEvent, type ThreadEffectRow } from './ThreadCommands'

export interface DispatchAttempt {
  readonly attempt_id: string
  readonly phase: 'preparing' | 'dispatching' | 'unknown' | 'settled'
  readonly provider_thread_id: string | null
  readonly native_turn_id: string | null
  readonly stop_requested: number
  readonly foreground_ended: number
  readonly background_running: number
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

const recoveryDetail = '原运行的引擎结果待按原命令核对。'
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)

export class ConversationEffectWorker {
  private readonly ownerId = `crux-${process.pid}-${randomUUID()}`

  constructor(private readonly database: DatabaseSync, private readonly sink: ConversationEventSink) {}

  attempt(effectId: string): DispatchAttempt | undefined {
    return this.database.prepare('SELECT * FROM conversation_v2_dispatch_attempts WHERE effect_id = ?').get(effectId) as DispatchAttempt | undefined
  }

  recover(): void {
    const unsettled = this.database.prepare(`SELECT effect.*, attempt.phase, attempt.stop_requested FROM conversation_v2_effect_outbox effect
      LEFT JOIN conversation_v2_dispatch_attempts attempt ON attempt.effect_id = effect.effect_id
      WHERE effect.status IN ('pending', 'running')`).all() as unknown as Array<ThreadEffectRow & {
      phase: DispatchAttempt['phase'] | null; effect_type: string; stop_requested: number | null
    }>
    const occurredAt = new Date().toISOString()
    const isUnpaused = this.database.prepare('SELECT 1 FROM conversation_v2_thread_control WHERE thread_id = ? AND paused = 1')
    const threadIds = [...new Set(unsettled.map(row => row.thread_id))].filter(threadId => !isUnpaused.get(threadId))
    const unknown = unsettled.filter(row => row.status === 'running' && (row.phase === 'dispatching' || row.phase === null))
    const preparing = unsettled.filter(row => row.status === 'running' && row.phase === 'preparing')
    const unfinished = unsettled.filter(row => row.status === 'pending' && row.effect_type !== 'provider-turn.start')
    const expiredRequests = (this.database.prepare(`SELECT thread_id, payload_json FROM conversation_v2_projection_runtime_requests
      WHERE status IN ('pending', 'responding')`).all() as Array<{ thread_id: string; payload_json: string }>).map(row => {
      const request = JSON.parse(row.payload_json) as ConversationRuntimeRequest
      return {
        threadId: row.thread_id,
        request: { ...request, status: request.status === 'responding' ? 'pending-reconciliation' as const : 'expired' as const },
      }
    })
    if (threadIds.length === 0 && unknown.length === 0 && preparing.length === 0 && unfinished.length === 0 && expiredRequests.length === 0) return
    const unposted = [...preparing, ...unfinished].flatMap(row => {
      const cancelled = row.stop_requested === 1
      if (!cancelled && row.effect_type !== 'provider-turn.steer') return []
      const runId = this.runId(row)
      if (!runId) return []
      const run = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_runs WHERE run_id = ? AND thread_id = ?')
        .get(runId, row.thread_id) as { payload_json: string } | undefined
      if (!run) return []
      const payload = { ...JSON.parse(run.payload_json), status: cancelled ? 'cancelled' : 'failed', completedAt: occurredAt }
      const event = decodeEvent({ id: randomUUID(), threadId: row.thread_id, runId, occurredAt, type: 'run.updated', payload })
      return [{ row, runId, payload, event }]
    })
    this.sink.commit({
      events: unposted.map(item => item.event),
      hostEvents: [
        ...threadIds.map(threadId => lifecycleEvent(threadId, { kind: 'queue', paused: true }, undefined, occurredAt)),
        ...unknown.map(row => lifecycleEvent(row.thread_id, { kind: 'dispatch', status: 'unknown' }, this.runId(row), occurredAt)),
        ...expiredRequests.map(({ threadId, request }) => lifecycleEvent(threadId, { kind: 'request', request }, request.runId, occurredAt)),
      ],
    }, () => {
      for (const threadId of threadIds) {
        this.database.prepare(`INSERT INTO conversation_v2_thread_control (thread_id, authority_digest, paused) VALUES (?, '', 1)
          ON CONFLICT(thread_id) DO UPDATE SET paused = 1`)
          .run(threadId)
      }
      for (const row of [...preparing, ...unfinished]) {
        const isStart = row.effect_type === 'provider-turn.start'
        if (!isStart || row.stop_requested === 1) {
          const status = row.stop_requested === 1 ? 'cancelled' : 'failed'
          this.database.prepare(`UPDATE conversation_v2_effect_outbox SET status = ?, last_error = ?, updated_at = ?, completed_at = ?,
            lease_owner = NULL, lease_expires_at = NULL WHERE effect_id = ?`)
            .run(status, '引擎操作在派发前已中断。', occurredAt, occurredAt, row.effect_id)
          if (row.phase === 'preparing') this.database.prepare("UPDATE conversation_v2_dispatch_attempts SET phase = 'settled' WHERE effect_id = ?").run(row.effect_id)
        } else {
          this.database.prepare('DELETE FROM conversation_v2_dispatch_attempts WHERE effect_id = ?').run(row.effect_id)
          this.database.prepare(`UPDATE conversation_v2_effect_outbox SET status = 'pending', updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
            WHERE effect_id = ?`).run(occurredAt, row.effect_id)
        }
      }
      for (const item of unposted) {
        this.database.prepare('UPDATE conversation_v2_projection_runs SET status = ?, completed_at = ?, payload_json = ? WHERE run_id = ?')
          .run(item.payload.status, occurredAt, JSON.stringify(item.payload), item.runId)
      }
      for (const row of unknown) {
        this.database.prepare(`INSERT INTO conversation_v2_dispatch_attempts (effect_id, attempt_id, phase)
          VALUES (?, ?, 'unknown') ON CONFLICT(effect_id) DO UPDATE SET phase = 'unknown'`).run(row.effect_id, randomUUID())
        this.database.prepare('UPDATE conversation_v2_effect_outbox SET last_error = ?, updated_at = ?, lease_expires_at = NULL WHERE effect_id = ?')
          .run(recoveryDetail, occurredAt, row.effect_id)
        const runId = this.runId(row)
        if (runId && row.effect_type === 'provider-turn.start') {
          const evidence: ConversationRunEvidence = { outcomeUnknown: true, outcomeUnknownAt: occurredAt, failure: recoveryDetail }
          this.database.prepare('UPDATE conversation_v2_projection_runs SET payload_json = json_patch(payload_json, ?) WHERE run_id = ?')
            .run(JSON.stringify(evidence), runId)
          this.database.prepare(`UPDATE conversation_v2_projection_messages SET streaming = 0,
            payload_json = json_set(payload_json, '$.streaming', json('false'))
            WHERE run_id = ? AND role = 'assistant'`).run(runId)
        }
      }
      const writeRequest = this.database.prepare(`UPDATE conversation_v2_projection_runtime_requests
        SET status = ?, payload_json = ? WHERE runtime_request_id = ? AND thread_id = ?`)
      for (const { threadId, request } of expiredRequests) {
        writeRequest.run(request.status, JSON.stringify(request), request.requestId, threadId)
      }
    })
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
