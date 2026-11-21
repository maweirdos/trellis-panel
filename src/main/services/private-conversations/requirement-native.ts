import type { RequirementOperation } from '../../../shared/conversation-requirements'
import type { TimelineEvent } from '../../../shared/types'
import { replayConversationTextEvents } from '../../../shared/acp-text-blocks'
import { IpcErrorCode } from '../../../shared/ipc-errors'
import type { RequirementNativeObservation } from './requirements'
import { PrivateConversations, ConversationError } from './service'
import { hash, pathKey } from './files'

/** Observe the original native receipt and turn; an idle connection is not a result. */
export async function observeRequirementNative(service: PrivateConversations, conversationId: string, operation: Pick<RequirementOperation, 'requestId' | 'sessionId' | 'turnId' | 'connectionGeneration'>, assertCurrent: () => void, readFinalText = false): Promise<RequirementNativeObservation & { finalText?: string }> {
  assertCurrent()
  const owner = await service.workspaceAccess(conversationId)
  assertCurrent(); owner.assertCurrent()
  const original = owner.conversation, base = { requestId: operation.requestId }
  if (!original.nativeRef) return { ...base, state: 'not-sent', detail: '原需求操作尚未发送' }
  if (operation.sessionId && operation.sessionId !== original.nativeRef.sessionId) throw new ConversationError('需求操作与原生会话不匹配', IpcErrorCode.Denied)
  const receipt = await service.requestReceipt(conversationId, operation.requestId)
  assertCurrent(); owner.assertCurrent()
  if (!receipt.ok) return { ...base, state: 'unknown', detail: receipt.error }
  const response = receipt.receipt.result?.inline
  const inline = response?.ok ? response : undefined
  if (inline && (inline.session.privateConversation?.request?.id !== operation.requestId || !inline.session.privateConversation.request.sent || inline.session.privateConversation.request.turnId !== inline.turnId)) throw new ConversationError('需求操作回执的请求或回合身份不匹配', IpcErrorCode.Denied)
  const direct = receipt.state === 'sent' && receipt.session.privateConversation?.request?.id === operation.requestId && receipt.session.privateConversation.request.sent && receipt.session.privateConversation.request.turnId === receipt.turnId ? receipt.session : undefined
  const proof = direct ?? inline?.session
  const turnId = operation.turnId ?? (direct ? receipt.turnId : inline?.turnId)
  const generation = operation.connectionGeneration ?? proof?.connectionGeneration
  const identity = { ...base, sessionId: original.nativeRef.sessionId, connectionGeneration: generation, turnId }
  if (proof && (proof.sessionId !== original.nativeRef.sessionId || proof.privateConversation?.id !== conversationId || pathKey(proof.projectRoot) !== pathKey(original.workspace.root))) throw new ConversationError('需求操作回执来源不匹配', IpcErrorCode.Denied)
  if (!turnId || !generation) {
    if (response && !response.ok && response.notSent || receipt.state === 'absent') return { ...base, state: 'not-sent', detail: response && !response.ok ? response.error : '未找到原操作的发送回执' }
    return { ...base, state: 'unknown', detail: '原操作发送结果尚待核对' }
  }
  let before: string | undefined
  const cursors = new Set<string>()
  for (let index = 0; index < 4; index++) {
    const result = await service.events(conversationId, { before, limit: 120 })
    assertCurrent(); owner.assertCurrent()
    if (!result.ok) return { ...identity, state: 'unknown', detail: result.error }
    const page = result.value
    if (!page) break
    const terminal = [...page.events].reverse().find(event => event.kind === 'turn-done' && event.sessionId === identity.sessionId && event.turnId === turnId && event.connectionGeneration === generation && typeof event.projectRoot === 'string' && pathKey(event.projectRoot) === pathKey(original.workspace.root))
    if (terminal) {
      const payload = terminal.payload as { result?: { status?: string } } | undefined
      const status = payload?.result?.status
      if (readFinalText && status === 'completed') {
        const turn = page.events.filter(event => event.sessionId === identity.sessionId && event.turnId === turnId && event.connectionGeneration === generation && event.projectRoot && pathKey(event.projectRoot) === pathKey(original.workspace.root))
        if (!turn.some(event => event.kind === 'message' && event.payload?.role === 'user') || page.coverage.state !== 'complete' || page.historyPersistence.state !== 'saved' || page.historyPersistence.pendingCount) return { ...identity, state: 'unknown', detail: '正在核对原会话的完整回复' }
        const outcome = terminal.payload?.result as { stopReason?: string } | undefined
        if (terminal.payload?.hostPolicyOutcome || (outcome?.stopReason ?? terminal.payload?.stopReason) !== 'end_turn') return { ...identity, state: 'failed', detail: '原回合未正常完成，任务尚未创建。' }
        const messages = replayConversationTextEvents(turn).filter(event => event.kind === 'message' && ['acp', 'pi'].includes(event.source ?? '') && (event.payload?.role ?? 'assistant') === 'assistant')
        const final = messages.filter(event => (event.payload?.meta as { phase?: string } | undefined)?.phase === 'final_answer')
        return { ...identity, state: 'completed', finalText: (final.length ? final : messages).map(event => event.text ?? '').join('') }
      }
      if (status === 'completed' || status === 'cancelled' || status === 'failed') return { ...identity, state: status, ...(status !== 'completed' ? { detail: terminal.text?.slice(0, 2000) } : {}) }
      return { ...identity, state: 'unknown', detail: '原回合缺少可核对的结束状态' }
    }
    if (!page.hasEarlier || !page.beforeCursor || cursors.has(page.beforeCursor)) break
    before = page.beforeCursor; cursors.add(before)
  }
  const current = receipt.session
  if (current.sessionId === identity.sessionId && current.turnId === turnId && current.connectionGeneration === generation && current.connectionOwned && ['starting', 'busy', 'awaiting_permission', 'cancelling'].includes(current.status)) return { ...identity, state: 'running' }
  return { ...identity, state: 'unknown', detail: '未读取到原回合的结束记录，请核对后再继续' }
}

/** Explicitly captured private chat context, bounded and separate from shared task materials. */
export async function requirementConversationContext(service: PrivateConversations, conversationId: string, assertCurrent: () => void): Promise<{ text: string; revision: string }> {
  const owner = await service.workspaceAccess(conversationId)
  assertCurrent(); owner.assertCurrent()
  const page = await service.events(conversationId, { limit: 80 })
  assertCurrent(); owner.assertCurrent()
  if (!page.ok) throw new ConversationError(page.error, page.code)
  const messages = (page.value?.events ?? []).filter((event: TimelineEvent) => event.kind === 'message' && event.text && ['user', 'assistant'].includes(String(event.payload?.role ?? ''))).slice(-12)
  const text = messages.map(event => `${event.payload?.role === 'user' ? '用户' : '助手'}：${event.text}`).join('\n\n').slice(-24_000)
  return { text, revision: hash(JSON.stringify(messages.map(({ id, text }) => ({ id, text })))) }
}
