import { useSyncExternalStore } from 'react'
import { conversationClient, conversationValue } from './client'
import { selectConversation, updateConversation, useConversations } from './workspace'
import type { ConversationDirectoryGrant } from '@shared/private-conversations'
import type { ConversationTaskAction, ConversationTaskDesign } from '@shared/conversation-task'
import type { CruxTask } from '@shared/crux'
import { useCrux } from '../crux/store'
import { useMy } from '../my/store'
import { useApp } from '../store'
import { showPrivateConversation } from './private-navigation'
import { ensureActorTaskConversation, isActorTaskConversation } from './task-navigation-core'

export interface TaskConversationIntent {
  conversationId: string
  taskId: string
  taskCreatedAt: string
  spaceId: string
  workspaceKey: string
  teamActorId: string
  token: string
  originPage: ReturnType<typeof useApp.getState>['page']
  originShell: ReturnType<typeof useMy.getState>['shellView']
  request?: 'analyze' | 'develop'
  expectedUpdatedAt?: string
  design?: ConversationTaskDesign
  canvas?: { documentId: string; candidateId?: string }
}

let pendingIntent: TaskConversationIntent | null = null
const listeners = new Set<() => void>()

function snapshotIntent(): TaskConversationIntent | null {
  return pendingIntent
}

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The team side validates its actor-scoped binding; the private client read validates local visibility. */
export async function openTaskConversationFromPost(task: CruxTask, conversationId: string, current: () => boolean = () => true,
  target: Pick<TaskConversationIntent, 'design' | 'canvas' | 'request'> = {}): Promise<void> {
  const openingState = useCrux.getState()
  const originPage = useApp.getState().page
  const originShell = useMy.getState().shellView
  const context = openingState.workspaceContext
  const teamActorId = context.actorId
  const client = conversationClient()
  const link = task.conversations?.find(candidate => candidate.actorId === teamActorId && candidate.id === conversationId)
  if (!client || !teamActorId || !link) throw Error('当前成员还没有此任务的任务对话。')

  const read = conversationValue(await client.read(link.id))
  const closedState = useCrux.getState()
  const currentTask = closedState.snapshot?.tasks.find(candidate => candidate.id === task.id && candidate.createdAt === task.createdAt && candidate.spaceId === task.spaceId)
  const stillBound = Boolean(closedState.workspaceContext.key === context.key && closedState.workspaceContext.actorId === teamActorId &&
    currentTask?.conversations?.some(candidate => candidate.id === link.id && candidate.actorId === teamActorId))
  if (!currentTask || !stillBound || !current() || read.conversation.id !== link.id) throw Error('任务对话身份或来源已变化。')
  if (target.request) {
    const space = closedState.snapshot?.spaces.find(candidate => candidate.id === currentTask.spaceId)
    if (!['local', 'connected'].includes(closedState.workspaceContext.state) || !space || space.archived || !space.memberIds.includes(teamActorId)) {
      throw Error('当前工作区或任务空间不可发送，请先恢复访问。')
    }
  }

  pendingIntent = {
    conversationId: link.id,
    taskId: task.id,
    taskCreatedAt: task.createdAt,
    spaceId: task.spaceId,
    workspaceKey: context.key,
    teamActorId,
    token: crypto.randomUUID(), originPage, originShell, ...target,
    expectedUpdatedAt: target.request ? currentTask.updatedAt : undefined
  }
  emit()
  selectConversation(read.conversation)
  showPrivateConversation(read.conversation.kind)
}

