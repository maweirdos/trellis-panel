import type { Conversation, ConversationUpdateDraft } from '@shared/private-conversations'
import type { ConversationTaskAction, ConversationTaskResult } from '@shared/conversation-task'
import type { CruxSnapshot, CruxTask } from '@shared/crux'

export interface TaskConversationTeamContext {
  workspaceKey: string
  actorId: string
}

export interface TaskConversationPorts {
  createDraft(): Promise<{ conversation: Conversation }>
  updateDraft(id: string, input: Pick<ConversationUpdateDraft, 'title'>): Promise<{ conversation: Conversation }>
  taskAction(id: string, input: ConversationTaskAction): Promise<ConversationTaskResult>
  bootstrap(): Promise<CruxSnapshot | undefined>
  read(id: string): Promise<{ conversation: Conversation }>
}

const titleFor = (task: CruxTask): string => task.title.slice(0, 200) || '任务对话'

export async function ensureActorTaskConversation(
  task: CruxTask,
  context: TaskConversationTeamContext,
  ports: TaskConversationPorts,
  destination?: { kind: 'code'; existingId?: string }
): Promise<{ conversation: Conversation; task: CruxTask }> {
  const existing = task.conversations?.find(link => link.actorId === context.actorId && (!destination || link.id === destination.existingId))
  if (existing) {
    const read = await ports.read(existing.id)
    if (read.conversation.id !== existing.id || destination && read.conversation.kind !== destination.kind) throw Error('任务对话身份或来源已变化。')
    return { conversation: read.conversation, task }
  }

  const created = await ports.createDraft()
  const conversationId = created.conversation.id
  const kind = destination?.kind ?? 'work'
  if (created.conversation.kind !== kind || created.conversation.projectId !== undefined) throw Error('新建任务对话的类型或分组已变化。')
  const title = titleFor(task)
  const titled = await ports.updateDraft(conversationId, { title })
  if (titled.conversation.id !== conversationId || titled.conversation.title !== title) throw Error('任务对话标题未确认。')

  const result = await ports.taskAction(conversationId, {
    action: 'bind', workspaceKey: context.workspaceKey, spaceId: task.spaceId,
    actorId: context.actorId, taskId: task.id, taskCreatedAt: task.createdAt
  })
  if (result.state !== 'bound' || result.taskId !== task.id || result.spaceId !== task.spaceId) {
    throw Error(result.state === 'bound' ? '任务对话绑定到了其他任务。' : result.message)
  }

  const snapshot = await ports.bootstrap()
  const currentTask = snapshot?.tasks.find(candidate => candidate.id === task.id && candidate.createdAt === task.createdAt && candidate.spaceId === task.spaceId)
  if (!currentTask?.conversations?.some(link => link.id === conversationId && link.actorId === context.actorId)) {
    throw Error('任务对话绑定回执与当前成员不匹配。')
  }
  const read = await ports.read(conversationId)
  if (read.conversation.id !== conversationId || read.conversation.kind !== kind) throw Error('新建任务对话当前不可读取。')
  return { conversation: read.conversation, task: currentTask }
}

export function isActorTaskConversation(task: CruxTask, context: TaskConversationTeamContext, conversationId: string): boolean {
  return Boolean(task.conversations?.some(link => link.id === conversationId && link.actorId === context.actorId))
}
