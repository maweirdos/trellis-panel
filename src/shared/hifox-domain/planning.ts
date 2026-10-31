/**
 * HiFox 计划域服务：专项、版本、视图、分拣台、自动化。
 * 业务规则来源：docs/prd-hifox 3.4~3.8。
 * 注意：本文件不得 import core.ts（core → planning 单向依赖）；小工具函数就地实现。
 */
import type {
  HifoxActivity,
  HifoxAutomation,
  HifoxAutomationInput,
  HifoxAutomationRun,
  HifoxID,
  HifoxIteration,
  HifoxMilestone,
  HifoxMilestoneCommandInput,
  HifoxSaveMilestoneInput,
  HifoxProject,
  HifoxRecordVersionDeliveryInput,
  HifoxSnapshot,
  HifoxTask,
  HifoxTriageDecision,
  HifoxView,
  HifoxViewFilter
} from '../hifox'
import { loadSnapshot, mutate, nextId, nowIso } from './store'
import { hifoxRecordVersionDeliveryInputSchema, hifoxSaveMilestoneInputSchema, hifoxMilestoneCommandInputSchema } from '../hifox-schema'

export class HifoxError extends Error {}

function fail(message: string): never {
  throw new HifoxError(message)
}

function taskOf(draft: HifoxSnapshot, id: HifoxID): HifoxTask {
  return draft.tasks.find((t) => t.id === id) ?? fail('任务不存在')
}

function pushActivity(draft: HifoxSnapshot, taskId: HifoxID, kind: string, text: string): void {
  const activity: HifoxActivity = { id: nextId('ac'), taskId, kind, text, at: nowIso() }
  draft.activities.unshift(activity)
}

/** Resolve a category within the task type's workflow, never the space alone. */
export function taskStatusForCategory(draft: HifoxSnapshot, task: HifoxTask, category: string): HifoxID {
  const type = draft.taskTypes.find((t) => t.id === task.typeId && t.spaceId === task.spaceId)
  return draft.taskStatuses
    .filter((s) => s.spaceId === task.spaceId && s.category === category && (!type?.statusIds?.length || type.statusIds.includes(s.id)))
    .sort((a, b) => a.order - b.order)[0]?.id ?? fail(`任务类型缺少可用的 ${category} 状态`)
}

/** All task state writers use the same non-runtime dispatch boundary. */
export function refreshTaskDispatch(draft: HifoxSnapshot, task: HifoxTask, reason: string): void {
  const executor = task.executor
  const category = draft.taskStatuses.find((s) => s.id === task.statusId)?.category
  const available = executor ? executionTargetAvailable(draft, task.spaceId, executor) : false
  if (!executor || !available || task.triagePending || !['backlog', 'todo', 'in_progress'].includes(category ?? '')) {
    if (task.dispatch) {
      task.dispatch = undefined
      pushActivity(draft, task.id, 'dispatch', `${reason}：当前任务不派发执行`)
    }
    return
  }
  const next = category === 'backlog' ? 'queued' : 'waiting_runtime'
  const note = next === 'queued'
    ? `已指派给 ${executor.name}，当前待规划，进入 Todo 后等待 Runtime 接入执行`
    : `已指派给 ${executor.name}，等待 Runtime 接入后执行`
  if (!task.dispatch || task.dispatch.status !== next || task.dispatch.note !== note) {
    task.dispatch = { status: next, since: nowIso(), note }
    pushActivity(draft, task.id, 'dispatch', `${reason}：${note}`)
  }
}

/** Shared by assignments, dispatch refresh and automation receipts. */
function executionTargetAvailable(draft: HifoxSnapshot, spaceId: HifoxID, target: HifoxAutomation['target']): boolean {
  if (target.kind !== 'agent' && target.kind !== 'crew') return false
  const crew = target.kind === 'crew' ? draft.crews.find((c) => c.id === target.id && c.spaceId === spaceId && !c.archived) : undefined
  if (target.kind === 'crew' && !crew) return false
  if (crew && !crewCaptainAvailable(draft, crew.id)) return false
  const agentIds = target.kind === 'agent' ? [target.id] : crew?.members.filter((member) => member.kind === 'agent').map((member) => member.id) ?? []
  return draft.agents.some((a) => agentIds.includes(a.id) && a.spaceId === spaceId && a.enabled && !a.archived
    && (!a.exclusiveCrewId || (target.kind === 'crew' && a.exclusiveCrewId === crew?.id)))
}

function crewCaptainAvailable(draft: HifoxSnapshot, crewId: HifoxID): boolean {
  const crew = draft.crews.find((item) => item.id === crewId && !item.archived)
  if (!crew) return false
  if (crew.captain.kind === 'member') return draft.spaces.find((space) => space.id === crew.spaceId)?.memberIds.includes(crew.captain.id) === true && draft.members.some((member) => member.id === crew.captain.id)
  return draft.agents.some((agent) => agent.id === crew.captain.id && agent.spaceId === crew.spaceId && agent.enabled && !agent.archived && (!agent.exclusiveCrewId || agent.exclusiveCrewId === crew.id))
}

