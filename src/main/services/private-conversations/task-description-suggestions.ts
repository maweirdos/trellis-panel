import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  taskDescriptionSuggestionAdoptSchema,
  taskDescriptionSuggestionCheckSchema,
  taskDescriptionSuggestionCloseSchema,
  taskDescriptionSuggestionStartSchema,
  type TaskDescriptionSuggestionResult
} from '../../../shared/crux-task-suggestions'
import { executeCruxWorkspace, cruxStableWorkspaceGeneration, cruxWorkspaceSnapshot } from '../crux/connection-service'
import { observeRequirementNative } from './requirement-native'
import { hash, pathKey } from './files'
import { readOptional, writeRevision } from './requirement-files'
import type { PrivateConversations } from './service'

const prompt = (selection: string, instruction: string): string =>
  `请根据任务正文选区生成一个替换文本。原选区：${JSON.stringify(selection)}\n用户要求：${JSON.stringify(instruction)}\n只输出替换这段选区的纯文本，不输出解释、上下文或全文。`

const commandSchema = z.object({
  conversationId: z.string().uuid(),
  commandId: z.string().uuid(),
  workspaceKey: z.string().min(1),
  actorId: z.string().min(1),
  taskId: z.string().min(1),
  taskCreatedAt: z.string().min(1).max(100),
  selection: z.object({
    text: z.string().min(1).max(16_000), bodyRevision: z.string().regex(/^[a-f0-9]{64}$/),
    from: z.number().int().nonnegative().max(200_000), to: z.number().int().positive().max(200_000), comparisonOnly: z.boolean().optional()
  }).strict(),
  instruction: z.string().trim().min(1).max(16_000),
  requestId: z.string().uuid(),
  displayText: z.string().min(1).max(200_000),
  source: z.string().min(1),
  state: z.enum(['running', 'candidate', 'adopted', 'closed', 'failed', 'unknown']),
  turnId: z.string().optional(),
  connectionGeneration: z.string().optional(),
  candidate: z.string().min(1).max(16_000).optional(),
  error: z.string().max(2000).optional()
}).strict()

type Command = z.infer<typeof commandSchema>

