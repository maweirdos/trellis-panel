/**
 * HiFox 核心服务：空间、成员、任务配置（类型/状态/标签）、任务、评论、活动、收件箱。
 * 业务规则来源：docs/prd-hifox 3.1~3.2、4.1~4.5、2.5~2.6、2.2（派发边界内）。
 */
import type {
  HifoxActivity,
  HifoxComment,
  HifoxID,
  HifoxInboxItem,
  HifoxInboxSection,
  HifoxMember,
  HifoxRole,
  HifoxSnapshot,
  HifoxSpace,
  HifoxStatusCategory,
  HifoxTask,
  HifoxTaskInput,
  HifoxTaskPatchInput,
  HifoxTaskRelation
} from '../../../shared/hifox'
import { mutate, nextId, nowIso } from './store'
import { evaluateAutomationsForComment, evaluateAutomationsForStatus, evaluateAutomationsForTaskCreated } from './planning'

export class HifoxError extends Error {}

function fail(message: string): never {
  throw new HifoxError(message)
}

function spaceOf(draft: HifoxSnapshot, id: HifoxID): HifoxSpace {
  return draft.spaces.find((s) => s.id === id) ?? fail('空间不存在')
}

function taskOf(draft: HifoxSnapshot, id: HifoxID): HifoxTask {
  return draft.tasks.find((t) => t.id === id) ?? fail('任务不存在')
}

export function statusCategoryOf(draft: HifoxSnapshot, statusId?: HifoxID): HifoxStatusCategory | undefined {
  if (!statusId) return undefined
  return draft.taskStatuses.find((s) => s.id === statusId)?.category
}

function pushActivity(draft: HifoxSnapshot, taskId: HifoxID, kind: string, text: string): void {
  const activity: HifoxActivity = { id: nextId('ac'), taskId, kind, text, at: nowIso() }
  draft.activities.unshift(activity)
}

function pushInbox(draft: HifoxSnapshot, item: Omit<HifoxInboxItem, 'id' | 'at' | 'read'> & { at?: string }): void {
  const inboxItem: HifoxInboxItem = { id: nextId('in'), read: false, at: item.at ?? nowIso(), ...item }
  draft.inbox.unshift(inboxItem)
}

function memberName(draft: HifoxSnapshot, id: HifoxID): string {
  return draft.members.find((m) => m.id === id)?.name ?? id
}

/* ---------------- 空间 ---------------- */

export function createSpace(input: { name: string; key: string; description?: string }): HifoxSnapshot {
  return mutate((draft) => {
    const key = input.key.trim().toUpperCase()
    if (!/^[A-Z]{2,6}$/.test(key)) fail('空间前缀需为 2~6 个英文字母')
    if (draft.spaces.some((s) => s.key === key)) fail(`空间前缀 ${key} 已存在`)
    if (draft.spaces.some((s) => s.name === input.name.trim())) fail('同名空间已存在')
    const space: HifoxSpace = {
      id: nextId('sp'),
      name: input.name.trim(),
      key,
      description: input.description?.trim() || undefined,
      multiAssignee: false,
      memberIds: [],
      taskSeq: 0,
      createdAt: nowIso()
    }
    draft.spaces.push(space)
    // 每个新空间自带默认类型与七类状态（PRD 3.2 / 4.4）
    const types: Array<[string, string[] | undefined, boolean?]> = [
      ['需求', ['背景与目标', '验收标准'], true],
      ['Bug', ['复现步骤', '影响范围']],
      ['任务', undefined],
      ['内容', undefined]
    ]
    for (const [name, hints, isDefault] of types) {
      draft.taskTypes.push({ id: nextId('tt'), spaceId: space.id, name, requiredHints: hints, isDefault })
    }
    const statuses: Array<[string, HifoxStatusCategory]> = [
      ['Backlog', 'backlog'], ['Todo', 'todo'], ['In Progress', 'in_progress'],
      ['In Review', 'in_review'], ['Done', 'done'], ['Blocked', 'blocked'], ['Cancelled', 'cancelled']
    ]
    statuses.forEach(([name, category], index) => {
      draft.taskStatuses.push({ id: nextId('st'), spaceId: space.id, name, category, order: index + 1 })
    })
    return space.id
  }).snapshot
}

