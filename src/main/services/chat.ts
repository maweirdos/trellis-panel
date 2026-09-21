import { broadcastToWindows } from './bridge'
import { getSettings } from './store'
import { aiChatStream, decryptKeyOf, type StreamTarget } from './ai'
import type { ThinkingLevel } from '../../shared/types'
import { appendMessage, createSession, openSession, popLastAssistant, renameSession, updateBinding, type AppPathProvider } from './chat-store'
import { ipcEvent } from '../../shared/ipc-channels'
import type { ChatMessage, ChatSendResult, ModelProvider } from '../../shared/types'

/**
 * 对话运行时：每会话串行（一忙不二跑），忙碌发送进 FIFO 队列、轮末自动续发；
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

  /** 供 index.ts 启动时注入 electron app（避免本模块直接依赖 electron，利于冒烟） */
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
  }): ChatSendResult {
    const app = this.app()
    const content = String(input.content ?? '').trim()
    if (!content) return { ok: false, error: '消息不能为空', runId: null, queued: false }
    const session = openSession(app, input.sessionId)
    if (!session) return { ok: false, error: '会话不存在', runId: null, queued: false }

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
      queue.push({ runId, content })
      this.queues.set(input.sessionId, queue)
      return { ok: true, runId, queued: true, queueLen: queue.length }
    }
    void this.startRun(runId, input.sessionId, content)
    return { ok: true, runId, queued: false }
  }

  /** 重新生成：截断末条 assistant，以原历史重跑（不新增 user 消息） */
  regenerate(sessionId: string): ChatSendResult {
    const app = this.app()
    const session = openSession(app, sessionId)
    if (!session) return { ok: false, error: '会话不存在', runId: null, queued: false }
    if (this.active.has(sessionId)) return { ok: false, error: '当前有轮次运行中', runId: null, queued: false }
    if (session.messages.length === 0 || session.messages[session.messages.length - 1].role !== 'assistant') {
      return { ok: false, error: '没有可重新生成的回答', runId: null, queued: false }
    }
    popLastAssistant(app, sessionId)
    const runId = newRunId()
    void this.startRun(runId, sessionId, '', { appendUser: false, thinkingLevel: session.thinkingLevel ?? 'off' })
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

  private async startRun(
    runId: string,
    sessionId: string,
    content: string,
    opts?: { appendUser?: boolean; thinkingLevel?: ThinkingLevel }
  ): Promise<void> {
    const app = this.app()
    const appendUser = opts?.appendUser ?? true
    const session = openSession(app, sessionId)
    if (!session) {
      this.finish(runId, sessionId, { kind: 'error', error: '会话不存在' })
      return
    }
    const controller = new AbortController()
    this.runs.set(runId, { runId, sessionId, controller })
    this.active.set(sessionId, runId)

    if (appendUser) appendMessage(app, sessionId, { role: 'user', content })
    const history = openSession(app, sessionId)?.messages ?? []
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

    // 流式占位：assistant 消息在完成时一次性落库（增量只走事件，不逐条写盘）
    const result = await aiChatStream(
      targetOf(provider, modelId, opts?.thinkingLevel ?? session.thinkingLevel ?? 'off'),
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
      // 错误不落库为 assistant 消息（避免污染下一轮上下文），渲染层凭 done 事件展示
      this.finish(runId, sessionId, { kind: 'error', error: result.error ?? '未知错误' })
      return
    }

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: result.content,
      ...(result.reasoning ? { reasoning: result.reasoning } : {})
    }
    appendMessage(app, sessionId, assistantMsg)
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
          void this.startRun(next.runId, sessionId, next.content)
        }, 50)
      }
    }
  }

  /** 首轮完成后异步总结标题（best-effort，失败保留默认标题） */
  private async maybeSummarizeTitle(sessionId: string): Promise<void> {
    try {
      const app = this.app()
      const session = openSession(app, sessionId)
      if (!session || session.messages.length !== 2) return // 仅首轮
      const cfg = getSettings().ai
      if (!cfg.enabled) {
        this.applyTitle(sessionId, session.messages[0]?.content ?? '')
        return
      }
      const provider = resolveProvider(session.providerId ?? undefined)
      const modelId = session.modelId || provider?.models?.[0]?.id || ''
      if (!provider || !modelId) {
        this.applyTitle(sessionId, session.messages[0]?.content ?? '')
        return
      }
      const res = await aiChatStream(targetOf(provider, modelId), [
        { role: 'system', content: '为用户消息拟一个不超过 16 字的中文标题，直接输出标题本身，不要标点结尾。' },
        { role: 'user', content: session.messages[0]?.content?.slice(0, 500) ?? '' }
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
