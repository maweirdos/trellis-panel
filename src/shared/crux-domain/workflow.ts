import type {
  CruxSnapshot, CruxStatusCategory, CruxTask, CruxTaskAction, CruxTaskStage,
  CruxTaskWorkflowArtifact, CruxTransitionTaskInput
} from '../crux'
import { cruxTransitionTaskInputSchema } from '../crux-schema'
import { currentPostInput, fixedPostInput } from '../crux'
import { taskInputCanonical } from '../team-canonical'
import { CruxError, validateExecutor } from './core'
import { evaluateAutomationsForStatus, refreshTaskDispatch, setTaskIterations, taskStatusForCategory } from './planning'
import { mutate, nextId, nowIso } from './store'
import type { TaskDeliveryDependencies } from '../task-delivery'
import { applyTaskDeliveryTransition } from './task-delivery'
export { CruxError } from './core'

export function currentTaskTestSubmission(task: CruxTask) {
  const last = task.workflow?.history.slice().reverse().find(event =>
    ['submit_test', 'return_development', 'return_delivery'].includes(event.action))
  return last?.action === 'submit_test' ? last : undefined
}

export interface CruxTaskStageMetadata {
  stage: CruxTaskStage
  label: string
  category: CruxStatusCategory
  actions: readonly CruxTaskAction[]
}

const stages: Record<CruxTaskStage, Omit<CruxTaskStageMetadata, 'stage'>> = {
  accepted: { label: '已接受', category: 'backlog', actions: ['arrange', 'request_info', 'decline', 'submit_delivery'] },
  needs_info: { label: '待补充', category: 'blocked', actions: ['supplement', 'decline'] },
  design_ready: { label: '待设计', category: 'todo', actions: ['start_design', 'request_info', 'decline', 'submit_delivery'] },
  designing: { label: '设计中', category: 'in_progress', actions: ['submit_design', 'request_info', 'decline'] },
  design_review: { label: '设计评审', category: 'in_review', actions: ['approve_design', 'return_design', 'request_info', 'decline'] },
  dev_ready: { label: '待开发', category: 'todo', actions: ['begin_development', 'request_info', 'submit_delivery', 'decline'] },
  planning: { label: '技术规划', category: 'in_progress', actions: ['approve_plan', 'request_info', 'decline'] },
  developing: { label: '处理中', category: 'in_progress', actions: ['submit_test', 'submit_delivery', 'request_info', 'decline'] },
  testing: { label: '测试中', category: 'in_review', actions: ['pass_test', 'return_development', 'request_info', 'decline'] },
  acceptance: { label: '待验收', category: 'in_review', actions: ['accept_delivery', 'return_delivery', 'request_info', 'decline'] },
  done: { label: '已完成', category: 'done', actions: [] }
}

export function getCruxTaskStageMetadata(stage: CruxTaskStage): CruxTaskStageMetadata {
  return { stage, ...stages[stage], actions: stage === 'done' ? [] : [...stages[stage].actions, 'reassign'] }
}

export function canStartAssignedTaskPlan(task: CruxTask, actorId: string | undefined): boolean {
  return Boolean(actorId && !task.workflow && !task.triagePending && task.workKind !== 'general' &&
    task.executor?.kind === 'agent' && task.assigneeIds[0] === actorId)
}

/** Availability is a pure UI hint. The mutation independently checks actor and references. */
export function getCruxTaskActions(task: Pick<CruxTask, 'workflow' | 'triagePending' | 'workKind'>): CruxTaskAction[] {
  if (task.workflow?.stage === 'done') return []
  if (!task.workflow) return task.triagePending ? ['accept', 'arrange', 'request_info', 'decline'] : ['arrange']
  if (task.triagePending) return task.workflow.stage === 'needs_info' ? ['supplement', 'decline', 'reassign'] : ['accept', 'arrange', 'request_info', 'decline', 'reassign']
  const actions = getCruxTaskStageMetadata(task.workflow.stage).actions.filter((action) => {
    if (action === 'submit_delivery') return task.workKind === 'general'
    if (action === 'submit_test' || action === 'begin_development') return task.workKind !== 'general'
    return true
  })
  if (task.workflow.stage === 'developing' && task.workKind !== 'general' && task.workflow.deliveryState && task.workflow.deliveryState.approvedBaselineId !== task.workflow.deliveryState.currentBaselineId) actions.unshift('approve_plan')
  if (task.workflow.stage === 'acceptance' && task.workKind !== 'general' && task.workflow.deliveryState?.currentDeliveryId && !task.workflow.deliveryState.passedTestRunId) actions.unshift('pass_test')
  return actions
}