/** Maintain both membership indexes from either task or iteration mutations. */
export function setTaskIterations(draft: HifoxSnapshot, task: HifoxTask, iterationIds: HifoxID[]): void {
  const next = [...new Set(iterationIds)]
  for (const iteration of draft.iterations) {
    if (iteration.status === 'completed' && task.iterationIds.includes(iteration.id) !== next.includes(iteration.id)) fail('已关闭版本的任务范围不能增删')
  }
  for (const id of next) {
    const iteration = draft.iterations.find((it) => it.id === id && it.spaceId === task.spaceId) ?? fail('版本不属于该空间')
    if (iteration.status === 'completed') continue
    const isNew = !task.iterationIds.includes(id) || !iteration.taskIds.includes(task.id)
    if (isNew && task.triagePending) fail('待分拣任务需先接受后再加入版本')
  }
  for (const iteration of draft.iterations) {
    if (iteration.status === 'completed') continue
    if (next.includes(iteration.id)) iteration.taskIds = [...new Set([...iteration.taskIds, task.id])]
    else iteration.taskIds = iteration.taskIds.filter((id) => id !== task.id)
  }
  task.iterationIds = next
}

/* ---------------- 专项（PRD 3.4） ---------------- */

export function createProject(input: { spaceId: HifoxID; name: string; goal?: string; ownerIds?: HifoxID[] }): HifoxSnapshot {
  return mutate((draft) => {
    const space = draft.spaces.find((s) => s.id === input.spaceId) ?? fail('空间不存在')
    if (!input.name.trim()) fail('专项名称不能为空')
    for (const id of input.ownerIds ?? []) {
      if (!space.memberIds.includes(id) || !draft.members.some((m) => m.id === id)) fail('专项负责人不在该空间内')
    }
    const project: HifoxProject = {
      id: nextId('pr'),
      spaceId: input.spaceId,
      name: input.name.trim(),
      goal: input.goal?.trim() || undefined,
      status: 'active',
      ownerIds: [...new Set(input.ownerIds ?? [])],
      createdAt: nowIso()
    }
    draft.projects.push(project)
    return project.id
  }).snapshot
}

export function updateProject(input: { id: HifoxID; name?: string; goal?: string; ownerIds?: HifoxID[]; status?: HifoxProject['status'] }): HifoxSnapshot {
  return mutate((draft) => {
    const project = draft.projects.find((p) => p.id === input.id) ?? fail('专项不存在')
    if (input.ownerIds !== undefined) {
      const space = draft.spaces.find((s) => s.id === project.spaceId) ?? fail('空间不存在')
      for (const id of input.ownerIds) {
        if (!space.memberIds.includes(id) || !draft.members.some((m) => m.id === id)) fail('专项负责人不在该空间内')
      }
      project.ownerIds = [...new Set(input.ownerIds)]
    }
    if (input.name !== undefined) {
      if (!input.name.trim()) fail('专项名称不能为空')
      project.name = input.name.trim()
    }
    if (input.goal !== undefined) project.goal = input.goal.trim() || undefined
    if (input.status !== undefined) {
      if (!['active', 'done', 'archived'].includes(input.status)) fail('专项状态无效')
      project.status = input.status
    }
    return undefined
  }).snapshot
}

/* ---------------- 版本（PRD 3.6） ---------------- */

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('日期格式应为 YYYY-MM-DD')
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail('日期不存在')
}

function validatePredecessor(draft: HifoxSnapshot, iteration: Pick<HifoxIteration, 'id' | 'spaceId'>, predecessorId?: HifoxID | null): void {
  const seen = new Set([iteration.id])
  let id = predecessorId
  while (id) {
    if (seen.has(id)) fail('版本先后顺序不能形成循环')
    seen.add(id)
    const predecessor = draft.iterations.find((item) => item.id === id && item.spaceId === iteration.spaceId) ?? fail('前置版本必须属于同一空间')
    id = predecessor.predecessorId
  }
}

export function createIteration(input: { spaceId: HifoxID; name: string; goal?: string; startDate: string; endDate: string; taskIds?: HifoxID[]; predecessorId?: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    if (!draft.spaces.some((s) => s.id === input.spaceId)) fail('空间不存在')
    if (!input.name.trim()) fail('版本名称不能为空')
    validateDate(input.startDate)
    validateDate(input.endDate)
    if (input.endDate < input.startDate) fail('结束日期不能早于开始日期')
    const taskIds = [...new Set(input.taskIds ?? [])]
    for (const id of taskIds) if (taskOf(draft, id).spaceId !== input.spaceId) fail('版本任务必须属于同一空间')
    const iteration: HifoxIteration = {
      id: nextId('it'),
      spaceId: input.spaceId,
      name: input.name.trim(),
      goal: input.goal?.trim() || undefined,
      startDate: input.startDate,
      endDate: input.endDate,
      status: 'pending',
      taskIds: [],
      predecessorId: input.predecessorId
    }
    validatePredecessor(draft, iteration, input.predecessorId)
    draft.iterations.push(iteration)
    for (const task of draft.tasks) {
      if (taskIds.includes(task.id)) setTaskIterations(draft, task, [...task.iterationIds, iteration.id])
    }
    iteration.taskIds = taskIds
    return iteration.id
  }).snapshot
}

