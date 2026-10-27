import { api } from '../api'
import { projectRootKey } from '../my/navigation'
import type { AcpSessionMeta, AcpSessionRecord, AcpSourceReference, AcpStateEvent } from '../../../shared/types'

export type ConversationReferenceOwner = Pick<AcpSessionMeta, 'sessionId' | 'projectRoot' | 'taskDir' | 'backendSessionId' | 'agentSessionId' | 'connectionGeneration'>

/** An archived startup snapshot is not evidence of a running connection. */
export function conversationConnectionStatus(session: AcpSessionMeta): AcpSessionMeta['status'] {
  return session.connectionOwned === false && ['starting', 'ready', 'busy', 'awaiting_permission', 'cancelling'].includes(session.status) ? 'disconnected' : session.status
}

export function canSubmitConversation(session: AcpSessionRecord): boolean {
  const status = conversationConnectionStatus(session)
  return !session.archivedAt && !session.cleanupRequired && (['ready', 'starting'].includes(status) ||
    (session.canResume === true && ['closed', 'disconnected', 'error'].includes(status)))
}

/** Rebind the submitted copy only; file bytes/revision remain main's authority. */
export function rebindSubmittedReferences(original: ConversationReferenceOwner, fresh: ConversationReferenceOwner, references: AcpSourceReference[]): AcpSourceReference[] {
  if (!references.length) return references
  if (original.sessionId !== fresh.sessionId || projectRootKey(original.projectRoot) !== projectRootKey(fresh.projectRoot) || original.taskDir !== fresh.taskDir ||
    references.some((source) => projectRootKey(source.projectRoot) !== projectRootKey(original.projectRoot) || source.targetSessionId !== original.sessionId || source.taskDir !== original.taskDir || source.targetConnectionGeneration !== original.connectionGeneration)) {
    throw Error('引用的项目、任务或会话已变化。草稿与原版本引用已保留，请核对来源。')
  }
  if (references.every((source) => source.targetConnectionGeneration === fresh.connectionGeneration)) return references
  if (!fresh.connectionGeneration || !original.backendSessionId || original.backendSessionId !== fresh.backendSessionId || (original.agentSessionId && original.agentSessionId !== fresh.agentSessionId)) {
    throw Error('无法确认原会话身份，未更新引用目标。草稿与原版本引用已保留。')
  }
  return references.map((source) => ({ ...source, targetConnectionGeneration: fresh.connectionGeneration }))
}

