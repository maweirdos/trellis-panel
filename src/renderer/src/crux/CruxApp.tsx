import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { inboxGroups, observeCollaborationWorkspace, useCrux } from './store'
import { WorkspaceNavigation } from './WorkspaceNavigation'
import { COLLABORATION_MODULES } from './navigation'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { Button } from '../my/ui'
import { SidebarResizeHandle, useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import { ContextRegion } from '../my/layout/ContextRegion'
import { FlowIcon } from './icons'
import { OverviewPage } from './pages/OverviewPage'
import { TaskWorkspace } from './TaskWorkspace'
import { InboxPage } from './pages/InboxPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { IterationsPage } from './pages/IterationsPage'
import { MembersPage, type WebInvitationCapability } from './pages/MembersPage'
import { SpacesPage } from './pages/SpacesPage'
import { AgentsPage } from './pages/AgentsPage'
import { SkillsPage } from './pages/SkillsPage'
import { CrewsPage } from './pages/CrewsPage'
import { AutomationsPage } from './pages/AutomationsPage'
import { AgentDirectoryPage } from './pages/AgentDirectoryPage'
import { ViewsPage } from './pages/ViewsPage'
import { ConfigurationPage } from './pages/ConfigurationPage'
import { EmbeddedTaskPost, NewTaskModal } from './pages/TaskDetailDrawer'
import './collaboration.css'
import { ConnectionPanel } from './ConnectionPanel'

const CreationWorkspace = lazy(() => import('../creations/CreationWorkspace').then((module) => ({ default: module.CreationWorkspace })))

/** Both personal and team task surfaces follow the same collaboration source. */
export function useCollaborationWorkspace(): number {
  const bootstrap = useCrux((state) => state.bootstrap)
  const [now, setNow] = useState(Date.now)
  useEffect(() => { void bootstrap() }, [bootstrap])
  useEffect(observeCollaborationWorkspace, [])
  useEffect(() => { const timer = window.setInterval(() => { setNow(Date.now()); void bootstrap() }, 30_000); return () => window.clearInterval(timer) }, [bootstrap])
  return now
}

export function CruxApp({ host = 'desktop', webInvitation, webSpaceAction, automationsOnly = false }: {
  host?: 'desktop' | 'web'
  webInvitation?: WebInvitationCapability
  webSpaceAction?: ReactNode
  automationsOnly?: boolean
} = {}): JSX.Element {
  const { bootstrap, snapshot, loadError, module, currentSpaceId, busy, createTaskOpen, createTaskContext, setCreateTaskOpen, workspaceContext } = useCrux()
  const collapsed = useMy((s) => s.sidebarCollapsed)
  const sidebarStyle = useSidebarWidthStyle()
  const now = useCollaborationWorkspace()
  if (loadError) return <div className="grid h-full place-items-center p-6"><div role="alert" className="flex max-w-md flex-col gap-3 text-my-sm text-my-secondary"><p>{loadError}</p><Button variant="outline" onClick={() => void bootstrap()}>重新加载</Button>{host === 'desktop' && <ConnectionPanel />}</div></div>
  if (!snapshot) return <div role="status" className="grid h-full place-items-center text-my-xs text-my-tertiary">{automationsOnly ? '正在加载自动化…' : '正在加载团队协作…'}</div>
  const groups = inboxGroups(snapshot.inbox, now)
  const unread = groups.unread.important + groups.unread.other
  const route = COLLABORATION_MODULES.find((entry) => entry.id === module)
  const space = snapshot.spaces.find((entry) => entry.id === currentSpaceId)
  const actorId = workspaceContext.actorId ?? (workspaceContext.state === 'local' ? snapshot.members.find((member) => member.role === 'owner')?.id : undefined)
  if (automationsOnly) {
    if (!space || space.archived || !actorId || !space.memberIds.includes(actorId) || workspaceContext.state === 'access-revoked') {
      return <div className="space-y-3"><h1 className="text-my-lg font-semibold">自动化</h1><p className="my-item-description">请从顶栏选择已加入的团队空间。</p><Button variant="outline" onClick={() => { useCrux.getState().setModule('spaces'); useApp.getState().setPage('crux') }}>管理空间</Button></div>
    }
    const readOnly = workspaceContext.state !== 'local' && (workspaceContext.state !== 'connected' || !workspaceContext.canManage)
    return <fieldset key={`${workspaceContext.key}:${actorId}:${space.id}:${readOnly}`} className="min-w-0 border-0 p-0" disabled={readOnly} aria-label={`${space.name}的自动化`}>
      <AutomationsPage />
    </fieldset>
  }
  const spaceAccess = space?.visibility === 'private' ? space.memberIds.includes(actorId ?? '') ? 'member' : 'metadata' : 'public'
  const separateReader = Boolean(useCrux.getState().openTaskId && !['tasks', 'board', 'my-tasks', 'triage', 'iterations'].includes(module))
  const taskWorkspace = ['tasks', 'board', 'my-tasks', 'triage', 'creations'].includes(module)
  return <div className="collab-workspace" data-host={host} aria-label="团队协作工作区">
    <ContextRegion collapsed={host === 'desktop' && collapsed}><aside aria-label="协作导航" style={sidebarStyle} className="collab-sidebar">
      <SidebarResizeHandle />
      <header className={host === 'web' && webSpaceAction ? 'flex items-center justify-between gap-2' : undefined}>
        <span className="text-my-sm font-semibold text-my-primary">团队协作</span>
        {host === 'web' && webSpaceAction}
      </header>
      <WorkspaceNavigation key={workspaceContext.key} unread={unread} onOpenAutomations={host === 'desktop' ? () => useApp.getState().setPage('automations') : undefined} />
      <footer className="flex flex-col gap-2 border-t border-my-line p-3 text-my-xs text-my-tertiary">{host === 'desktop' && <><button type="button" className="flex items-center gap-2 text-left hover:text-my-primary" onClick={() => useApp.getState().setPage('team')}><FlowIcon name="reports" size={16} />项目动态与报告</button><ConnectionPanel /></>}<span role="status">{busy ? '正在保存…' : workspaceContext.state === 'local' ? '本机协作数据' : workspaceContext.state === 'connected' ? `已同步 · 修订 ${workspaceContext.revision}` : workspaceContext.state === 'offline' ? '离线缓存 · 权限为上次核对' : '访问权限已失效'}</span></footer>
    </aside>
    </ContextRegion>
    <fieldset className={`collab-main border-0 ${taskWorkspace ? 'is-task-workspace' : ''}`} data-crux-module={module} key={`${workspaceContext.key}:${spaceAccess}:${currentSpaceId}:${module}`} disabled={workspaceContext.state !== 'local' && !workspaceContext.canManage && ['agents', 'crews', 'skills', 'automations'].includes(module)}>
      {!taskWorkspace && route?.scope === 'space' && space && <div aria-label="当前空间" className="mb-3 flex min-w-0 shrink-0 items-center gap-2 text-my-xs text-my-tertiary"><FlowIcon name="projects" size={14} /><span className="truncate">{space.name}</span><span aria-hidden="true">/</span><span className="shrink-0">{route.label}</span>{space.archived && <span className="ml-auto">空间已停用 · 历史只读</span>}</div>}
      <div className="collab-main-content" ref={(element) => { element?.toggleAttribute('inert', createTaskOpen) }} aria-hidden={createTaskOpen || undefined}>
      {separateReader && <EmbeddedTaskPost taskId={useCrux.getState().openTaskId!} onClose={() => useCrux.getState().openTask(null)} />}
      <div hidden={separateReader} className={separateReader ? undefined : 'contents'}>
      {module === 'overview' && <OverviewPage />}{module === 'my-tasks' && <TaskWorkspace scope="mine" />}{module === 'all-agents' && <AgentDirectoryPage />}{module === 'views' && <ViewsPage />}{module === 'tasks' && <TaskWorkspace scope="space" />}{module === 'board' && <TaskWorkspace scope="space" layout="board" />}{module === 'inbox' && <InboxPage />}{module === 'triage' && <TaskWorkspace scope="triage" />}{module === 'projects' && <ProjectsPage />}{module === 'iterations' && <IterationsPage renderTasks={(tasks, iteration) => <TaskWorkspace scope="space" iterationId={iteration.id} taskIds={tasks.map((task) => task.id)} />} />}{module === 'members' && <MembersPage webInvitation={webInvitation} />}{module === 'spaces' && <SpacesPage />}{module === 'agents' && <AgentsPage />}{module === 'skills' && <SkillsPage />}{module === 'crews' && <CrewsPage />}{module === 'automations' && <AutomationsPage />}
      {module === 'task-types' && <ConfigurationPage kind="types" />}{module === 'task-statuses' && <ConfigurationPage kind="statuses" />}{module === 'task-labels' && <ConfigurationPage kind="labels" />}
      {module === 'creations' && <Suspense fallback={<div role="status" className="grid h-full place-items-center text-my-sm text-my-tertiary">正在加载产物…</div>}><CreationWorkspace scope="team" /></Suspense>}
      </div></div><NewTaskModal {...createTaskContext} open={createTaskOpen} onClose={() => setCreateTaskOpen(false)} />
    </fieldset>
  </div>
}