export function updateIteration(input: { id: HifoxID; name?: string; goal?: string; startDate?: string; endDate?: string; status?: HifoxIteration['status']; taskIds?: HifoxID[]; predecessorId?: HifoxID | null }): HifoxSnapshot {
  return mutate((draft) => {
    const iteration = draft.iterations.find((it) => it.id === input.id) ?? fail('版本不存在')
    if (input.status === 'completed') fail('请通过完成版本操作检查未完成任务')
    if (input.predecessorId !== undefined) {
      validatePredecessor(draft, iteration, input.predecessorId)
      iteration.predecessorId = input.predecessorId ?? undefined
    }
    if ((input.status === 'active' || input.predecessorId !== undefined) && (input.status ?? iteration.status) === 'active' && iteration.predecessorId) {
      const predecessor = draft.iterations.find((item) => item.id === iteration.predecessorId && item.spaceId === iteration.spaceId) ?? fail('前置版本必须属于同一空间')
      if (predecessor.status !== 'completed') fail('前置版本尚未完成，不能启动后续版本')
    }
    if (input.startDate !== undefined || input.endDate !== undefined) {
      if (iteration.status === 'completed') fail('已完成版本不能修改日期')
      if (input.startDate !== undefined && input.startDate !== iteration.startDate && iteration.status !== 'pending') fail('只能修改未开始版本的开始日期')
      const startDate = input.startDate ?? iteration.startDate
      const endDate = input.endDate ?? iteration.endDate
      validateDate(startDate)
      validateDate(endDate)
      if (endDate < startDate) fail('结束日期不能早于开始日期')
      iteration.startDate = startDate
      iteration.endDate = endDate
    }
    if (input.name !== undefined) {
      if (!input.name.trim()) fail('版本名称不能为空')
      iteration.name = input.name.trim()
    }
    if (input.goal !== undefined) iteration.goal = input.goal.trim() || undefined
    if (input.status !== undefined) {
      if (!['pending', 'active'].includes(input.status)) fail('版本状态无效')
      if (iteration.status === 'completed') fail('已完成版本不能重新开始')
      iteration.status = input.status
    }
    if (input.taskIds !== undefined) {
      const next = [...new Set(input.taskIds)]
      if (iteration.status === 'completed') {
        const previous = new Set(iteration.taskIds)
        if (next.length !== previous.size || next.some((id) => !previous.has(id))) fail('已关闭版本的任务范围不能增删')
        return undefined
      }
      for (const id of next) if (taskOf(draft, id).spaceId !== iteration.spaceId) fail('版本任务必须属于同一空间')
      for (const task of draft.tasks) {
        const shouldContain = next.includes(task.id)
        const ids = task.iterationIds.filter((id) => id !== iteration.id)
        if (shouldContain) ids.push(iteration.id)
        if (shouldContain || task.iterationIds.includes(iteration.id) || iteration.taskIds.includes(task.id)) setTaskIterations(draft, task, ids)
      }
      iteration.taskIds = next
    }
    return undefined
  }).snapshot
}

/** Closing a version preserves its explicitly selected scope and all historical links. */
export function completeIteration(input: { id: HifoxID; carryOver?: 'backlog' | 'next' }): HifoxSnapshot {
  return mutate((draft) => {
    const iteration = draft.iterations.find((it) => it.id === input.id) ?? fail('版本不存在')
    if (input.carryOver !== undefined && !['backlog', 'next'].includes(input.carryOver)) fail('兼容参数无效')
    if (iteration.status === 'completed') return
    const sourceIds = [...new Set([...iteration.taskIds, ...draft.tasks.filter((task) => task.iterationIds.includes(iteration.id)).map((task) => task.id)])]
    const source = sourceIds.map((id) => taskOf(draft, id))
    if (source.some((task) => task.spaceId !== iteration.spaceId)) fail('版本包含其他空间的任务')
    if (source.some((task) => {
      const category = draft.taskStatuses.find((status) => status.id === task.statusId)?.category
      return task.triagePending || (task.workflow ? task.workflow.stage !== 'done' : category !== 'done' && category !== 'cancelled')
    })) fail('版本还有未完成任务，请明确处理或调整任务范围后再关闭；不会自动顺延')
    // Repair one-sided legacy indexes without moving or removing any scope.
    for (const task of source) if (!task.iterationIds.includes(iteration.id)) task.iterationIds.push(iteration.id)
    iteration.taskIds = sourceIds
    iteration.status = 'completed'
  }).snapshot
}

/** An append-only record of incorporation evidence; no merge or task mutation is performed. */
export function recordVersionDelivery(raw: HifoxRecordVersionDeliveryInput, actorId: string): HifoxSnapshot {
  const input = hifoxRecordVersionDeliveryInputSchema.parse(raw)
  return mutate((draft) => {
    const source = draft.iterations.find((item) => item.id === input.sourceIterationId) ?? fail('来源版本不存在')
    const target = draft.iterations.find((item) => item.id === input.targetIterationId) ?? fail('目标版本不存在')
    if (source.id === target.id) fail('来源版本与目标版本必须不同')
    if (source.spaceId !== target.spaceId) fail('交付记录的两个版本必须属于同一空间')
    const space = draft.spaces.find((item) => item.id === source.spaceId) ?? fail('空间不存在')
    if (space.archived) fail('空间已停用，请先恢复空间')
    if (!space.memberIds.includes(actorId) || !draft.members.some((member) => member.id === actorId)) fail('记录交付的成员不在该空间内')
    draft.versionDeliveries ??= []
    draft.versionDeliveries.push({ ...input, id: nextId('vd'), spaceId: space.id, actorId, at: nowIso() })
  }).snapshot
}

