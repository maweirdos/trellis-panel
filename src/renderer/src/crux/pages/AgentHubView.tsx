import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode, type UIEvent } from 'react'
import {
  Archive, AtSign, Bot, ChevronDown, ChevronRight, Copy, Cpu, FileText,
  FolderGit2, GitBranch, Globe, History, Lock, Maximize2, MessageCircle,
  Minimize2, Monitor, MoreHorizontal, PauseCircle, PlayCircle, Plug, Plus,
  RefreshCw, RotateCcw, Search, Share2, ShieldCheck, ShoppingBag, Sparkles,
  Star, Trash2, Users2, Wifi, Workflow, Wrench, X, Zap
} from 'lucide-react'
import type { CruxAgent, CruxAgentInput, CruxCrew, CruxRuntimeKind, CruxWorkingDirectoryMode } from '@shared/crux'
import type { AcpAgentStatus, GatewayStatus, KbMcpStatus } from '../../../../shared/types'
import { api, hasIpc } from '../../api'
import { runtimeHealthLabel } from '../../acp/runtime-status'
import { ensureRuntimeInventoryLoaded, getRuntimeInventorySnapshot, subscribeRuntimeInventory } from '../../acp/useRuntimeInventoryRefresh'
import { ToolBrandIcon } from '../../components/ToolBrandIcon'
import { Button, EmptyState, Switch } from '../../my/ui'
import { useApp } from '../../store'
import { ActionMenu } from '../ActionMenu'
import { useAgentChatBridge } from '../agent-chat-bridge'
import { AppBrandIcon, inferAppBrandFromName, type AppBrandId } from '../AppBrandIcon'
import { identityTone } from '../identity-tone'
import {
  useCollaborationPlatform,
  type AgentApprovalMode,
  type AgentCollabMode,
  type GitAuthorMode,
  type IsolationMode
} from '../collaboration-platform-store'
import { FlowIcon } from '../icons'
import {
  matchDetectedRuntime,
  MODEL_PRESET_OPTIONS,
  resolveRuntimeBrandId,
  resolveRuntimeDisplayName,
  useLocalExecutionSlot,
  WORKDIR_MODE_OPTIONS
} from '../local-execution-slot'
import { RuntimePicker } from '../RuntimePicker'
import { statusOf, useCrux } from '../store'
import { AGENT_PRESENCE_META, computeAgentPresence, RUN_STATUS_META, useTaskRuns } from '../task-run-store'
import { inputClass, MemberChip, Select, StatusBadge, textareaClass } from '../ui'
import { AssignTaskModal, CreateAgentModal, CreateCrewModal } from './AgentModals'

type FilterPill = 'all' | 'agent' | 'crew' | 'mine'
type DrawerTab = 'settings' | 'history' | 'tasks'
type AccordionSectionId =
  | 'instructions'
  | 'triggers'
  | 'mcp'
  | 'runtime'
  | 'git'
  | 'skills'
  | 'automations'

type DrawerSelection =
  | { kind: 'agent'; id: string }
  | { kind: 'crew'; id: string }
  | null

const SECTION_NAV_ITEMS: ReadonlyArray<{ id: AccordionSectionId; shortLabel: string }> = [
  { id: 'instructions', shortLabel: '指令' },
  { id: 'triggers', shortLabel: '触发器与消息' },
  { id: 'mcp', shortLabel: '工具·知识库·MCP' },
  { id: 'runtime', shortLabel: '机器、Runtime 与工作目录' },
  { id: 'git', shortLabel: 'Git 仓库' },
  { id: 'skills', shortLabel: '技能' },
  { id: 'automations', shortLabel: '自动化' }
]

const IM_PLATFORMS: ReadonlyArray<{ id: AppBrandId; label: string }> = [
  { id: 'feishu', label: '飞书' },
  { id: 'dingtalk', label: '钉钉' },
  { id: 'wecom', label: '企业微信' },
  { id: 'wechat', label: '微信' },
  { id: 'slack', label: 'Slack' }
]

function buildAgentInput(agent: CruxAgent): CruxAgentInput & { id: string } {
  return {
    id: agent.id,
    spaceId: agent.spaceId,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    skillIds: agent.skillIds,
    repositories: agent.repositories,
    runtimeKind: agent.runtimeKind,
    workingDirectory: agent.workingDirectory,
    enabled: agent.enabled,
    archived: agent.archived
  }
}

/**
 * HiFox 风格「全部 Agent 和小队 / 空间 Agents」主从双栏视图：
 * - 容器查询自适应单/双列 + 悬停渐变浮层，绝不挤压文字
 * - 统一公共 ActionMenu（固定图标槽位、纯净透明底危险项）
 * - 零抖动就地单字段编辑（同高同 1px 透明边框，点击周边 0px 位移）
 * - 真实引擎图标分组 RuntimePicker（切换即实时同步对应官方品牌图标）
 */
