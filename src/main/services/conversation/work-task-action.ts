import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { cruxRemoteCommandSchema, type CruxRemoteSnapshot } from '../../../shared/crux-remote'
import { assertCruxSpaceMutation } from '../../../shared/crux-domain/commands'
import { workTaskActionSchema, type WorkTaskAction, type WorkTaskActionValue } from '../../../shared/conversation/work-task-action'
import { taskInputCanonical } from '../../../shared/team-task-inputs'
import { cruxStableWorkspaceGeneration, cruxWorkspaceStatus } from '../crux/connection-service'
import {
  applyConversationCommand, readConversationThread, readConversationThreadCommand,
} from '../daemon-client/conversation'
import { checkedDirectory, directoryIdentity, hash, ownedDirectory, pathKey } from '../private-conversations/files'
import { readOptional, writeRevision } from '../private-conversations/requirement-files'
import { withDesktopTeamService } from '../team-desktop'
import { isActiveRun } from './orchestration/CommandPolicy'

const directory = 'conversation-v2-work-task-actions'
const selectionSchema = z.object({ model: z.string().min(1), instanceId: z.string().min(1),
  options: z.array(z.object({ id: z.string(), value: z.union([z.string(), z.boolean()]) })).optional() }).strict()
const recordSchema = z.object({
  action: z.enum(['generate', 'bind']),
  intentDigest: z.string(),
  workspaceKey: z.string(), actorId: z.string(), projectId: z.string(), connectionId: z.string(), instanceId: z.string(), epoch: z.string(),
  rootIdentity: z.string(), threadId: z.string(), spaceId: z.string(), commandId: z.string().uuid(),
  generation: z.object({ commandId: z.string().uuid(), messageId: z.string().uuid(), selection: selectionSchema }).strict().nullable(),
  candidate: z.object({ title: z.string().max(300), description: z.string().max(32_000), revision: z.string() }).strict().nullable(),
  teamCommand: cruxRemoteCommandSchema.nullable(), failure: z.string().nullable(),
}).strict()
type Record = z.infer<typeof recordSchema>

const summarize = [
  '根据当前私有对话草拟一张任务。第一行使用「# 标题」，之后给出简明的任务正文。',
  '写明要做什么、已有成果和后续工作。仅引用本对话有依据的结论。不要包含凭据、私人材料、或不必要的原文引用。',
  '只输出候选文字。用户随后决定是否向选定团队分享它。',
].join('\n')
const canonical = taskInputCanonical
const identical = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right)

function readLink(packet: CruxRemoteSnapshot, record: Record): WorkTaskActionValue | null {
  const task = packet.snapshot.tasks.find(item => item.spaceId === record.spaceId &&
    item.conversations?.some(link => link.id === record.threadId && link.actorId === record.actorId))
  return task ? { state: 'bound', taskId: task.id, spaceId: task.spaceId, taskCreatedAt: task.createdAt } : null
}

export class WorkConversationTaskActions {
  private readonly lanes = new Map<string, Promise<unknown>>()
  constructor(private readonly profile: string) {}

  async execute(raw: unknown, isDocumentCurrent: () => boolean): Promise<WorkTaskActionValue> {
    const input = workTaskActionSchema.parse(raw)
    const activeGeneration = cruxStableWorkspaceGeneration()
    const before = await cruxWorkspaceStatus()
    const expected = ownedDirectory(this.profile, 'conversation-v2-workspace')
    const given = checkedDirectory(input.cwd)
    const rootIdentity = directoryIdentity(expected)
    const current = (): boolean => {
      try { return isDocumentCurrent() && activeGeneration === cruxStableWorkspaceGeneration() && directoryIdentity(expected) === rootIdentity }
      catch { return false }
    }
    if (!current() || pathKey(given) !== pathKey(expected) || before.state !== 'connected' || before.key !== input.workspaceKey
      || !before.actorId || !before.projectId || !before.connectionId || !before.instanceId || !before.epoch) {
      throw Error('请在原 Work 对话选择已连接的团队空间。')
    }
    const owner = { workspaceKey: before.key, actorId: before.actorId, projectId: before.projectId,
      connectionId: before.connectionId, instanceId: before.instanceId, epoch: before.epoch, rootIdentity }
    const lane = hash(canonical([owner, input.threadId]))
    const previous = this.lanes.get(lane) ?? Promise.resolve()
    const next = previous.then(
      () => this.apply(input, owner, expected, current),
      () => this.apply(input, owner, expected, current),
    )
    this.lanes.set(lane, next)
    try { return await next }
    finally { if (this.lanes.get(lane) === next) this.lanes.delete(lane) }
  }