export async function ensureTaskConversationFromPost(task: CruxTask, kind: 'work' | 'code' = 'work', current: () => boolean = () => true,
  design?: ConversationTaskDesign, request?: TaskConversationIntent['request']): Promise<void> {
  const openingState = useCrux.getState()
  const context = openingState.workspaceContext
  const actorId = context.actorId
  const client = conversationClient()
  if (!client || !actorId || !['local', 'connected'].includes(context.state)) throw Error('当前工作区尚未确认，无法创建任务对话。')

  const assertSourceCurrent = (): void => {
    if (!current()) throw Error('原任务已关闭，请重新打开。')
    const latest = useCrux.getState()
    const latestContext = latest.workspaceContext
    if (latestContext.key !== context.key || latestContext.actorId !== actorId || latestContext.state !== context.state ||
        latestContext.instanceId !== context.instanceId || latestContext.epoch !== context.epoch) throw Error('任务工作区已变化，请重新打开原任务。')
    const latestTask = latest.snapshot?.tasks.find(candidate => candidate.id === task.id && candidate.createdAt === task.createdAt && candidate.spaceId === task.spaceId)
    const latestSpace = latest.snapshot?.spaces.find(candidate => candidate.id === task.spaceId)
    if (!latestTask || !latestSpace || latestSpace.archived || !latestSpace.memberIds.includes(actorId)) throw Error('原任务或空间已变化，请重新打开。')
  }
  assertSourceCurrent()

  let directory: ConversationDirectoryGrant | null = null
  let existingId: string | undefined
  if (kind === 'code') {
    // A bound Code draft is usable before its first send, while general history omits empty drafts.
    for (const link of [...(task.conversations ?? [])].reverse()) {
      if (!current()) return
      if (link.actorId !== actorId) continue
      const reply = await client.read(link.id)
      if (!reply.ok && ['E_NOT_FOUND', 'E_DENIED'].includes(reply.code)) continue
      const chat = conversationValue(reply).conversation
      if (chat.id === link.id && chat.kind === 'code' && chat.archivedAt === undefined) { existingId = chat.id; break }
    }
    if (!current()) return
    if (!existingId) {
      directory = conversationValue(await client.pickDirectory({ purpose: 'code' }))
      if (!directory || !current()) return
    }
  }
  const assertCurrent = (): void => {
    if (!current()) throw Error('原任务已关闭，请重新打开。')
  }
  const ports = {
    createDraft: async () => {
      assertCurrent()
      return conversationValue(await client.createDraft({ kind, directoryGrantId: directory?.grantId, runtimeId: useConversations.getState().defaultRuntimeId }))
    },
    updateDraft: async (id: string, input: Parameters<typeof updateConversation>[1]) => {
      assertCurrent()
      const conversation = await updateConversation(id, input)
      if (!conversation) throw Error('任务对话标题保存未确认。')
      return { conversation }
    },
    taskAction: async (id: string, input: ConversationTaskAction) => {
      assertCurrent()
      return conversationValue(await client.taskAction(id, input))
    },
    bootstrap: async () => {
      await useCrux.getState().bootstrap()
      return useCrux.getState().snapshot ?? undefined
    },
    read: async (id: string) => conversationValue(await client.read(id))
  }
  const bound = await ensureActorTaskConversation(task, { workspaceKey: context.key, actorId }, ports, kind === 'code' ? { kind, existingId } : undefined)
  const link = bound.task.conversations?.find(candidate => candidate.actorId === actorId && candidate.id === bound.conversation.id)
  if (!link || !isActorTaskConversation(bound.task, { workspaceKey: context.key, actorId }, link.id)) throw Error('任务对话绑定未出现在当前任务。')
  const resumeCode = kind === 'code' && Boolean(existingId && bound.conversation.nativeRef) && !design
  if (current()) await openTaskConversationFromPost(bound.task, link.id, current, { design, request: resumeCode ? undefined : request })
}

export function useTaskConversationIntent(): TaskConversationIntent | null {
  return useSyncExternalStore(subscribe, snapshotIntent, () => null)
}

export function consumeTaskConversationIntent(token: string): TaskConversationIntent | null {
  if (!pendingIntent || pendingIntent.token !== token) return null
  const intent = pendingIntent
  pendingIntent = null
  emit()
  return intent
}
