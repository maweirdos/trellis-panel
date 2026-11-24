import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import * as Schema from 'effect/Schema'
import { DaemonError } from '../../../daemon/errors'
import type { ConversationAuthority } from '../../../../shared/conversation/desktop'
import type {
  ConversationLifecycleEvent, ConversationRuntimeRequest, ConversationThreadCommand, ConversationThreadCommandState,
} from '../../../../shared/conversation/command-runtime'
import {
  OrchestrationV2DomainEventJson, type ModelSelection, type OrchestrationV2DomainEvent, type ProviderDriverKind,
} from '../../../../shared/conversation/contracts'
import { commandPayloadDigest } from '../persistence/event-store'
import type { ConversationEventSink } from './EventSink'
import { queuedRunsInDeliveryOrder } from './QueuedRunOrder'

export interface ThreadRunRow {
  run_id: string
  thread_id: string
  ordinal: number
  provider_instance_id: string
  status: string
  payload_json: string
}

export interface ThreadEffectRow {
  effect_id: string
  command_id: string
  thread_id: string
  payload_json: string
  status: string
  last_error: string | null
  lease_expires_at: string | null
}

interface CommandTarget {
  run_id: string | null
  message_id: string | null
  request_id: string | null
  follows_run: number
  detail: string | null
}

interface CommandPlan {
  readonly target?: Partial<CommandTarget>
  readonly events?: readonly OrchestrationV2DomainEvent[]
  readonly hostEvents?: readonly ConversationLifecycleEvent[]
  readonly apply: () => void
}

interface DriverSelection {
  readonly modelSelection: ModelSelection
  readonly driverKind: ProviderDriverKind
  readonly configurationFingerprint: string
}

const now = () => new Date().toISOString()
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)

export function lifecycleEvent(
  threadId: string, payload: ConversationLifecycleEvent['payload'], runId?: string, occurredAt = now(),
): ConversationLifecycleEvent {
  return { id: randomUUID(), threadId, runId, occurredAt, type: 'crux.lifecycle', payload }
}

export function authorityDigest(authority: ConversationAuthority): string {
  return commandPayloadDigest({
    ownerId: authority.ownerId, spaceId: authority.spaceId, projectId: authority.projectId,
    cwd: process.platform === 'win32' ? authority.cwd.toLowerCase() : authority.cwd,
    binding: authority.binding,
  })
}

export class ThreadCommands {
  constructor(private readonly database: DatabaseSync, private readonly sink: ConversationEventSink) {}

  hasThread(threadId: string, authority: ConversationAuthority): boolean {
    const row = this.database.prepare(`SELECT control.authority_digest FROM conversation_v2_projection_threads thread
      LEFT JOIN conversation_v2_thread_control control ON control.thread_id = thread.thread_id
      WHERE thread.thread_id = ? AND thread.owner_id = ? AND thread.space_id = ? AND thread.project_id = ? AND thread.deleted_at IS NULL`)
      .get(threadId, authority.ownerId, authority.spaceId, authority.projectId) as { authority_digest: string | null } | undefined
    return row !== undefined && (!row.authority_digest ? authority.binding.kind === 'personal' : row.authority_digest === authorityDigest(authority))
  }

  ensureControl(threadId: string, authority: ConversationAuthority): void {
    this.database.prepare(`INSERT INTO conversation_v2_thread_control (thread_id, authority_digest) VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET authority_digest = excluded.authority_digest
      WHERE conversation_v2_thread_control.authority_digest = ''`)
      .run(threadId, authorityDigest(authority))
  }

  isPaused(threadId: string): boolean {
    const row = this.database.prepare('SELECT paused FROM conversation_v2_thread_control WHERE thread_id = ?').get(threadId) as { paused: number } | undefined
    return row?.paused === 1
  }

  setPaused(threadId: string, paused: boolean): void {
    this.database.prepare('UPDATE conversation_v2_thread_control SET paused = ? WHERE thread_id = ?').run(paused ? 1 : 0, threadId)
  }

  run(threadId: string, runId: string): ThreadRunRow | undefined {
    return this.database.prepare('SELECT * FROM conversation_v2_projection_runs WHERE thread_id = ? AND run_id = ?').get(threadId, runId) as ThreadRunRow | undefined
  }