export function updateSpace(input: { id: HifoxID; name?: string; description?: string; multiAssignee?: boolean }): HifoxSnapshot {
  return mutate((draft) => {
    const space = spaceOf(draft, input.id)
    if (input.name !== undefined && input.name.trim()) space.name = input.name.trim()
    if (input.description !== undefined) space.description = input.description.trim() || undefined
    if (input.multiAssignee !== undefined) {
      space.multiAssignee = input.multiAssignee
      if (!input.multiAssignee) {
        // 关闭多人处理人后，既有任务收敛为第一名处理人（PRD 3.2 联动规则）
        for (const task of draft.tasks) {
          if (task.spaceId === space.id && task.assigneeIds.length > 1) {
            task.assigneeIds = task.assigneeIds.slice(0, 1)
          }
        }
      }
    }
    return undefined
  }).snapshot
}

/* ---------------- 成员 ---------------- */

export function inviteMember(input: { name: string; email?: string; title?: string; role?: HifoxRole; spaceId?: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    if (!input.name.trim()) fail('成员姓名不能为空')
    if (draft.members.some((m) => m.name === input.name.trim())) fail('同名成员已存在')
    const member: HifoxMember = {
      id: nextId('m'),
      name: input.name.trim(),
      email: input.email?.trim() || undefined,
      title: input.title?.trim() || undefined,
      role: input.role ?? 'member',
      avatarHue: Math.floor(Math.random() * 360),
      joinedAt: nowIso()
    }
    draft.members.push(member)
    if (input.spaceId) {
      const space = spaceOf(draft, input.spaceId)
      if (!space.memberIds.includes(member.id)) space.memberIds.push(member.id)
    }
    return member.id
  }).snapshot
}

export function updateMember(input: { id: HifoxID; name?: string; title?: string; role?: HifoxRole }): HifoxSnapshot {
  return mutate((draft) => {
    const member = draft.members.find((m) => m.id === input.id) ?? fail('成员不存在')
    if (input.name !== undefined && input.name.trim()) member.name = input.name.trim()
    if (input.title !== undefined) member.title = input.title.trim() || undefined
    if (input.role !== undefined) {
      if (member.role === 'owner' && input.role !== 'owner' && draft.members.filter((m) => m.role === 'owner').length <= 1) {
        fail('组织至少保留一名 owner')
      }
      member.role = input.role
    }
    return undefined
  }).snapshot
}

export function removeMember(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const member = draft.members.find((m) => m.id === input.id) ?? fail('成员不存在')
    if (member.role === 'owner' && draft.members.filter((m) => m.role === 'owner').length <= 1) {
      fail('不能移除唯一 owner')
    }
    draft.members = draft.members.filter((m) => m.id !== input.id)
    for (const space of draft.spaces) space.memberIds = space.memberIds.filter((id) => id !== input.id)
    for (const task of draft.tasks) {
      task.assigneeIds = task.assigneeIds.filter((id) => id !== input.id)
      task.followerIds = task.followerIds.filter((id) => id !== input.id)
    }
    for (const project of draft.projects) project.ownerIds = project.ownerIds.filter((id) => id !== input.id)
    for (const crew of draft.crews) crew.members = crew.members.filter((ref) => !(ref.kind === 'member' && ref.id === input.id))
    return undefined
  }).snapshot
}

export function setSpaceMembers(input: { spaceId: HifoxID; memberIds: HifoxID[] }): HifoxSnapshot {
  return mutate((draft) => {
    const space = spaceOf(draft, input.spaceId)
    for (const id of input.memberIds) {
      if (!draft.members.some((m) => m.id === id)) fail(`成员 ${id} 不存在`)
    }
    space.memberIds = [...new Set(input.memberIds)]
    return undefined
  }).snapshot
}

/* ---------------- 任务配置：类型 / 状态 / 标签 ---------------- */

