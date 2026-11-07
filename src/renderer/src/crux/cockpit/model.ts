import type { CruxSnapshot, CruxStatusCategory, CruxTask, CruxTaskAction } from '@shared/crux'
import type { CruxWorkspaceContext } from '@shared/crux-remote'
import { getCruxTaskActions, getCruxTaskStageMetadata, isCruxTriageManager } from '@shared/crux-domain/workflow'

export type NextStepGroup = 'confirm' | 'blocked' | 'handle' | 'continue'
export const NEXT_STEP_GROUPS: { id: NextStepGroup; label: string }[] = [
  { id: 'confirm', label: '需要我确认' }, { id: 'blocked', label: '我的阻塞' },
  { id: 'handle', label: '我负责的待处理' }, { id: 'continue', label: '继续最近工作' }
]
const confirmations = new Set<CruxTaskAction>(['accept', 'arrange', 'approve_design', 'approve_plan', 'pass_test', 'accept_delivery'])
const secondary = new Set<CruxTaskAction>(['request_info', 'decline', 'return_design', 'return_development', 'return_delivery', 'reassign'])
const priorities = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

export function cockpitActor(snapshot: CruxSnapshot, context: CruxWorkspaceContext): string | undefined {
  return context.actorId ?? (context.state === 'local' ? snapshot.members.find((member) => member.role === 'owner')?.id : undefined)
}

export function cockpitSpaces(snapshot: CruxSnapshot, context: CruxWorkspaceContext): Set<string> {
  const actor = cockpitActor(snapshot, context)
  return new Set(context.state === 'access-revoked' ? [] : snapshot.spaces.filter((space) =>
    context.state === 'local' || actor && space.memberIds.includes(actor)).map((space) => space.id))
}

export function taskCategory(snapshot: CruxSnapshot, task: CruxTask): CruxStatusCategory | undefined {
  return snapshot.taskStatuses.find((status) => status.id === task.statusId && status.spaceId === task.spaceId)?.category
}

export function taskIsDone(snapshot: CruxSnapshot, task: CruxTask): boolean {
  return !task.triagePending && taskCategory(snapshot, task) === 'done' && (!task.workflow || task.workflow.stage === 'done')
}

export function taskStage(snapshot: CruxSnapshot, task: CruxTask): string {
  if (taskCategory(snapshot, task) === 'cancelled') return '已取消'
  if (task.triagePending) return task.workflow?.stage === 'needs_info' ? '待补充 · 分拣' : '待分拣'
  return task.workflow ? getCruxTaskStageMetadata(task.workflow.stage).label :
    snapshot.taskStatuses.find((status) => status.id === task.statusId && status.spaceId === task.spaceId)?.name ?? '阶段未报告'
}

export interface TaskInsight {
  task: CruxTask
  stage: string
  handlerId?: string
  action: CruxTaskAction | null
  canAct: boolean
  blockers: CruxTask[]
  missing: string[]
  waiting: string | null
  lastConfirmedAt: string
  deadline?: string
  group: NextStepGroup | null
}

/** Only business facts determine responsibility and progress. Runtime presence is never a progress estimate. */
export function taskInsights(snapshot: CruxSnapshot, context: CruxWorkspaceContext): TaskInsight[] {
  const actor = cockpitActor(snapshot, context)
  const spaces = cockpitSpaces(snapshot, context)
  const tasks = snapshot.tasks.filter((task) => spaces.has(task.spaceId))
  const incoming = new Map<string, CruxTask[]>()
  for (const source of tasks) for (const relation of source.relations) {
    if (relation.kind !== 'blocks' || taskIsDone(snapshot, source)) continue
    const entries = incoming.get(relation.taskId) ?? []
    if (!entries.some((task) => task.id === source.id)) entries.push(source)
    incoming.set(relation.taskId, entries)
  }
  return tasks.map((task) => {
    const space = snapshot.spaces.find((item) => item.id === task.spaceId)
    const category = taskCategory(snapshot, task)
    const closed = category === 'cancelled' || taskIsDone(snapshot, task)
    const handlerId = task.workflow?.handlerId ?? task.assigneeIds[0]
    const managesIntake = actor && (task.triagePending || !task.workflow || task.workflow.stage === 'accepted') &&
      (task.creatorId === actor || isCruxTriageManager(snapshot, task.spaceId, actor))
    const roles = task.workflow?.deliveryState?.roles
    const allowed = !closed && actor ? getCruxTaskActions(task).filter((action) => {
      const reviewer = roles && (['pass_test', 'return_development'].includes(action) ? roles.testOwnerId === actor :
        ['accept_delivery', 'return_delivery'].includes(action) ? (task.workKind === 'general' ? roles.acceptanceOwnerId : roles.testOwnerId) === actor : false)
      return handlerId === actor || managesIntake || reviewer
    }) : []
    const action = allowed.find((candidate) => !secondary.has(candidate)) ?? null
    const blockers = closed ? [] : incoming.get(task.id) ?? []
    const missing: string[] = []
    if (!closed && !handlerId) missing.push('尚未指定当前处理人')
    if (!category) missing.push('工作状态未报告')
    if (!closed && (!task.acceptanceCriteria?.length) && (task.workKind === 'code' || ['begin_development', 'approve_plan', 'submit_delivery', 'accept_delivery'].includes(action ?? ''))) missing.push('缺少验收标准')
    if (action === 'approve_plan' && !task.workflow?.artifacts.some((artifact) => artifact.kind === 'plan')) missing.push('需填写并确认技术计划')
    if (action === 'submit_design') missing.push('需提供本次设计成果')
    if (action === 'submit_test' && !task.workflow?.history.some((event) => event.action === 'approve_plan')) missing.push('技术计划尚未批准')
    if (action === 'pass_test' && !task.workflow?.deliveryState) missing.push('需逐项确认当前验收标准')
    if (action === 'supplement') missing.push('需补充请求的信息')
    const delivery = task.workflow?.deliveryState
    if (delivery) {
      if (['submit_test', 'submit_delivery', 'pass_test', 'accept_delivery'].includes(action ?? '') && !delivery.currentDeliveryId) missing.push('尚无本轮固定交付')
      if (task.workKind !== 'general' && ['submit_test', 'accept_delivery'].includes(action ?? '') && delivery.approvedBaselineId !== delivery.currentBaselineId) missing.push('当前需求基线尚未批准')
      if (action === 'accept_delivery' && task.workKind !== 'general' && !delivery.passedTestRunId) missing.push('尚无当前交付的通过测试结果')
    }
    if (!closed && space?.archived) missing.push('空间已停用 · 历史只读')
    if (!closed && context.state === 'offline') missing.push('离线 · 操作前需恢复连接')
    const waiting = blockers.length ? `等待 ${blockers.map((entry) => entry.id).join('、')}` :
      category === 'blocked' ? task.workflow?.stage === 'needs_info' ? '等待补充信息' : '任务标记受阻，原因待确认' :
      task.dispatch?.status === 'waiting_runtime' ? '等待运行环境 · 尚未报告执行' :
      !action && !closed ? handlerId ? `等待 ${snapshot.members.find((member) => member.id === handlerId)?.name ?? '原处理人（成员不可用）'}` : '等待明确责任人' : null
    const related = Boolean(actor && (task.assigneeIds.includes(actor) || handlerId === actor || action))
    const recent = Boolean(actor && (task.workflow?.history.some((event) => event.actorId === actor) || snapshot.comments.some((comment) => comment.taskId === task.id && comment.authorId === actor)))
    const group: NextStepGroup | null = closed || !actor ? null : related && (blockers.length > 0 || category === 'blocked') ? 'blocked' :
      action && confirmations.has(action) ? 'confirm' : related ? 'handle' : recent ? 'continue' : null
    const deadlines = snapshot.iterations.filter((version) => version.spaceId === task.spaceId && version.status !== 'completed' &&
      (task.iterationIds.includes(version.id) || version.taskIds.includes(task.id))).map((version) => version.endDate).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort()
    return { task, stage: taskStage(snapshot, task), handlerId, action, blockers, missing, waiting, group,
      canAct: Boolean(action && !space?.archived && (context.state === 'local' || context.state === 'connected')),
      lastConfirmedAt: task.workflow?.history.at(-1)?.at ?? task.updatedAt, deadline: deadlines[0] }
  })
}

