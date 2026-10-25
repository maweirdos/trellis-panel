import { acpHandoffCreateInputSchema, acpHandoffOperationSchema, ACP_HANDOFF_CONTEXT_BYTE_LIMIT, type AcpHandoffCreateInput, type AcpHandoffOperation } from '../../../shared/acp-handoff'
import type { AcpSessionRecord } from '../../../shared/types'
import { projectRootKey } from '../my/navigation'
import { isMeaningfulConversation } from './conversation-selection'

export interface RuntimeHandoffDraft {
  targetRuntimeId: string
  context?: string
  attempt?: AcpHandoffCreateInput & { targetRuntimeId: string }
  operation?: AcpHandoffOperation
  rejected?: boolean
}

const drafts = new Map<string, RuntimeHandoffDraft>()
const storageKey = (root: string, sessionId: string): string => `tpanel.acp.handoff.${encodeURIComponent(projectRootKey(root) ?? '')}.${encodeURIComponent(sessionId)}`

export function readRuntimeHandoffDraft(root: string, sessionId: string): RuntimeHandoffDraft {
  const key = storageKey(root, sessionId)
  const cached = drafts.get(key)
  if (cached) return cached
  let draft: RuntimeHandoffDraft = { targetRuntimeId: '' }
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (saved && typeof saved.targetRuntimeId === 'string') {
      draft.targetRuntimeId = saved.targetRuntimeId
      if (typeof saved.context === 'string' && saved.context.length <= ACP_HANDOFF_CONTEXT_BYTE_LIMIT * 2) draft.context = saved.context
      const attempt = acpHandoffCreateInputSchema.safeParse(saved.attempt && { operationId: saved.attempt.operationId, previewId: saved.attempt.previewId, context: saved.attempt.context })
      if (attempt.success && typeof saved.attempt.targetRuntimeId === 'string') draft.attempt = { ...attempt.data, targetRuntimeId: saved.attempt.targetRuntimeId }
      const operation = acpHandoffOperationSchema.safeParse(saved.operation)
      if (operation.success && operation.data.sourceSessionId === sessionId && operation.data.id === draft.attempt?.operationId && operation.data.targetRuntimeId === draft.attempt.targetRuntimeId) draft.operation = operation.data
      if (draft.attempt && saved.rejected === true && !draft.operation) draft.rejected = true
    }
  } catch { /* Keep recovery available in memory when local preferences cannot be read. */ }
  drafts.set(key, draft)
  return draft
}

export function writeRuntimeHandoffDraft(root: string, sessionId: string, draft: RuntimeHandoffDraft): void {
  const key = storageKey(root, sessionId)
  drafts.set(key, draft)
  try { localStorage.setItem(key, JSON.stringify(draft)) }
  catch { /* The current renderer still retains the exact operation for recovery. */ }
}

export function runtimeHandoffSourceKey(session: AcpSessionRecord): string {
  return JSON.stringify([session.sessionId, session.connectionGeneration, session.runtimeSnapshot?.id ?? session.agentId, session.cwd, session.taskDir, session.turnId, session.stateRevision, session.historyPersistence?.committedThroughEventId, session.historyPersistence?.committedThroughSeq])
}

export function runtimeHandoffUnavailableReason(session: AcpSessionRecord, locallyBusy: boolean): string | undefined {
  if (locallyBusy || ['starting', 'busy', 'awaiting_permission', 'cancelling'].includes(session.status) || session.restorePending) return '请等待当前回合和连接操作结束。'
  if (session.cleanupRequired) return '请先完成当前会话的连接清理。'
  if (session.pendingPermissions?.length) return '请先处理当前会话的授权请求。'
  if (session.archivedAt) return '请先取消归档，再准备新的接续。'
  if (session.historyPersistence && session.historyPersistence.state !== 'saved') return '请等待历史保存完成，或先恢复历史记录。'
  if (!isMeaningfulConversation(session)) return '完成一轮对话后，可以用另一个 Runtime 接续。'
  return undefined
}

/** An IPC timeout leaves a mutation's outcome unknown; it does not cancel it. */
export async function handoffRequest<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('请求暂未返回，请检查接续状态。')), 12000) })])
  } finally { clearTimeout(timer) }
}