export function createTaskType(input: { spaceId: HifoxID; name: string; requiredHints?: string[]; statusIds?: HifoxID[] }): HifoxSnapshot {
  return mutate((draft) => {
    spaceOf(draft, input.spaceId)
    if (!input.name.trim()) fail('类型名称不能为空')
    if (draft.taskTypes.some((t) => t.spaceId === input.spaceId && t.name === input.name.trim())) fail('同名类型已存在')
    if (input.statusIds) {
      for (const id of input.statusIds) {
        if (!draft.taskStatuses.some((s) => s.id === id && s.spaceId === input.spaceId)) fail('类型可用状态必须属于该空间')
      }
    }
    draft.taskTypes.push({ id: nextId('tt'), spaceId: input.spaceId, name: input.name.trim(), requiredHints: input.requiredHints, statusIds: input.statusIds })
    return undefined
  }).snapshot
}

export function updateTaskType(input: { id: HifoxID; name?: string; statusIds?: HifoxID[] }): HifoxSnapshot {
  return mutate((draft) => {
    const type = draft.taskTypes.find((t) => t.id === input.id) ?? fail('类型不存在')
    if (input.name !== undefined && input.name.trim()) type.name = input.name.trim()
    if (input.statusIds !== undefined) {
      for (const id of input.statusIds) {
        if (!draft.taskStatuses.some((s) => s.id === id && s.spaceId === type.spaceId)) fail('类型可用状态必须属于该空间')
      }
      type.statusIds = input.statusIds
      // 收窄后，已有任务若停在不再可用的状态，回退到该类型首个可用状态（或空间 Backlog）
      for (const task of draft.tasks) {
        if (task.typeId === type.id && !type.statusIds.includes(task.statusId)) {
          const fallback = type.statusIds[0]
            ?? statusIdOfCategoryLocal(draft, type.spaceId, 'backlog')
          if (fallback) {
            task.statusId = fallback
            pushActivity(draft, task.id, 'status', `类型状态集调整，状态迁移为 ${draft.taskStatuses.find((s) => s.id === fallback)?.name}`)
          }
        }
      }
    }
    return undefined
  }).snapshot
}

/** 类型可用状态（两层模型，PRD 4.4）：未配置时为空间全部状态 */
export function allowedStatusIds(draft: HifoxSnapshot, spaceId: HifoxID, typeId?: HifoxID): Set<HifoxID> {
  const type = typeId ? draft.taskTypes.find((t) => t.id === typeId) : undefined
  if (type?.statusIds?.length) return new Set(type.statusIds)
  return new Set(draft.taskStatuses.filter((s) => s.spaceId === spaceId).map((s) => s.id))
}

function statusIdOfCategoryLocal(draft: HifoxSnapshot, spaceId: HifoxID, category: HifoxStatusCategory): HifoxID | undefined {
  return draft.taskStatuses
    .filter((s) => s.spaceId === spaceId && s.category === category)
    .sort((a, b) => a.order - b.order)[0]?.id
}

export function removeTaskType(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const type = draft.taskTypes.find((t) => t.id === input.id) ?? fail('类型不存在')
    if (type.isDefault) fail('默认类型不可删除')
    const fallback = draft.taskTypes.find((t) => t.spaceId === type.spaceId && t.isDefault) ?? fail('缺少默认类型可承接')
    for (const task of draft.tasks) {
      if (task.typeId === input.id) task.typeId = fallback.id
    }
    draft.taskTypes = draft.taskTypes.filter((t) => t.id !== input.id)
    return undefined
  }).snapshot
}

export function createTaskStatus(input: { spaceId: HifoxID; name: string; category: HifoxStatusCategory }): HifoxSnapshot {
  return mutate((draft) => {
    spaceOf(draft, input.spaceId)
    if (!input.name.trim()) fail('状态名称不能为空')
    if (draft.taskStatuses.some((s) => s.spaceId === input.spaceId && s.name === input.name.trim())) fail('同名状态已存在')
    const order = Math.max(0, ...draft.taskStatuses.filter((s) => s.spaceId === input.spaceId).map((s) => s.order)) + 1
    draft.taskStatuses.push({ id: nextId('st'), spaceId: input.spaceId, name: input.name.trim(), category: input.category, order })
    return undefined
  }).snapshot
}

