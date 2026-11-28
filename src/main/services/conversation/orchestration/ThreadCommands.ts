import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ChatAttachment } from '../../../../shared/conversation/chatAttachment'
import type { ConversationAttachmentStore } from '../attachments'
import { prepareConversationAttachmentClaim } from '../attachments/claims'
import { assertPromptAttachments, type ConversationPromptAttachmentSupport } from '../providers/core/attachment-input'
import * as Schema from 'effect/Schema'
import { DaemonError } from '../../../daemon/errors'
import type { ConversationAuthority } from '../../../../shared/conversation/desktop'
import type {
  ConversationCompaction, ConversationLifecycleEvent, ConversationRuntimeRequest, ConversationThreadCommand, ConversationThreadCommandState,
} from '../../../../shared/conversation/command-runtime'
import {
  OrchestrationV2DomainEventJson, type ModelSelection, type OrchestrationV2DomainEvent, type OrchestrationV2Notification, type ProviderDriverKind,
} from '../../../../shared/conversation/contracts'
import { commandPayloadDigest } from '../persistence/event-store'
import type { ConversationEventSink } from './EventSink'
import { queuedRunsInDeliveryOrder } from './QueuedRunOrder'
import { isThreadDeletionComplete, planThreadDeletion, threadDeletionPendingMessage, type ThreadDeletionState } from './ThreadDeletion'
import type { PortableHistory } from './ContextHandoff'
import type { ThreadRelations } from './ThreadRelations'
import { completionIntent, type DelegatedCompletionIntent } from './DelegatedCompletion'

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
  readonly receiptType?: 'delegated_task.completion-delivery'
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
  constructor(
    private readonly database: DatabaseSync,
    private readonly sink: ConversationEventSink,
    private readonly attachmentStore?: ConversationAttachmentStore,
  ) {}

  hasThread(threadId: string, authority: ConversationAuthority, includeDeleted = false): boolean {
    const row = this.database.prepare(`SELECT control.authority_digest FROM conversation_v2_projection_threads thread
      LEFT JOIN conversation_v2_thread_control control ON control.thread_id = thread.thread_id
      WHERE thread.thread_id = ? AND thread.owner_id = ? AND thread.space_id = ? AND thread.project_id = ?
        AND (? OR thread.deleted_at IS NULL)`)
      .get(threadId, authority.ownerId, authority.spaceId, authority.projectId, Number(includeDeleted)) as { authority_digest: string | null } | undefined
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
        AND json_extract(message.payload_json, '$.delegatedCompletion') IS NOT NULL) AS automatic
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

  nextCommand(threadId: string, mayDeliver: (commandId: string) => boolean): string | undefined {
    if (this.isPaused(threadId)) return undefined
    const blocked = this.database.prepare(`SELECT 1 FROM conversation_v2_effect_outbox WHERE thread_id = ?
      AND effect_type IN ('provider-turn.start', 'provider-turn.steer') AND status = 'running' LIMIT 1`).get(threadId)
    if (blocked) return undefined
    for (const run of this.queuedRuns(threadId)) {
      const effect = this.effectForRun(threadId, run.run_id)
      if (effect && (!completionIntent(effect) || mayDeliver(effect.command_id))) return effect.command_id
    }
    return undefined
  }

  replay(input: ConversationThreadCommand, authority: ConversationAuthority): ConversationThreadCommandState | undefined {
    const receipt = this.sink.readReceipt(input.commandId)
    if (!receipt) return undefined
    if (receipt.threadId !== input.threadId || receipt.payloadDigest !== commandPayloadDigest(input)
      || !this.hasThread(receipt.threadId, authority, input.type === 'thread.delete')) {
      throw new DaemonError('E_CONFLICT', '此命令编号已用于另一个请求。')
    }
    if (receipt.status === 'rejected') throw new DaemonError('E_CONFLICT', receipt.error ?? '原命令已拒收。')
    return this.read(input.commandId, authority) ?? undefined
  }

  read(commandId: string, authority: ConversationAuthority): ConversationThreadCommandState | null {
    const receipt = this.sink.readReceipt(commandId)
    if (!receipt || receipt.status !== 'accepted' || !this.hasThread(receipt.threadId, authority, receipt.commandType === 'thread.delete')) return null
    const effect = this.effect(commandId)
    const target = this.database.prepare('SELECT * FROM conversation_v2_command_targets WHERE command_id = ?').get(commandId) as CommandTarget | undefined
    if (receipt.commandType === 'thread.fork') {
      const relation = this.database.prepare(`SELECT child_thread_id FROM conversation_v2_thread_relations
        WHERE relation_id = ? AND parent_thread_id = ?`).get(commandId, receipt.threadId) as { child_thread_id: string } | undefined
      if (!relation) return null
      return {
        commandId, threadId: receipt.threadId, childThreadId: relation.child_thread_id,
        acceptedAt: receipt.acceptedAt, resultSequence: receipt.resultSequence, dispatch: 'completed',
      }
    }
    if (receipt.commandType === 'thread.delete') {
      const completed = isThreadDeletionComplete(target?.detail)
      return {
        commandId, threadId: receipt.threadId, acceptedAt: receipt.acceptedAt, resultSequence: receipt.resultSequence,
        dispatch: completed ? 'completed' : 'pending-reconciliation',
        ...(!completed && { detail: threadDeletionPendingMessage }),
      }
    }
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

  isArchived(threadId: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM conversation_v2_projection_threads WHERE thread_id = ? AND archived_at IS NOT NULL').get(threadId))
  }

  changeThread(
    input: Extract<ConversationThreadCommand, { type: 'thread.rename' | 'thread.pin' | 'thread.archive' | 'thread.delete' }>,
    authority: ConversationAuthority, deletionState: ThreadDeletionState = {}, hostEvents?: readonly ConversationLifecycleEvent[],
    updateRelation?: () => void,
  ): ConversationThreadCommandState {
    const row = this.database.prepare(`SELECT payload_json FROM conversation_v2_projection_threads
      WHERE thread_id = ? AND deleted_at IS NULL`).get(input.threadId) as { payload_json: string } | undefined
    if (!row) throw new DaemonError('E_CONFLICT', '原会话已删除。')
    const occurredAt = now()
    const current = JSON.parse(row.payload_json) as Record<string, unknown>
    if (input.type === 'thread.delete') {
      return this.commit(input, authority, { ...planThreadDeletion(this.database, input.threadId, current, occurredAt, deletionState), hostEvents })
    }
    if (input.type === 'thread.archive' && input.archived && this.database.prepare(`SELECT 1 FROM conversation_v2_effect_outbox
      WHERE thread_id = ? AND status IN ('pending', 'running') AND effect_type <> 'provider-runtime.continue' LIMIT 1`).get(input.threadId)) {
      throw new DaemonError('E_BUSY', '请先处理运行中、排队或待核对的消息。')
    }
    const change = (() => {
      switch (input.type) {
        case 'thread.rename': return { type: 'thread.metadata-updated', patch: { title: input.title } } as const
        case 'thread.pin': return { type: input.pinned ? 'thread.pinned' : 'thread.unpinned', patch: { pinnedAt: input.pinned ? occurredAt : null } } as const
        case 'thread.archive': return { type: input.archived ? 'thread.archived' : 'thread.unarchived', patch: { archivedAt: input.archived ? occurredAt : null } } as const
      }
    })()
    const next: Record<string, unknown> = { ...current, ...change.patch, updatedAt: occurredAt }
    const event = decodeEvent({ type: change.type, id: randomUUID(), threadId: input.threadId, occurredAt, payload: next })
    return this.commit(input, authority, {
      events: [event],
      hostEvents,
      apply: () => {
        this.database.prepare(`UPDATE conversation_v2_projection_threads SET title = ?, updated_at = ?,
          archived_at = ?, deleted_at = ?, payload_json = ? WHERE thread_id = ?`)
          .run(String(next.title), occurredAt, typeof next.archivedAt === 'string' ? next.archivedAt : null,
            typeof next.deletedAt === 'string' ? next.deletedAt : null, JSON.stringify(next), input.threadId)
        if (input.type === 'thread.archive' && input.archived) {
          this.database.prepare(`UPDATE conversation_v2_effect_outbox
            SET status = 'cancelled', last_error = '会话已归档，取消自动续接。', updated_at = ?, completed_at = ?
            WHERE thread_id = ? AND effect_type = 'provider-runtime.continue' AND status = 'pending'`)
            .run(occurredAt, occurredAt, input.threadId)
        }
        updateRelation?.()
      },
    })
  }

  /**
   * 持久更新会话的运行权限模式（`runtimeMode`）或交互模式（`interactionMode`），并发布元数据变更事件。
   */
  setThreadMode(
    input: Extract<ConversationThreadCommand, { type: 'thread.runtime-mode.set' | 'thread.interaction-mode.set' }>,
    authority: ConversationAuthority,
  ): ConversationThreadCommandState {
    const row = this.database.prepare(
      'SELECT payload_json, archived_at FROM conversation_v2_projection_threads WHERE thread_id = ? AND deleted_at IS NULL',
    ).get(input.threadId) as { payload_json: string; archived_at: string | null } | undefined
    if (!row) throw new DaemonError('E_CONFLICT', '原会话已删除。')
    if (row.archived_at !== null) throw new DaemonError('E_CONFLICT', '请先恢复已归档的会话。')
    const occurredAt = now()
    const current = JSON.parse(row.payload_json) as Record<string, unknown>
    const patch = input.type === 'thread.runtime-mode.set'
      ? { runtimeMode: input.runtimeMode }
      : { interactionMode: input.interactionMode }
    const next: Record<string, unknown> = { ...current, ...patch, updatedAt: occurredAt }
    const event = decodeEvent({ type: 'thread.metadata-updated', id: randomUUID(), threadId: input.threadId, occurredAt, payload: next })
    return this.commit(input, authority, {
      events: [event],
      apply: () => {
        if (input.type === 'thread.runtime-mode.set') {
          this.database.prepare(
            'UPDATE conversation_v2_projection_threads SET runtime_mode = ?, updated_at = ?, payload_json = ? WHERE thread_id = ?',
          ).run(input.runtimeMode, occurredAt, JSON.stringify(next), input.threadId)
        } else {
          this.database.prepare(
            'UPDATE conversation_v2_projection_threads SET interaction_mode = ?, updated_at = ?, payload_json = ? WHERE thread_id = ?',
          ).run(input.interactionMode, occurredAt, JSON.stringify(next), input.threadId)
        }
      },
    })
  }

  switchProvider(
    input: Extract<ConversationThreadCommand, { type: 'provider.switch' }>,
    authority: ConversationAuthority,
    selection: { readonly modelSelection: ModelSelection; readonly clearNativeBinding: boolean },
    clearBinding: (occurredAt: string) => void,
  ): ConversationThreadCommandState {
    const row = this.database.prepare(
      'SELECT payload_json, archived_at FROM conversation_v2_projection_threads WHERE thread_id = ? AND deleted_at IS NULL',
    ).get(input.threadId) as { payload_json: string; archived_at: string | null } | undefined
    if (!row) throw new DaemonError('E_CONFLICT', '原会话已删除。')
    if (row.archived_at !== null) throw new DaemonError('E_CONFLICT', '请先恢复已归档的会话。')
    const occurredAt = now()
    const current = JSON.parse(row.payload_json) as Record<string, unknown>
    const next: Record<string, unknown> = {
      ...current,
      providerInstanceId: selection.modelSelection.instanceId,
      modelSelection: selection.modelSelection,
      ...(selection.clearNativeBinding ? { activeProviderThreadId: null } : {}),
      updatedAt: occurredAt,
    }
    const event = decodeEvent({ type: 'thread.metadata-updated', id: randomUUID(), threadId: input.threadId, occurredAt, payload: next })
    return this.commit(input, authority, {
      events: [event],
      apply: () => {
        this.database.prepare(
          'UPDATE conversation_v2_projection_threads SET default_provider = ?, updated_at = ?, payload_json = ? WHERE thread_id = ?',
        ).run(selection.modelSelection.instanceId, occurredAt, JSON.stringify(next), input.threadId)
        clearBinding(occurredAt)
      },
    })
  }

  appendMessage(
    input: Extract<ConversationThreadCommand, { type: 'message.dispatch' | 'thread.handoff' }>, authority: ConversationAuthority, selection: DriverSelection,
    steer?: { targetRunId: string; targetAttemptId: string }, promptAttachments?: ConversationPromptAttachmentSupport,
    portableHistory?: readonly PortableHistory[], relations?: ThreadRelations,
    completion?: { readonly intent: DelegatedCompletionIntent; readonly runId: string; readonly plan: CommandPlan },
    manualContinuation?: { readonly sourceRunId: string; readonly promptText: string; readonly notification: OrchestrationV2Notification },
  ): ConversationThreadCommandState {
    const first = this.database.prepare('SELECT default_provider FROM conversation_v2_projection_threads WHERE thread_id = ?')
      .get(input.threadId) as { default_provider: string } | undefined
    if (input.type === 'thread.handoff') {
      if (!first) throw new DaemonError('E_CONFLICT', '找不到要接力的原会话。')
    } else if (first?.default_provider !== input.instanceId) throw new DaemonError('E_CONFLICT', '当前会话未连接所选引擎实例。')
    if (this.database.prepare(`SELECT 1 FROM conversation_v2_effect_outbox WHERE thread_id = ?
      AND status IN ('pending','running') AND json_extract(payload_json, '$.handoff') IS 1 LIMIT 1`).get(input.threadId)) {
      throw new DaemonError('E_BUSY', '原接力指令尚未确认，请按原命令核对。')
    }
    if (this.database.prepare('SELECT 1 FROM conversation_v2_projection_messages WHERE message_id = ?').get(input.messageId)) {
      throw new DaemonError('E_CONFLICT', '此消息编号已受理。')
    }
    const latest = this.database.prepare('SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM conversation_v2_projection_runs WHERE thread_id = ?')
      .get(input.threadId) as { ordinal: number }
    const { threadId, messageId, text } = input
    const attachmentClaim = input.type === 'message.dispatch' && !manualContinuation
      ? prepareConversationAttachmentClaim(this.attachmentStore, authority, input, threadId)
      : undefined
    assertPromptAttachments(attachmentClaim?.attachments, promptAttachments)
    const runId = completion?.runId ?? `run_${randomUUID()}`
    const requestedAt = now()
    const ordinal = latest.ordinal + 1
    const shiftedQueued = manualContinuation
      ? this.queuedRuns(threadId).map((queued, index) => ({
        runId: queued.run_id,
        payload: { ...JSON.parse(queued.payload_json), queuePosition: index + 2 },
      }))
      : []
    const run = {
      id: runId, threadId, ordinal, providerInstanceId: input.instanceId, modelSelection: selection.modelSelection,
      providerThreadId: null, userMessageId: messageId, rootNodeId: null, activeAttemptId: null, status: 'queued',
      requestedAt, startedAt: null, completedAt: null, checkpointId: null, contextHandoffId: null,
      ...(manualContinuation && {
        manualContinuationOfRunId: manualContinuation.sourceRunId,
        ...(shiftedQueued.length ? { queuePosition: 1 } : {}),
      }),
    }
    const message = {
      createdBy: completion ? 'agent' : 'user', creationSource: completion ? 'server' : 'web', id: messageId, threadId, runId, nodeId: null,
      role: completion || manualContinuation ? 'system' : 'user',
      text: manualContinuation ? manualContinuation.promptText : text,
      attachments: attachmentClaim?.attachments ?? [], streaming: false, createdAt: requestedAt, updatedAt: requestedAt,
      ...(completion && { delegatedCompletion: { parentRunId: completion.intent.parentRunId,
        generation: completion.intent.generation, taskIds: completion.intent.nodeIds } }),
      ...(manualContinuation && { notification: manualContinuation.notification }),
    }
    const base = { threadId, runId, occurredAt: requestedAt }
    const relation = !steer && relations?.childUpdate(threadId, 'queued', runId, requestedAt,
      { instanceId: input.instanceId, model: selection.modelSelection.model })
    return this.commit(input, authority, {
      receiptType: completion && 'delegated_task.completion-delivery',
      target: { run_id: runId, message_id: messageId, follows_run: 1 },
      events: [
        decodeEvent({ ...base, id: randomUUID(), type: 'run.created', payload: run }),
        decodeEvent({ ...base, id: randomUUID(), type: 'message.updated', payload: message }),
        ...shiftedQueued.map(item => decodeEvent({ id: randomUUID(), threadId, runId: item.runId, occurredAt: requestedAt, type: 'run.updated', payload: item.payload })),
        ...(completion?.plan.events ?? []),
      ],
      hostEvents: [
        ...(!steer && this.isPaused(threadId) ? [lifecycleEvent(threadId, { kind: 'queue', paused: false })] : []),
        ...(relation ? relation.hostEvents : []),
        ...(completion?.plan.hostEvents ?? []),
      ],
      apply: () => {
        attachmentClaim?.commit()
        if (relation) relation.apply()
        this.database.prepare(`INSERT INTO conversation_v2_projection_runs
          (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`)
          .run(runId, threadId, ordinal, selection.driverKind, input.instanceId, requestedAt, JSON.stringify(run))
        if (shiftedQueued.length) {
          const updateQueued = this.database.prepare('UPDATE conversation_v2_projection_runs SET payload_json = ? WHERE run_id = ?')
          for (const item of shiftedQueued) updateQueued.run(JSON.stringify(item.payload), item.runId)
        }
        this.database.prepare(`INSERT INTO conversation_v2_projection_messages
          (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`)
          .run(messageId, threadId, runId, message.role, requestedAt, requestedAt, JSON.stringify(message))
        this.database.prepare('UPDATE conversation_v2_projection_threads SET updated_at = ? WHERE thread_id = ?').run(requestedAt, threadId)
        this.database.prepare(`UPDATE conversation_v2_effect_outbox
          SET status = 'cancelled', last_error = '用户已发送新消息，跳过重启自动续接。', updated_at = ?, completed_at = ?
          WHERE thread_id = ? AND effect_type = 'provider-runtime.continue' AND status = 'pending'`)
          .run(requestedAt, requestedAt, threadId)
        this.insertEffect(input, steer ? 'provider-turn.steer' : 'provider-turn.start', {
          runId, configurationFingerprint: selection.configurationFingerprint, ...steer,
          ...(portableHistory?.length && { portableHistory }),
          ...(input.type === 'thread.handoff' && { handoff: true }),
          ...(completion && { delegatedCompletion: completion.intent }),
          ...(manualContinuation && { manualContinuationOfRunId: manualContinuation.sourceRunId }),
        }, requestedAt)
        if (completion) completion.plan.apply()
        else if (!steer) this.setPaused(threadId, false)
      },
    })
  }

  appendEditAndRerun(
    input: Extract<ConversationThreadCommand, { type: 'message.edit-and-rerun' }>,
    authority: ConversationAuthority,
    selection: DriverSelection,
    targetOrdinal: number,
    onTruncate: (occurredAt: string) => void,
    portableHistory?: readonly PortableHistory[],
  ): ConversationThreadCommandState {
    const { threadId, text } = input
    const requestedAt = now()
    const runId = `run_${randomUUID()}`
    const newMessageId = `msg_${randomUUID()}`
    const threadRow = this.database.prepare('SELECT title, payload_json FROM conversation_v2_projection_threads WHERE thread_id = ?')
      .get(threadId) as { title: string; payload_json: string } | undefined
    if (!threadRow) throw new DaemonError('E_CONFLICT', '找不到要重跑的原会话。')
    const currentThreadPayload = JSON.parse(threadRow.payload_json) as Record<string, unknown>
    const nextThreadPayload = {
      ...currentThreadPayload,
      defaultProvider: input.instanceId,
      modelSelection: selection.modelSelection,
      updatedAt: requestedAt,
    }
    const run = {
      id: runId,
      threadId,
      ordinal: targetOrdinal,
      providerInstanceId: input.instanceId,
      modelSelection: selection.modelSelection,
      providerThreadId: null,
      userMessageId: newMessageId,
      rootNodeId: null,
      activeAttemptId: null,
      status: 'queued',
      requestedAt,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    }
    const message = {
      createdBy: 'user',
      creationSource: 'web',
      id: newMessageId,
      threadId,
      runId,
      nodeId: null,
      role: 'user',
      text,
      attachments: [],
      streaming: false,
      createdAt: requestedAt,
      updatedAt: requestedAt,
    }
    const base = { threadId, runId, occurredAt: requestedAt }
    return this.commit(input, authority, {
      target: { run_id: runId, message_id: newMessageId, follows_run: 1 },
      events: [
        decodeEvent({ type: 'thread.metadata-updated', id: randomUUID(), threadId, occurredAt: requestedAt, payload: nextThreadPayload }),
        decodeEvent({ ...base, id: randomUUID(), type: 'run.created', payload: run }),
        decodeEvent({ ...base, id: randomUUID(), type: 'message.updated', payload: message }),
      ],
      hostEvents: [
        lifecycleEvent(threadId, { kind: 'thread-reset', reason: 'edit-and-rerun' }, runId, requestedAt),
        ...(this.isPaused(threadId) ? [lifecycleEvent(threadId, { kind: 'queue', paused: false }, runId, requestedAt)] : []),
      ],
      apply: () => {
        onTruncate(requestedAt)
        this.database.prepare('UPDATE conversation_v2_projection_threads SET default_provider = ?, updated_at = ?, payload_json = ? WHERE thread_id = ?')
          .run(input.instanceId, requestedAt, JSON.stringify(nextThreadPayload), threadId)
        this.database.prepare(`INSERT INTO conversation_v2_projection_runs
          (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`)
          .run(runId, threadId, targetOrdinal, selection.driverKind, input.instanceId, requestedAt, JSON.stringify(run))
        this.database.prepare(`INSERT INTO conversation_v2_projection_messages
          (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
          VALUES (?, ?, ?, 'user', 0, ?, ?, ?)`)
          .run(newMessageId, threadId, runId, requestedAt, requestedAt, JSON.stringify(message))
        this.database.prepare(`UPDATE conversation_v2_effect_outbox
          SET status = 'cancelled', last_error = '用户已编辑历史消息重跑，跳过原自动续接。', updated_at = ?, completed_at = ?
          WHERE thread_id = ? AND effect_type = 'provider-runtime.continue' AND status = 'pending'`)
          .run(requestedAt, requestedAt, threadId)
        this.insertEffect(input, 'provider-turn.start', {
          runId,
          configurationFingerprint: selection.configurationFingerprint,
          ...(portableHistory?.length && { portableHistory }),
        }, requestedAt)
        this.setPaused(threadId, false)
      },
    })
  }

  compact(
    input: Extract<ConversationThreadCommand, { type: 'thread.compact' }>, authority: ConversationAuthority,
    selection: DriverSelection, compaction: ConversationCompaction,
  ): ConversationThreadCommandState {
    const { threadId } = input
    const latest = this.database.prepare('SELECT MAX(ordinal) AS ordinal FROM conversation_v2_projection_runs WHERE thread_id = ?')
      .get(threadId) as { ordinal: number }
    const at = now()
    const runId = `run_${randomUUID()}`
    const run = {
      id: runId, threadId, ordinal: latest.ordinal + 1, providerInstanceId: selection.modelSelection.instanceId,
      modelSelection: selection.modelSelection, providerThreadId: null, userMessageId: `msg_${randomUUID()}`,
      rootNodeId: null, activeAttemptId: null, status: 'queued', requestedAt: at,
      startedAt: null, completedAt: null, checkpointId: null, contextHandoffId: null,
    }
    return this.commit(input, authority, {
      target: { run_id: runId, follows_run: 1 },
      events: [decodeEvent({ id: randomUUID(), threadId, runId, occurredAt: at, type: 'run.created', payload: run })],
      hostEvents: [lifecycleEvent(threadId, { kind: 'compaction', compaction }, runId, at)],
      apply: () => {
        this.database.prepare(`INSERT INTO conversation_v2_projection_runs
          (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`).run(runId, threadId, run.ordinal, selection.driverKind,
          selection.modelSelection.instanceId, at, JSON.stringify({ ...run, compaction }))
        this.insertEffect(input, 'provider-turn.start', { runId, configurationFingerprint: selection.configurationFingerprint, compaction }, at)
      },
    })
  }

  queue(input: Extract<ConversationThreadCommand, { type: 'queue.resume' | `queued-run.${string}` }>, authority: ConversationAuthority,
    promptAttachments?: ConversationPromptAttachmentSupport,
    relation?: Pick<CommandPlan, 'hostEvents' | 'apply'>): ConversationThreadCommandState {
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
      if (JSON.parse(run.payload_json).compaction || completionIntent(this.effectForRun(threadId, runId))) {
        throw new DaemonError('E_CONFLICT', '此宿主操作没有可编辑的消息。')
      }
      const message = this.readUserMessage(runId)
      const attachmentClaim = prepareConversationAttachmentClaim(this.attachmentStore, authority, input, threadId)
      assertPromptAttachments(attachmentClaim?.attachments, promptAttachments)
      const attachments = input.attachmentIds === undefined ? message.attachments : attachmentClaim?.attachments ?? []
      const payload = { ...message, text: input.text, attachments, updatedAt: occurredAt }
      return this.commit(input, authority, {
        target: { run_id: runId, message_id: message.id },
        events: [decodeEvent({ id: randomUUID(), threadId, runId, occurredAt, type: 'message.updated', payload })],
        apply: () => {
          attachmentClaim?.commit()
          this.database.prepare('UPDATE conversation_v2_projection_messages SET payload_json = ?, updated_at = ? WHERE message_id = ?')
            .run(JSON.stringify(payload), occurredAt, message.id)
        },
      })
    }
    if (type === 'queued-run.cancel') {
      const payload = { ...JSON.parse(run.payload_json), status: 'cancelled', completedAt: occurredAt }
      const remainingQueued = this.queuedRuns(threadId).some(queued => queued.run_id !== runId)
      const hasUnknownAttempt = this.database.prepare(`SELECT 1 FROM conversation_v2_effect_outbox effect
        JOIN conversation_v2_dispatch_attempts attempt ON attempt.effect_id = effect.effect_id
        WHERE effect.thread_id = ? AND effect.status = 'running' AND attempt.phase = 'unknown' LIMIT 1`).get(threadId) !== undefined
      const clearPause = !remainingQueued && !hasUnknownAttempt && this.isPaused(threadId)
      return this.commit(input, authority, {
        target: { run_id: runId },
        events: [decodeEvent({ id: randomUUID(), threadId, runId, occurredAt, type: 'run.updated', payload })],
        hostEvents: [
          ...(relation?.hostEvents ?? []),
          ...(clearPause ? [lifecycleEvent(threadId, { kind: 'queue', paused: false }, runId, occurredAt)] : []),
        ],
        apply: () => {
          this.database.prepare("UPDATE conversation_v2_projection_runs SET status = 'cancelled', completed_at = ?, payload_json = ? WHERE run_id = ?")
            .run(occurredAt, JSON.stringify(payload), runId)
          this.database.prepare(`UPDATE conversation_v2_effect_outbox SET status = 'cancelled', updated_at = ?, completed_at = ?
            WHERE thread_id = ? AND effect_type = 'provider-turn.start' AND json_extract(payload_json, '$.runId') = ? AND status = 'pending'`)
            .run(occurredAt, occurredAt, threadId, runId)
          if (clearPause) this.setPaused(threadId, false)
          relation?.apply()
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

  appendRestartContinuation(input: {
    readonly commandId: string
    readonly threadId: string
    readonly messageId: string
    readonly sourceRunId: string
    readonly text: string
    readonly notification: OrchestrationV2Notification
    readonly selection: DriverSelection
  }, authority: ConversationAuthority): { readonly runId: string; readonly commandId: string } {
    if (!this.hasThread(input.threadId, authority)) throw new DaemonError('E_DENIED', '此会话不在当前授权范围。')
    const latest = this.database.prepare('SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM conversation_v2_projection_runs WHERE thread_id = ?')
      .get(input.threadId) as { ordinal: number }
    const requestedAt = now()
    const runId = `run_${randomUUID()}`
    const ordinal = latest.ordinal + 1
    const run = {
      id: runId,
      threadId: input.threadId,
      ordinal,
      providerInstanceId: input.selection.modelSelection.instanceId,
      modelSelection: input.selection.modelSelection,
      providerThreadId: null,
      userMessageId: input.messageId,
      rootNodeId: null,
      activeAttemptId: null,
      status: 'queued',
      requestedAt,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
      restartContinuationOfRunId: input.sourceRunId,
    }
    const message = {
      createdBy: 'agent',
      creationSource: 'server',
      id: input.messageId,
      threadId: input.threadId,
      runId,
      nodeId: null,
      role: 'system',
      text: input.text,
      attachments: [],
      streaming: false,
      createdAt: requestedAt,
      updatedAt: requestedAt,
      notification: input.notification,
    }
    const base = { threadId: input.threadId, runId, occurredAt: requestedAt }
    const payloadDigest = commandPayloadDigest({
      type: 'restart.continue',
      threadId: input.threadId,
      sourceRunId: input.sourceRunId,
      messageId: input.messageId,
    })
    this.sink.commitCommand({
      commandId: input.commandId,
      threadId: input.threadId,
      commandType: 'message.dispatch',
      acceptedAt: requestedAt,
      payloadDigest,
      events: [
        decodeEvent({ ...base, id: randomUUID(), type: 'run.created', payload: run }),
        decodeEvent({ ...base, id: randomUUID(), type: 'message.updated', payload: message }),
      ],
      hostEvents: this.isPaused(input.threadId) ? [lifecycleEvent(input.threadId, { kind: 'queue', paused: false })] : [],
    }, () => {
      this.ensureControl(input.threadId, authority)
      this.database.prepare(`INSERT INTO conversation_v2_command_targets (command_id, run_id, message_id, request_id, follows_run, detail)
        VALUES (?, ?, ?, NULL, 1, NULL)`).run(input.commandId, runId, input.messageId)
      this.database.prepare(`INSERT INTO conversation_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`)
        .run(runId, input.threadId, ordinal, input.selection.driverKind, input.selection.modelSelection.instanceId, requestedAt, JSON.stringify(run))
      this.database.prepare(`INSERT INTO conversation_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (?, ?, ?, 'system', 0, ?, ?, ?)`)
        .run(input.messageId, input.threadId, runId, requestedAt, requestedAt, JSON.stringify(message))
      this.database.prepare('UPDATE conversation_v2_projection_threads SET updated_at = ? WHERE thread_id = ?')
        .run(requestedAt, input.threadId)
      this.insertEffect(
        { threadId: input.threadId, commandId: input.commandId },
        'provider-turn.start',
        { runId, configurationFingerprint: input.selection.configurationFingerprint, restartContinuationOfRunId: input.sourceRunId },
        requestedAt,
      )
      this.setPaused(input.threadId, false)
    }, () => {})
    return { runId, commandId: input.commandId }
  }

  readUserMessage(runId: string): { id: string; text: string; attachments?: readonly ChatAttachment[] } {
    const row = this.database.prepare(`SELECT payload_json FROM conversation_v2_projection_messages WHERE run_id = ? AND
      (role = 'user' OR (role = 'system' AND (
        json_extract(payload_json, '$.delegatedCompletion') IS NOT NULL
        OR json_extract(payload_json, '$.notification') IS NOT NULL
      ))) LIMIT 1`)
      .get(runId) as { payload_json: string } | undefined
    if (!row) throw new Error('The accepted run has no user message.')
    return JSON.parse(row.payload_json) as { id: string; text: string; attachments?: readonly ChatAttachment[] }
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
      commandId: input.commandId, threadId: input.threadId, commandType: plan.receiptType ?? input.type, acceptedAt: now(),
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
