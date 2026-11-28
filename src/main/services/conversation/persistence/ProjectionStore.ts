import type { DatabaseSync } from 'node:sqlite'
import type { ConversationProjectedWorkItem, ConversationUsageLimitRecovery } from '../../../../shared/conversation/command-runtime'
import type { ThreadEffectRow } from '../orchestration/ThreadCommands'

export interface NativeBindingRow {
  readonly instance_id: string
  readonly native_thread_id: string
  readonly configuration_fingerprint: string | null
}

export interface HandoffSourceBindingRow extends NativeBindingRow {
  readonly previous_run_id: string | null
}

export interface AssistantMessageRow {
  readonly message_id: string
  readonly streaming: number
  readonly payload_json: string
}

/**
 * 集中封装会话投影表与绑定表的 SQLite 读写操作，避免原始 SQL 散落在编排运行时各处。
 * 所有写方法均假定调用方已在需要原子性的外层事务中执行。
 */
export class ConversationProjectionStore {
  constructor(private readonly database: DatabaseSync) {}

  readStorageId(): string {
    return (this.database.prepare("SELECT value FROM conversation_meta WHERE key = 'storage_id'").get() as { value: string }).value
  }

  hasQueuedRuns(threadId: string): boolean {
    return this.database.prepare(
      "SELECT 1 FROM conversation_v2_projection_runs WHERE thread_id = ? AND status = 'queued' LIMIT 1",
    ).get(threadId) !== undefined
  }

  readNativeBindingFingerprint(threadId: string): string | null | undefined {
    const row = this.database.prepare(
      'SELECT configuration_fingerprint FROM conversation_v2_native_bindings WHERE thread_id = ?',
    ).get(threadId) as { configuration_fingerprint: string | null } | undefined
    return row?.configuration_fingerprint
  }

  readNativeBindingOrRunFallback(threadId: string): NativeBindingRow | undefined {
    return this.database.prepare(`SELECT instance_id, native_thread_id, configuration_fingerprint
      FROM conversation_v2_native_bindings WHERE thread_id = ?
      UNION ALL SELECT provider_instance_id, provider_thread_id, NULL FROM conversation_v2_projection_runs
        WHERE thread_id = ? AND provider_thread_id IS NOT NULL LIMIT 1`)
      .get(threadId, threadId) as NativeBindingRow | undefined
  }

  upsertNativeBinding(threadId: string, instanceId: string, nativeThreadId: string, configurationFingerprint: string): void {
    this.database.prepare(`INSERT INTO conversation_v2_native_bindings (thread_id, instance_id, native_thread_id, configuration_fingerprint)
      VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET instance_id = excluded.instance_id, native_thread_id = excluded.native_thread_id,
      configuration_fingerprint = excluded.configuration_fingerprint`)
      .run(threadId, instanceId, nativeThreadId, configurationFingerprint)
  }