export function removeTaskStatus(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const status = draft.taskStatuses.find((s) => s.id === input.id) ?? fail('状态不存在')
    const inUse = draft.tasks.some((t) => t.statusId === input.id)
    if (inUse) fail('仍有任务处于该状态，先迁移任务后再删除')
    const sameCategory = draft.taskStatuses.find((s) => s.spaceId === status.spaceId && s.category === status.category && s.id !== input.id)
    if (!sameCategory) fail('每个状态类别至少保留一个状态')
    draft.taskStatuses = draft.taskStatuses.filter((s) => s.id !== input.id)
    return undefined
  }).snapshot
}

export function createLabel(input: { spaceId?: HifoxID; name: string; color?: string }): HifoxSnapshot {
  return mutate((draft) => {
    if (input.spaceId) spaceOf(draft, input.spaceId)
    if (!input.name.trim()) fail('标签名称不能为空')
    if (draft.taskLabels.some((l) => l.spaceId === input.spaceId && l.name === input.name.trim() && !l.archived)) fail('同名标签已存在')
    draft.taskLabels.push({
      id: nextId('lb'),
      // spaceId 为空 = 组织标签，所有空间可用（PRD 4.3 规则4）
      spaceId: input.spaceId,
      name: input.name.trim(),
      color: input.color || ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'][draft.taskLabels.length % 6]
    })
    return undefined
  }).snapshot
}

export function archiveLabel(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const label = draft.taskLabels.find((l) => l.id === input.id) ?? fail('标签不存在')
    label.archived = true
    for (const task of draft.tasks) task.labelIds = task.labelIds.filter((id) => id !== input.id)
    return undefined
  }).snapshot
}

/* ---------------- 任务 ---------------- */

function validateAssignees(draft: HifoxSnapshot, space: HifoxSpace, assigneeIds: HifoxID[]): HifoxID[] {
  const unique = [...new Set(assigneeIds)]
  for (const id of unique) {
    if (!space.memberIds.includes(id)) fail(`处理人 ${memberName(draft, id)} 不在该空间内`)
  }
  if (!space.multiAssignee && unique.length > 1) fail('该空间未开启多人处理人，仅可设置一名处理人')
  return unique
}

function validateExecutor(draft: HifoxSnapshot, spaceId: HifoxID, executor: HifoxTask['executor']): void {
  if (!executor) return
  if (executor.kind === 'agent') {
    const agent = draft.agents.find((a) => a.id === executor.id)
    if (!agent || agent.spaceId !== spaceId) fail('执行 Agent 不在该空间内')
    if (!agent.enabled) fail('执行 Agent 已停用，先启用后再指派')
    executor.name = agent.name
  } else {
    const crew = draft.crews.find((c) => c.id === executor.id)
    if (!crew || crew.spaceId !== spaceId) fail('执行小队不在该空间内')
    executor.name = crew.name
  }
}

function defaultStatusId(draft: HifoxSnapshot, spaceId: HifoxID, category: HifoxStatusCategory = 'backlog'): HifoxID {
  return draft.taskStatuses
    .filter((s) => s.spaceId === spaceId && s.category === category)
    .sort((a, b) => a.order - b.order)[0]?.id ?? fail('空间缺少 Backlog 状态')
}

