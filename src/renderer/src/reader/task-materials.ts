/** Browsing conveniences only. A file's name never establishes workflow approval or success. */
export const TASK_MATERIAL_GROUPS = [
  { id: 'all', label: '全部材料' },
  { id: 'requirements', label: '需求与决策' },
  { id: 'execution', label: '计划与执行' },
  { id: 'validation', label: '验证与交付' },
  { id: 'other', label: '其他与原始记录' }
] as const

export type TaskMaterialGroup = typeof TASK_MATERIAL_GROUPS[number]['id']

export function taskMaterialGroup(name: string): Exclude<TaskMaterialGroup, 'all'> {
  const normalized = name.replace(/\\/g, '/').toLowerCase()
  const base = normalized.split('/').pop() ?? normalized
  // Known context manifests belong to their browsing stage, without implying a completed run.
  if (base === 'implement.jsonl') return 'execution'
  if (base === 'check.jsonl') return 'validation'
  // Raw machine records and unknown formats remain discoverable without interpreting their content.
  if (/\.(json|jsonl)$/i.test(base)) return 'other'
  if (/(?:^|[\/_.-])(prd|requirements?|decisions?|research)(?:[\/_.-]|$)|需求|决策|调研/.test(normalized)) return 'requirements'
  if (/(?:^|[\/_.-])(check|checks|validation|verification|test|tests|delivery|release)(?:[\/_.-]|$)|验收|验证|交付|测试/.test(normalized)) return 'validation'
  if (/(?:^|[\/_.-])(design|implement|implementation|plan|execution)(?:[\/_.-]|$)|方案|设计|计划|执行/.test(normalized)) return 'execution'
  return 'other'
}
