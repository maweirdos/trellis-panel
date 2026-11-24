import type { DatabaseSync } from 'node:sqlite'
import type { ConversationCompaction, ConversationGoal, ConversationThreadCommand, ConversationTurnUsage } from '../../../../shared/conversation/command-runtime'
import { DaemonError } from '../../../daemon/errors'
import { lifecycleEvent, type ThreadRunRow } from './ThreadCommands'

type GoalCommand = Extract<ConversationThreadCommand, { type: `thread.goal.${string}` }>

export class ThreadContinuation {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS conversation_v2_thread_goals (
      thread_id TEXT PRIMARY KEY REFERENCES conversation_v2_projection_threads(thread_id),
      objective TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'paused')), updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS conversation_v2_handoff_bindings (
      command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES conversation_v2_projection_threads(thread_id),
      previous_instance_id TEXT NOT NULL, previous_native_thread_id TEXT NOT NULL, previous_fingerprint TEXT,
      next_instance_id TEXT NOT NULL, next_native_thread_id TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;`)
  }

  readGoal(threadId: string): ConversationGoal | null {
    const row = this.database.prepare(`SELECT objective, status, updated_at FROM conversation_v2_thread_goals
      WHERE thread_id = ?`).get(threadId) as { objective: string; status: ConversationGoal['status']; updated_at: string } | undefined
    return row ? { source: 'application', objective: row.objective, status: row.status, updatedAt: row.updated_at } : null
  }

  planGoal(command: GoalCommand) {
    const at = new Date().toISOString()
    const { threadId } = command
    const current = this.readGoal(threadId)
    if (command.type !== 'thread.goal.set' && command.type !== 'thread.goal.clear' && !current) {
      throw new DaemonError('E_CONFLICT', '该会话还没有目标。')
    }
    const objective = command.type === 'thread.goal.set' ? command.objective : current?.objective
    const goal: ConversationGoal | null = command.type !== 'thread.goal.clear' && objective
      ? { source: 'application', objective, status: command.type === 'thread.goal.pause' ? 'paused' : 'active', updatedAt: at }
      : null
    return {
      hostEvents: [lifecycleEvent(threadId, { kind: 'goal', goal }, undefined, at)],
      apply: () => {
        if (!goal) this.database.prepare('DELETE FROM conversation_v2_thread_goals WHERE thread_id = ?').run(threadId)
        else this.database.prepare(`INSERT INTO conversation_v2_thread_goals (thread_id, objective, status, updated_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET objective = excluded.objective,
          status = excluded.status, updated_at = excluded.updated_at`).run(threadId, goal.objective, goal.status, goal.updatedAt)
      },
    }
  }

  latestForCompaction(threadId: string): ThreadRunRow {
    const blocked = this.database.prepare(`SELECT 1 FROM conversation_v2_effect_outbox
      WHERE thread_id = ? AND status IN ('pending', 'running')
      UNION ALL SELECT 1 FROM conversation_v2_projection_runtime_requests
      WHERE thread_id = ? AND status IN ('pending', 'responding', 'pending-reconciliation') LIMIT 1`).get(threadId, threadId)
    if (blocked) throw new DaemonError('E_BUSY', '请先处理当前回合、待答请求和队列。')
    const run = this.database.prepare(`SELECT run.* FROM conversation_v2_projection_runs run
      JOIN conversation_v2_native_bindings binding ON binding.thread_id = run.thread_id
        AND binding.instance_id = run.provider_instance_id AND binding.native_thread_id = run.provider_thread_id
      WHERE run.thread_id = ? AND run.status = 'completed' ORDER BY run.ordinal DESC LIMIT 1`).get(threadId) as ThreadRunRow | undefined
    if (!run) throw new DaemonError('E_UNAVAILABLE', '会话需要先完成一个原生回合。')
    return run
  }

  idleCandidate(threadId: string): ThreadRunRow | undefined {
    const run = this.database.prepare(`SELECT * FROM conversation_v2_projection_runs WHERE thread_id = ?
      ORDER BY ordinal DESC LIMIT 1`).get(threadId) as ThreadRunRow | undefined
    if (run?.status !== 'completed') return undefined
    const facts = JSON.parse(run.payload_json) as { usage?: ConversationTurnUsage; compaction?: ConversationCompaction }
    const { inputTokens, outputTokens, contextWindow } = facts.usage ?? {}
    if (facts.compaction || !contextWindow || inputTokens === undefined || outputTokens === undefined ||
      inputTokens + outputTokens < Math.max(64_000, contextWindow * 0.8)) return undefined
    return run
  }

  writeUsage(runId: string, usage: ConversationTurnUsage): void {
    this.database.prepare('UPDATE conversation_v2_projection_runs SET payload_json = json_patch(payload_json, ?) WHERE run_id = ?')
      .run(JSON.stringify({ usage }), runId)
  }
}

export function compactionFromPayload(payload: string): ConversationCompaction | undefined {
  return (JSON.parse(payload) as { compaction?: ConversationCompaction }).compaction
}