/** Send is the authority to connect this identity. Selection never calls here. */
export async function connectConversationForSend(session: AcpSessionRecord, signal: AbortSignal, readLive: () => AcpSessionRecord | undefined): Promise<AcpSessionRecord> {
  let acknowledged = false
  let candidate: AcpSessionRecord | undefined
  let connectingGeneration: string | undefined
  let connectionError = ''
  let rejected: Error | undefined
  let resolveReady: (session: AcpSessionRecord) => void = () => {}
  let rejectReady: (error: Error) => void = () => {}
  const ready = new Promise<AcpSessionRecord>((resolve, reject) => { resolveReady = resolve; rejectReady = (error) => { rejected = error; reject(error) } })
  // Attach a rejection handler before awaiting the independent resume RPC.
  void ready.catch(() => {})
  const accept = (record: AcpSessionRecord): void => {
    if (signal.aborted || record.sessionId !== session.sessionId || projectRootKey(record.projectRoot) !== projectRootKey(session.projectRoot)) return
    if (candidate?.stateRevision !== undefined && record.stateRevision !== undefined && record.stateRevision < candidate.stateRevision) return
    if ((session.backendSessionId && record.backendSessionId !== session.backendSessionId) || (session.agentSessionId && record.agentSessionId !== session.agentSessionId)) {
      rejectReady(new Error('原会话身份已改变，草稿已保留。')); return
    }
    if (record.connectionGeneration && ['starting', 'ready'].includes(record.status)) {
      if (connectingGeneration && record.connectionGeneration !== connectingGeneration) {
        rejectReady(new Error('会话连接已变化，草稿已保留。')); return
      }
      connectingGeneration = record.connectionGeneration
    }
    candidate = record
    if (!acknowledged) return
    if (record.cleanupRequired || record.archivedAt || record.connectionOwned === false) rejectReady(new Error(record.error || '原会话连接尚未确认，草稿已保留。'))
    else if (record.status === 'ready' && record.connectionGeneration && !record.restorePending) resolveReady(record)
    else if (['error', 'closed', 'disconnected', 'busy', 'awaiting_permission', 'cancelling'].includes(record.status)) rejectReady(new Error(record.error || '原会话当前不能发送，草稿已保留。'))
  }
  const abort = (): void => rejectReady(new Error('发送已停止，草稿已保留。'))
  const metadataFailed = (message: string): void => {
    connectionError = message
    // A failed archive read does not erase a real ready owner. Resume has
    // acknowledged it; main still checks this live generation on dispatch.
    const live = readLive()
    if (live?.status === 'ready') accept(live)
    else rejectReady(new Error(message))
  }
  const off = api.onAcpState((state: AcpStateEvent) => {
    if (state.sessionId !== session.sessionId || projectRootKey(state.projectRoot) !== projectRootKey(session.projectRoot)) return
    accept({ ...(candidate ?? session), ...state.session, status: state.status, connectionGeneration: state.connectionGeneration ?? state.session?.connectionGeneration,
      stateRevision: state.stateRevision, error: state.error, events: [] })
  })
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => rejectReady(new Error(connectionError || '原会话连接尚未确认，请重试发送。草稿已保留。')), 60000)
  try {
    if (signal.aborted) throw new Error('发送已停止，草稿已保留。')
    // A current metadata read can prove a reusable live owner. A cached ready
    // record alone cannot: it may be awaiting idle eviction in main.
    if (session.status === 'ready' && typeof api.acpHistorySession === 'function') {
      const current = await Promise.race([api.acpHistorySession(session.sessionId).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : '无法核对连接状态' })), ready])
      if (signal.aborted) throw new Error('发送已停止，草稿已保留。')
      if (!('ok' in current)) throw new Error('原会话连接尚未确认，草稿已保留。')
      if (!current.ok) connectionError = current.error
      else {
        const fresh = { ...current.session, events: [] }
        if (fresh.sessionId !== session.sessionId || projectRootKey(fresh.projectRoot) !== projectRootKey(session.projectRoot)) throw new Error('项目或会话已变化，草稿已保留。')
        accept(fresh)
        if (rejected) throw rejected
        // Reconcile any state that overtook this read, including eviction/End.
        const latest = candidate ?? fresh
        if (fresh.connectionOwned === true && latest.status === 'ready' && latest.connectionOwned === true && latest.connectionGeneration === fresh.connectionGeneration && latest.connectionGeneration && !latest.restorePending && !latest.cleanupRequired && !latest.archivedAt) return latest
        if (latest.cleanupRequired || latest.archivedAt) throw new Error(latest.error || '原会话当前不能发送，草稿已保留。')
      }
    }
    if (signal.aborted) throw new Error('发送已停止，草稿已保留。')
    // Only this explicit send may restore; the main process joins an existing
    // preparation and reuses the same native identity. Never replay a prompt.
    candidate = undefined; connectingGeneration = undefined
    const response = await Promise.race([api.acpSessionResume(session.sessionId), ready])
    if (!('ok' in response)) throw new Error('原会话连接尚未确认，草稿已保留。')
    if (!response.ok) throw new Error(response.error || '连接失败，草稿已保留。')
    if (response.sessionId && response.sessionId !== session.sessionId) throw new Error('原会话身份不匹配，草稿已保留。')
    if (signal.aborted) throw new Error('发送已停止，草稿已保留。')
    acknowledged = true
    if (typeof api.acpHistorySession === 'function') {
      // A ready owner may be evicted without the selected view catching up.
      // Resume awaits that eviction/reconnect; read its current generation,
      // never treat the pre-Send ready snapshot or ok alone as readiness.
      void api.acpHistorySession(session.sessionId).then((result) => {
        if (result.ok && (result.session.sessionId !== session.sessionId || projectRootKey(result.session.projectRoot) !== projectRootKey(session.projectRoot))) rejectReady(new Error('项目或会话已变化，草稿已保留。'))
        else if (result.ok) accept({ ...result.session, events: [] })
        else if (!result.ok) metadataFailed(result.error)
      }).catch((error: unknown) => { metadataFailed(error instanceof Error ? error.message : '无法核对连接状态') })
    } else {
      // Legacy bridges expose only the current live state and full catalogue.
      // Resume has acknowledged native readiness; still read the current owner.
      const live = readLive()
      if (live) accept(live)
    }
    return await ready
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); off() }
}