/** 派发状态机（PRD 2.2 边界内）：Backlog → queued；可执行状态 → waiting_runtime */
function refreshDispatch(draft: HifoxSnapshot, task: HifoxTask, reason: string): void {
  if (!task.executor) {
    if (task.dispatch) task.dispatch = undefined
    return
  }
  const category = statusCategoryOf(draft, task.statusId)
  const next = category === 'backlog' ? 'queued' : 'waiting_runtime'
  const note = next === 'queued'
    ? `已指派给 ${task.executor.name}，Backlog 中不启动，进入 Todo 后开始执行`
    : `已指派给 ${task.executor.name}，等待 Runtime 接入后执行`
  if (!task.dispatch || task.dispatch.status !== next) {
    const wasNone = !task.dispatch
    task.dispatch = { status: next, since: nowIso(), note }
    pushActivity(draft, task.id, 'dispatch', `${reason}：${note}`)
    if (!wasNone || next === 'waiting_runtime') {
      pushInbox(draft, { section: 'other', kind: 'dispatch', title: `${task.id} ${next === 'queued' ? '已排队' : '等待 Runtime'}`, body: note, taskId: task.id })
    }
  } else {
    task.dispatch.note = note
  }
}

export function createTask(input: HifoxTaskInput): { snapshot: HifoxSnapshot; taskId: HifoxID } {
  const { snapshot, result } = mutate((draft) => {
    const space = spaceOf(draft, input.spaceId)
    if (!input.title.trim()) fail('任务标题不能为空')
    space.taskSeq += 1
    const taskId = `${space.key}-${space.taskSeq}`
    const typeId = input.typeId ?? draft.taskTypes.find((t) => t.spaceId === space.id && t.isDefault)?.id
    // PRD 4.4 两层模型：状态必须在「该任务类型的可用状态」内
    const allowed = allowedStatusIds(draft, space.id, typeId)
    const statusId = input.statusId ?? defaultStatusId(draft, space.id)
    if (!draft.taskStatuses.some((s) => s.id === statusId && s.spaceId === space.id)) fail('给定状态不属于该空间')
    if (!allowed.has(statusId)) fail('该状态不在当前任务类型的可用状态里（PRD 4.4）')
    const assigneeIds = validateAssignees(draft, space, input.assigneeIds ?? [])
    const task: HifoxTask = {
      id: taskId,
      spaceId: space.id,
      title: input.title.trim(),
      description: input.description?.trim() || undefined,
      typeId,
      statusId,
      priority: input.priority ?? 'none',
      assigneeIds,
      creatorId: 'm-lin',
      labelIds: [...new Set(input.labelIds ?? [])],
      projectId: input.projectId ?? undefined,
      iterationIds: [...new Set(input.iterationIds ?? [])],
      parentTaskId: input.parentTaskId ?? undefined,
      relations: [],
      followerIds: [],
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
    validateExecutor(draft, space.id, input.executor ?? undefined)
    if (input.executor) task.executor = { ...input.executor }
    draft.tasks.unshift(task)
    if (task.parentTaskId && !draft.tasks.some((t) => t.id === task.parentTaskId)) {
      task.parentTaskId = undefined
    }
    for (const iterationId of task.iterationIds) {
      const iteration = draft.iterations.find((it) => it.id === iterationId)
      if (iteration && !iteration.taskIds.includes(taskId)) iteration.taskIds.push(taskId)
    }
    pushActivity(draft, taskId, 'created', '任务创建')
    refreshDispatch(draft, task, '指派执行槽')
    evaluateAutomationsForTaskCreated(draft, task)
    return taskId
  })
  return { snapshot, taskId: result }
}

export function updateTask(input: { id: HifoxID; patch: HifoxTaskPatchInput }): HifoxSnapshot {
  return mutate((draft) => {
    const task = taskOf(draft, input.id)
    const space = spaceOf(draft, task.spaceId)
    const patch = input.patch
    const changes: string[] = []

    if (patch.title !== undefined && patch.title.trim() && patch.title !== task.title) {
      task.title = patch.title.trim()
      changes.push('标题')
    }
    if (patch.description !== undefined) {
      task.description = patch.description.trim() || undefined
      changes.push('描述')
    }
    if (patch.typeId !== undefined) {
      if (patch.typeId === null) task.typeId = undefined
      else {
        if (!draft.taskTypes.some((t) => t.id === patch.typeId && t.spaceId === space.id)) fail('任务类型不属于该空间')
        task.typeId = patch.typeId
      }
      // 类型切换后状态可选集变化：当前状态不可用时回退（PRD 4.4 规则2）
      const allowedAfterType = allowedStatusIds(draft, space.id, task.typeId)
      if (!allowedAfterType.has(task.statusId)) {
        const fallback = [...allowedAfterType][0] ?? defaultStatusId(draft, space.id)
        task.statusId = fallback
        pushActivity(draft, task.id, 'status', `类型变更后状态迁移为 ${draft.taskStatuses.find((s) => s.id === fallback)?.name}`)
      }
      changes.push('类型')
    }
    if (patch.priority !== undefined && patch.priority !== task.priority) {
      task.priority = patch.priority
      changes.push('优先级')
    }
    if (patch.labelIds !== undefined) {
      task.labelIds = [...new Set(patch.labelIds)]
      changes.push('标签')
    }
    if (patch.projectId !== undefined) {
      task.projectId = patch.projectId ?? undefined
      changes.push('专项')
    }
    if (patch.iterationIds !== undefined) {
      const next = [...new Set(patch.iterationIds)]
      for (const id of next) if (!draft.iterations.some((it) => it.id === id && it.spaceId === space.id)) fail('迭代不属于该空间')
      for (const iteration of draft.iterations) {
        const shouldContain = next.includes(iteration.id)
        const contains = iteration.taskIds.includes(task.id)
        if (shouldContain && !contains) iteration.taskIds.push(task.id)
        if (!shouldContain && contains) iteration.taskIds = iteration.taskIds.filter((id) => id !== task.id)
      }
      task.iterationIds = next
      changes.push('迭代')
    }
    if (patch.assigneeIds !== undefined) {
      const previous = new Set(task.assigneeIds)
      task.assigneeIds = validateAssignees(draft, space, patch.assigneeIds)
      changes.push('处理人')
      // 被指派 → 重要（REA 实测：任务指派给你属于强提醒）
      for (const id of task.assigneeIds) {
        if (!previous.has(id)) {
          pushInbox(draft, {
            section: 'important',
            kind: 'assign',
            title: `${task.id} 指派给了你`,
            body: task.title,
            taskId: task.id
          })
          break
        }
      }
    }
    if (patch.executor !== undefined) {
      if (patch.executor === null) {
        task.executor = undefined
        changes.push('清空执行槽')
      } else {
        validateExecutor(draft, space.id, patch.executor)
        task.executor = { ...patch.executor }
        changes.push('执行槽')
      }
    }
    if (patch.followerToggle !== undefined) {
      if (patch.followerToggle === 'ALL') {
        // 面板语义：清空关注
        task.followerIds = []
      } else if (task.followerIds.includes(patch.followerToggle)) {
        task.followerIds = task.followerIds.filter((id) => id !== patch.followerToggle)
        changes.push('取消关注')
      } else {
        task.followerIds.push(patch.followerToggle)
        changes.push('关注')
      }
    }

    if (patch.statusId !== undefined && patch.statusId !== task.statusId) {
      const nextStatus = draft.taskStatuses.find((s) => s.id === patch.statusId && s.spaceId === space.id)
      if (!nextStatus) fail('目标状态不属于该空间')
      // PRD 4.4 两层模型：切类型后状态可选集随之收窄
      if (!allowedStatusIds(draft, space.id, task.typeId).has(nextStatus.id)) fail('该状态不在当前任务类型的可用状态里（PRD 4.4）')
      const prev = draft.taskStatuses.find((s) => s.id === task.statusId)
      task.statusId = nextStatus.id
      if (nextStatus.category === 'done') task.completedAt = nowIso()
      else task.completedAt = undefined
      pushActivity(draft, task.id, 'status', `状态从 ${prev?.name ?? '—'} 变更为 ${nextStatus.name}`)
      // 状态流转通知 → 其他（REA 实测：状态变化/任务完成属于弱提醒，同一任务在 UI 聚合为一行）
      pushInbox(draft, { section: 'other', kind: 'status', title: `${task.id} 进入 ${nextStatus.name}`, body: task.title, taskId: task.id })
      evaluateAutomationsForStatus(draft, task, nextStatus.name)
    }

    refreshDispatch(draft, task, '执行状态更新')

    if (changes.length > 0) {
      pushActivity(draft, task.id, 'field', `更新了${changes.join('、')}`)
      task.updatedAt = nowIso()
    }
    return undefined
  }).snapshot
}

export function removeTask(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const task = taskOf(draft, input.id)
    draft.tasks = draft.tasks.filter((t) => t.id !== input.id)
    for (const t of draft.tasks) {
      t.relations = t.relations.filter((r) => r.taskId !== input.id)
      if (t.parentTaskId === input.id) t.parentTaskId = undefined
    }
    for (const iteration of draft.iterations) iteration.taskIds = iteration.taskIds.filter((id) => id !== input.id)
    draft.comments = draft.comments.filter((c) => c.taskId !== input.id)
    draft.activities = draft.activities.filter((a) => a.taskId !== input.id)
    draft.inbox = draft.inbox.filter((i) => i.taskId !== input.id)
    draft.triageDecisions = draft.triageDecisions.filter((d) => d.taskId !== input.id)
    return task.id
  }).snapshot
}

