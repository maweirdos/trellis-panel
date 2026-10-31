import type { HifoxSnapshot, HifoxTask, HifoxTaskWorkflow, HifoxTransitionTaskInput } from '../hifox'
import {
  recordTaskDeliveryInputSchema,
  type AdoptTaskDeliveryProtocol, type RecordTaskDeliveryInput, type RequirementBaselineInput,
  type TaskDelivery, type TaskDeliveryAuthorityContext, type TaskDeliveryDependencies, type TaskDeliveryEventLinks,
  type TaskDeliveryInput, type TaskDeliveryIssueDecisionInput, type TaskDeliveryIssueInput, type TaskDeliveryRoles,
  type TaskDeliveryState, type TaskMaterialReference, type TaskTestRun, type TaskTestRunInput
} from '../task-delivery'
import { HifoxError } from './core'
import { mutate, nextId } from './store'

export class TaskDeliveryError extends HifoxError {
  constructor(message: string, public readonly code: 'DELIVERY_CONFLICT' | 'DELIVERY_INVALID' | 'DELIVERY_FORBIDDEN' | 'DELIVERY_UNVERIFIED' = 'DELIVERY_INVALID') {
    super(message)
    this.name = 'TaskDeliveryError'
  }
}

function fail(message: string, code?: TaskDeliveryError['code']): never { throw new TaskDeliveryError(message, code) }
function stateOf(task: HifoxTask): TaskDeliveryState { return task.workflow?.deliveryState ?? fail('任务尚未显式采用固定交付协议') }
function workflowOf(task: HifoxTask): HifoxTaskWorkflow { return task.workflow ?? fail('请先安排任务采用交接流程') }
function baselineOf(state: TaskDeliveryState): TaskDeliveryState['baselines'][number] {
  return state.baselines.find((entry) => entry.id === state.currentBaselineId) ?? fail('当前需求基线不存在')
}
function requireAuthority(deps?: TaskDeliveryDependencies): TaskDeliveryDependencies {
  return deps ?? fail('尚未接入可信材料、环境与准出核验，请先完成核验', 'DELIVERY_UNVERIFIED')
}
function member(snapshot: HifoxSnapshot, task: HifoxTask, memberId: string): void {
  const space = snapshot.spaces.find((entry) => entry.id === task.spaceId)
  if (!space || space.archived || !space.memberIds.includes(memberId) || !snapshot.members.some((entry) => entry.id === memberId)) fail('交付责任人必须是当前可写空间成员', 'DELIVERY_FORBIDDEN')
}
function manager(snapshot: HifoxSnapshot, task: HifoxTask, actorId: string): boolean {
  const space = snapshot.spaces.find((entry) => entry.id === task.spaceId)
  const actor = snapshot.members.find((entry) => entry.id === actorId)
  return Boolean(space?.memberIds.includes(actorId) && (space.ownerId === actorId || actor?.role === 'owner' || actor?.role === 'admin'))
}
function requireHandler(task: HifoxTask, actorId: string): void {
  if ((task.workflow?.handlerId ?? task.assigneeIds[0]) !== actorId) fail('只有当前处理人可以提交交付材料', 'DELIVERY_FORBIDDEN')
}
function validateRoles(snapshot: HifoxSnapshot, task: HifoxTask, roles: TaskDeliveryRoles): void {
  for (const role of Object.values(roles)) if (role) member(snapshot, task, role)
}
function context(task: HifoxTask, actorId: string, recipientIds: string[] = []): TaskDeliveryAuthorityContext {
  return {
    taskId: task.id, taskCreatedAt: task.createdAt, spaceId: task.spaceId, actorId,
    recipientIds: [...new Set([actorId, ...Object.values(stateOf(task).roles).filter((value): value is string => Boolean(value)), ...recipientIds])],
    deliveryRevision: stateOf(task).revision
  }
}
function verifyMaterials(task: HifoxTask, actorId: string, refs: TaskMaterialReference[], deps: TaskDeliveryDependencies, recipients: string[] = []): void {
  for (const ref of refs) {
    const result = deps.verifyMaterial(context(task, actorId, recipients), structuredClone(ref))
    if (result.readable !== true || result.digest !== ref.digest) fail('固定材料不可读、权限不足或内容摘要已变化', 'DELIVERY_UNVERIFIED')
  }
}
function deliveryMaterials(delivery: TaskDeliveryInput): TaskMaterialReference[] {
  return [...delivery.materials, ...delivery.manifest.flatMap((entry) => entry.evidence), ...(delivery.testPackage?.cases.flatMap((entry) => {
    if (entry.data.kind === 'dataset') return [entry.data.recipe, entry.data.dataset]
    return entry.data.kind === 'manual' && entry.data.recipe ? [entry.data.recipe] : []
  }) ?? [])]
}
function assertFence(task: HifoxTask, expectedUpdatedAt?: string, expectedRevision?: number): void {
  if (expectedUpdatedAt !== task.updatedAt || expectedRevision !== (task.workflow?.deliveryState?.revision ?? 0)) fail('任务或交付修订已变化，请刷新后重试', 'DELIVERY_CONFLICT')
}
function appendEvent(task: HifoxTask, actorId: string, at: string, operation: string, reason?: string): void {
  const state = stateOf(task)
  state.revision += 1
  state.events.push({ id: nextId('de'), operation, actorId, at, revision: state.revision, ...(reason ? { reason } : {}) })
}
function createBaseline(task: HifoxTask, input: RequirementBaselineInput, actorId: string, at: string, deps?: TaskDeliveryDependencies): void {
  const state = stateOf(task)
  const authority = requireAuthority(deps)
  // Stable IDs cannot silently change meaning; an edited criterion gets a new identity.
  for (const item of input.criteria) {
    if (state.baselines.some((baseline) => baseline.criteria.some((previous) => previous.id === item.id && previous.text !== item.text))) fail('验收条目内容变化必须使用新的稳定 ID')
  }
  verifyMaterials(task, actorId, input.materials, authority)
  const digest = authority.digestBody(JSON.stringify({ taskId: task.id, taskCreatedAt: task.createdAt, criteria: input.criteria, materials: input.materials }))
  if (!/^[a-f0-9]{64}$/.test(digest)) fail('可信基线摘要无效', 'DELIVERY_UNVERIFIED')
  const baseline = { ...structuredClone(input), id: nextId('rb'), taskId: task.id, number: state.baselines.length + 1, digest, actorId, at }
  state.baselines.push(baseline)
  state.currentBaselineId = baseline.id
  state.approvedBaselineId = undefined
  state.currentDeliveryId = undefined
  state.passedTestRunId = undefined
  task.acceptanceCriteria = baseline.criteria.map((entry) => entry.text)
}
function adopt(snapshot: HifoxSnapshot, task: HifoxTask, protocol: AdoptTaskDeliveryProtocol, actorId: string, at: string, deps?: TaskDeliveryDependencies): void {
  const workflow = workflowOf(task)
  if (workflow.deliveryState) fail('任务已采用固定交付协议，不能重置或降级')
  if (['testing', 'acceptance', 'done'].includes(workflow.stage)) fail('请先退回处理中再采用固定交付协议；历史测试不能补造新协议证据')
  validateRoles(snapshot, task, protocol.roles)
  workflow.deliveryState = {
    version: 2, revision: 0, roles: structuredClone(protocol.roles), currentBaselineId: '',
    baselines: [], deliveries: [], testRuns: [], issues: [], issueDecisions: [], closures: [], events: []
  }
  createBaseline(task, protocol.baseline, actorId, at, deps)
}
function currentDelivery(task: HifoxTask, deliveryId?: string): TaskDelivery {
  const state = stateOf(task)
  if (!deliveryId || deliveryId !== state.currentDeliveryId) fail('请选择本轮当前交付；历史或已退回的交付不能复用')
  return state.deliveries.find((entry) => entry.id === deliveryId && entry.baselineId === state.currentBaselineId && entry.taskId === task.id) ?? fail('交付与当前任务或需求基线不一致')
}
function assertPackage(task: HifoxTask, input: TaskDeliveryInput): void {
  const expected = new Set(baselineOf(stateOf(task)).criteria.map((item) => item.id))
  if (input.manifest.length !== expected.size || input.manifest.some((item) => !expected.has(item.criterionId))) fail('交付清单必须逐项覆盖当前需求基线，不能缺项或加入其他条目')
  for (const item of input.manifest) if (item.verification === 'evidence_attached' && !item.evidence.length) fail('声称附有验证证据的交付项必须提供固定证据')
  if (input.testPackage) {
    const covered = new Set(input.testPackage.cases.map((entry) => entry.criterionId))
    if (covered.size !== expected.size || [...covered].some((criterionId) => !expected.has(criterionId))) fail('测试包必须覆盖当前基线的全部验收条目')
    for (const testCase of input.testPackage.cases) {
      if (testCase.data.kind !== 'none' && testCase.data.recipe && testCase.data.recipe.sourceKind !== 'data_recipe') fail('测试数据配方引用类型不正确')
      if (testCase.data.kind === 'dataset' && testCase.data.dataset.sourceKind !== 'dataset') fail('测试数据集引用类型不正确')
    }
  }
}
function saveDelivery(task: HifoxTask, input: TaskDeliveryInput, actorId: string, at: string, deps?: TaskDeliveryDependencies): TaskDelivery {
  requireHandler(task, actorId)
  if (workflowOf(task).stage !== 'developing') fail('只能在处理中保存新交付；请先退回当前交付')
  const state = stateOf(task)
  if (input.baselineId !== state.currentBaselineId) fail('交付依据已过期，请选择当前需求基线', 'DELIVERY_CONFLICT')
  assertPackage(task, input)
  if (deps) verifyMaterials(task, actorId, [...baselineOf(state).materials, ...deliveryMaterials(input)], deps)
  const delivery: TaskDelivery = {
    ...structuredClone(input), id: nextId('dl'), taskId: task.id, number: state.deliveries.length + 1,
    actorId, at, verification: deps ? 'verified' : 'pending'
  }
  state.deliveries.push(delivery)
  state.currentDeliveryId = delivery.id
  state.passedTestRunId = undefined
  return delivery
}
function verifyDelivery(task: HifoxTask, delivery: TaskDelivery, actorId: string, deps?: TaskDeliveryDependencies, recipients: string[] = []): void {
  const state = stateOf(task)
  assertPackage(task, delivery)
  const authority = requireAuthority(deps)
  verifyMaterials(task, actorId, [...baselineOf(state).materials, ...deliveryMaterials(delivery)], authority, recipients)
  if (delivery.manifest.some((entry) => entry.implementation !== 'implemented')) fail('当前交付仍有未实现的验收项')
  if (task.workKind !== 'general') {
    if (state.approvedBaselineId !== state.currentBaselineId) fail('当前需求基线的技术计划尚未批准')
    if (!delivery.materials.some((ref) => ref.sourceKind === 'code')) fail('代码交付必须提供可核验的固定代码修订')
    if (!delivery.environment || !delivery.testPackage) fail('测试环境或可执行测试包尚未准备')
  } else if (!delivery.materials.length && !delivery.completionRecord) fail('日常交付必须有可读成果或明确完成记录')
}
function verifyReadiness(task: HifoxTask, delivery: TaskDelivery, actorId: string, deps?: TaskDeliveryDependencies): string {
  const authority = requireAuthority(deps)
  const environment = delivery.environment ?? fail('尚未固定测试环境')
  const result = authority.verifyTestReadiness(context(task, actorId), structuredClone(delivery))
  if (result.ready !== true || !result.receiptId?.trim() || result.environmentId !== environment.id || result.environmentRevision !== environment.revision || result.deployedRevision !== environment.deployedRevision) fail('环境、部署修订或测试数据尚未通过可信就绪核验', 'DELIVERY_UNVERIFIED')
  return result.receiptId
}
function validateRun(delivery: TaskDelivery, input: TaskTestRunInput): void {
  if (input.baselineId !== delivery.baselineId || input.deliveryId !== delivery.id) fail('测试必须对应本次交付与需求基线')
  if (JSON.stringify(input.environment) !== JSON.stringify(delivery.environment)) fail('测试环境必须与固定交付的环境、部署修订和角色一致')
  const cases = delivery.testPackage?.cases ?? fail('当前交付缺少测试包')
  for (const result of input.results) {
    const testCase = cases.find((entry) => entry.id === result.caseId) ?? fail('测试结果引用了交付之外的用例')
    if (result.steps.some((step) => !testCase.steps.some((entry) => entry.id === step.stepId))) fail('测试结果引用了用例之外的步骤')
  }
}
function saveRun(task: HifoxTask, input: TaskTestRunInput, actorId: string, at: string, deps?: TaskDeliveryDependencies): TaskTestRun {
  const state = stateOf(task)
  if (!['testing', 'acceptance'].includes(workflowOf(task).stage)) fail('只能在测试或待验收中记录本轮测试结果')
  if (actorId !== state.roles.testOwnerId) requireHandler(task, actorId)
  const delivery = currentDelivery(task, input.deliveryId)
  validateRun(delivery, input)
  let readinessReceiptId: string | undefined
  if (deps) {
    verifyMaterials(task, actorId, input.results.flatMap((result) => result.steps.flatMap((step) => step.evidence)), deps)
    readinessReceiptId = verifyReadiness(task, delivery, actorId, deps)
  }
  const run: TaskTestRun = { ...structuredClone(input), id: nextId('tr'), taskId: task.id, actorId, at, verification: deps ? 'verified' : 'pending', readinessReceiptId }
  state.testRuns.push(run)
  // Even a later incomplete/failing result supersedes a previous pass for this delivery.
  state.passedTestRunId = undefined
  return run
}
function requirePassingRun(task: HifoxTask, delivery: TaskDelivery, testRunId: string | undefined, actorId: string, deps?: TaskDeliveryDependencies): TaskTestRun {
  const state = stateOf(task)
  const run = state.testRuns.find((entry) => entry.id === testRunId && entry.deliveryId === delivery.id && entry.baselineId === state.currentBaselineId) ?? fail('请选择当前交付的测试结果')
  if (state.testRuns.filter((entry) => entry.deliveryId === delivery.id).at(-1)?.id !== run.id) fail('该测试结果已被后续结果替代')
  validateRun(delivery, run)
  const cases = delivery.testPackage?.cases ?? fail('当前交付缺少测试包')
  if (run.results.length !== cases.length || cases.some((testCase) => {
    const result = run.results.find((entry) => entry.caseId === testCase.id)
    return !result || result.steps.length !== testCase.steps.length || result.steps.some((step) => step.outcome !== 'passed')
  })) fail('当前交付全部用例和步骤必须通过；未执行、失败、阻塞和跳过不算通过')
  verifyMaterials(task, actorId, run.results.flatMap((result) => result.steps.flatMap((step) => step.evidence)), requireAuthority(deps))
  verifyReadiness(task, delivery, actorId, deps)
  return run
}
function saveIssue(snapshot: HifoxSnapshot, task: HifoxTask, input: TaskDeliveryIssueInput, actorId: string, at: string, deps?: TaskDeliveryDependencies): void {
  const state = stateOf(task)
  member(snapshot, task, input.assigneeId)
  const baseline = state.baselines.find((entry) => entry.id === input.baselineId) ?? fail('问题引用的基线不存在')
  if (input.criterionIds.some((criterionId) => !baseline.criteria.some((entry) => entry.id === criterionId))) fail('问题必须关联其基线中的验收条目')
  const delivery = input.deliveryId ? state.deliveries.find((entry) => entry.id === input.deliveryId && entry.baselineId === input.baselineId) ?? fail('问题交付与基线不一致') : undefined
  const run = input.testRunId ? state.testRuns.find((entry) => entry.id === input.testRunId && entry.deliveryId === delivery?.id) ?? fail('问题测试与交付不一致') : undefined
  const testCase = input.caseId ? delivery?.testPackage?.cases.find((entry) => entry.id === input.caseId) ?? fail('问题用例不属于该交付') : undefined
  if (testCase && !input.criterionIds.includes(testCase.criterionId)) fail('缺陷验收条目必须包含失败用例对应条目')
  if (input.stepId && !testCase?.steps.some((entry) => entry.id === input.stepId)) fail('问题步骤不属于该用例')
  if (input.kind === 'defect' && !run?.results.find((entry) => entry.caseId === input.caseId)?.steps.some((step) => step.stepId === input.stepId && ['failed', 'blocked'].includes(step.outcome))) fail('缺陷必须关联已记录的失败或阻塞步骤')
  if (deps) verifyMaterials(task, actorId, input.evidence, deps, [input.assigneeId])
  state.issues.push({ ...structuredClone(input), id: nextId('di'), taskId: task.id, actorId, at, verification: deps ? 'verified' : 'pending' })
  snapshot.inbox.unshift({ id: nextId('in'), section: 'important', kind: 'assign', taskId: task.id, spaceId: task.spaceId, title: `${task.id} · ${input.kind === 'defect' ? '缺陷' : '业务疑问'}`, body: input.title, at, read: false, recipientIds: [input.assigneeId] })
}
function decideIssue(task: HifoxTask, input: TaskDeliveryIssueDecisionInput, actorId: string, at: string, deps?: TaskDeliveryDependencies): void {
  const state = stateOf(task)
  const issue = state.issues.find((entry) => entry.id === input.issueId) ?? fail('问题不存在')
  const ownerId = issue.kind === 'product_question' ? state.roles.productOwnerId : state.roles.testOwnerId
  if (actorId !== ownerId) fail('仅指定产品负责人可以处理业务疑问；仅指定测试负责人可以裁定缺陷', 'DELIVERY_FORBIDDEN')
  if (input.decision === 'waived' && issue.kind === 'defect' && (issue.severity === 'P0' || issue.severity === 'P1')) fail('P0/P1 缺陷不能通过普通豁免关闭')
  if (input.decision !== 'reopened' || input.evidence.length) verifyMaterials(task, actorId, input.evidence, requireAuthority(deps))
  if (input.decision !== 'reopened') {
    if (issue.kind === 'defect' && input.decision === 'resolved') {
      const delivery = currentDelivery(task, state.currentDeliveryId)
      if (delivery.id === issue.deliveryId) fail('缺陷修复必须关联新的固定交付与复测结果')
      if (issue.criterionIds.some((criterionId) => !delivery.testPackage?.cases.some((entry) => entry.criterionId === criterionId))) fail('复测必须覆盖缺陷关联的全部验收条目，不能用删除条目绕过修复')
      requirePassingRun(task, delivery, input.testRunId, actorId, deps)
    }
  }
  state.issueDecisions.push({ ...structuredClone(input), id: nextId('dd'), actorId, at })
}
function assertNoBlockers(task: HifoxTask): void {
  const state = stateOf(task)
  for (const issue of state.issues) {
    // Changing a baseline must never erase an unresolved business question or defect.
    const decision = state.issueDecisions.filter((entry) => entry.issueId === issue.id).at(-1)
    const unresolved = !decision || decision.decision === 'reopened'
    if (unresolved && (issue.kind === 'product_question' || issue.blocksClosure || issue.severity === 'P0' || issue.severity === 'P1')) fail(`准出受阻：${issue.title}`)
  }
}

