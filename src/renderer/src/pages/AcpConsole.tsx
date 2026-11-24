import { lazy, Suspense, useState, type JSX } from 'react'
import type { ConversationProjectRole } from '../../../shared/conversation/project-role'
import { TaskConversationWorkspace } from '../crux/TaskConversationWorkspace'
import { projectRootKey } from '../my/navigation'
import { PageLoading } from '../my/layout/PageLoading'
import { useMy } from '../my/store'
import { EmptyState } from '../my/ui'
import { useApp } from '../store'
import { InteractionScope } from '../utils/interaction-scope'

const NativeConversationWorkbench = lazy(() => import('../conversation-workbench/ConversationWorkbench').then(module => ({ default: module.ConversationWorkbench })))
const ConversationRoles = lazy(() => import('../acp/ConversationRoles').then(module => ({ default: module.ConversationRoles })))

export function AcpConsolePage({ compact = false }: { compact?: boolean }): JSX.Element {
  const agentView = useMy((state) => state.agentTarget)
  const taskTarget = useMy((state) => state.taskConversationTarget)
  const root = useApp((state) => state.snapshot?.meta.root)
  const activeRootKey = projectRootKey(root)
  const [roleRequest, setRoleRequest] = useState<{ rootKey: string; role: ConversationProjectRole }>()
  const pendingRole = !compact && roleRequest?.rootKey === activeRootKey ? roleRequest?.role : undefined
  const showRoles = !compact && agentView === 'roles'
  const task = !compact && !showRoles && taskTarget?.kind === 'ordinary' ? taskTarget : null
  const showProject = !showRoles && !task

  return <>
    {root && <div className="h-full min-h-0" hidden={!showProject}>
      <InteractionScope active={showProject}>
        <Suspense fallback={<PageLoading />}>
          <NativeConversationWorkbench key={activeRootKey} root={root} source="code" projectIntake compact={compact}
            projectRoleRequest={pendingRole} onProjectRoleOpened={() => setRoleRequest(current => current === roleRequest ? undefined : current)} />
        </Suspense>
      </InteractionScope>
    </div>}
    {task && <TaskConversationWorkspace key={task.scope.scopeKey} target={task} />}
    {showRoles && root && activeRootKey && <Suspense fallback={<PageLoading />}>
      <ConversationRoles key={activeRootKey} root={root} onStart={role => {
        setRoleRequest({ rootKey: activeRootKey, role })
        useMy.getState().setTaskConversationTarget(null)
        useMy.getState().requestAgentView('conversation')
      }} />
    </Suspense>}
    {!root && !task && <EmptyState title="请先打开本机工程" />}
  </>
}
