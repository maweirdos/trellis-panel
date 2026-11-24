import { lazy, Suspense } from 'react'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { Button } from '../my/ui'
import { PageLoading } from '../my/layout/PageLoading'
import { ownsTaskConversation, returnToConversationTask, type TaskConversationTarget } from './task-conversation'
import { useCrux } from './store'

const ConversationWorkbench = lazy(() => import('../conversation-workbench/ConversationWorkbench')
  .then(module => ({ default: module.ConversationWorkbench })))

export function TaskConversationWorkspace({ target }: { target: TaskConversationTarget }): JSX.Element {
  useCrux(state => state.snapshot)
  if (!ownsTaskConversation(target)) {
    return <div className="flex h-full flex-col items-center justify-center gap-3 text-my-sm text-my-secondary">
      <p>原任务会话当前不可用。</p>
      <Button variant="outline" onClick={() => {
        useMy.getState().setTaskConversationTarget(null)
        useApp.getState().setPage('crux')
      }}>返回团队</Button>
    </div>
  }
  const { scope } = target
  return <Suspense fallback={<PageLoading />}>
    <ConversationWorkbench key={scope.scopeKey} root={scope.cwd} source="task" taskScope={scope}
      onBackToTask={() => returnToConversationTask(target)} />
  </Suspense>
}
