import { useMemo, type JSX } from 'react'
import { AlertTriangle, Bot, CheckCircle2, Clock, Play, Users } from 'lucide-react'
import { Button, EmptyState, TriProgressBar } from '../../my/ui'
import { statusOf, useCrux } from '../store'
import { AGENT_PRESENCE_META, computeAgentPresence, isActiveRunStatus, useTaskRuns } from '../task-run-store'
import { MemberChip, PageHeader, StatusBadge } from '../ui'

const TONE_CLASS: Record<'neutral' | 'info' | 'warning' | 'success' | 'danger', string> = {
  neutral: 'bg-my-layer-2 text-my-tertiary',
  info: 'bg-my-info-subtle text-my-info-text',
  warning: 'bg-my-warning-subtle text-my-warning-text',
  success: 'bg-my-success-subtle text-my-success-text',
  danger: 'bg-my-danger-subtle text-my-danger-text'
}

const CATEGORY_ORDER = ['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'] as const
const CATEGORY_LABEL: Record<string, string> = {
  triage: '待分拣',
  backlog: '待规划',
  todo: '待开始',
  in_progress: '进行中',
  in_review: '待评审',
  blocked: '已受阻',
  done: '已完成',
  cancelled: '已取消'
}

export function AnalyticsPage(): JSX.Element | null {
  const snapshot = useCrux((state) => state.snapshot)
  const spaceId = useCrux((state) => state.currentSpaceId)
  const openTask = useCrux((state) => state.openTask)
  const setModule = useCrux((state) => state.setModule)
  const runs = useTaskRuns((state) => state.runs)

  const metrics = useMemo(() => {
    if (!snapshot || !spaceId) return null
    const tasks = snapshot.tasks.filter((task) => task.spaceId === spaceId)
    const spaceRuns = runs.filter((run) => run.spaceId === spaceId)
    const done = tasks.filter((task) => statusOf(snapshot, task.statusId)?.category === 'done')
    const inProgress = tasks.filter((task) => ['in_progress', 'in_review'].includes(statusOf(snapshot, task.statusId)?.category ?? ''))
    const blocked = tasks.filter((task) => statusOf(snapshot, task.statusId)?.category === 'blocked')
    const triage = tasks.filter((task) => task.triagePending === true)
    const aiDelegated = tasks.filter((task) => Boolean(task.executor))
    const activeRuns = spaceRuns.filter((run) => isActiveRunStatus(run.status))
    const waitingRuns = spaceRuns.filter((run) => (run.interaction && !run.interaction.resolvedAt) || run.status === 'waiting_local_directory')
    const completedRuns = spaceRuns.filter((run) => run.status === 'completed')
    const failedRuns = spaceRuns.filter((run) => run.status === 'failed')

    const byCategory = CATEGORY_ORDER.map((category) => {
      const count = tasks.filter((task) => {
        if (category === 'triage') return task.triagePending === true
        return !task.triagePending && statusOf(snapshot, task.statusId)?.category === category
      }).length
      return { category, label: CATEGORY_LABEL[category], count }
    }).filter((entry) => entry.count > 0)

    const space = snapshot.spaces.find((item) => item.id === spaceId)
    const memberLoads = snapshot.members
      .filter((member) => space?.memberIds.includes(member.id))
      .map((member) => {
        const assigned = tasks.filter((task) => task.assigneeIds.includes(member.id))
        const memberDone = assigned.filter((task) => statusOf(snapshot, task.statusId)?.category === 'done').length
        const memberActive = assigned.filter((task) => ['in_progress', 'in_review', 'blocked'].includes(statusOf(snapshot, task.statusId)?.category ?? '')).length
        return { member, total: assigned.length, done: memberDone, active: memberActive }
      })
      .sort((a, b) => b.active - a.active || b.total - a.total)

    const agentLoads = snapshot.agents
      .filter((agent) => agent.spaceId === spaceId && !agent.archived)
      .map((agent) => {
        const assigned = tasks.filter((task) => task.executor?.kind === 'agent' && task.executor.id === agent.id)
        const agentRuns = spaceRuns.filter((run) => run.executorKind === 'agent' && run.executorId === agent.id)
        const succeeded = agentRuns.filter((run) => run.status === 'completed').length
        const presence = computeAgentPresence(agent.id, spaceRuns, agent.enabled)
        return { agent, assignedCount: assigned.length, runCount: agentRuns.length, succeeded, presence }
      })
      .sort((a, b) => b.runCount - a.runCount || b.assignedCount - a.assignedCount)

    return {
      total: tasks.length,
      doneCount: done.length,
      inProgressCount: inProgress.length,
      blocked,
      triageCount: triage.length,
      aiDelegatedCount: aiDelegated.length,
      completionRate: tasks.length > 0 ? Math.round((done.length / tasks.length) * 100) : 0,
      activeRuns,
      waitingRuns,
      completedRunsCount: completedRuns.length,
      failedRunsCount: failedRuns.length,
      runSuccessRate: completedRuns.length + failedRuns.length > 0
        ? Math.round((completedRuns.length / (completedRuns.length + failedRuns.length)) * 100)
        : 100,
      byCategory,
      memberLoads,
      agentLoads
    }
  }, [snapshot, spaceId, runs])

  if (!snapshot || !spaceId || !metrics) {
    return <EmptyState title="请先选择一个空间" description="选择协作空间后查看任务吞吐、成员负载与 AI 执行统计。" />
  }

  return (
    <div className="my-fade flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title="统计分析"
        description="实时汇总当前空间的任务交付进度、人机协同负载与 AI Run 执行健康度。"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setModule('triage')}>分拣台 ({metrics.triageCount})</Button>
            <Button size="sm" variant="outline" onClick={() => setModule('runtimes')}>运行环境</Button>
          </div>
        }
      />

      <div className="my-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1" style={{ scrollbarGutter: 'stable' }}>
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="核心交付指标">
          <div className="rounded-my-base border border-my-line bg-my-panel p-3.5">
            <div className="text-my-xs text-my-tertiary">空间总任务</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-my-primary">{metrics.total}</div>
            <div className="mt-1 text-my-2xs text-my-secondary">完成率 {metrics.completionRate}%</div>
          </div>
          <div className="rounded-my-base border border-my-line bg-my-panel p-3.5">
            <div className="text-my-xs text-my-tertiary">进行中 / 待评审</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-my-primary">{metrics.inProgressCount}</div>
            <div className="mt-1 text-my-2xs text-my-secondary">已完成 {metrics.doneCount} 条</div>
          </div>
          <div className="rounded-my-base border border-my-line bg-my-panel p-3.5">
            <div className="text-my-xs text-my-tertiary">受阻 / 待分拣</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-my-primary">{metrics.blocked.length} / {metrics.triageCount}</div>
            <div className="mt-1 text-my-2xs text-my-secondary">需重点协调项</div>
          </div>
          <div className="rounded-my-base border border-my-line bg-my-panel p-3.5">
            <div className="text-my-xs text-my-tertiary">AI 委派任务</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-my-primary">{metrics.aiDelegatedCount}</div>
            <div className="mt-1 text-my-2xs text-my-secondary">活跃 Run {metrics.activeRuns.length} 个</div>
          </div>
          <div className="rounded-my-base border border-my-line bg-my-panel p-3.5">
            <div className="text-my-xs text-my-tertiary">Run 成功率</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-my-primary">{metrics.runSuccessRate}%</div>
            <div className="mt-1 text-my-2xs text-my-secondary">完成 {metrics.completedRunsCount} · 失败 {metrics.failedRunsCount}</div>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <section className="flex flex-col gap-3 rounded-my-base border border-my-line bg-my-panel p-4" aria-label="任务状态分布">
            <header className="flex items-center justify-between">
              <h2 className="my-item-title">任务状态分布</h2>
              <span className="text-my-xs tabular-nums text-my-tertiary">共 {metrics.total} 条</span>
            </header>
            {metrics.byCategory.length === 0 ? (
              <p className="text-my-xs text-my-tertiary">当前空间暂无任务数据。</p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {metrics.byCategory.map((item) => {
                  const pct = metrics.total > 0 ? Math.round((item.count / metrics.total) * 100) : 0
                  return (
                    <div key={item.category} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-my-xs">
                        <span className="text-my-secondary">{item.label}</span>
                        <span className="tabular-nums text-my-tertiary">{item.count} ({pct}%)</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-my-layer-2">
                        <div className="h-full rounded-full bg-my-accent" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3 rounded-my-base border border-my-line bg-my-panel p-4" aria-label="需关注阻塞与等待确认">
            <header className="flex items-center justify-between">
              <h2 className="my-item-title flex items-center gap-1.5"><AlertTriangle size={15} />需要立即介入</h2>
              <span className="text-my-xs tabular-nums text-my-tertiary">{metrics.blocked.length + metrics.waitingRuns.length} 项</span>
            </header>
            {metrics.blocked.length === 0 && metrics.waitingRuns.length === 0 ? (
              <div className="flex items-center gap-2 rounded-my-base bg-my-layer-1 px-3 py-4 text-my-xs text-my-secondary">
                <CheckCircle2 size={15} className="text-my-success-text" />
                当前没有受阻任务或等待确认的 Agent 执行。
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {metrics.waitingRuns.map((run) => {
                  const taskTitle = snapshot.tasks.find((item) => item.id === run.taskId)?.title ?? run.taskId
                  return (
                    <li key={run.id} className="flex items-center justify-between gap-2 rounded-my-base border border-my-line bg-my-warning-subtle px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-my-xs font-medium text-my-warning-text">{run.executorName} 等待你确认</div>
                        <div className="truncate text-my-2xs text-my-secondary">{run.taskId} · {taskTitle}</div>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => openTask(run.taskId)}>立即处理</Button>
                    </li>
                  )
                })}
                {metrics.blocked.slice(0, 6).map((task) => (
                  <li key={task.id} className="flex items-center justify-between gap-2 rounded-my-base border border-my-line bg-my-layer-1 px-3 py-2">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openTask(task.id)}>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-my-2xs text-my-tertiary">{task.id}</span>
                        <span className="truncate text-my-xs font-medium text-my-primary">{task.title}</span>
                      </div>
                    </button>
                    <StatusBadge status={statusOf(snapshot, task.statusId)} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <section className="flex flex-col gap-3 rounded-my-base border border-my-line bg-my-panel p-4" aria-label="成员负载">
            <header className="flex items-center justify-between">
              <h2 className="my-item-title flex items-center gap-1.5"><Users size={15} />成员交付与负载</h2>
              <span className="text-my-xs text-my-tertiary">{metrics.memberLoads.length} 人</span>
            </header>
            {metrics.memberLoads.length === 0 ? (
              <p className="text-my-xs text-my-tertiary">当前空间暂无成员。</p>
            ) : (
              <ul className="divide-y divide-my-line">
                {metrics.memberLoads.map(({ member, total, done, active }) => (
                  <li key={member.id} className="flex items-center gap-3 py-2">
                    <MemberChip member={member} />
                    <div className="ml-auto flex w-36 items-center gap-2">
                      <TriProgressBar done={done} started={active} total={total} />
                      <span className="w-12 text-right text-my-xs tabular-nums text-my-tertiary">{done}/{total}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-3 rounded-my-base border border-my-line bg-my-panel p-4" aria-label="AI Agent 吞吐">
            <header className="flex items-center justify-between">
              <h2 className="my-item-title flex items-center gap-1.5"><Bot size={15} />AI Agent 运行吞吐</h2>
              <Button size="sm" variant="ghost" onClick={() => setModule('agents')}>管理 Agent</Button>
            </header>
            {metrics.agentLoads.length === 0 ? (
              <p className="text-my-xs text-my-tertiary">当前空间尚未配置 AI Agent。</p>
            ) : (
              <ul className="divide-y divide-my-line">
                {metrics.agentLoads.map(({ agent, assignedCount, runCount, succeeded, presence }) => (
                  <li key={agent.id} className="flex items-center gap-3 py-2 text-my-xs">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-my-primary">{agent.name}</span>
                        <span className={`rounded-my-sm px-1.5 py-0.5 text-my-2xs ${TONE_CLASS[AGENT_PRESENCE_META[presence.state].tone]}`}>
                          {AGENT_PRESENCE_META[presence.state].label}
                        </span>
                      </div>
                      <div className="mt-0.5 text-my-2xs text-my-tertiary">
                        委派任务 {assignedCount} · 执行 {runCount} 次 · 成功 {succeeded} 次
                      </div>
                    </div>
                    {presence.queuedCount > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-my-sm bg-my-layer-2 px-1.5 py-0.5 text-my-2xs tabular-nums text-my-secondary">
                        <Clock size={11} />排队 {presence.queuedCount}
                      </span>
                    )}
                    {presence.activeRun && (
                      <span className="inline-flex items-center gap-1 rounded-my-sm bg-my-info-subtle px-1.5 py-0.5 text-my-2xs text-my-info-text">
                        <Play size={11} />运行中
                      </span>
                    )}
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
