import { useEffect, useMemo, useState, type JSX } from 'react'
import { AlertTriangle, BarChart3, CheckCircle2, Clock, Users } from 'lucide-react'
import type { CruxPriority } from '@shared/crux'
import type { AcpAgentStatus } from '../../../../shared/types'
import { ensureRuntimeInventoryLoaded, getRuntimeInventorySnapshot, subscribeRuntimeInventory } from '../../acp/useRuntimeInventoryRefresh'
import { PriorityIcon, StateGroupIcon } from '../../my/icons'
import { Button, EmptyState, TriProgressBar } from '../../my/ui'
import { AgentAvatar } from '../AgentAvatar'
import { matchDetectedRuntime, useLocalExecutionSlot } from '../local-execution-slot'
import { PRIORITY_LABEL, spaceTasks, statusDisplayName, statusOf, useCrux } from '../store'
import { AGENT_PRESENCE_META, computeAgentPresence, isActiveRunStatus, useTaskRuns } from '../task-run-store'
import { CRUX_STATE_GROUPS, cruxStatusColor } from '../task-workspace-adapter'
import { MemberChip, PageHeader } from '../ui'

const PRIORITY_ORDER: CruxPriority[] = ['urgent', 'high', 'medium', 'low', 'none']

export function AnalyticsPage(): JSX.Element | null {
  const snapshot = useCrux((s) => s.snapshot)
  const currentSpaceId = useCrux((s) => s.currentSpaceId)
  const setModule = useCrux((s) => s.setModule)
  const runs = useTaskRuns((s) => s.runs)
  const resolveAgentSlot = useLocalExecutionSlot((s) => s.resolveAgentSlot)
  const [detectedRuntimes, setDetectedRuntimes] = useState<AcpAgentStatus[]>(getRuntimeInventorySnapshot)

  useEffect(() => {
    const unsubscribe = subscribeRuntimeInventory(setDetectedRuntimes)
    void ensureRuntimeInventoryLoaded()
    return unsubscribe
  }, [])

  const stats = useMemo(() => {
    if (!snapshot) return null
    const tasks = spaceTasks(snapshot, currentSpaceId)
    const space = snapshot.spaces.find((item) => item.id === currentSpaceId)
    const members = space
      ? snapshot.members.filter((member) => space.memberIds.includes(member.id))
      : snapshot.members
    const agents = snapshot.agents.filter((agent) => (!currentSpaceId || agent.spaceId === currentSpaceId) && !agent.archived)

    let done = 0
    let inProgress = 0
    let blocked = 0
    const statusBuckets = new Map<string, { id: string; name: string; category: keyof typeof CRUX_STATE_GROUPS; count: number }>()
    const priorityCounts: Record<CruxPriority, number> = { urgent: 0, high: 0, medium: 0, low: 0, none: 0 }

    for (const task of tasks) {
      priorityCounts[task.priority]++
      const st = statusOf(snapshot, task.statusId)
      if (!st) continue
      if (st.category === 'done') done++
      else if (st.category === 'in_progress' || st.category === 'in_review') inProgress++
      else if (st.category === 'blocked') blocked++

      const existing = statusBuckets.get(st.id)
      if (existing) existing.count++
      else statusBuckets.set(st.id, { id: st.id, name: statusDisplayName(st), category: st.category, count: 1 })
    }

    const memberLoads = members.map((member) => {
      const assigned = tasks.filter((task) => task.assigneeIds.includes(member.id))
      const finished = assigned.filter((task) => statusOf(snapshot, task.statusId)?.category === 'done').length
      const active = assigned.filter((task) => {
        const category = statusOf(snapshot, task.statusId)?.category
        return category === 'in_progress' || category === 'in_review'
      }).length
      return { member, total: assigned.length, done: finished, inProgress: active }
    })

    const spaceRuns = runs.filter((run) => !currentSpaceId || run.spaceId === currentSpaceId)
    const activeRuns = spaceRuns.filter((run) => isActiveRunStatus(run.status)).length

    return {
      total: tasks.length,
      done,
      inProgress,
      blocked,
      completionRate: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
      statusList: Array.from(statusBuckets.values()).sort((a, b) => b.count - a.count),
      priorityCounts,
      memberLoads,
      agents,
      activeRuns,
      totalRuns: spaceRuns.length
    }
  }, [snapshot, currentSpaceId, runs])

  if (!snapshot || !stats) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <PageHeader
        title="统计分析"
        description="基于当前空间实时任务快照、成员负载与 Agent 运行记录生成的统计视图。"
        actions={
          <Button size="sm" variant="outline" onClick={() => setModule('tasks')}>
            返回任务列表
          </Button>
        }
      />

      {stats.total === 0 ? (
        <EmptyState
          icon={<BarChart3 size={28} />}
          title="暂无可统计的任务数据"
          description="创建并推进首批任务后，这里将自动呈现完成率、状态分布及成员负载均衡。"
          action={
            <Button size="sm" variant="primary" onClick={() => setModule('tasks')}>
              前往任务工作区
            </Button>
          }
        />
      ) : (
        <div className="my-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="统计核心指标">
            <div className="my-card flex flex-col gap-2 p-4">
              <span className="flex items-center gap-1.5 text-my-xs text-my-secondary">
                <CheckCircle2 size={14} className="text-my-success-text" />
                <span>总体完成率</span>
              </span>
              <strong className="collab-stat text-my-xl font-medium tabular-nums text-my-primary">
                {stats.completionRate}%
              </strong>
              <span className="text-my-xs tabular-nums text-my-tertiary">
                已完成 {stats.done} / {stats.total} 项
              </span>
            </div>

            <div className="my-card flex flex-col gap-2 p-4">
              <span className="flex items-center gap-1.5 text-my-xs text-my-secondary">
                <Clock size={14} className="text-my-info-text" />
                <span>推进中任务</span>
              </span>
              <strong className="collab-stat text-my-xl font-medium tabular-nums text-my-primary">
                {stats.inProgress}
              </strong>
              <span className="text-my-xs text-my-tertiary">包含进行中与待评审状态</span>
            </div>

            <div className="my-card flex flex-col gap-2 p-4">
              <span className="flex items-center gap-1.5 text-my-xs text-my-secondary">
                <AlertTriangle size={14} className={stats.blocked > 0 ? 'text-my-danger-text' : 'text-my-tertiary'} />
                <span>受阻待解除</span>
              </span>
              <strong className="collab-stat text-my-xl font-medium tabular-nums text-my-primary">
                {stats.blocked}
              </strong>
              <span className="text-my-xs text-my-tertiary">
                {stats.blocked > 0 ? '建议优先排查依赖阻塞' : '当前无受阻任务'}
              </span>
            </div>

            <div className="my-card flex flex-col gap-2 p-4">
              <span className="flex items-center gap-1.5 text-my-xs text-my-secondary">
                <Users size={14} className="text-my-secondary" />
                <span>AI 执行记录</span>
              </span>
              <strong className="collab-stat text-my-xl font-medium tabular-nums text-my-primary">
                {stats.totalRuns}
              </strong>
              <span className="text-my-xs tabular-nums text-my-tertiary">
                当前运行中 {stats.activeRuns} 条
              </span>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="my-card flex flex-col gap-3 p-4">
              <header className="flex items-center justify-between">
                <h2 className="my-item-title text-my-sm font-medium text-my-primary">状态分布</h2>
                <span className="text-my-xs tabular-nums text-my-tertiary">共 {stats.total} 项</span>
              </header>
              <ul className="space-y-2.5">
                {stats.statusList.map((bucket) => {
                  const pct = Math.round((bucket.count / stats.total) * 100)
                  const color = cruxStatusColor(bucket.category)
                  return (
                    <li key={bucket.id} className="space-y-1">
                      <div className="flex items-center justify-between text-my-xs">
                        <span className="inline-flex items-center gap-1.5 text-my-primary">
                          <StateGroupIcon stateGroup={CRUX_STATE_GROUPS[bucket.category]} size={13} color={color} />
                          <span>{bucket.name}</span>
                        </span>
                        <span className="tabular-nums text-my-secondary">
                          {bucket.count} ({pct}%)
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-my-layer-1">
                        <div
                          className="h-full rounded-full transition-[width] duration-200 ease-out"
                          style={{ width: `${pct}%`, backgroundColor: color }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>

            <section className="my-card flex flex-col gap-3 p-4">
              <header className="flex items-center justify-between">
                <h2 className="my-item-title text-my-sm font-medium text-my-primary">优先级构成</h2>
                <span className="text-my-xs text-my-tertiary">按任务数量</span>
              </header>
              <ul className="space-y-2.5">
                {PRIORITY_ORDER.map((priority) => {
                  const count = stats.priorityCounts[priority]
                  const pct = Math.round((count / stats.total) * 100)
                  return (
                    <li key={priority} className="space-y-1">
                      <div className="flex items-center justify-between text-my-xs">
                        <span className="inline-flex items-center gap-1.5 text-my-primary">
                          <PriorityIcon priority={priority} size={13} />
                          <span>{PRIORITY_LABEL[priority]}</span>
                        </span>
                        <span className="tabular-nums text-my-secondary">
                          {count} ({pct}%)
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-my-layer-1">
                        <div
                          className="h-full rounded-full bg-my-accent transition-[width] duration-200 ease-out"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="my-card flex flex-col gap-3 p-4">
              <header className="flex items-center justify-between">
                <h2 className="my-item-title text-my-sm font-medium text-my-primary">成员任务负载</h2>
                <span className="text-my-xs tabular-nums text-my-tertiary">{stats.memberLoads.length} 人</span>
              </header>
              {stats.memberLoads.length === 0 ? (
                <p className="py-4 text-center text-my-xs text-my-tertiary">当前空间暂无成员数据。</p>
              ) : (
                <ul className="space-y-3">
                  {stats.memberLoads.map((entry) => (
                    <li key={entry.member.id} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-my-xs">
                        <MemberChip member={entry.member} />
                        <span className="tabular-nums text-my-secondary">
                          完成 {entry.done} · 推进中 {entry.inProgress} · 共 {entry.total}
                        </span>
                      </div>
                      <TriProgressBar
                        total={entry.total}
                        done={entry.done}
                        started={entry.inProgress}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="my-card flex flex-col gap-3 p-4">
              <header className="flex items-center justify-between">
                <h2 className="my-item-title text-my-sm font-medium text-my-primary">Agent 在线状态</h2>
                <Button size="sm" variant="ghost" onClick={() => setModule('agents')}>
                  管理 Agent
                </Button>
              </header>
              {stats.agents.length === 0 ? (
                <p className="py-4 text-center text-my-xs text-my-tertiary">当前空间暂无配置的 Agent。</p>
              ) : (
                <ul className="space-y-1.5">
                  {stats.agents.map((agent) => {
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
                      <li key={agent.id} className="flex items-center gap-2.5 rounded-my-base px-2 py-1.5">
                        <AgentAvatar avatarId={agent.avatarId} size={24} />
                        <span className="min-w-0 flex-1 truncate text-my-sm text-my-primary">{agent.name}</span>
                        <span className="text-my-2xs text-my-tertiary">{agent.runtimeKind}</span>
                        <span className={`rounded-my-base px-1.5 py-0.5 text-my-2xs ${toneClass}`}>{meta.label}</span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  )
}
