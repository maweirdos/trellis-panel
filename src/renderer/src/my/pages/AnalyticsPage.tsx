// 分析页（R9）：指标卡 + 手写 SVG 柱状图（创建 vs 关闭）+ 状态/优先级分布 + 成员排行。
import { useMemo, type JSX } from 'react'
import { PRIORITY_ORDER, useMy } from '../store'
import { Avatar } from '../ui'
import { PriorityIcon, StateGroupIcon } from '../icons'
import type { Issue, Priority, WorkItemState } from '../types'

const PRIORITY_KEYS: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
const DAY_MS = 86400000

/** 近 8 周的「创建 vs 关闭」聚合结果 */
interface WeekBar {
  label: string // 周起始日期 M/D
  created: number
  closed: number
}

function buildWeeklyBars(issues: Issue[]): WeekBar[] {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const todayMs = today.getTime()

  // 桶 0 = 7 周前那一周 … 桶 7 = 本周
  const bars: WeekBar[] = []
  for (let w = 7; w >= 0; w--) {
    const start = new Date(todayMs - (w * 7 + 6) * DAY_MS)
    bars.push({ label: `${start.getMonth() + 1}/${start.getDate()}`, created: 0, closed: 0 })
  }
  const bucketOf = (iso: string): number => {
    const d = new Date(`${iso}T12:00:00`)
    if (Number.isNaN(d.getTime())) return -1
    const weekIdx = Math.floor((todayMs - d.getTime()) / DAY_MS / 7)
    return weekIdx >= 0 && weekIdx <= 7 ? 7 - weekIdx : -1
  }
  for (const i of issues) {
    const ci = bucketOf(i.createdAt)
    if (ci >= 0) bars[ci].created += 1
    if (i.completedAt) {
      const di = bucketOf(i.completedAt)
      if (di >= 0) bars[di].closed += 1
    }
  }
  return bars
}

/* ---------------- 柱状图（手写 SVG，不引图表库） ---------------- */