/* ---------------- 里程碑 ---------------- */

export interface HifoxMilestoneIssue {
  kind: 'task' | 'iteration' | 'evidence' | 'predecessor' | 'owner' | 'criteria'
  id: string
  label: string
  taskId?: string
}

export function canManageMilestone(snapshot: HifoxSnapshot, spaceId: string, actorId: string | undefined, milestone?: HifoxMilestone): boolean {
  const space = snapshot.spaces.find((item) => item.id === spaceId)
  const actor = snapshot.members.find((item) => item.id === actorId)
  return Boolean(space && !space.archived && actor && space.memberIds.includes(actor.id) &&
    (actor.role === 'owner' || actor.role === 'admin' || space.ownerId === actor.id || milestone?.ownerId === actor.id))
}

/** Evaluate exit facts without changing any task, version or evidence. Cancelled work never counts as done. */
export function getMilestoneIssues(snapshot: HifoxSnapshot, milestone: HifoxMilestone): HifoxMilestoneIssue[] {
  const issues: HifoxMilestoneIssue[] = []
  const space = snapshot.spaces.find((item) => item.id === milestone.spaceId)
  if (!space?.memberIds.includes(milestone.ownerId) || !snapshot.members.some((item) => item.id === milestone.ownerId)) {
    issues.push({ kind: 'owner', id: milestone.ownerId, label: '负责人已不在空间' })
  }
  if (!milestone.requiredTaskIds.length && !milestone.requiredIterationIds.length && !milestone.requiredEvidence.length) {
    issues.push({ kind: 'criteria', id: milestone.id, label: '尚未配置任务、版本或成果证据准出条件' })
  }
  const tasks = new Map(snapshot.tasks.filter((item) => item.spaceId === milestone.spaceId).map((item) => [item.id, item]))
  const done = (task: HifoxTask): boolean => !task.triagePending &&
    snapshot.taskStatuses.some((status) => status.id === task.statusId && status.spaceId === milestone.spaceId && status.category === 'done') &&
    (!task.workflow || task.workflow.stage === 'done')
  for (const id of milestone.requiredTaskIds) {
    const task = tasks.get(id)
    if (!task || !done(task)) issues.push({ kind: 'task', id, taskId: task?.id, label: task ? `${id} 尚未完成` : '必需任务不可用' })
  }
  for (const id of milestone.requiredIterationIds) {
    const version = snapshot.iterations.find((item) => item.id === id && item.spaceId === milestone.spaceId)
    if (!version) { issues.push({ kind: 'iteration', id, label: '必需版本不可用' }); continue }
    if (version.status !== 'completed') issues.push({ kind: 'iteration', id, label: `${version.name} 尚未关闭` })
    const ids = new Set([...version.taskIds, ...[...tasks.values()].filter((task) => task.iterationIds.includes(id)).map((task) => task.id)])
    for (const taskId of ids) {
      const task = tasks.get(taskId)
      if (!task || !done(task)) issues.push({ kind: 'task', id: taskId, taskId: task?.id, label: task ? `${version.name} · ${taskId} 未完成（取消不算完成）` : `${version.name} 的任务不可用` })
    }
  }
  for (const reference of milestone.requiredEvidence) {
    const task = tasks.get(reference.taskId)
    if (!task?.workflow?.artifacts.some((artifact) => artifact.id === reference.artifactId && artifact.body.trim())) {
      issues.push({ kind: 'evidence', id: reference.artifactId, taskId: task?.id, label: '必需成果证据不可用' })
    }
  }
  for (const id of milestone.predecessorIds) {
    const predecessor = snapshot.milestones?.find((item) => item.id === id && item.spaceId === milestone.spaceId)
    if (!predecessor || predecessor.status !== 'completed') issues.push({ kind: 'predecessor', id, label: predecessor ? `前置里程碑「${predecessor.name}」尚未达成` : '前置里程碑不可用' })
  }
  return issues
}

function milestoneAuthority(draft: HifoxSnapshot, spaceId: string, actorId: string, milestone?: HifoxMilestone): void {
  if (!canManageMilestone(draft, spaceId, actorId, milestone)) fail('只有本空间管理员或里程碑负责人可以执行此操作')
}

function milestoneCas(milestone: HifoxMilestone, expectedUpdatedAt?: string): void {
  if (!expectedUpdatedAt || expectedUpdatedAt !== milestone.updatedAt) fail('里程碑已更新，请重新打开后操作')
}

function validateMilestonePredecessors(draft: HifoxSnapshot, milestone: HifoxMilestone): void {
  const visiting = new Set<string>([milestone.id])
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) fail('里程碑依赖不能形成循环')
    if (visited.has(id)) return
    const predecessor = draft.milestones?.find((item) => item.id === id && item.spaceId === milestone.spaceId) ?? fail('前置里程碑必须属于同一空间')
    visiting.add(id)
    for (const dependency of predecessor.predecessorIds) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of milestone.predecessorIds) visit(id)
}

