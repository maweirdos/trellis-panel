import type { CruxTask } from '@shared/crux'
import { isOrdinaryConversationTask, sameConversationTaskLocator, type ConversationTaskScope } from '@shared/conversation/task-scope'
import { api } from '../api'
import { useApp, type Page } from '../store'
import { useMy } from '../my/store'
import { useCrux, type CruxModule } from './store'
import { canReadTaskSpace, taskSourceKey } from './pages/task-detail/use-task-source'
import { captureWorkPage, restoreWorkPage } from './local-work'
import type { WorkPageSnapshot } from './development/types'

interface TaskConversationOrigin {
  workspaceKey: string
  taskId: string
  taskCreatedAt: string
  sourceKey: string
  spaceId: string
  module: CruxModule
  selectedSpaceId: string | null
  fromPage: Page
  pageSnapshot: WorkPageSnapshot
}

export type TaskConversationTarget = TaskConversationOrigin & { kind: 'ordinary'; scope: ConversationTaskScope }

export function ownsTaskConversation(target: TaskConversationTarget): boolean {
  const state = useCrux.getState()
  const task = state.snapshot?.tasks.find(item => item.id === target.taskId && item.createdAt === target.taskCreatedAt && item.spaceId === target.spaceId)
  return Boolean(state.snapshot && task && taskSourceKey(state.snapshot, state.workspaceContext) === target.sourceKey &&
    state.workspaceContext.key === target.workspaceKey && canReadTaskSpace(state.snapshot, state.workspaceContext, target.spaceId) &&
    state.workspaceContext.state === 'connected' && task.assigneeIds[0] === target.scope.handlerId && isOrdinaryConversationTask(task))
}

function taskConversationOrigin(workspaceKey: string, task: CruxTask): TaskConversationOrigin {
  const state = useCrux.getState()
  if (!state.snapshot) throw Error('任务来源已改变，请重新打开。')
  return { workspaceKey, taskId: task.id, taskCreatedAt: task.createdAt,
    spaceId: task.spaceId, sourceKey: taskSourceKey(state.snapshot, state.workspaceContext), module: state.module,
    selectedSpaceId: state.currentSpaceId, fromPage: useApp.getState().page, pageSnapshot: captureWorkPage() }
}

function activateTaskConversation(target: TaskConversationTarget): void {
  if (!ownsTaskConversation(target)) throw Error('原任务或空间当前不可用。')
  useMy.getState().setTaskConversationTarget(target)
  useMy.getState().requestAgentView(null)
  useApp.getState().setPage('acp')
}

export async function openOrdinaryTaskConversation(workspaceKey: string, task: CruxTask, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return
  const origin = taskConversationOrigin(workspaceKey, task)
  const locator = { workspaceKey, taskId: task.id, taskCreatedAt: task.createdAt }
  const result = await api.conversationTaskScope(locator)
  if (!isCurrent()) return
  if (!result.ok) throw Error(result.error)
  const { scope } = result
  if (!sameConversationTaskLocator(scope.locator, locator) || scope.spaceId !== task.spaceId) throw Error('原任务会话来源已改变。')
  activateTaskConversation({ ...origin, kind: 'ordinary', scope })
}

export function returnToConversationTask(target: TaskConversationTarget): void {
  if (useMy.getState().taskConversationTarget !== target || !ownsTaskConversation(target)) return
  useMy.getState().setTaskConversationTarget(null)
  restoreWorkPage(target.pageSnapshot, target.taskId)
}

// A source change invalidates even a batched A → B → A; no target grants authority.
useCrux.subscribe(() => {
  const target = useMy.getState().taskConversationTarget
  if (target && !ownsTaskConversation(target)) useMy.getState().setTaskConversationTarget(null)
})
