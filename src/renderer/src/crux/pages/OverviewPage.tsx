import { useEffect, useState, type JSX } from 'react'
import { ArrowRight, Bot, Cpu, Plus } from 'lucide-react'
import type { AcpAgentStatus } from '../../../../shared/types'
import { ensureRuntimeInventoryLoaded, getRuntimeInventorySnapshot, subscribeRuntimeInventory } from '../../acp/useRuntimeInventoryRefresh'
import { Button, EmptyState } from '../../my/ui'
import { AgentAvatar } from '../AgentAvatar'
import { GetStartedWidget } from '../GetStartedWidget'
import { FlowIcon } from '../icons'
import { matchDetectedRuntime, useLocalExecutionSlot } from '../local-execution-slot'
import { isTriagePending, spaceTasks, statusOf, useCrux } from '../store'
import { AGENT_PRESENCE_META, computeAgentPresence, useTaskRuns } from '../task-run-store'
import { formatCollaborationTime, PageHeader, selectSnapshotCount, StatusBadge } from '../ui'
import { SpaceEditor } from './SpacesPage'

export function OverviewPage(): JSX.Element | null {
  const snapshot = useCrux((s) => s.snapshot)
  const currentSpaceId = useCrux((s) => s.currentSpaceId)
  const setModule = useCrux((s) => s.setModule)
  const openTask = useCrux((s) => s.openTask)
  const canManage = useCrux((s) => s.workspaceContext.canManage)
  const context = useCrux((s) => s.workspaceContext)
  const runs = useTaskRuns((s) => s.runs)
  const resolveAgentSlot = useLocalExecutionSlot((s) => s.resolveAgentSlot)
  const [creatingSpace, setCreatingSpace] = useState(false)
  const [detectedRuntimes, setDetectedRuntimes] = useState<AcpAgentStatus[]>(getRuntimeInventorySnapshot)

  useEffect(() => {
    const unsubscribe = subscribeRuntimeInventory(setDetectedRuntimes)
    void ensureRuntimeInventoryLoaded()
    return unsubscribe
  }, [])

  if (!snapshot) return null

  const space = snapshot.spaces.find((item) => item.id === currentSpaceId) ?? snapshot.spaces[0] ?? null
  if (!space) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-5">
        <PageHeader title="概览" description="查看当前空间的推进进度、待处理入口与团队运行概况。" />
        <EmptyState
          icon={<FlowIcon name="overview" size={28} />}
          title={canManage ? '还没有空间' : '还没有加入空间'}
          description={canManage ? '创建一个协作空间来组织任务、迭代与 Agent 执行。' : '浏览并加入公开空间，或联系管理员为你开通权限。'}
          action={
            <div className="flex items-center gap-2">
              {canManage && <Button variant="primary" size="sm" onClick={() => setCreatingSpace(true)}>创建空间</Button>}
              <Button variant={canManage ? 'outline' : 'primary'} size="sm" onClick={() => setModule('spaces')}>浏览空间</Button>
            </div>
          }
        />
        {creatingSpace && canManage && <SpaceEditor onClose={() => setCreatingSpace(false)} />}
      </div>
    )
  }

  const tasks = spaceTasks(snapshot, space.id)
  const counts = selectSnapshotCount(snapshot, space.id)
  const triage = tasks.filter((task) => isTriagePending(snapshot, task)).length
  const iterations = snapshot.iterations.filter((item) => item.spaceId === space.id)
  const activeVersions = iterations.filter((item) => item.status === 'active')
  const pendingVersions = iterations.filter((item) => item.status === 'pending')
  const canCreateTask = !space.archived && (canManage || !context.actorId || space.memberIds.includes(context.actorId))

  const activeAgents = snapshot.agents.filter((agent) => agent.spaceId === space.id && agent.enabled && !agent.archived)
  const attention = tasks
    .filter((task) => {
      const cat = statusOf(snapshot, task.statusId)?.category
      return cat === 'blocked' || cat === 'in_review'
    })
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

  const taskIds = new Set(tasks.map((task) => task.id))
  const activities = snapshot.activities
    .filter((item) => taskIds.has(item.taskId))
    .slice()
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 6)

  const summaryCards = [
    { label: '全部任务', value: counts.tasks, detail: `已完成 ${counts.done}`, icon: 'tasks' as const, go: 'tasks' as const },
    { label: '待分拣', value: triage, detail: triage > 0 ? '等待分拣确认' : '已全部处置', icon: 'triage' as const, go: 'triage' as const },
    { label: '进行中版本', value: activeVersions.length, detail: pendingVersions.length ? `待开始 ${pendingVersions.length}` : '暂无待开始版本', icon: 'iterations' as const, go: 'iterations' as const },
    { label: '空间成员', value: counts.members, detail: `${counts.agents} 个可用 Agent`, icon: 'members' as const, go: 'members' as const }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <PageHeader
        title="概览"
        description={`${space.name} · 空间推进态势与快速入口`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setModule('runtimes')}>
              <Cpu size={14} />
              <span>电脑与 Runtime</span>
            </Button>
            {canCreateTask && (
              <Button variant="primary" size="sm" onClick={() => useCrux.getState().beginCreateTask({ spaceId: space.id })}>
                <Plus size={14} />
                <span>新建任务</span>
              </Button>
            )}
          </div>
        }
      />

      <div className="my-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
        <GetStartedWidget />

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="空间核心指标">
        {summaryCards.map((card) => (
          <button
            key={card.label}
            type="button"
            onClick={() => setModule(card.go)}
            className="my-card flex min-w-0 flex-col gap-2 p-4 text-left transition-[transform,background-color,border-color] duration-150 ease-out hover:border-my-line-strong hover:bg-my-layer-1-hover active:translate-y-[var(--my-tactile-press-y)] active:scale-[var(--my-tactile-press-scale)]"
          >
            <span className="flex items-center gap-2 text-my-xs text-my-secondary">
              <FlowIcon name={card.icon} size={15} />
              <span className="truncate">{card.label}</span>
            </span>
            <strong className="collab-stat text-my-xl font-medium tabular-nums text-my-primary">{card.value}</strong>
            <span className="truncate text-my-xs text-my-tertiary">{card.detail}</span>
          </button>
        ))}
      </section>

      <div className="grid min-h-0 gap-4 lg:grid-cols-3">
        <section className="my-card flex min-w-0 flex-col gap-3 p-4">
          <header className="flex items-center justify-between gap-2">
            <h2 className="my-item-title text-my-sm font-medium text-my-primary">Agent 运行态势</h2>
            <Button variant="ghost" size="sm" onClick={() => setModule('agents')}>
              <span>管理</span>
              <ArrowRight size={13} />
            </Button>
          </header>
          {activeAgents.length === 0 ? (
            <p className="py-4 text-center text-my-xs text-my-tertiary">当前空间暂无启用的 Agent。</p>
          ) : (
            <ul className="space-y-1.5">
              {activeAgents.slice(0, 6).map((agent) => {
                const resolved = resolveAgentSlot(agent.id, { runtimeKind: agent.runtimeKind, workingDirectory: agent.workingDirectory }).slot
                const matched = matchDetectedRuntime(detectedRuntimes, resolved.runtimeKind, resolved.runtimeId)
                const presence = computeAgentPresence(agent.id, runs, Boolean(matched?.available && !matched?.setupRequired))
                const meta = AGENT_PRESENCE_META[presence.state]
                const toneClass =
                  meta.tone === 'success'
                    ? 'bg-my-success-subtle text-my-success-text'
                    : meta.tone === 'info'
                      ? 'bg-my-info-subtle text-my-info-text'
                      : meta.tone === 'warning'
                        ? 'bg-my-warning-subtle text-my-warning-text'
                        : meta.tone === 'danger'
                          ? 'bg-my-danger-subtle text-my-danger-text'
                          : 'bg-my-layer-1 text-my-tertiary'
                return (
                  <li key={agent.id} className="flex items-center gap-2.5 rounded-my-base px-2 py-1.5 transition-colors hover:bg-my-layer-1">
                    <AgentAvatar avatarId={agent.avatarId} size={24} />
                    <span className="min-w-0 flex-1 truncate text-my-sm text-my-primary">{agent.name}</span>
                    <span className={`inline-flex shrink-0 items-center gap-1 rounded-my-base px-1.5 py-0.5 text-my-2xs ${toneClass}`}>
                      <Bot size={11} />
                      <span>{meta.label}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="my-card flex min-w-0 flex-col gap-3 p-4">
          <header className="flex items-center justify-between gap-2">
            <h2 className="my-item-title text-my-sm font-medium text-my-primary">重点关注任务</h2>
            <span className="text-my-xs tabular-nums text-my-tertiary">{attention.length}</span>
          </header>
          {attention.length === 0 ? (
            <p className="py-4 text-center text-my-xs text-my-tertiary">暂无受阻或待评审任务。</p>
          ) : (
            <ul className="space-y-1">
              {attention.slice(0, 6).map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => openTask(task.id)}
                    className="flex w-full items-center gap-2 rounded-my-base px-2 py-1.5 text-left transition-colors hover:bg-my-layer-1"
                  >
                    <span className="shrink-0 font-mono text-my-2xs text-my-tertiary">{task.id}</span>
                    <span className="min-w-0 flex-1 truncate text-my-sm text-my-primary">{task.title}</span>
                    <StatusBadge status={statusOf(snapshot, task.statusId)} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="my-card flex min-w-0 flex-col gap-3 p-4">
          <header className="flex items-center justify-between gap-2">
            <h2 className="my-item-title text-my-sm font-medium text-my-primary">最近动态</h2>
            <span className="text-my-xs tabular-nums text-my-tertiary">{activities.length}</span>
          </header>
          {activities.length === 0 ? (
            <p className="py-4 text-center text-my-xs text-my-tertiary">暂无空间动态。</p>
          ) : (
            <ul className="space-y-2.5">
              {activities.map((activity) => (
                <li key={activity.id} className="flex items-start gap-2 text-my-xs">
                  <button
                    type="button"
                    onClick={() => openTask(activity.taskId)}
                    className="shrink-0 rounded-my-base bg-my-layer-1 px-1.5 py-0.5 font-mono text-my-2xs text-my-secondary transition-colors hover:bg-my-layer-2 hover:text-my-primary"
                  >
                    {activity.taskId}
                  </button>
                  <span className="min-w-0 flex-1 break-words text-my-secondary">{activity.text}</span>
                  <span className="shrink-0 tabular-nums text-my-tertiary">{formatCollaborationTime(activity.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      </div>
    </div>
  )
}
