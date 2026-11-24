import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import * as DateTime from 'effect/DateTime'
import * as Schema from 'effect/Schema'
import type { ConversationCommandReceipt, ConversationRunEvidence } from '../../../../shared/conversation/desktop'
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
import { ThreadCommands } from './ThreadCommands'
import type { ConversationAuthority } from '../../../../shared/conversation/desktop'
import type { ConversationRunLifecycle } from '../../../../shared/conversation/command-runtime'
import type { ConversationAttachmentReferences } from '../../../../shared/conversation/attachments'
import type { ConversationAttachmentStore } from '../attachments'
import { prepareConversationAttachmentClaim } from '../attachments/claims'
import { assertPromptAttachments, type ConversationPromptAttachmentSupport } from '../providers/core/attachment-input'

const newId = (prefix: string): string => `${prefix}_${randomUUID()}`

export interface NewThreadRequest extends ConversationAttachmentReferences {
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
const historyByteBudget = 1_048_576

/**
 * One command, one transaction: thread + first message + run + receipt + outbox commit together.
 * A repeated commandId replays the original receipt; a different payload under the same id conflicts.
 */
export class ThreadMessageIntake {
  constructor(
    private readonly database: DatabaseSync,
    private readonly eventSink: ConversationEventSink,
    private readonly commands = new ThreadCommands(database, eventSink),
    private readonly attachmentStore?: ConversationAttachmentStore,
  ) {}

