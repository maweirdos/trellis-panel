import { app } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { archiveQuerySchema, listSessions, openSession, sessionView } from '../services/chat-store'
import { errorMessage } from '../../shared/errors'
import { handle } from './registry'

/** Historical API conversations are available only for reading. */
export function registerChatArchiveIpc(): void {
  handle(ipcInvoke.chat.list, () => {
    try { return { ok: true, sessions: listSessions(app) } }
    catch (error) { return ipcFail(IpcErrorCode.Io, errorMessage(error) || '历史会话列表无法读取') }
  })

  handle(ipcInvoke.chat.open, (_event, id: unknown, branchId?: unknown) => {
    const query = archiveQuerySchema.safeParse({ id, branchId })
    if (!query.success) return ipcFail(IpcErrorCode.InvalidArg, '无效的归档会话或分支 ID')
    try {
      const session = openSession(app, query.data.id)
      if (!session) return ipcFail(IpcErrorCode.NotFound, '历史会话不存在')
      if (query.data.branchId !== undefined && !Object.hasOwn(session.nodes, query.data.branchId)) return ipcFail(IpcErrorCode.NotFound, '历史分支不存在')
      return { ok: true, session: sessionView(session, query.data.branchId) }
    } catch (error) {
      return ipcFail(IpcErrorCode.Io, errorMessage(error) || '历史会话无法读取')
    }
  })
}
