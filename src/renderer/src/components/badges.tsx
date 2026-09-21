import type { TaskPhase } from '../../../shared/types'
import { STATUS_LABEL } from '../utils/labels'
import { clsx } from 'clsx'

export function StatusBadge({ status }: { status: string }): JSX.Element {
  const map: Record<string, { label: string; cls: string }> = {
    planning: {
      label: '规划中',
      cls: 'bg-sky-50 text-sky-700 border border-sky-300 font-medium dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30'
    },
    in_progress: {
      label: '进行中',
      cls: 'bg-amber-50 text-amber-800 border border-amber-300 font-medium dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30'
    },
    review: {
      label: '评审中',
      cls: 'bg-violet-50 text-violet-700 border border-violet-300 font-medium dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30'
    },
    completed: {
      label: '已完成',
      cls: 'bg-emerald-50 text-emerald-800 border border-emerald-300 font-medium dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30'
    },
    done: {
      label: '已完成',
      cls: 'bg-emerald-50 text-emerald-800 border border-emerald-300 font-medium dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30'
    }
  }
  const it = map[status?.toLowerCase()] ?? {
    label: STATUS_LABEL[status] ?? (status || '未知'),
    cls: 'bg-ink-100 text-mist-600 border border-ink-300 dark:bg-ink-700 dark:text-mist-300 dark:border-ink-500'
  }
  return <span className={clsx('chip', it.cls)}>{it.label}</span>
}

export function PriorityBadge({ priority }: { priority: string }): JSX.Element {
  const map: Record<string, string> = {
    P0: 'bg-rose-50 text-rose-700 border border-rose-300 font-medium dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30',
    P1: 'bg-orange-50 text-orange-800 border border-orange-300 font-medium dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/30',
    P2: 'bg-ink-100 text-mist-700 border border-ink-300 dark:bg-ink-700 dark:text-mist-200 dark:border-ink-500',
    P3: 'bg-ink-50 text-mist-500 border border-ink-200 dark:bg-ink-750 dark:text-mist-300 dark:border-ink-600'
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
