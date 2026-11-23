import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import * as DateTime from 'effect/DateTime'
import * as Schema from 'effect/Schema'
import type { ConversationCommandReceipt } from '../../../../shared/conversation/desktop'
import {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2AppThreadJson,
  OrchestrationV2RunJson,
  OrchestrationV2ConversationMessageJson,
  type ModelSelection,
  type ProviderDriverKind,
} from '../../../../shared/conversation/contracts'
import { commandPayloadDigest } from '../persistence/event-store'
import { ConversationEventSink } from './EventSink'

const newId = (prefix: string): string => `${prefix}_${randomUUID()}`

export interface NewThreadRequest {
  readonly projectId: string
  readonly ownerId: string
  readonly spaceId: string
  readonly title: string
  readonly text: string
  readonly driverKind: ProviderDriverKind
  readonly modelSelection: ModelSelection
  readonly messageId?: string
  readonly runtimeMode?: 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'
  readonly interactionMode?: 'default' | 'plan'
}

export type IntakeResult = { readonly receipt: ConversationCommandReceipt; readonly committed: boolean } | { readonly conflict: string }

const decodeThread = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson)
const decodeThreadEvent = Schema.decodeUnknownSync(OrchestrationV2AppThread)
const decodeRun = Schema.decodeUnknownSync(OrchestrationV2RunJson)
const decodeRunEvent = Schema.decodeUnknownSync(OrchestrationV2Run)
const decodeMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessageJson)
const decodeMessageEvent = Schema.decodeUnknownSync(OrchestrationV2ConversationMessage)
const encodeThread = Schema.encodeSync(OrchestrationV2AppThreadJson)
const encodeRun = Schema.encodeSync(OrchestrationV2RunJson)
const encodeMessage = Schema.encodeSync(OrchestrationV2ConversationMessageJson)

const threadJson = (value: unknown) => JSON.stringify(encodeThread(value as never))
const runJson = (value: unknown) => JSON.stringify(encodeRun(value as never))
const messageJson = (value: unknown) => JSON.stringify(encodeMessage(value as never))

/**
 * One command, one transaction: thread + first message + run + receipt + outbox commit together.
 * A repeated commandId replays the original receipt; a different payload under the same id conflicts.
 */
export class ThreadMessageIntake {
  constructor(private readonly database: DatabaseSync, private readonly eventSink: ConversationEventSink) {}

  launchThread(input: NewThreadRequest & { readonly commandId: string }): IntakeResult {
    const digest = commandPayloadDigest({ ...input, commandId: undefined })
    const existing = this.eventSink.readReceipt(input.commandId)
    if (existing) {
      if (existing.payloadDigest !== digest) return { conflict: 'The original command ID was reused with a different request.' }
      if (existing.status !== 'accepted') return { conflict: existing.error ?? 'The original command was rejected.' }
      const receipt = this.readCommand(input.commandId, input.ownerId, input.spaceId, input.projectId)
      if (!receipt) return { conflict: 'The original command has no readable thread.' }
      return { receipt, committed: false }
    }
    const timestamp = DateTime.nowUnsafe()
    const iso = DateTime.formatIso(timestamp)
    const threadId = newId('thr')
    const runId = newId('run')
    const messageId = input.messageId ?? newId('msg')
    const runtimeMode = input.runtimeMode ?? 'approval-required'
    const interactionMode = input.interactionMode ?? 'default'
    const title = input.title.trim() || input.text.trim().slice(0, 80) || '新对话'
    const thread = decodeThreadEvent({
      createdBy: 'user', creationSource: 'web', id: threadId, projectId: input.projectId, title,
      providerInstanceId: input.modelSelection.instanceId, modelSelection: input.modelSelection,
      runtimeMode, interactionMode, branch: null, worktreePath: null, activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null, createdAt: timestamp, updatedAt: timestamp, archivedAt: null, settledAt: null,
      lastVisitedAt: null, deletedAt: null,
    })
    const run = decodeRunEvent({
      id: runId, threadId, ordinal: 1, providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection, providerThreadId: null, userMessageId: messageId,
      rootNodeId: null, activeAttemptId: null, status: 'queued', requestedAt: timestamp,
      startedAt: null, completedAt: null, checkpointId: null, contextHandoffId: null,
    })
    const message = decodeMessageEvent({
      createdBy: 'user', creationSource: 'web', id: messageId, threadId, runId, nodeId: null,
      role: 'user', text: input.text, attachments: [], streaming: false, createdAt: timestamp, updatedAt: timestamp,
    })
    const events: OrchestrationV2DomainEvent[] = [
      { id: randomUUID() as never, threadId: threadId as never, occurredAt: timestamp, type: 'thread.created', payload: thread },
      { id: randomUUID() as never, threadId: threadId as never, runId: runId as never, occurredAt: timestamp, type: 'run.created', payload: run },
      { id: randomUUID() as never, threadId: threadId as never, runId: runId as never, occurredAt: timestamp, type: 'message.updated', payload: message },
    ]
    const resultSequence = this.commitCommand(input.commandId, digest, thread, run, message, events, iso, input)
    return { receipt: { threadId, runId, commandId: input.commandId, messageId, acceptedAt: iso, resultSequence }, committed: true }
  }

