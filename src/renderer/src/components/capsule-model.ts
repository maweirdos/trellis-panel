import type { FileEntry, TaskInfo, TaskPhase } from '../../../shared/types'
import { relativePathUnderRoot } from '../reader/reader-paths'
import { taskMaterialGroup, type TaskMaterialGroup } from '../reader/task-materials'

export interface CapsuleDocument {
  file: FileEntry
  label: string
  kind: string
  group: Exclude<TaskMaterialGroup, 'all'>
  modified: string
  modifiedTitle: string
  modifiedAt?: string
}

const KNOWN_DOCUMENTS: Record<string, { label: string; kind: string; rank: number }> = {
  'prd.md': { label: '需求说明', kind: 'PRD', rank: 0 },
  'design.md': { label: '设计方案', kind: '设计', rank: 1 },
  'handoff.md': { label: '交接说明', kind: '交接', rank: 2 },
  'check.md': { label: '检查记录', kind: '检查', rank: 3 },
  'implement.md': { label: '实施计划', kind: '计划', rank: 4 }
}

/** Only the scanned task's real, project-contained Markdown files are actionable. */
export function capsuleDocuments(task: TaskInfo, root: string): CapsuleDocument[] {
  return task.artifacts
    .filter((file) => {
      if (file.kind !== 'file' || !/\.(md|markdown)$/i.test(file.name)) return false
      const projectPath = relativePathUnderRoot(root, file.path)
      const taskPath = relativePathUnderRoot(task.path, file.path)
      return projectPath !== null && taskPath !== null && !projectPath.split('/').some((part) => part === '..' || part === '.')
    })
    .sort((left, right) => (KNOWN_DOCUMENTS[left.name.toLowerCase()]?.rank ?? 5) - (KNOWN_DOCUMENTS[right.name.toLowerCase()]?.rank ?? 5) || left.name.localeCompare(right.name))
    .map((file) => {
      const known = KNOWN_DOCUMENTS[file.name.toLowerCase()]
      const date = Number.isFinite(file.mtime) && file.mtime > 0 ? new Date(file.mtime) : null
      const validDate = date && Number.isFinite(date.getTime()) ? date : null
      return {
        file,
        label: known?.label ?? file.name.replace(/\.(md|markdown)$/i, ''),
        kind: known?.kind ?? '文档',
        group: taskMaterialGroup(file.name),
        modified: validDate ? `${String(validDate.getMonth() + 1).padStart(2, '0')}/${String(validDate.getDate()).padStart(2, '0')}` : '未知',
        modifiedTitle: validDate ? `修改于 ${validDate.toLocaleString()}` : '修改时间未知',
        modifiedAt: validDate?.toISOString()
      }
    })
}

export const CAPSULE_PHASES: ReadonlyArray<{ phase: Exclude<TaskPhase, 'unknown'>; label: string; hint: string }> = [
  { phase: 'plan', label: '规划', hint: '梳理需求与实现方案' },
  { phase: 'implement', label: '实施', hint: '实现当前工作范围' },
  { phase: 'review', label: '检查', hint: '核对改动与检查结果' },
  { phase: 'completed', label: '完成', hint: '本地任务记录为已完成' }
]