  effect(commandId: string): ThreadEffectRow | undefined {
    return this.database.prepare('SELECT * FROM conversation_v2_effect_outbox WHERE command_id = ?').get(commandId) as ThreadEffectRow | undefined
  }

  effectForRun(threadId: string, runId: string): ThreadEffectRow | undefined {
    return this.database.prepare(`SELECT * FROM conversation_v2_effect_outbox WHERE thread_id = ? AND effect_type = 'provider-turn.start' AND json_extract(payload_json, '$.runId') = ?`)
      .get(threadId, runId) as ThreadEffectRow | undefined
  }

  private queuedRuns(threadId: string): ThreadRunRow[] {
    const rows = this.database.prepare(`SELECT run.*,
      EXISTS(SELECT 1 FROM conversation_v2_projection_messages message WHERE message.run_id = run.run_id
        AND message.role = 'user' AND json_extract(message.payload_json, '$.delegatedCompletion') IS NOT NULL) AS automatic
      FROM conversation_v2_projection_runs run
      JOIN conversation_v2_effect_outbox effect ON effect.thread_id = run.thread_id AND effect.effect_type = 'provider-turn.start'
        AND json_extract(effect.payload_json, '$.runId') = run.run_id AND effect.status = 'pending'
      WHERE run.thread_id = ? AND run.status = 'queued'`)
      .all(threadId) as unknown as Array<ThreadRunRow & { automatic: number; requested_at: string }>
    return queuedRunsInDeliveryOrder(rows.map(row => ({
      row, ordinal: row.ordinal, requestedAt: row.requested_at, isAutomaticCompletion: row.automatic === 1,
      queuePosition: (JSON.parse(row.payload_json) as { queuePosition?: number }).queuePosition,
    }))).map(entry => entry.row)
  }

  nextCommand(threadId: string): string | undefined {
    if (this.isPaused(threadId)) return undefined
    const blocked = this.database.prepare(`SELECT 1 FROM conversation_v2_effect_outbox WHERE thread_id = ?
      AND effect_type IN ('provider-turn.start', 'provider-turn.steer') AND status = 'running' LIMIT 1`).get(threadId)
    if (blocked) return undefined
    const run = this.queuedRuns(threadId)[0]
    return run && this.effectForRun(threadId, run.run_id)?.command_id
  }

  replay(input: ConversationThreadCommand, authority: ConversationAuthority): ConversationThreadCommandState | undefined {
    const receipt = this.sink.readReceipt(input.commandId)
    if (!receipt) return undefined
    if (receipt.threadId !== input.threadId || receipt.payloadDigest !== commandPayloadDigest(input) || !this.hasThread(receipt.threadId, authority)) {
      throw new DaemonError('E_CONFLICT', '此命令编号已用于另一个请求。')
    }
    if (receipt.status === 'rejected') throw new DaemonError('E_CONFLICT', receipt.error ?? '原命令已拒收。')
    return this.read(input.commandId, authority) ?? undefined
  }