export function conversationTaskDescriptionSuggestions(service: PrivateConversations) {
  const busy = new Set<string>()
  const path = (conversationId: string, commandId: string): string => `task-suggestions/${conversationId}/${commandId}.json`
  const load = (conversationId: string, commandId: string): Command | null => {
    const file = readOptional(service.metadataDirectory(), path(conversationId, commandId), 512 * 1024)
    return file ? commandSchema.parse(JSON.parse(file.bytes.toString('utf8'))) : null
  }
  const save = (value: Command, current: () => void, expectedState?: Command['state']): void => {
    const file = readOptional(service.metadataDirectory(), path(value.conversationId, value.commandId), 512 * 1024)
    const prior = file ? commandSchema.parse(JSON.parse(file.bytes.toString('utf8'))) : null
    if (expectedState && (!prior || prior.state !== expectedState || prior.commandId !== value.commandId || prior.conversationId !== value.conversationId)) throw new Error('原建议状态已变化，请重新核对。')
    writeRevision(service.metadataDirectory(), path(value.conversationId, value.commandId), Buffer.from(JSON.stringify(value)), file ? hash(file.bytes) : null, current)
  }
  const currentCommand = (conversationId: string, commandId: string, current: () => void): Command | null => {
    current()
    return load(conversationId, commandId)
  }
  const task = async (conversationId: string, workspaceKey: string, taskId: string, taskCreatedAt: string, actorId: string) => {
    const generation = cruxStableWorkspaceGeneration()
    const { context, snapshot } = await cruxWorkspaceSnapshot()
    if (!['local', 'connected'].includes(context.state) || context.key !== workspaceKey || context.actorId !== actorId ||
      generation !== cruxStableWorkspaceGeneration()) throw new Error('任务工作区或身份已变化，请回到原任务重新选择。')
    const task = snapshot.tasks.find(item => item.id === taskId && item.createdAt === taskCreatedAt)
    const space = snapshot.spaces.find(item => item.id === task?.spaceId)
    if (!task || !space || space.archived || !space.memberIds.includes(actorId)) throw new Error('原任务当前不可访问。')
    if (!task.conversations?.some(link => link.id === conversationId && link.actorId === actorId)) throw new Error('只有原任务绑定的当前成员会话可以修改任务正文。')
    return { context, snapshot, task }
  }
  const replacement = (description: string, selection: Command['selection'], candidate: string): string => {
    if (hash(description) !== selection.bodyRevision || selection.to > description.length || description.slice(selection.from, selection.to) !== selection.text) throw new Error('任务描述已更新，请核对最新原文。')
    return description.slice(0, selection.from) + candidate + description.slice(selection.to)
  }
  function result(state: 'running' | 'closed' | 'failed' | 'unknown', message: string): TaskDescriptionSuggestionResult
  function result(state: 'candidate', message: string, replacementText: string, selection: Command['selection']): TaskDescriptionSuggestionResult
  function result(state: 'adopted', taskId: string, description: string): TaskDescriptionSuggestionResult
  function result(state: TaskDescriptionSuggestionResult['state'], message: string, first = '', selection?: Command['selection']): TaskDescriptionSuggestionResult {
    if (state === 'candidate' && selection) return { state, replacement: first, source: selection, message }
    if (state === 'adopted') return { state, taskId: first, description: message, message: '建议已采用到任务。' }
    if (state === 'candidate') return { state: 'unknown', message }
    return { state, message }
  }

  return {
    async start(conversationId: string, raw: unknown, windowCurrent: () => void): Promise<TaskDescriptionSuggestionResult> {
      const input = taskDescriptionSuggestionStartSchema.parse(raw)
      if (busy.has(conversationId)) return result('unknown', '请先核对原任务建议。')
      busy.add(conversationId)
      try {
        const generation = cruxStableWorkspaceGeneration()
        const owner = await service.workspaceAccess(conversationId, true)
        const current = (): void => { windowCurrent(); owner.assertCurrent(); if (generation !== cruxStableWorkspaceGeneration()) throw new Error('任务工作区已切换，请回到原任务核对。') }
        const selected = await task(conversationId, input.workspaceKey, input.taskId, input.taskCreatedAt, input.actorId)
        current()
        const description = selected.task.description ?? ''
        if (input.conversationId !== conversationId || input.selection.comparisonOnly || hash(description) !== input.selection.bodyRevision || input.selection.to > description.length || description.slice(input.selection.from, input.selection.to) !== input.selection.text) throw new Error('任务描述已更新，请核对最新原文。')
        const displayText = `修改任务正文：${input.selection.text.slice(0, 200)}`
        const command: Command = { ...input, requestId: randomUUID(), displayText, source: owner.sourceIdentity, state: 'running' }
        save(command, current)
        const sent = await service.send(conversationId, { requestId: command.requestId, text: prompt(input.selection.text, input.instruction) }, displayText, current)
        current()
        if (!sent.ok) {
          const receipt = await service.reconcileSend(conversationId, command.requestId)
          if (receipt.state === 'not-sent' || 'notSent' in sent && sent.notSent === true) {
            command.state = 'failed'; command.error = sent.error; save(command, current)
            return result('failed', sent.error)
          }
          return result('unknown', '建议发送结果待核对')
        }
        command.turnId = sent.value.turnId; command.connectionGeneration = sent.value.session.connectionGeneration; save(command, current, 'running')
        return result('running', 'Agent 正在生成任务正文建议')
      } finally { busy.delete(conversationId) }
    },
    async check(conversationId: string, raw: unknown, windowCurrent: () => void): Promise<TaskDescriptionSuggestionResult> {
      const input = taskDescriptionSuggestionCheckSchema.parse(raw)
      const owner = await service.workspaceAccess(conversationId)
      const current = (): void => { windowCurrent(); owner.assertCurrent() }
      const command = currentCommand(conversationId, input.commandId, current)
      if (!command) return result('failed', '原建议不存在或已清理，请重新选择。')
        if (command.state === 'adopted') return { state: 'adopted', taskId: command.taskId, description: '', message: '建议已采用到任务。' }
      if (command.state === 'closed') return result('closed', '建议已关闭，任务正文保持原文。')
      if (command.state === 'failed') return result('failed', command.error ?? '建议生成未完成。')
      if (command.state === 'candidate' && command.candidate) return result('candidate', '请核对替换文本。', command.candidate, command.selection)
      const turn = await observeRequirementNative(service, conversationId, command, current, true)
      current()
      if (turn.state === 'running') return result('running', 'Agent 正在生成任务正文建议')
      if (turn.state === 'unknown') return result('unknown', turn.detail ?? '请核对原会话回复。')
      const candidate = (turn.finalText ?? '').trim()
      if (turn.state !== 'completed' || !candidate || candidate.length > 16_000 || /[\r\n]/.test(candidate)) {
        command.state = 'failed'; command.error = turn.detail ?? '本轮没有返回可用的替换文本。'; save(command, current, 'running')
        return result('failed', command.error)
      }
      const prior = command.state; command.state = 'candidate'; command.candidate = candidate; save(command, current, prior)
      return result('candidate', '请核对替换文本。', candidate, command.selection)
    },
    async adopt(conversationId: string, raw: unknown, windowCurrent: () => void): Promise<TaskDescriptionSuggestionResult> {
      const input = taskDescriptionSuggestionAdoptSchema.parse(raw)
      if (busy.has(conversationId)) return result('unknown', '原建议正在核对，请稍后重试。')
      busy.add(conversationId)
      try {
        const generation = cruxStableWorkspaceGeneration()
        const owner = await service.workspaceAccess(conversationId, true)
        const current = (): void => { windowCurrent(); owner.assertCurrent(); if (generation !== cruxStableWorkspaceGeneration()) throw new Error('任务工作区已切换，请回到原任务核对。') }
        const command = currentCommand(conversationId, input.commandId, current)
        if (!command || command.conversationId !== conversationId || command.taskId !== input.taskId || command.taskCreatedAt !== input.taskCreatedAt || command.workspaceKey !== input.workspaceKey) throw new Error('原建议与当前任务不一致，请重新选择。')
        if (command.state === 'closed') return result('closed', '建议已关闭，任务正文保持原文。')
      if (command.state === 'adopted') return { state: 'adopted', taskId: command.taskId, description: '', message: '建议已采用到任务。' }
        if (command.state !== 'candidate') return result('failed', '建议尚未生成完成，不能采用。')
        const selected = await task(conversationId, input.workspaceKey, input.taskId, input.taskCreatedAt, input.actorId)
        if (selected.task.description !== input.expectedDescription) throw new Error('任务描述已更新，请核对最新原文。')
        const prefix = input.expectedDescription.slice(0, command.selection.from), suffix = input.expectedDescription.slice(command.selection.to)
        const candidate = input.description.slice(prefix.length, input.description.length - suffix.length)
        if (command.actorId !== input.actorId || !candidate || candidate !== command.candidate || !input.description.startsWith(prefix) || !input.description.endsWith(suffix) || input.description.length <= prefix.length + suffix.length || input.description !== replacement(input.expectedDescription, command.selection, candidate)) throw new Error('采用文本与原建议替换结果不一致。')
        const committed = await executeCruxWorkspace('updateTask', { id: input.taskId, patch: { description: input.description, expectedDescription: input.expectedDescription } }, input.workspaceKey)
        current()
        const adopted = committed.snapshot.tasks.find(item => item.id === input.taskId)
        if (!adopted || adopted.description !== input.description || pathKey(committed.context.key) !== pathKey(input.workspaceKey)) throw new Error('任务修改回执不一致，请核对当前任务。')
        command.state = 'adopted'; save(command, current, 'candidate')
        return result('adopted', adopted.id, adopted.description)
      } finally { busy.delete(conversationId) }
    },
    async close(conversationId: string, raw: unknown, windowCurrent: () => void): Promise<TaskDescriptionSuggestionResult> {
      const input = taskDescriptionSuggestionCloseSchema.parse(raw)
      const owner = await service.workspaceAccess(conversationId, true)
      const current = (): void => { windowCurrent(); owner.assertCurrent() }
      const command = currentCommand(conversationId, input.commandId, current)
      if (!command) return result('closed', '建议不存在或已清理。')
      if (command.state === 'adopted') return result('adopted', command.taskId, '')
      if (command.state === 'closed') return result('closed', '建议已关闭，任务正文保持原文。')
      const prior = command.state; command.state = 'closed'; save(command, current, prior)
      return result('closed', '建议已关闭，任务正文保持原文。')
    }
  }
}
