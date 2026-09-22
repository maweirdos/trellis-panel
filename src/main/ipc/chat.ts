import { app } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { chatService } from '../services/chat'
import { distillToNote } from '../services/kb-distill'
import { getProjectRoot, getSnapshot } from '../state'
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
import type { ThinkingLevel } from '../../shared/types'
import type { ChatMessageView } from '../../shared/types'
import { handle } from './registry'
import type { WindowDeps } from './deps'

let depsCapture: WindowDeps['captureMain'] = async () => null

export function registerChatIpc(deps?: WindowDeps): void {
  if (deps) depsCapture = deps.captureMain
  chatService.init(app)

  handle(ipcInvoke.chat.list, () => ({ ok: true, sessions: listSessions(app) }))

  handle(ipcInvoke.chat.screenshot, async () => {
    try {
      const dataUrl = await depsCapture()
      if (!dataUrl) return ipcFail(IpcErrorCode.Unknown, '截图失败')
      return { ok: true, dataUrl }
    } catch (e) {
      return ipcFail(IpcErrorCode.Unknown, errorMessage(e) ?? '截图失败')
    }
  })

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

  handle(ipcInvoke.chat.send, (_e, input: { sessionId: string; content: string; providerId?: string; modelId?: string; thinkingLevel?: string; images?: string[]; agent?: boolean; taskDir?: string | null }) => {
    return chatService.send({
      sessionId: String(input?.sessionId ?? ''),
      content: String(input?.content ?? ''),
      providerId: input?.providerId ? String(input.providerId) : undefined,
      modelId: input?.modelId ? String(input.modelId) : undefined,
      thinkingLevel: input?.thinkingLevel as ThinkingLevel | undefined,
      images: Array.isArray(input?.images) ? input.images.map(String) : undefined,
      agent: typeof input?.agent === 'boolean' ? input.agent : undefined,
      taskDir: input?.taskDir !== undefined ? input.taskDir : undefined
    })
  })

  /** 对话沉淀：把一条问答交给 AI 加工成知识笔记（写入 .trellis/notes/） */
  handle(ipcInvoke.chat.distill, async (_e, sessionId: string, messageId: string) => {
    const root = getProjectRoot()
    if (!root) return ipcFail(IpcErrorCode.InvalidArg, '未打开项目')
    const session = openSession(app, String(sessionId ?? ''))
    if (!session) return ipcFail(IpcErrorCode.NotFound, '会话不存在')
    const node = session.nodes[String(messageId ?? '')]
    if (!node || node.role !== 'assistant') return ipcFail(IpcErrorCode.InvalidArg, '只能沉淀 AI 回答')
    // 找到该回答之前最近的用户消息作为问题
    const path = activePath(session)
    const idx = path.findIndex((n) => n.id === node.id)
    const questionNode = [...path.slice(0, idx)].reverse().find((n) => n.role === 'user')
    if (!questionNode) return ipcFail(IpcErrorCode.InvalidArg, '未找到对应的提问')
    const sources = (node.toolOps ?? [])
      .flatMap((op) => op.sources ?? [])
      .filter((s, i, arr) => arr.findIndex((x) => x.path === s.path) === i)
      .slice(0, 6)
    const taskTitle = session.taskDir ? getSnapshot()?.tasks.find((t) => t.dirName === session.taskDir)?.record?.title : undefined
    const res = await distillToNote(root, {
      question: questionNode.content,
      answer: node.content,
      sources,
      taskTitle: taskTitle ?? undefined
    })
    if (!res.ok) return ipcFail(IpcErrorCode.Unknown, res.error ?? '沉淀失败')
    return { ok: true, fileName: res.fileName, path: res.path }
  })

  handle(ipcInvoke.chat.abort, (_e, sessionId: string) => chatService.abort(String(sessionId ?? '')))

  handle(ipcInvoke.chat.regenerate, (_e, sessionId: string) => chatService.regenerate(String(sessionId ?? '')))

  handle(ipcInvoke.chat.edit, (_e, sessionId: string, messageId: string, content: string) =>
    chatService.editAndResend(String(sessionId ?? ''), String(messageId ?? ''), String(content ?? ''))
  )

  handle(ipcInvoke.chat.branch, (_e, sessionId: string, messageId: string) =>
    chatService.branch(String(sessionId ?? ''), String(messageId ?? ''))
  )

  handle(ipcInvoke.chat.steer, (_e, sessionId: string, content: string) =>
    chatService.steer(String(sessionId ?? ''), String(content ?? ''))
  )

  handle(
    ipcInvoke.chat.permissionResolve,
    (_e, permId: string, decision: 'allow-once' | 'allow-session' | 'deny') =>
      chatService.resolvePermission(String(permId ?? ''), decision)
  )
}
