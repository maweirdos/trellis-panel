import type { HifoxMember, HifoxSnapshot, HifoxTask, HifoxTaskAction } from '@shared/hifox'

export interface WorkflowRecipient {
  member: HifoxMember
  reason: string
  suggested: boolean
}

export function recipientRole(action: HifoxTaskAction): string {
  if (action === 'submit_design') return '设计评审人'
  if (action === 'return_design') return '设计负责人'
  if (['approve_design', 'return_development', 'return_delivery'].includes(action)) return '开发负责人'
  if (action === 'submit_test') return '测试负责人'
  if (['pass_test', 'submit_delivery'].includes(action)) return '验收负责人'
  if (action === 'request_info') return '信息补充人'
  if (action === 'supplement') return '接续处理人'
  return '负责同事'
}

/** Authenticated roles explain shared recommendations; membership/fixed delivery grants still constrain eligibility. */
export function workflowRecipients(snapshot: HifoxSnapshot, task: HifoxTask, action: HifoxTaskAction, responsibility?: 'design' | 'development', local = false): WorkflowRecipient[] {
  const space = snapshot.spaces.find((item) => item.id === task.spaceId)
  const roles = task.workflow?.deliveryState?.roles
  const fixedId = roles && (['submit_test', 'pass_test'].includes(action) && task.workKind !== 'general'
    ? roles.testOwnerId : action === 'submit_delivery' ? roles.acceptanceOwnerId : undefined)
  const requiresFixedRole = Boolean(roles && (['submit_test', 'pass_test'].includes(action) && task.workKind !== 'general' || action === 'submit_delivery'))
  if (requiresFixedRole && !fixedId) return []
  const priorActions: Partial<Record<HifoxTaskAction, HifoxTaskAction>> = {
    return_design: 'start_design', return_development: 'begin_development', return_delivery: 'begin_development'
  }
  const prior = task.workflow?.history.slice().reverse().find((event) => event.action === priorActions[action])?.actorId
  const expectedRole = responsibility === 'development' || ['approve_design', 'return_development', 'return_delivery'].includes(action) && task.workKind !== 'general' ? 'developer'
    : responsibility === 'design' || ['submit_design', 'return_design'].includes(action) ? 'product' : action === 'submit_test' ? 'tester' : undefined
  const authenticatedRoles = !local && snapshot.members.some((member) => member.projectRoles !== undefined)
  const roleLabels = { product: '产品', developer: '开发', tester: '测试' }
  const pattern = responsibility === 'development' ? /开发|研发|工程|前端|后端|developer|engineer/i : responsibility === 'design' ? /设计|design/i : action === 'submit_test' ? /测试|\bqa\b|test/i
    : ['approve_design', 'return_development', 'return_delivery'].includes(action) && task.workKind !== 'general' ? /开发|研发|工程|前端|后端|developer|engineer/i
      : action === 'return_design' ? /设计|design/i : action === 'submit_design' ? /产品|设计|评审|product|design/i : null
  return snapshot.members.filter((person) => space?.memberIds.includes(person.id) && (!fixedId || fixedId === person.id)).map((member) => {
    if (fixedId === member.id) return { member, reason: '任务已指定的负责人', suggested: true }
    if (authenticatedRoles && expectedRole && member.projectRoles?.includes(expectedRole)) return { member, reason: `工作区角色：${roleLabels[expectedRole]}（${expectedRole}）`, suggested: true }
    if (prior === member.id) return { member, reason: '上一轮实际处理人', suggested: !authenticatedRoles || !expectedRole }
    if (action === 'supplement' && task.workflow?.resumeAssigneeId === member.id) return { member, reason: '补充前的处理人', suggested: true }
    if (action === 'request_info' && task.creatorId === member.id) return { member, reason: '需求提出人', suggested: true }
    if (!authenticatedRoles && pattern?.test(member.title ?? '')) return { member, reason: `职责匹配：${member.title}`, suggested: true }
    return { member, reason: '本空间成员，可明确指定', suggested: false }
  }).sort((a, b) => Number(b.suggested) - Number(a.suggested))
}
