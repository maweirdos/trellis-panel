import { useEffect, useState } from 'react'
import { formatCollaborationTime } from '../ui'
import { ArrowRight, Bot, Cpu, Plus } from 'lucide-react'
import type { AcpAgentStatus } from '../../../../shared/types'
import { ensureRuntimeInventoryLoaded, getRuntimeInventorySnapshot, subscribeRuntimeInventory } from '../../acp/useRuntimeInventoryRefresh'
import { isTriagePending, useCrux, spaceTasks, statusOf } from '../store'
import { PageHeader, StatusBadge, selectSnapshotCount, MemberChip } from '../ui'
import { FlowIcon } from '../icons'
import { GetStartedWidget } from '../GetStartedWidget'
import { matchDetectedRuntime, useLocalExecutionSlot } from '../local-execution-slot'
import { AGENT_PRESENCE_META, computeAgentPresence, useTaskRuns } from '../task-run-store'
import { Button, EmptyState } from '../../my/ui'
import { SpaceEditor } from './SpacesPage'



export function OverviewPage(): JSX.Element {
  const snapshot = useCrux((s) => s.snapshot)
  const spaceId = useCrux((s) => s.currentSpaceId)
  const setModule = useCrux((s) => s.setModule)
  const openTask = useCrux((s) => s.openTask)
  const canManage = useCrux((s) => s.workspaceContext.canManage)
  const context = useCrux((s) => s.workspaceContext)
  const runs = useTaskRuns((s) => s.runs)
  const resolveAgentSlot = useLocalExecutionSlot((s) => s.resolveAgentSlot)
  const [detected, setDetected] = useState<AcpAgentStatus[]>(getRuntimeInventorySnapshot)
  const [creatingSpace, setCreatingSpace] = useState(false)
  useEffect(() => {
    const unsub = subscribeRuntimeInventory(setDetected)
    void ensureRuntimeInventoryLoaded()
    return unsub
  }, [])
  if (!snapshot) return <></>
  const space = snapshot.spaces.find((s) => s.id === spaceId)
  if (!space) return <div className="flex min-h-0 flex-1 flex-col">
    <PageHeader title="协作概览" />
    <div className="my-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto" aria-label="空间为空">
      <EmptyState
        title={canManage ? '还没有空间' : '还没有加入空间'}
        action={(
          <>
            {canManage && <Button variant="primary" onClick={() => setCreatingSpace(true)}>创建空间</Button>}
            <Button variant={canManage ? 'outline' : 'primary'} onClick={() => setModule('spaces')}>浏览空间</Button>
          </>
        )}
      />
    </div>
    {creatingSpace && canManage && <SpaceEditor onClose={() => setCreatingSpace(false)} />}
  </div>
  const tasks = spaceTasks(snapshot, space.id)
  const counts = selectSnapshotCount(snapshot, space.id)
  const activeVersions = snapshot.iterations.filter((it) => it.spaceId === space.id && it.status === 'active')
  const pendingVersions = snapshot.iterations.filter((it) => it.spaceId === space.id && it.status === 'pending')
  const actor = context.actorId ?? (context.state === 'local' ? snapshot.members.find((member) => member.role === 'owner')?.id : undefined)
  const canCreateTask = Boolean(actor && !space.archived && space.memberIds.includes(actor) && (context.state === 'local' || context.state === 'connected'))
  const attention = tasks.filter((task) => ['blocked', 'in_review'].includes(statusOf(snapshot, task.statusId)?.category ?? ''))
  const activities = snapshot.activities.filter((a) => tasks.some((t) => t.id === a.taskId)).slice(0, 6)
  const triage = tasks.filter((t) => isTriagePending(snapshot, t)).length
  const spaceAgents = snapshot.agents.filter((agent) => agent.spaceId === space.id && !agent.archived && agent.enabled)
  return <div className="my-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
    <PageHeader
      title={`${space.name} · 协作概览`}
      description={space.description}
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setModule('runtimes')}><Cpu size={14} />电脑与 Runtime</Button>
          {canCreateTask && <Button variant="primary" size="sm" onClick={() => useCrux.getState().beginCreateTask({ spaceId: space.id })}><Plus size={14} />新建任务</Button>}
        </div>
      }
    />
    <GetStartedWidget variant="overview" />
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {[{ label: '全部任务', value: counts.tasks, detail: `已完成 ${counts.done}`, icon: 'tasks' as const, go: 'tasks' as const }, { label: '待分拣', value: triage, detail: null, icon: 'triage' as const, go: 'triage' as const }, { label: '进行中版本', value: activeVersions.length, detail: pendingVersions.length ? `待开始 ${pendingVersions.length}` : null, icon: 'iterations' as const, go: 'iterations' as const }, { label: '空间成员', value: counts.members, detail: counts.agents ? <span className="inline-flex items-center gap-1 tabular-nums"><Bot size={13} />{counts.agents}</span> : null, icon: 'members' as const, go: 'members' as const }].map((card) => <button key={card.label} type="button" onClick={() => setModule(card.go)} className="flex min-w-0 flex-col gap-2 rounded-my-md border border-my-line bg-my-layer-1 p-3 text-left shadow-[var(--my-surface-rim),var(--my-shadow-raised-100)] transition-[transform,background-color,border-color] duration-150 hover:border-my-line-strong hover:bg-my-layer-1-hover active:translate-y-[var(--my-tactile-press-y)] active:scale-[var(--my-tactile-press-scale)]"><span className="flex items-center gap-2 text-my-xs text-my-secondary"><FlowIcon name={card.icon} size={18} />{card.label}</span><strong className="collab-stat text-my-xl text-my-primary">{card.value}</strong>{card.detail && <span className="truncate text-my-xs text-my-tertiary">{card.detail}</span>}</button>)}
    </div>
    {spaceAgents.length > 0 && (
      <section className="rounded-my-base border border-my-line bg-my-panel p-4" aria-label="空间 Agent 实时状态">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="my-item-title flex items-center gap-2"><Bot size={15} className="text-my-icon-secondary" />Agent 实时状态与队列</h2>
          <button type="button" onClick={() => setModule('agents')} className="inline-flex items-center gap-1 text-my-xs text-my-secondary hover:underline">管理 Agent<ArrowRight size={13} /></button>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {spaceAgents.slice(0, 6).map((agent) => {
            const slot = resolveAgentSlot(agent.id, { runtimeKind: agent.runtimeKind, workingDirectory: agent.workingDirectory })
            const matched = matchDetectedRuntime(detected, slot.slot.runtimeKind)
            const runtimeReady = Boolean(matched && matched.available && !matched.setupRequired)
            const presence = computeAgentPresence(agent.id, runs, runtimeReady)
            const meta = AGENT_PRESENCE_META[presence.state]
            const toneClass = meta.tone === 'success' ? 'bg-my-success-subtle text-my-success-text'
              : meta.tone === 'info' ? 'bg-my-info-subtle text-my-info-text'
                : meta.tone === 'warning' ? 'bg-my-warning-subtle text-my-warning-text'
                  : meta.tone === 'danger' ? 'bg-my-danger-subtle text-my-danger-text'
                    : 'bg-my-layer-3 text-my-tertiary'
            return (
              <div key={agent.id} className="flex items-center justify-between gap-2 rounded-my-base border border-my-line bg-my-layer-1 px-3 py-2">
                <div className="min-w-0">
                  <p className="my-item-title truncate">{agent.name}</p>
                  <p className="my-item-description truncate">{presence.activeRun ? `执行中：${presence.activeRun.taskId}` : agent.description || '待命接单'}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className={`rounded-my-sm px-1.5 py-0.5 text-my-2xs font-medium ${toneClass}`}>{meta.label}</span>
                  {presence.queuedCount > 0 && <span className="my-chip tabular-nums">+{presence.queuedCount} 排队</span>}
                </div>
              </div>
            )
          })}
        </div>
      </section>
    )}
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <section className="rounded-my-md border border-my-line p-4"><h2 className="mb-3 flex items-center gap-2 text-my-sm font-medium text-my-primary"><FlowIcon name="review" size={18} />需要团队关注<span className="ml-auto text-my-xs tabular-nums text-my-tertiary">{attention.length}</span></h2>
        {attention.length === 0 ? <p className="text-my-xs text-my-tertiary">暂无受阻或等待评审的任务。</p> : <ul className="space-y-1">{attention.slice(0, 6).map((task) => <li key={task.id}><button type="button" onClick={() => openTask(task.id)} className="flex w-full items-center gap-2 rounded-my-md px-2 py-2 text-left transition-colors hover:bg-my-layer-transparent-hover"><span className="font-mono text-my-2xs text-my-tertiary">{task.id}</span><span className="min-w-0 flex-1 truncate text-my-sm text-my-secondary">{task.title}</span><StatusBadge status={statusOf(snapshot, task.statusId)} /></button></li>)}</ul>}
      </section>
      <section className="rounded-my-md border border-my-line p-4"><h2 className="mb-3 flex items-center gap-2 text-my-sm font-medium text-my-primary"><FlowIcon name="activity" size={18} />最近协作记录</h2>
        {activities.length === 0 ? <p className="text-my-xs text-my-tertiary">暂无动态</p> : <ul className="space-y-3">{activities.map((activity) => <li key={activity.id} className="flex items-start gap-2 text-my-xs"><button type="button" onClick={() => openTask(activity.taskId)} className="shrink-0 font-mono text-my-secondary hover:underline">{activity.taskId}</button><span className="min-w-0 flex-1 break-words text-my-secondary">{activity.text}</span><span className="shrink-0 tabular-nums text-my-tertiary">{formatCollaborationTime(activity.at)}</span></li>)}</ul>}
      </section>
    </div>
    <section className="flex flex-wrap items-center gap-3 border-t border-my-line pt-3"><span className="text-my-xs text-my-tertiary">空间同事</span>{space.memberIds.map((id) => <MemberChip key={id} member={snapshot.members.find((m) => m.id === id)} />)}<button type="button" onClick={() => setModule('members')} className="ml-auto inline-flex items-center gap-1 text-my-xs text-my-secondary hover:underline">管理同事<ArrowRight size={13} /></button></section>
  </div>
}