  launchThread(input: NewThreadRequest & { readonly commandId: string }, authority?: ConversationAuthority, configurationFingerprint?: string,
    promptAttachments?: ConversationPromptAttachmentSupport): IntakeResult {
    const digest = commandPayloadDigest({ ...input, commandId: undefined })
    const existing = this.eventSink.readReceipt(input.commandId)
    if (existing) {
      if (existing.payloadDigest !== digest) return { conflict: 'The original command ID was reused with a different request.' }
      if (existing.status !== 'accepted') return { conflict: existing.error ?? 'The original command was rejected.' }
      if (authority && !this.commands.hasThread(existing.threadId, authority)) {
        return { conflict: 'The original command ID belongs to a different conversation scope.' }
      }
      const receipt = this.readCommand(input.commandId, input.ownerId, input.spaceId, input.projectId)
      if (!receipt) return { conflict: 'The original command has no readable thread.' }
      return { receipt, committed: false }
    }
    const timestamp = DateTime.nowUnsafe()
    const iso = DateTime.formatIso(timestamp)
    const threadId = newId('thr')
    const attachmentClaim = prepareConversationAttachmentClaim(this.attachmentStore, authority, input, threadId, true)
    assertPromptAttachments(attachmentClaim?.attachments, promptAttachments)
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
      role: 'user', text: input.text, attachments: attachmentClaim?.attachments ?? [], streaming: false, createdAt: timestamp, updatedAt: timestamp,
    })
    const events: OrchestrationV2DomainEvent[] = [
      { id: randomUUID() as never, threadId: threadId as never, occurredAt: timestamp, type: 'thread.created', payload: thread },
      { id: randomUUID() as never, threadId: threadId as never, runId: runId as never, occurredAt: timestamp, type: 'run.created', payload: run },
      { id: randomUUID() as never, threadId: threadId as never, runId: runId as never, occurredAt: timestamp, type: 'message.updated', payload: message },
    ]
    const resultSequence = this.commitCommand(input.commandId, digest, thread, run, message, events, iso, input, authority, configurationFingerprint, attachmentClaim?.commit)
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
    authority?: ConversationAuthority,
    configurationFingerprint?: string,
    claimAttachments?: () => void,
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
      if (authority) this.commands.ensureControl(threadId, authority)
      claimAttachments?.()
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
      `).run(randomUUID(), commandId, threadId, JSON.stringify({ runId, configurationFingerprint }), acceptedAt, acceptedAt, acceptedAt)
    })
  }

  readCommand(commandId: string, ownerId: string, spaceId: string, projectId: string): ConversationCommandReceipt | undefined {
    const row = this.database.prepare(`
      SELECT receipt.thread_id, receipt.accepted_at, receipt.result_sequence, run.run_id, message.message_id
      FROM conversation_v2_command_receipts receipt
      JOIN conversation_v2_projection_threads thread ON thread.thread_id = receipt.thread_id
      JOIN conversation_v2_projection_runs run ON run.thread_id = receipt.thread_id AND run.ordinal = 1
      JOIN conversation_v2_projection_messages message ON message.run_id = run.run_id AND message.role = 'user'
      WHERE receipt.command_id = ? AND receipt.command_type = 'thread.create' AND receipt.status = 'accepted' AND thread.owner_id = ?
        AND thread.space_id = ? AND thread.project_id = ? AND thread.deleted_at IS NULL
    `).get(commandId, ownerId, spaceId, projectId) as {
      thread_id: string; accepted_at: string; result_sequence: number; run_id: string; message_id: string
    } | undefined
    return row && { threadId: row.thread_id, runId: row.run_id, commandId, messageId: row.message_id, acceptedAt: row.accepted_at, resultSequence: row.result_sequence }
  }

  /** A thread list is scoped to its owner, space and project; titles can quote user input. */
  listThreads(ownerId: string, spaceId: string, projectId: string, filter?: { archived?: boolean; query?: string }): OrchestrationV2AppThread[] {
    const query = filter?.query ?? ''
    const rows = this.database.prepare(`SELECT thread.payload_json FROM conversation_v2_projection_threads thread
      WHERE thread.owner_id = ? AND thread.space_id = ? AND thread.project_id = ? AND thread.deleted_at IS NULL
      AND (thread.archived_at IS NOT NULL) = ?
      AND (? = '' OR instr(lower(thread.title), lower(?)) > 0 OR EXISTS (
        SELECT 1 FROM conversation_v2_projection_messages message WHERE message.thread_id = thread.thread_id
        AND instr(lower(json_extract(message.payload_json, '$.text')), lower(?)) > 0
      ))
      ORDER BY json_extract(thread.payload_json, '$.pinnedAt') DESC NULLS LAST, thread.updated_at DESC LIMIT 100`)
      .all(ownerId, spaceId, projectId, Number(filter?.archived ?? false), query, query, query) as Array<{ payload_json: string }>
    return rows.map(row => decodeThread(JSON.parse(row.payload_json)))
  }

  readThread(threadId: string): (ReturnType<ThreadMessageIntake['readHistory']> & { thread: OrchestrationV2AppThread }) | undefined {
    const threadRow = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_threads WHERE thread_id = ?').get(threadId) as { payload_json: string } | undefined
    if (!threadRow) return undefined
    return { thread: decodeThread(JSON.parse(threadRow.payload_json)), ...this.readHistory(threadId, Number.MAX_SAFE_INTEGER, 32) }
  }

  readHistory(threadId: string, beforeRunOrdinal: number, limit: number): {
    messages: OrchestrationV2ConversationMessage[]
    runs: Array<OrchestrationV2Run & ConversationRunEvidence & { lifecycle?: ConversationRunLifecycle }>
    hasOlder: boolean
  } {
    const runRows = this.database.prepare(`SELECT run.run_id, run.payload_json, attempt.foreground_ended, attempt.background_running,
      attempt.stop_requested, attempt.phase, terminal.status AS terminal_status, terminal.observed_at AS terminal_at,
      terminal.native_turn_id AS terminal_turn_id FROM conversation_v2_projection_runs run
      LEFT JOIN conversation_v2_effect_outbox effect ON effect.thread_id = run.thread_id AND effect.effect_type = 'provider-turn.start'
        AND json_extract(effect.payload_json, '$.runId') = run.run_id
      LEFT JOIN conversation_v2_dispatch_attempts attempt ON attempt.effect_id = effect.effect_id
      LEFT JOIN conversation_v2_native_terminal_evidence terminal ON terminal.effect_id = effect.effect_id
      WHERE run.thread_id = ? AND run.ordinal < ? ORDER BY run.ordinal DESC LIMIT ?`)
      .all(threadId, beforeRunOrdinal, limit + 1) as Array<{
      run_id: string; payload_json: string; foreground_ended: number | null; background_running: number | null
      stop_requested: number | null; phase: string | null
      terminal_status: string | null; terminal_at: string | null; terminal_turn_id: string | null
    }>
    const messages: OrchestrationV2ConversationMessage[] = []
    const runs: Array<OrchestrationV2Run & ConversationRunEvidence & { lifecycle?: ConversationRunLifecycle }> = []
    const readMessages = this.database.prepare(`SELECT payload_json FROM conversation_v2_projection_messages
      WHERE thread_id = ? AND run_id = ? ORDER BY created_at, message_id`)
    let bytes = 0
    for (const row of runRows.slice(0, limit)) {
      const entries = readMessages.all(threadId, row.run_id) as Array<{ payload_json: string }>
      const batchBytes = entries.reduce((size, entry) => size + Buffer.byteLength(entry.payload_json), Buffer.byteLength(row.payload_json))
      if (runs.length && bytes + batchBytes > historyByteBudget) break
      bytes += batchBytes
      const raw = JSON.parse(row.payload_json) as Record<string, unknown>
      runs.unshift({
        ...decodeRun(raw),
        ...(typeof raw.failure === 'string' ? { failure: raw.failure } : {}),
        ...(raw.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
        ...(typeof raw.outcomeUnknownAt === 'string' ? { outcomeUnknownAt: raw.outcomeUnknownAt } : {}),
        ...(typeof raw.nativeTurnId === 'string' ? { nativeTurnId: raw.nativeTurnId } : {}),
        ...(typeof raw.nativeStartedAt === 'string' ? { nativeStartedAt: raw.nativeStartedAt } : {}),
        ...(typeof raw.engineAcceptedAt === 'string' ? { engineAcceptedAt: raw.engineAcceptedAt } : {}),
        ...(typeof raw.firstOutputAt === 'string' ? { firstOutputAt: raw.firstOutputAt } : {}),
        ...(row.phase !== null ? { lifecycle: {
          foregroundEnded: row.foreground_ended === 1,
          backgroundRunning: row.background_running === 1 && row.phase !== 'settled',
          stopRequested: row.stop_requested === 1,
          ...(row.terminal_status && row.terminal_at ? { terminalEvidence: {
            status: row.terminal_status, observedAt: row.terminal_at,
            ...(row.terminal_turn_id ? { nativeTurnId: row.terminal_turn_id } : {}),
          } } : {}),
        } } : {}),
      })
      messages.unshift(...entries.map(entry => decodeMessage(JSON.parse(entry.payload_json))))
    }
    return { messages, runs, hasOlder: runs.length < runRows.length }
  }
}