/** Writes a fixed record without advancing the business stage. Handoff can be retried independently. */
export function recordTaskDelivery(raw: RecordTaskDeliveryInput, actorId: string, deps?: TaskDeliveryDependencies): HifoxSnapshot {
  const input = recordTaskDeliveryInputSchema.parse(raw)
  return mutate((draft) => {
    const task = draft.tasks.find((entry) => entry.id === input.taskId) ?? fail('任务不存在')
    member(draft, task, actorId)
    const workflow = workflowOf(task)
    if (workflow.stage === 'done') fail('已关闭任务的交付记录不能修改')
    assertFence(task, input.expectedUpdatedAt, input.expectedDeliveryRevision)
    const at = new Date(Math.max(Date.now(), Date.parse(task.updatedAt) + 1)).toISOString()
    if (input.operation === 'adopt') {
      if (!manager(draft, task, actorId)) requireHandler(task, actorId)
      adopt(draft, task, input.protocol, actorId, at, deps)
    } else {
      const state = stateOf(task)
      if (input.operation === 'baseline') {
        if (state.roles.productOwnerId) {
          if (actorId !== state.roles.productOwnerId) fail('修订业务基线需指定产品负责人确认', 'DELIVERY_FORBIDDEN')
        } else if (!manager(draft, task, actorId)) requireHandler(task, actorId)
        if (['testing', 'acceptance', 'needs_info'].includes(workflow.stage)) fail('请先退回处理中再修订需求基线')
        createBaseline(task, input.baseline, actorId, at, deps)
      } else if (input.operation === 'roles') {
        if (!manager(draft, task, actorId)) fail('仅本空间管理员可以修改交付职责授权', 'DELIVERY_FORBIDDEN')
        validateRoles(draft, task, input.roles)
        if (state.roles.testOwnerId !== input.roles.testOwnerId) state.passedTestRunId = undefined
        state.roles = structuredClone(input.roles)
      } else if (input.operation === 'delivery') saveDelivery(task, input.delivery, actorId, at, deps)
      else if (input.operation === 'test_run') saveRun(task, input.testRun, actorId, at, deps)
      else if (input.operation === 'issue') saveIssue(draft, task, input.issue, actorId, at, deps)
      else decideIssue(task, input.decision, actorId, at, deps)
    }
    appendEvent(task, actorId, at, input.operation, input.operation === 'roles' ? input.reason : undefined)
    task.updatedAt = at
    const titles: Record<RecordTaskDeliveryInput['operation'], string> = { adopt: '采用固定交付流程', baseline: '修订需求基线', roles: '调整交付责任人', delivery: '保存交付', test_run: '记录测试结果', issue: '登记问题', issue_decision: '确认问题处理结论' }
    draft.activities.unshift({ id: nextId('ac'), taskId: task.id, kind: 'delivery', text: `${draft.members.find((entry) => entry.id === actorId)?.name ?? actorId}：${titles[input.operation]}`, at })
  }).snapshot
}

