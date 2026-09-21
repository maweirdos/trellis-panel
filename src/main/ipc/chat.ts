import { app } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { chatService } from '../services/chat'
import {
  activePath,
  createSession,
  deleteSession,
  listSessions,
  openSession,
  renameSession,
  siblingsOf
} from '../services/chat-store'
import { errorMessage } from '../../shared/errors'
import type { ChatMessageView } from '../../shared/types'
import { handle } from './registry'

export function registerChatIpc(): void {
  chatService.init(app)

  handle(ipcInvoke.chat.list, () => ({ ok: true, sessions: listSessions(app) }))

  handle(ipcInvoke.chat.open, (_e, id: string) => {
    const session = openSession(app, String(id ?? ''))
    if (!session) return ipcFail(IpcErrorCode.NotFound, '会话不存在')
    // 活跃路径视图：每条消息带兄弟分支信息（TPD-016）
    const messages: ChatMessageView[] = activePath(session).map((n) => {
      const siblings = siblingsOf(session, n.id)
      return {
        id: n.id,
        role: n.role,
        content: n.content,
        ...(n.reasoning ? { reasoning: n.reasoning } : {}),
        siblingCount: siblings.length,
        siblingIndex: siblings.findIndex((x) => x.id === n.id),
        siblingIds: siblings.map((x) => x.id)
      }
    })
    return {
      ok: true,
      session: {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: messages.length,
        providerId: session.providerId,
        modelId: session.modelId,
        thinkingLevel: session.thinkingLevel ?? 'off',
        messages
      }
    }
  })

  handle(ipcInvoke.chat.new, (_e, binding?: { providerId?: string; modelId?: string }) => {
    try {
      return { ok: true, session: createSession(app, binding) }
    } catch (e) {
      return ipcFail(IpcErrorCode.Io, errorMessage(e) ?? '创建会话失败')
    }
  })

  handle(ipcInvoke.chat.delete, (_e, id: string) => {
    try {
      deleteSession(app, String(id ?? ''))
      return { ok: true }
    } catch (e) {
      return ipcFail(IpcErrorCode.InvalidArg, errorMessage(e) ?? '删除失败')
    }
  })

  handle(ipcInvoke.chat.rename, (_e, id: string, title: string) => {
    try {
      renameSession(app, String(id ?? ''), String(title ?? ''))
      return { ok: true }
    } catch (e) {
      return ipcFail(IpcErrorCode.NotFound, errorMessage(e) ?? '重命名失败')
    }
  })

  handle(ipcInvoke.chat.send, (_e, input: { sessionId: string; content: string; providerId?: string; modelId?: string }) => {
    return chatService.send({
      sessionId: String(input?.sessionId ?? ''),
      content: String(input?.content ?? ''),
      providerId: input?.providerId ? String(input.providerId) : undefined,
      modelId: input?.modelId ? String(input.modelId) : undefined
    })
  })

  handle(ipcInvoke.chat.abort, (_e, sessionId: string) => chatService.abort(String(sessionId ?? '')))

  handle(ipcInvoke.chat.regenerate, (_e, sessionId: string) => chatService.regenerate(String(sessionId ?? '')))

  handle(ipcInvoke.chat.edit, (_e, sessionId: string, messageId: string, content: string) =>
    chatService.editAndResend(String(sessionId ?? ''), String(messageId ?? ''), String(content ?? ''))
  )

  handle(ipcInvoke.chat.branch, (_e, sessionId: string, messageId: string) =>
    chatService.branch(String(sessionId ?? ''), String(messageId ?? ''))
  )
}