export function nextSteps(insights: TaskInsight[], today: string): TaskInsight[] {
  return insights.filter((item) => item.group).sort((a, b) => {
    if (a.group === 'continue' && b.group === 'continue') return b.task.updatedAt.localeCompare(a.task.updatedAt) || a.task.id.localeCompare(b.task.id)
    return Number(Boolean(b.deadline && b.deadline < today)) - Number(Boolean(a.deadline && a.deadline < today)) ||
      priorities[a.task.priority] - priorities[b.task.priority] || a.lastConfirmedAt.localeCompare(b.lastConfirmedAt) || a.task.id.localeCompare(b.task.id)
  })
}

export interface CockpitScope { spaceId: string; iterationId?: string; projectId?: string; from?: string; to?: string }

export function cockpitDataset(snapshot: CruxSnapshot, context: CruxWorkspaceContext, scope: CockpitScope) {
  const version = scope.iterationId ? snapshot.iterations.find((item) => item.id === scope.iterationId && item.spaceId === scope.spaceId) : undefined
  const versionIds = version ? new Set(version.taskIds) : null
  const all = taskInsights(snapshot, context)
  const tasks = all.filter(({ task }) => task.spaceId === scope.spaceId &&
    (!scope.iterationId || Boolean(version && (versionIds?.has(task.id) || task.iterationIds.includes(version.id)))) &&
    (!scope.projectId || task.projectId === scope.projectId) &&
    (!scope.from || task.updatedAt.slice(0, 10) >= scope.from) && (!scope.to || task.updatedAt.slice(0, 10) <= scope.to))
  const missingIds = version && !scope.projectId && !scope.from && !scope.to ? [...new Set(version.taskIds)].filter((id) => !snapshot.tasks.some((task) => task.id === id && task.spaceId === scope.spaceId)) : []
  const done = tasks.filter((item) => taskIsDone(snapshot, item.task))
  const cancelled = tasks.filter((item) => taskCategory(snapshot, item.task) === 'cancelled')
  const unknown = tasks.filter((item) => !taskCategory(snapshot, item.task) || taskCategory(snapshot, item.task) === 'done' && !taskIsDone(snapshot, item.task))
  const active = tasks.filter((item) => !done.includes(item) && !cancelled.includes(item))
  const blocked = active.filter((item) => item.blockers.length || taskCategory(snapshot, item.task) === 'blocked')
  const waiting = active.filter((item) => item.waiting || ['design_review', 'testing', 'acceptance', 'needs_info'].includes(item.task.workflow?.stage ?? ''))
  const testing = active.filter((item) => item.task.workflow?.stage === 'testing' || snapshot.taskTypes.some((type) => type.id === item.task.typeId && /bug|缺陷/i.test(type.name)))
  return { tasks, done, cancelled, unknown, active, blocked, waiting, testing, missingIds,
    denominator: tasks.length - cancelled.length + missingIds.length,
    incomplete: unknown.length > 0 || missingIds.length > 0 || Boolean(scope.iterationId && !version) }
}

export function localCalendarDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