/** Called inside transitionTask's single draft; failures roll back records, history, stage and version indexes together. */
export function applyTaskDeliveryTransition(snapshot: HifoxSnapshot, task: HifoxTask, input: HifoxTransitionTaskInput, actorId: string, handlerId: string, at: string, deps?: TaskDeliveryDependencies): TaskDeliveryEventLinks | undefined {
  if (!task.workflow?.deliveryState && !input.adoptDeliveryProtocol) {
    if (input.delivery || input.deliveryId || input.testRun || input.testRunId || input.expectedDeliveryRevision !== undefined) fail('使用结构化交付前必须显式采用固定交付协议')
    return undefined
  }
  assertFence(task, input.expectedUpdatedAt, input.expectedDeliveryRevision)
  if (input.adoptDeliveryProtocol) adopt(snapshot, task, input.adoptDeliveryProtocol, actorId, at, deps)
  const state = stateOf(task)
  if (input.workKind !== undefined && task.workKind !== undefined && input.workKind !== task.workKind) fail('采用固定交付协议后不能切换工作类型绕过验收')
  if (input.acceptanceCriteria && JSON.stringify(input.acceptanceCriteria) !== JSON.stringify(baselineOf(state).criteria.map((entry) => entry.text))) fail('验收标准必须通过新需求基线修订')
  if (input.checkedCriteria !== undefined) fail('固定交付协议使用稳定条目和测试结果，不能以文字勾选代替')
  const links: TaskDeliveryEventLinks = { baselineId: state.currentBaselineId }
  if (input.action === 'approve_plan') {
    verifyMaterials(task, actorId, baselineOf(state).materials, requireAuthority(deps))
    state.approvedBaselineId = state.currentBaselineId
  }
  if (['submit_test', 'submit_delivery', 'pass_test', 'return_development', 'accept_delivery', 'return_delivery'].includes(input.action)) {
    if (input.delivery) saveDelivery(task, input.delivery, actorId, at, deps)
    const delivery = currentDelivery(task, input.delivery ? state.currentDeliveryId : input.deliveryId)
    links.deliveryId = delivery.id
    if (input.action === 'submit_test' || input.action === 'submit_delivery') {
      const ownerId = task.workKind === 'general' ? state.roles.acceptanceOwnerId : state.roles.testOwnerId
      if (!ownerId || handlerId !== ownerId) fail('交付必须交给明确指定的测试或验收负责人')
      member(snapshot, task, ownerId)
      verifyDelivery(task, delivery, actorId, deps, [handlerId])
      if (task.workKind !== 'general') verifyReadiness(task, delivery, actorId, deps)
    }
    if (input.testRun) links.testRunId = saveRun(task, input.testRun, actorId, at, deps).id
    else if (input.testRunId) {
      if (!state.testRuns.some((run) => run.id === input.testRunId && run.deliveryId === delivery.id && run.baselineId === state.currentBaselineId)) fail('测试记录不属于当前交付和需求基线')
      links.testRunId = input.testRunId
    }
    if (input.action === 'pass_test') {
      if (actorId !== state.roles.testOwnerId || handlerId !== state.roles.testOwnerId) fail('仅指定测试负责人可以确认测试通过并接续验收', 'DELIVERY_FORBIDDEN')
      verifyDelivery(task, delivery, actorId, deps)
      const run = requirePassingRun(task, delivery, links.testRunId, actorId, deps)
      assertNoBlockers(task)
      state.passedTestRunId = run.id
    }
    if (input.action === 'accept_delivery') {
      const ownerId = task.workKind === 'general' ? state.roles.acceptanceOwnerId : state.roles.testOwnerId
      if (actorId !== ownerId || handlerId !== ownerId) fail('仅任务明确指定的验收负责人可以终结任务', 'DELIVERY_FORBIDDEN')
      verifyDelivery(task, delivery, actorId, deps)
      if (task.workKind !== 'general') {
        if (!state.passedTestRunId || links.testRunId !== state.passedTestRunId) fail('缺少本轮测试通过确认；历史通过不能继承')
        requirePassingRun(task, delivery, links.testRunId, actorId, deps)
      }
      assertNoBlockers(task)
      const gate = requireAuthority(deps).checkClosure(context(task, actorId), structuredClone(delivery))
      if (!gate.receiptId?.trim() || !Array.isArray(gate.blockers) || gate.blockers.length) fail('可信准出核验未通过，仍有业务疑问、缺陷或独立评审待确认', 'DELIVERY_UNVERIFIED')
      const closure = { id: nextId('cl'), taskId: task.id, baselineId: state.currentBaselineId, deliveryId: delivery.id, testRunId: links.testRunId, criterionIds: baselineOf(state).criteria.map((entry) => entry.id), gateReceiptId: gate.receiptId, actorId, at }
      state.closures.push(closure)
      links.closureId = closure.id
    }
    if (input.action === 'return_development' || input.action === 'return_delivery') {
      state.currentDeliveryId = undefined
      state.passedTestRunId = undefined
    }
  }
  appendEvent(task, actorId, at, input.action, input.body)
  links.deliveryRevision = state.revision
  return links
}
