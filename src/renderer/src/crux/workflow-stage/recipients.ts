import type { CruxMember, CruxSnapshot, CruxTask, CruxTaskAction, CruxTaskStage } from '@shared/crux'
import type { GovernanceSettings } from '@shared/team-governance'
import { taskInputCanonical, taskInputTransitionFence, type TaskInputRead } from '@shared/team-task-inputs'

type ApprovalRole = Extract<GovernanceSettings, { kind: 'workflow-template' }>['nodes'][number]['approvalRole']
const approvalLabels: Record<ApprovalRole, string> = { none: '', product: '产品负责人', design: '设计评审人', development: '开发负责人', testing: '测试负责人', 'space-owner': '空间负责人' }
const deliveryTargets: Partial<Record<CruxTaskAction, CruxTaskStage>> = { submit_test: 'testing', pass_test: 'acceptance', submit_delivery: 'acceptance', accept_delivery: 'done' }

export function workflowNeedsInputCheck(action: CruxTaskAction): boolean {
  return action in deliveryTargets || ['approve_plan', 'submit_design', 'approve_design'].includes(action)
}

export function workflowInputIdentity(read: TaskInputRead): string {
  return taskInputCanonical([read.taskId, taskInputTransitionFence(read)])
}

function stageNode(inputs: TaskInputRead | null | undefined, stage: CruxTaskStage | undefined): Extract<GovernanceSettings, { kind: 'workflow-template' }>['nodes'][number] | undefined {
  const settings = inputs?.current?.template?.settings
  return settings?.kind === 'workflow-template' ? settings.nodes.find(node => node.stage === stage) : undefined
}

/** Display hints only. Exact design-document grants and all writes remain server checked. */
function matchesApprovalRole(snapshot: CruxSnapshot, task: CruxTask, member: CruxMember, role: ApprovalRole | undefined): boolean {
  const assignments = task.workflow?.deliveryState?.roles
  if (!role || role === 'none' || role === 'design') return true
  if (role === 'space-owner') return snapshot.spaces.find(space => space.id === task.spaceId)?.ownerId === member.id
  if (role === 'product') return Boolean(member.projectRoles?.includes('product') || assignments?.productOwnerId === member.id || task.workKind === 'general' && assignments?.acceptanceOwnerId === member.id)
  if (role === 'development') return member.projectRoles?.includes('developer') === true
  return Boolean(member.projectRoles?.includes('tester') || assignments?.testOwnerId === member.id)
}

export function workflowActionBlocker(snapshot: CruxSnapshot, task: CruxTask, action: CruxTaskAction, actorId: string | null, inputs?: TaskInputRead | null): string | null {
  if (!workflowNeedsInputCheck(action)) return null
  if (inputs === null) return '任务流程尚未核对，请先核对任务输入。'
  if (inputs && inputs.admission.status !== 'ready') return inputs.admission.blockers[0] ?? '任务输入需要重新核对。'
  if (!(action in deliveryTargets)) return null
  const roles = task.workflow?.deliveryState?.roles
  const owner = action === 'pass_test' ? roles?.testOwnerId : action === 'accept_delivery' ? task.workKind === 'general' ? roles?.acceptanceOwnerId : roles?.testOwnerId : undefined
  if (roles && ['pass_test', 'accept_delivery'].includes(action) && (!owner || owner !== actorId)) return '此操作需由任务指定的测试或验收负责人确认。'
  const node = stageNode(inputs, task.workflow?.stage)
  if (!node || node.stage === deliveryTargets[action] || node.approvalRole === 'none' || node.approvalRole === 'design') return null
  if (node.outputs.length && !['pass_test', 'accept_delivery'].includes(action)) return null
  const actor = snapshot.members.find(member => member.id === actorId)
  return actor && matchesApprovalRole(snapshot, task, actor, node.approvalRole) ? null : `当前流程要求${approvalLabels[node.approvalRole]}确认。`
}

export interface WorkflowRecipient {
  member: CruxMember
  reason: string
  suggested: boolean
}

export function recipientRole(action: CruxTaskAction): string {
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
export function workflowRecipients(snapshot: CruxSnapshot, task: CruxTask, action: CruxTaskAction, responsibility?: 'design' | 'development', local = false, inputs?: TaskInputRead | null): WorkflowRecipient[] {
  const space = snapshot.spaces.find((item) => item.id === task.spaceId)
  const roles = task.workflow?.deliveryState?.roles
  const fixedId = roles && (['submit_test', 'pass_test'].includes(action) && task.workKind !== 'general'
    ? roles.testOwnerId : action === 'submit_delivery' ? roles.acceptanceOwnerId : undefined)
  const requiresFixedRole = Boolean(roles && (['submit_test', 'pass_test'].includes(action) && task.workKind !== 'general' || action === 'submit_delivery'))
  if (requiresFixedRole && !fixedId) return []
  const receivingRole = !local ? stageNode(inputs, deliveryTargets[action])?.approvalRole : undefined
  if (!local && inputs === null && ['submit_test', 'pass_test', 'submit_delivery'].includes(action)) return []
  const priorActions: Partial<Record<CruxTaskAction, CruxTaskAction>> = {
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
  return snapshot.members.filter((person) => space?.memberIds.includes(person.id) && (!fixedId || fixedId === person.id) && matchesApprovalRole(snapshot, task, person, receivingRole)).map((member) => {
    if (fixedId === member.id) return { member, reason: '任务已指定的负责人', suggested: true }
    if (receivingRole && !['none', 'design'].includes(receivingRole)) return { member, reason: `当前流程的${approvalLabels[receivingRole]}`, suggested: true }
    if (authenticatedRoles && expectedRole && member.projectRoles?.includes(expectedRole)) return { member, reason: `工作区角色：${roleLabels[expectedRole]}（${expectedRole}）`, suggested: true }
    if (prior === member.id) return { member, reason: '上一轮实际处理人', suggested: !authenticatedRoles || !expectedRole }
    if (action === 'supplement' && task.workflow?.resumeAssigneeId === member.id) return { member, reason: '补充前的处理人', suggested: true }
    if (action === 'request_info' && task.creatorId === member.id) return { member, reason: '需求提出人', suggested: true }
    if (!authenticatedRoles && pattern?.test(member.title ?? '')) return { member, reason: `职责匹配：${member.title}`, suggested: true }
    return { member, reason: '本空间成员，可明确指定', suggested: false }
  }).sort((a, b) => Number(b.suggested) - Number(a.suggested))
}
