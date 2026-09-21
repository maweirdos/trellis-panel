import { broadcastToWindows } from './bridge'
import { getSettings } from './store'
import { aiChatStream, decryptKeyOf, type StreamTarget } from './ai'
import type { ThinkingLevel } from '../../shared/types'
import {
  activePath,
  addChildNode,
  appendNode,
  createSession,
  openSession,
  renameSession,
  setLeaf,
  updateBinding,
  type AppPathProvider,
  type ChatNode
} from './chat-store'
import { ipcEvent } from '../../shared/ipc-channels'
import type { ChatImage, ChatMessage, ChatSendResult, ModelProvider } from '../../shared/types'

/**
 * 对话运行时（TPD-016 树语义）：每会话串行（一忙不二跑），忙碌发送进 FIFO 队列、轮末自动续发；
 * 编辑重发与 regenerate 均以兄弟分支实现，旧分支保留可切回；
 * 事件遵循 TPD 事件流约定（chat:output / chat:done，runId 关联成对）。
 */

interface RunState {
  runId: string
  sessionId: string
  controller: AbortController
}

interface QueuedItem {
  runId: string
  content: string
  images?: ChatImage[]
}

function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function resolveProvider(providerId?: string): ModelProvider | null {
  const cfg = getSettings().ai
  const list = cfg.providers ?? []
  return list.find((p) => p.id === providerId) ?? list.find((p) => p.id === cfg.activeProviderId) ?? list[0] ?? null
}

function targetOf(provider: ModelProvider, modelId: string, thinkingLevel?: ThinkingLevel): StreamTarget {
  return {
    baseUrl: provider.baseUrl,
    apiFormat: provider.apiFormat,
    apiKey: decryptKeyOf(provider.apiKey, provider.apiKeyEncrypted),
    model: modelId,
    temperature: 0.4,
    thinkingLevel
  }
}

class ChatService {
  private runs = new Map<string, RunState>() // runId → run
  private active = new Map<string, string>() // sessionId → runId
  private queues = new Map<string, QueuedItem[]>() // sessionId → FIFO
  private appProvider: AppPathProvider | null = null

  init(app: AppPathProvider): void {
    this.appProvider = app
  }

  private app(): AppPathProvider {
    if (!this.appProvider) throw new Error('chat service 未初始化')
    return this.appProvider
  }

  queueLength(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0
  }

  createSession(binding?: { providerId?: string; modelId?: string }) {
    return createSession(this.app(), binding)
  }

  send(input: {
    sessionId: string
    content: string
    providerId?: string
    modelId?: string
    thinkingLevel?: ThinkingLevel
    images?: string[]
  }): ChatSendResult {
    const app = this.app()
    const content = String(input.content ?? '').trim()
    if (!content && !(input.images?.length)) return { ok: false, error: '消息不能为空', runId: null, queued: false }
    const session = openSession(app, input.sessionId)
    if (!session) return { ok: false, error: '会话不存在', runId: null, queued: false }

    const imgs = this.parseImages(input.images)
    if (imgs.error) return { ok: false, error: imgs.error, runId: null, queued: false }

    // 绑定更新：发送时可携带 provider/model/thinking（composer 切换即持久化到会话）
    if (input.providerId || input.modelId || input.thinkingLevel) {
      updateBinding(app, input.sessionId, {
        providerId: input.providerId,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel
      })
    }

    const runId = newRunId()
    const busy = this.active.has(input.sessionId)
    if (busy) {
      const queue = this.queues.get(input.sessionId) ?? []
      queue.push({ runId, content, images: imgs.images })
      this.queues.set(input.sessionId, queue)
      return { ok: true, runId, queued: true, queueLen: queue.length }
    }
    const userNode = appendNode(app, input.sessionId, {
      role: 'user',
      content,
      ...(imgs.images?.length ? { images: imgs.images } : {})
    })
    void this.startTurn(runId, input.sessionId, {
      historyEndLeafId: userNode.id,
      assistantParentId: userNode.id
    })
    return { ok: true, runId, queued: false }
  }

