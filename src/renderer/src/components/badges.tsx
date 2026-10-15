import type { TaskPhase } from '../../../shared/types'
import { STATUS_LABEL } from '../utils/labels'

export function StatusBadge({ status }: { status: string }): JSX.Element {
  const map: Record<string, { label: string; cls: string }> = {
    planning: {
      label: '规划中',
      cls: 'bg-my-info-subtle text-my-info-text'
    },
    in_progress: {
      label: '进行中',
      cls: 'bg-my-warning-subtle text-my-warning-text'
    },
    review: {
      label: '评审中',
      cls: 'bg-my-label-purple text-my-label-purple-text'
    },
    completed: {
      label: '已完成',
      cls: 'bg-my-success-subtle text-my-success-text'
    },
    done: {
      label: '已完成',
      cls: 'bg-my-success-subtle text-my-success-text'
    }
  }
  const it = map[status?.toLowerCase()] ?? {
    label: STATUS_LABEL[status] ?? (status || '未知'),
    cls: 'bg-my-layer-2 text-my-tertiary'
  }
  return <span className={`my-chip ${it.cls}`}>{it.label}</span>
}

export function PriorityBadge({ priority }: { priority: string }): JSX.Element {
  const map: Record<string, string> = {
    P0: 'bg-my-danger-subtle text-my-danger-text',
    P1: 'bg-my-warning-subtle text-my-warning-text',
    P2: 'bg-my-layer-2 text-my-secondary',
    P3: 'bg-my-layer-2 text-my-tertiary'
  }
  return (
    <span className={`my-chip font-mono ${map[priority] ?? map.P2}`}>
      {priority || 'P?'}
    </span>
  )
}

export function JiraChip({ jiraKey }: { jiraKey: string }): JSX.Element {
  return (
    <span className="my-chip border border-my-label-indigo-border bg-my-label-indigo font-mono text-my-label-indigo-text">
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
