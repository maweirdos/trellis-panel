/**
 * HiFox 计划域服务：专项、迭代、视图、分拣台、自动化。
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
  HifoxProject,
  HifoxSnapshot,
  HifoxTask,
  HifoxTriageDecision,
  HifoxView,
  HifoxViewFilter
} from '../../../shared/hifox'
import { mutate, nextId, nowIso } from './store'

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

function statusIdOfCategory(draft: HifoxSnapshot, spaceId: HifoxID, category: string): HifoxID | undefined {
  return draft.taskStatuses
    .filter((s) => s.spaceId === spaceId && s.category === category)
    .sort((a, b) => a.order - b.order)[0]?.id
}

/* ---------------- 专项（PRD 3.4） ---------------- */

export function createProject(input: { spaceId: HifoxID; name: string; goal?: string; ownerIds?: HifoxID[] }): HifoxSnapshot {
  return mutate((draft) => {
    if (!draft.spaces.some((s) => s.id === input.spaceId)) fail('空间不存在')
    if (!input.name.trim()) fail('专项名称不能为空')
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

export function updateProject(input: { id: HifoxID; name?: string; goal?: string; status?: HifoxProject['status'] }): HifoxSnapshot {
  return mutate((draft) => {
    const project = draft.projects.find((p) => p.id === input.id) ?? fail('专项不存在')
    if (input.name !== undefined && input.name.trim()) project.name = input.name.trim()
    if (input.goal !== undefined) project.goal = input.goal.trim() || undefined
    if (input.status !== undefined) project.status = input.status
    if (input.status === 'archived') {
      for (const task of draft.tasks) {
        if (task.projectId === input.id) task.projectId = undefined
      }
    }
    return undefined
  }).snapshot
}

/* ---------------- 迭代（PRD 3.6） ---------------- */

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function createIteration(input: { spaceId: HifoxID; name: string; goal?: string; startDate: string; endDate: string; taskIds?: HifoxID[] }): HifoxSnapshot {
  return mutate((draft) => {
    if (!draft.spaces.some((s) => s.id === input.spaceId)) fail('空间不存在')
    if (!input.name.trim()) fail('迭代名称不能为空')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) fail('日期格式应为 YYYY-MM-DD')
    if (input.endDate < input.startDate) fail('结束日期不能早于开始日期')
    const taskIds = [...new Set(input.taskIds ?? [])]
    for (const id of taskIds) taskOf(draft, id)
    const iteration: HifoxIteration = {
      id: nextId('it'),
      spaceId: input.spaceId,
      name: input.name.trim(),
      goal: input.goal?.trim() || undefined,
      startDate: input.startDate,
      endDate: input.endDate,
      status: 'pending',
      taskIds
    }
    draft.iterations.push(iteration)
    for (const task of draft.tasks) {
      if (taskIds.includes(task.id) && !task.iterationIds.includes(iteration.id)) task.iterationIds.push(iteration.id)
    }
    return iteration.id
  }).snapshot
}

export function updateIteration(input: { id: HifoxID; name?: string; goal?: string; status?: HifoxIteration['status']; taskIds?: HifoxID[] }): HifoxSnapshot {
  return mutate((draft) => {
    const iteration = draft.iterations.find((it) => it.id === input.id) ?? fail('迭代不存在')
    if (input.name !== undefined && input.name.trim()) iteration.name = input.name.trim()
    if (input.goal !== undefined) iteration.goal = input.goal.trim() || undefined
    if (input.status !== undefined) iteration.status = input.status
    if (input.taskIds !== undefined) {
      const next = [...new Set(input.taskIds)]
      for (const id of next) taskOf(draft, id)
      iteration.taskIds = next
      for (const task of draft.tasks) {
        const shouldContain = next.includes(task.id)
        const contains = task.iterationIds.includes(iteration.id)
        if (shouldContain && !contains) task.iterationIds.push(iteration.id)
        if (!shouldContain && contains) task.iterationIds = task.iterationIds.filter((id) => id !== iteration.id)
      }
    }
    return undefined
  }).snapshot
}

/** 结束迭代：未完成任务顺延（PRD 3.6：退回 Backlog 或移入下一迭代） */
export function completeIteration(input: { id: HifoxID; carryOver: 'backlog' | 'next' }): HifoxSnapshot {
  return mutate((draft) => {
    const iteration = draft.iterations.find((it) => it.id === input.id) ?? fail('迭代不存在')
    const doneCategories = new Set(['done', 'cancelled'])
    const unfinished = iteration.taskIds
      .map((id) => draft.tasks.find((t) => t.id === id))
      .filter((t): t is HifoxTask => Boolean(t) && !doneCategories.has(draft.taskStatuses.find((s) => s.id === t!.statusId)?.category ?? ''))

    let nextIteration: HifoxIteration | undefined
    if (input.carryOver === 'next') {
      nextIteration = draft.iterations
        .filter((it) => it.spaceId === iteration.spaceId && it.status === 'pending' && it.id !== iteration.id)
        .sort((a, b) => a.startDate.localeCompare(b.startDate))[0]
      if (!nextIteration) {
        const span = Math.round((Date.parse(iteration.endDate) - Date.parse(iteration.startDate)) / 86400000) || 7
        nextIteration = {
          id: nextId('it'),
          spaceId: iteration.spaceId,
          name: `${iteration.name}（顺延）`,
          goal: '上一迭代未完成项顺延',
          startDate: shiftDays(iteration.endDate, 1),
          endDate: shiftDays(iteration.endDate, 1 + Math.max(span, 1)),
          status: 'pending',
          taskIds: []
        }
        draft.iterations.push(nextIteration)
      }
    }

    const backlogStatus = statusIdOfCategory(draft, iteration.spaceId, 'backlog')
    for (const task of unfinished) {
      if (input.carryOver === 'backlog' && backlogStatus) {
        task.statusId = backlogStatus
        task.completedAt = undefined
        pushActivity(draft, task.id, 'iteration', `迭代「${iteration.name}」结束，顺延回 Backlog`)
      }
      if (nextIteration) {
        task.iterationIds = task.iterationIds.filter((id) => id !== iteration.id)
        if (!task.iterationIds.includes(nextIteration.id)) task.iterationIds.push(nextIteration.id)
        if (!nextIteration.taskIds.includes(task.id)) nextIteration.taskIds.push(task.id)
        pushActivity(draft, task.id, 'iteration', `顺延进入「${nextIteration.name}」`)
      }
      task.updatedAt = nowIso()
    }
    iteration.taskIds = iteration.taskIds.filter((id) => !unfinished.some((t) => t.id === id))
    iteration.status = 'completed'
    return undefined
  }).snapshot
}

/* ---------------- 视图（PRD 3.5） ---------------- */

export function saveView(input: { spaceId: HifoxID; name: string; filter: HifoxViewFilter; groupBy: HifoxView['groupBy'] }): HifoxSnapshot {
  return mutate((draft) => {
    if (!draft.spaces.some((s) => s.id === input.spaceId)) fail('空间不存在')
    if (!input.name.trim()) fail('视图名称不能为空')
    const view: HifoxView = {
      id: nextId('vw'),
      spaceId: input.spaceId,
      name: input.name.trim(),
      filter: input.filter,
      groupBy: input.groupBy
    }
    draft.views.push(view)
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

/** 计算待分拣队列：未分配的 Backlog 任务，附优先级建议 */
export function triageQueue(draft: HifoxSnapshot, spaceId: HifoxID): Array<{ task: HifoxTask; suggested: 'urgent' | 'high' | 'medium' | 'low'; reason: string }> {
  return draft.tasks
    .filter((t) => t.spaceId === spaceId
      && draft.taskStatuses.find((s) => s.id === t.statusId)?.category === 'backlog'
      && t.assigneeIds.length === 0
      && !t.executor)
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

    if (input.disposition === 'assign') {
      const assigneeIds = [...new Set(input.assigneeIds ?? [])]
      if (assigneeIds.length === 0) fail('处置为指派时需选择处理人')
      for (const id of assigneeIds) {
        if (!space.memberIds.includes(id)) fail('处理人不在该空间内')
      }
      if (!space.multiAssignee && assigneeIds.length > 1) fail('该空间未开启多人处理人')
      task.assigneeIds = assigneeIds
      const todo = statusIdOfCategory(draft, space.id, 'todo')
      if (todo) task.statusId = todo
      pushActivity(draft, task.id, 'triage', `分拣：指派给 ${assigneeIds.map((id) => draft.members.find((m) => m.id === id)?.name ?? id).join('、')}`)
    } else if (input.disposition === 'iterate') {
      if (!input.iterationId) fail('处置为放入迭代时需选择迭代')
      const iteration = draft.iterations.find((it) => it.id === input.iterationId) ?? fail('迭代不存在')
      if (!task.iterationIds.includes(iteration.id)) task.iterationIds.push(iteration.id)
      if (!iteration.taskIds.includes(task.id)) iteration.taskIds.push(task.id)
      const todo = statusIdOfCategory(draft, space.id, 'todo')
      if (todo && draft.taskStatuses.find((s) => s.id === task.statusId)?.category === 'backlog') task.statusId = todo
      pushActivity(draft, task.id, 'triage', `分拣：放入迭代「${iteration.name}」`)
    } else if (input.disposition === 'park') {
      pushActivity(draft, task.id, 'triage', `分拣：保留在 Backlog 待定${input.note ? `（${input.note}）` : ''}`)
    } else if (input.disposition === 'close') {
      const cancelled = statusIdOfCategory(draft, space.id, 'cancelled')
      if (cancelled) task.statusId = cancelled
      pushActivity(draft, task.id, 'triage', `分拣：关闭不再处理${input.note ? `（${input.note}）` : ''}`)
    }

    task.updatedAt = nowIso()
    draft.triageDecisions.unshift({ taskId: task.id, disposition: input.disposition, at: nowIso(), actorId: input.actorId, note: input.note })
    return undefined
  }).snapshot
}

/* ---------------- 自动化（PRD 3.8；Agent 动作到「等待 Runtime」为止） ---------------- */

function normalizeTarget(draft: HifoxSnapshot, input: HifoxAutomationInput, spaceId: HifoxID): HifoxAutomation['target'] {
  const target = input.target
  if (target.kind === 'agent') {
    const agent = draft.agents.find((a) => a.id === target.id)
    if (!agent || agent.spaceId !== spaceId) fail('目标 Agent 不在该空间内')
    return { kind: 'agent', id: agent.id, name: agent.name }
  }
  if (target.kind === 'crew') {
    const crew = draft.crews.find((c) => c.id === target.id)
    if (!crew || crew.spaceId !== spaceId) fail('目标小队不在该空间内')
    return { kind: 'crew', id: crew.id, name: crew.name }
  }
  if (target.kind === 'member') {
    const member = draft.members.find((m) => m.id === target.id)
    if (!member) fail('目标成员不存在')
    return { kind: 'member', id: member.id, name: member.name }
  }
  return { kind: 'none' }
}

export function saveAutomation(input: HifoxAutomationInput & { id?: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    if (!draft.spaces.some((s) => s.id === input.spaceId)) fail('空间不存在')
    if (!input.name.trim()) fail('自动化名称不能为空')
    const target = normalizeTarget(draft, input, input.spaceId)
    if (input.id) {
      const automation = draft.automations.find((a) => a.id === input.id) ?? fail('自动化不存在')
      automation.name = input.name.trim()
      automation.trigger = input.trigger
      automation.target = target
      automation.instruction = input.instruction?.trim() || undefined
      automation.projectId = input.projectId
      return automation.id
    }
    const automation: HifoxAutomation = {
      id: nextId('au'),
      spaceId: input.spaceId,
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      trigger: input.trigger,
      target,
      instruction: input.instruction?.trim() || undefined,
      projectId: input.projectId,
      runs: []
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

function recordRun(draft: HifoxSnapshot, automation: HifoxAutomation, trigger: string): void {
  const agentBound = automation.target.kind === 'agent' || automation.target.kind === 'crew'
  const run: HifoxAutomationRun = {
    id: nextId('run'),
    at: nowIso(),
    trigger,
    outcome: agentBound ? 'waiting_runtime' : 'done',
    detail: agentBound
      ? `目标为 ${automation.target.name}，已登记等待 Runtime 接入`
      : automation.target.kind === 'member'
        ? `已通知 ${automation.target.name} 并写入收件箱`
        : '规则触发（无执行目标）'
  }
  automation.runs.unshift(run)
  automation.lastRunAt = run.at
  if (automation.runs.length > 20) automation.runs.length = 20
  draft.inbox.unshift({
    id: nextId('in'),
    section: 'other',
    kind: 'automation',
    title: `自动化「${automation.name}」已运行`,
    body: run.detail,
    at: run.at,
    read: false
  })
  if (automation.target.kind === 'member' && automation.target.id) {
    draft.inbox.unshift({
      id: nextId('in'),
      section: 'other',
      kind: 'automation',
      title: `自动化「${automation.name}」提醒`,
      body: automation.instruction || trigger,
      at: run.at,
      read: false
    })
  }
}

/** 手动运行（验证规则链路；Agent 目标仅登记等待 Runtime） */
export function runAutomation(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const automation = draft.automations.find((a) => a.id === input.id) ?? fail('自动化不存在')
    recordRun(draft, automation, '手动触发')
    return undefined
  }).snapshot
}

/** 任务状态触发的自动执行（由 core.updateTask 调用） */
export function evaluateAutomationsForStatus(draft: HifoxSnapshot, task: HifoxTask, statusName: string): void {
  for (const automation of draft.automations) {
    if (!automation.enabled || automation.spaceId !== task.spaceId) continue
    if (automation.trigger.kind !== 'task_status') continue
    const triggerStatus = draft.taskStatuses.find((s) => s.id === automation.trigger.value)
    if (!triggerStatus || triggerStatus.name !== statusName) continue
    recordRun(draft, automation, `${task.id} → ${statusName}`)
  }
}

/** 评论关键词触发的自动执行（由 core.addComment 调用） */
export function evaluateAutomationsForComment(draft: HifoxSnapshot, task: HifoxTask, body: string): void {
  for (const automation of draft.automations) {
    if (!automation.enabled || automation.spaceId !== task.spaceId) continue
    if (automation.trigger.kind !== 'comment') continue
    const keyword = (automation.trigger.value ?? '').trim()
    if (!keyword || !body.includes(keyword)) continue
    recordRun(draft, automation, `${task.id} 评论命中「${keyword}」`)
  }
}