  /** 解析并校验 dataURL 图片（TPD-019）：≤4 张、单张 dataURL ≤4MB */
  private parseImages(images?: string[]): { images?: ChatImage[]; error?: string } {
    if (!images?.length) return {}
    if (images.length > 4) return { error: '每条消息最多 4 张图片' }
    const parsed: ChatImage[] = []
    for (const dataUrl of images) {
      if (dataUrl.length > 4 * 1024 * 1024) return { error: '单张图片超过 4MB' }
      const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl.trim())
      if (!m) return { error: '图片格式无效' }
      parsed.push({ mediaType: m[1], dataBase64: m[2] })
    }
    return { images: parsed }
  }

  /** 编辑重发：user 节点生成兄弟分支重跑（旧分支保留，可经 chat:branch 切回） */
  editAndResend(sessionId: string, messageId: string, newContent: string): ChatSendResult {
    const app = this.app()
    const session = openSession(app, sessionId)
    if (!session) return { ok: false, error: '会话不存在', runId: null, queued: false }
    if (this.active.has(sessionId)) return { ok: false, error: '当前有轮次运行中', runId: null, queued: false }
    const node: ChatNode | undefined = session.nodes[messageId]
    if (!node || node.role !== 'user') return { ok: false, error: '只能编辑用户消息', runId: null, queued: false }
    const content = String(newContent ?? '').trim()
    if (!content) return { ok: false, error: '消息不能为空', runId: null, queued: false }
    const sibling = addChildNode(app, sessionId, node.parent, { role: 'user', content })
    const runId = newRunId()
    void this.startTurn(runId, sessionId, {
      historyEndLeafId: sibling.id,
      assistantParentId: sibling.id
    })
    return { ok: true, runId, queued: false }
  }

  /** 分支切换：activeLeaf 置为指定节点（视图截至该处） */
  branch(sessionId: string, messageId: string): { ok: boolean; error?: string } {
    const app = this.app()
    const session = openSession(app, sessionId)
    if (!session) return { ok: false, error: '会话不存在' }
    if (this.active.has(sessionId)) return { ok: false, error: '当前有轮次运行中' }
    if (!session.nodes[messageId]) return { ok: false, error: '分支节点不存在' }
    setLeaf(app, sessionId, messageId)
    return { ok: true }
  }

  /** 重新生成：同父生成兄弟 assistant 并切换（旧回答保留可切回） */
  regenerate(sessionId: string): ChatSendResult {
    const app = this.app()
    const session = openSession(app, sessionId)
    if (!session) return { ok: false, error: '会话不存在', runId: null, queued: false }
    if (this.active.has(sessionId)) return { ok: false, error: '当前有轮次运行中', runId: null, queued: false }
    const leaf = session.activeLeaf ? session.nodes[session.activeLeaf] : undefined
    if (!leaf || leaf.role !== 'assistant') return { ok: false, error: '没有可重新生成的回答', runId: null, queued: false }
    const runId = newRunId()
    void this.startTurn(runId, sessionId, {
      historyEndLeafId: leaf.parent ?? '',
      assistantParentId: leaf.parent,
      thinkingLevel: session.thinkingLevel ?? 'off'
    })
    return { ok: true, runId, queued: false }
  }

  abort(sessionId: string): { ok: boolean; error?: string } {
    const runId = this.active.get(sessionId)
    if (runId) {
      this.runs.get(runId)?.controller.abort()
    }
    const queue = this.queues.get(sessionId)
    if (queue?.length) {
      for (const item of queue) {
        broadcastToWindows(ipcEvent.chatDone, {
          runId: item.runId,
          sessionId,
          kind: 'aborted' as const
        })
      }
      this.queues.delete(sessionId)
    }
    return { ok: true }
  }

  /** 一轮：history 取 historyEndLeafId 的活跃路径；完成后在其下挂 assistant 兄弟并置为活跃叶 */
  private async startTurn(
    runId: string,
    sessionId: string,
    opts: { historyEndLeafId: string; assistantParentId: string | null; thinkingLevel?: ThinkingLevel }
  ): Promise<void> {
    const app = this.app()
    const session = openSession(app, sessionId)
    if (!session) {
      this.finish(runId, sessionId, { kind: 'error', error: '会话不存在' })
      return
    }
    const controller = new AbortController()
    this.runs.set(runId, { runId, sessionId, controller })
    this.active.set(sessionId, runId)

    // 剥离节点元数据（id/parent），仅传协议字段；images 透传
    const history: ChatMessage[] = activePath({ ...session, activeLeaf: opts.historyEndLeafId })
      .filter((n) => n.role !== 'system')
      .map((n) => ({
        role: n.role,
        content: n.content,
        ...(n.reasoning ? { reasoning: n.reasoning } : {}),
        ...(n.images?.length ? { images: n.images } : {})
      }))
    if (history.length === 0) {
      this.finish(runId, sessionId, { kind: 'error', error: '没有可发送的内容' })
      return
    }

    const provider = resolveProvider(session.providerId ?? undefined)
    const modelId = session.modelId || provider?.models?.find((m) => m.enabled)?.id || provider?.models?.[0]?.id || ''
    if (!provider) {
      this.finish(runId, sessionId, { kind: 'error', error: '未配置模型供应商（设置 → AI 模型）' })
      return
    }
    if (!modelId) {
      this.finish(runId, sessionId, { kind: 'error', error: '当前供应商未选择模型' })
      return
    }

    // 增量只走事件不落盘；assistant 节点在完成时一次性落库
    const result = await aiChatStream(
      targetOf(provider, modelId, opts.thinkingLevel ?? session.thinkingLevel ?? 'off'),
      history,
      {
        signal: controller.signal,
        onDelta: (delta) => {
          broadcastToWindows(ipcEvent.chatOutput, { runId, sessionId, delta })
        },
        onReasoning: (reasoning) => {
          broadcastToWindows(ipcEvent.chatOutput, { runId, sessionId, delta: '', reasoning })
        }
      }
    )

    if (result.aborted) {
      this.finish(runId, sessionId, { kind: 'aborted' })
      return
    }
    if (!result.ok || !result.content) {
      // 错误不落库为 assistant 节点（避免污染分支历史），渲染层凭 done 事件展示
      this.finish(runId, sessionId, { kind: 'error', error: result.error ?? '未知错误' })
      return
    }

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: result.content,
      ...(result.reasoning ? { reasoning: result.reasoning } : {})
    }
    addChildNode(app, sessionId, opts.assistantParentId, assistantMsg)
    void this.maybeSummarizeTitle(sessionId)
    this.finish(runId, sessionId, { kind: 'done', message: assistantMsg })
  }

  private finish(
    runId: string,
    sessionId: string,
    extra: { kind: 'done' | 'error' | 'aborted'; error?: string; message?: ChatMessage }
  ): void {
    this.runs.delete(runId)
    if (this.active.get(sessionId) === runId) this.active.delete(sessionId)
    broadcastToWindows(ipcEvent.chatDone, { runId, sessionId, ...extra })
    // 队列续发（微小退避让渲染层先完成本轮 UI 固化）
    const queue = this.queues.get(sessionId)
    if (queue?.length) {
      const next = queue.shift()
      if (queue.length === 0) this.queues.delete(sessionId)
      if (next) {
        setTimeout(() => {
          const userNode = appendNode(this.app(), sessionId, {
            role: 'user',
            content: next.content,
            ...(next.images?.length ? { images: next.images } : {})
          })
          void this.startTurn(next.runId, sessionId, {
            historyEndLeafId: userNode.id,
            assistantParentId: userNode.id
          })
        }, 50)
      }
    }
  }

  /** 首轮完成后异步总结标题（best-effort，失败保留默认标题） */
  private async maybeSummarizeTitle(sessionId: string): Promise<void> {
    try {
      const app = this.app()
      const session = openSession(app, sessionId)
      const path = session ? activePath(session) : []
      if (!session || path.length !== 2) return // 仅首轮
      const cfg = getSettings().ai
      if (!cfg.enabled) {
        this.applyTitle(sessionId, path[0]?.content ?? '')
        return
      }
      const provider = resolveProvider(session.providerId ?? undefined)
      const modelId = session.modelId || provider?.models?.[0]?.id || ''
      if (!provider || !modelId) {
        this.applyTitle(sessionId, path[0]?.content ?? '')
        return
      }
      const res = await aiChatStream(targetOf(provider, modelId), [
        { role: 'system', content: '为用户消息拟一个不超过 16 字的中文标题，直接输出标题本身，不要标点结尾。' },
        { role: 'user', content: path[0]?.content?.slice(0, 500) ?? '' }
      ], { signal: undefined, onDelta: () => {} })
      const title = res.ok && res.content ? res.content.replace(/\s+/g, ' ').trim().slice(0, 24) : ''
      if (title) {
        renameSession(app, sessionId, title)
        broadcastToWindows(ipcEvent.chatDone, { runId: `title-${sessionId}`, sessionId, kind: 'done', title })
      }
    } catch {
      // 标题总结是 best-effort
    }
  }

  private applyTitle(sessionId: string, firstUserMsg: string): void {
    const fallback = firstUserMsg.replace(/\s+/g, ' ').trim().slice(0, 18) || '新对话'
    try {
      renameSession(this.app(), sessionId, fallback)
      broadcastToWindows(ipcEvent.chatDone, { runId: `title-${sessionId}`, sessionId, kind: 'done', title: fallback })
    } catch {
      // ignore
    }
  }
}

export const chatService = new ChatService()
