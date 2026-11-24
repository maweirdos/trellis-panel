import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import * as Schema from 'effect/Schema'
import { z } from 'zod'
import { OrchestrationV2DomainEventJson, type ModelSelection, type ProviderDriverKind } from '../../../../shared/conversation/contracts'
import type { ConversationAuthority } from '../../../../shared/conversation/desktop'
import type { ConversationDelegationReply, ConversationThreadRelation } from '../../../../shared/conversation/thread-relations'
import { DaemonError } from '../../../daemon/errors'
import { commandPayloadDigest } from '../persistence/event-store'
import type { ConversationEventSink } from './EventSink'
import { lifecycleEvent, type ThreadCommands } from './ThreadCommands'

const id = z.string().min(1).max(200)
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)
export const delegateTaskArguments = z.strictObject({
  task: z.string().trim().min(1).max(16_000),
  title: z.string().trim().min(1).max(200).optional(),
  mode: z.enum(['async', 'wait']).optional(),
  timeoutMs: z.number().optional(),
})
export const DEFAULT_DELEGATION_WAIT_MS = 30_000
export const MAX_DELEGATION_WAIT_MS = 45_000
export const taskStatusArguments = z.strictObject({ taskId: id })
export const taskRespondArguments = z.strictObject({
  taskId: id, requestId: id, generation: z.number().int().positive().safe(),
  answers: z.record(id, z.union([z.string().max(4_000), z.array(z.string().max(4_000)).max(32)])),
})