export function saveMilestone(raw: HifoxSaveMilestoneInput, actorId: string): HifoxSnapshot {
  const input = hifoxSaveMilestoneInputSchema.parse(raw)
  return mutate((draft) => {
    const previous = input.id ? draft.milestones?.find((item) => item.id === input.id) ?? fail('里程碑不存在') : undefined
    if (previous && previous.spaceId !== input.spaceId) fail('里程碑不能跨空间移动')
    milestoneAuthority(draft, input.spaceId, actorId, previous)
    if (previous) {
      milestoneCas(previous, input.expectedUpdatedAt)
      if (previous.status === 'completed') fail('已达成里程碑保留准出记录，不能修改')
      if (input.ownerId !== previous.ownerId && !canManageMilestone(draft, input.spaceId, actorId)) fail('变更里程碑负责人需要本空间管理员')
    } else if (input.expectedUpdatedAt !== undefined) fail('新里程碑不能带入旧修订')
    validateDate(input.targetDate)
    const space = draft.spaces.find((item) => item.id === input.spaceId) ?? fail('空间不存在')
    if (!space.memberIds.includes(input.ownerId) || !draft.members.some((item) => item.id === input.ownerId)) fail('里程碑负责人必须属于同一空间')
    for (const id of input.requiredTaskIds) if (taskOf(draft, id).spaceId !== space.id) fail('里程碑任务必须属于同一空间')
    for (const id of input.requiredIterationIds) if (!draft.iterations.some((item) => item.id === id && item.spaceId === space.id)) fail('里程碑版本必须属于同一空间')
    for (const reference of input.requiredEvidence) {
      const task = taskOf(draft, reference.taskId)
      if (task.spaceId !== space.id || !task.workflow?.artifacts.some((artifact) => artifact.id === reference.artifactId && artifact.body.trim())) fail('里程碑证据必须是同一空间任务的实际成果')
    }
    const at = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString()
    const milestone: HifoxMilestone = {
      id: previous?.id ?? nextId('ms'), spaceId: space.id, name: input.name, goal: input.goal,
      targetDate: input.targetDate, ownerId: input.ownerId, status: input.status ?? previous?.status ?? 'planned',
      requiredTaskIds: [...new Set(input.requiredTaskIds)], requiredIterationIds: [...new Set(input.requiredIterationIds)],
      requiredEvidence: input.requiredEvidence.filter((ref, index, refs) => refs.findIndex((other) => other.taskId === ref.taskId && other.artifactId === ref.artifactId) === index),
      predecessorIds: [...new Set(input.predecessorIds)], createdAt: previous?.createdAt ?? at, updatedAt: at
    }
    validateMilestonePredecessors(draft, milestone)
    draft.milestones ??= []
    if (previous) Object.assign(previous, milestone)
    else draft.milestones.push(milestone)
  }).snapshot
}

export function completeMilestone(raw: HifoxMilestoneCommandInput, actorId: string): HifoxSnapshot {
  const input = hifoxMilestoneCommandInputSchema.parse(raw)
  return mutate((draft) => {
    const milestone = draft.milestones?.find((item) => item.id === input.id) ?? fail('里程碑不存在')
    milestoneAuthority(draft, milestone.spaceId, actorId, milestone)
    milestoneCas(milestone, input.expectedUpdatedAt)
    if (milestone.status !== 'planned') fail('只能确认计划中的里程碑')
    validateDate(milestone.targetDate)
    validateMilestonePredecessors(draft, milestone)
    const issues = getMilestoneIssues(draft, milestone)
    if (issues.length) fail(`里程碑准出条件未满足：${issues.slice(0, 5).map((issue) => issue.label).join('；')}`)
    milestone.status = 'completed'
    milestone.completedAt = new Date(Math.max(Date.now(), Date.parse(milestone.updatedAt) + 1)).toISOString()
    milestone.completedBy = actorId
    milestone.updatedAt = milestone.completedAt
  }).snapshot
}

export function removeMilestone(raw: HifoxMilestoneCommandInput, actorId: string): HifoxSnapshot {
  const input = hifoxMilestoneCommandInputSchema.parse(raw)
  return mutate((draft) => {
    const milestone = draft.milestones?.find((item) => item.id === input.id) ?? fail('里程碑不存在')
    milestoneAuthority(draft, milestone.spaceId, actorId, milestone)
    milestoneCas(milestone, input.expectedUpdatedAt)
    if (milestone.status === 'completed') fail('已达成里程碑保留准出记录，不能删除')
    if (draft.milestones?.some((item) => item.predecessorIds.includes(milestone.id))) fail('请先解除其他里程碑的前置依赖')
    draft.milestones = draft.milestones?.filter((item) => item.id !== milestone.id)
  }).snapshot
}

/* ---------------- 视图（PRD 3.5） ---------------- */