  private async apply(input: WorkTaskAction, owner: Pick<Record, 'workspaceKey' | 'actorId' | 'projectId' | 'connectionId' | 'instanceId' | 'epoch' | 'rootIdentity'>,
    root: string, current: () => boolean): Promise<WorkTaskActionValue> {
    const assertCurrent = (): void => { if (!current()) throw Error('原 Work 线程或团队账号已变化。') }
    assertCurrent()
    const thread = await readConversationThread(root, input.threadId, current)
    assertCurrent()
    if (!thread.ok || thread.thread.id !== input.threadId || thread.thread.archivedAt || thread.thread.deletedAt) {
      throw Error('当前 Work 窗口不能操作原私有线程。')
    }
    const name = `${hash(canonical([owner, input.threadId, input.commandId]))}.json`
    const data = ownedDirectory(this.profile, directory)
    const previous = readOptional(data, name, 6 * 1024 * 1024)
    let revision = previous ? hash(previous.bytes) : null
    let record = previous ? recordSchema.parse(JSON.parse(previous.bytes.toString('utf8'))) : null
    const save = (value: Record): void => {
      const bytes = Buffer.from(JSON.stringify(recordSchema.parse(value)))
      if (bytes.length > 6 * 1024 * 1024) throw Error('原转换记录超过私有存储上限。')
      writeRevision(this.profile, `${directory}/${name}`, bytes, revision, assertCurrent)
      revision = hash(bytes)
    }
    const validatePacket = (packet: CruxRemoteSnapshot): void => {
      assertCurrent()
      if (packet.actor.id !== owner.actorId || packet.projectId !== owner.projectId || packet.instanceId !== owner.instanceId
        || packet.epoch !== owner.epoch) throw Error('原团队身份或世代已变化。')
    }
    const update = async () => {
      const packet = await withDesktopTeamService(team => team.cruxSnapshot(owner.connectionId, { expectedInstanceId: owner.instanceId }))
      validatePacket(packet)
      return packet
    }
    const findSpace = (packet: CruxRemoteSnapshot, spaceId: string): void => {
      if (!packet.snapshot.spaces.some(space => space.id === spaceId && !space.archived && space.memberIds.includes(owner.actorId))) {
        throw Error('当前账号无权操作选定的团队空间。')
      }
    }
    if (record && (!identical(owner, { workspaceKey: record.workspaceKey, actorId: record.actorId, projectId: record.projectId,
      connectionId: record.connectionId, instanceId: record.instanceId, epoch: record.epoch, rootIdentity: record.rootIdentity })
      || record.commandId !== input.commandId || record.threadId !== input.threadId)) throw Error('原 Work 转换记录身份不一致。')
    if (input.action === 'generate' || input.action === 'bind') {
      const intentDigest = hash(canonical(input))
      if (record && intentDigest !== record.intentDigest) throw Error('同一命令不能更改任务或共享范围。')
      const packet = await update()
      findSpace(packet, input.spaceId)
      const linked = packet.snapshot.tasks.find(task => task.conversations?.some(link => link.id === input.threadId && link.actorId === owner.actorId))
      if (linked && (linked.spaceId !== input.spaceId || input.action === 'bind' &&
        (linked.id !== input.taskId || linked.createdAt !== input.taskCreatedAt))) throw Error('原 Work 线程已关联另一张任务。')
      if (linked) return { state: 'bound', taskId: linked.id, spaceId: linked.spaceId, taskCreatedAt: linked.createdAt }
      if (!record) {
        record = { ...owner, action: input.action, intentDigest, threadId: input.threadId, spaceId: input.spaceId, commandId: input.commandId,
          generation: null, candidate: null, teamCommand: null, failure: null }
        if (input.action === 'bind') {
          const target = packet.snapshot.tasks.find(task => task.id === input.taskId && task.createdAt === input.taskCreatedAt && task.spaceId === input.spaceId)
          if (!target) throw Error('原任务或创建时间已变化，请重新选择。')
          record.teamCommand = this.teamCommand(packet, input.commandId, 'updateTask', { id: target.id,
            patch: { bindConversation: { id: input.threadId, title: 'Work 对话' } } })
        } else {
          if (thread.runs.some(run => run.status === 'queued' || isActiveRun(run) || run.lifecycle?.backgroundRunning)) {
            throw Error('请等待原对话当前操作结束后再整理任务。')
          }
          const { instanceId, model, options } = thread.thread.modelSelection
          record.generation = { commandId: randomUUID(), messageId: randomUUID(), selection: { instanceId, model, ...(options?.length && { options: [...options] }) } }
        }
        save(record)
        if (record.generation) {
          assertCurrent()
          const generation = record.generation
          const sent = await applyConversationCommand(root, { command: { type: 'message.dispatch', threadId: input.threadId,
            commandId: generation.commandId, messageId: generation.messageId, text: summarize, ...generation.selection } }, current)
          if (!sent.ok && 'outcome' in sent && sent.outcome === 'not-admitted') { record.failure = sent.error; save(record) }
          return sent.ok ? { state: 'working', detail: '正在整理任务草稿。' }
            : { state: record.failure ? 'failed' : 'unknown', detail: sent.error }
        }
        return this.publish(record, update, validatePacket, current, true)
      }
    }
    if (!record) return { state: 'idle', detail: '还没有原任务操作。' }
    if (record.failure) return { state: 'failed', detail: record.failure }
    if (input.action === 'publish') {
      if (!record.candidate || record.candidate.revision !== input.candidateRevision) throw Error('请核对并确认原候选正文。')
      if (!record.teamCommand) {
        const packet = await update()
        findSpace(packet, record.spaceId)
        const linked = readLink(packet, record)
        if (linked) return linked
        record.teamCommand = this.teamCommand(packet, input.commandId, 'createTask', { spaceId: record.spaceId, creatorId: owner.actorId,
          title: record.candidate.title, description: record.candidate.description, lightweightSource: 'conversation',
          bindConversation: { id: record.threadId, title: record.candidate.title } })
        save(record)
        return this.publish(record, update, validatePacket, current, true)
      }
    }
    if (record.teamCommand) return this.publish(record, update, validatePacket, current, input.action === 'retry')
    if (record.candidate) return { state: 'candidate', candidateRevision: record.candidate.revision, title: record.candidate.title, description: record.candidate.description }
    if (!record.generation) return { state: 'unknown', detail: '未取得原转换记录。' }
    const receipt = await readConversationThreadCommand(root, { threadId: input.threadId, commandId: record.generation.commandId }, current)
    if (!receipt.ok || !receipt.receipt || receipt.receipt.dispatch === 'pending-reconciliation') return { state: 'unknown', detail: '原转换回合需要核对。' }
    if (['failed', 'cancelled'].includes(receipt.receipt.dispatch)) return { state: 'failed', detail: receipt.receipt.detail ?? '原转换回合未完成。' }
    if (receipt.receipt.dispatch !== 'completed') return { state: 'working', detail: '正在整理任务草稿。' }
    const result = await readConversationThread(root, input.threadId, current)
    assertCurrent()
    if (!result.ok || result.thread.id !== input.threadId || result.thread.archivedAt || result.thread.deletedAt) {
      throw Error('当前 Work 窗口不能读取原转换结果。')
    }
    const run = result.runs.find(item => item.id === receipt.receipt?.runId && item.userMessageId === record?.generation?.messageId)
    const replies = result.messages.filter(item => item.runId === run?.id && item.role === 'assistant' && !item.streaming && item.nodeId === null)
    const final = replies.at(-1)?.text.trim()
    if (!run?.engineAcceptedAt || run.status !== 'completed' || run.outcomeUnknown || !final) {
      return { state: 'unknown', detail: '原转换结果或送达证据尚不完整。' }
    }
    const parsed = /^#\s+([^\r\n]+)\r?\n+([\s\S]+)$/u.exec(final)
    if (!parsed || parsed[1].trim().length > 300 || !parsed[2].trim() || parsed[2].trim().length > 32_000) {
      return { state: 'failed', detail: '模型未返回完整的任务标题和正文。' }
    }
    const candidate = { title: parsed[1].trim(), description: parsed[2].trim() }
    record.candidate = { ...candidate, revision: hash(canonical(candidate)) }
    save(record)
    return { state: 'candidate', ...candidate, candidateRevision: record.candidate.revision }
  }

