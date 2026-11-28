import { useEffect, useRef, useState } from 'react'
import {
  ChevronRight, MoreHorizontal, Plus, ShoppingBag, Sparkles, Star, Users2
} from 'lucide-react'
import { resolveSpaceModules } from '@shared/crux-space-presets'
import { DisclosureGrid, Dropdown, DropdownDivider, DropdownHeader, DropdownItem, Modal } from '../my/ui'
import { AgentAvatar } from './AgentAvatar'
import { useAgentChatBridge } from './agent-chat-bridge'
import { useCollaborationPlatform } from './collaboration-platform-store'
import { GetStartedWidget } from './GetStartedWidget'
import { FlowIcon } from './icons'
import { identityTone } from './identity-tone'
import { SpaceSetupWizard } from './account/SpaceSetupWizard'
import { isTriagePending, useCrux, type CruxModule } from './store'
import { AGENT_PRESENCE_META, computeAgentPresence, isActiveRunStatus, useTaskRuns } from './task-run-store'

export function WorkspaceNavigation({
  unread,
  onOpenAutomations
}: {
  unread: number
  onOpenAutomations?: () => void
}): JSX.Element | null {
  const { snapshot, module, currentSpaceId, workspaceContext, setModule, setCurrentSpace, beginCreateTask, openTask } = useCrux()
  const activeChatAgentId = useAgentChatBridge((state) => state.selectedAgentId)
  const runs = useTaskRuns((state) => state.runs)
  const favorites = useCollaborationPlatform((state) => state.favorites)
  const toggleFavorite = useCollaborationPlatform((state) => state.toggleFavorite)

  const [expandedSpaceId, setExpandedSpaceId] = useState<string | null>(() => currentSpaceId)
  const [chatsOpen, setChatsOpen] = useState(true)
  const [showAllChats, setShowAllChats] = useState(false)
  const [mySpacesOpen, setMySpacesOpen] = useState(true)
  const [taskMoreOpen, setTaskMoreOpen] = useState<Record<string, boolean>>({})
  const [orgOpen, setOrgOpen] = useState(false)
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false)
  const orgSectionRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (currentSpaceId) setExpandedSpaceId(currentSpaceId)
    if (module === 'runtimes' || module === 'members') setOrgOpen(true)
  }, [module, currentSpaceId])

  if (!snapshot) return null
  const actorId = workspaceContext.actorId ?? (workspaceContext.state === 'local' ? snapshot.members.find((member) => member.role === 'owner')?.id : null)
  const spaces = snapshot.spaces.filter((space) => !space.archived && actorId && space.memberIds.includes(actorId))
  const activeSpace = spaces.find((space) => space.id === currentSpaceId) ?? spaces[0]
  const activeRunCount = runs.filter((run) => isActiveRunStatus(run.status)).length

  const chatTargets = [
    ...snapshot.agents
      .filter((agent) => !agent.archived && agent.enabled && (!activeSpace || agent.spaceId === activeSpace.id))
      .map((agent) => ({
        key: `agent:${agent.id}`,
        kind: 'agent' as const,
        name: agent.name,
        avatarId: agent.avatarId,
        tooltip: agent.description && agent.description.trim() !== agent.name.trim() ? agent.description : `与 ${agent.name} 开始对话`,
        presence: computeAgentPresence(agent.id, runs, agent.enabled),
        onClick: () => useAgentChatBridge.getState().startAgentChat(agent.id, { runtimeKind: agent.runtimeKind, workingDirectory: agent.workingDirectory })
      })),
    ...snapshot.crews
      .filter((crew) => !crew.archived && (!activeSpace || crew.spaceId === activeSpace.id))
      .map((crew) => ({
        key: `crew:${crew.id}`,
        kind: 'crew' as const,
        name: crew.name,
        tooltip: crew.description || `${crew.members.length + 1} 位协作者`,
        presence: null,
        onClick: () => { setCurrentSpace(crew.spaceId); setModule('agents') }
      }))
  ]
  const visibleChats = showAllChats ? chatTargets : chatTargets.slice(0, 2)
  const hiddenChatCount = Math.max(0, chatTargets.length - visibleChats.length)

  const resolvedFavorites = favorites
    .map((fav) => {
      if (fav.kind === 'space') {
        const sp = snapshot.spaces.find((item) => item.id === fav.id && !item.archived)
        return sp ? { fav, label: sp.name, meta: sp.key, onOpen: () => { setCurrentSpace(sp.id); setModule('tasks') } } : null
      }
      if (fav.kind === 'task') {
        const task = snapshot.tasks.find((item) => item.id === fav.id)
        return task ? { fav, label: task.title, meta: task.id, onOpen: () => { setCurrentSpace(task.spaceId); openTask(task.id) } } : null
      }
      if (fav.kind === 'agent') {
        const agent = snapshot.agents.find((item) => item.id === fav.id && !item.archived)
        return agent ? { fav, label: agent.name, meta: 'Agent', onOpen: () => { setCurrentSpace(agent.spaceId); setModule('all-agents') } } : null
      }
      return null
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 6)

  const goSpaceModule = (target: CruxModule, spaceId: string): void => {
    if (spaceId !== currentSpaceId) setCurrentSpace(spaceId)
    if (target === 'automations' && onOpenAutomations) onOpenAutomations()
    else setModule(target)
  }

  return <>
    <div className="flex h-my-header shrink-0 items-center justify-between px-3">
      <h1 className="text-my-md font-semibold text-my-primary">首页</h1>
      <Dropdown
        align="right"
        width={184}
        trigger={({ toggle, open }) => (
          <button
            type="button"
            aria-label="新建任务或对话"
            aria-expanded={open}
            onClick={toggle}
            className="my-icon-control text-my-icon-secondary hover:text-my-primary"
          >
            <Plus size={15} strokeWidth={1.75} />
          </button>
        )}
      >
        {(close) => (
          <>
            <DropdownItem disabled={!activeSpace} onClick={() => { close(); if (activeSpace) beginCreateTask({ spaceId: activeSpace.id }) }}>
              <span className="flex-1">新建任务</span>
              <kbd className="my-kbd">C</kbd>
            </DropdownItem>
            <DropdownItem onClick={() => { close(); useAgentChatBridge.getState().startAgentChat(null) }}>
              新建 Agent 对话
            </DropdownItem>
            <DropdownDivider />
            <DropdownItem onClick={() => { close(); setModule('all-agents') }}>创建 Agent</DropdownItem>
            <DropdownItem onClick={() => { close(); setModule('all-agents') }}>创建小队</DropdownItem>
            {workspaceContext.canManage && workspaceContext.state !== 'access-revoked' && (
              <DropdownItem onClick={() => { close(); setCreateSpaceOpen(true) }}>新建空间</DropdownItem>
            )}
            <DropdownItem onClick={() => { close(); setModule('members') }}>邀请成员</DropdownItem>
          </>
        )}
      </Dropdown>
    </div>

    <nav aria-label="协作模块" className="collab-navigation collab-scroll">
      <section aria-label="全局入口" className="collab-nav-section">
        <button
          type="button"
          onClick={() => setModule('inbox')}
          aria-current={module === 'inbox' ? 'page' : undefined}
          className={`collab-nav-item ${module === 'inbox' ? 'is-selected' : ''}`}
        >
          <FlowIcon name="inbox" size={17} />
          <span className="min-w-0 flex-1 truncate">收件箱</span>
          {unread > 0 && <span className="collab-stat rounded-full bg-my-info-subtle px-1.5 py-0.5 text-my-2xs font-medium text-my-info-text">{unread > 99 ? '99+' : unread}</span>}
        </button>

        <button
          type="button"
          onClick={() => setModule('my-tasks')}
          aria-current={module === 'my-tasks' ? 'page' : undefined}
          className={`collab-nav-item ${module === 'my-tasks' ? 'is-selected' : ''}`}
        >
          <FlowIcon name="members" size={17} />
          <span className="min-w-0 flex-1 truncate">我的任务</span>
        </button>

        <button
          type="button"
          onClick={() => useAgentChatBridge.getState().startAgentChat(null)}
          aria-current={module === 'chat' && !activeChatAgentId ? 'page' : undefined}
          className={`collab-nav-item ${module === 'chat' && !activeChatAgentId ? 'is-selected' : ''}`}
        >
          <Sparkles size={17} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">小助手</span>
        </button>

        <button
          type="button"
          onClick={() => setModule('all-agents')}
          aria-current={module === 'all-agents' ? 'page' : undefined}
          className={`collab-nav-item ${module === 'all-agents' ? 'is-selected' : ''}`}
        >
          <FlowIcon name="agents" size={17} />
          <span className="min-w-0 flex-1 truncate">全部 Agent</span>
        </button>

        <button
          type="button"
          onClick={() => setModule('marketplace')}
          aria-current={module === 'marketplace' ? 'page' : undefined}
          className={`collab-nav-item ${module === 'marketplace' ? 'is-selected' : ''}`}
        >
          <ShoppingBag size={16} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">市场</span>
        </button>
      </section>

      {resolvedFavorites.length > 0 && (
        <section aria-label="收藏" className="collab-nav-section">
          <div className="collab-nav-section-heading">
            <span>收藏</span>
          </div>
          {resolvedFavorites.map(({ fav, label, meta, onOpen }) => (
            <div key={`${fav.kind}:${fav.id}`} className="collab-nav-parent group">
              <button type="button" className="collab-nav-item" onClick={onOpen}>
                <Star size={14} className="shrink-0 fill-current text-my-warning-text" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="shrink-0 font-mono text-my-2xs text-my-tertiary">{meta}</span>
              </button>
              <button
                type="button"
                aria-label={`取消收藏 ${label}`}
                className="collab-nav-disclosure opacity-0 group-hover:opacity-100 focus:opacity-100"
                onClick={() => toggleFavorite(fav.kind, fav.id, fav.spaceId)}
              >
                <Star size={12} />
              </button>
            </div>
          ))}
        </section>
      )}

      <section aria-label="对话" className="collab-nav-section">
        <button
          type="button"
          aria-expanded={chatsOpen}
          onClick={() => setChatsOpen((prev) => !prev)}
          className="collab-nav-section-heading w-full justify-start gap-1 text-left hover:text-my-primary"
        >
          <span>对话</span>
          <ChevronRight size={11} className="my-disclosure-chevron" data-open={chatsOpen || undefined} />
        </button>
        <DisclosureGrid open={chatsOpen} innerClassName="flex flex-col gap-0.5">
            {visibleChats.length === 0 ? (
              <button
                type="button"
                onClick={() => useAgentChatBridge.getState().startAgentChat(null)}
                className="collab-nav-item text-my-xs text-my-tertiary"
              >
                <Plus size={14} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">发起 Agent 对话</span>
              </button>
            ) : (
              visibleChats.map((entry) => {
                const isSelectedChat = module === 'chat' && entry.kind === 'agent' && entry.key === `agent:${activeChatAgentId}`
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={entry.onClick}
                    title={entry.tooltip}
                    aria-current={isSelectedChat ? 'page' : undefined}
                    className={`collab-nav-item ${isSelectedChat ? 'is-selected' : ''}`}
                  >
                    {entry.kind === 'agent' ? <AgentAvatar avatarId={entry.avatarId} size={20} /> : (
                      <span className="collab-tone-avatar grid h-5 w-5 shrink-0 place-items-center rounded-full" data-tone={identityTone(entry.name)}>
                        <Users2 size={11} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    {entry.presence && (
                      <span className="collab-presence-dot" data-state={entry.presence.state} title={AGENT_PRESENCE_META[entry.presence.state].label} />
                    )}
                  </button>
                )
              })
            )}
            {(hiddenChatCount > 0 || showAllChats) && chatTargets.length > 2 && (
              <button
                type="button"
                onClick={() => setShowAllChats((prev) => !prev)}
                className="px-2 py-0.5 text-left text-my-2xs text-my-tertiary hover:text-my-primary"
              >
                {showAllChats ? '收起' : `更多 (${hiddenChatCount})`}
              </button>
            )}
        </DisclosureGrid>
      </section>

      <section aria-label="我的空间" className="collab-nav-section">
        <div className="collab-nav-section-heading">
          <button
            type="button"
            aria-expanded={mySpacesOpen}
            onClick={() => setMySpacesOpen((prev) => !prev)}
            className="collab-nav-collapse-btn"
          >
            <span>我的空间</span>
            <ChevronRight size={12} className="my-disclosure-chevron" data-open={mySpacesOpen || undefined} />
          </button>
          {workspaceContext.canManage && workspaceContext.state !== 'access-revoked' && (
            <button type="button" aria-label="新建空间" title="新建空间" onClick={() => setCreateSpaceOpen(true)}><Plus size={14} /></button>
          )}
        </div>

        <DisclosureGrid open={mySpacesOpen} innerClassName="flex flex-col gap-0.5">
        {spaces.map((space) => {
          const open = expandedSpaceId === space.id
          const enabledModules = resolveSpaceModules(space)
          const starred = favorites.some((fav) => fav.kind === 'space' && fav.id === space.id)
          const triageCount = snapshot.tasks.filter((task) => task.spaceId === space.id && isTriagePending(snapshot, task)).length
          const isTaskSelected = currentSpaceId === space.id && (module === 'tasks' || module === 'board')
          const moreExpanded = Boolean(taskMoreOpen[space.id]) || (currentSpaceId === space.id && ['triage', 'projects', 'analytics'].includes(module))

          return (
            <section key={space.id} data-nav-space={space.id} aria-label={`${space.name}空间`} className="collab-nav-space">
              <div className="collab-nav-space-heading group">
                <button
                  type="button"
                  className="collab-nav-space-toggle"
                  aria-expanded={open}
                  onClick={() => setExpandedSpaceId((previous) => previous === space.id ? null : space.id)}
                >
                  <ChevronRight size={12} className="collab-nav-space-chevron my-disclosure-chevron" data-open={open || undefined} />
                  <span className="collab-nav-space-badge" aria-hidden="true">
                    <FlowIcon name="projects" size={12} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{space.name}</span>
                </button>
                <button
                  type="button"
                  className="collab-nav-space-create opacity-0 group-hover:opacity-100 focus:opacity-100"
                  aria-label={`在${space.name}中新建任务`}
                  title="在此新建任务"
                  onClick={() => { if (space.id !== currentSpaceId) setCurrentSpace(space.id); beginCreateTask({ spaceId: space.id }) }}
                >
                  <Plus size={14} />
                </button>
                <Dropdown
                  align="right"
                  width={176}
                  trigger={({ toggle, open: menuOpen }) => (
                    <button
                      type="button"
                      className={`collab-nav-space-create ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
                      aria-label={`${space.name}更多操作`}
                      aria-expanded={menuOpen}
                      onClick={toggle}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <DropdownHeader>{space.name} · {space.key}</DropdownHeader>
                      <DropdownItem onClick={() => { close(); toggleFavorite('space', space.id, space.id) }}>{starred ? '取消收藏' : '添加到收藏'}</DropdownItem>
                      <DropdownItem onClick={() => { close(); setCurrentSpace(space.id); beginCreateTask({ spaceId: space.id }) }}>在此新建任务</DropdownItem>
                      <DropdownItem onClick={() => { close(); goSpaceModule('projects', space.id) }}>在此管理专项</DropdownItem>
                      <DropdownItem onClick={() => { close(); goSpaceModule('views', space.id) }}>在此管理视图</DropdownItem>
                      <DropdownDivider />
                      <DropdownItem onClick={() => { close(); goSpaceModule('spaces', space.id) }}>空间设置</DropdownItem>
                    </>
                  )}
                </Dropdown>
              </div>

              <DisclosureGrid open={open} innerClassName="collab-nav-space-content">
                  <div className="collab-nav-branch">
                    <button
                      type="button"
                      onClick={() => goSpaceModule('tasks', space.id)}
                      aria-current={isTaskSelected ? 'page' : undefined}
                      className={`collab-nav-item ${isTaskSelected ? 'is-selected' : ''}`}
                    >
                      <FlowIcon name="tasks" size={16} />
                      <span className="min-w-0 flex-1 truncate">任务</span>
                    </button>
                    <div className="collab-nav-children">
                      {enabledModules.iterations && (
                        <button
                          type="button"
                          onClick={() => goSpaceModule('iterations', space.id)}
                          aria-current={currentSpaceId === space.id && module === 'iterations' ? 'page' : undefined}
                          className={`collab-nav-item ${currentSpaceId === space.id && module === 'iterations' ? 'is-selected' : ''}`}
                        >
                          <span className="min-w-0 flex-1 truncate">迭代</span>
                        </button>
                      )}
                      {enabledModules.views && (
                        <button
                          type="button"
                          onClick={() => goSpaceModule('views', space.id)}
                          aria-current={currentSpaceId === space.id && module === 'views' ? 'page' : undefined}
                          className={`collab-nav-item ${currentSpaceId === space.id && module === 'views' ? 'is-selected' : ''}`}
                        >
                          <span className="min-w-0 flex-1 truncate">视图</span>
                        </button>
                      )}
                      <DisclosureGrid open={moreExpanded} innerClassName="flex flex-col gap-0.5">
                          {enabledModules.triage && (
                            <button
                              type="button"
                              onClick={() => goSpaceModule('triage', space.id)}
                              aria-current={currentSpaceId === space.id && module === 'triage' ? 'page' : undefined}
                              className={`collab-nav-item ${currentSpaceId === space.id && module === 'triage' ? 'is-selected' : ''}`}
                            >
                              <span className="min-w-0 flex-1 truncate">分拣台</span>
                              {triageCount > 0 && <span className="collab-stat text-my-2xs text-my-tertiary">{triageCount}</span>}
                            </button>
                          )}
                          {enabledModules.projects && (
                            <button
                              type="button"
                              onClick={() => goSpaceModule('projects', space.id)}
                              aria-current={currentSpaceId === space.id && module === 'projects' ? 'page' : undefined}
                              className={`collab-nav-item ${currentSpaceId === space.id && module === 'projects' ? 'is-selected' : ''}`}
                            >
                              <span className="min-w-0 flex-1 truncate">专项</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => goSpaceModule('analytics', space.id)}
                            aria-current={currentSpaceId === space.id && module === 'analytics' ? 'page' : undefined}
                            className={`collab-nav-item ${currentSpaceId === space.id && module === 'analytics' ? 'is-selected' : ''}`}
                          >
                            <span className="min-w-0 flex-1 truncate">统计分析</span>
                          </button>
                      </DisclosureGrid>
                      <button
                        type="button"
                        aria-expanded={moreExpanded}
                        onClick={() => setTaskMoreOpen((prev) => ({ ...prev, [space.id]: !moreExpanded }))}
                        className="collab-nav-item text-my-tertiary"
                      >
                        <span className="min-w-0 flex-1 truncate">{moreExpanded ? '收起' : '更多...'}</span>
                        {!moreExpanded && triageCount > 0 && <span className="collab-stat text-my-2xs text-my-tertiary">{triageCount}</span>}
                      </button>
                    </div>
                  </div>

                  {enabledModules.agents && (
                    <button
                      type="button"
                      onClick={() => goSpaceModule('agents', space.id)}
                      aria-current={currentSpaceId === space.id && (module === 'agents' || module === 'crews') ? 'page' : undefined}
                      className={`collab-nav-item ${currentSpaceId === space.id && (module === 'agents' || module === 'crews') ? 'is-selected' : ''}`}
                    >
                      <FlowIcon name="agents" size={16} />
                      <span className="min-w-0 flex-1 truncate">Agents</span>
                    </button>
                  )}

                  {enabledModules.automations && (
                    <button
                      type="button"
                      onClick={() => goSpaceModule('automations', space.id)}
                      aria-current={currentSpaceId === space.id && module === 'automations' ? 'page' : undefined}
                      className={`collab-nav-item ${currentSpaceId === space.id && module === 'automations' ? 'is-selected' : ''}`}
                    >
                      <FlowIcon name="automations" size={16} />
                      <span className="min-w-0 flex-1 truncate">Agent 自动化</span>
                    </button>
                  )}

                  {enabledModules.docs && (
                    <button
                      type="button"
                      onClick={() => goSpaceModule('creations', space.id)}
                      aria-current={currentSpaceId === space.id && module === 'creations' ? 'page' : undefined}
                      className={`collab-nav-item ${currentSpaceId === space.id && module === 'creations' ? 'is-selected' : ''}`}
                    >
                      <FlowIcon name="reports" size={16} />
                      <span className="min-w-0 flex-1 truncate">文档库</span>
                    </button>
                  )}

                  {enabledModules.skills && (
                    <button
                      type="button"
                      onClick={() => goSpaceModule('skills', space.id)}
                      aria-current={currentSpaceId === space.id && module === 'skills' ? 'page' : undefined}
                      className={`collab-nav-item ${currentSpaceId === space.id && module === 'skills' ? 'is-selected' : ''}`}
                    >
                      <FlowIcon name="skills" size={16} />
                      <span className="min-w-0 flex-1 truncate">技能</span>
                    </button>
                  )}

                  <Dropdown
                    align="left"
                    width={184}
                    trigger={({ toggle, open: moreMenuOpen }) => (
                      <button
                        type="button"
                        onClick={toggle}
                        aria-expanded={moreMenuOpen}
                        className={`collab-nav-item ${currentSpaceId === space.id && ['spaces', 'task-types', 'task-statuses', 'task-labels'].includes(module) ? 'is-selected' : 'text-my-tertiary'}`}
                      >
                        <MoreHorizontal size={16} />
                        <span className="min-w-0 flex-1 truncate">更多</span>
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        <DropdownItem onClick={() => { close(); goSpaceModule('spaces', space.id) }}>空间设置</DropdownItem>
                        <DropdownItem onClick={() => { close(); goSpaceModule('task-types', space.id) }}>任务类型 & 工作流</DropdownItem>
                        <DropdownItem onClick={() => { close(); goSpaceModule('task-statuses', space.id) }}>任务状态</DropdownItem>
                        <DropdownItem onClick={() => { close(); goSpaceModule('task-labels', space.id) }}>任务标签</DropdownItem>
                      </>
                    )}
                  </Dropdown>
              </DisclosureGrid>
            </section>
          )
        })}
        {spaces.length === 0 && (
          <button type="button" className="collab-nav-item" onClick={() => setModule('spaces')}>
            <FlowIcon name="spaces" size={17} />
            <span>浏览与加入空间</span>
          </button>
        )}
        </DisclosureGrid>
      </section>

      <section ref={orgSectionRef} aria-label="组织" className="collab-nav-section">
        <button
          type="button"
          aria-expanded={orgOpen}
          onClick={() => {
            const next = !orgOpen
            setOrgOpen(next)
            if (next) {
              requestAnimationFrame(() => {
                orgSectionRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
              })
            }
          }}
          className="collab-nav-section-heading w-full justify-start gap-1 text-left hover:text-my-primary"
        >
          <span>组织</span>
          <ChevronRight size={11} className="my-disclosure-chevron" data-open={orgOpen || undefined} />
        </button>
        <DisclosureGrid open={orgOpen} innerClassName="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => setModule('runtimes')}
              aria-current={module === 'runtimes' ? 'page' : undefined}
              className={`collab-nav-item ${module === 'runtimes' ? 'is-selected' : ''}`}
            >
              <FlowIcon name="automations" size={16} />
              <span className="min-w-0 flex-1 truncate">机器与 Runtime</span>
              {activeRunCount > 0 && <span className="collab-stat text-my-2xs text-my-tertiary">{activeRunCount}</span>}
            </button>
            <button
              type="button"
              onClick={() => setModule('members')}
              aria-current={module === 'members' ? 'page' : undefined}
              className={`collab-nav-item ${module === 'members' ? 'is-selected' : ''}`}
            >
              <FlowIcon name="members" size={16} />
              <span className="min-w-0 flex-1 truncate">成员</span>
            </button>
            <button
              type="button"
              onClick={() => setModule('spaces')}
              aria-current={module === 'spaces' ? 'page' : undefined}
              className={`collab-nav-item ${module === 'spaces' ? 'is-selected' : ''}`}
            >
              <FlowIcon name="spaces" size={16} />
              <span className="min-w-0 flex-1 truncate">设置</span>
            </button>
        </DisclosureGrid>
      </section>
    </nav>

    <GetStartedWidget variant="sidebar" />

    <Modal open={createSpaceOpen} onClose={() => setCreateSpaceOpen(false)} width={760} ariaLabel="新建空间">
      <SpaceSetupWizard
        mode="create"
        organizationName={workspaceContext.projectName}
        onCancel={() => setCreateSpaceOpen(false)}
        onComplete={(spaceId) => {
          setCurrentSpace(spaceId)
          setModule('tasks')
          setCreateSpaceOpen(false)
        }}
      />
    </Modal>
  </>
}
