import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { conversationTaskAction, type ConversationTaskResult, type ConversationTaskTurn } from '../../../shared/conversation-task'
import { cruxStableWorkspaceGeneration, cruxWorkspaceSnapshot, executeCruxWorkspace } from '../crux/connection-service'
import { hash } from './files'
import { readOptional, writeRevision } from './requirement-files'
import { observeRequirementNative } from './requirement-native'
import type { PrivateConversations } from './service'

const prompt = '请根据当前对话生成一项任务。第一行用「# 标题」，从第二行开始写可以直接交给负责人的任务描述。写清要做什么、已有哪些成果、还要跟进什么，仅引用对话中确有依据的结论。Crux 将使用你的标题和正文创建任务并绑定此对话。仅输出任务内容。'
const intentSchema = z.object({ spaceId: z.string(), requestId: z.string().uuid(), source: z.string(), turnId: z.string().optional(),
  sessionId: z.string().optional(), connectionGeneration: z.string().optional(), title: z.string().max(300).optional(),
  description: z.string().min(1).optional(), error: z.string().optional() }).strict()

const turnOf = (intent: z.infer<typeof intentSchema>): ConversationTaskTurn | undefined =>
  intent.turnId && intent.sessionId && intent.connectionGeneration
    ? { requestId: intent.requestId, sessionId: intent.sessionId, connectionGeneration: intent.connectionGeneration, turnId: intent.turnId }
    : undefined