  read(commandId: string, authority: ConversationAuthority): ConversationThreadCommandState | null {
    const receipt = this.sink.readReceipt(commandId)
    if (!receipt || receipt.status !== 'accepted' || !this.hasThread(receipt.threadId, authority)) return null
    const effect = this.effect(commandId)
    const target = this.database.prepare('SELECT * FROM conversation_v2_command_targets WHERE command_id = ?').get(commandId) as CommandTarget | undefined
    const runId = target?.run_id ?? (effect ? (JSON.parse(effect.payload_json) as { runId?: string }).runId : undefined)
    const originalEffect = effect ?? (runId && target?.follows_run ? this.effectForRun(receipt.threadId, runId) : undefined)
    const promotedEffect = originalEffect && this.database.prepare(`SELECT * FROM conversation_v2_effect_outbox
      WHERE thread_id = ? AND effect_type = 'provider-turn.steer' AND json_extract(payload_json, '$.sourceEffectId') = ? LIMIT 1`)
      .get(receipt.threadId, originalEffect.effect_id) as ThreadEffectRow | undefined
    const stateEffect = promotedEffect ?? originalEffect
    const attempt = stateEffect && this.database.prepare('SELECT phase, native_turn_id FROM conversation_v2_dispatch_attempts WHERE effect_id = ?')
      .get(stateEffect.effect_id) as { phase: string; native_turn_id: string | null } | undefined
    const run = runId ? this.run(receipt.threadId, runId) : undefined
    const runPayload = run ? JSON.parse(run.payload_json) as { userMessageId: string; engineAcceptedAt?: string } : undefined
    const dispatch: ConversationThreadCommandState['dispatch'] =
      stateEffect?.status === 'succeeded' ? 'completed'
        : stateEffect?.status === 'failed' ? 'failed'
          : stateEffect?.status === 'cancelled' ? 'cancelled'
            : stateEffect?.status === 'pending' ? this.isPaused(receipt.threadId) ? 'paused' : 'queued'
              : stateEffect?.status === 'running' ? attempt?.phase === 'unknown' || !attempt ? 'pending-reconciliation'
                : runPayload?.engineAcceptedAt ? 'running' : 'dispatching'
                : receipt.commandType === 'run.interrupt' && target?.detail ? 'pending-reconciliation' : 'completed'
    const messageId = target?.message_id ?? (target === undefined ? runPayload?.userMessageId : undefined)
    const detail = stateEffect?.last_error ?? target?.detail
    return {
      commandId, threadId: receipt.threadId, acceptedAt: receipt.acceptedAt, resultSequence: receipt.resultSequence,
      ...(runId ? { runId } : {}), ...(messageId ? { messageId } : {}), ...(target?.request_id ? { requestId: target.request_id } : {}),
      dispatch, ...(detail ? { detail } : {}),
    }
  }

  appendMessage(
    input: Extract<ConversationThreadCommand, { type: 'message.dispatch' }>, authority: ConversationAuthority, selection: DriverSelection,
    steer?: { targetRunId: string; targetAttemptId: string },
  ): ConversationThreadCommandState {
    const first = this.database.prepare('SELECT default_provider FROM conversation_v2_projection_threads WHERE thread_id = ?')
      .get(input.threadId) as { default_provider: string } | undefined
    if (first?.default_provider !== input.instanceId) throw new DaemonError('E_CONFLICT', '当前会话未连接所选引擎实例。')
    if (this.database.prepare('SELECT 1 FROM conversation_v2_projection_messages WHERE message_id = ?').get(input.messageId)) {
      throw new DaemonError('E_CONFLICT', '此消息编号已受理。')
    }
    const latest = this.database.prepare('SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM conversation_v2_projection_runs WHERE thread_id = ?')
      .get(input.threadId) as { ordinal: number }
    const { threadId, messageId, text } = input
    const runId = `run_${randomUUID()}`
    const requestedAt = now()
    const ordinal = latest.ordinal + 1
    const run = {
      id: runId, threadId, ordinal, providerInstanceId: input.instanceId, modelSelection: selection.modelSelection,
      providerThreadId: null, userMessageId: messageId, rootNodeId: null, activeAttemptId: null, status: 'queued',
      requestedAt, startedAt: null, completedAt: null, checkpointId: null, contextHandoffId: null,
    }
    const message = {
      createdBy: 'user', creationSource: 'web', id: messageId, threadId, runId, nodeId: null,
      role: 'user', text, attachments: [], streaming: false, createdAt: requestedAt, updatedAt: requestedAt,
    }
    const base = { threadId, runId, occurredAt: requestedAt }
    return this.commit(input, authority, {
      target: { run_id: runId, message_id: messageId, follows_run: 1 },
      events: [
        decodeEvent({ ...base, id: randomUUID(), type: 'run.created', payload: run }),
        decodeEvent({ ...base, id: randomUUID(), type: 'message.updated', payload: message }),
      ],
      hostEvents: !steer && this.isPaused(threadId) ? [lifecycleEvent(threadId, { kind: 'queue', paused: false })] : [],
      apply: () => {
        this.database.prepare(`INSERT INTO conversation_v2_projection_runs
          (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`)
          .run(runId, threadId, ordinal, selection.driverKind, input.instanceId, requestedAt, JSON.stringify(run))
        this.database.prepare(`INSERT INTO conversation_v2_projection_messages
          (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json) VALUES (?, ?, ?, 'user', 0, ?, ?, ?)`)
          .run(messageId, threadId, runId, requestedAt, requestedAt, JSON.stringify(message))
        this.database.prepare('UPDATE conversation_v2_projection_threads SET updated_at = ? WHERE thread_id = ?').run(requestedAt, threadId)
        this.insertEffect(input, steer ? 'provider-turn.steer' : 'provider-turn.start', {
          runId, configurationFingerprint: selection.configurationFingerprint, ...steer,
        }, requestedAt)
        if (!steer) this.setPaused(threadId, false)
      },
    })
  }