/* ---------------- 任务关联（PRD 4.5） ---------------- */

export function addRelation(input: { taskId: HifoxID; relation: HifoxTaskRelation }): HifoxSnapshot {
  return mutate((draft) => {
    const task = taskOf(draft, input.taskId)
    if (input.relation.taskId === input.taskId) fail('不能与自身建立关联')
    const target = taskOf(draft, input.relation.taskId)
    // PRD 4.5 规则2：同组织内可跨空间关联（面板数据同属一个组织）
    if (task.relations.some((r) => r.taskId === input.relation.taskId)) fail('两个任务已存在关联')
    // PRD 4.5 规则4：反向冲突关系拦截（对方已关联我）
    if (target.relations.some((r) => r.taskId === input.taskId)) fail('两个任务已存在关联（反向）')
    task.relations.push({ kind: input.relation.kind, taskId: input.relation.taskId })
    // blocks 双向可读：目标侧登记 related 引用
    if (input.relation.kind === 'blocks' && !target.relations.some((r) => r.taskId === input.taskId)) {
      target.relations.push({ kind: 'related', taskId: input.taskId })
    }
    pushActivity(draft, task.id, 'relation', `与 ${input.relation.taskId} 建立 ${relationLabel(input.relation.kind)} 关联`)
    return undefined
  }).snapshot
}

