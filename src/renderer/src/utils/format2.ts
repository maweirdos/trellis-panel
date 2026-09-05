import type { TaskInfo } from '../../../shared/types'

export function subtaskProgressOf(t: TaskInfo): { done: number; total: number } | null {
  const list = t.record?.subtasks ?? []
  if (list.length === 0) return null
  const done = list.filter((s) => /\[[xX]\]/.test(s.trim().replace(/^-\s*/, ''))).length
  return { done, total: list.length }
}