export function saveView(input: { id?: HifoxID; spaceId: HifoxID; name: string; filter: HifoxViewFilter; groupBy: HifoxView['groupBy'] }): HifoxSnapshot {
  return mutate((draft) => {
    const space = draft.spaces.find((s) => s.id === input.spaceId) ?? fail('空间不存在')
    if (!input.name.trim()) fail('视图名称不能为空')
    if (!['status', 'assignee', 'type', 'priority'].includes(input.groupBy)) fail('视图分组无效')
    const filter = input.filter
    for (const id of filter.statusIds ?? []) if (!draft.taskStatuses.some((s) => s.id === id && s.spaceId === space.id)) fail('视图状态不属于该空间')
    for (const id of filter.typeIds ?? []) if (!draft.taskTypes.some((t) => t.id === id && t.spaceId === space.id)) fail('视图类型不属于该空间')
    for (const id of filter.labelIds ?? []) if (!draft.taskLabels.some((l) => l.id === id && (!l.spaceId || l.spaceId === space.id))) fail('视图标签不属于该空间')
    for (const id of filter.assigneeIds ?? []) if (!space.memberIds.includes(id) || !draft.members.some((m) => m.id === id)) fail('视图处理人不在该空间内')
    for (const priority of filter.priorities ?? []) if (!['urgent', 'high', 'medium', 'low', 'none'].includes(priority)) fail('视图优先级无效')
    if (filter.projectId && !draft.projects.some((p) => p.id === filter.projectId && p.spaceId === space.id)) fail('视图专项不属于该空间')
    if (filter.iterationId && !draft.iterations.some((it) => it.id === filter.iterationId && it.spaceId === space.id)) fail('视图版本不属于该空间')
    const existing = input.id ? draft.views.find((view) => view.id === input.id) ?? fail('视图不存在') : undefined
    if (existing && existing.spaceId !== input.spaceId) fail('视图不属于该空间')
    const view: HifoxView = {
      id: existing?.id ?? nextId('vw'),
      spaceId: input.spaceId,
      name: input.name.trim(),
      filter: input.filter,
      groupBy: input.groupBy
    }
    if (existing) Object.assign(existing, view)
    else draft.views.push(view)
    return view.id
  }).snapshot
}

export function removeView(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    if (!draft.views.some((v) => v.id === input.id)) fail('视图不存在')
    draft.views = draft.views.filter((v) => v.id !== input.id)
    return undefined
  }).snapshot
}

/* ---------------- 分拣台（PRD 3.7） ---------------- */

/** 待分拣是显式审核队列，独立于 Backlog 和处理人。 */
export function triageQueue(draft: HifoxSnapshot, spaceId: HifoxID): Array<{ task: HifoxTask; suggested: 'urgent' | 'high' | 'medium' | 'low'; reason: string }> {
  if (!draft.spaces.some((s) => s.id === spaceId)) fail('空间不存在')
  return draft.tasks
    .filter((t) => t.spaceId === spaceId
      && t.triagePending === true)
    .map((task) => {
      const isBug = draft.taskTypes.find((t) => t.id === task.typeId)?.name === 'Bug'
      const blockedOthers = task.relations.some((r) => r.kind === 'blocks')
      const suggested: 'urgent' | 'high' | 'medium' | 'low' = isBug && blockedOthers ? 'urgent' : isBug ? 'high' : blockedOthers ? 'high' : 'medium'
      const reason = [isBug ? '缺陷类任务' : null, blockedOthers ? '阻塞了其他任务' : null].filter(Boolean).join('，') || '常规任务'
      return { task, suggested, reason: `建议优先级 ${suggested.toUpperCase()}（${reason}）` }
    })
}

export function triage(input: Omit<HifoxTriageDecision, 'at'> & { assigneeIds?: HifoxID[]; iterationId?: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const task = taskOf(draft, input.taskId)
    const space = draft.spaces.find((s) => s.id === task.spaceId)
    if (!space) fail('空间不存在')
    if (!task.triagePending) fail('任务不在待分拣队列')
    if (task.workflow) fail('交接任务请使用接受、补充或拒绝操作完成分拣')
    if (input.actorId && !space.memberIds.includes(input.actorId)) fail('分拣成员不在该空间内')
    if (!['assign', 'iterate', 'park', 'close'].includes(input.disposition)) fail('分拣处置方式无效')

    if (input.disposition === 'assign') {
      const assigneeIds = [...new Set(input.assigneeIds ?? [])]
      if (assigneeIds.length === 0) fail('处置为指派时需选择处理人')
      for (const id of assigneeIds) {
        if (!space.memberIds.includes(id)) fail('处理人不在该空间内')
      }
      if (!space.multiAssignee && assigneeIds.length > 1 && task.assigneeIds.length <= 1) fail('该空间未开启多人处理人')
      task.assigneeIds = assigneeIds
      task.statusId = taskStatusForCategory(draft, task, 'todo')
      pushActivity(draft, task.id, 'triage', `分拣：指派给 ${assigneeIds.map((id) => draft.members.find((m) => m.id === id)?.name ?? id).join('、')}`)
    } else if (input.disposition === 'iterate') {
      if (!input.iterationId) fail('处置为放入版本时需选择版本')
      const iteration = draft.iterations.find((it) => it.id === input.iterationId && it.spaceId === space.id) ?? fail('版本不属于该空间')
      task.statusId = taskStatusForCategory(draft, task, 'todo')
      task.triagePending = undefined
      setTaskIterations(draft, task, [...task.iterationIds, iteration.id])
      pushActivity(draft, task.id, 'triage', `分拣：放入版本「${iteration.name}」`)
    } else if (input.disposition === 'park') {
      task.statusId = taskStatusForCategory(draft, task, 'backlog')
      pushActivity(draft, task.id, 'triage', `分拣：保留在 Backlog 待定${input.note ? `（${input.note}）` : ''}`)
    } else if (input.disposition === 'close') {
      task.statusId = taskStatusForCategory(draft, task, 'cancelled')
      pushActivity(draft, task.id, 'triage', `分拣：关闭不再处理${input.note ? `（${input.note}）` : ''}`)
    }

    task.triagePending = undefined
    task.completedAt = undefined
    refreshTaskDispatch(draft, task, '分拣处置')
    task.updatedAt = nowIso()
    draft.triageDecisions.unshift({ taskId: task.id, disposition: input.disposition, at: nowIso(), actorId: input.actorId, note: input.note })
    return undefined
  }).snapshot
}

