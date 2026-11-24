import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import * as Schema from 'effect/Schema'
import { OrchestrationV2DomainEventJson } from '../../../../shared/conversation/contracts'
import type { ConversationThreadCommand } from '../../../../shared/conversation/command-runtime'
import type { ConversationAuthority } from '../../../../shared/conversation/desktop'
import type { ConversationNativeSubagentEvent, ConversationThreadRelation, ConversationThreadRelations } from '../../../../shared/conversation/thread-relations'
import { DaemonError } from '../../../daemon/errors'
import { lifecycleEvent, type ThreadCommands } from './ThreadCommands'
import type { ContextHandoff, PortableHistory } from './ContextHandoff'
import type { ConversationEventSink } from './EventSink'

type ForkCommand = Extract<ConversationThreadCommand, { type: 'thread.fork' }>
type ForkSourceRun = { run_id: string; ordinal: number; status: string; provider_instance_id: string }
type ThreadRow = { payload_json: string }
type RelationRow = { payload_json: string }
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)
const stableStatuses = ['completed', 'failed', 'interrupted', 'cancelled']
const maxChildren = 128

export class ThreadRelations {
  constructor(private readonly database: DatabaseSync, private readonly commands: ThreadCommands,
    private readonly context: ContextHandoff) {
    database.exec(`CREATE TABLE IF NOT EXISTS conversation_v2_thread_relations (
      relation_id TEXT PRIMARY KEY, parent_thread_id TEXT NOT NULL REFERENCES conversation_v2_projection_threads(thread_id),
      child_thread_id TEXT UNIQUE REFERENCES conversation_v2_projection_threads(thread_id), created_at TEXT NOT NULL,
      source_ordinal INTEGER, fork_context_json TEXT, payload_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS conversation_v2_thread_relations_parent
      ON conversation_v2_thread_relations(parent_thread_id, created_at, relation_id);`)
  }

  read(threadId: string): ConversationThreadRelations {
    const child = this.database.prepare(`SELECT relation.payload_json FROM conversation_v2_thread_relations relation
      JOIN conversation_v2_projection_threads parent ON parent.thread_id = relation.parent_thread_id
      WHERE relation.child_thread_id = ? AND parent.deleted_at IS NULL`).get(threadId) as RelationRow | undefined
    const children = this.database.prepare(`SELECT relation.payload_json FROM conversation_v2_thread_relations relation
      LEFT JOIN conversation_v2_projection_threads child ON child.thread_id = relation.child_thread_id
      WHERE relation.parent_thread_id = ? AND (relation.child_thread_id IS NULL OR child.deleted_at IS NULL)
      ORDER BY relation.created_at DESC, relation.relation_id DESC LIMIT ?`).all(threadId, maxChildren) as RelationRow[]
    return {
      parent: child ? this.decode(child) : null,
      children: children.map(row => this.decode(row)),
    }
  }

  private decode(row: RelationRow): ConversationThreadRelation {
    return JSON.parse(row.payload_json) as ConversationThreadRelation
  }