  queue(input: Extract<ConversationThreadCommand, { type: 'queue.resume' | `queued-run.${string}` }>, authority: ConversationAuthority): ConversationThreadCommandState {
    const { threadId, type } = input
    if (type === 'queue.resume') {
      return this.commit(input, authority, {
        hostEvents: [lifecycleEvent(threadId, { kind: 'queue', paused: false })],
        apply: () => this.setPaused(threadId, false),
      })
    }
    const { runId } = input
    const run = this.requireQueued(threadId, runId)
    const occurredAt = now()
    if (type === 'queued-run.edit') {
      const message = this.readUserMessage(runId)
      const payload = { ...message, text: input.text, updatedAt: occurredAt }
      return this.commit(input, authority, {
        target: { run_id: runId, message_id: message.id },
        events: [decodeEvent({ id: randomUUID(), threadId, runId, occurredAt, type: 'message.updated', payload })],
        apply: () => {
          this.database.prepare('UPDATE conversation_v2_projection_messages SET payload_json = ?, updated_at = ? WHERE message_id = ?')
            .run(JSON.stringify(payload), occurredAt, message.id)
        },
      })
    }
    if (type === 'queued-run.cancel') {
      const payload = { ...JSON.parse(run.payload_json), status: 'cancelled', completedAt: occurredAt }
      return this.commit(input, authority, {
        target: { run_id: runId },
        events: [decodeEvent({ id: randomUUID(), threadId, runId, occurredAt, type: 'run.updated', payload })],
        apply: () => {
          this.database.prepare("UPDATE conversation_v2_projection_runs SET status = 'cancelled', completed_at = ?, payload_json = ? WHERE run_id = ?")
            .run(occurredAt, JSON.stringify(payload), runId)
          this.database.prepare(`UPDATE conversation_v2_effect_outbox SET status = 'cancelled', updated_at = ?, completed_at = ?
            WHERE thread_id = ? AND effect_type = 'provider-turn.start' AND json_extract(payload_json, '$.runId') = ? AND status = 'pending'`)
            .run(occurredAt, occurredAt, threadId, runId)
        },
      })
    }
    const rest = this.queuedRuns(threadId).filter(queued => queued.run_id !== runId)
    const beforeRunId = type === 'queued-run.start' ? rest[0]?.run_id ?? null : input.beforeRunId
    const index = beforeRunId === null ? rest.length : rest.findIndex(queued => queued.run_id === beforeRunId)
    if (index < 0) throw new DaemonError('E_CONFLICT', '目标位置已不在队列中。')
    rest.splice(index, 0, run)
    const ordered = rest.map((queued, index) => ({
      runId: queued.run_id,
      payload: { ...JSON.parse(queued.payload_json), queuePosition: index + 1 },
    }))
    return this.commit(input, authority, {
      target: { run_id: runId, follows_run: type === 'queued-run.start' ? 1 : 0 },
      events: ordered.map(item => decodeEvent({ id: randomUUID(), threadId, runId: item.runId, occurredAt, type: 'run.updated', payload: item.payload })),
      hostEvents: type === 'queued-run.start' ? [lifecycleEvent(threadId, { kind: 'queue', paused: false })] : [],
      apply: () => {
        const update = this.database.prepare('UPDATE conversation_v2_projection_runs SET payload_json = ? WHERE run_id = ?')
        for (const item of ordered) update.run(JSON.stringify(item.payload), item.runId)
        if (type === 'queued-run.start') this.setPaused(threadId, false)
      },
    })
  }