  recordHandoffBinding(input: {
    readonly commandId: string
    readonly threadId: string
    readonly previousInstanceId: string
    readonly previousNativeThreadId: string
    readonly previousFingerprint: string | null
    readonly nextInstanceId: string
    readonly nextNativeThreadId: string
    readonly createdAt: string
  }): void {
    this.database.prepare(`INSERT OR IGNORE INTO conversation_v2_handoff_bindings
      (command_id, thread_id, previous_instance_id, previous_native_thread_id, previous_fingerprint, next_instance_id, next_native_thread_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.commandId,
        input.threadId,
        input.previousInstanceId,
        input.previousNativeThreadId,
        input.previousFingerprint,
        input.nextInstanceId,
        input.nextNativeThreadId,
        input.createdAt,
      )
  }

  latestSettledNativeRunId(threadId: string, nativeThreadId: string, instanceId: string): string | null {
    const row = this.database.prepare(`SELECT run_id FROM conversation_v2_projection_runs
      WHERE thread_id = ? AND provider_thread_id = ? AND provider_instance_id = ?
        AND status IN ('completed', 'cancelled', 'interrupted')
        AND json_extract(payload_json, '$.outcomeUnknown') IS NOT 1
      ORDER BY ordinal DESC LIMIT 1`).get(threadId, nativeThreadId, instanceId) as { run_id: string } | undefined
    return row?.run_id ?? null
  }

  readHandoffSourceBinding(threadId: string): HandoffSourceBindingRow | undefined {
    return this.database.prepare(`SELECT binding.instance_id, binding.native_thread_id, binding.configuration_fingerprint,
      (SELECT run_id FROM conversation_v2_projection_runs run WHERE run.thread_id = binding.thread_id
        AND run.provider_thread_id = binding.native_thread_id AND run.provider_instance_id = binding.instance_id
        AND run.status IN ('completed', 'cancelled', 'interrupted')
        AND json_extract(run.payload_json, '$.outcomeUnknown') IS NOT 1
        ORDER BY run.ordinal DESC LIMIT 1) AS previous_run_id
      FROM conversation_v2_native_bindings binding WHERE thread_id = ?`).get(threadId) as HandoffSourceBindingRow | undefined
  }

  readThreadPayload(threadId: string): { payload_json: string } | undefined {
    return this.database.prepare(
      'SELECT payload_json FROM conversation_v2_projection_threads WHERE thread_id = ?',
    ).get(threadId) as { payload_json: string } | undefined
  }

  readThreadModes(threadId: string): {
    readonly runtimeMode: 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'
    readonly interactionMode: 'default' | 'plan'
  } {
    const row = this.database.prepare(
      'SELECT runtime_mode, interaction_mode FROM conversation_v2_projection_threads WHERE thread_id = ? AND deleted_at IS NULL',
    ).get(threadId) as {
      runtime_mode?: string
      interaction_mode?: string
    } | undefined
    const runtimeMode = row?.runtime_mode === 'full-access'
      || row?.runtime_mode === 'auto-accept-edits'
      || row?.runtime_mode === 'auto'
      || row?.runtime_mode === 'approval-required'
      ? row.runtime_mode
      : 'approval-required'
    const interactionMode = row?.interaction_mode === 'plan' ? 'plan' : 'default'
    return { runtimeMode, interactionMode }
  }

  updateThreadProvider(threadId: string, instanceId: string, updatedAt: string, payloadJson: string): void {
    this.database.prepare(`UPDATE conversation_v2_projection_threads SET default_provider = ?, updated_at = ?,
      payload_json = ? WHERE thread_id = ?`).run(instanceId, updatedAt, payloadJson, threadId)
  }

  touchThread(threadId: string, updatedAt: string): void {
    this.database.prepare('UPDATE conversation_v2_projection_threads SET updated_at = ? WHERE thread_id = ?')
      .run(updatedAt, threadId)
  }

  readRunPayload(runId: string): { payload_json: string } | undefined {
    return this.database.prepare(
      'SELECT payload_json FROM conversation_v2_projection_runs WHERE run_id = ?',
    ).get(runId) as { payload_json: string } | undefined
  }

  readLatestRunPayload(threadId: string): { payload_json: string } | undefined {
    return this.database.prepare(
      'SELECT payload_json FROM conversation_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1',
    ).get(threadId) as { payload_json: string } | undefined
  }

  markRunRunning(runId: string, nativeThreadId: string, payloadJson: string): void {
    this.database.prepare(
      "UPDATE conversation_v2_projection_runs SET provider_thread_id = ?, status = 'running', payload_json = ? WHERE run_id = ?",
    ).run(nativeThreadId, payloadJson, runId)
  }

  patchRunPayload(runId: string, patch: Record<string, unknown>): void {
    this.database.prepare(
      'UPDATE conversation_v2_projection_runs SET payload_json = json_patch(payload_json, ?) WHERE run_id = ?',
    ).run(JSON.stringify(patch), runId)
  }

  settleRunProjection(threadId: string, runId: string, status: string, settledAt: string, nextPayload: Record<string, unknown>): void {
    this.database.prepare(
      'UPDATE conversation_v2_projection_runs SET status = ?, completed_at = ?, payload_json = ? WHERE run_id = ?',
    ).run(status, settledAt, JSON.stringify(nextPayload), runId)
    this.database.prepare(`UPDATE conversation_v2_projection_messages SET streaming = 0, updated_at = ?,
      payload_json = json_patch(payload_json, ?) WHERE run_id = ? AND role = 'assistant'`)
      .run(settledAt, JSON.stringify({ streaming: false, updatedAt: settledAt }), runId)
    this.touchThread(threadId, settledAt)
  }

  readAssistantMessage(messageId: string): AssistantMessageRow | undefined {
    return this.database.prepare(
      'SELECT message_id, payload_json, streaming FROM conversation_v2_projection_messages WHERE message_id = ?',
    ).get(messageId) as AssistantMessageRow | undefined
  }

  hasAssistantMessageForRun(runId: string): boolean {
    return this.database.prepare(
      "SELECT 1 FROM conversation_v2_projection_messages WHERE run_id = ? AND role = 'assistant' LIMIT 1",
    ).get(runId) !== undefined
  }

  readAssistantMessagesForRun(runId: string): readonly { payload_json: string }[] {
    return this.database.prepare(
      "SELECT payload_json FROM conversation_v2_projection_messages WHERE run_id = ? AND role = 'assistant'",
    ).all(runId) as { payload_json: string }[]
  }

  insertAssistantMessage(
    messageId: string,
    threadId: string,
    runId: string,
    final: boolean,
    now: string,
    payloadJson: string,
  ): void {
    this.database.prepare(`INSERT INTO conversation_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (?, ?, ?, NULL, 'assistant', ?, ?, ?, ?)`)
      .run(messageId, threadId, runId, final ? 0 : 1, now, now, payloadJson)
  }

  updateAssistantMessage(messageId: string, final: boolean, now: string, payloadJson: string): void {
    this.database.prepare(
      'UPDATE conversation_v2_projection_messages SET payload_json = ?, updated_at = ?, streaming = ? WHERE message_id = ?',
    ).run(payloadJson, now, final ? 0 : 1, messageId)
  }

  readTurnItem(id: string, threadId: string, runId: string): { payload_json: string } | undefined {
    return this.database.prepare(
      'SELECT payload_json FROM conversation_v2_projection_turn_items WHERE turn_item_id = ? AND thread_id = ? AND run_id = ?',
    ).get(id, threadId, runId) as { payload_json: string } | undefined
  }

  nextTurnItemOrdinal(threadId: string): number {
    return (this.database.prepare(
      'SELECT COALESCE(MAX(ordinal) + 1, 0) AS ordinal FROM conversation_v2_projection_turn_items WHERE thread_id = ?',
    ).get(threadId) as { ordinal: number }).ordinal
  }

  readTurnItemBudget(runId: string, excludeId: string): { count: number; bytes: number } {
    return this.database.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
      FROM conversation_v2_projection_turn_items WHERE run_id = ? AND turn_item_id <> ?`)
      .get(runId, excludeId) as { count: number; bytes: number }
  }