  planFork(command: ForkCommand, authority: ConversationAuthority) {
    const { threadId, targetThreadId } = command
    if (this.database.prepare('SELECT 1 FROM conversation_v2_projection_threads WHERE thread_id = ?').get(targetThreadId)) {
      throw new DaemonError('E_CONFLICT', '目标会话编号已使用。')
    }
    const row = this.database.prepare(`SELECT payload_json FROM conversation_v2_projection_threads
      WHERE thread_id = ? AND deleted_at IS NULL`).get(threadId) as ThreadRow | undefined
    if (!row) throw new DaemonError('E_DENIED', '原会话不可用。')
    const source = JSON.parse(row.payload_json) as {
      title: string; providerInstanceId: string; runtimeMode: string; interactionMode: string
      modelSelection: { instanceId: string; model: string }; delegatedFrom?: unknown
      lineage: { rootThreadId: string; sideChat?: boolean; relationshipToParent?: string }
    }
    if (command.sideChat && (source.lineage.sideChat || source.lineage.relationshipToParent === 'subagent' || source.delegatedFrom)) {
      throw new DaemonError('E_CONFLICT', '侧聊和子代理会话不能再开侧聊。')
    }
    if (this.database.prepare(`SELECT 1 FROM conversation_v2_thread_relations relation
      LEFT JOIN conversation_v2_projection_threads child ON child.thread_id = relation.child_thread_id
      WHERE relation.parent_thread_id = ? AND (relation.child_thread_id IS NULL OR child.deleted_at IS NULL)
      LIMIT 1 OFFSET ?`).get(threadId, maxChildren - 1)) {
      throw new DaemonError('E_BUSY', '原会话的关联项已达上限。')
    }
    const sourceRun = this.forkRun(command)
    const portable = this.context.capture({ threadId }, authority, sourceRun?.ordinal ?? 1, !sourceRun)
    const at = new Date().toISOString()
    const selection = command.selection ?? source.modelSelection
    const title = command.title ?? (command.sideChat ? '侧聊' : `${source.title.slice(0, 490)} · 分支`)
    const isSideChat = command.sideChat === true
    const thread = {
      createdBy: 'user', creationSource: 'web', id: targetThreadId, projectId: authority.projectId, title,
      providerInstanceId: selection.instanceId, modelSelection: selection,
      runtimeMode: source.runtimeMode, interactionMode: source.interactionMode,
      branch: null, worktreePath: null, activeProviderThreadId: null,
      lineage: { parentThreadId: threadId, relationshipToParent: 'fork', rootThreadId: source.lineage.rootThreadId,
        ...(isSideChat && { sideChat: true }) },
      forkedFrom: sourceRun ? { type: 'run', threadId, runId: sourceRun.run_id } : null,
      createdAt: at, updatedAt: at, archivedAt: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
    }
    const relation: ConversationThreadRelation = {
      id: command.commandId, kind: isSideChat ? 'side-chat' : 'fork', parentThreadId: threadId,
      rootThreadId: source.lineage.rootThreadId, childThreadId: targetThreadId,
      ...(sourceRun && { parentRunId: sourceRun.run_id }),
      ...(command.readOnly && { access: 'read-only' as const }),
      title, instanceId: selection.instanceId, model: selection.model, status: 'idle', createdAt: at, updatedAt: at,
    }
    const transfer = {
      id: randomUUID(), type: 'fork', sourceThreadId: threadId, targetThreadId,
      sourcePoint: { threadId, ...(sourceRun && { runId: sourceRun.run_id }) }, basePoint: null,
      sourceProviderInstanceId: sourceRun?.provider_instance_id ?? source.providerInstanceId,
      targetProviderInstanceId: null, targetRunId: null,
      status: 'pending', resolution: null, createdBy: 'user',
      error: null, createdAt: at, updatedAt: at, consumedAt: null,
    }
    return {
      relation,
      events: [
        decodeEvent({ id: randomUUID(), threadId: targetThreadId, occurredAt: at, type: 'thread.created', payload: thread }),
        decodeEvent({ id: randomUUID(), threadId: targetThreadId, occurredAt: at, type: 'context-transfer.created', payload: transfer }),
      ],
      hostEvents: [lifecycleEvent(threadId, { kind: 'relation', relation }, sourceRun?.run_id, at)],
      apply: () => {
        this.database.prepare(`INSERT INTO conversation_v2_projection_threads (
          thread_id, project_id, owner_id, space_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(targetThreadId, authority.projectId, authority.ownerId, authority.spaceId, title, selection.instanceId,
            source.runtimeMode, source.interactionMode, at, at, JSON.stringify(thread))
        this.commands.ensureControl(targetThreadId, authority)
        this.database.prepare(`INSERT INTO conversation_v2_thread_relations
          (relation_id, parent_thread_id, child_thread_id, created_at, source_ordinal, fork_context_json, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(relation.id, threadId, targetThreadId, at, sourceRun?.ordinal ?? null,
          JSON.stringify(portable), JSON.stringify(relation))
      },
    }
  }

  forkContext(threadId: string, beforeOrdinal: number): PortableHistory | undefined {
    const row = this.database.prepare(`SELECT fork_context_json FROM conversation_v2_thread_relations WHERE child_thread_id = ?`)
      .get(threadId) as { fork_context_json: string | null } | undefined
    if (!row?.fork_context_json || this.database.prepare(`SELECT 1 FROM conversation_v2_projection_runs run
      LEFT JOIN conversation_v2_effect_outbox effect ON effect.thread_id = run.thread_id AND effect.effect_type = 'provider-turn.start'
        AND json_extract(effect.payload_json, '$.runId') = run.run_id
      LEFT JOIN conversation_v2_dispatch_attempts attempt ON attempt.effect_id = effect.effect_id
      WHERE run.thread_id = ? AND run.ordinal < ? AND (attempt.phase IN ('dispatching','unknown') OR attempt.native_turn_id IS NOT NULL
        OR json_extract(run.payload_json, '$.engineAcceptedAt') IS NOT NULL) LIMIT 1`).get(threadId, beforeOrdinal)) return undefined
    return row?.fork_context_json ? JSON.parse(row.fork_context_json) as PortableHistory : undefined
  }

  childUpdate(threadId: string, status: ConversationThreadRelation['status'], runId: string, at: string, selection?: { instanceId: string; model: string }) {
    const previous = this.read(threadId).parent
    if (!previous || previous.status === status && previous.childRunId === runId) return undefined
    const relation = { ...previous, ...selection, childRunId: runId, status, updatedAt: at }
    return this.update(relation)
  }

  update(relation: ConversationThreadRelation) {
    const { parentThreadId, childThreadId, parentRunId, childRunId, updatedAt } = relation
    const childEvents = childThreadId
      ? [lifecycleEvent(childThreadId, { kind: 'relation', relation }, childRunId, updatedAt)] : []
    return {
      hostEvents: [lifecycleEvent(parentThreadId, { kind: 'relation', relation }, parentRunId, updatedAt), ...childEvents],
      apply: () => this.database.prepare(`UPDATE conversation_v2_thread_relations SET payload_json = ?
        WHERE relation_id = ?`).run(JSON.stringify(relation), relation.id),
    }
  }

  childOf(parentThreadId: string, relationId: string): ConversationThreadRelation | undefined {
    const row = this.database.prepare(`SELECT relation.payload_json FROM conversation_v2_thread_relations relation
      JOIN conversation_v2_projection_threads thread ON thread.thread_id = relation.child_thread_id
      WHERE relation.parent_thread_id = ? AND relation.relation_id = ? AND thread.deleted_at IS NULL`)
      .get(parentThreadId, relationId) as RelationRow | undefined
    return row ? this.decode(row) : undefined
  }

  delegatedParent(threadId: string): ConversationThreadRelation | undefined {
    const relation = this.restrictedParent(threadId)
    return relation?.kind === 'delegated' ? relation : undefined
  }

  restrictedParent(threadId: string): ConversationThreadRelation | undefined {
    const row = this.database.prepare('SELECT payload_json FROM conversation_v2_thread_relations WHERE child_thread_id = ?')
      .get(threadId) as RelationRow | undefined
    const relation = row ? this.decode(row) : undefined
    return relation?.kind === 'delegated' || relation?.access === 'read-only' ? relation : undefined
  }

  recordNativeActivity(
    sink: ConversationEventSink, input: { threadId: string; runId: string; attemptId: string; instanceId: string; model: string },
    event: ConversationNativeSubagentEvent,
  ): void {
    if (!event.activityId || event.activityId.length > 512 || !event.title.trim() || event.title.length > 512 ||
      !['running', 'waiting', 'completed', 'failed', 'cancelled'].includes(event.status)) return
    const { threadId, runId, attemptId, instanceId, model } = input
    const id = `activity_${createHash('sha256').update(JSON.stringify([threadId, runId, attemptId, event.activityId])).digest('hex')}`
    const stored = this.database.prepare('SELECT payload_json FROM conversation_v2_thread_relations WHERE relation_id = ?')
      .get(id) as RelationRow | undefined
    const previous = stored && this.decode(stored)
    if (previous && (previous.status === event.status || ['completed', 'failed', 'cancelled'].includes(previous.status))) return
    const at = new Date().toISOString()
    const root = this.database.prepare(`SELECT json_extract(payload_json, '$.lineage.rootThreadId') AS id
      FROM conversation_v2_projection_threads WHERE thread_id = ? AND deleted_at IS NULL`).get(threadId) as { id: string } | undefined
    if (!root || !stored && this.read(threadId).children.length >= maxChildren) return
    const relation: ConversationThreadRelation = {
      id, kind: 'native-activity', parentThreadId: threadId, rootThreadId: root.id, parentRunId: runId,
      activityId: event.activityId, title: event.title, status: event.status, instanceId, model,
      createdAt: previous?.createdAt ?? at, updatedAt: at,
    }
    sink.commit({ hostEvents: [lifecycleEvent(threadId, { kind: 'relation', relation }, runId, at)] }, () => {
      this.database.prepare(`INSERT INTO conversation_v2_thread_relations
        (relation_id, parent_thread_id, created_at, payload_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(relation_id) DO UPDATE SET payload_json = excluded.payload_json`)
        .run(id, threadId, relation.createdAt, JSON.stringify(relation))
    })
  }

  reconcileAfterRecovery(sink: ConversationEventSink): void {
    const rows = this.database.prepare(`SELECT relation.payload_json, attempt.phase, attempt.stop_requested, run.status AS run_status
      FROM conversation_v2_thread_relations relation
      JOIN conversation_v2_projection_threads child ON child.thread_id = relation.child_thread_id AND child.deleted_at IS NULL
      LEFT JOIN conversation_v2_projection_runs run ON run.run_id = json_extract(relation.payload_json, '$.childRunId')
      LEFT JOIN conversation_v2_effect_outbox effect ON effect.thread_id = child.thread_id AND effect.effect_type = 'provider-turn.start'
        AND json_extract(effect.payload_json, '$.runId') = run.run_id
      LEFT JOIN conversation_v2_dispatch_attempts attempt ON attempt.effect_id = effect.effect_id
      WHERE json_extract(relation.payload_json, '$.status') IN ('running', 'waiting')
        OR json_extract(relation.payload_json, '$.result.state') = 'available'
        OR json_extract(relation.payload_json, '$.completionDelivery.state') IN ('pending', 'claimed')`)
    const stoppedBeforeDispatch = this.database.prepare(`SELECT 1
      FROM conversation_v2_effect_outbox delivery
      JOIN conversation_v2_dispatch_attempts attempt ON attempt.effect_id = delivery.effect_id
      JOIN conversation_v2_projection_runs run ON run.thread_id = delivery.thread_id
        AND run.run_id = json_extract(delivery.payload_json, '$.runId')
      JOIN json_each(delivery.payload_json, '$.delegatedCompletion.taskIds') task
      WHERE delivery.command_id = ? AND delivery.thread_id = ? AND run.run_id = ?
        AND delivery.effect_type = 'provider-turn.start' AND delivery.status = 'cancelled' AND run.status = 'cancelled'
        AND attempt.phase = 'settled' AND attempt.stop_requested = 1
        AND attempt.provider_thread_id IS NULL AND attempt.native_turn_id IS NULL
        AND task.value = ? AND json_extract(delivery.payload_json, '$.delegatedCompletion.resultIds[' || task.key || ']') = ?`)
    const at = new Date().toISOString()
    const changes = [...rows.iterate() as Iterable<RelationRow & { phase: string | null; run_status: string | null }>].flatMap(row => {
      const relation = this.decode(row)
      const result = relation.result?.state === 'available' ? { ...relation.result, state: 'read-only' as const } : relation.result
      const stoppedClaim = relation.completionDelivery?.state === 'claimed' && relation.continuation && relation.result &&
        stoppedBeforeDispatch.get(relation.continuation.commandId, relation.parentThreadId, relation.continuation.runId,
          relation.id, relation.result.deliveryId)
      const completionDelivery = relation.completionDelivery?.state === 'pending' || stoppedClaim
        ? { state: 'disposed' as const, observedByRunId: null } : relation.completionDelivery
      const status = row.phase === 'unknown' ? 'pending-reconciliation' : row.run_status === 'queued' ? 'queued' : relation.status
      if (status === relation.status && result === relation.result && completionDelivery === relation.completionDelivery && !relation.question) return []
      return [this.update({ ...relation, question: undefined, result, completionDelivery, status, updatedAt: at })]
    })
    if (changes.length) sink.commit({ hostEvents: changes.flatMap(change => change.hostEvents) }, () => {
      for (const change of changes) change.apply()
    })
  }

  private forkRun(command: ForkCommand): ForkSourceRun | undefined {
    const { threadId, sourcePoint } = command
    const stable = this.database.prepare(`SELECT run_id, ordinal, status, provider_instance_id FROM conversation_v2_projection_runs
      WHERE thread_id = ? AND status IN (${stableStatuses.map(() => '?').join(',')})
        AND json_extract(payload_json, '$.outcomeUnknown') IS NOT 1
        AND (status = 'completed' OR provider_thread_id IS NOT NULL)
        AND json_extract(payload_json, '$.compaction') IS NULL
      AND (? IS NULL OR run_id = ?) ORDER BY ordinal DESC LIMIT 1`)
      .get(threadId, ...stableStatuses, sourcePoint.type === 'run' ? sourcePoint.runId : null,
        sourcePoint.type === 'run' ? sourcePoint.runId : null) as ForkSourceRun | undefined
    if (!stable && (sourcePoint.type === 'run' || !command.sideChat)) {
      throw new DaemonError('E_CONFLICT', '请选择同一会话中已经结算的来源回合。')
    }
    return stable
  }

  deletionEvents(threadId: string, authority: ConversationAuthority, onlyIfUnused: boolean) {
    const { parent, children } = this.read(threadId)
    if (children.some(relation => relation.kind === 'delegated' &&
      ['queued', 'running', 'waiting', 'pending-reconciliation'].includes(relation.status))) {
      throw new DaemonError('E_BUSY', '请先完成、停止或核对仍在运行的委派任务。')
    }
    if (onlyIfUnused) {
      if (parent?.kind !== 'side-chat' || !this.commands.hasThread(parent.parentThreadId, authority)) {
        throw new DaemonError('E_CONFLICT', '只能回收当前范围内的空侧聊。')
      }
      if (this.database.prepare(`SELECT 1 FROM conversation_v2_projection_runs WHERE thread_id = ?
        UNION ALL SELECT 1 FROM conversation_v2_projection_messages WHERE thread_id = ?
        UNION ALL SELECT 1 FROM conversation_v2_effect_outbox WHERE thread_id = ?
        UNION ALL SELECT 1 FROM conversation_v2_native_bindings WHERE thread_id = ? LIMIT 1`)
        .get(threadId, threadId, threadId, threadId) || children.length) {
        throw new DaemonError('E_CONFLICT', '此侧聊已受理工作，请保留会话。')
      }
    }
    return [
      ...(parent && this.commands.hasThread(parent.parentThreadId, authority)
        ? [lifecycleEvent(parent.parentThreadId, { kind: 'relation', relation: parent, removed: true }, parent.parentRunId),
          lifecycleEvent(threadId, { kind: 'relation', relation: parent, removed: true })] : []),
      ...children.flatMap(relation => relation.childThreadId && this.commands.hasThread(relation.childThreadId, authority)
        ? [lifecycleEvent(relation.childThreadId, { kind: 'relation', relation, removed: true })] : []),
    ]
  }
}