export function conversationTaskActions(service: PrivateConversations) {
  const busy = new Set<string>()
  return async (id: string, raw: unknown, windowCurrent: () => void): Promise<ConversationTaskResult> => {
    const input = conversationTaskAction.parse(raw)
    if (busy.has(id)) {
      if (input.action === 'bind') throw Error('此对话有进行中的任务操作，请稍后再绑定。')
      return { state: 'working', message: '正在处理此对话的任务' }
    }
    busy.add(id)
    try {
      const generation = cruxStableWorkspaceGeneration()
      const owner = await service.workspaceAccess(id, true)
      const current = () => {
        windowCurrent(); owner.assertCurrent()
        if (generation !== cruxStableWorkspaceGeneration()) throw Error('工作区已切换，请回到原对话核对任务。')
      }
      const { context, snapshot } = await cruxWorkspaceSnapshot()
      current()
      if (input.action === 'status') {
        const directory = service.metadataDirectory()
        const path = `task-conversions/${hash(JSON.stringify([context.key, context.instanceId, context.epoch, context.actorId, id]))}.json`
        const previous = readOptional(directory, path, 8 * 1024 * 1024)
        const intent = previous ? intentSchema.parse(JSON.parse(previous.bytes.toString('utf8'))) : undefined
        const existing = snapshot.tasks.find(item => item.conversations?.some(link => link.id === id && link.actorId === context.actorId))
        if (existing && snapshot.spaces.some(space => space.id === existing.spaceId && context.actorId && space.memberIds.includes(context.actorId)) && ['local', 'connected'].includes(context.state)) return { state: 'bound', taskId: existing.id, spaceId: existing.spaceId, title: existing.title, origin: intent && intent.source === owner.sourceIdentity ? 'created' : 'bound', ...(intent && intent.source === owner.sourceIdentity ? { turn: turnOf(intent) } : {}) }
        if (!intent) return { state: 'idle', message: '此对话还没有任务操作' }
        if (intent.source !== owner.sourceIdentity) return { state: 'failed', message: '请回到原会话查看任务回执' }
        if (intent.error) return { state: 'failed', message: intent.error, spaceId: intent.spaceId, turn: turnOf(intent) }
        return { state: 'working', message: '正在核对原任务操作', spaceId: intent.spaceId, turn: turnOf(intent) }
      }
      const space = snapshot.spaces.find(item => item.id === input.spaceId)
      if (!['local', 'connected'].includes(context.state) || context.key !== input.workspaceKey || context.actorId !== input.actorId ||
        !space || space.archived || !space.memberIds.includes(input.actorId)) throw Error('请选择有访问权限的任务空间。')
      const existing = snapshot.tasks.find(item => item.conversations?.some(link => link.id === id && link.actorId === input.actorId))
      if (existing) {
        if (input.action === 'bind' && (existing.id !== input.taskId || existing.createdAt !== input.taskCreatedAt)) throw Error(`此对话已绑定 ${existing.id}`)
        return { state: 'bound', taskId: existing.id, spaceId: existing.spaceId, title: existing.title, origin: 'bound' }
      }
      const link = { id, title: owner.conversation.title.trim().slice(0, 300) || '任务对话' }
      if (input.action === 'bind') {
        const target = snapshot.tasks.find(item => item.id === input.taskId && item.spaceId === space.id && item.createdAt === input.taskCreatedAt)
        if (!target) throw Error('原任务已变化，请重新选择。')
        await executeCruxWorkspace('updateTask', { id: target.id, patch: { bindConversation: link } }, context.key)
        return { state: 'bound', taskId: target.id, spaceId: space.id, title: target.title, origin: 'bound' }
      }
      const directory = service.metadataDirectory()
      const path = `task-conversions/${hash(JSON.stringify([context.key, context.instanceId, context.epoch, context.actorId, id]))}.json`
      const previous = readOptional(directory, path, 8 * 1024 * 1024)
      let revision = previous ? hash(previous.bytes) : null
      let intent = previous ? intentSchema.parse(JSON.parse(previous.bytes.toString('utf8'))) : undefined
      const save = (value: z.infer<typeof intentSchema>) => {
        const bytes = Buffer.from(JSON.stringify(value))
        writeRevision(directory, path, bytes, revision, current); revision = hash(bytes)
      }
      if (intent && (intent.source !== owner.sourceIdentity || intent.spaceId !== space.id)) throw Error('请在原会话和原目标空间继续创建。')
      if (!intent || intent.error && input.action === 'create') {
        if (input.action === 'check') return { state: 'failed', message: intent?.error ?? '还未发起转换', ...(intent?.spaceId ? { spaceId: intent.spaceId } : {}), ...(intent ? { turn: turnOf(intent) } : {}) }
        intent = { requestId: randomUUID(), source: owner.sourceIdentity, spaceId: space.id }
        save(intent)
        const sent = await service.send(id, { requestId: intent.requestId, text: prompt }, '请根据当前对话创建任务，整理标题和描述，并绑定此对话。', current)
        current()
        if (!sent.ok) {
          const receipt = await service.reconcileSend(id, intent.requestId)
          if (receipt.state === 'not-sent' || 'notSent' in sent && sent.notSent === true) { intent.error = sent.error; save(intent) }
          return { state: intent.error ? 'failed' : 'unknown', message: sent.error, spaceId: intent.spaceId, turn: turnOf(intent) }
        }
        intent.turnId = sent.value.turnId
        intent.sessionId = sent.value.session.sessionId
        intent.connectionGeneration = sent.value.session.connectionGeneration
        save(intent)
        return { state: 'working', message: 'Agent 正在根据此对话整理任务', turn: turnOf(intent) }
      }
      if (intent.error) return { state: 'failed', message: intent.error, turn: turnOf(intent) }
      if (intent.title && intent.description) {
        const created = await executeCruxWorkspace('createTask', { spaceId: space.id, creatorId: input.actorId,
          title: intent.title, description: intent.description, bindConversation: link, lightweightSource: 'conversation' }, context.key)
        if (!created.taskId) throw Error('未收到任务编号，请核对原创建结果。')
        return { state: 'bound', taskId: created.taskId, spaceId: space.id, title: intent.title, origin: 'created', turn: turnOf(intent) }
      }
      const turn = await observeRequirementNative(service, id, intent, current, true)
      current()
      if (turn.state === 'running') return { state: 'working', message: 'Agent 正在根据此对话整理任务', turn: turnOf(intent) }
      if (turn.state === 'unknown') return { state: 'unknown', message: turn.detail ?? '请核对原会话的回复', turn: turnOf(intent) }
      const match = /^#\s+([^\r\n]+)\r?\n+([\s\S]+)$/u.exec(turn.finalText?.trim() ?? '')
      if (turn.state !== 'completed' || !match || match[1].trim().length > 300 || !match[2].trim()) {
        intent.error = turn.detail ?? '本轮没有返回完整的任务标题和正文，可重新转换。'
        save(intent); return { state: 'failed', message: intent.error, turn: turnOf(intent) }
      }
      intent.title = match[1].trim(); intent.description = match[2].trim(); save(intent)
      const created = await executeCruxWorkspace('createTask', { spaceId: space.id, creatorId: input.actorId,
        title: intent.title, description: intent.description, bindConversation: link, lightweightSource: 'conversation' }, context.key)
      if (!created.taskId) throw Error('未收到任务编号，请核对原创建结果。')
      return { state: 'bound', taskId: created.taskId, spaceId: space.id, title: intent.title, origin: 'created', turn: turnOf(intent) }
    } finally { busy.delete(id) }
  }
}