export function AgentHubView({ scope }: { scope: 'all' | 'space' }): JSX.Element | null {
  const { snapshot, currentSpaceId, workspaceContext, busy, run, setCurrentSpace, setModule, openTask, beginCreateTask } = useCrux()
  const inspectAgentId = useAgentChatBridge((s) => s.inspectAgentId)
  const setInspectAgentId = useAgentChatBridge((s) => s.setInspectAgentId)
  const runs = useTaskRuns((s) => s.runs)
  const enqueueRun = useTaskRuns((s) => s.enqueueRun)
  const stopRun = useTaskRuns((s) => s.stopRun)
  const rerun = useTaskRuns((s) => s.rerun)
  const resolveAgentSlot = useLocalExecutionSlot((s) => s.resolveAgentSlot)
  const setAgentSlotOverride = useLocalExecutionSlot((s) => s.setAgentOverride)
  const {
    favorites,
    toggleFavorite,
    customRuntimes,
    runtimeLaunchConfigs,
    setRuntimeLaunchConfig,
    getAgentMeta,
    updateAgentMeta,
    recordAgentInstructionVersion,
    getCrewQuickReplies,
    setCrewQuickReplies
  } = useCollaborationPlatform()

  const [detectedRuntimes, setDetectedRuntimes] = useState<AcpAgentStatus[]>(getRuntimeInventorySnapshot)
  const [pill, setPill] = useState<FilterPill>('all')
  const [searchOpen, setSearchOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [collapsedSpaces, setCollapsedSpaces] = useState<Record<string, boolean>>({})
  const [selection, setSelection] = useState<DrawerSelection>(null)
  const [drawerExpanded, setDrawerExpanded] = useState(false)
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('settings')

  const [createAgentOpen, setCreateAgentOpen] = useState(false)
  const [createCrewOpen, setCreateCrewOpen] = useState(false)
  const [assignTarget, setAssignTarget] = useState<{ kind: 'agent' | 'crew'; id: string; name: string; spaceId: string; runtimeKind: CruxRuntimeKind; workingDirectory: CruxWorkingDirectoryMode } | null>(null)

  useEffect(() => {
    const unsubscribe = subscribeRuntimeInventory(setDetectedRuntimes)
    void ensureRuntimeInventoryLoaded()
    return unsubscribe
  }, [])

  const spaceList = useMemo(() => {
    if (!snapshot) return []
    if (scope === 'space') return snapshot.spaces.filter((sp) => sp.id === currentSpaceId)
    return snapshot.spaces.filter((sp) => !sp.archived)
  }, [snapshot, scope, currentSpaceId])

  useEffect(() => {
    if (!inspectAgentId || !snapshot) return
    const target = snapshot.agents.find((a) => a.id === inspectAgentId)
    if (target) {
      setSelection({ kind: 'agent', id: target.id })
      setDrawerTab('settings')
    }
    setInspectAgentId(null)
  }, [inspectAgentId, snapshot, setInspectAgentId])

  useEffect(() => {
    if (!snapshot || selection !== null || inspectAgentId) return
    const firstSpaceId = scope === 'space' ? currentSpaceId : spaceList[0]?.id
    const firstAgent = snapshot.agents.find((a) => !a.archived && (!firstSpaceId || a.spaceId === firstSpaceId))
    if (firstAgent) setSelection({ kind: 'agent', id: firstAgent.id })
  }, [snapshot, scope, currentSpaceId, spaceList, selection, inspectAgentId])

  if (!snapshot) return null

  const machineName = workspaceContext.state === 'local' ? '本机工作台' : (workspaceContext.projectName ?? '团队机器')
  const searchLower = keyword.trim().toLowerCase()

  const groups = spaceList
    .map((space) => {
      const spaceAgents = snapshot.agents.filter((agent) => {
        if (agent.spaceId !== space.id) return false
        if (Boolean(agent.archived) !== showArchived) return false
        if (pill === 'crew') return false
        if (pill === 'mine' && getAgentMeta(agent.id).visibility !== 'personal') return false
        if (searchLower && !`${agent.name} ${agent.description ?? ''}`.toLowerCase().includes(searchLower)) return false
        return true
      })
      const spaceCrews = snapshot.crews.filter((crew) => {
        if (crew.spaceId !== space.id) return false
        if (Boolean(crew.archived) !== showArchived) return false
        if (pill === 'agent' || pill === 'mine') return false
        if (searchLower && !`${crew.name} ${crew.description ?? ''}`.toLowerCase().includes(searchLower)) return false
        return true
      })
      return { space, agents: spaceAgents, crews: spaceCrews, total: spaceAgents.length + spaceCrews.length }
    })
    .filter((group) => group.total > 0 || scope === 'space')

  const archivedCount = snapshot.agents.filter((a) => a.archived && (scope === 'all' || a.spaceId === currentSpaceId)).length
    + snapshot.crews.filter((c) => c.archived && (scope === 'all' || c.spaceId === currentSpaceId)).length

  const selectedAgent = selection?.kind === 'agent' ? snapshot.agents.find((a) => a.id === selection.id) : undefined
  const selectedCrew = selection?.kind === 'crew' ? snapshot.crews.find((c) => c.id === selection.id) : undefined
  const drawerOpen = Boolean(selectedAgent || selectedCrew)

  const selectEntity = (next: DrawerSelection, targetTab: DrawerTab = 'settings'): void => {
    setSelection(next)
    if (next) setDrawerTab(targetTab)
  }

  const duplicateAgent = async (agent: CruxAgent): Promise<void> => {
    if (busy) return
    const res = await run(`克隆 ${agent.name}`, () => api.crux.saveAgent({
      spaceId: agent.spaceId,
      name: `${agent.name} 副本`,
      description: agent.description,
      instructions: agent.instructions,
      skillIds: [...agent.skillIds],
      repositories: agent.repositories.map((r) => ({ ...r })),
      runtimeKind: agent.runtimeKind,
      workingDirectory: agent.workingDirectory,
      enabled: true,
      archived: false
    }))
    if (res?.ok) {
      const created = [...res.data.agents].reverse().find((item) => item.spaceId === agent.spaceId && item.name === `${agent.name} 副本`)
      if (created) {
        updateAgentMeta(created.id, { ...getAgentMeta(agent.id) })
        selectEntity({ kind: 'agent', id: created.id })
      }
    }
  }

  const toggleAgentEnabled = async (agent: CruxAgent): Promise<void> => {
    if (busy) return
    await run(agent.enabled ? '停用 Agent' : '启用 Agent', () => api.crux.saveAgent({ ...buildAgentInput(agent), enabled: !agent.enabled }))
  }

  const toggleAgentArchived = async (agent: CruxAgent): Promise<void> => {
    if (busy) return
    await run(agent.archived ? '恢复 Agent' : '归档 Agent', () => api.crux.saveAgent({
      ...buildAgentInput(agent),
      archived: !agent.archived,
      enabled: agent.archived ? true : false
    }))
  }

  const delegateExistingTask = async (
    taskId: string,
    executor: { kind: 'agent' | 'crew'; id: string; name: string },
    runtimeKind: CruxRuntimeKind,
    workingDirectory: CruxWorkingDirectoryMode
  ): Promise<void> => {
    const task = snapshot.tasks.find((t) => t.id === taskId)
    if (!task || busy) return
    const res = await run(`指派给 ${executor.name}`, () => api.crux.updateTask({
      id: task.id,
      patch: { executor }
    }))
    if (res?.ok) {
      const matched = matchDetectedRuntime(detectedRuntimes, runtimeKind)
      const runtimeReady = Boolean(matched ? matched.available && !matched.setupRequired : true)
      enqueueRun({
        taskId: task.id,
        spaceId: task.spaceId,
        executorKind: executor.kind,
        executorId: executor.id,
        executorName: executor.name,
        runtimeKind,
        model: 'follow-runtime',
        workingDirectory,
        isolationMode: executor.kind === 'agent' ? getAgentMeta(executor.id).isolationMode : 'worktree',
        triggerSource: 'delegate',
        prompt: `请处理任务 ${task.id}：${task.title}`,
        runtimeReady
      })
    }
  }

  const targetSpaceId = currentSpaceId ?? spaceList[0]?.id ?? snapshot.spaces[0]?.id

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      {/* 左侧主目录区 */}
      <div className="collab-canvas-surface collab-agent-list-canvas collab-scroll flex min-h-0 min-w-0 flex-1 flex-col gap-4 px-6 py-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-my-lg font-semibold text-my-primary">
              {showArchived
                ? '已归档 Agent 和小队'
                : scope === 'all'
                  ? '全部 Agent 和小队'
                  : `${spaceList[0]?.name ?? '空间'} · Agents`}
            </h1>
            {showArchived && (
              <Button size="sm" variant="ghost" onClick={() => setShowArchived(false)}>
                返回活跃列表
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ActionMenu
              width={204}
              ariaLabel="更多页面操作"
              trigger={({ toggle, open }) => (
                <Button size="sm" variant="ghost" aria-label="更多操作" aria-expanded={open} onClick={toggle}>
                  <MoreHorizontal size={16} />
                </Button>
              )}
              items={[
                {
                  kind: 'item',
                  id: 'archived',
                  label: showArchived ? '返回活跃 Agent' : `查看已归档 (${archivedCount})`,
                  icon: <Archive size={14} />,
                  onSelect: () => setShowArchived((v) => !v)
                },
                {
                  kind: 'item',
                  id: 'marketplace',
                  label: '从市场浏览 Agent 模板',
                  icon: <ShoppingBag size={14} />,
                  onSelect: () => setModule('marketplace')
                },
                { kind: 'divider', id: 'div-1' },
                {
                  kind: 'item',
                  id: 'runtimes',
                  label: '机器与 Runtime 设置',
                  icon: <Cpu size={14} />,
                  onSelect: () => setModule('runtimes')
                }
              ]}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!targetSpaceId}
              onClick={() => setCreateCrewOpen(true)}
            >
              <Plus size={14} />创建小队
            </Button>
            <Button
              size="sm"
              variant={drawerOpen ? 'outline' : 'primary'}
              disabled={!targetSpaceId}
              onClick={() => setCreateAgentOpen(true)}
            >
              <Plus size={14} />创建 Agent
            </Button>
          </div>
        </header>

        {/* 胶囊筛选栏 + 搜索 */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex flex-wrap items-center gap-0.5 rounded-full bg-my-layer-2 p-0.5" role="tablist" aria-label="筛选类型">
            {([
              ['all', '全部'],
              ['agent', 'Agent'],
              ['crew', '小队'],
              ['mine', '我的']
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={pill === id}
                onClick={() => setPill(id)}
                className="collab-filter-pill"
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {searchOpen && (
              <input
                autoFocus
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索 Agent 或小队..."
                aria-label="搜索 Agent 或小队"
                className={`${inputClass} w-52`}
              />
            )}
            <button
              type="button"
              aria-label={searchOpen ? '收起搜索' : '搜索 Agent 或小队'}
              onClick={() => {
                if (searchOpen && keyword) setKeyword('')
                setSearchOpen((prev) => !prev)
              }}
              className="grid h-8 w-8 place-items-center rounded-full border border-my-line bg-my-panel text-my-icon-secondary transition-colors hover:border-my-line-strong hover:text-my-primary"
            >
              {searchOpen && keyword ? <X size={14} /> : <Search size={14} />}
            </button>
          </div>
        </div>

        {/* 空间分组列表 */}
        {groups.every((g) => g.total === 0) ? (
          <div className="flex flex-1 flex-col items-center justify-center py-12">
            <EmptyState
              title={keyword ? '没有符合当前筛选条件的结果' : '还没有 Agent'}
              description="创建一个 Agent，像给同事指派任务那样把工作交给它。本地 Agent 直接在你连接的机器上执行。"
            />
            {!keyword && targetSpaceId && (
              <div className="-mt-4 flex items-center gap-2">
                <Button size="sm" variant="primary" onClick={() => setCreateAgentOpen(true)}>
                  <Plus size={14} />创建第一个 Agent
                </Button>
                <Button size="sm" variant="outline" onClick={() => setModule('marketplace')}>
                  <Sparkles size={14} />浏览模板市场
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map(({ space, agents, crews, total }) => {
              const collapsed = Boolean(collapsedSpaces[space.id])
              return (
                <section key={space.id} className="flex flex-col gap-2.5">
                  <button
                    type="button"
                    onClick={() => setCollapsedSpaces((prev) => ({ ...prev, [space.id]: !collapsed }))}
                    className="inline-flex w-fit items-center gap-1.5 text-my-xs font-medium text-my-secondary hover:text-my-primary"
                  >
                    <span>{space.name}</span>
                    <span className="tabular-nums text-my-tertiary">{total}</span>
                    {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  </button>

                  {!collapsed && (
                    <div className="collab-agent-grid">
                      {agents.map((agent) => {
                        const meta = getAgentMeta(agent.id)
                        const slot = resolveAgentSlot(agent.id, { runtimeKind: agent.runtimeKind, workingDirectory: agent.workingDirectory }).slot
                        const brandId = resolveRuntimeBrandId(slot)
                        const runtimeLabel = slot.model === 'follow-runtime'
                          ? resolveRuntimeDisplayName(slot, detectedRuntimes)
                          : slot.model
                        const presence = computeAgentPresence(agent.id, runs, agent.enabled && !agent.archived)
                        const isSelected = selection?.kind === 'agent' && selection.id === agent.id
                        const isStarred = favorites.some((f) => f.kind === 'agent' && f.id === agent.id)
                        const distinctRole = agent.description && agent.description.trim() !== agent.name.trim() ? agent.description.trim() : ''

                        return (
                          <div
                            key={agent.id}
                            role="button"
                            tabIndex={0}
                            data-selected={isSelected || undefined}
                            onClick={() => selectEntity({ kind: 'agent', id: agent.id })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                selectEntity({ kind: 'agent', id: agent.id })
                              }
                            }}
                            className="collab-agent-card collab-elevated-card flex cursor-pointer items-center gap-3.5 rounded-my-base px-4 py-3.5 text-left"
                          >
                            <span
                              className="collab-tone-avatar relative grid h-10 w-10 shrink-0 place-items-center rounded-full"
                              data-tone={identityTone(agent.name)}
                            >
                              <Bot size={20} />
                              <span
                                className="collab-presence-dot absolute right-0 bottom-0 ring-2 ring-[var(--my-bg-panel)]"
                                data-state={presence.state}
                              />
                            </span>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-my-sm font-semibold text-my-primary">{agent.name}</span>
                                {distinctRole && (
                                  <span className="truncate text-my-xs text-my-tertiary">- {distinctRole}</span>
                                )}
                                {!agent.enabled && <span className="my-chip shrink-0">已停用</span>}
                              </div>
                              <div className="mt-1 flex items-center gap-1.5 overflow-hidden text-my-2xs text-my-tertiary">
                                <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
                                  {meta.visibility === 'personal' ? <Lock size={11} /> : <Globe size={11} />}
                                  <span>{meta.visibility === 'personal' ? '私有' : '公开'}</span>
                                </span>
                                <span className="shrink-0">·</span>
                                <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-my-secondary">
                                  <ToolBrandIcon brand={brandId} size={13} />
                                  <span>{runtimeLabel}</span>
                                </span>
                                <span className="shrink-0">·</span>
                                <span className="truncate whitespace-nowrap">{machineName}</span>
                                {presence.queuedCount > 0 && (
                                  <span className="shrink-0 rounded-full bg-my-info-subtle px-1.5 py-0.5 tabular-nums text-my-info-text">
                                    排队 {presence.queuedCount}
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* 悬停右侧渐变浮层：公共 ActionMenu + 收藏 + 对话 */}
                            <div
                              className="collab-card-hover-actions"
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!agent.enabled || agent.archived}
                                onClick={() => useAgentChatBridge.getState().startAgentChat(agent.id, { runtimeKind: slot.runtimeKind, workingDirectory: slot.workingDirectory })}
                              >
                                <MessageCircle size={13} />对话
                              </Button>
                              <button
                                type="button"
                                aria-label={isStarred ? '取消收藏' : '收藏 Agent'}
                                onClick={() => toggleFavorite('agent', agent.id, agent.spaceId)}
                                className="grid h-7 w-7 place-items-center rounded-my-base text-my-icon-secondary hover:bg-my-layer-1 hover:text-my-primary"
                              >
                                <Star size={14} className={isStarred ? 'fill-current text-my-warning-text' : ''} />
                              </button>
                              <ActionMenu
                                width={168}
                                ariaLabel={`${agent.name} 的更多操作`}
                                items={[
                                  {
                                    kind: 'item',
                                    id: 'history',
                                    label: '查看运行历史',
                                    icon: <History size={14} />,
                                    onSelect: () => selectEntity({ kind: 'agent', id: agent.id }, 'history')
                                  },
                                  {
                                    kind: 'item',
                                    id: 'clone',
                                    label: '克隆',
                                    icon: <Copy size={14} />,
                                    onSelect: () => void duplicateAgent(agent)
                                  },
                                  {
                                    kind: 'item',
                                    id: 'toggle',
                                    label: agent.enabled ? '停用' : '启用',
                                    icon: agent.enabled ? <PauseCircle size={14} /> : <PlayCircle size={14} />,
                                    onSelect: () => void toggleAgentEnabled(agent)
                                  },
                                  { kind: 'divider', id: 'div-archive' },
                                  {
                                    kind: 'item',
                                    id: 'archive',
                                    label: agent.archived ? '恢复' : '归档',
                                    danger: !agent.archived,
                                    icon: agent.archived ? <RotateCcw size={14} /> : <Archive size={14} />,
                                    onSelect: () => void toggleAgentArchived(agent)
                                  }
                                ]}
                              />
                            </div>
                          </div>
                        )
                      })}

                      {crews.map((crew) => {
                        const isSelected = selection?.kind === 'crew' && selection.id === crew.id
                        const chatAgent = [crew.captain, ...crew.members]
                          .filter((r) => r.kind === 'agent')
                          .map((r) => snapshot.agents.find((a) => a.id === r.id && a.enabled && !a.archived))
                          .find((a): a is CruxAgent => Boolean(a))

                        return (
                          <div
                            key={crew.id}
                            role="button"
                            tabIndex={0}
                            data-selected={isSelected || undefined}
                            onClick={() => selectEntity({ kind: 'crew', id: crew.id })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                selectEntity({ kind: 'crew', id: crew.id })
                              }
                            }}
                            className="collab-agent-card collab-elevated-card flex cursor-pointer items-center gap-3.5 rounded-my-base px-4 py-3.5 text-left"
                          >
                            <span
                              className="collab-tone-avatar grid h-10 w-10 shrink-0 place-items-center rounded-full"
                              data-tone={identityTone(crew.name)}
                            >
                              <Users2 size={19} />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-my-sm font-semibold text-my-primary">{crew.name}</span>
                                <span className="my-chip shrink-0">小队</span>
                              </div>
                              <div className="mt-1 flex items-center gap-1.5 overflow-hidden text-my-2xs text-my-tertiary">
                                <span className="shrink-0 whitespace-nowrap">队长 {crew.captain.name}</span>
                                <span className="shrink-0">·</span>
                                <span className="shrink-0 whitespace-nowrap tabular-nums">{crew.members.length + 1} 名成员</span>
                                {crew.description && <span className="truncate whitespace-nowrap">· {crew.description}</span>}
                              </div>
                            </div>
                            <div
                              className="collab-card-hover-actions"
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              {chatAgent && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => useAgentChatBridge.getState().startAgentChat(chatAgent.id, { runtimeKind: chatAgent.runtimeKind, workingDirectory: chatAgent.workingDirectory })}
                                >
                                  <MessageCircle size={13} />对话
                                </Button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>

      {/* 右侧详情抽屉 */}
      {drawerOpen && (
        <aside
          aria-label="Agent 与小队设置抽屉"
          className={`flex h-full shrink-0 flex-col border-l border-my-line bg-my-sidebar transition-all ${
            drawerExpanded ? 'w-[580px] max-w-full' : 'w-[430px] xl:w-[460px] max-w-full'
          }`}
        >
          {selectedAgent && (
            <AgentInspectorDrawer
              key={selectedAgent.id}
              agent={selectedAgent}
              machineName={machineName}
              detectedRuntimes={detectedRuntimes}
              expanded={drawerExpanded}
              onToggleExpand={() => setDrawerExpanded((v) => !v)}
              onClose={() => selectEntity(null)}
              tab={drawerTab}
              onTabChange={setDrawerTab}
              starred={favorites.some((f) => f.kind === 'agent' && f.id === selectedAgent.id)}
              onToggleStar={() => toggleFavorite('agent', selectedAgent.id, selectedAgent.spaceId)}
              onDuplicate={() => void duplicateAgent(selectedAgent)}
              onOpenAssignModal={() => {
                const activeSlot = resolveAgentSlot(selectedAgent.id, { runtimeKind: selectedAgent.runtimeKind, workingDirectory: selectedAgent.workingDirectory }).slot
                setAssignTarget({
                  kind: 'agent',
                  id: selectedAgent.id,
                  name: selectedAgent.name,
                  spaceId: selectedAgent.spaceId,
                  runtimeKind: activeSlot.runtimeKind,
                  workingDirectory: activeSlot.workingDirectory
                })
              }}
              onOpenTask={openTask}
              customRuntimes={customRuntimes}
              runtimeLaunchConfigs={runtimeLaunchConfigs}
              setRuntimeLaunchConfig={setRuntimeLaunchConfig}
              setAgentSlotOverride={setAgentSlotOverride}
              recordAgentInstructionVersion={recordAgentInstructionVersion}
              stopRun={(runId) => { stopRun(runId) }}
              rerun={(runId) => { rerun(runId, true) }}
            />
          )}

          {selectedCrew && (
            <CrewInspectorDrawer
              key={selectedCrew.id}
              crew={selectedCrew}
              expanded={drawerExpanded}
              onToggleExpand={() => setDrawerExpanded((v) => !v)}
              onClose={() => selectEntity(null)}
              onSelectAgent={(agentId) => selectEntity({ kind: 'agent', id: agentId })}
              onOpenAssignModal={() => setAssignTarget({
                kind: 'crew',
                id: selectedCrew.id,
                name: selectedCrew.name,
                spaceId: selectedCrew.spaceId,
                runtimeKind: 'codex',
                workingDirectory: 'repo'
              })}
              onOpenTask={openTask}
              quickReplies={getCrewQuickReplies(selectedCrew.id)}
              onSaveQuickReplies={(replies) => setCrewQuickReplies(selectedCrew.id, replies)}
            />
          )}
        </aside>
      )}

      {targetSpaceId && (
        <CreateAgentModal
          open={createAgentOpen}
          defaultSpaceId={targetSpaceId}
          detectedRuntimes={detectedRuntimes}
          machineName={machineName}
          onClose={() => setCreateAgentOpen(false)}
          onCreated={(agentId) => {
            setCreateAgentOpen(false)
            selectEntity({ kind: 'agent', id: agentId })
          }}
        />
      )}

      {targetSpaceId && (
        <CreateCrewModal
          open={createCrewOpen}
          defaultSpaceId={targetSpaceId}
          onClose={() => setCreateCrewOpen(false)}
          onCreated={(crewId) => {
            setCreateCrewOpen(false)
            selectEntity({ kind: 'crew', id: crewId })
          }}
        />
      )}

      <AssignTaskModal
        open={Boolean(assignTarget)}
        target={assignTarget}
        onClose={() => setAssignTarget(null)}
        onCreateNewTask={() => {
          if (!assignTarget) return
          setCurrentSpace(assignTarget.spaceId)
          beginCreateTask({ spaceId: assignTarget.spaceId })
        }}
        onDelegateTask={(taskId) => {
          if (!assignTarget) return
          void delegateExistingTask(
            taskId,
            { kind: assignTarget.kind, id: assignTarget.id, name: assignTarget.name },
            assignTarget.runtimeKind,
            assignTarget.workingDirectory
          )
        }}
      />
    </div>
  )
}

function AgentInspectorDrawer({
  agent,
  machineName,
  detectedRuntimes,
  expanded,
  onToggleExpand,
  onClose,
  tab,
  onTabChange,
  starred,
  onToggleStar,
  onDuplicate,
  onOpenAssignModal,
  onOpenTask,
  customRuntimes,
  runtimeLaunchConfigs,
  setRuntimeLaunchConfig,
  setAgentSlotOverride,
  recordAgentInstructionVersion,
  stopRun,
  rerun
}: {
  agent: CruxAgent
  machineName: string
  detectedRuntimes: AcpAgentStatus[]
  expanded: boolean
  onToggleExpand: () => void
  onClose: () => void
  tab: DrawerTab
  onTabChange: (tab: DrawerTab) => void
  starred: boolean
  onToggleStar: () => void
  onDuplicate: () => void
  onOpenAssignModal: () => void
  onOpenTask: (taskId: string) => void
  customRuntimes: ReturnType<typeof useCollaborationPlatform.getState>['customRuntimes']
  runtimeLaunchConfigs: ReturnType<typeof useCollaborationPlatform.getState>['runtimeLaunchConfigs']
  setRuntimeLaunchConfig: ReturnType<typeof useCollaborationPlatform.getState>['setRuntimeLaunchConfig']
  setAgentSlotOverride: ReturnType<typeof useLocalExecutionSlot.getState>['setAgentOverride']
  recordAgentInstructionVersion: ReturnType<typeof useCollaborationPlatform.getState>['recordAgentInstructionVersion']
  stopRun: (runId: string) => void
  rerun: (runId: string) => void
}): JSX.Element | null {
  const { snapshot, busy, run, setCurrentSpace, setModule } = useCrux()
  const runs = useTaskRuns((s) => s.runs)
  const resolveAgentSlot = useLocalExecutionSlot((s) => s.resolveAgentSlot)
  const meta = useCollaborationPlatform((s) => s.getAgentMeta(agent.id))
  const updateAgentMeta = useCollaborationPlatform((s) => s.updateAgentMeta)

  const scrollBodyRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Partial<Record<AccordionSectionId, HTMLDivElement | null>>>({})
  const [stickyVisible, setStickyVisible] = useState(false)
  const [activeAnchor, setActiveAnchor] = useState<AccordionSectionId>('instructions')
  const [openSections, setOpenSections] = useState<Partial<Record<AccordionSectionId, boolean>>>({})

  // 零抖动就地单字段编辑
  const [editingField, setEditingField] = useState<'name' | 'role' | 'bio' | null>(null)
  const [fieldDraft, setFieldDraft] = useState('')

  const [instDraft, setInstDraft] = useState(agent.instructions)
  const [addingQr, setAddingQr] = useState(false)
  const [qrLabel, setQrLabel] = useState('')
  const [qrPrompt, setQrPrompt] = useState('')

  const [mcpName, setMcpName] = useState('')
  const [mcpUrl, setMcpUrl] = useState('')
  const [addingMcp, setAddingMcp] = useState(false)
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null)
  const [kbMcpStatus, setKbMcpStatus] = useState<KbMcpStatus | null>(null)
  const [mcpLoading, setMcpLoading] = useState(false)

  const [addingEnv, setAddingEnv] = useState(false)
  const [envKey, setEnvKey] = useState('')
  const [envVal, setEnvVal] = useState('')
  const [addingArg, setAddingArg] = useState(false)
  const [argDraft, setArgDraft] = useState('')

  const [addingRepo, setAddingRepo] = useState(false)
  const [repoDraft, setRepoDraft] = useState('')
  const [authorOpen, setAuthorOpen] = useState(true)

  const refreshLocalMcp = useCallback(async (): Promise<void> => {
    if (!hasIpc) return
    setMcpLoading(true)
    try {
      const [gw, kb] = await Promise.all([
        api.gatewayStatus?.().catch(() => null),
        api.kbMcpStatus?.().catch(() => null)
      ])
      if (gw) setGatewayStatus(gw)
      if (kb) setKbMcpStatus(kb)
    } finally {
      setMcpLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshLocalMcp()
  }, [refreshLocalMcp])

  if (!snapshot) return null
  const space = snapshot.spaces.find((s) => s.id === agent.spaceId)
  const slot = resolveAgentSlot(agent.id, { runtimeKind: agent.runtimeKind, workingDirectory: agent.workingDirectory }).slot
  const runtimeBrandId = resolveRuntimeBrandId(slot)
  const runtimeName = resolveRuntimeDisplayName(slot, detectedRuntimes)
  const matchedRuntime = matchDetectedRuntime(detectedRuntimes, slot.runtimeKind, slot.runtimeId)
  const runtimeHealthy = Boolean(matchedRuntime && matchedRuntime.available && !matchedRuntime.setupRequired)
  const launchCfg = runtimeLaunchConfigs[runtimeBrandId] ?? runtimeLaunchConfigs[slot.runtimeKind] ?? { args: [], env: [], manualModels: [], isolationMode: meta.isolationMode }

  const agentRuns = runs.filter((r) => r.executorKind === 'agent' && r.executorId === agent.id)
  const delegatedTasks = snapshot.tasks.filter((t) => t.executor?.kind === 'agent' && t.executor.id === agent.id)
  const agentAutomations = snapshot.automations.filter((a) => a.target.kind === 'agent' && a.target.id === agent.id)
  const availableSkills = snapshot.skills.filter((sk) => !sk.spaceId || sk.spaceId === agent.spaceId)
  const distinctRole = agent.description && agent.description.trim() !== agent.name.trim() ? agent.description.trim() : ''

  const saveAgentPatch = async (patch: Partial<CruxAgentInput>): Promise<void> => {
    await run('保存 Agent', () => api.crux.saveAgent({ ...buildAgentInput(agent), ...patch }))
  }

  const startInlineEdit = (field: 'name' | 'role' | 'bio', initial: string): void => {
    setEditingField(field)
    setFieldDraft(initial)
  }

  const commitInlineEdit = async (): Promise<void> => {
    const field = editingField
    const nextVal = fieldDraft.trim()
    setEditingField(null)
    if (!field) return
    if (field === 'name') {
      if (nextVal && nextVal !== agent.name) await saveAgentPatch({ name: nextVal })
      return
    }
    const prev = agent.description ?? ''
    if (nextVal !== prev) await saveAgentPatch({ description: nextVal || undefined })
  }

  const toggleSection = (id: AccordionSectionId): void => {
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }))
    setActiveAnchor(id)
  }

  const jumpToSection = (id: AccordionSectionId): void => {
    if (tab !== 'settings') onTabChange('settings')
    setOpenSections((prev) => ({ ...prev, [id]: true }))
    setActiveAnchor(id)
    window.requestAnimationFrame(() => {
      sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const handleScroll = (e: UIEvent<HTMLDivElement>): void => {
    const top = e.currentTarget.scrollTop
    setStickyVisible(tab === 'settings' && top > 150)
    if (tab !== 'settings') return
    const parentTop = e.currentTarget.getBoundingClientRect().top
    for (const item of SECTION_NAV_ITEMS) {
      const node = sectionRefs.current[item.id]
      if (!node) continue
      const rect = node.getBoundingClientRect()
      if (rect.top - parentTop <= 96 && rect.bottom - parentTop > 32) {
        setActiveAnchor(item.id)
        break
      }
    }
  }

  const addEnvPair = (): void => {
    const k = envKey.trim()
    if (!k) return
    const next = [...launchCfg.env.filter((item) => item.key !== k), { key: k, value: envVal.trim() }]
    setRuntimeLaunchConfig(runtimeBrandId, { env: next })
    setEnvKey('')
    setEnvVal('')
    setAddingEnv(false)
  }

  const addLaunchArg = (): void => {
    const val = argDraft.trim()
    if (!val) return
    const lines = val.split('\n').map((s) => s.trim()).filter(Boolean)
    setRuntimeLaunchConfig(runtimeBrandId, { args: [...launchCfg.args, ...lines] })
    setArgDraft('')
    setAddingArg(false)
  }

  const addGitRepo = async (repoName: string): Promise<void> => {
    const trimmed = repoName.trim()
    if (!trimmed) return
    if (agent.repositories.some((r) => r.name === trimmed)) return
    await saveAgentPatch({ repositories: [...agent.repositories, { name: trimmed }] })
    setRepoDraft('')
    setAddingRepo(false)
  }

  const pickGitRepoFolder = async (): Promise<void> => {
    if (!hasIpc) return
    const picked = await api.pickProject()
    if (picked?.trim()) await addGitRepo(picked.trim())
  }

  const inheritedUpstreams = gatewayStatus?.upstreams ?? []
  const enabledImBrands = IM_PLATFORMS.filter((im) => meta.triggers.imChannels.includes(im.id))

  return (
    <div className="flex h-full min-h-0 flex-col">
      {stickyVisible ? (
        <div className="collab-drawer-sticky-nav shrink-0" role="navigation" aria-label="设置分区快速定位">
          <button
            type="button"
            aria-label="关闭抽屉"
            onClick={onClose}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-my-base text-my-icon-secondary hover:bg-my-layer-1 hover:text-my-primary"
          >
            <X size={15} />
          </button>
          <span
            className="collab-tone-avatar grid h-6 w-6 shrink-0 place-items-center rounded-full"
            data-tone={identityTone(agent.name)}
            title={agent.name}
          >
            <Bot size={13} />
          </span>
          {SECTION_NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              data-active={activeAnchor === item.id || undefined}
              onClick={() => jumpToSection(item.id)}
              className="collab-drawer-anchor-pill"
            >
              {item.shortLabel}
            </button>
          ))}
        </div>
      ) : (
        <header className="flex shrink-0 items-center justify-between px-4 pt-3 pb-1">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="关闭抽屉"
              onClick={onClose}
              className="grid h-7 w-7 place-items-center rounded-my-base text-my-icon-secondary hover:bg-my-layer-1 hover:text-my-primary"
            >
              <X size={15} />
            </button>
            <button
              type="button"
              aria-label={expanded ? '收起宽度' : '展开宽度'}
              onClick={onToggleExpand}
              className="grid h-7 w-7 place-items-center rounded-my-base text-my-icon-secondary hover:bg-my-layer-1 hover:text-my-primary"
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
          {agent.archived && <span className="my-chip">已归档</span>}
        </header>
      )}

      <div
        ref={scrollBodyRef}
        onScroll={handleScroll}
        className="collab-scroll flex min-h-0 flex-1 flex-col"
      >
        {/* Hero 头部（严格固定高度编辑槽：点击切换输入框周边 0px 抖动！） */}
        <div className="flex flex-col gap-2.5 px-5 pt-2 pb-3">
          <div className="flex items-start gap-3.5">
            <span
              className="collab-tone-avatar grid h-12 w-12 shrink-0 place-items-center rounded-full"
              data-tone={identityTone(agent.name)}
            >
              <Bot size={23} />
            </span>
            <div className="min-w-0 flex-1">
              {/* 名字 + 职位行：固定 28px 高度，零上下抖动 */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="collab-inline-slot-title">
                  {editingField === 'name' ? (
                    <input
                      autoFocus
                      className="collab-inline-input w-32 text-my-md font-semibold"
                      value={fieldDraft}
                      onChange={(e) => setFieldDraft(e.target.value)}
                      onBlur={() => void commitInlineEdit()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitInlineEdit()
                        if (e.key === 'Escape') setEditingField(null)
                      }}
                      aria-label="编辑 Agent 名称"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => startInlineEdit('name', agent.name)}
                      className="collab-inline-trigger max-w-[180px] truncate text-left text-my-md font-semibold text-my-primary"
                      title="点击直接修改名称"
                    >
                      {agent.name}
                    </button>
                  )}
                </div>

                <div className="collab-inline-slot-title">
                  {editingField === 'role' ? (
                    <input
                      autoFocus
                      className="collab-inline-input w-32 text-my-sm font-medium"
                      value={fieldDraft}
                      onChange={(e) => setFieldDraft(e.target.value)}
                      onBlur={() => void commitInlineEdit()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitInlineEdit()
                        if (e.key === 'Escape') setEditingField(null)
                      }}
                      placeholder="职位或角色"
                      aria-label="编辑职位或角色"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => startInlineEdit('role', distinctRole)}
                      className="collab-inline-trigger max-w-[150px] truncate text-left text-my-sm text-my-tertiary hover:text-my-primary"
                      title="点击直接修改职位或角色"
                    >
                      {distinctRole ? `- ${distinctRole}` : '+ 职位'}
                    </button>
                  )}
                </div>

                {!agent.enabled && <span className="my-chip">已停用</span>}
              </div>

              {/* 第二行：实时对应当前选中引擎的官方品牌图标 */}
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-my-2xs text-my-tertiary">
                <ToolBrandIcon brand={runtimeBrandId} size={14} />
                <span className="text-my-secondary">
                  {slot.model === 'follow-runtime' ? runtimeName : slot.model}
                </span>
                <span>·</span>
                <span>{machineName}</span>
                {matchedRuntime && (
                  <span
                    className={`inline-flex items-center ${runtimeHealthy ? 'text-my-success-text' : 'text-my-warning-text'}`}
                    title={runtimeHealthLabel(matchedRuntime)}
                  >
                    <Wifi size={11} />
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* 描述行：固定 24px 高度，点击编辑 0px 抖动 */}
          <div className="collab-inline-slot-bio">
            {editingField === 'bio' ? (
              <input
                autoFocus
                className="collab-inline-input w-full text-my-xs"
                value={fieldDraft}
                onChange={(e) => setFieldDraft(e.target.value)}
                onBlur={() => void commitInlineEdit()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitInlineEdit()
                  if (e.key === 'Escape') setEditingField(null)
                }}
                placeholder="一句话描述此 Agent 的职责…"
                aria-label="编辑职责描述"
              />
            ) : (
              <button
                type="button"
                onClick={() => startInlineEdit('bio', agent.description ?? '')}
                className="collab-inline-trigger w-full truncate text-left text-my-xs text-my-tertiary hover:text-my-secondary"
                title="点击直接编辑描述"
              >
                {distinctRole || '暂无描述'}
              </button>
            )}
          </div>

          {/* 空间 · 可见性 · 机器 行 */}
          <div className="flex flex-wrap items-center gap-1.5 text-my-xs text-my-secondary">
            <FlowIcon name="projects" size={13} />
            <span>{space?.name ?? '默认空间'}</span>
            <span className="text-my-tertiary">·</span>
            <button
              type="button"
              onClick={() => updateAgentMeta(agent.id, { visibility: meta.visibility === 'space' ? 'personal' : 'space' })}
              className="inline-flex items-center gap-1 rounded-my-sm px-1 py-0.5 text-my-secondary hover:bg-my-layer-1 hover:text-my-primary"
              title="点击切换公开 / 私有可见性"
            >
              {meta.visibility === 'personal' ? <Lock size={11} /> : <Globe size={11} />}
              <span>{meta.visibility === 'personal' ? '私有' : '公开'}</span>
            </button>
            <span className="text-my-tertiary">·</span>
            <button
              type="button"
              onClick={() => jumpToSection('runtime')}
              className="inline-flex items-center gap-1 text-my-secondary hover:text-my-primary"
            >
              <span>{machineName}</span>
              <ChevronRight size={12} className="text-my-tertiary" />
            </button>
          </div>

          {/* 核心操作行（使用统一公共 ActionMenu） */}
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="primary"
              className="flex-1 justify-center"
              disabled={!agent.enabled || agent.archived}
              onClick={onOpenAssignModal}
            >
              <Plus size={14} />创建或指派任务
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 justify-center"
              disabled={!agent.enabled || agent.archived}
              onClick={() => useAgentChatBridge.getState().startAgentChat(agent.id, { runtimeKind: slot.runtimeKind, workingDirectory: slot.workingDirectory })}
            >
              <MessageCircle size={14} />对话
            </Button>
            <Button size="sm" variant="ghost" aria-label={starred ? '取消收藏' : '添加到收藏'} onClick={onToggleStar} className="px-2">
              <Star size={15} className={starred ? 'fill-current text-my-warning-text' : ''} />
            </Button>
            <ActionMenu
              width={168}
              ariaLabel="Agent 更多操作"
              trigger={({ toggle, open }) => (
                <Button size="sm" variant="ghost" aria-label="更多操作" aria-expanded={open} onClick={toggle} className="px-2">
                  <MoreHorizontal size={15} />
                </Button>
              )}
              items={[
                {
                  kind: 'item',
                  id: 'history',
                  label: '查看运行历史',
                  icon: <History size={14} />,
                  onSelect: () => onTabChange('history')
                },
                {
                  kind: 'item',
                  id: 'clone',
                  label: '克隆',
                  icon: <Copy size={14} />,
                  onSelect: onDuplicate
                },
                {
                  kind: 'item',
                  id: 'toggle',
                  label: agent.enabled ? '停用' : '启用',
                  icon: agent.enabled ? <PauseCircle size={14} /> : <PlayCircle size={14} />,
                  onSelect: () => void saveAgentPatch({ enabled: !agent.enabled })
                },
                { kind: 'divider', id: 'div-archive' },
                {
                  kind: 'item',
                  id: 'archive',
                  label: agent.archived ? '恢复' : '归档',
                  danger: !agent.archived,
                  icon: agent.archived ? <RotateCcw size={14} /> : <Archive size={14} />,
                  onSelect: () => void saveAgentPatch({ archived: !agent.archived, enabled: agent.archived ? true : false })
                }
              ]}
            />
          </div>
        </div>

        {/* 3 下划线标签页 */}
        <div className="task-post-tabs px-5" role="tablist" aria-label="Agent 抽屉分区">
          <button type="button" role="tab" aria-selected={tab === 'settings'} onClick={() => onTabChange('settings')}>
            设置
          </button>
          <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => onTabChange('history')}>
            运行历史 <span className="ml-0.5 tabular-nums text-my-tertiary">{agentRuns.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'tasks'} onClick={() => onTabChange('tasks')}>
            任务 <span className="ml-0.5 tabular-nums text-my-tertiary">{delegatedTasks.length}</span>
          </button>
        </div>

        {/* 分区内容 */}
        <div className="flex flex-col gap-2.5 p-4">
          {tab === 'settings' && (
            <>
              {/* 1. 指令 */}
              <div ref={(el) => { sectionRefs.current.instructions = el }}>
                <AccordionCard
                  icon={<FileText size={16} />}
                  title="指令"
                  description="设定此 Agent 的职责、指引和约束；每个任务都会携带这段文本。"
                  summary={agent.instructions.trim() ? '已配置' : '无'}
                  expanded={Boolean(openSections.instructions)}
                  onToggle={() => toggleSection('instructions')}
                >
                  <div className="flex flex-col gap-3">
                    <textarea
                      className={`${textareaClass} font-mono text-my-xs`}
                      rows={5}
                      value={instDraft}
                      onChange={(e) => setInstDraft(e.target.value)}
                      placeholder="例如：1. 先阅读任务目标与验收标准；2. 修改代码并运行检查；3. 输出总结…"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-my-2xs text-my-tertiary">
                        {meta.instructionVersions.length > 0 ? `历史版本 ${meta.instructionVersions.length} 条` : '修改后点击保存立即生效'}
                      </span>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy || instDraft.trim() === agent.instructions.trim()}
                        onClick={async () => {
                          await saveAgentPatch({ instructions: instDraft.trim() })
                          recordAgentInstructionVersion(agent.id, instDraft.trim(), '手动保存指令')
                        }}
                      >
                        保存指令
                      </Button>
                    </div>

                    <div className="border-t border-my-line pt-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-my-xs font-medium text-my-primary">快捷回复指令</span>
                        {!addingQr && (
                          <Button size="sm" variant="ghost" onClick={() => setAddingQr(true)}>
                            <Plus size={12} />添加
                          </Button>
                        )}
                      </div>
                      {meta.quickReplies.length > 0 && (
                        <div className="mb-2 space-y-1.5">
                          {meta.quickReplies.map((qr) => (
                            <div key={qr.id} className="flex items-center justify-between gap-2 rounded-my-base bg-my-layer-1 px-2.5 py-1.5 text-my-xs">
                              <div className="min-w-0 flex-1">
                                <div className="font-medium text-my-primary">{qr.label}</div>
                                <div className="truncate text-my-2xs text-my-tertiary">{qr.prompt}</div>
                              </div>
                              <button
                                type="button"
                                aria-label="删除快捷指令"
                                onClick={() => updateAgentMeta(agent.id, { quickReplies: meta.quickReplies.filter((item) => item.id !== qr.id) })}
                                className="text-my-tertiary hover:text-my-danger-text"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {addingQr && (
                        <div className="space-y-1.5 rounded-my-base bg-my-layer-1 p-2.5">
                          <input autoFocus className={inputClass} value={qrLabel} onChange={(e) => setQrLabel(e.target.value)} placeholder="按钮标题，如：先给实现方案" />
                          <input className={inputClass} value={qrPrompt} onChange={(e) => setQrPrompt(e.target.value)} placeholder="发送给 Agent 的完整提示词" />
                          <div className="flex justify-end gap-1.5">
                            <Button size="sm" variant="ghost" onClick={() => { setAddingQr(false); setQrLabel(''); setQrPrompt('') }}>取消</Button>
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={!qrLabel.trim() || !qrPrompt.trim()}
                              onClick={() => {
                                updateAgentMeta(agent.id, {
                                  quickReplies: [...meta.quickReplies, { id: `qr-${Date.now()}`, label: qrLabel.trim(), prompt: qrPrompt.trim() }]
                                })
                                setQrLabel('')
                                setQrPrompt('')
                                setAddingQr(false)
                              }}
                            >
                              添加
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>

                    {meta.instructionVersions.length > 0 && (
                      <div className="border-t border-my-line pt-3">
                        <div className="mb-2 text-my-xs font-medium text-my-primary">历史版本</div>
                        <div className="space-y-1">
                          {meta.instructionVersions.slice(0, 4).map((ver) => (
                            <div key={ver.id} className="flex items-center justify-between gap-2 rounded-my-base bg-my-layer-1 px-2.5 py-1.5 text-my-xs">
                              <span className="truncate text-my-secondary">{ver.note || '历史版本'} · {formatDateLabel(ver.savedAt)}</span>
                              <Button size="sm" variant="ghost" onClick={() => setInstDraft(ver.instructions)}>载入</Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </AccordionCard>
              </div>

              {/* 2. 触发器与消息 */}
              <div ref={(el) => { sectionRefs.current.triggers = el }}>
                <AccordionCard
                  icon={<Share2 size={16} />}
                  title="触发器与消息"
                  description="连接飞书、企业微信、钉钉、微信等 IM 平台"
                  summary={
                    <span className="inline-flex items-center gap-1">
                      {(enabledImBrands.length > 0 ? enabledImBrands : IM_PLATFORMS.slice(0, 2)).map((im) => (
                        <span key={im.id} className="collab-brand-badge" data-tone="plate">
                          <AppBrandIcon brand={im.id} size={14} />
                        </span>
                      ))}
                    </span>
                  }
                  expanded={Boolean(openSections.triggers)}
                  onToggle={() => toggleSection('triggers')}
                >
                  <div className="flex flex-col gap-3">
                    <div className="space-y-2.5">
                      <div className="text-my-xs font-medium text-my-primary">Crux 内部</div>
                      <TriggerRow
                        icon={<FileText size={13} />}
                        label="被指派任务"
                        checked={meta.triggers.onAssign}
                        onChange={(onAssign) => updateAgentMeta(agent.id, { triggers: { ...meta.triggers, onAssign } })}
                      />
                      <TriggerRow
                        icon={<MessageCircle size={13} />}
                        label="私聊"
                        checked={meta.triggers.onDirectChat}
                        onChange={(onDirectChat) => updateAgentMeta(agent.id, { triggers: { ...meta.triggers, onDirectChat } })}
                      />
                      <TriggerRow
                        icon={<Users2 size={13} />}
                        label="加入小队"
                        checked={meta.triggers.onCrewJoin ?? true}
                        onChange={(onCrewJoin) => updateAgentMeta(agent.id, { triggers: { ...meta.triggers, onCrewJoin } })}
                      />
                      <TriggerRow
                        icon={<AtSign size={13} />}
                        label="被 @ 提到"
                        checked={meta.triggers.onMention}
                        onChange={(onMention) => updateAgentMeta(agent.id, { triggers: { ...meta.triggers, onMention } })}
                      />
                      <TriggerRow
                        icon={<Workflow size={13} />}
                        label="被工作流调用"
                        checked={meta.triggers.onWorkflowInvoke ?? true}
                        onChange={(onWorkflowInvoke) => updateAgentMeta(agent.id, { triggers: { ...meta.triggers, onWorkflowInvoke } })}
                      />
                    </div>

                    <div className="space-y-2.5 border-t border-my-line pt-3">
                      <div className="flex flex-wrap gap-1.5">
                        {IM_PLATFORMS.map((im) => {
                          const enabled = meta.triggers.imChannels.includes(im.id)
                          return (
                            <button
                              key={im.id}
                              type="button"
                              aria-pressed={enabled}
                              onClick={() => {
                                const next = enabled
                                  ? meta.triggers.imChannels.filter((id) => id !== im.id)
                                  : [...meta.triggers.imChannels, im.id]
                                updateAgentMeta(agent.id, { triggers: { ...meta.triggers, imChannels: next } })
                              }}
                              className="collab-scenario-pill"
                            >
                              <AppBrandIcon brand={im.id} size={14} />
                              <span>{im.label}</span>
                            </button>
                          )
                        })}
                      </div>
                      <button
                        type="button"
                        onClick={() => useApp.getState().setPage('channels')}
                        className="inline-flex items-center gap-2 rounded-my-base border border-my-line bg-my-panel px-3 py-1.5 text-my-xs font-medium text-my-secondary transition-colors hover:border-my-line-strong hover:text-my-primary"
                      >
                        <Plus size={13} />
                        <span>连接消息平台</span>
                        <span className="inline-flex items-center gap-1 pl-0.5">
                          <AppBrandIcon brand="feishu" size={14} />
                          <AppBrandIcon brand="dingtalk" size={14} />
                          <AppBrandIcon brand="wecom" size={14} />
                          <AppBrandIcon brand="wechat" size={14} />
                        </span>
                      </button>
                    </div>
                  </div>
                </AccordionCard>
              </div>

              {/* 3. 工具 · 知识库 · MCP */}
              <div ref={(el) => { sectionRefs.current.mcp = el }}>
                <AccordionCard
                  icon={<Plug size={16} />}
                  title="工具 · 知识库 · MCP"
                  description="设置 Agent 可以使用的外部应用数据、工具和 MCP"
                  summary={
                    inheritedUpstreams.length > 0 ? (
                      <span className="inline-flex items-center gap-1">
                        {inheritedUpstreams.slice(0, 3).map((u) => {
                          const brand = inferAppBrandFromName(u.name)
                          return brand ? (
                            <span key={u.id} className="collab-brand-badge" data-tone="plate">
                              <AppBrandIcon brand={brand} size={15} />
                            </span>
                          ) : (
                            <span
                              key={u.id}
                              className="collab-tone-avatar grid h-5 w-5 place-items-center rounded-full text-my-2xs font-semibold"
                              data-tone={identityTone(u.name)}
                            >
                              {u.name.slice(0, 1).toUpperCase()}
                            </span>
                          )
                        })}
                      </span>
                    ) : meta.knowledgeEnabled ? '知识库' : '无'
                  }
                  expanded={Boolean(openSections.mcp)}
                  onToggle={() => toggleSection('mcp')}
                >
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between rounded-my-base bg-my-layer-1 px-3 py-2">
                      <div className="min-w-0 pr-3">
                        <div className="text-my-xs font-medium text-my-primary">空间文档库检索</div>
                        <div className="text-my-2xs text-my-tertiary">执行任务时自动挂载所属空间的规范与文档</div>
                      </div>
                      <Switch
                        label="空间文档库检索"
                        checked={meta.knowledgeEnabled}
                        onChange={(knowledgeEnabled) => updateAgentMeta(agent.id, { knowledgeEnabled })}
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 text-my-xs font-medium text-my-primary">
                          <ToolBrandIcon brand={runtimeBrandId} size={14} />
                          <span>从 {runtimeName} / MCP 网关继承</span>
                        </span>
                        <button
                          type="button"
                          aria-label="刷新本机 MCP 服务"
                          onClick={() => void refreshLocalMcp()}
                          className="grid h-6 w-6 place-items-center rounded-my-base text-my-tertiary hover:bg-my-layer-1 hover:text-my-primary"
                        >
                          <RefreshCw size={12} className={mcpLoading ? 'animate-spin' : ''} />
                        </button>
                      </div>

                      {inheritedUpstreams.length === 0 && !kbMcpStatus?.installed ? (
                        <div className="collab-empty-inset">
                          <div className="text-my-xs font-medium text-my-secondary">尚未检测到本机 MCP 上游服务</div>
                          <div className="text-my-2xs text-my-tertiary">在「MCP 网关」中接入的知识库、数据库与工具会自动被本地 Agent 继承。</div>
                          <Button size="sm" variant="outline" onClick={() => useApp.getState().setPage('gateway')}>
                            前往配置 MCP 网关
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {kbMcpStatus?.installed && (
                            <div className="collab-mcp-row">
                              <span className="collab-tone-avatar grid h-6 w-6 shrink-0 place-items-center rounded-my-sm text-my-2xs font-semibold" data-tone="emerald">
                                K
                              </span>
                              <span className="truncate text-my-xs font-medium text-my-primary">trellis-panel-kb</span>
                              <span className="rounded-my-sm bg-my-layer-2 px-1.5 py-0.5 font-mono text-my-2xs text-my-tertiary">
                                STDIO · 本地知识库
                              </span>
                              <span className="ml-auto shrink-0 rounded-my-sm bg-my-success-subtle px-1.5 py-0.5 text-my-2xs text-my-success-text">
                                已安装
                              </span>
                            </div>
                          )}
                          {inheritedUpstreams.map((up) => {
                            const brand = inferAppBrandFromName(up.name)
                            return (
                              <div key={up.id} className="collab-mcp-row">
                                {brand ? (
                                  <span className="collab-brand-badge" data-tone="plate" data-size="md">
                                    <AppBrandIcon brand={brand} size={16} />
                                  </span>
                                ) : (
                                  <span
                                    className="collab-tone-avatar grid h-6 w-6 shrink-0 place-items-center rounded-my-sm text-my-2xs font-semibold"
                                    data-tone={identityTone(up.name)}
                                  >
                                    {up.name.slice(0, 1).toUpperCase()}
                                  </span>
                                )}
                                <span className="min-w-0 flex-1 truncate text-my-xs font-medium text-my-primary">{up.name}</span>
                                <span className="shrink-0 rounded-my-sm bg-my-layer-2 px-1.5 py-0.5 font-mono text-my-2xs text-my-tertiary">
                                  {up.isRemote ? 'HTTP' : 'STDIO'} · {up.tools.length} 工具
                                </span>
                                {!up.enabled || up.status === 'disabled' ? (
                                  <span className="shrink-0 rounded-my-sm border border-my-line px-1.5 py-0.5 text-my-2xs text-my-tertiary">已停用</span>
                                ) : up.status === 'connected' ? (
                                  <span className="shrink-0 rounded-my-sm bg-my-success-subtle px-1.5 py-0.5 text-my-2xs text-my-success-text">已连接</span>
                                ) : (
                                  <span className="shrink-0 rounded-my-sm bg-my-warning-subtle px-1.5 py-0.5 text-my-2xs text-my-warning-text">待连接</span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    <div className="border-t border-my-line pt-3">
                      {meta.mcpEndpoints.length > 0 && (
                        <div className="mb-2 space-y-1.5">
                          {meta.mcpEndpoints.map((ep) => {
                            const brand = inferAppBrandFromName(ep.name)
                            return (
                              <div key={ep.id} className="collab-mcp-row">
                                {brand ? (
                                  <span className="collab-brand-badge" data-tone="plate" data-size="md">
                                    <AppBrandIcon brand={brand} size={16} />
                                  </span>
                                ) : (
                                  <span className="collab-tone-avatar grid h-6 w-6 shrink-0 place-items-center rounded-my-sm text-my-2xs font-semibold" data-tone={identityTone(ep.name)}>
                                    {ep.name.slice(0, 1).toUpperCase()}
                                  </span>
                                )}
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-my-xs font-medium text-my-primary">{ep.name}</div>
                                  <div className="truncate font-mono text-my-2xs text-my-tertiary">{ep.commandOrUrl}</div>
                                </div>
                                <Switch
                                  label={ep.name}
                                  checked={ep.enabled}
                                  onChange={(enabled) => updateAgentMeta(agent.id, {
                                    mcpEndpoints: meta.mcpEndpoints.map((item) => item.id === ep.id ? { ...item, enabled } : item)
                                  })}
                                />
                                <button
                                  type="button"
                                  aria-label={`删除 ${ep.name}`}
                                  onClick={() => updateAgentMeta(agent.id, { mcpEndpoints: meta.mcpEndpoints.filter((item) => item.id !== ep.id) })}
                                  className="text-my-tertiary hover:text-my-danger-text"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {addingMcp ? (
                        <div className="space-y-1.5 rounded-my-base bg-my-layer-1 p-2.5">
                          <input autoFocus className={inputClass} value={mcpName} onChange={(e) => setMcpName(e.target.value)} placeholder="名称，如：GitHub / Jira" />
                          <input className={inputClass} value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} placeholder="命令或 HTTP URL" />
                          <div className="flex justify-end gap-1.5">
                            <Button size="sm" variant="ghost" onClick={() => { setAddingMcp(false); setMcpName(''); setMcpUrl('') }}>取消</Button>
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={!mcpName.trim() || !mcpUrl.trim()}
                              onClick={() => {
                                updateAgentMeta(agent.id, {
                                  mcpEndpoints: [...meta.mcpEndpoints, { id: `mcp-${Date.now()}`, name: mcpName.trim(), commandOrUrl: mcpUrl.trim(), enabled: true }]
                                })
                                setMcpName('')
                                setMcpUrl('')
                                setAddingMcp(false)
                              }}
                            >
                              添加
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => setAddingMcp(true)}
                            className="inline-flex items-center gap-2 rounded-my-base border border-my-line bg-my-panel px-3 py-1.5 text-my-xs font-medium text-my-secondary transition-colors hover:border-my-line-strong hover:text-my-primary"
                          >
                            <Plus size={13} />
                            <span>添加连接</span>
                            <span className="inline-flex items-center gap-1 pl-0.5">
                              <AppBrandIcon brand="weknora" size={14} />
                              <AppBrandIcon brand="gitlab" size={14} />
                              <AppBrandIcon brand="jira" size={14} />
                              <AppBrandIcon brand="github" size={14} />
                            </span>
                          </button>
                          <Button size="sm" variant="ghost" onClick={() => useApp.getState().setPage('gateway')}>
                            网关管理
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </AccordionCard>
              </div>

              {/* 4. 机器、Runtime 与工作目录（HiFox 图 6 分组真图标 RuntimePicker！） */}
              <div ref={(el) => { sectionRefs.current.runtime = el }}>
                <AccordionCard
                  icon={<Monitor size={16} />}
                  title="机器、Runtime 与工作目录"
                  description="调整 Runtime 环境变量、自定义参数、并发数等"
                  summary={
                    <span className="collab-brand-badge">
                      <ToolBrandIcon brand={runtimeBrandId} size={14} />
                    </span>
                  }
                  expanded={Boolean(openSections.runtime)}
                  onToggle={() => toggleSection('runtime')}
                >
                  <div className="flex flex-col gap-3">
                    <ConfigRow label="Runtime">
                      <RuntimePicker
                        valueKind={slot.runtimeKind}
                        valueRuntimeId={slot.runtimeId}
                        customRuntimeId={meta.customRuntimeId}
                        detectedRuntimes={detectedRuntimes}
                        customRuntimes={customRuntimes}
                        machineName={machineName}
                        onSelect={(next) => {
                          setAgentSlotOverride(agent.id, {
                            runtimeKind: next.runtimeKind,
                            runtimeId: next.runtimeId
                          })
                          updateAgentMeta(agent.id, { customRuntimeId: next.customRuntimeId })
                          if (next.runtimeKind !== agent.runtimeKind) {
                            void api.crux.saveAgent({ ...buildAgentInput(agent), runtimeKind: next.runtimeKind }).catch(() => undefined)
                          }
                        }}
                        onOpenMore={() => setModule('runtimes')}
                      />
                    </ConfigRow>

                    <ConfigRow label="默认模型">
                      <Select
                        className="w-48"
                        value={slot.model}
                        onChange={(model) => setAgentSlotOverride(agent.id, { ...slot, model })}
                        options={[...MODEL_PRESET_OPTIONS]}
                      />
                    </ConfigRow>

                    <ConfigRow label="审批模式默认" icon={<ShieldCheck size={13} />}>
                      <Select
                        className="w-48"
                        value={meta.approvalMode ?? 'follow_runtime'}
                        onChange={(v) => updateAgentMeta(agent.id, { approvalMode: v as AgentApprovalMode })}
                        options={[
                          { value: 'follow_runtime', label: '跟随 Runtime' },
                          { value: 'ask', label: '高危改动前询问' },
                          { value: 'auto', label: '自动执行' }
                        ]}
                      />
                    </ConfigRow>

                    <ConfigRow label="协作模式默认" icon={<Workflow size={13} />}>
                      <Select
                        className="w-48"
                        value={meta.collabMode ?? 'follow_runtime'}
                        onChange={(v) => updateAgentMeta(agent.id, { collabMode: v as AgentCollabMode })}
                        options={[
                          { value: 'follow_runtime', label: '跟随 Runtime' },
                          { value: 'autonomous', label: '自主推进并汇报' },
                          { value: 'supervised', label: '每步确认后继续' }
                        ]}
                      />
                    </ConfigRow>

                    <ConfigRow label="最大并发">
                      <Select
                        className="w-48"
                        value={String(meta.concurrency)}
                        onChange={(val) => updateAgentMeta(agent.id, { concurrency: Number(val) || 1 })}
                        options={[
                          { value: '1', label: '1 个（串行稳妥）' },
                          { value: '2', label: '2 个' },
                          { value: '4', label: '4 个' }
                        ]}
                      />
                    </ConfigRow>

                    {/* 环境变量 */}
                    <div className="border-t border-my-line pt-3">
                      <div className="text-my-xs font-medium text-my-primary">环境变量</div>
                      <p className="mt-0.5 text-my-2xs text-my-tertiary">在 Agent 进程启动时注入，例如 ANTHROPIC_BASE_URL。</p>
                      {launchCfg.env.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {launchCfg.env.map((pair) => (
                            <div key={pair.key} className="flex items-center justify-between gap-2 rounded-my-base bg-my-layer-1 px-2.5 py-1.5 font-mono text-my-2xs">
                              <span className="truncate text-my-primary">{pair.key}={pair.value}</span>
                              <button
                                type="button"
                                aria-label={`移除环境变量 ${pair.key}`}
                                onClick={() => setRuntimeLaunchConfig(runtimeBrandId, { env: launchCfg.env.filter((e) => e.key !== pair.key) })}
                                className="text-my-tertiary hover:text-my-danger-text"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {addingEnv ? (
                        <div className="mt-2 flex flex-col gap-1.5">
                          <div className="grid grid-cols-2 gap-1.5">
                            <input autoFocus className={`${inputClass} font-mono text-my-xs`} value={envKey} onChange={(e) => setEnvKey(e.target.value)} placeholder="KEY" />
                            <input className={`${inputClass} font-mono text-my-xs`} value={envVal} onChange={(e) => setEnvVal(e.target.value)} placeholder="VALUE" />
                          </div>
                          <div className="flex justify-end gap-1.5">
                            <Button size="sm" variant="ghost" onClick={() => { setAddingEnv(false); setEnvKey(''); setEnvVal('') }}>取消</Button>
                            <Button size="sm" variant="primary" disabled={!envKey.trim()} onClick={addEnvPair}>保存</Button>
                          </div>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline" className="mt-2" onClick={() => setAddingEnv(true)}>
                          <Plus size={12} />添加
                        </Button>
                      )}
                    </div>

                    {/* 自定义参数 */}
                    <div className="border-t border-my-line pt-3">
                      <div className="text-my-xs font-medium text-my-primary">自定义参数</div>
                      <p className="mt-0.5 text-my-2xs text-my-tertiary">每行一个参数与值，如 --full-auto。</p>
                      {launchCfg.args.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {launchCfg.args.map((arg, idx) => (
                            <span key={`${arg}-${idx}`} className="inline-flex items-center gap-1 rounded-my-base bg-my-layer-1 px-2 py-1 font-mono text-my-2xs text-my-primary">
                              {arg}
                              <button
                                type="button"
                                aria-label={`移除参数 ${arg}`}
                                onClick={() => setRuntimeLaunchConfig(runtimeBrandId, { args: launchCfg.args.filter((_, i) => i !== idx) })}
                                className="text-my-tertiary hover:text-my-danger-text"
                              >
                                <X size={11} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      {addingArg ? (
                        <div className="mt-2 flex items-center gap-1.5">
                          <input
                            autoFocus
                            className={`${inputClass} flex-1 font-mono text-my-xs`}
                            value={argDraft}
                            onChange={(e) => setArgDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') addLaunchArg() }}
                            placeholder="--full-auto"
                          />
                          <Button size="sm" variant="primary" disabled={!argDraft.trim()} onClick={addLaunchArg}>添加</Button>
                          <Button size="sm" variant="ghost" onClick={() => { setAddingArg(false); setArgDraft('') }}>取消</Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline" className="mt-2" onClick={() => setAddingArg(true)}>
                          <Plus size={12} />添加
                        </Button>
                      )}
                    </div>

                    {/* 默认工作目录 */}
                    <div className="space-y-2.5 border-t border-my-line pt-3">
                      <ConfigRow label="默认工作目录">
                        <Select
                          className="w-48"
                          value={slot.workingDirectory}
                          onChange={(val) => {
                            const wd = val as CruxWorkingDirectoryMode
                            setAgentSlotOverride(agent.id, { workingDirectory: wd })
                            void api.crux.saveAgent({ ...buildAgentInput(agent), workingDirectory: wd }).catch(() => undefined)
                          }}
                          options={[...WORKDIR_MODE_OPTIONS]}
                        />
                      </ConfigRow>
                      <ConfigRow label="目录隔离模式">
                        <Select
                          className="w-48"
                          value={meta.isolationMode}
                          onChange={(val) => {
                            const nextMode = val as IsolationMode
                            updateAgentMeta(agent.id, { isolationMode: nextMode })
                            setRuntimeLaunchConfig(runtimeBrandId, { isolationMode: nextMode })
                          }}
                          options={[
                            { value: 'worktree', label: 'worktree 独立工作树' },
                            { value: 'in_place', label: 'in_place 原地目录' }
                          ]}
                        />
                      </ConfigRow>
                      <Button size="sm" variant="ghost" className="self-start" onClick={() => setModule('runtimes')}>
                        前往机器与 Runtime 中心
                      </Button>
                    </div>
                  </div>
                </AccordionCard>
              </div>

              {/* 5. Git 仓库与设置 */}
              <div ref={(el) => { sectionRefs.current.git = el }}>
                <AccordionCard
                  icon={<FolderGit2 size={16} />}
                  title="Git 仓库与设置"
                  description="选择此 Agent 读写的仓库"
                  summary={agent.repositories.length > 0 ? `${agent.repositories.length} 个` : '无'}
                  expanded={Boolean(openSections.git)}
                  onToggle={() => toggleSection('git')}
                >
                  <div className="flex flex-col gap-3">
                    <div>
                      <div className="mb-2 text-my-xs font-medium text-my-primary">Git 仓库</div>
                      {agent.repositories.length > 0 && (
                        <div className="mb-2 space-y-1.5">
                          {agent.repositories.map((repo) => {
                            const repoBrand = inferAppBrandFromName(repo.name)
                            return (
                              <div key={repo.name} className="flex items-center justify-between gap-2 rounded-my-base bg-my-layer-1 px-2.5 py-1.5 text-my-xs">
                                <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-my-primary">
                                  {repoBrand ? <AppBrandIcon brand={repoBrand} size={13} /> : <GitBranch size={12} className="shrink-0 text-my-tertiary" />}
                                  <span className="truncate">{repo.name}</span>
                                </span>
                                <button
                                  type="button"
                                  aria-label={`移除仓库 ${repo.name}`}
                                  onClick={() => void saveAgentPatch({ repositories: agent.repositories.filter((r) => r.name !== repo.name) })}
                                  className="text-my-tertiary hover:text-my-danger-text"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {addingRepo ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            autoFocus
                            className={`${inputClass} flex-1 font-mono text-my-xs`}
                            value={repoDraft}
                            onChange={(e) => setRepoDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') void addGitRepo(repoDraft) }}
                            placeholder="输入仓库名称或本地路径"
                          />
                          <Button size="sm" variant="primary" disabled={!repoDraft.trim() || busy} onClick={() => void addGitRepo(repoDraft)}>添加</Button>
                          <Button size="sm" variant="ghost" onClick={() => { setAddingRepo(false); setRepoDraft('') }}>取消</Button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => setAddingRepo(true)}>
                            <Plus size={12} />添加 Git 仓库
                          </Button>
                          {hasIpc && (
                            <Button size="sm" variant="ghost" onClick={() => void pickGitRepoFolder()}>
                              选择本地目录
                            </Button>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="border-t border-my-line pt-3">
                      <button
                        type="button"
                        onClick={() => setAuthorOpen((v) => !v)}
                        className="flex w-full items-center justify-between text-my-xs font-medium text-my-primary"
                      >
                        <span>提交作者设置</span>
                        {authorOpen ? <ChevronDown size={14} className="text-my-tertiary" /> : <ChevronRight size={14} className="text-my-tertiary" />}
                      </button>
                      {authorOpen && (
                        <div className="mt-3 flex flex-col gap-3">
                          <ConfigRow label="提交人名称" hint="此空间 Git 提交使用的作者名称。">
                            <Select
                              className="w-48"
                              value={meta.gitAuthorMode}
                              onChange={(val) => updateAgentMeta(agent.id, { gitAuthorMode: val as GitAuthorMode })}
                              options={[
                                { value: 'user_and_agent', label: '使用者名 + Agent 名' },
                                { value: 'user', label: '任务指派人名称' },
                                { value: 'owner', label: 'Agent 所有者名称' },
                                { value: 'computer', label: '使用机器 git 配置' },
                                { value: 'manual', label: '手动指定作者' }
                              ]}
                            />
                          </ConfigRow>

                          {meta.gitAuthorMode === 'manual' && (
                            <div className="grid grid-cols-1 gap-2 rounded-my-base bg-my-layer-1 p-2.5">
                              <input
                                className={inputClass}
                                value={meta.gitAuthorName ?? ''}
                                onChange={(e) => updateAgentMeta(agent.id, { gitAuthorName: e.target.value })}
                                placeholder="提交作者名称"
                              />
                              <input
                                className={inputClass}
                                value={meta.gitAuthorEmail ?? ''}
                                onChange={(e) => updateAgentMeta(agent.id, { gitAuthorEmail: e.target.value })}
                                placeholder="提交作者邮箱"
                              />
                            </div>
                          )}

                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-my-xs font-medium text-my-primary">Co-authored-by 署名</div>
                              <div className="text-my-2xs text-my-tertiary">自动为 Agent 创建的 commit 附加协同作者署名。</div>
                            </div>
                            <Switch
                              label="Co-authored-by 署名"
                              checked={meta.coAuthoredBy ?? true}
                              onChange={(coAuthoredBy) => updateAgentMeta(agent.id, { coAuthoredBy })}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </AccordionCard>
              </div>

              {/* 6. 技能 (Skills) */}
              <div ref={(el) => { sectionRefs.current.skills = el }}>
                <AccordionCard
                  icon={<Wrench size={16} />}
                  title="技能 (Skills)"
                  description="选择此 Agent 可用的技能"
                  summary={agent.skillIds.length > 0 ? `${agent.skillIds.length} 项` : '无'}
                  expanded={Boolean(openSections.skills)}
                  onToggle={() => toggleSection('skills')}
                >
                  {availableSkills.length === 0 ? (
                    <div className="collab-empty-inset">
                      <div className="text-my-xs font-medium text-my-primary">尚未分配技能</div>
                      <div className="text-my-2xs text-my-tertiary">为此 Agent 附加技能；本地技能已自动生效。</div>
                      <Button size="sm" variant="primary" className="mt-1" onClick={() => { setCurrentSpace(agent.spaceId); setModule('skills') }}>
                        <Plus size={13} />添加技能
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {agent.skillIds.length === 0 && (
                        <div className="collab-empty-inset mb-1">
                          <div className="text-my-xs font-medium text-my-primary">尚未分配技能</div>
                          <div className="text-my-2xs text-my-tertiary">勾选下方空间技能立即附加；本地技能已自动生效。</div>
                        </div>
                      )}
                      {availableSkills.map((sk) => {
                        const checked = agent.skillIds.includes(sk.id)
                        return (
                          <label key={sk.id} className="flex cursor-pointer items-start gap-2.5 rounded-my-base border border-my-line bg-my-panel px-3 py-2 hover:border-my-line-strong">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={checked}
                              onChange={(e) => {
                                const nextIds = e.target.checked
                                  ? [...agent.skillIds, sk.id]
                                  : agent.skillIds.filter((id) => id !== sk.id)
                                void saveAgentPatch({ skillIds: nextIds })
                              }}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block text-my-xs font-medium text-my-primary">{sk.name}</span>
                              <span className="block text-my-2xs text-my-tertiary">{sk.description || '空间共享技能'}</span>
                            </span>
                          </label>
                        )
                      })}
                      <Button size="sm" variant="ghost" className="self-start" onClick={() => { setCurrentSpace(agent.spaceId); setModule('skills') }}>
                        管理技能库
                      </Button>
                    </div>
                  )}
                </AccordionCard>
              </div>

              {/* 7. 自动化 */}
              <div ref={(el) => { sectionRefs.current.automations = el }}>
                <AccordionCard
                  icon={<Zap size={16} />}
                  title="自动化"
                  description="附加到此 Agent 的时间计划和事件触发器"
                  summary={agentAutomations.length > 0 ? `${agentAutomations.length} 条` : '无'}
                  expanded={Boolean(openSections.automations)}
                  onToggle={() => toggleSection('automations')}
                >
                  {agentAutomations.length === 0 ? (
                    <div className="collab-empty-inset">
                      <div className="text-my-xs font-medium text-my-primary">暂无关联自动化</div>
                      <div className="text-my-2xs text-my-tertiary">创建定时巡检或任务事件触发器，让此 Agent 按计划自主工作。</div>
                      <Button size="sm" variant="primary" className="mt-1" onClick={() => { setCurrentSpace(agent.spaceId); setModule('automations') }}>
                        <Plus size={13} />配置 Agent 自动化
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {agentAutomations.map((auto) => (
                        <div key={auto.id} className="rounded-my-base border border-my-line bg-my-layer-1 p-2.5">
                          <div className="text-my-xs font-medium text-my-primary">{auto.name}</div>
                          <div className="mt-0.5 text-my-2xs text-my-tertiary">{auto.instruction || '按触发器自动执行'}</div>
                        </div>
                      ))}
                      <Button size="sm" variant="outline" onClick={() => { setCurrentSpace(agent.spaceId); setModule('automations') }}>
                        前往自动化中心
                      </Button>
                    </div>
                  )}
                </AccordionCard>
              </div>

              {/* 8. 底部独立「归档」卡片 */}
              <div className="collab-accordion-card flex min-h-16 items-center justify-between gap-3 px-3.5 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-my-base border border-my-line bg-my-layer-3 text-my-icon-secondary">
                    {agent.archived ? <RotateCcw size={15} /> : <Archive size={15} />}
                  </span>
                  <div className="min-w-0">
                    <div className="my-item-title truncate">{agent.archived ? '恢复此 Agent' : '归档'}</div>
                    <div
                      className="my-item-description mt-0.5 truncate"
                      title={
                        agent.archived
                          ? '恢复后，Agent 将重新出现在目录中并可接受任务指派。'
                          : '归档后，Agent 不再接受指派和提及；历史会保留，随时可以恢复。'
                      }
                    >
                      {agent.archived
                        ? '恢复后，Agent 将重新出现在目录中并可接受任务指派。'
                        : '归档后，Agent 不再接受指派和提及；历史会保留，随时可以恢复。'}
                    </div>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={agent.archived ? 'outline' : 'ghost'}
                  className={agent.archived ? 'shrink-0' : 'shrink-0 text-my-danger-text hover:bg-my-danger-subtle'}
                  disabled={busy}
                  onClick={() => void saveAgentPatch({ archived: !agent.archived, enabled: agent.archived ? true : false })}
                >
                  {agent.archived ? '恢复' : '归档'}
                </Button>
              </div>
            </>
          )}

          {tab === 'history' && (
            agentRuns.length === 0 ? (
              <EmptyState title="还没有可展示的运行" description="将任务指派给此 Agent 后，每次执行的日志、耗时与状态都会记录在这里。" />
            ) : (
              <div className="space-y-2">
                {agentRuns.map((entry) => {
                  const task = snapshot.tasks.find((t) => t.id === entry.taskId)
                  return (
                    <div key={entry.id} className="rounded-my-base border border-my-line bg-my-panel p-3 text-my-xs">
                      <div className="flex items-center justify-between gap-2">
                        <button type="button" onClick={() => onOpenTask(entry.taskId)} className="min-w-0 flex-1 truncate text-left font-medium text-my-primary hover:underline">
                          {entry.taskId} · {task?.title ?? '关联任务'}
                        </button>
                        <span className="my-chip">{RUN_STATUS_META[entry.status].label}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-my-2xs text-my-tertiary">{entry.summary || entry.prompt}</p>
                      <div className="mt-2 flex items-center justify-between text-my-2xs text-my-tertiary">
                        <span>{formatDateLabel(entry.createdAt)}</span>
                        <div className="flex gap-1.5">
                          {['queued', 'dispatched', 'running', 'waiting_local_directory'].includes(entry.status) ? (
                            <Button size="sm" variant="ghost" onClick={() => stopRun(entry.id)}>停止</Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => rerun(entry.id)}>重跑</Button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          )}

          {tab === 'tasks' && (
            delegatedTasks.length === 0 ? (
              <EmptyState title="暂无指派的任务" description="点击上方「+ 创建或指派任务」，把第一个工作交给该 Agent。" />
            ) : (
              <div className="space-y-1.5">
                {delegatedTasks.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onOpenTask(t.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-my-base border border-my-line bg-my-panel px-3 py-2.5 text-left hover:border-my-line-strong"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-my-2xs text-my-tertiary">{t.id}</span>
                      <span className="block truncate text-my-xs font-medium text-my-primary">{t.title}</span>
                    </span>
                    <StatusBadge status={statusOf(snapshot, t.statusId)} />
                  </button>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

function AccordionCard({
  icon,
  title,
  description,
  summary,
  expanded,
  onToggle,
  children
}: {
  icon: JSX.Element
  title: string
  description: string
  summary: ReactNode
  expanded: boolean
  onToggle: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <div className="collab-accordion-card" data-expanded={expanded || undefined}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="collab-accordion-trigger"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-my-base border border-my-line bg-my-layer-3 text-my-icon-secondary">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="my-item-title block truncate">{title}</span>
          <span className="my-item-description mt-0.5 block truncate" title={description}>{description}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-my-xs text-my-tertiary">
          {summary && <span className="inline-flex items-center">{summary}</span>}
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {expanded && <div className="collab-accordion-body">{children}</div>}
    </div>
  )
}

function TriggerRow({
  icon,
  label,
  checked,
  onChange
}: {
  icon: JSX.Element
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 text-my-xs">
      <span className="inline-flex items-center gap-2 text-my-secondary">
        <span className="text-my-icon-tertiary">{icon}</span>
        <span>{label}</span>
      </span>
      <Switch label={label} checked={checked} onChange={onChange} />
    </div>
  )
}

function ConfigRow({ label, hint, icon, children }: { label: string; hint?: string; icon?: JSX.Element; children: JSX.Element }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="inline-flex items-center gap-1.5 text-my-xs font-medium text-my-primary">
          {icon && <span className="text-my-icon-tertiary">{icon}</span>}
          <span>{label}</span>
        </div>
        {hint && <div className="text-my-2xs text-my-tertiary">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function formatDateLabel(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch {
    return iso
  }
}

function CrewInspectorDrawer({
  crew,
  expanded,
  onToggleExpand,
  onClose,
  onSelectAgent,
  onOpenAssignModal,
  onOpenTask,
  quickReplies,
  onSaveQuickReplies
}: {
  crew: CruxCrew
  expanded: boolean
  onToggleExpand: () => void
  onClose: () => void
  onSelectAgent: (agentId: string) => void
  onOpenAssignModal: () => void
  onOpenTask: (taskId: string) => void
  quickReplies: Array<{ id: string; label: string; prompt: string }>
  onSaveQuickReplies: (replies: Array<{ id: string; label: string; prompt: string }>) => void
}): JSX.Element | null {
  const { snapshot, busy, run } = useCrux()
  const runs = useTaskRuns((s) => s.runs)
  const [tab, setTab] = useState<'overview' | 'tasks'>('overview')
  const [replyLabel, setReplyLabel] = useState('')
  const [replyPrompt, setReplyPrompt] = useState('')
  if (!snapshot) return null

  const roster = [crew.captain, ...crew.members.filter((m) => !(m.kind === crew.captain.kind && m.id === crew.captain.id))]
  const tasks = snapshot.tasks.filter((t) => t.executor?.kind === 'crew' && t.executor.id === crew.id)
  const chatAgent = roster
    .filter((r) => r.kind === 'agent')
    .map((r) => snapshot.agents.find((a) => a.id === r.id && a.enabled && !a.archived))
    .find((a): a is CruxAgent => Boolean(a))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between px-4 pt-3 pb-1">
        <div className="flex items-center gap-1">
          <button type="button" aria-label="关闭抽屉" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-my-base text-my-icon-secondary hover:bg-my-layer-1"><X size={15} /></button>
          <button type="button" aria-label="切换宽度" onClick={onToggleExpand} className="grid h-7 w-7 place-items-center rounded-my-base text-my-icon-secondary hover:bg-my-layer-1">{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="text-my-danger-text hover:bg-my-danger-subtle"
          disabled={busy}
          onClick={() => void run('归档小队', () => api.crux.removeCrew({ id: crew.id }))}
        >
          <Archive size={13} />归档
        </Button>
      </header>

      <div className="collab-scroll flex min-h-0 flex-1 flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <span className="collab-tone-avatar grid h-11 w-11 shrink-0 place-items-center rounded-full" data-tone={identityTone(crew.name)}>
            <Users2 size={21} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-my-md font-semibold text-my-primary">{crew.name}</h2>
            <p className="mt-0.5 text-my-xs text-my-tertiary">{crew.description || '多 Agent 与成员协同小队'}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" className="flex-1 justify-center" onClick={onOpenAssignModal}>
            <Plus size={14} />创建或指派任务
          </Button>
          {chatAgent && (
            <Button
              size="sm"
              variant="outline"
              className="flex-1 justify-center"
              onClick={() => useAgentChatBridge.getState().startAgentChat(chatAgent.id, { runtimeKind: chatAgent.runtimeKind, workingDirectory: chatAgent.workingDirectory })}
            >
              <MessageCircle size={14} />小队对话
            </Button>
          )}
        </div>

        <div className="task-post-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')}>成员与约定</button>
          <button type="button" role="tab" aria-selected={tab === 'tasks'} onClick={() => setTab('tasks')}>指派任务 ({tasks.length})</button>
        </div>

        {tab === 'overview' ? (
          <div className="flex flex-col gap-3">
            <div className="space-y-2 rounded-my-base border border-my-line bg-my-panel p-3">
              <div className="text-my-xs font-medium text-my-primary">小队阵容 ({roster.length})</div>
              {roster.map((ref) => {
                const isCap = ref.kind === crew.captain.kind && ref.id === crew.captain.id
                if (ref.kind === 'agent') {
                  const ag = snapshot.agents.find((a) => a.id === ref.id)
                  const presence = ag ? computeAgentPresence(ag.id, runs, ag.enabled && !ag.archived) : null
                  return (
                    <button key={`a:${ref.id}`} type="button" onClick={() => ag && onSelectAgent(ag.id)} className="flex w-full items-center justify-between rounded-my-base bg-my-layer-1 px-2.5 py-2 text-left text-my-xs hover:bg-my-layer-2">
                      <span className="inline-flex items-center gap-2 font-medium text-my-primary">
                        {presence && <span className="collab-presence-dot" data-state={presence.state} />}
                        <Bot size={14} />{ag?.name ?? ref.name}
                      </span>
                      <span className="text-my-2xs text-my-tertiary">{isCap ? '队长' : (presence ? AGENT_PRESENCE_META[presence.state].label : 'Agent')}</span>
                    </button>
                  )
                }
                const mem = snapshot.members.find((m) => m.id === ref.id)
                return (
                  <div key={`m:${ref.id}`} className="flex items-center justify-between rounded-my-base bg-my-layer-1 px-2.5 py-2 text-my-xs">
                    <MemberChip member={mem} size="sm" />
                    <span className="text-my-2xs text-my-tertiary">{isCap ? '队长' : '成员'}</span>
                  </div>
                )
              })}
            </div>

            {crew.instructions && (
              <div className="rounded-my-base border border-my-line bg-my-panel p-3">
                <div className="mb-1 text-my-xs font-medium text-my-primary">协作约定</div>
                <p className="whitespace-pre-wrap text-my-xs text-my-secondary">{crew.instructions}</p>
              </div>
            )}

            <div className="space-y-2 rounded-my-base border border-my-line bg-my-panel p-3">
              <div className="text-my-xs font-medium text-my-primary">小队快捷指令</div>
              {quickReplies.map((qr) => (
                <div key={qr.id} className="flex items-center justify-between text-my-xs">
                  <span className="text-my-secondary">{qr.label}</span>
                  <button type="button" onClick={() => onSaveQuickReplies(quickReplies.filter((i) => i.id !== qr.id))} className="text-my-tertiary hover:text-my-danger-text"><Trash2 size={12} /></button>
                </div>
              ))}
              <div className="flex gap-1.5 pt-1">
                <input className={inputClass} value={replyLabel} onChange={(e) => setReplyLabel(e.target.value)} placeholder="快捷按钮名" />
                <input className={inputClass} value={replyPrompt} onChange={(e) => setReplyPrompt(e.target.value)} placeholder="指令内容" />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!replyLabel.trim() || !replyPrompt.trim()}
                  onClick={() => {
                    onSaveQuickReplies([...quickReplies, { id: `cqr-${Date.now()}`, label: replyLabel.trim(), prompt: replyPrompt.trim() }])
                    setReplyLabel('')
                    setReplyPrompt('')
                  }}
                >
                  添加
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            {tasks.length === 0 ? (
              <EmptyState title="尚未指派任务给该小队" description="点击上方「+ 创建或指派任务」即可把任务交由本小队协同完成。" />
            ) : (
              tasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onOpenTask(t.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-my-base border border-my-line bg-my-panel px-3 py-2 text-left hover:border-my-line-strong"
                >
                  <span className="min-w-0 flex-1 truncate text-my-xs font-medium text-my-primary">{t.id} · {t.title}</span>
                  <StatusBadge status={statusOf(snapshot, t.statusId)} />
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