export function isCruxTriageManager(snapshot: CruxSnapshot, spaceId: string, actorId: string): boolean {
  const space = snapshot.spaces.find((item) => item.id === spaceId)
  const actor = snapshot.members.find((item) => item.id === actorId)
  return Boolean(space?.memberIds.includes(actorId) && actor && (space.ownerId === actorId || actor.role === 'owner' || actor.role === 'admin'))
}

const targets: Partial<Record<CruxTaskAction, CruxTaskStage>> = {
  accept: 'accepted', arrange: 'design_ready', request_info: 'needs_info', decline: 'done',
  start_design: 'designing', submit_design: 'design_review', approve_design: 'dev_ready', return_design: 'designing',
  begin_development: 'planning', approve_plan: 'developing', submit_test: 'testing', return_development: 'developing',
  pass_test: 'acceptance', accept_delivery: 'done', return_delivery: 'developing', submit_delivery: 'acceptance'
}
const artifactKinds: Partial<Record<CruxTaskAction, CruxTaskWorkflowArtifact['kind']>> = {
  accept: 'requirements', arrange: 'requirements', request_info: 'requirements', supplement: 'requirements', decline: 'requirements',
  start_design: 'design', submit_design: 'design', approve_design: 'design', return_design: 'design',
  begin_development: 'plan', approve_plan: 'plan', submit_test: 'implementation', return_development: 'test',
  pass_test: 'test', accept_delivery: 'acceptance', return_delivery: 'acceptance', submit_delivery: 'delivery'
}
const bodyRequired = new Set<CruxTaskAction>([
  'request_info', 'supplement', 'decline', 'submit_design', 'return_design',
  'approve_plan', 'submit_test', 'return_development', 'pass_test', 'accept_delivery', 'return_delivery', 'submit_delivery'
])
const actionTitles: Record<CruxTaskAction, string> = {
  accept: '接纳需求', arrange: '接纳并安排', request_info: '请求补充', supplement: '补充信息', decline: '拒绝需求',
  start_design: '开始设计', submit_design: '提交设计', approve_design: '批准设计', return_design: '退回设计',
  begin_development: '开始技术规划', approve_plan: '批准计划', submit_test: '提交测试', return_development: '退回开发',
  pass_test: '测试通过', accept_delivery: '确认验收', return_delivery: '退回交付', submit_delivery: '提交交付', reassign: '转交任务'
}