  private teamCommand(packet: CruxRemoteSnapshot, commandId: string, operation: 'updateTask' | 'createTask', input: unknown) {
    assertCruxSpaceMutation(packet.snapshot, operation, input, packet.actor.id)
    return cruxRemoteCommandSchema.parse({ commandId, expectedEpoch: packet.epoch, expectedRevision: packet.revision,
      expectedAuthorizationRevision: packet.authorizationRevision, operation, input })
  }
  private async publish(record: Record, update: () => Promise<CruxRemoteSnapshot>, validate: (packet: CruxRemoteSnapshot) => void,
    current: () => boolean, send: boolean): Promise<WorkTaskActionValue> {
    const command = record.teamCommand
    if (!command) throw Error('没有可核对的原团队命令。')
    const original = await withDesktopTeamService(team => team.cruxReceipt(record.connectionId, command.commandId, record.instanceId))
    if (original) {
      validate(original)
      if (original.revision !== command.expectedRevision + 1) throw Error('原任务回执版本不一致。')
      const bound = readLink(original, record)
      if (!bound) throw Error('回执缺少原线程关联。')
      const fresh = await update()
      if (!identical(readLink(fresh, record), bound)) throw Error('原任务关联已不可读或已变化。')
      return bound
    }
    if (!send) return { state: 'unknown', detail: '尚未收到原团队命令回执。', canRetry: true }
    const packet = await update()
    if (packet.revision !== command.expectedRevision || packet.authorizationRevision !== command.expectedAuthorizationRevision) {
      return { state: 'unknown', detail: '原命令的工作区版本已变化，请继续核对原回执。' }
    }
    if (!current()) throw Error('原团队授权已变化。')
    try {
      const result = await withDesktopTeamService(team => {
        if (!current()) throw Error('原团队授权已变化。')
        return team.cruxCommand(record.connectionId, command, record.instanceId, { instanceId: packet.instanceId,
          epoch: packet.epoch, revision: packet.revision, authorizationRevision: packet.authorizationRevision })
      })
      validate(result.result)
      const bound = readLink(result.result, record)
      if (!bound) throw Error('原命令回执缺少能核对的任务关联。')
      return bound
    } catch (error) {
      return { state: 'unknown', detail: error instanceof Error ? error.message : '原团队命令结果待核对。', canRetry: true }
    }
  }
}
