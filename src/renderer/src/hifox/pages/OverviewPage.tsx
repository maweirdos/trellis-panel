/**
 * 空间概况：任务/成员/Agent 统计 + 各状态分布 + 最近活动 + 快捷入口。
 */
import { ArrowRight } from 'lucide-react'
import { useHifox, spaceTasks, statusOf } from '../store'
import { PageHeader, StatusBadge, selectSnapshotCount, MemberChip } from '../ui'
import { ResetDemoButton } from '../HiFoxApp'
import { formatDate } from '../../my/ui'

export function OverviewPage(): JSX.Element {
  const snapshot = useHifox((s) => s.snapshot)!
  const currentSpaceId = useHifox((s) => s.currentSpaceId)
  const setModule = useHifox((s) => s.setModule)
  const space = snapshot.spaces.find((s) => s.id === currentSpaceId)
  if (!space) return <PageHeader title="概况" description="先创建一个空间" />

  const tasks = spaceTasks(snapshot, space.id)
  const counts = selectSnapshotCount(snapshot, space.id)
  const statuses = snapshot.taskStatuses
    .filter((s) => s.spaceId === space.id)
    .sort((a, b) => a.order - b.order)
    .map((status) => ({ status, count: tasks.filter((t) => t.statusId === status.id).length }))
    .filter((row) => row.count > 0)
  const recentActivities = snapshot.activities
    .filter((a) => tasks.some((t) => t.id === a.taskId))
    .slice(0, 8)
  const activeIteration = snapshot.iterations.find((it) => it.spaceId === space.id && it.status === 'active')
  const triageable = tasks.filter((t) =>
    !t.assigneeIds.length && !t.executor
    && statusOf(snapshot, t.statusId)?.category === 'backlog').length

  const cards = [
    { label: '任务总数', value: counts.tasks, hint: `完成 ${counts.done} · 受阻 ${counts.blocked}`, go: 'tasks' as const },
    { label: '进行中迭代', value: activeIteration ? activeIteration.name : '—', hint: activeIteration ? `${activeIteration.startDate} ~ ${activeIteration.endDate}` : '暂无进行中迭代', go: 'iterations' as const },
    { label: 'Agent', value: counts.agents, hint: `小队 ${snapshot.crews.filter((c) => c.spaceId === space.id).length} 个 · 技能 ${snapshot.skills.length} 项`, go: 'agents' as const },
    { label: '待分拣', value: triageable, hint: 'Backlog 中未分配的任务', go: 'triage' as const }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <PageHeader
        title={`${space.name} · 概况`}
        description={space.description ?? `前缀 ${space.key} · ${space.multiAssignee ? '已开启多人处理人' : '单人处理人'}`}
        actions={<ResetDemoButton />}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((card) => (
          <button
            key={card.label}
            type="button"
            onClick={() => setModule(card.go)}
            className="flex flex-col gap-1 rounded-my-md border border-my-line bg-my-layer p-3 text-left transition-colors hover:border-my-brand/50"
          >
            <span className="text-my-xs text-my-tertiary">{card.label}</span>
            <span className="truncate text-lg font-semibold text-my-primary">{card.value}</span>
            <span className="truncate text-my-xs text-my-tertiary">{card.hint}</span>
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
        <section className="flex flex-col gap-2 rounded-my-md border border-my-line bg-my-layer p-3">
          <h2 className="text-my-sm font-medium text-my-primary">状态分布</h2>
          <div className="flex flex-wrap gap-1.5">
            {statuses.length === 0 && <p className="text-my-xs text-my-tertiary">暂无任务</p>}
            {statuses.map(({ status, count }) => (
              <span key={status.id} className="flex items-center gap-1.5">
                <StatusBadge status={status} />
                <span className="text-my-xs text-my-secondary">{count}</span>
              </span>
            ))}
          </div>
          <h2 className="mt-2 text-my-sm font-medium text-my-primary">空间成员（{space.memberIds.length}）</h2>
          <div className="flex flex-wrap gap-2">
            {space.memberIds.map((id) => {
              const member = snapshot.members.find((m) => m.id === id)
              return member ? <MemberChip key={id} member={member} /> : null
            })}
          </div>
        </section>
        <section className="flex min-h-0 flex-col gap-2 rounded-my-md border border-my-line bg-my-layer p-3">
          <h2 className="text-my-sm font-medium text-my-primary">最近活动</h2>
          <ul className="my-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto">
            {recentActivities.length === 0 && <li className="text-my-xs text-my-tertiary">暂无活动</li>}
            {recentActivities.map((activity) => {
              const task = snapshot.tasks.find((t) => t.id === activity.taskId)
              return (
                <li key={activity.id} className="flex items-start gap-2 text-my-xs">
                  <span className="mt-0.5 shrink-0 rounded-my-sm bg-my-layer-active px-1.5 py-0.5 font-mono text-[10px] text-my-tertiary">{activity.taskId}</span>
                  <span className="min-w-0 flex-1 text-my-secondary">
                    {activity.text}
                    {task && <button type="button" className="ml-1 inline-flex items-center gap-0.5 text-indigo-400 hover:underline" onClick={() => { useHifox.getState().openTask(task.id); setModule('tasks') }}>
                      查看<ArrowRight size={10} />
                    </button>}
                  </span>
                  <span className="shrink-0 text-my-tertiary">{formatDate(activity.at)}</span>
                </li>
              )
            })}
          </ul>
        </section>
      </div>
    </div>
  )
}