export function removeRelation(input: { taskId: HifoxID; targetTaskId: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const task = taskOf(draft, input.taskId)
    const target = draft.tasks.find((t) => t.id === input.targetTaskId)
    task.relations = task.relations.filter((r) => r.taskId !== input.targetTaskId)
    if (target) target.relations = target.relations.filter((r) => r.taskId !== input.taskId)
    pushActivity(draft, task.id, 'relation', `移除与 ${input.targetTaskId} 的关联`)
    return undefined
  }).snapshot
}

export function relationLabel(kind: HifoxTaskRelation['kind']): string {
  return kind === 'blocks' ? '阻塞' : kind === 'duplicate' ? '重复' : '相关'
}

/* ---------------- 评论（PRD 2.5） ---------------- */

export function addComment(input: { taskId: HifoxID; body: string; authorId: string }): HifoxSnapshot {
  return mutate((draft) => {
    const task = taskOf(draft, input.taskId)
    if (!input.body.trim()) fail('评论内容不能为空')
    // @提及自动识别成员姓名（PRD 2.5：@ 该看的人）
    const mentions = draft.members.filter((m) => input.body.includes(`@${m.name}`)).map((m) => m.id)
    const comment: HifoxComment = {
      id: nextId('cm'),
      taskId: task.id,
      authorId: input.authorId,
      body: input.body.trim(),
      mentions,
      createdAt: nowIso()
    }
    draft.comments.push(comment)
    const authorLabel = input.authorId.startsWith('agent:')
      ? `Agent「${draft.agents.find((a) => a.id === input.authorId.slice(6))?.name ?? 'Agent'}」`
      : memberName(draft, input.authorId)
    pushActivity(draft, task.id, 'comment', `${authorLabel} 评论：${input.body.trim().slice(0, 30)}${input.body.trim().length > 30 ? '……' : ''}`)
    for (const mention of mentions) {
      if (mention !== input.authorId) {
        // @提及 → 重要（REA 实测：直接 @ 你属于强提醒）
        pushInbox(draft, { section: 'important', kind: 'mention', title: `${authorLabel} 在 ${task.id} 提到了你`, body: input.body.trim().slice(0, 80), taskId: task.id })
        break
      }
    }
    // 关注任务的新评论 → 其他（PRD 2.6 事件清单：关注的任务有新评论）
    if (task.followerIds.length > 0 && !task.followerIds.includes(input.authorId)) {
      pushInbox(draft, { section: 'other', kind: 'status', title: `你关注的 ${task.id} 有新评论`, body: `${authorLabel}：${input.body.trim().slice(0, 60)}`, taskId: task.id })
    }
    evaluateAutomationsForComment(draft, task, input.body)
    task.updatedAt = nowIso()
    return comment.id
  }).snapshot
}

