import type { DatabaseSync } from 'node:sqlite'
import type {
  ConversationCheckpointSummary,
  ConversationProjectedWorkItem,
  ConversationUsageLimitRecovery,
} from '../../../../shared/conversation/command-runtime'
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

  clearNativeBindingForSwitch(threadId: string, updatedAt: string): void {
    this.database.prepare('DELETE FROM conversation_v2_native_bindings WHERE thread_id = ?').run(threadId)
    this.database.prepare('UPDATE conversation_v2_projection_runs SET provider_thread_id = NULL WHERE thread_id = ?').run(threadId)
    this.database.prepare('UPDATE conversation_v2_projection_threads SET active_provider_thread_id = NULL, updated_at = ? WHERE thread_id = ?')
      .run(updatedAt, threadId)
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

  upsertCheckpoint(
    summary: ConversationCheckpointSummary,
    scope?: {
      readonly repoRoot: string
      readonly canonicalCwd: string
      readonly gitRefName?: string | null
      readonly untrackedManifestJson?: string | null
    },
  ): void {
    this.database.prepare(`INSERT INTO conversation_v2_checkpoints
      (checkpoint_id, thread_id, run_id, phase, cwd, git_tree_ref, head_ref, dirty_file_count, untracked_count, status, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, run_id, phase) DO UPDATE SET
        checkpoint_id = excluded.checkpoint_id,
        cwd = excluded.cwd,
        git_tree_ref = excluded.git_tree_ref,
        head_ref = excluded.head_ref,
        dirty_file_count = excluded.dirty_file_count,
        untracked_count = excluded.untracked_count,
        status = excluded.status,
        detail = excluded.detail,
        created_at = excluded.created_at`)
      .run(
        summary.checkpointId,
        summary.threadId,
        summary.runId,
        summary.phase,
        summary.cwd,
        summary.gitTreeRef,
        summary.headRef,
        summary.dirtyFileCount,
        summary.untrackedCount,
        summary.status,
        summary.detail ?? null,
        summary.createdAt,
      )
    if (scope) {
      this.database.prepare(`INSERT INTO conversation_v2_checkpoint_scopes
        (checkpoint_id, repo_root, canonical_cwd, git_ref_name, untracked_manifest_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(checkpoint_id) DO UPDATE SET
          repo_root = excluded.repo_root,
          canonical_cwd = excluded.canonical_cwd,
          git_ref_name = excluded.git_ref_name,
          untracked_manifest_json = excluded.untracked_manifest_json`)
        .run(
          summary.checkpointId,
          scope.repoRoot,
          scope.canonicalCwd,
          scope.gitRefName ?? null,
          scope.untrackedManifestJson ?? null,
        )
    }
  }

  listCheckpoints(threadId: string): readonly ConversationCheckpointSummary[] {
    const rows = this.database.prepare(`SELECT checkpoint_id, thread_id, run_id, phase, cwd, git_tree_ref, head_ref,
      dirty_file_count, untracked_count, status, detail, created_at
      FROM conversation_v2_checkpoints WHERE thread_id = ?
      ORDER BY created_at ASC, checkpoint_id ASC`).all(threadId) as Array<{
      checkpoint_id: string
      thread_id: string
      run_id: string
      phase: 'before' | 'after'
      cwd: string
      git_tree_ref: string | null
      head_ref: string | null
      dirty_file_count: number
      untracked_count: number
      status: 'captured' | 'skipped' | 'failed'
      detail: string | null
      created_at: string
    }>
    return rows.map(row => ({
      checkpointId: row.checkpoint_id,
      threadId: row.thread_id,
      runId: row.run_id,
      phase: row.phase,
      cwd: row.cwd,
      gitTreeRef: row.git_tree_ref,
      headRef: row.head_ref,
      dirtyFileCount: row.dirty_file_count,
      untrackedCount: row.untracked_count,
      status: row.status,
      ...(row.detail ? { detail: row.detail } : {}),
      createdAt: row.created_at,
    }))
  }

  readCheckpointWithScope(
    threadId: string,
    runId: string,
    phase: 'before' | 'after',
  ): {
    readonly checkpoint: ConversationCheckpointSummary
    readonly scope: {
      readonly repoRoot: string
      readonly canonicalCwd: string
      readonly gitRefName: string | null
    } | null
  } | null {
    const row = this.database.prepare(`SELECT c.checkpoint_id, c.thread_id, c.run_id, c.phase, c.cwd, c.git_tree_ref, c.head_ref,
      c.dirty_file_count, c.untracked_count, c.status, c.detail, c.created_at,
      s.repo_root, s.canonical_cwd, s.git_ref_name
      FROM conversation_v2_checkpoints c
      LEFT JOIN conversation_v2_checkpoint_scopes s ON s.checkpoint_id = c.checkpoint_id
      WHERE c.thread_id = ? AND c.run_id = ? AND c.phase = ?`)
      .get(threadId, runId, phase) as {
      checkpoint_id: string
      thread_id: string
      run_id: string
      phase: 'before' | 'after'
      cwd: string
      git_tree_ref: string | null
      head_ref: string | null
      dirty_file_count: number
      untracked_count: number
      status: 'captured' | 'skipped' | 'failed'
      detail: string | null
      created_at: string
      repo_root: string | null
      canonical_cwd: string | null
      git_ref_name: string | null
    } | undefined
    if (!row) return null
    return {
      checkpoint: {
        checkpointId: row.checkpoint_id,
        threadId: row.thread_id,
        runId: row.run_id,
        phase: row.phase,
        cwd: row.cwd,
        gitTreeRef: row.git_tree_ref,
        headRef: row.head_ref,
        dirtyFileCount: row.dirty_file_count,
        untrackedCount: row.untracked_count,
        status: row.status,
        ...(row.detail ? { detail: row.detail } : {}),
        createdAt: row.created_at,
      },
      scope: row.repo_root && row.canonical_cwd
        ? { repoRoot: row.repo_root, canonicalCwd: row.canonical_cwd, gitRefName: row.git_ref_name }
        : null,
    }
  }

  addSessionApproval(threadId: string, scopeKey: string, createdAt = new Date().toISOString()): void {
    this.database.prepare(`INSERT INTO conversation_v2_session_approvals (thread_id, scope_key, created_at)
      VALUES (?, ?, ?) ON CONFLICT(thread_id, scope_key) DO NOTHING`).run(threadId, scopeKey, createdAt)
  }

  hasSessionApproval(threadId: string, scopeKey: string): boolean {
    return this.database.prepare(
      'SELECT 1 FROM conversation_v2_session_approvals WHERE thread_id = ? AND scope_key = ?',
    ).get(threadId, scopeKey) !== undefined
  }

  listSessionApprovals(threadId: string): readonly string[] {
    const rows = this.database.prepare(
      'SELECT scope_key FROM conversation_v2_session_approvals WHERE thread_id = ? ORDER BY created_at ASC',
    ).all(threadId) as Array<{ scope_key: string }>
    return rows.map(row => row.scope_key)
  }

  clearSessionApprovals(threadId: string): void {
    this.database.prepare('DELETE FROM conversation_v2_session_approvals WHERE thread_id = ?').run(threadId)
  }

  truncateThreadFromOrdinal(
    threadId: string,
    minOrdinalToRemove: number,
    updatedAt: string,
    options?: { readonly preserveNativeBinding?: boolean },
  ): readonly string[] {
    const runRows = this.database.prepare(
      'SELECT run_id FROM conversation_v2_projection_runs WHERE thread_id = ? AND ordinal >= ? ORDER BY ordinal ASC',
    ).all(threadId, minOrdinalToRemove) as Array<{ run_id: string }>
    const removedRunIds = runRows.map(row => row.run_id)
    if (removedRunIds.length > 0) {
      const placeholders = removedRunIds.map(() => '?').join(',')
      const effectRows = this.database.prepare(`SELECT effect_id FROM conversation_v2_effect_outbox
        WHERE thread_id = ? AND json_extract(payload_json, '$.runId') IN (${placeholders})`)
        .all(threadId, ...removedRunIds) as Array<{ effect_id: string }>
      const effectIds = effectRows.map(row => row.effect_id)
      const requestRows = this.database.prepare(`SELECT runtime_request_id FROM conversation_v2_projection_runtime_requests
        WHERE thread_id = ? AND node_id IN (${placeholders})`)
        .all(threadId, ...removedRunIds) as Array<{ runtime_request_id: string }>
      const requestIds = requestRows.map(row => row.runtime_request_id)
      const messageRows = this.database.prepare(`SELECT message_id FROM conversation_v2_projection_messages
        WHERE thread_id = ? AND run_id IN (${placeholders})`)
        .all(threadId, ...removedRunIds) as Array<{ message_id: string }>
      const removedMessageIds = messageRows.map(row => row.message_id)

      if (requestIds.length > 0) {
        const reqPh = requestIds.map(() => '?').join(',')
        this.database.prepare(`DELETE FROM conversation_v2_runtime_request_bindings WHERE request_id IN (${reqPh})`).run(...requestIds)
      }
      if (effectIds.length > 0) {
        const effPh = effectIds.map(() => '?').join(',')
        this.database.prepare(`DELETE FROM conversation_v2_runtime_request_bindings
          WHERE attempt_id IN (SELECT attempt_id FROM conversation_v2_dispatch_attempts WHERE effect_id IN (${effPh}))`)
          .run(...effectIds)
        this.database.prepare(`DELETE FROM conversation_v2_native_terminal_evidence WHERE effect_id IN (${effPh})`).run(...effectIds)
        this.database.prepare(`DELETE FROM conversation_v2_dispatch_attempts WHERE effect_id IN (${effPh})`).run(...effectIds)
        this.database.prepare(`DELETE FROM conversation_v2_effect_outbox WHERE effect_id IN (${effPh})`).run(...effectIds)
      }

      this.database.prepare(`DELETE FROM conversation_v2_projection_runtime_requests WHERE thread_id = ? AND node_id IN (${placeholders})`)
        .run(threadId, ...removedRunIds)
      this.database.prepare(`DELETE FROM conversation_v2_projection_turn_items WHERE thread_id = ? AND run_id IN (${placeholders})`)
        .run(threadId, ...removedRunIds)
      if (removedMessageIds.length > 0) {
        try {
          const msgPh = removedMessageIds.map(() => '?').join(',')
          this.database.prepare(`DELETE FROM conversation_v2_message_fts WHERE message_id IN (${msgPh})`).run(...removedMessageIds)
        } catch {
          // 若当前数据库未启用 FTS5，跳过索引清理
        }
      }
      this.database.prepare(`DELETE FROM conversation_v2_projection_messages WHERE thread_id = ? AND run_id IN (${placeholders})`)
        .run(threadId, ...removedRunIds)
      this.database.prepare(`DELETE FROM conversation_v2_projection_plans WHERE thread_id = ? AND run_id IN (${placeholders})`)
        .run(threadId, ...removedRunIds)
      this.database.prepare(`DELETE FROM conversation_v2_projection_nodes WHERE thread_id = ? AND run_id IN (${placeholders})`)
        .run(threadId, ...removedRunIds)
      this.database.prepare(`DELETE FROM conversation_v2_projection_run_attempts WHERE thread_id = ? AND run_id IN (${placeholders})`)
        .run(threadId, ...removedRunIds)
      this.database.prepare(`DELETE FROM conversation_v2_checkpoints WHERE thread_id = ? AND run_id IN (${placeholders})`)
        .run(threadId, ...removedRunIds)
      this.database.prepare(`DELETE FROM conversation_v2_projection_runs WHERE thread_id = ? AND run_id IN (${placeholders})`)
        .run(threadId, ...removedRunIds)
    }

    this.database.prepare('DELETE FROM conversation_v2_usage_limit_recoveries WHERE thread_id = ?').run(threadId)
    if (!options?.preserveNativeBinding) {
      this.database.prepare('DELETE FROM conversation_v2_native_bindings WHERE thread_id = ?').run(threadId)
      this.database.prepare('UPDATE conversation_v2_projection_runs SET provider_thread_id = NULL WHERE thread_id = ?').run(threadId)
      this.database.prepare('UPDATE conversation_v2_projection_threads SET active_provider_thread_id = NULL, updated_at = ? WHERE thread_id = ?')
        .run(updatedAt, threadId)
    } else {
      this.database.prepare('UPDATE conversation_v2_projection_threads SET updated_at = ? WHERE thread_id = ?')
        .run(updatedAt, threadId)
    }
    return removedRunIds
  }
}