  requireQueued(threadId: string, runId: string): ThreadRunRow {
    const run = this.run(threadId, runId)
    if (run?.status !== 'queued' || this.effectForRun(threadId, runId)?.status !== 'pending') {
      throw new DaemonError('E_CONFLICT', '此条消息已离开队列。')
    }
    return run
  }

  readUserMessage(runId: string): { id: string; text: string } {
    const row = this.database.prepare("SELECT payload_json FROM conversation_v2_projection_messages WHERE run_id = ? AND role = 'user' LIMIT 1")
      .get(runId) as { payload_json: string } | undefined
    if (!row) throw new Error('The accepted run has no user message.')
    return JSON.parse(row.payload_json) as { id: string; text: string }
  }

  requests(threadId: string): ConversationRuntimeRequest[] {
    const rows = this.database.prepare(`SELECT payload_json FROM conversation_v2_projection_runtime_requests
      WHERE thread_id = ? ORDER BY CASE WHEN status IN ('pending', 'responding', 'pending-reconciliation') THEN 0 ELSE 1 END,
        created_at DESC, runtime_request_id LIMIT 100`).iterate(threadId) as Iterable<{ payload_json: string }>
    let bytes = 0
    const requests: ConversationRuntimeRequest[] = []
    for (const row of rows) {
      bytes += Buffer.byteLength(row.payload_json)
      if (bytes > 256 * 1024) break
      requests.push(this.visibleRequest(JSON.parse(row.payload_json) as ConversationRuntimeRequest))
    }
    return requests
  }

  request(threadId: string, requestId: string): ConversationRuntimeRequest | undefined {
    const row = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_runtime_requests WHERE thread_id = ? AND runtime_request_id = ?')
      .get(threadId, requestId) as { payload_json: string } | undefined
    return row && this.visibleRequest(JSON.parse(row.payload_json) as ConversationRuntimeRequest)
  }

  private visibleRequest(request: ConversationRuntimeRequest): ConversationRuntimeRequest {
    return request.status === 'pending' && request.expiresAt && Date.parse(request.expiresAt) <= Date.now()
      ? { ...request, status: 'expired' } : request
  }

  writeRequest(threadId: string, request: ConversationRuntimeRequest, nativeTurnId: string | null): void {
    this.database.prepare(`INSERT INTO conversation_v2_projection_runtime_requests
      (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(runtime_request_id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json`)
      .run(request.requestId, threadId, request.runId, nativeTurnId, request.kind, request.status, request.createdAt, JSON.stringify(request))
  }

  bindNativeRequest(requestId: string, attemptId: string, nativeRequestId: string): void {
    this.database.prepare(`INSERT OR IGNORE INTO conversation_v2_runtime_request_bindings (request_id, attempt_id, native_request_id)
      VALUES (?, ?, ?)`).run(requestId, attemptId, nativeRequestId)
  }

  commit(input: ConversationThreadCommand, authority: ConversationAuthority, plan: CommandPlan): ConversationThreadCommandState {
    if (!this.hasThread(input.threadId, authority)) throw new DaemonError('E_DENIED', '此会话不在当前授权范围。')
    this.sink.commitCommand({
      commandId: input.commandId, threadId: input.threadId, commandType: input.type, acceptedAt: now(),
      payloadDigest: commandPayloadDigest(input), events: plan.events, hostEvents: plan.hostEvents,
    }, () => {
      this.ensureControl(input.threadId, authority)
      const target = plan.target
      this.database.prepare(`INSERT INTO conversation_v2_command_targets (command_id, run_id, message_id, request_id, follows_run, detail)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(input.commandId, target?.run_id ?? null, target?.message_id ?? null, target?.request_id ?? null, target?.follows_run ?? 0, target?.detail ?? null)
      plan.apply()
    }, () => {})
    const result = this.read(input.commandId, authority)
    if (!result) throw new Error('Committed conversation receipt could not be read.')
    return result
  }

  insertEffect(input: Pick<ConversationThreadCommand, 'threadId' | 'commandId'>, type: string, payload: unknown, occurredAt = now()): string {
    const effectId = randomUUID()
    this.database.prepare(`INSERT INTO conversation_v2_effect_outbox
      (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(effectId, input.commandId, input.threadId, type, JSON.stringify(payload), occurredAt, occurredAt, occurredAt)
    return effectId
  }
}