/* ---------------- 自动化（PRD 3.8；Agent 动作到「等待 Runtime」为止） ---------------- */

function normalizeTarget(draft: HifoxSnapshot, input: HifoxAutomationInput, spaceId: HifoxID): HifoxAutomation['target'] {
  const target = input.target
  if (target.kind === 'agent') {
    const agent = draft.agents.find((a) => a.id === target.id && a.spaceId === spaceId)
    if (!agent) fail('目标 Agent 不在该空间内')
    if (!executionTargetAvailable(draft, spaceId, target)) fail('目标 Agent 已停用、归档或被小队专属占用')
    return { kind: 'agent', id: agent.id, name: agent.name }
  }
  if (target.kind === 'crew') {
    const crew = draft.crews.find((c) => c.id === target.id && c.spaceId === spaceId)
    if (!crew) fail('目标小队不在该空间内')
    if (!crewCaptainAvailable(draft, crew.id)) fail('小队已归档或队长不可用')
    return { kind: 'crew', id: crew.id, name: crew.name }
  }
  if (target.kind === 'member') {
    const member = draft.members.find((m) => m.id === target.id)
    if (!member || !draft.spaces.find((s) => s.id === spaceId)?.memberIds.includes(member.id)) fail('目标成员不在该空间内')
    return { kind: 'member', id: member.id, name: member.name }
  }
  if (target.kind !== 'none') fail('自动化目标类型无效')
  return { kind: 'none' }
}

function validateTrigger(draft: HifoxSnapshot, input: HifoxAutomationInput): void {
  const trigger = input.trigger
  if (trigger.kind === 'schedule') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.value ?? '')) fail('定时时间应为 HH:mm')
    if (trigger.days?.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) fail('定时星期应为 1~7')
  } else if (trigger.kind === 'task_status') {
    if (!draft.taskStatuses.some((s) => s.id === trigger.value && s.spaceId === input.spaceId)) fail('触发状态不属于该空间')
  } else if (trigger.kind === 'comment') {
    if (!trigger.value?.trim()) fail('评论关键词不能为空')
  } else if (trigger.kind !== 'task_created') fail('触发器类型无效')
  if (input.projectId && !draft.projects.some((p) => p.id === input.projectId && p.spaceId === input.spaceId && p.status !== 'archived')) fail('专项不属于该空间或已归档')
}

export function saveAutomation(input: HifoxAutomationInput & { id?: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    if (!draft.spaces.some((s) => s.id === input.spaceId)) fail('空间不存在')
    if (!input.name.trim()) fail('自动化名称不能为空')
    validateTrigger(draft, input)
    const target = normalizeTarget(draft, input, input.spaceId)
    const trigger = structuredClone(input.trigger)
    if (trigger.days) trigger.days = [...new Set(trigger.days)]
    if (trigger.value) trigger.value = trigger.value.trim()
    if (input.id) {
      const automation = draft.automations.find((a) => a.id === input.id) ?? fail('自动化不存在')
      if (automation.spaceId !== input.spaceId) fail('自动化不能跨空间移动')
      automation.name = input.name.trim()
      automation.trigger = trigger
      automation.target = target
      automation.instruction = input.instruction?.trim() || undefined
      automation.projectId = input.projectId || undefined
      if (input.enabled !== undefined) automation.enabled = input.enabled
      return automation.id
    }
    const automation: HifoxAutomation = {
      id: nextId('au'), spaceId: input.spaceId, name: input.name.trim(), enabled: input.enabled ?? true,
      trigger, target, instruction: input.instruction?.trim() || undefined,
      projectId: input.projectId || undefined, runs: []
    }
    draft.automations.push(automation)
    return automation.id
  }).snapshot
}

export function toggleAutomation(input: { id: HifoxID; enabled: boolean }): HifoxSnapshot {
  return mutate((draft) => {
    const automation = draft.automations.find((a) => a.id === input.id) ?? fail('自动化不存在')
    automation.enabled = input.enabled
    return undefined
  }).snapshot
}

export function removeAutomation(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    if (!draft.automations.some((a) => a.id === input.id)) fail('自动化不存在')
    draft.automations = draft.automations.filter((a) => a.id !== input.id)
    return undefined
  }).snapshot
}