export function resolveComment(input: { id: HifoxID; resolved: boolean }): HifoxSnapshot {
  return mutate((draft) => {
    const comment = draft.comments.find((c) => c.id === input.id) ?? fail('评论不存在')
    comment.resolved = input.resolved
    pushActivity(draft, comment.taskId, 'comment', input.resolved ? '一段讨论被标记为已解决' : '一段讨论被重新打开')
    return undefined
  }).snapshot
}

/* ---------------- 收件箱（PRD 2.6 + REA 实测校准） ---------------- */

export function markInboxRead(input: { ids?: HifoxID[]; all?: boolean; section?: HifoxInboxSection }): HifoxSnapshot {
  return mutate((draft) => {
    for (const item of draft.inbox) {
      if (input.all || (input.section && item.section === input.section) || (input.ids && input.ids.includes(item.id))) {
        item.read = true
      }
    }
    return undefined
  }).snapshot
}

/** 稍后处理：同一任务的活跃通知一起进入稍后；到时回对应分区 */
export function snoozeInbox(input: { id: HifoxID; option: '20m' | '2h' | 'tomorrow' | 'nextweek' }): HifoxSnapshot {
  return mutate((draft) => {
    const item = draft.inbox.find((i) => i.id === input.id) ?? fail('收件箱条目不存在')
    const base = Date.now()
    let until: number
    if (input.option === '20m') until = base + 20 * 60 * 1000
    else if (input.option === '2h') until = base + 2 * 60 * 60 * 1000
    else if (input.option === 'tomorrow') {
      const next = new Date(base)
      next.setHours(9, 0, 0, 0)
      until = next.getTime() <= base ? next.getTime() + 24 * 60 * 60 * 1000 : next.getTime()
    } else {
      const next = new Date(base)
      next.setDate(next.getDate() + 7)
      next.setHours(9, 0, 0, 0)
      until = next.getTime()
    }
    // 任务级稍后：该任务所有未清理通知一并进入稍后
    const taskId = item.taskId
    for (const other of draft.inbox) {
      if (!taskId || other.taskId === taskId) other.snoozedUntil = new Date(until).toISOString()
    }
    return undefined
  }).snapshot
}

/** 清理：移入已清理，可恢复；不删除任务/评论/活动（REA 实测语义） */
export function clearInbox(input: { ids?: HifoxID[]; all?: boolean; section?: HifoxInboxSection }): HifoxSnapshot {
  return mutate((draft) => {
    for (const item of draft.inbox) {
      if (input.all || (input.section && item.section === input.section) || (input.ids && input.ids.includes(item.id))) {
        item.cleared = true
        item.snoozedUntil = undefined
      }
    }
    return undefined
  }).snapshot
}

export function restoreInbox(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const item = draft.inbox.find((i) => i.id === input.id) ?? fail('收件箱条目不存在')
    item.cleared = false
    return undefined
  }).snapshot
}
