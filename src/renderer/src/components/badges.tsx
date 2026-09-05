import type { TaskPhase } from '../../../shared/types'
import { STATUS_LABEL } from '../utils/labels'
import { clsx } from 'clsx'

export function StatusBadge({ status }: { status: string }): JSX.Element {
  const map: Record<string, { label: string; cls: string }> = {
    planning: { label: '规划中', cls: 'bg-sky-500/15 text-sky-300 border border-sky-500/25' },
    in_progress: { label: '进行中', cls: 'bg-amber-500/15 text-amber-300 border border-amber-500/25' },
    review: { label: '评审中', cls: 'bg-violet-500/15 text-violet-300 border border-violet-500/25' },
    completed: { label: '已完成', cls: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25' },
    done: { label: '已完成', cls: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25' }
  }
  const it = map[status?.toLowerCase()] ?? {
    label: STATUS_LABEL[status] ?? (status || '未知'),
    cls: 'bg-ink-700 text-mist-300 border border-ink-500'
  }
  return <span className={clsx('chip', it.cls)}>{it.label}</span>
}

export function PriorityBadge({ priority }: { priority: string }): JSX.Element {
  const map: Record<string, string> = {
    P0: 'bg-rose-500/15 text-rose-300 border border-rose-500/25',
    P1: 'bg-orange-500/15 text-orange-300 border border-orange-500/25',
    P2: 'bg-ink-700 text-mist-200 border border-ink-500',
    P3: 'bg-ink-750 text-mist-300 border border-ink-600'
  }
  return (
    <span className={clsx('chip font-mono font-medium', map[priority] ?? map.P2)}>
      {priority || 'P?'}
    </span>
  )
}

export function JiraChip({ jiraKey }: { jiraKey: string }): JSX.Element {
  return (
    <span className="chip border border-blue-400/30 bg-blue-500/15 font-mono text-[10.5px] text-blue-300">
      ⚡ {jiraKey}
    </span>
  )
}

export const PHASE_LABEL: Record<TaskPhase, string> = {
  plan: '计划',
  implement: '实现',
  review: '评审',
  completed: '完成',
  unknown: '未知'
}
