import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import * as Schema from 'effect/Schema'
import { OrchestrationV2DomainEventJson } from '../../../../shared/conversation/contracts'
import { DaemonError } from '../../../daemon/errors'
import type { ConversationAttachmentStore } from '../attachments'
import type { ConversationThreadDetachConfirmation } from '../providers/registry'

const cleanupPending = 'thread.cleanup.local-pending'
const nativeCleanupPending = 'thread.cleanup.native-pending'
const nativeCleanupConfirmed = 'thread.cleanup.native-confirmed:'
const cleanupComplete = 'thread.cleanup.completed'
export const threadDeletionPendingMessage = '会话已从记录中移除，本机资源清理待核对。请按原删除命令继续清理。'

const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)

type ThreadDeletionConfirmation = ConversationThreadDetachConfirmation | 'windowsJobClosed'
const confirmations = ['unsubscribed', 'notSubscribed', 'notLoaded', 'windowsJobClosed'] as const satisfies readonly ThreadDeletionConfirmation[]

export interface ThreadDeletionState {
  readonly hasLiveTurn?: boolean
  readonly hasLoadedThread?: boolean
}

export function isThreadDeletionComplete(detail: string | null | undefined): boolean {
  return detail === cleanupComplete || confirmations.some(status => detail === `${cleanupComplete}:${status}`)
}

export function planThreadDeletion(
  database: DatabaseSync, threadId: string, current: Record<string, unknown>, occurredAt: string,
  state: ThreadDeletionState,
) {
  const outstanding = database.prepare(`SELECT
    EXISTS (
      SELECT 1 FROM conversation_v2_effect_outbox effect
      LEFT JOIN conversation_v2_dispatch_attempts attempt ON attempt.effect_id = effect.effect_id
      WHERE effect.thread_id = ? AND effect.status = 'running' AND (attempt.phase IS NULL OR attempt.phase = 'unknown')
    ) OR EXISTS (
      SELECT 1 FROM conversation_v2_projection_runtime_requests
      WHERE thread_id = ? AND status = 'pending-reconciliation'
    ) AS uncertain,
    EXISTS (
      SELECT 1 FROM conversation_v2_effect_outbox WHERE thread_id = ? AND status = 'running'
    ) OR EXISTS (
      SELECT 1 FROM conversation_v2_projection_runs
      WHERE thread_id = ? AND status IN ('preparing', 'starting', 'running', 'waiting')
    ) OR EXISTS (
      SELECT 1 FROM conversation_v2_projection_runtime_requests WHERE thread_id = ? AND status = 'responding'
    ) AS running,
    EXISTS (
      SELECT 1 FROM conversation_v2_effect_outbox WHERE thread_id = ? AND status = 'pending'
    ) OR EXISTS (
      SELECT 1 FROM conversation_v2_projection_runs WHERE thread_id = ? AND status = 'queued'
    ) AS queued`).get(threadId, threadId, threadId, threadId, threadId, threadId, threadId) as {
    uncertain: number
    running: number
    queued: number
  }
  if (outstanding.uncertain) throw new DaemonError('E_BUSY', '请先用原命令核对送达或审批结果，再删除会话。')
  if (outstanding.running || state.hasLiveTurn) {
    throw new DaemonError('E_BUSY', '请返回会话停止原回合（如引擎支持），或等待它及后台工作结束后再删除。')
  }
  if (outstanding.queued) throw new DaemonError('E_BUSY', '请先撤回排队的消息，再删除会话。')

  const payload = { ...current, deletedAt: occurredAt, updatedAt: occurredAt, titleRegeneration: null }
  return {
    target: { detail: state.hasLoadedThread ? nativeCleanupPending : cleanupPending },
    events: [decodeEvent({ type: 'thread.deleted', id: randomUUID(), threadId, occurredAt, payload })],
    apply: () => {
      const updated = database.prepare(`UPDATE conversation_v2_projection_threads
        SET deleted_at = ?, updated_at = ?, payload_json = ? WHERE thread_id = ? AND deleted_at IS NULL`)
        .run(occurredAt, occurredAt, JSON.stringify(payload), threadId)
      if (updated.changes !== 1) throw new DaemonError('E_CONFLICT', '原会话已删除。')
    },
  }
}

export function recordThreadDeletionDetach(
  database: DatabaseSync, threadId: string, commandId: string, confirmation: ThreadDeletionConfirmation,
): boolean {
  const result = database.prepare(`UPDATE conversation_v2_command_targets SET detail = ?
    WHERE command_id = ? AND (detail IS NULL OR detail IN (?, ?, 'thread.cleanup.pending'))
      AND EXISTS (SELECT 1 FROM conversation_v2_command_receipts receipt
        JOIN conversation_v2_projection_threads thread ON thread.thread_id = receipt.thread_id
        WHERE receipt.command_id = ? AND receipt.thread_id = ? AND receipt.command_type = 'thread.delete'
          AND receipt.status = 'accepted' AND thread.deleted_at IS NOT NULL)`)
    .run(`${nativeCleanupConfirmed}${confirmation}`, commandId, nativeCleanupPending, cleanupPending, commandId, threadId)
  return result.changes === 1
}

export function completeThreadDeletion(
  database: DatabaseSync, attachments: ConversationAttachmentStore,
  threadId: string, commandId: string,
): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    const pending = database.prepare(`SELECT target.detail,
      EXISTS(SELECT 1 FROM conversation_v2_native_bindings binding WHERE binding.thread_id = thread.thread_id) AS has_native_binding
      FROM conversation_v2_command_targets target
      JOIN conversation_v2_command_receipts receipt ON receipt.command_id = target.command_id
      JOIN conversation_v2_projection_threads thread ON thread.thread_id = receipt.thread_id
      WHERE target.command_id = ? AND receipt.thread_id = ? AND receipt.command_type = 'thread.delete'
        AND receipt.status = 'accepted' AND thread.deleted_at IS NOT NULL`)
      .get(commandId, threadId) as { detail: string | null; has_native_binding: number } | undefined
    const legacy = pending?.detail === null || pending?.detail === 'thread.cleanup.pending'
    const nativeConfirmation = confirmations.find(status => pending?.detail === `${nativeCleanupConfirmed}${status}`)
    const confirmed = pending?.detail === cleanupPending || nativeConfirmation !== undefined || legacy && !pending?.has_native_binding
    if (confirmed) {
      attachments.releaseDeletedThreadClaims(threadId)
      database.prepare('DELETE FROM conversation_v2_native_bindings WHERE thread_id = ?').run(threadId)
      const completed = database.prepare('UPDATE conversation_v2_command_targets SET detail = ? WHERE command_id = ?')
        .run(nativeConfirmation ? `${cleanupComplete}:${nativeConfirmation}` : cleanupComplete, commandId)
      if (completed.changes !== 1) throw new Error('The original thread deletion cleanup could not be recorded.')
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