function recordRun(draft: HifoxSnapshot, automation: HifoxAutomation, trigger: string, at: string = nowIso(), taskId?: HifoxID): void {
  let outcome: HifoxAutomationRun['outcome'] = 'skipped'
  let detail = '未配置执行目标，本次未执行'
  if (!automation.enabled) detail = '自动化已暂停，本次未执行'
  else if (automation.projectId && !draft.projects.some((p) => p.id === automation.projectId && p.spaceId === automation.spaceId && p.status !== 'archived')) detail = '专项上下文不可用，本次未执行'
  else if (automation.target.kind === 'agent' || automation.target.kind === 'crew') {
    if (executionTargetAvailable(draft, automation.spaceId, automation.target)) {
      outcome = 'waiting_runtime'
      detail = `目标为 ${automation.target.name ?? automation.target.id}，已登记等待 Runtime 接入；尚未执行指令`
    } else if (automation.target.kind === 'crew' && automation.target.id && crewCaptainAvailable(draft, automation.target.id)) {
      const crew = draft.crews.find((item) => item.id === automation.target.id)
      const members = crew?.members.filter((member) => member.kind === 'member' && draft.spaces.find((space) => space.id === automation.spaceId)?.memberIds.includes(member.id)) ?? []
      if (members.length && !crew?.members.some((member) => member.kind === 'agent')) {
        outcome = 'done'
        detail = '已为人员小队登记收件箱提醒，任务仍由人员处理'
      } else detail = '小队没有可用的 Agent，本次未执行'
    } else detail = '执行目标已移除、停用、归档、被专属占用或不在该空间，本次未执行'
  } else if (automation.target.kind === 'member') {
    const member = draft.members.find((m) => m.id === automation.target.id)
    if (member && draft.spaces.find((s) => s.id === automation.spaceId)?.memberIds.includes(member.id)) {
      outcome = 'done'
      detail = `已在本地收件箱登记 ${member.name} 的提醒`
    } else detail = '提醒成员不在该空间，本次未执行'
  }
  const run: HifoxAutomationRun = { id: nextId('run'), at, trigger, outcome, detail }
  automation.runs.unshift(run)
  automation.lastRunAt = at
  if (automation.runs.length > 20) automation.runs.length = 20
  // Waiting for runtime is not a completed run and sends no completion notification.
  if (outcome !== 'waiting_runtime') draft.inbox.unshift({
    id: nextId('in'), section: outcome === 'skipped' ? 'important' : 'other', kind: 'automation',
    title: `自动化「${automation.name}」${outcome === 'skipped' ? '已跳过' : '提醒'}`,
    body: outcome === 'done' ? automation.instruction || detail : detail,
    taskId, spaceId: automation.spaceId, at, read: false,
    recipientIds: automation.target.kind === 'member' && automation.target.id ? [automation.target.id] : automation.target.kind === 'crew' ? draft.crews.find((crew) => crew.id === automation.target.id)?.members.filter((member) => member.kind === 'member').map((member) => member.id) ?? [] : draft.spaces.find((space) => space.id === automation.spaceId)?.memberIds ?? []
  })
}

/** Manual runs obey pause/target checks and retain an honest local receipt. */
export function runAutomation(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const automation = draft.automations.find((a) => a.id === input.id) ?? fail('自动化不存在')
    recordRun(draft, automation, '手动触发')
    return undefined
  }).snapshot
}

function matchesTaskScope(automation: HifoxAutomation, task: HifoxTask): boolean {
  return automation.enabled && automation.spaceId === task.spaceId && (!automation.projectId || automation.projectId === task.projectId)
}

export function evaluateAutomationsForStatus(draft: HifoxSnapshot, task: HifoxTask, statusName: string): void {
  for (const automation of draft.automations) {
    if (!matchesTaskScope(automation, task) || automation.trigger.kind !== 'task_status') continue
    if (automation.trigger.value !== task.statusId) continue
    recordRun(draft, automation, `${task.id} → ${statusName}`, nowIso(), task.id)
  }
}

export function evaluateAutomationsForTaskCreated(draft: HifoxSnapshot, task: HifoxTask): void {
  for (const automation of draft.automations) {
    if (!matchesTaskScope(automation, task) || automation.trigger.kind !== 'task_created') continue
    recordRun(draft, automation, `${task.id} 创建`, nowIso(), task.id)
  }
}

export function evaluateAutomationsForComment(draft: HifoxSnapshot, task: HifoxTask, body: string): void {
  for (const automation of draft.automations) {
    if (!matchesTaskScope(automation, task) || automation.trigger.kind !== 'comment') continue
    const keyword = automation.trigger.value?.trim()
    if (keyword && body.includes(keyword)) recordRun(draft, automation, `${task.id} 评论命中「${keyword}」`, nowIso(), task.id)
  }
}

function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function scheduleDue(automation: HifoxAutomation, now: Date): boolean {
  if (!automation.enabled || automation.trigger.kind !== 'schedule') return false
  const value = automation.trigger.value ?? ''
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false
  const day = now.getDay() || 7
  if (automation.trigger.days?.length && !automation.trigger.days.includes(day)) return false
  if (automation.lastScheduledDate && automation.lastScheduledDate >= localDate(now)) return false
  const [hours, minutes] = value.split(':').map(Number)
  return now.getHours() * 60 + now.getMinutes() >= hours * 60 + minutes
}

/**
 * Local calendar scheduling, one receipt per rule per day, persisted across restarts.
 * A late tick catches up today's occurrence only; older dates are never replayed.
 * Paused rules do not tick. Runtime-bound work stays waiting_runtime.
 */
export function tickScheduledAutomations(now: Date = new Date()): HifoxSnapshot {
  if (!Number.isFinite(now.getTime())) fail('定时检查时间无效')
  const current = loadSnapshot()
  if (!current.automations.some((automation) => scheduleDue(automation, now))) return current
  return mutate((draft) => {
    for (const automation of draft.automations) {
      if (!scheduleDue(automation, now)) continue
      recordRun(draft, automation, `schedule ${localDate(now)} ${automation.trigger.value}`, now.toISOString())
      automation.lastScheduledDate = localDate(now)
    }
  }).snapshot
}
