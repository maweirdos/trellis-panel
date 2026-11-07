import type { CruxTask } from '@shared/crux'
import type { CruxProgressSession } from '@shared/crux-task-progress'
import { useApp, type Page } from '../store'
import { useMy } from '../my/store'
import { useCrux, type CruxModule } from './store'
import { canReadTaskSpace, taskSourceKey } from './pages/task-detail/use-task-source'
import { captureWorkPage, restoreWorkPage } from './local-work'
import type { WorkPageSnapshot } from './development/types'

export interface TaskConversationTarget {
  workspaceKey: string
  taskId: string
  taskCreatedAt: string
  sourceKey: string
  spaceId: string
  module: CruxModule
  selectedSpaceId: string | null
  fromPage: Page
  session: CruxProgressSession
  readOnly: boolean
  pageSnapshot: WorkPageSnapshot
}

export function ownsTaskConversation(target: TaskConversationTarget): boolean {
  const state = useCrux.getState()
  return Boolean(state.snapshot && taskSourceKey(state.snapshot, state.workspaceContext) === target.sourceKey &&
    state.workspaceContext.key === target.workspaceKey && canReadTaskSpace(state.snapshot, state.workspaceContext, target.spaceId) &&
    state.snapshot.tasks.some((task) => task.id === target.taskId && task.createdAt === target.taskCreatedAt && task.spaceId === target.spaceId))
}

/** Explicit continuation stays in the existing Agent route, without selecting a code project. */
export async function openTaskConversation(workspaceKey: string, task: CruxTask, session: CruxProgressSession, readOnly = false): Promise<void> {
  const state = useCrux.getState()
  if (!state.snapshot || state.openTaskId !== task.id) throw Error('任务来源已改变，请重新打开。')
  const target: TaskConversationTarget = { workspaceKey, taskId: task.id, taskCreatedAt: task.createdAt,
    spaceId: task.spaceId, sourceKey: taskSourceKey(state.snapshot, state.workspaceContext), module: state.module,
    selectedSpaceId: state.currentSpaceId, fromPage: useApp.getState().page, session, readOnly, pageSnapshot: captureWorkPage() }
  if (!ownsTaskConversation(target)) throw Error('原任务或空间当前不可用。')
  useMy.getState().setTaskConversationTarget(target)
  useMy.getState().requestAgentView(null)
  useApp.getState().setPage('acp')
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
