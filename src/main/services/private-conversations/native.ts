import { realpathSync, statSync } from 'node:fs'
import { samePlanningPolicy } from '../acp/task-planning-policy'
import { isAbsolute } from 'node:path'
import { privateNativeReadSchema, privateNativeSendSchema, privateNativeControlSchema, type PrivateNativeOwner } from '../../../shared/private-conversations'
import { ipcFail, IpcErrorCode } from '../../../shared/ipc-errors'
import * as acp from '../acp'
import { canonicalDirectory } from '../acp/metadata'
import { withOrdinaryConnectionAdmission, withOrdinaryWorkflowAdmission } from '../workflow-desktop'

function assertDirectory(owner: PrivateNativeOwner): void {
  if (owner.sessionId !== `acp-private-${owner.conversationId}` || !isAbsolute(owner.root) || realpathSync.native(owner.root) !== owner.root || !statSync(owner.root).isDirectory()) throw new Error('私有会话的原目录身份已变化')
}
export async function privateNativeSession(owner: PrivateNativeOwner) {
  assertDirectory(owner)
  const result = await acp.getAcpHistorySession(owner.root, owner.sessionId)
  assertDirectory(owner)
  if (!result.ok) return result
  const meta = result.session
  if (!samePlanningPolicy(meta.privateConversation?.planningPolicy, owner.planningPolicy)) return ipcFail(IpcErrorCode.Denied, '原任务规划策略不一致；未授予普通发送或配置权限')
  if (meta.privateConversation?.id !== owner.conversationId || meta.privateConversation.creatorId !== owner.creatorId || canonicalDirectory(meta.projectRoot) !== canonicalDirectory(owner.root) || canonicalDirectory(meta.cwd ?? meta.projectRoot) !== canonicalDirectory(owner.root)) return ipcFail(IpcErrorCode.Denied, '此原生会话不属于当前私有会话')
  return result
}
export async function privateNativeRead(raw: unknown) {
  const input = privateNativeReadSchema.parse(raw), session = await privateNativeSession(input)
  if (!session.ok) return session
  if (input.operation === 'events') return acp.getAcpHistoryEvents(input.root, input.sessionId, input.paging)
  if (input.operation === 'image') return input.imageId ? acp.getAcpPiImage(input.root, input.sessionId, input.imageId) : ipcFail(IpcErrorCode.InvalidArg, '请选择图片')
  return session
}
export async function privateNativeSend(raw: unknown, valid: () => boolean) {
  const input = privateNativeSendSchema.parse(raw)
  assertDirectory(input)
  if (input.operation === 'prepare') {
    const connected = await withOrdinaryConnectionAdmission(input.root, {}, () => acp.ensurePrivateAcpSession(input.root, input.agentId, input))
    if (!connected.ok) return { ...connected, notSent: true }
    const ready = await privateNativeSession(input)
    if (!ready.ok) return { ...ready, notSent: true }
    if (input.initialModelId && ready.session.currentModelId !== input.initialModelId) {
      if (!valid() || !ready.session.connectionGeneration || input.agentId !== 'pi') return ipcFail(IpcErrorCode.Conflict, '原会话连接已变化，模型未应用，消息未发送', { notSent: true })
      const configured = await acp.configureAcpSession(input.root, input.sessionId, { kind: 'model', id: input.initialModelId })
      if (!configured.ok) return { ...configured, notSent: true }
      if (!valid() || configured.session.connectionGeneration !== ready.session.connectionGeneration || configured.session.currentModelId !== input.initialModelId) return ipcFail(IpcErrorCode.Conflict, '执行引擎未确认所选模型，消息未发送', { notSent: true })
      return { ok: true as const, session: { ...configured.session, events: [] } }
    }
    return { ok: true as const, session: { ...ready.session, events: [] } }
  }
  if (!valid()) return ipcFail(IpcErrorCode.Conflict, '原生准入已关闭，消息未发送', { notSent: true })
  const session = await privateNativeSession(input)
  if (!session.ok) return { ...session, notSent: true }
  if (session.session.agentId !== input.agentId || !session.session.connectionGeneration) return ipcFail(IpcErrorCode.Conflict, '原生身份未确认，消息未发送', { notSent: true })
  if (input.input.expectedConnectionGeneration && input.input.expectedConnectionGeneration !== session.session.connectionGeneration) return ipcFail(IpcErrorCode.Conflict, '原连接已变化，请重新核对后发送', { notSent: true })
  const result = await withOrdinaryWorkflowAdmission(input.root, input.sessionId, session.session.connectionGeneration, admitted => acp.promptAcpSession(input.root, input.sessionId, input.input.text,
    { images: input.input.images, expectedConnectionGeneration: session.session.connectionGeneration }, () => valid() && admitted(), 0, undefined, input.input.requestId, input.displayText))
  if (!result.ok) {
    const latest = await privateNativeSession(input)
    return latest.ok && latest.session.privateConversation?.request?.id !== input.input.requestId ? { ...result, notSent: true } : result
  }
  const latest = await privateNativeSession(input)
  return latest.ok ? { ok: true as const, session: { ...latest.session, events: [] }, turnId: result.turnId } : { ...latest, outcome: 'unknown' }
}
export async function privateNativeControl(operation: 'cancel' | 'end' | 'respond', raw: unknown) {
  const input = privateNativeControlSchema.parse(raw)
  const session = operation === 'respond' ? await privateNativeSession(input) : acp.getPrivateAcpCleanupSession(input.root, input.sessionId)
  if (!session.ok) return session
  if (input.expectedConnectionGeneration && session.session.connectionGeneration !== input.expectedConnectionGeneration) return ipcFail(IpcErrorCode.Conflict, '原生连接已变化')
  if (operation === 'cancel') return acp.cancelAcpSession(input.root, input.sessionId)
  if (operation === 'end') return acp.killAcpSession(input.root, input.sessionId)
  const pending = (session.session.pendingPermissions ?? []).find(item => item.requestId === input.requestId && item.sessionId === input.sessionId && item.connectionGeneration === input.expectedConnectionGeneration)
  if (!pending || !input.expectedConnectionGeneration || !input.optionId || !pending.options.some(option => option.optionId === input.optionId)) return ipcFail(IpcErrorCode.Denied, '权限请求已结束或不属于原会话')
  if (session.session.privateConversation?.planningPolicy) return acp.respondTaskPlanningPermission(input.root, pending.requestId, input.optionId)
  return acp.respondAcpPermission(input.root, pending.requestId, input.optionId)
}
