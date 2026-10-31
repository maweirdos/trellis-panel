import type { TeamTaskMaterialKind } from '@shared/team-task-materials'

export const TASK_MATERIAL_LABELS: Record<TeamTaskMaterialKind, string> = {
  prd: '需求说明', design: '设计说明', implement: '实施计划', 'delivery-note': '交付说明'
}
const SECTIONS: Record<TeamTaskMaterialKind, readonly string[]> = {
  prd: ['目标用户与问题', '现有功能与依据', '业务主流程', '字段与业务规则', '页面状态与异常', '验收标准', '待确认问题'],
  design: ['设计方案', '页面与交互状态', '数据与接口影响', '风险与待确认问题'],
  implement: ['实施范围', '实施步骤', '验证方式', '风险与依赖'],
  'delivery-note': ['已交付', '未交付', '体验入口', '验证结果与证据', '剩余风险']
}
export function initialTaskMaterial(kind: TeamTaskMaterialKind, taskTitle: string): { title: string; text: string } {
  const title = `${taskTitle} · ${TASK_MATERIAL_LABELS[kind]}`.slice(0, 300)
  return { title, text: `# ${title}\n\n${SECTIONS[kind].map((section) => `## ${section}\n\n`).join('')}` }
}
export async function taskMaterialDigest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('共享正文必须为 1 字节到 1 MiB；请缩减正文或拆分引用，当前输入已保留。')
  const value = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export function taskMaterialTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
