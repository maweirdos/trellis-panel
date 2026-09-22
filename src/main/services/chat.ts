import { broadcastToWindows } from './bridge'
import { getSettings } from './store'
import { aiChatStream, decryptKeyOf, type StreamTarget, type ToolCallReq } from './ai'
import { buildSystemPrompt } from './chat-context'
import type { ChatToolOp, ThinkingLevel } from '../../shared/types'
import { GatewayManager } from './gateway/manager'
import { getSnapshot } from '../state'
import {
  activePath,
  addChildNode,
  appendNode,
  createSession,
  addActiveTool,
  deepestLeaf,
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

/** 从检索类工具结果提取来源清单（供回答引用，R2） */
function extractSources(toolName: string, result: unknown): ChatToolOp['sources'] | null {
  if (!result || typeof result !== 'object') return null
  const r = result as { hits?: unknown; result?: { hits?: unknown } }
  const hits = Array.isArray(r.hits) ? r.hits : Array.isArray(r.result?.hits) ? r.result.hits : null
  if (!hits) return null
  const LIB_LABEL: Record<string, string> = {
    requirements: '需求库',
    spec: '规范库',
    wiki: '项目文档',
    archive: '归档库',
    notes: '我的笔记'
  }
  const sources = hits.slice(0, 5).map((h) => {
    const o = (h ?? {}) as { title?: unknown; path?: unknown; filename?: unknown; library?: unknown; knowledgeId?: unknown }
    return {
      title: String(o.title ?? o.filename ?? '未命名文档'),
      path: String(o.path ?? o.knowledgeId ?? ''),
      library: o.library ? (LIB_LABEL[String(o.library)] ?? String(o.library)) : toolName === 'weknora_search' ? '公司库' : ''
    }
  })
  return sources.length > 0 ? sources : null
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

  private permissionTimeoutMs = 120_000
  private pendingPerms = new Map<string, (decision: 'allow-once' | 'allow-session' | 'deny') => void>()
  private runSteers = new Map<string, string[]>() // runId -> 未注入的 steer

  /** 冒烟可缩短权限超时 */
  configure(cfg: { permissionTimeoutMs?: number }): void {
    if (cfg.permissionTimeoutMs != null) this.permissionTimeoutMs = cfg.permissionTimeoutMs
  }

  /** steer：运行中注入当前 turn（不入队）；turn 未运行时报错（TPD-021） */
  steer(sessionId: string, content: string): { ok: boolean; error?: string } {
    const runId = this.active.get(sessionId)
    if (!runId) return { ok: false, error: '当前没有运行中的轮次' }
    const text = String(content ?? '').trim()
    if (!text) return { ok: false, error: '内容不能为空' }
    const list = this.runSteers.get(runId) ?? []
    list.push(text)
    this.runSteers.set(runId, list)
    broadcastToWindows(ipcEvent.chatSteer, { runId, sessionId, content: text })
    return { ok: true }
  }

  /** 渲染层权限卡决策回传 */
  resolvePermission(permId: string, decision: 'allow-once' | 'allow-session' | 'deny'): { ok: boolean; error?: string } {
    const resolve = this.pendingPerms.get(permId)
    if (!resolve) return { ok: false, error: '权限请求不存在或已过期' }
    this.pendingPerms.delete(permId)
    resolve(decision)
    return { ok: true }
  }

  /** 权限 broker：allow-session 持久化跳过；否则广播权限卡并等待决策，超时默认 deny */
  private async requestPermission(
    runId: string,
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    allowedTools: string[]
  ): Promise<'allow-once' | 'allow-session' | 'deny'> {
    if (allowedTools.includes(toolName)) return 'allow-session'
    if (!this.pendingPerms) return 'deny'
    const permId = `perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const argsSummary = JSON.stringify(args).slice(0, 200)
    const promise = new Promise<'allow-once' | 'allow-session' | 'deny'>((resolve) => {
      this.pendingPerms.set(permId, resolve)
      setTimeout(() => {
        if (this.pendingPerms.delete(permId)) resolve('deny')
      }, this.permissionTimeoutMs)
    })
    broadcastToWindows(ipcEvent.chatPermission, {
      runId,
      sessionId,
      permId,
      toolName,
      argsSummary,
      timeoutSec: Math.round(this.permissionTimeoutMs / 1000)
    })
    return promise
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
    /** agent 模式：启用工具调用循环（TPD-020） */
    agent?: boolean
    /** 会话聚焦的任务目录（系统提示词注入该任务上下文） */
    taskDir?: string | null
  }): ChatSendResult {
    const app = this.app()
    const content = String(input.content ?? '').trim()
    if (!content && !(input.images?.length)) return { ok: false, error: '消息不能为空', runId: null, queued: false }
    const session = openSession(app, input.sessionId)
    if (!session) return { ok: false, error: '会话不存在', runId: null, queued: false }

    const imgs = this.parseImages(input.images)
    if (imgs.error) return { ok: false, error: imgs.error, runId: null, queued: false }

    // 绑定更新：发送时可携带 provider/model/thinking/taskDir（composer 切换即持久化到会话）
    if (input.providerId || input.modelId || input.thinkingLevel || input.agent !== undefined || input.taskDir !== undefined) {
      updateBinding(app, input.sessionId, {
        providerId: input.providerId,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel,
        agent: input.agent,
        taskDir: input.taskDir
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
      assistantParentId: userNode.id,
      agent: input.agent ?? session.agent ?? false
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
    // 局部视图语义（TPD-023）：切回旧分支 = 下潜到该分支最深叶，看到完整旧问答而非截断在切换点
    setLeaf(app, sessionId, deepestLeaf(session, messageId))
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

  /**
   * agent 工具循环（TPD-020）：工具轮静默流式（聚合 tool_calls）→ 权限 broker → 执行 →
   * 结果回灌；无 toolCalls 的轮即最终回答。≤6 轮；steer 在每轮边界并入请求上下文。
   */
  private async runAgentLoop(
    runId: string,
    sessionId: string,
    opts: {
      target: StreamTarget
      history: ChatMessage[]
      controller: AbortController
      allowedTools: string[]
      assistantParentId: string | null
      thinkingLevel?: ThinkingLevel
    }
  ): Promise<{ done: boolean; content: string; reasoning?: string; toolOps: ChatToolOp[] }> {
    const app = this.app()
    const ctx: Array<ChatMessage | { role: 'assistant'; content: string; tool_calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> } | { role: 'tool'; tool_call_id: string; content: string }> = [
      ...opts.history
    ]
    const toolOps: ChatToolOp[] = []
    const MAX_ROUNDS = 6

    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      // steer 注入：每个循环边界并入请求上下文
      const steers = this.runSteers.get(runId) ?? []
      for (const text of steers.splice(0, steers.length)) {
        ctx.push({ role: 'user', content: `[用户补充] ${text}` })
      }

      // 激活工具恢复（roadmap #6）：仅携带成功执行过的工具 schema；无记录则全量
      const activeTools = openSession(app, sessionId)?.activeTools ?? []
      const allTools = GatewayManager.toOpenAiTools()
      const toolsForRound = activeTools.length
        ? allTools.filter((t) => {
            const fn = t.function as { name?: string }
            return activeTools.includes(String(fn?.name ?? ''))
          })
        : allTools
      const res = await aiChatStream(opts.target, ctx, {
        signal: opts.controller.signal,
        tools: toolsForRound,
        onDelta: () => {}
      })
      if (res.aborted) {
        this.finish(runId, sessionId, { kind: 'aborted' })
        return { done: true, content: '', toolOps }
      }
      if (!res.ok) {
        this.finish(runId, sessionId, { kind: 'error', error: res.error ?? '未知错误' })
        return { done: true, content: '', toolOps }
      }
      if (!res.toolCalls?.length) {
        // 无工具请求：本轮内容即最终回答
        return { done: false, content: res.content ?? '', reasoning: res.reasoning, toolOps }
      }

      // 回显 assistant.tool_calls，然后逐个执行工具
      ctx.push({
        role: 'assistant',
        content: res.content ?? '',
        tool_calls: res.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.argsJson }
        }))
      })
      for (const call of res.toolCalls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.argsJson || '{}') as Record<string, unknown>
        } catch {
          args = {}
        }
        const decision = await this.requestPermission(runId, sessionId, call.name, args, opts.allowedTools)
        let status: ChatToolOp['status'] = 'success'
        let elapsedMs = 0
        let result: unknown
        if (decision === 'deny') {
          status = 'denied'
          result = { ok: false, error: '用户拒绝了此工具调用' }
        } else {
          const exec = await GatewayManager.executeTool(call.name, args, getSnapshot()?.meta.root ?? '')
          status = exec.ok ? 'success' : 'error'
          elapsedMs = exec.elapsedMs
          result = exec
          if (exec.ok) addActiveTool(app, sessionId, call.name)
        }
        const opSources = extractSources(call.name, result)
        const op: ChatToolOp = {
          toolName: call.name,
          argsSummary: JSON.stringify(args).slice(0, 200),
          status,
          elapsedMs,
          ...(opSources ? { sources: opSources } : {})
        }
        toolOps.push(op)
        broadcastToWindows(ipcEvent.chatOutput, { runId, sessionId, delta: '', toolOp: op })
        ctx.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result ?? {}).slice(0, 8000) })
        if (decision === 'allow-session') {
          const { addAllowedTool } = await import('./chat-store')
          addAllowedTool(app, sessionId, call.name)
        }
      }
    }
    this.finish(runId, sessionId, { kind: 'error', error: '工具轮次超过上限（6 轮）' })
    return { done: true, content: '', toolOps }
  }

  /** 一轮：history 取 historyEndLeafId 的活跃路径；完成后在其下挂 assistant 兄弟并置为活跃叶 */
  private async startTurn(
    runId: string,
    sessionId: string,
    opts: {
      historyEndLeafId: string
      assistantParentId: string | null
      thinkingLevel?: ThinkingLevel
      agent?: boolean
    }
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

    // 系统提示词：面板助手人设 + 项目实时上下文（R1：对话「通」的前提）
    const systemPrompt = buildSystemPrompt(app, sessionId)
    const historyWithSystem: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...history]

    const steers = this.runSteers.get(runId) ?? []
    const takeSteers = (): ChatMessage[] =>
      steers.splice(0, steers.length).map((text) => ({ role: 'user' as const, content: `[用户补充] ${text}` }))

    // agent 工具循环（TPD-020）：openai 兼容 + 会话开启 agent 时启用
    const agentMode = !!opts.agent && provider.apiFormat === 'openai'
    if (agentMode) {
      const agentResult = await this.runAgentLoop(runId, sessionId, {
        target: targetOf(provider, modelId, opts.thinkingLevel ?? session.thinkingLevel ?? 'off'),
        history: historyWithSystem,
        controller,
        allowedTools: session.allowedTools ?? [],
        assistantParentId: opts.assistantParentId
      })
      if (agentResult.done) return // 循环内部已处理完成/中止/错误
      // 最终回答：落 assistant 节点（含 toolOps）
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: agentResult.content,
        ...(agentResult.reasoning ? { reasoning: agentResult.reasoning } : {}),
        ...(agentResult.toolOps.length ? { toolOps: agentResult.toolOps } : {})
      }
      addChildNode(app, sessionId, opts.assistantParentId, assistantMsg)
      void this.maybeSummarizeTitle(sessionId)
      this.finish(runId, sessionId, { kind: 'done', message: assistantMsg })
      return
    }

    // 增量只走事件不落盘；assistant 节点在完成时一次性落库
    const result = await aiChatStream(
      targetOf(provider, modelId, opts.thinkingLevel ?? session.thinkingLevel ?? 'off'),
      [...historyWithSystem, ...takeSteers()],
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
