// Shared label maps used by both main and renderer processes.

export const STATUS_LABEL: Record<string, string> = {
  planning: '规划中',
  in_progress: '进行中',
  review: '评审中',
  completed: '已完成',
  done: '已完成'
}

export function statusLabelShared(status: string | null | undefined): string {
  if (!status) return '未知'
  return STATUS_LABEL[status.toLowerCase()] ?? status
}

/** Jira statusCategory.key -> trellis status (locale-independent fallback). */
export const JIRA_CATEGORY_STATUS: Record<string, string> = {
  new: 'planning',
  indeterminate: 'in_progress',
  done: 'completed'
}
