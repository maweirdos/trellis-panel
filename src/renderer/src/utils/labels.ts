import type { TaskPhase } from '../../../shared/types'

/** Canonical status values are English on disk; UI always shows Chinese. */
export const STATUS_LABEL: Record<string, string> = {
  planning: '规划中',
  in_progress: '进行中',
  review: '评审中',
  completed: '已完成',
  done: '已完成'
}

export const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'planning', label: '规划中' },
  { value: 'in_progress', label: '进行中' },
  { value: 'review', label: '评审中' },
  { value: 'completed', label: '已完成' }
]

export function statusLabel(status: string | null | undefined): string {
  if (!status) return '未知'
  return STATUS_LABEL[status.toLowerCase()] ?? status
}

export const PRIORITY_LABEL: Record<string, string> = {
  P0: '紧急 P0',
  P1: '高 P1',
  P2: '中 P2',
  P3: '低 P3'
}

export const PHASE_LABEL: Record<TaskPhase, string> = {
  plan: '计划阶段',
  implement: '实现阶段',
  review: '评审阶段',
  completed: '已完成',
  unknown: '未知阶段'
}

/** Jira statusCategory.key → trellis status. Locale-independent. */
export const JIRA_CATEGORY_STATUS: Record<string, string> = {
  new: 'planning',
  indeterminate: 'in_progress',
  done: 'completed'
}

export function fmtTaskStatus(value: string): string {
  return statusLabel(value)
}