export function delegationOperationId(parts: readonly string[]): string {
  return `delegate_${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
}

export interface DelegationParent {
  readonly threadId: string
  readonly runId: string
  readonly attemptId: string
  readonly nativeThreadId: string
  readonly nativeTurnId: string
  readonly selection: ModelSelection
  readonly driverKind: ProviderDriverKind
  readonly fingerprint: string
}

export class DelegatedWork {
  constructor(private readonly database: DatabaseSync, private readonly commands: ThreadCommands, private readonly sink: ConversationEventSink) {
    database.exec(`CREATE TABLE IF NOT EXISTS conversation_v2_delegation_calls (
      call_id TEXT PRIMARY KEY, intent_digest TEXT NOT NULL, reply_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS conversation_v2_delegation_authority (
      task_id TEXT PRIMARY KEY REFERENCES conversation_v2_thread_relations(relation_id),
      parent_attempt_id TEXT NOT NULL REFERENCES conversation_v2_dispatch_attempts(attempt_id)
    ) STRICT;`)
  }

  matchesOriginalAttempt(relation: ConversationThreadRelation, attemptId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM conversation_v2_delegation_authority authority
      JOIN conversation_v2_projection_nodes node ON node.node_id = ? AND node.thread_id = ? AND node.run_id = ?
      WHERE authority.task_id = ? AND authority.parent_attempt_id = ?`)
      .get(relation.parentNodeId ?? null, relation.parentThreadId, relation.parentRunId ?? null, relation.id, attemptId))
  }

  readReply(operationId: string, intent: unknown): ConversationDelegationReply | undefined {
    const row = this.database.prepare(`SELECT intent_digest, reply_json FROM conversation_v2_delegation_calls WHERE call_id = ?`)
      .get(operationId) as { intent_digest: string; reply_json: string } | undefined
    if (!row) return undefined
    if (row.intent_digest !== commandPayloadDigest(intent)) throw new DaemonError('E_CONFLICT', '同一委派工具调用编号已有其他内容。')
    return JSON.parse(row.reply_json) as ConversationDelegationReply
  }

  writeReply(operationId: string, intent: unknown, reply: ConversationDelegationReply): void {
    this.database.prepare('INSERT INTO conversation_v2_delegation_calls(call_id, intent_digest, reply_json) VALUES (?, ?, ?)')
      .run(operationId, commandPayloadDigest(intent), JSON.stringify(reply))
  }

  request(operationId: string, parent: DelegationParent, authority: ConversationAuthority, input: z.infer<typeof delegateTaskArguments>,
    intent: unknown) {
    if (this.database.prepare(`SELECT 1 FROM conversation_v2_thread_relations relation
      LEFT JOIN conversation_v2_projection_threads child ON child.thread_id = relation.child_thread_id
      WHERE relation.parent_thread_id = ? AND (relation.child_thread_id IS NULL OR child.deleted_at IS NULL)
      LIMIT 1 OFFSET 127`).get(parent.threadId) || this.database.prepare(`SELECT 1 FROM conversation_v2_thread_relations
      WHERE parent_thread_id = ? AND json_extract(payload_json, '$.parentRunId') = ?
        AND json_extract(payload_json, '$.kind') = 'delegated' LIMIT 1 OFFSET 7`).get(parent.threadId, parent.runId)) {
      throw new DaemonError('E_BUSY', '当前回合的委派数量已达上限。')
    }
    const source = this.database.prepare(`SELECT payload_json FROM conversation_v2_projection_threads WHERE thread_id = ? AND deleted_at IS NULL`)
      .get(parent.threadId) as { payload_json: string } | undefined
    if (!source) throw new DaemonError('E_DENIED', '原委派线程已不可用。')
    const { lineage } = JSON.parse(source.payload_json) as { lineage: { rootThreadId: string } }
    const { instanceId, model } = parent.selection
    const titleSeed = Array.from(input.title ?? input.task)
    const title = titleSeed.length > 72 ? `${titleSeed.slice(0, 69).join('')}...` : titleSeed.join('')
    const childThreadId = `thr_${randomUUID()}`
    const childRunId = `run_${randomUUID()}`
    const messageId = `msg_${randomUUID()}`
    const parentNodeId = `node_${operationId}`
    const at = new Date().toISOString()
    const parentNode = {
      id: parentNodeId, threadId: parent.threadId, runId: parent.runId, parentNodeId: null, rootNodeId: parentNodeId,
      kind: 'subagent', status: 'running', countsForRun: false,
      providerThreadId: parent.nativeThreadId, providerTurnId: parent.nativeTurnId,
      nativeItemRef: null, runtimeRequestId: null, checkpointScopeId: null, startedAt: at, completedAt: null,
    }
    const thread = {
      createdBy: 'agent', creationSource: 'mcp', id: childThreadId, projectId: authority.projectId, title,
      providerInstanceId: instanceId, modelSelection: parent.selection, runtimeMode: 'approval-required', interactionMode: 'default',
      branch: null, worktreePath: null, activeProviderThreadId: null,
      lineage: { parentThreadId: parent.threadId, relationshipToParent: 'subagent', rootThreadId: lineage.rootThreadId },
      forkedFrom: { type: 'node', nodeId: parentNodeId }, createdAt: at, updatedAt: at,
      archivedAt: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
    }
    const run = {
      id: childRunId, threadId: childThreadId, ordinal: 1, providerInstanceId: instanceId,
      modelSelection: parent.selection, providerThreadId: null, userMessageId: messageId, rootNodeId: null, activeAttemptId: null,
      status: 'queued', requestedAt: at, startedAt: null, completedAt: null, checkpointId: null, contextHandoffId: null,
    }
    const message = {
      createdBy: 'agent', creationSource: 'mcp', id: messageId, threadId: childThreadId, runId: childRunId,
      nodeId: null, role: 'user', text: input.task, attachments: [], streaming: false, createdAt: at, updatedAt: at,
    }
    const relation: ConversationThreadRelation = {
      id: operationId, kind: 'delegated', parentThreadId: parent.threadId, rootThreadId: lineage.rootThreadId,
      parentRunId: parent.runId, parentNodeId, childThreadId, childRunId,
      title, instanceId, model, status: 'queued', access: 'read-only', createdAt: at, updatedAt: at,
      completionWake: input.mode === 'wait' ? 'settled_only' : 'always',
    }
    const reply = { success: true, text: JSON.stringify({ taskId: relation.id, childThreadId, childRunId, status: relation.status }) }
    this.sink.commitCommand({
      commandId: operationId, threadId: parent.threadId, commandType: 'delegated_task.request',
      acceptedAt: at, payloadDigest: commandPayloadDigest(input),
      events: [
        decodeEvent({ id: randomUUID(), threadId: parent.threadId, runId: parent.runId, nodeId: parentNodeId, occurredAt: at,
          type: 'node.updated', payload: parentNode }),
        decodeEvent({ id: randomUUID(), threadId: childThreadId, occurredAt: at, type: 'thread.created', payload: thread }),
        decodeEvent({ id: randomUUID(), threadId: childThreadId, runId: childRunId, occurredAt: at, type: 'run.created', payload: run }),
        decodeEvent({ id: randomUUID(), threadId: childThreadId, runId: childRunId, occurredAt: at, type: 'message.updated', payload: message }),
      ],
      hostEvents: [lifecycleEvent(parent.threadId, { kind: 'relation', relation }, parent.runId, at)],
    }, () => {
      this.database.prepare(`INSERT INTO conversation_v2_projection_nodes
        (node_id, thread_id, run_id, root_node_id, kind, status, provider, provider_instance_id, provider_thread_id, provider_turn_id, started_at, payload_json)
        VALUES (?, ?, ?, ?, 'subagent', 'running', ?, ?, ?, ?, ?, ?)`)
        .run(parentNodeId, parent.threadId, parent.runId, parentNodeId, parent.driverKind, instanceId,
          parent.nativeThreadId, parent.nativeTurnId, at, JSON.stringify(parentNode))
      this.database.prepare(`INSERT INTO conversation_v2_projection_threads
        (thread_id, project_id, owner_id, space_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, 'approval-required', 'default', ?, ?, ?)`)
        .run(childThreadId, authority.projectId, authority.ownerId, authority.spaceId, title, instanceId, at, at, JSON.stringify(thread))
      this.commands.ensureControl(childThreadId, authority)
      this.database.prepare(`INSERT INTO conversation_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
        VALUES (?, ?, 1, ?, ?, 'queued', ?, ?)`).run(childRunId, childThreadId, parent.driverKind, instanceId, at, JSON.stringify(run))
      this.database.prepare(`INSERT INTO conversation_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (?, ?, ?, 'user', 0, ?, ?, ?)`).run(messageId, childThreadId, childRunId, at, at, JSON.stringify(message))
      this.database.prepare(`INSERT INTO conversation_v2_thread_relations
        (relation_id, parent_thread_id, child_thread_id, created_at, payload_json) VALUES (?, ?, ?, ?, ?)`)
        .run(relation.id, parent.threadId, childThreadId, at, JSON.stringify(relation))
      this.database.prepare(`INSERT INTO conversation_v2_delegation_authority (task_id, parent_attempt_id)
        VALUES (?, ?)`).run(relation.id, parent.attemptId)
      this.writeReply(operationId, intent, reply)
    }, () => {
      this.commands.insertEffect({ threadId: childThreadId, commandId: operationId }, 'provider-turn.start',
        { runId: childRunId, configurationFingerprint: parent.fingerprint }, at)
    })
    return { relation, reply }
  }
}