/** Actor is supplied by the owned execution boundary, never by an IPC/HTTP payload. */
export function transitionTask(raw: CruxTransitionTaskInput, actorId: string, deliveryDependencies?: TaskDeliveryDependencies): CruxSnapshot {
  const input = cruxTransitionTaskInputSchema.parse(raw)
  return mutate((draft) => {
    const fail = (message: string): never => { throw new CruxError(message) }
    const task = draft.tasks.find((item) => item.id === input.taskId) ?? fail('任务不存在')
    const space = draft.spaces.find((item) => item.id === task.spaceId) ?? fail('空间不存在')
    if (space.archived) fail('空间已停用，请先恢复空间')
    const actor = draft.members.find((member) => member.id === actorId) ?? fail('处理成员不在该空间内')
    if (!space.memberIds.includes(actorId)) fail('处理成员不在该空间内')
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== task.updatedAt) fail('任务内容已更新，请刷新后重试')
    const categoryBefore = draft.taskStatuses.find((status) => status.id === task.statusId)?.category
    const beginAssignedPlan = input.action === 'begin_development' && canStartAssignedTaskPlan(task, actorId) &&
      input.expectedUpdatedAt === task.updatedAt && input.assigneeId === undefined && input.executor === undefined && input.adoptDeliveryProtocol === undefined
    if (!task.workflow && !task.triagePending && input.action !== 'arrange' && !beginAssignedPlan) fail('请先确认任务的负责人和工程执行方式')
    if (!task.workflow && input.action === 'reassign') fail('旧任务继续使用原有指派方式；转交操作只适用于交接流程任务')
    if (!task.workflow && (!categoryBefore || ['done', 'cancelled'].includes(categoryBefore))) fail('已完成或已取消的旧任务不能采用交接流程')
    const workflow = task.workflow ?? { stage: 'accepted' as const, artifacts: [], history: [] }
    const fromStage = workflow.stage
    const hadWorkflow = Boolean(task.workflow)
    const wasTriage = Boolean(task.triagePending)
    const cancelling = input.action === 'decline' && Boolean(task.workflow) && !task.triagePending
    const previousStatusId = task.statusId
    const workStage = fromStage === 'needs_info' ? workflow.resumeStage ?? 'accepted' : fromStage
    if (input.expectedStage !== undefined && input.expectedStage !== fromStage) fail('任务阶段已变化，请刷新后重试')
    const currentHandler = workflow.handlerId ?? task.assigneeIds[0]
    const deliveryRoles = workflow.deliveryState?.roles
    const designatedReviewer = deliveryRoles && (input.action === 'pass_test' || input.action === 'return_development' ? actorId === deliveryRoles.testOwnerId : input.action === 'accept_delivery' || input.action === 'return_delivery' ? actorId === (task.workKind === 'general' ? deliveryRoles.acceptanceOwnerId : deliveryRoles.testOwnerId) : false)
    const managesIntake = input.action !== 'reassign' && (task.triagePending || (fromStage === 'accepted' && input.action === 'arrange')) && (task.creatorId === actorId || isCruxTriageManager(draft, space.id, actorId))
    const managesReassignment = input.action === 'reassign' && isCruxTriageManager(draft, space.id, actorId)
    if (currentHandler !== actorId && !managesIntake && !managesReassignment && !designatedReviewer) fail(input.action === 'reassign' ? '只有当前处理人或本空间管理员可以转交任务' : '只有当前处理人、指定验收人、本人需求的分拣人或本空间管理员可以交接任务')
    const refreshPlanning = input.action === 'begin_development' && fromStage === 'planning'
    if (!beginAssignedPlan && !refreshPlanning && !getCruxTaskActions({ ...task, workflow }).includes(input.action)) fail('当前阶段不允许此操作')
    if (bodyRequired.has(input.action) && !input.body) fail('请填写本次交接内容或处理依据')
    if (input.workKind !== undefined && input.workKind !== task.workKind && !['accepted', 'design_ready', 'designing', 'design_review', 'dev_ready'].includes(workStage)) fail('进入实施规划后不能更改工作类型')
    const firstDeliveryCriteria = input.action === 'submit_delivery' && task.workKind === 'general' && !workflow.deliveryState && !task.acceptanceCriteria?.length
    if (input.acceptanceCriteria !== undefined && !firstDeliveryCriteria && !['accepted', 'design_ready', 'designing', 'design_review', 'dev_ready', 'planning'].includes(workStage)) fail('开始实施后不能更改验收标准')
    if (input.nextStage !== undefined && input.action !== 'arrange') fail('只有安排任务时可以选择下一阶段')
    if (input.checkedCriteria !== undefined && input.action !== 'pass_test') fail('验收条目确认仅用于提交测试通过结果')
    // Work-kind changes cannot manufacture an action that was hidden for this task.
    const workKind = input.workKind ?? task.workKind ?? 'code'
    if (input.action === 'submit_delivery' && workKind !== 'general') fail('代码任务必须提交测试并通过后再验收')
    if ((input.action === 'begin_development' || input.action === 'submit_test' || input.action === 'pass_test') && workKind !== 'code') fail('一般事务通过提交交付物进入验收')
    if (input.executor !== undefined) {
      const executor = input.executor === null ? undefined : { ...input.executor }
      validateExecutor(draft, space.id, executor)
      task.executor = executor
    }
    const crew = task.executor?.kind === 'crew' ? draft.crews.find((item) => item.id === task.executor?.id && !item.archived && item.spaceId === space.id) : undefined
    const leader = crew?.captain.kind === 'member' ? crew.captain.id : crew?.ownerId
    let handlerId = input.assigneeId ?? leader ?? currentHandler ?? actorId
    if (deliveryRoles && ['submit_test', 'pass_test', 'accept_delivery', 'submit_delivery'].includes(input.action)) handlerId = input.assigneeId ?? (workKind === 'general' ? deliveryRoles.acceptanceOwnerId : deliveryRoles.testOwnerId) ?? handlerId
    let toStage = input.action === 'reassign' ? fromStage : input.action === 'supplement' ? workflow.resumeStage ?? 'accepted' : targets[input.action] ?? fail('未知交接操作')
    if (input.action === 'arrange') toStage = workKind === 'general' ? 'developing' : input.nextStage ?? 'design_ready'
    if (input.action === 'request_info') {
      workflow.resumeStage = fromStage
      workflow.resumeAssigneeId = currentHandler ?? actorId
      handlerId = input.assigneeId ?? task.creatorId
    }
    if (input.action === 'supplement') {
      toStage = workflow.resumeStage ?? 'accepted'
      handlerId = input.assigneeId ?? workflow.resumeAssigneeId ?? leader ?? currentHandler ?? actorId
      workflow.resumeStage = undefined
      workflow.resumeAssigneeId = undefined
    }
    const recipient = draft.members.find((member) => member.id === handlerId) ?? fail('交接处理人必须是本空间成员')
    if (!space.memberIds.includes(handlerId)) fail('交接处理人必须是本空间成员')
    const structuredDelivery = Boolean(workflow.deliveryState || input.adoptDeliveryProtocol)
    const at = structuredDelivery ? new Date(Math.max(Date.now(), Date.parse(task.updatedAt) + 1)).toISOString() : nowIso()
    task.workflow = workflow
    const deliveryLinks = applyTaskDeliveryTransition(draft, task, input, actorId, handlerId, at, deliveryDependencies)
    if (!structuredDelivery && input.action === 'submit_test' && !workflow.history.some((event) => event.action === 'approve_plan')) fail('技术计划批准后才能提交代码测试')
    if (!structuredDelivery && input.action === 'pass_test') {
      const expected = new Set(task.acceptanceCriteria ?? [])
      const checked = new Set(input.checkedCriteria ?? [])
      if (!expected.size || checked.size !== expected.size || [...expected].some((criterion) => !checked.has(criterion)) || input.checkedCriteria?.length !== checked.size) fail('测试通过必须逐项确认全部验收标准，不能缺项或加入其他条目')
    }
    if (!structuredDelivery && input.action === 'accept_delivery' && workKind === 'code') {
      const lastPass = workflow.history.map((event) => event.action).lastIndexOf('pass_test')
      const lastReturn = Math.max(workflow.history.map((event) => event.action).lastIndexOf('return_delivery'), workflow.history.map((event) => event.action).lastIndexOf('return_development'))
      if (lastPass < 0 || lastPass <= lastReturn) fail('代码任务必须通过当前轮次测试后才能完成')
    }
    if (['approve_plan', 'submit_delivery', 'accept_delivery'].includes(input.action) && !(input.acceptanceCriteria ?? task.acceptanceCriteria)?.length) fail('请先填写验收标准')
    const category = input.action === 'decline' ? 'cancelled' : getCruxTaskStageMetadata(toStage).category
    const statusId = input.action === 'reassign' ? task.statusId : taskStatusForCategory(draft, task, category)
    if (input.action === 'accept' || input.action === 'arrange' || input.action === 'decline') task.triagePending = undefined
    if (input.iterationId !== undefined) {
      if (task.triagePending || input.action === 'decline') fail('请先接受任务再安排版本')
      setTaskIterations(draft, task, [...task.iterationIds, input.iterationId])
    }
    const artifactBody = input.body
    const fixedExecutionDelivery = input.executionDelivery ? { executionDelivery: input.executionDelivery } : {}
    if (artifactBody) {
      const kind = artifactKinds[input.action]
      if (kind) workflow.artifacts.push({ id: nextId('wa'), kind, body: artifactBody, actorId, at, ...(input.checkedCriteria ? { checkedCriteria: [...input.checkedCriteria] } : {}), ...(deliveryLinks ? { deliveryLinks } : {}), ...fixedExecutionDelivery })
    }
    let postInput: ReturnType<typeof fixedPostInput>
    const prior = fixedPostInput(task)
    if ((toStage === 'planning' && (fromStage !== toStage || refreshPlanning)) || input.action === 'approve_plan') {
      const current = currentPostInput({ ...task, acceptanceCriteria: input.acceptanceCriteria ?? task.acceptanceCriteria }, draft.comments)
      const initialCriteria = !task.acceptanceCriteria?.length && Boolean(input.acceptanceCriteria?.length)
      const beforeApproval = initialCriteria ? currentPostInput(task, draft.comments) : current
      if (input.action === 'approve_plan' && fromStage === 'planning' && prior && taskInputCanonical(prior) !== taskInputCanonical(beforeApproval)) {
        fail('规划期间任务依据已变化，请先按当前内容重新规划。')
      }
      if (!prior || taskInputCanonical(prior) !== taskInputCanonical(current)) postInput = current
    }
    workflow.history.push({ id: nextId('wh'), action: input.action, fromStage, toStage, actorId, assigneeId: handlerId, body: input.body, at, ...(postInput ? { postInput } : {}), ...(input.checkedCriteria ? { checkedCriteria: [...input.checkedCriteria] } : {}), ...(deliveryLinks ? { deliveryLinks } : {}), ...fixedExecutionDelivery })
    workflow.stage = toStage
    workflow.handlerId = handlerId
    task.workflow = workflow
    if (input.action !== 'reassign') task.workKind = workKind
    if (input.acceptanceCriteria !== undefined) task.acceptanceCriteria = [...input.acceptanceCriteria]
    task.assigneeIds = [handlerId]
    task.statusId = statusId
    if (input.action !== 'reassign') task.completedAt = input.action === 'accept_delivery' ? at : undefined
    task.updatedAt = at
    const label = input.action === 'decline' ? cancelling ? '已取消' : '已拒绝' : getCruxTaskStageMetadata(toStage).label
    const executionNote = input.action !== 'reassign' || input.executor === undefined ? '' : input.executor === null ? '，已清空执行配置' : `，执行配置：${task.executor?.name}`
    const sameHandlerStageArrangement = input.action === 'arrange' && hadWorkflow && !wasTriage && handlerId === currentHandler
    const actionTitle = sameHandlerStageArrangement ? '阶段推进' : actionTitles[input.action]
    const handlerNote = sameHandlerStageArrangement ? '' : `，处理人：${recipient.name}`
    draft.activities.unshift({ id: nextId('ac'), taskId: task.id, kind: 'workflow', text: `${actor.name}：${cancelling ? '取消任务' : actionTitle} → ${label}${handlerNote}${executionNote}${input.body ? `\n${input.body}` : ''}`, at })
    if (!sameHandlerStageArrangement) draft.inbox.unshift({ id: nextId('in'), section: 'important', kind: 'assign', taskId: task.id, spaceId: space.id, title: `${task.id} · ${input.action === 'reassign' ? '任务转交' : label}`, body: input.body || task.title, at, read: false, recipientIds: [handlerId] })
    if ((input.action === 'accept' || input.action === 'decline') || (input.action === 'arrange' && !sameHandlerStageArrangement)) draft.triageDecisions.unshift({ taskId: task.id, disposition: input.action === 'decline' ? 'close' : input.iterationId ? 'iterate' : 'assign', actorId, note: input.body, at })
    refreshTaskDispatch(draft, task, '任务交接')
    if (statusId !== previousStatusId) {
      const status = draft.taskStatuses.find((item) => item.id === statusId)
      if (status) evaluateAutomationsForStatus(draft, task, status.name)
    }
  }).snapshot
}