  private commitCommand(
    commandId: string,
    payloadDigest: string,
    thread: typeof OrchestrationV2AppThread.Type,
    run: typeof OrchestrationV2Run.Type,
    message: typeof OrchestrationV2ConversationMessage.Type,
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
    acceptedAt: string,
    scope: NewThreadRequest,
  ): number {
    const threadId = thread.id
    const runId = run.id
    return this.eventSink.commitCommand({
      commandId, threadId, commandType: 'thread.create', payloadDigest, acceptedAt, events,
    }, () => {
      this.database.prepare(`
        INSERT INTO conversation_v2_projection_threads (
          thread_id, project_id, owner_id, space_id, title, default_provider, runtime_mode, interaction_mode,
          active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?)
      `).run(threadId, scope.projectId, scope.ownerId, scope.spaceId, thread.title, scope.modelSelection.instanceId,
        thread.runtimeMode, thread.interactionMode, acceptedAt, acceptedAt, threadJson(thread))
      this.database.prepare(`
        INSERT INTO conversation_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id, status, requested_at, completed_at, payload_json
        ) VALUES (?, ?, 1, ?, ?, NULL, 'queued', ?, NULL, ?)
      `).run(runId, threadId, scope.driverKind, scope.modelSelection.instanceId, acceptedAt, runJson(run))
      this.database.prepare(`
        INSERT INTO conversation_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
        ) VALUES (?, ?, ?, NULL, 'user', 0, ?, ?, ?)
      `).run(message.id, threadId, runId, acceptedAt, acceptedAt, messageJson(message))
    }, () => {
      this.database.prepare(`
        INSERT INTO conversation_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
        VALUES (?, ?, ?, 'provider-turn.start', ?, 'pending', ?, ?, ?)
      `).run(randomUUID(), commandId, threadId, JSON.stringify({ runId }), acceptedAt, acceptedAt, acceptedAt)
    })
  }

  readCommand(commandId: string, ownerId: string, spaceId: string, projectId: string): ConversationCommandReceipt | undefined {
    const row = this.database.prepare(`
      SELECT receipt.thread_id, receipt.accepted_at, receipt.result_sequence, run.run_id, message.message_id
      FROM conversation_v2_command_receipts receipt
      JOIN conversation_v2_projection_threads thread ON thread.thread_id = receipt.thread_id
      JOIN conversation_v2_projection_runs run ON run.thread_id = receipt.thread_id AND run.ordinal = 1
      JOIN conversation_v2_projection_messages message ON message.run_id = run.run_id AND message.role = 'user'
      WHERE receipt.command_id = ? AND receipt.status = 'accepted' AND thread.owner_id = ?
        AND thread.space_id = ? AND thread.project_id = ? AND thread.deleted_at IS NULL
    `).get(commandId, ownerId, spaceId, projectId) as {
      thread_id: string; accepted_at: string; result_sequence: number; run_id: string; message_id: string
    } | undefined
    return row && { threadId: row.thread_id, runId: row.run_id, commandId, messageId: row.message_id, acceptedAt: row.accepted_at, resultSequence: row.result_sequence }
  }

  /** A thread list is scoped to its owner, space and project; titles can quote user input. */
  listThreads(ownerId: string, spaceId: string, projectId: string): OrchestrationV2AppThread[] {
    const rows = this.database.prepare(
      'SELECT payload_json FROM conversation_v2_projection_threads WHERE owner_id = ? AND space_id = ? AND project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100',
    ).all(ownerId, spaceId, projectId) as Array<{ payload_json: string }>
    return rows.map(row => decodeThread(JSON.parse(row.payload_json)))
  }

  readThread(threadId: string): { thread: OrchestrationV2AppThread; messages: OrchestrationV2ConversationMessage[]; runs: OrchestrationV2Run[] } | undefined {
    const threadRow = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_threads WHERE thread_id = ?').get(threadId) as { payload_json: string } | undefined
    if (!threadRow) return undefined
    const messageRows = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_messages WHERE thread_id = ? ORDER BY created_at, message_id').all(threadId) as Array<{ payload_json: string }>
    const runRows = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal').all(threadId) as Array<{ payload_json: string }>
    return {
      thread: decodeThread(JSON.parse(threadRow.payload_json)),
      messages: messageRows.map(row => decodeMessage(JSON.parse(row.payload_json))),
      // Failure and unknown-outcome evidence are host extensions; keep them beside the contract run.
      runs: runRows.map(row => {
        const raw = JSON.parse(row.payload_json) as Record<string, unknown>
        const run = decodeRun(raw as never)
        return {
          ...run,
          ...(typeof raw.failure === 'string' ? { failure: raw.failure } : {}),
          ...(raw.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
          ...(typeof raw.nativeTurnId === 'string' ? { nativeTurnId: raw.nativeTurnId } : {}),
          ...(typeof raw.engineAcceptedAt === 'string' ? { engineAcceptedAt: raw.engineAcceptedAt } : {}),
          ...(typeof raw.firstOutputAt === 'string' ? { firstOutputAt: raw.firstOutputAt } : {}),
        }
      }),
    }
  }
}