function CreatedClosedChart({ bars }: { bars: WeekBar[] }): JSX.Element {
  const W = 560
  const H = 232
  const padL = 12
  const padR = 8
  const padT = 12
  const padB = 26
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const yBase = padT + plotH
  const maxCount = Math.max(1, ...bars.map((b) => Math.max(b.created, b.closed)))
  const groupW = plotW / bars.length
  const barW = 14
  const barGap = 6
  const gridYs = [0, 1, 2, 3, 4].map((k) => padT + (plotH * k) / 4)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="创建与关闭柱状图">
      {/* 网格线 */}
      {gridYs.map((y) => (
        <line key={y} x1={padL} x2={W - padR} y1={y} y2={y} stroke="var(--my-border-subtle)" strokeWidth={1} />
      ))}
      {bars.map((b, gi) => {
        const cx = padL + gi * groupW + groupW / 2
        const hCreated = (b.created / maxCount) * plotH
        const hClosed = (b.closed / maxCount) * plotH
        return (
          <g key={b.label}>
            <rect
              x={cx - barGap / 2 - barW}
              y={yBase - hCreated}
              width={barW}
              height={hCreated}
              rx={2}
              fill="var(--my-bg-accent-primary)"
            >
              <title>{`${b.label} 那周创建 ${b.created} 个`}</title>
            </rect>
            <rect
              x={cx + barGap / 2}
              y={yBase - hClosed}
              width={barW}
              height={hClosed}
              rx={2}
              fill="var(--my-txt-icon-states-completed)"
            >
              <title>{`${b.label} 那周关闭 ${b.closed} 个`}</title>
            </rect>
            <text x={cx} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--my-txt-tertiary)">
              {b.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/* ---------------- 指标卡 ---------------- */

function MetricCard({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="my-card p-3">
      <div className="text-[22px] font-semibold text-my-primary">{value}</div>
      <div className="mt-0.5 text-[12px] text-my-tertiary">{label}</div>
    </div>
  )
}

/* ---------------- 页面 ---------------- */

export function AnalyticsPage(): JSX.Element {
  const { data } = useMy()
  const issues = data.issues

  const states = useMemo(() => new Map<string, WorkItemState>(data.states.map((s) => [s.id, s])), [data.states])
  const groupOf = (i: Issue): string | undefined => states.get(i.stateId)?.group

  const createdCount = issues.length
  const closedCount = issues.filter((i) => groupOf(i) === 'completed').length
  const startedCount = issues.filter((i) => groupOf(i) === 'started').length
  const todoCount = issues.filter((i) => groupOf(i) === 'unstarted' || groupOf(i) === 'backlog').length

  const weeklyBars = useMemo(() => buildWeeklyBars(issues), [issues])

  // 状态分布（按 states 声明顺序）
  const stateCounts = data.states.map((s) => ({ state: s, count: issues.filter((i) => i.stateId === s.id).length }))
  const stateTotal = Math.max(1, issues.length)

  // 优先级分布（复用 PRIORITY_ORDER 排序）
  const priorityCounts = [...PRIORITY_KEYS]
    .sort((a, b) => PRIORITY_ORDER[a] - PRIORITY_ORDER[b])
    .map((p) => ({ priority: p, count: issues.filter((i) => i.priority === p).length }))
  const priorityMax = Math.max(1, ...priorityCounts.map((r) => r.count))

  // 成员排行：按负责人统计未关闭工作项
  const memberRows = data.members
    .map((m) => ({
      member: m,
      count: issues.filter((i) => i.assigneeId === m.id && groupOf(i) !== 'completed' && groupOf(i) !== 'cancelled').length
    }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
  const memberMax = Math.max(1, ...memberRows.map((r) => r.count))

  return (
    <div className="mx-auto max-w-[1024px]">
      {/* 顶栏 */}
      <header className="px-8 pb-4 pt-6">
        <h1 className="text-[20px] font-semibold text-my-primary">Analytics</h1>
      </header>

      <div className="space-y-3 px-8 pb-16">
        {/* 指标卡 */}
        <div className="grid grid-cols-4 gap-3">
          <MetricCard label="已创建" value={createdCount} />
          <MetricCard label="已关闭" value={closedCount} />
          <MetricCard label="进行中" value={startedCount} />
          <MetricCard label="待处理" value={todoCount} />
        </div>

        {/* 图表区：左柱状图（占 2 列）+ 右状态/优先级分布（占 2 列） */}
        <div className="grid grid-cols-4 gap-3">
          <div className="my-card col-span-2 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-medium text-my-secondary">创建 vs 关闭（近 8 周）</h2>
              <div className="flex items-center gap-3 text-[11px] text-my-tertiary">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-[2px] bg-my-accent" />
                  创建
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-[2px] bg-[var(--my-txt-icon-states-completed)]" />
                  关闭
                </span>
              </div>
            </div>
            <div className="mt-2">
              <CreatedClosedChart bars={weeklyBars} />
            </div>
          </div>

          <div className="col-span-2 flex flex-col gap-3">
            {/* 状态分布 */}
            <div className="my-card p-4">
              <h2 className="text-[13px] font-medium text-my-secondary">状态分布</h2>
              <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-my-layer-3">
                {stateCounts.map(
                  (r) =>
                    r.count > 0 && (
                      <div
                        key={r.state.id}
                        style={{ width: `${(r.count / stateTotal) * 100}%`, background: r.state.color }}
                      />
                    )
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
                {stateCounts.map((r) => (
                  <span key={r.state.id} className="flex items-center gap-1.5 text-[12px] text-my-secondary">
                    <StateGroupIcon stateGroup={r.state.group} color={r.state.color} size={12} />
                    {r.state.name}
                    <span className="text-my-tertiary">{r.count}</span>
                  </span>
                ))}
              </div>
            </div>

            {/* 优先级分布 */}
            <div className="my-card flex-1 p-4">
              <h2 className="text-[13px] font-medium text-my-secondary">优先级分布</h2>
              <div className="mt-3 space-y-2">
                {priorityCounts.map((r) => (
                  <div key={r.priority} className="flex items-center gap-2.5">
                    <span className="flex w-4 justify-center">
                      <PriorityIcon priority={r.priority} size={13} />
                    </span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-my-layer-3">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(r.count / priorityMax) * 100}%`,
                          background: `var(--my-priority-${r.priority})`
                        }}
                      />
                    </div>
                    <span className="w-7 shrink-0 text-right text-[12px] text-my-tertiary">{r.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 成员排行 */}
        <div className="my-card p-4">
          <h2 className="text-[13px] font-medium text-my-secondary">成员排行（未关闭工作项）</h2>
          <div className="mt-3 space-y-2.5">
            {memberRows.map((r) => (
              <div key={r.member.id} className="flex items-center gap-3">
                <Avatar name={r.member.name} color={r.member.avatarColor} size={20} />
                <span className="w-16 shrink-0 truncate text-[12.5px] text-my-secondary">{r.member.name}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-my-layer-3">
                  <div className="h-full rounded-full bg-my-accent" style={{ width: `${(r.count / memberMax) * 100}%` }} />
                </div>
                <span className="w-7 shrink-0 text-right text-[12px] text-my-tertiary">{r.count}</span>
              </div>
            ))}
            {memberRows.length === 0 && (
              <div className="py-4 text-center text-[12px] text-my-tertiary">暂无数据</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
