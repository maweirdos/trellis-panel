import { privateNativeConfigureSchema, privateNativeRecoverModelSchema } from '../../../shared/private-conversation-controls'
import { ipcFail, IpcErrorCode } from '../../../shared/ipc-errors'
import { withPrivateAcpOwner } from '../acp/private-access'
import { configureAcpSession, recoverAcpSessionModel } from '../acp'
import { withOrdinaryConnectionAdmission } from '../workflow-desktop'
import { privateNativeSession } from './native'

export function configurePrivateNativeSession(raw: unknown, current: () => boolean) {
  const input = privateNativeConfigureSchema.parse(raw)
  return withPrivateAcpOwner(input, async () => {
    const existing = await privateNativeSession(input)
    if (!existing.ok) return existing
    if (!current() || existing.session.connectionGeneration !== input.input.expectedConnectionGeneration)
      return ipcFail(IpcErrorCode.Conflict, '原会话连接已变化，配置未提交')
    return configureAcpSession(input.root, input.sessionId, input.input.configuration)
  })
}

export function recoverPrivateNativeModel(raw: unknown, current: () => boolean) {
  const input = privateNativeRecoverModelSchema.parse(raw)
  return withPrivateAcpOwner(input, async () => {
    const existing = await privateNativeSession(input)
    if (!existing.ok) return existing
    if (!current() || existing.session.connectionGeneration !== input.input.expectedConnectionGeneration)
      return ipcFail(IpcErrorCode.Conflict, '原会话连接已变化，请重新核对模型')
    return withOrdinaryConnectionAdmission(input.root, { sessionId: input.sessionId }, () =>
      recoverAcpSessionModel(input.root, input.sessionId, input.input, current))
  })
}