  upsertTurnItem(item: ConversationProjectedWorkItem, status: string, updatedAt: string, payloadJson: string): void {
    this.database.prepare(`INSERT INTO conversation_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, provider_turn_id, ordinal, type, status, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(turn_item_id) DO UPDATE SET
        provider_turn_id = excluded.provider_turn_id, type = excluded.type, status = excluded.status,
        updated_at = excluded.updated_at, payload_json = excluded.payload_json`)
      .run(item.id, item.threadId, item.runId, item.providerTurnId, item.ordinal, item.type, status, updatedAt, payloadJson)
  }

  insertTurnItemIfAbsent(item: ConversationProjectedWorkItem, updatedAt: string): void {
    this.database.prepare(`INSERT OR IGNORE INTO conversation_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, provider_turn_id, ordinal, type, status, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(item.id, item.threadId, item.runId, item.providerTurnId, item.ordinal, item.type, item.status, updatedAt, JSON.stringify(item))
  }

  markDispatchAttemptBackgroundRunning(effectId: string): void {
    this.database.prepare('UPDATE conversation_v2_dispatch_attempts SET background_running = 1 WHERE effect_id = ?').run(effectId)
  }

  markDispatchAttemptForegroundEnded(effectId: string): void {
    this.database.prepare('UPDATE conversation_v2_dispatch_attempts SET foreground_ended = 1 WHERE effect_id = ?').run(effectId)
  }

  findRunningInterruptEffects(threadId: string, targetAttemptId: string): readonly ThreadEffectRow[] {
    return this.database.prepare(`SELECT * FROM conversation_v2_effect_outbox WHERE thread_id = ?
      AND effect_type = 'provider-turn.interrupt' AND status = 'running' AND json_extract(payload_json, '$.targetAttemptId') = ?`)
      .all(threadId, targetAttemptId) as unknown as ThreadEffectRow[]
  }

  readLatestRunRecord(threadId: string): { readonly run_id: string; readonly status: string; readonly payload_json: string } | undefined {
    return this.database.prepare(
      'SELECT run_id, status, payload_json FROM conversation_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1',
    ).get(threadId) as { readonly run_id: string; readonly status: string; readonly payload_json: string } | undefined
  }

  readUsageLimitRecovery(threadId: string): ConversationUsageLimitRecovery | null {
    const row = this.database.prepare(
      `SELECT thread_id, run_id, resume_at, retry_after_ms, attempt, max_attempts, status, reason, updated_at
       FROM conversation_v2_usage_limit_recoveries WHERE thread_id = ?`,
    ).get(threadId) as {
      thread_id: string
      run_id: string
      resume_at: string
      retry_after_ms: number
      attempt: number
      max_attempts: number
      status: 'scheduled' | 'cancelled' | 'triggered'
      reason: string | null
      updated_at: string
    } | undefined
    if (!row) return null
    return {
      threadId: row.thread_id,
      runId: row.run_id,
      resumeAt: row.resume_at,
      retryAfterMs: row.retry_after_ms,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      status: row.status,
      ...(row.reason ? { reason: row.reason } : {}),
      updatedAt: row.updated_at,
    }
  }

  readScheduledUsageLimitRecovery(threadId: string): ConversationUsageLimitRecovery | null {
    const row = this.readUsageLimitRecovery(threadId)
    return row?.status === 'scheduled' ? row : null
  }

  upsertUsageLimitRecovery(recovery: ConversationUsageLimitRecovery): void {
    this.database.prepare(`INSERT INTO conversation_v2_usage_limit_recoveries
      (thread_id, run_id, resume_at, retry_after_ms, attempt, max_attempts, status, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        run_id = excluded.run_id,
        resume_at = excluded.resume_at,
        retry_after_ms = excluded.retry_after_ms,
        attempt = excluded.attempt,
        max_attempts = excluded.max_attempts,
        status = excluded.status,
        reason = excluded.reason,
        updated_at = excluded.updated_at`)
      .run(
        recovery.threadId,
        recovery.runId,
        recovery.resumeAt,
        recovery.retryAfterMs,
        recovery.attempt,
        recovery.maxAttempts,
        recovery.status,
        recovery.reason ?? null,
        recovery.updatedAt,
      )
  }

  listScheduledUsageLimitRecoveries(): readonly ConversationUsageLimitRecovery[] {
    const rows = this.database.prepare(
      `SELECT thread_id, run_id, resume_at, retry_after_ms, attempt, max_attempts, status, reason, updated_at
       FROM conversation_v2_usage_limit_recoveries WHERE status = 'scheduled'`,
    ).all() as Array<{
      thread_id: string
      run_id: string
      resume_at: string
      retry_after_ms: number
      attempt: number
      max_attempts: number
      status: 'scheduled'
      reason: string | null
      updated_at: string
    }>
    return rows.map(row => ({
      threadId: row.thread_id,
      runId: row.run_id,
      resumeAt: row.resume_at,
      retryAfterMs: row.retry_after_ms,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      status: row.status,
      ...(row.reason ? { reason: row.reason } : {}),
      updatedAt: row.updated_at,
    }))
  }
}
