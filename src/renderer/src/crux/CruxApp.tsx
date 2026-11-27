import { useEffect, useState, type ReactNode } from 'react'
import { resolveSpaceModules } from '@shared/crux-space-presets'
import { inboxGroups, observeCollaborationWorkspace, useCrux } from './store'
import { WorkspaceNavigation } from './WorkspaceNavigation'
import { useApp } from '../store'
import { useMy } from '../my/store'
import { Button, Modal } from '../my/ui'
import { SidebarResizeHandle, useSidebarWidthStyle } from '../my/layout/SidebarResizeHandle'
import { ContextRegion } from '../my/layout/ContextRegion'
import { CruxCommandPalette } from './CruxCommandPalette'
import { OverviewPage } from './pages/OverviewPage'
import { TaskWorkspace } from './TaskWorkspace'
import { InboxPage } from './pages/InboxPage'
import { TriagePage } from './pages/TriagePage'
import { AnalyticsPage } from './pages/AnalyticsPage'
import { MarketplacePage } from './pages/MarketplacePage'
import { ProjectsPage } from './pages/ProjectsPage'
import { IterationsPage } from './pages/IterationsPage'
import { MembersPage, type WebInvitationCapability } from './pages/MembersPage'
import { SpacesPage } from './pages/SpacesPage'
import { RuntimesPage } from './pages/RuntimesPage'
import { AgentsPage } from './pages/AgentsPage'
import { SkillsPage } from './pages/SkillsPage'
import { CrewsPage } from './pages/CrewsPage'
import { AutomationsPage } from './pages/AutomationsPage'
import { AgentDirectoryPage } from './pages/AgentDirectoryPage'
import { CruxChatPage } from './pages/CruxChatPage'
import { ViewsPage } from './pages/ViewsPage'
import { ConfigurationPage } from './pages/ConfigurationPage'
import { EmbeddedTaskPost, NewTaskModal } from './pages/TaskDetailDrawer'
import { SpaceSetupWizard } from './account/SpaceSetupWizard'
import { SpaceKnowledgeHub } from '../knowledge/SpaceKnowledgeHub'
import './collaboration.css'
import { ConnectionPanel } from './ConnectionPanel'

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
  const { bootstrap, snapshot, loadError, module, currentSpaceId, createTaskOpen, createTaskContext, setCreateTaskOpen, setCurrentSpace, setModule, workspaceContext } = useCrux()
  const collapsed = useMy((s) => s.sidebarCollapsed)
  const sidebarStyle = useSidebarWidthStyle()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [orgDialogOpen, setOrgDialogOpen] = useState(false)
  const now = useCollaborationWorkspace()
  const space = snapshot?.spaces.find((entry) => entry.id === currentSpaceId)
  const enabledModules = resolveSpaceModules(space)

  // 当前所在功能模块在空间设置中被关闭时，自动平滑回退到任务视图
  useEffect(() => {
    if (!space) return
    const disabled = (module === 'views' && !enabledModules.views)
      || (module === 'iterations' && !enabledModules.iterations)
      || (module === 'projects' && !enabledModules.projects)
      || (module === 'triage' && !enabledModules.triage)
      || ((module === 'agents' || module === 'crews') && !enabledModules.agents)
      || (module === 'automations' && !enabledModules.automations)
      || (module === 'skills' && !enabledModules.skills)
      || (module === 'creations' && !enabledModules.docs)
    if (disabled) setModule('tasks')
  }, [space, module, enabledModules, setModule])

  if (loadError) return <div className="grid h-full place-items-center p-6"><div role="alert" className="flex max-w-md flex-col gap-3 text-my-sm text-my-secondary"><p>{loadError}</p><Button variant="outline" onClick={() => void bootstrap()}>重新加载</Button>{host === 'desktop' && <ConnectionPanel />}</div></div>
  if (!snapshot) return <div role="status" className="grid h-full place-items-center text-my-xs text-my-tertiary">{automationsOnly ? '正在加载自动化…' : '正在加载团队协作…'}</div>
  const groups = inboxGroups(snapshot.inbox, now)
  const unread = groups.unread.important + groups.unread.other
  const actorId = workspaceContext.actorId ?? (workspaceContext.state === 'local' ? snapshot.members.find((member) => member.role === 'owner')?.id : undefined)
  if (automationsOnly) {
    if (!space || space.archived || !actorId || !space.memberIds.includes(actorId) || workspaceContext.state === 'access-revoked') {
      return <div className="space-y-3"><h1 className="text-my-lg font-semibold">Agent 自动化</h1><p className="my-item-description">请从顶栏选择已加入的团队空间。</p><Button variant="outline" onClick={() => { useCrux.getState().setModule('spaces'); useApp.getState().setPage('crux') }}>管理空间</Button></div>
    }
    const readOnly = workspaceContext.state !== 'local' && (workspaceContext.state !== 'connected' || !workspaceContext.canManage)
    return <fieldset key={`${workspaceContext.key}:${actorId}:${space.id}:${readOnly}`} className="min-w-0 border-0 p-0" disabled={readOnly} aria-label={`${space.name}的自动化`}>
      <AutomationsPage />
    </fieldset>
  }

  const spaceAccess = space?.visibility === 'private' ? space.memberIds.includes(actorId ?? '') ? 'member' : 'metadata' : 'public'
  const fullBleedModule = ['tasks', 'board', 'my-tasks', 'all-agents', 'agents', 'crews', 'marketplace', 'creations', 'chat'].includes(module)
  const separateReader = Boolean(
    useCrux.getState().openTaskId
    && !['tasks', 'board', 'my-tasks', 'triage', 'iterations', 'inbox'].includes(module)
  )
  const needsSpaceInit = Boolean(space && space.initialized === false && !space.archived && workspaceContext.canManage && workspaceContext.state !== 'access-revoked')

  return (
    <div className="collab-workspace" data-host={host} aria-label="团队协作工作区">
      <ContextRegion collapsed={host === 'desktop' && collapsed}>
        <aside aria-label="协作导航" style={sidebarStyle} className="collab-sidebar">
          <SidebarResizeHandle />
          {host === 'web' && webSpaceAction && (
            <header className="flex items-center justify-between gap-2 border-b border-my-line px-3 py-2">
              <span className="text-my-sm font-semibold text-my-primary">{workspaceContext.projectName ?? '团队协作'}</span>
              {webSpaceAction}
            </header>
          )}
          <WorkspaceNavigation key={workspaceContext.key} unread={unread} />
          {host === 'desktop' && (
            <ConnectionPanel hideTrigger open={orgDialogOpen} onOpenChange={setOrgDialogOpen} />
          )}
        </aside>
      </ContextRegion>

      <fieldset
        className={`collab-main border-0 ${fullBleedModule ? 'is-task-workspace' : ''}`}
        data-crux-module={module}
        key={`${workspaceContext.key}:${spaceAccess}:${currentSpaceId}:${module}`}
        disabled={workspaceContext.state !== 'local' && !workspaceContext.canManage && ['agents', 'crews', 'skills', 'automations'].includes(module)}
      >
        <div className="collab-main-content" ref={(element) => { element?.toggleAttribute('inert', createTaskOpen) }} aria-hidden={createTaskOpen || undefined}>
          {separateReader && <EmbeddedTaskPost taskId={useCrux.getState().openTaskId!} onClose={() => useCrux.getState().openTask(null)} />}
          <div hidden={separateReader} className={separateReader ? undefined : 'contents'}>
            {module === 'overview' && <OverviewPage />}
            {module === 'chat' && <CruxChatPage />}
            {module === 'my-tasks' && <TaskWorkspace scope="mine" />}
            {module === 'all-agents' && <AgentDirectoryPage />}
            {module === 'marketplace' && <MarketplacePage />}
            {module === 'runtimes' && <RuntimesPage />}
            {module === 'analytics' && <AnalyticsPage />}
            {module === 'views' && <ViewsPage />}
            {module === 'tasks' && <TaskWorkspace scope="space" />}
            {module === 'board' && <TaskWorkspace scope="space" layout="board" />}
            {module === 'inbox' && <InboxPage />}
            {module === 'triage' && <TriagePage />}
            {module === 'projects' && <ProjectsPage />}
            {module === 'iterations' && (
              <IterationsPage
                renderTasks={(tasks, iteration) => (
                  <TaskWorkspace scope="space" iterationId={iteration.id} taskIds={tasks.map((task) => task.id)} />
                )}
              />
            )}
            {module === 'members' && <MembersPage webInvitation={webInvitation} />}
            {module === 'spaces' && <SpacesPage />}
            {(module === 'agents' || module === 'crews') && <AgentsPage />}
            {module === 'skills' && <SkillsPage />}
            {module === 'automations' && <AutomationsPage />}
            {module === 'task-types' && <ConfigurationPage kind="types" />}
            {module === 'task-statuses' && <ConfigurationPage kind="statuses" />}
            {module === 'task-labels' && <ConfigurationPage kind="labels" />}
            {module === 'creations' && <SpaceKnowledgeHub host={host} showSpaceSwitcher={false} />}
          </div>
        </div>
        <NewTaskModal {...createTaskContext} open={createTaskOpen} onClose={() => setCreateTaskOpen(false)} />
        <CruxCommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onOpenOrgSwitcher={host === 'desktop' ? () => setOrgDialogOpen(true) : undefined}
        />
      </fieldset>

      <Modal open={needsSpaceInit} onClose={() => {}} width={760} ariaLabel="初始化默认空间">
        {needsSpaceInit && space && (
          <SpaceSetupWizard
            mode="initialize"
            space={space}
            organizationName={workspaceContext.projectName}
            onComplete={(targetSpaceId) => {
              setCurrentSpace(targetSpaceId)
              setModule('tasks')
            }}
          />
        )}
      </Modal>
    </div>
  )
}
