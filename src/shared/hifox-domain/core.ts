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
  HifoxInitialTaskType,
  HifoxMember,
  HifoxRole,
  HifoxSnapshot,
  HifoxSpace,
  HifoxStatusCategory,
  HifoxTask,
  HifoxTaskInput,
  HifoxTaskPatchInput,
  HifoxTaskRelation
} from '../hifox'
import { hifoxInitialTaskTypesSchema } from '../hifox-schema'
import { mutate, nextId, nowIso } from './store'
import { evaluateAutomationsForComment, evaluateAutomationsForStatus, evaluateAutomationsForTaskCreated, refreshTaskDispatch as refreshDispatch, setTaskIterations } from './planning'

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

export function createSpace(input: { name: string; key: string; description?: string; visibility?: HifoxSpace['visibility']; initialTaskTypes?: HifoxInitialTaskType[]; actorId?: HifoxID }): HifoxSnapshot {
  const selectedTypes = hifoxInitialTaskTypesSchema.parse(input.initialTaskTypes === undefined ? ['需求', 'Bug', '任务', '内容'] : input.initialTaskTypes)
  return mutate((draft) => {
    const key = input.key.trim().toUpperCase()
    if (!input.name.trim()) fail('空间名称不能为空')
    if (!/^[A-Z0-9]{2,7}$/.test(key)) fail('空间前缀需为 2~7 个英文字母或数字')
    if (draft.spaces.some((s) => s.key === key)) fail(`空间前缀 ${key} 已存在`)
    if (input.visibility !== undefined && !['public', 'private'].includes(input.visibility)) fail('空间访问权限无效')
    const owner = input.actorId
      ? draft.members.find((m) => m.id === input.actorId) ?? fail('空间创建人不存在')
      : draft.members.find((m) => m.id === 'local-owner' && m.role === 'owner')
        ?? draft.members.find((m) => m.role === 'owner') ?? fail('组织缺少所有者')
    const space: HifoxSpace = {
      id: nextId('sp'),
      name: input.name.trim(),
      key,
      description: input.description?.trim() || undefined,
      visibility: input.visibility ?? 'public',
      ownerId: owner.id,
      multiAssignee: false,
      memberIds: [owner.id],
      taskSeq: 0,
      createdAt: nowIso()
    }
    draft.spaces.push(space)
    // 每个新空间自带默认类型与七类状态（PRD 3.2 / 4.4）
    const defaultType = selectedTypes.includes('需求') ? '需求' : selectedTypes[0]
    for (const name of selectedTypes) {
      const requiredHints = name === '需求' ? ['背景与目标', '验收标准'] : name === 'Bug' ? ['复现步骤', '影响范围'] : undefined
      draft.taskTypes.push({ id: nextId('tt'), spaceId: space.id, name, requiredHints, isDefault: name === defaultType ? true : undefined })
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

export function updateSpace(input: { id: HifoxID; name?: string; description?: string; multiAssignee?: boolean; visibility?: HifoxSpace['visibility']; archived?: boolean }): HifoxSnapshot {
  return mutate((draft) => {
    const space = spaceOf(draft, input.id)
    if (space.archived && (input.archived !== false || Object.keys(input).some((key) => key !== 'id' && key !== 'archived'))) fail('空间已停用，只能先恢复空间')
    if (input.archived === true && !space.archived && draft.tasks.some((task) => task.spaceId === space.id && (task.triagePending || (task.workflow ? task.workflow.stage !== 'done' : !['done', 'cancelled'].includes(statusCategoryOf(draft, task.statusId) ?? ''))))) {
      fail('空间还有未完成任务，请先取消任务或移到其他空间，再停用空间')
    }
    if (input.name !== undefined) {
      if (!input.name.trim()) fail('空间名称不能为空')
      space.name = input.name.trim()
    }
    if (input.description !== undefined) space.description = input.description.trim() || undefined
    if (input.visibility !== undefined) {
      if (!['public', 'private'].includes(input.visibility)) fail('空间访问权限无效')
      space.visibility = input.visibility
    }
    if (input.archived !== undefined) {
      space.archived = input.archived
      if (input.archived) for (const rule of draft.automations) if (rule.spaceId === space.id) rule.enabled = false
    }
    if (input.multiAssignee !== undefined) {
      space.multiAssignee = input.multiAssignee
      // The setting governs new assignments; historical sets remain editable.
    }
    return undefined
  }).snapshot
}

export function joinSpace(input: { spaceId: HifoxID; memberId?: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const space = spaceOf(draft, input.spaceId)
    if (space.archived) fail('空间已停用，请先恢复空间')
    if (space.visibility === 'private') fail('私有空间需由已有空间成员添加成员')
    const memberId = input.memberId ?? draft.members.find((member) => member.id === 'local-owner')?.id ?? draft.members.find((member) => member.role === 'owner')?.id
    if (!memberId || !draft.members.some((member) => member.id === memberId)) fail('加入空间的成员不存在')
    if (!space.memberIds.includes(memberId)) space.memberIds.push(memberId)
  }).snapshot
}

/* ---------------- 成员 ---------------- */

function normalizeMemberEmail(email?: string): string | undefined {
  if (email !== undefined && typeof email !== 'string') fail('成员邮箱必须为文本')
  return email?.trim() || undefined
}

export function inviteMember(input: { name: string; email?: string; title?: string; role?: HifoxRole; spaceId?: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    if (!input.name.trim()) fail('成员姓名不能为空')
    if (input.role !== undefined && !['owner', 'admin', 'member'].includes(input.role)) fail('成员角色无效')
    if (draft.members.some((m) => m.name === input.name.trim())) fail('同名成员已存在')
    const member: HifoxMember = {
      id: nextId('m'),
      name: input.name.trim(),
      email: normalizeMemberEmail(input.email),
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

export function updateMember(input: { id: HifoxID; name?: string; email?: string; title?: string; role?: HifoxRole }): HifoxSnapshot {
  return mutate((draft) => {
    const member = draft.members.find((m) => m.id === input.id) ?? fail('成员不存在')
    if (input.name !== undefined) {
      if (!input.name.trim()) fail('成员姓名不能为空')
      if (draft.members.some((m) => m.id !== member.id && m.name === input.name?.trim())) fail('同名成员已存在')
      member.name = input.name.trim()
      for (const crew of draft.crews) {
        if (crew.captain.kind === 'member' && crew.captain.id === member.id) crew.captain.name = member.name
        for (const ref of crew.members) if (ref.kind === 'member' && ref.id === member.id) ref.name = member.name
      }
      for (const automation of draft.automations) {
        if (automation.target.kind === 'member' && automation.target.id === member.id) automation.target.name = member.name
      }
    }
    if (input.email !== undefined) member.email = normalizeMemberEmail(input.email)
    if (input.title !== undefined) member.title = input.title.trim() || undefined
    if (input.role !== undefined) {
      if (!['owner', 'admin', 'member'].includes(input.role)) fail('成员角色无效')
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
    if (draft.crews.some((crew) => !crew.archived && crew.captain.kind === 'member' && crew.captain.id === input.id)) fail('请先更换人员队长或归档小队')
    if (draft.tasks.some((task) => task.workflow && task.workflow.stage !== 'done' && (task.workflow.handlerId === input.id || task.workflow.resumeAssigneeId === input.id))) fail('请先交接该成员正在处理的任务')
    draft.members = draft.members.filter((m) => m.id !== input.id)
    for (const space of draft.spaces) space.memberIds = space.memberIds.filter((id) => id !== input.id)
    for (const task of draft.tasks) {
      task.assigneeIds = task.assigneeIds.filter((id) => id !== input.id)
      task.followerIds = task.followerIds.filter((id) => id !== input.id)
    }
    for (const project of draft.projects) project.ownerIds = project.ownerIds.filter((id) => id !== input.id)
    for (const crew of draft.crews) {
      crew.members = crew.members.filter((ref) => !(ref.kind === 'member' && ref.id === input.id))
      if (crew.ownerId === input.id) crew.ownerId = undefined
    }
    for (const automation of draft.automations) {
      if (automation.target.kind === 'member' && automation.target.id === input.id) {
        automation.target = { kind: 'none' }
        automation.enabled = false
      }
    }
    return undefined
  }).snapshot
}

export function setSpaceMembers(input: { spaceId: HifoxID; memberIds: HifoxID[] }): HifoxSnapshot {
  return mutate((draft) => {
    const space = spaceOf(draft, input.spaceId)
    if (space.archived) fail('空间已停用，请先恢复空间')
    for (const id of input.memberIds) {
      if (!draft.members.some((m) => m.id === id)) fail(`成员 ${id} 不存在`)
    }
    if (draft.crews.some((crew) => crew.spaceId === space.id && !crew.archived && crew.captain.kind === 'member' && !input.memberIds.includes(crew.captain.id))) fail('请先更换人员队长或归档小队')
    if (draft.tasks.some((task) => task.spaceId === space.id && task.workflow && task.workflow.stage !== 'done' && [task.workflow.handlerId, task.workflow.resumeAssigneeId].some((id) => id && !input.memberIds.includes(id)))) fail('请先交接离开空间成员正在处理的任务')
    space.memberIds = [...new Set(input.memberIds)]
    for (const crew of draft.crews.filter((c) => c.spaceId === space.id)) {
      crew.members = crew.members.filter((ref) => ref.kind !== 'member' || space.memberIds.includes(ref.id))
      if (crew.ownerId && !space.memberIds.includes(crew.ownerId)) crew.ownerId = undefined
    }
    for (const automation of draft.automations.filter((a) => a.spaceId === space.id)) {
      if (automation.target.kind === 'member' && !space.memberIds.includes(automation.target.id ?? '')) automation.enabled = false
    }
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
    if (input.name !== undefined) {
      if (!input.name.trim()) fail('类型名称不能为空')
      if (draft.taskTypes.some((t) => t.id !== type.id && t.spaceId === type.spaceId && t.name === input.name?.trim())) fail('同名类型已存在')
      type.name = input.name.trim()
    }
    if (input.statusIds !== undefined) {
      for (const id of input.statusIds) {
        if (!draft.taskStatuses.some((s) => s.id === id && s.spaceId === type.spaceId)) fail('类型可用状态必须属于该空间')
      }
      const next = [...new Set(input.statusIds)]
      if (next.length > 0 && draft.tasks.some((task) => task.typeId === type.id && !next.includes(task.statusId))) {
        fail('仍有任务使用待移除状态，先迁移任务后再调整工作流')
      }
      type.statusIds = next
    }
    return undefined
  }).snapshot
}

/** 类型可用状态（两层模型，PRD 4.4）：未配置时为空间全部状态 */
export function allowedStatusIds(draft: HifoxSnapshot, spaceId: HifoxID, typeId?: HifoxID): Set<HifoxID> {
  const type = typeId ? draft.taskTypes.find((t) => t.id === typeId && t.spaceId === spaceId) ?? fail('任务类型不属于该空间') : undefined
  if (type?.statusIds?.length) return new Set(type.statusIds)
  return new Set(draft.taskStatuses.filter((s) => s.spaceId === spaceId).map((s) => s.id))
}

export function removeTaskType(input: { id: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const type = draft.taskTypes.find((t) => t.id === input.id) ?? fail('类型不存在')
    if (type.isDefault) fail('默认类型不可删除')
    if (draft.tasks.some((task) => task.typeId === type.id)) fail('仍有任务使用该类型，先迁移任务后再删除')
    draft.taskTypes = draft.taskTypes.filter((t) => t.id !== input.id)
    return undefined
  }).snapshot
}

export function createTaskStatus(input: { spaceId: HifoxID; name: string; category: HifoxStatusCategory }): HifoxSnapshot {
  return mutate((draft) => {
    spaceOf(draft, input.spaceId)
    if (!input.name.trim()) fail('状态名称不能为空')
    if (!['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'].includes(input.category)) fail('状态类别无效')
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
    if (draft.taskTypes.some((t) => t.statusIds?.includes(input.id))) fail('任务类型仍在使用该状态，先调整工作流后再删除')
    if (draft.automations.some((a) => a.trigger.kind === 'task_status' && a.trigger.value === input.id)) fail('自动化仍在使用该状态')
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
    return undefined
  }).snapshot
}

/* ---------------- 任务 ---------------- */

function validateAssignees(draft: HifoxSnapshot, space: HifoxSpace, assigneeIds: HifoxID[], previous: HifoxID[] = []): HifoxID[] {
  const unique = [...new Set(assigneeIds)]
  for (const id of unique) {
    if (!draft.members.some((m) => m.id === id) || (!space.memberIds.includes(id) && !previous.includes(id))) fail(`处理人 ${memberName(draft, id)} 不在该空间内`)
  }
  if (!space.multiAssignee && unique.length > 1 && previous.length <= 1) fail('该空间未开启多人处理人，仅可设置一名处理人')
  return unique
}

export function validateExecutor(draft: HifoxSnapshot, spaceId: HifoxID, executor: HifoxTask['executor']): void {
  if (!executor) return
  if (executor.kind === 'agent') {
    const agent = draft.agents.find((a) => a.id === executor.id)
    if (!agent || agent.spaceId !== spaceId) fail('执行 Agent 不在该空间内')
    if (!agent.enabled) fail('执行 Agent 已停用，先启用后再指派')
    if (agent.archived) fail('执行 Agent 已归档')
    if (agent.exclusiveCrewId) fail('该 Agent 为小队专属成员，不能单独指派')
    executor.name = agent.name
  } else if (executor.kind === 'crew') {
    const crew = draft.crews.find((c) => c.id === executor.id)
    if (!crew || crew.spaceId !== spaceId) fail('执行小队不在该空间内')
    if (crew.archived) fail('执行小队已归档')
    if (crew.captain.kind === 'agent') {
      if (!draft.agents.some((a) => a.id === crew.captain.id && a.spaceId === spaceId && a.enabled && !a.archived && (!a.exclusiveCrewId || a.exclusiveCrewId === crew.id))) fail('小队队长不可用')
    } else if (!draft.spaces.find((space) => space.id === spaceId)?.memberIds.includes(crew.captain.id) || !draft.members.some((member) => member.id === crew.captain.id)) fail('小队队长不在该空间内')
    executor.name = crew.name
  } else fail('执行槽类型无效')
}

function defaultStatusId(draft: HifoxSnapshot, spaceId: HifoxID, typeId?: HifoxID): HifoxID {
  const allowed = allowedStatusIds(draft, spaceId, typeId)
  const type = draft.taskTypes.find((t) => t.id === typeId)
  const ordered = type?.statusIds?.length ? type.statusIds : [...allowed]
  const statuses = ordered.flatMap((id) => {
    const status = draft.taskStatuses.find((s) => s.id === id)
    return status && !['done', 'cancelled'].includes(status.category) ? [status] : []
  })
  return statuses.find((s) => s.category === 'todo')?.id ?? statuses[0]?.id ?? fail('任务类型缺少可用的默认状态')
}

function validateLabels(draft: HifoxSnapshot, spaceId: HifoxID, labelIds: HifoxID[], previous: HifoxID[] = []): HifoxID[] {
  const unique = [...new Set(labelIds)]
  for (const id of unique) {
    const label = draft.taskLabels.find((l) => l.id === id)
    if (!label || (label.spaceId && label.spaceId !== spaceId)) fail('标签不属于该空间或组织')
    if (label.archived && !previous.includes(id)) fail('归档标签不能新添加到任务')
  }
  return unique
}

function validateProject(draft: HifoxSnapshot, spaceId: HifoxID, projectId?: HifoxID | null, previous?: HifoxID): void {
  if (!projectId) return
  const project = draft.projects.find((p) => p.id === projectId && p.spaceId === spaceId)
  if (!project) fail('专项不属于该空间')
  if (project.status === 'archived' && previous !== projectId) fail('不能添加到已归档专项')
}

function validateParent(draft: HifoxSnapshot, task: Pick<HifoxTask, 'id' | 'spaceId'>, parentId?: HifoxID | null): void {
  const seen = new Set([task.id])
  let id = parentId
  while (id) {
    if (seen.has(id)) fail('父子任务不能形成循环')
    seen.add(id)
    const parent = taskOf(draft, id)
    if (parent.spaceId !== task.spaceId) fail('父任务必须属于同一空间')
    id = parent.parentTaskId
  }
}

function validatePriority(priority: HifoxTask['priority']): void {
  if (!['urgent', 'high', 'medium', 'low', 'none'].includes(priority)) fail('任务优先级无效')
}

export function createTask(input: HifoxTaskInput): { snapshot: HifoxSnapshot; taskId: HifoxID } {
  const { snapshot, result } = mutate((draft) => {
    const space = spaceOf(draft, input.spaceId)
    if (!input.title.trim()) fail('任务标题不能为空')
    const eligible = draft.members.filter((m) => space.memberIds.includes(m.id))
    const creator = input.creatorId
      ? eligible.find((m) => m.id === input.creatorId) ?? fail('任务创建人不在该空间内')
      : eligible.find((m) => m.role === 'owner') ?? eligible[0] ?? fail('空间没有成员，请先添加成员再创建任务')
    space.taskSeq += 1
    const taskId = `${space.key}-${space.taskSeq}`
    const typeId = input.typeId ?? draft.taskTypes.find((t) => t.spaceId === space.id && t.isDefault)?.id
    // PRD 4.4 两层模型：状态必须在「该任务类型的可用状态」内
    const allowed = allowedStatusIds(draft, space.id, typeId)
    const statusId = input.statusId ?? defaultStatusId(draft, space.id, typeId)
    const usesWorkflow = input.workKind !== undefined || input.acceptanceCriteria !== undefined
    if (usesWorkflow && input.statusId !== undefined && statusCategoryOf(draft, statusId) !== 'backlog') fail('新交接任务必须从待分拣或已接受阶段开始')
    if (!draft.taskStatuses.some((s) => s.id === statusId && s.spaceId === space.id)) fail('给定状态不属于该空间')
    if (!allowed.has(statusId)) fail('该状态不在当前任务类型的可用状态里（PRD 4.4）')
    const assigneeIds = validateAssignees(draft, space, input.assigneeIds ?? [])
    validatePriority(input.priority ?? 'none')
    validateProject(draft, space.id, input.projectId)
    const task: HifoxTask = {
      id: taskId,
      spaceId: space.id,
      title: input.title.trim(),
      description: input.description?.trim() || undefined,
      typeId,
      statusId: usesWorkflow ? draft.taskStatuses.find((status) => status.spaceId === space.id && status.category === 'backlog' && allowed.has(status.id))?.id ?? fail('任务类型缺少 Backlog 状态') : statusId,
      priority: input.priority ?? 'none',
      assigneeIds,
      creatorId: creator.id,
      labelIds: validateLabels(draft, space.id, input.labelIds ?? []),
      projectId: input.projectId ?? undefined,
      iterationIds: [],
      parentTaskId: input.parentTaskId ?? undefined,
      relations: [],
      followerIds: [],
      triagePending: input.triagePending || undefined,
      workKind: usesWorkflow ? input.workKind ?? 'code' : undefined,
      acceptanceCriteria: input.acceptanceCriteria,
      workflow: usesWorkflow ? { stage: 'accepted', handlerId: assigneeIds[0] ?? (input.triagePending ? undefined : creator.id), artifacts: [], history: [] } : undefined,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: statusCategoryOf(draft, statusId) === 'done' ? nowIso() : undefined
    }
    if (task.triagePending && ['done', 'cancelled'].includes(statusCategoryOf(draft, statusId) ?? '')) fail('待分拣任务不能处于终态')
    if (input.executor) {
      task.executor = { ...input.executor }
      validateExecutor(draft, space.id, task.executor)
      if (task.workflow && !task.workflow.handlerId && task.executor.kind === 'crew') {
        const crew = draft.crews.find((item) => item.id === task.executor?.id)
        task.workflow.handlerId = crew?.captain.kind === 'member' ? crew.captain.id : crew?.ownerId
      }
    }
    if (task.workflow?.handlerId && task.assigneeIds.length === 0) task.assigneeIds = [task.workflow.handlerId]
    validateParent(draft, task, task.parentTaskId)
    draft.tasks.unshift(task)
    for (const assignee of task.assigneeIds) pushInbox(draft, { section: 'important', kind: 'assign', title: `${task.id} 已指派给 ${memberName(draft, assignee)}`, body: task.title, taskId: task.id, recipientIds: [assignee] })
    setTaskIterations(draft, task, input.iterationIds ?? [])
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
    const originalStatusId = task.statusId

    const initialTriage = task.triagePending === true && task.workflow?.stage === 'accepted' &&
      task.workflow.history.length === 0 && task.workflow.artifacts.length === 0 && !task.workflow.deliveryState &&
      !task.workflow.resumeStage && !task.workflow.resumeAssigneeId && task.iterationIds.length === 0 && !task.completedAt &&
      statusCategoryOf(draft, task.statusId) === 'backlog' && !draft.triageDecisions.some((decision) => decision.taskId === task.id)
    if (task.workflow && (['assigneeIds', 'executor', 'workKind'].some((key) => key in patch) || 'acceptanceCriteria' in patch && !initialTriage)) fail('交接任务请通过阶段操作修改处理人、执行配置和验收标准')
    if (task.workflow && patch.statusId !== undefined && statusCategoryOf(draft, patch.statusId) !== statusCategoryOf(draft, task.statusId)) fail('交接任务请通过阶段操作修改状态类别')
    if (!task.workflow && (patch.workKind !== undefined || patch.acceptanceCriteria !== undefined)) fail('旧任务保留原有流程，不能通过字段编辑启用交接流程')

    if (patch.title !== undefined && !patch.title.trim()) fail('任务标题不能为空')
    if (patch.title !== undefined && patch.title.trim() !== task.title) {
      task.title = patch.title.trim()
      changes.push('标题')
    }
    if (patch.description !== undefined) {
      task.description = patch.description.trim() || undefined
      changes.push('描述')
    }
    if (patch.acceptanceCriteria !== undefined && JSON.stringify(patch.acceptanceCriteria) !== JSON.stringify(task.acceptanceCriteria)) {
      task.acceptanceCriteria = [...patch.acceptanceCriteria]
      changes.push('验收标准')
    }
    if (patch.typeId !== undefined) {
      if (patch.typeId === null) task.typeId = undefined
      else {
        if (!draft.taskTypes.some((t) => t.id === patch.typeId && t.spaceId === space.id)) fail('任务类型不属于该空间')
        task.typeId = patch.typeId
      }
      // 类型切换后状态可选集变化：当前状态不可用时回退（PRD 4.4 规则2）
      const allowedAfterType = allowedStatusIds(draft, space.id, task.typeId)
      if (patch.statusId === undefined && !allowedAfterType.has(task.statusId)) {
        if (task.workflow) fail('任务类型必须支持当前交接阶段的状态')
        const fallback = defaultStatusId(draft, space.id, task.typeId)
        task.statusId = fallback
        pushActivity(draft, task.id, 'status', `类型变更后状态迁移为 ${draft.taskStatuses.find((s) => s.id === fallback)?.name}`)
      }
      changes.push('类型')
    }
    if (patch.priority !== undefined && patch.priority !== task.priority) {
      validatePriority(patch.priority)
      task.priority = patch.priority
      changes.push('优先级')
    }
    if (patch.labelIds !== undefined) {
      task.labelIds = validateLabels(draft, space.id, patch.labelIds, task.labelIds)
      changes.push('标签')
    }
    if (patch.projectId !== undefined) {
      validateProject(draft, space.id, patch.projectId, task.projectId)
      task.projectId = patch.projectId ?? undefined
      changes.push('专项')
    }
    if (patch.iterationIds !== undefined) {
      // Apply after the final status, so a task completed in this patch can join history.
      changes.push('版本')
    }
    if (patch.assigneeIds !== undefined) {
      const previous = new Set(task.assigneeIds)
      task.assigneeIds = validateAssignees(draft, space, patch.assigneeIds, task.assigneeIds)
      changes.push('处理人')
      // 被指派 → 重要（REA 实测：任务指派给你属于强提醒）
      for (const id of task.assigneeIds) {
        if (!previous.has(id)) {
          pushInbox(draft, {
            section: 'important',
            kind: 'assign',
            title: `${task.id} 已指派给 ${memberName(draft, id)}`,
            body: task.title,
            taskId: task.id,
            recipientIds: [id]
          })
        }
      }
    }
    if (patch.executor !== undefined) {
      if (patch.executor === null) {
        task.executor = undefined
        changes.push('清空执行槽')
      } else {
        task.executor = { ...patch.executor }
        validateExecutor(draft, space.id, task.executor)
        changes.push('执行槽')
      }
    }
    if (patch.followerToggle !== undefined) {
      if (patch.followerToggle !== 'ALL' && !draft.members.some((m) => m.id === patch.followerToggle)) fail('关注成员不存在')
      if (patch.followerToggle === 'ALL') {
        // 面板语义：清空关注
        task.followerIds = []
        changes.push('清空关注')
      } else if (task.followerIds.includes(patch.followerToggle)) {
        task.followerIds = task.followerIds.filter((id) => id !== patch.followerToggle)
        changes.push('取消关注')
      } else {
        task.followerIds.push(patch.followerToggle)
        changes.push('关注')
      }
    }

    if (patch.parentTaskId !== undefined) {
      validateParent(draft, task, patch.parentTaskId)
      task.parentTaskId = patch.parentTaskId ?? undefined
      changes.push('父任务')
    }

    if (patch.statusId !== undefined) {
      const nextStatus = draft.taskStatuses.find((s) => s.id === patch.statusId && s.spaceId === space.id)
      if (!nextStatus) fail('目标状态不属于该空间')
      // PRD 4.4 两层模型：切类型后状态可选集随之收窄
      if (!allowedStatusIds(draft, space.id, task.typeId).has(nextStatus.id)) fail('该状态不在当前任务类型的可用状态里（PRD 4.4）')
      task.statusId = nextStatus.id
    }
    if (task.statusId !== originalStatusId) {
      const prev = draft.taskStatuses.find((s) => s.id === originalStatusId)
      const nextStatus = draft.taskStatuses.find((s) => s.id === task.statusId) ?? fail('目标状态不存在')
      changes.push('状态')
      task.completedAt = nextStatus.category === 'done' ? nowIso() : undefined
      if (['done', 'cancelled'].includes(nextStatus.category)) task.triagePending = undefined
      pushActivity(draft, task.id, 'status', `状态从 ${prev?.name ?? '—'} 变更为 ${nextStatus.name}`)
      // 状态流转通知 → 其他（REA 实测：状态变化/任务完成属于弱提醒，同一任务在 UI 聚合为一行）
      pushInbox(draft, { section: 'other', kind: 'status', title: `${task.id} 进入 ${nextStatus.name}`, body: task.title, taskId: task.id, recipientIds: [...new Set([...task.assigneeIds, ...task.followerIds, task.creatorId])] })
      evaluateAutomationsForStatus(draft, task, nextStatus.name)
    }

    if (patch.iterationIds !== undefined) setTaskIterations(draft, task, patch.iterationIds)

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
    if (draft.iterations.some((iteration) => iteration.status === 'completed' && (iteration.taskIds.includes(task.id) || task.iterationIds.includes(iteration.id)))) fail('已关闭版本的任务范围不能增删，不能删除其中任务')
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
    if (!['blocks', 'related', 'duplicate'].includes(input.relation.kind)) fail('任务关联类型无效')
    // PRD 4.5 规则2：同组织内可跨空间关联（面板数据同属一个组织）
    if (task.relations.some((r) => r.taskId === input.relation.taskId)) fail('两个任务已存在关联')
    // PRD 4.5 规则4：反向冲突关系拦截（对方已关联我）
    if (target.relations.some((r) => r.taskId === input.taskId)) fail('两个任务已存在关联（反向）')
    task.relations.push({ kind: input.relation.kind, taskId: input.relation.taskId })
    target.relations.push({ kind: input.relation.kind === 'blocks' ? 'related' : input.relation.kind, taskId: input.taskId })
    task.updatedAt = nowIso()
    target.updatedAt = nowIso()
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
    task.updatedAt = nowIso()
    if (target) target.updatedAt = nowIso()
    pushActivity(draft, task.id, 'relation', `移除与 ${input.targetTaskId} 的关联`)
    return undefined
  }).snapshot
}

export function relationLabel(kind: HifoxTaskRelation['kind']): string {
  return kind === 'blocks' ? '阻塞' : kind === 'duplicate' ? '重复' : '相关'
}

/* ---------------- 评论（PRD 2.5） ---------------- */

export function addComment(input: { taskId: HifoxID; body: string; authorId: string; parentId?: HifoxID }): HifoxSnapshot {
  return mutate((draft) => {
    const task = taskOf(draft, input.taskId)
    if (!input.body.trim()) fail('评论内容不能为空')
    if (input.parentId !== undefined) {
      const parent = draft.comments.find((c) => c.id === input.parentId) ?? fail('回复的评论不存在')
      if (parent.taskId !== task.id) fail('只能回复同一任务内的评论')
    }
    if (input.authorId.startsWith('agent:')) {
      if (!draft.agents.some((a) => a.id === input.authorId.slice(6) && a.spaceId === task.spaceId)) fail('评论 Agent 不在该空间内')
    } else if (!draft.members.some((m) => m.id === input.authorId)) fail('评论作者不存在')
    // @提及自动识别成员姓名（PRD 2.5：@ 该看的人）
    const mentions = draft.members.filter((m) => input.body.includes(`@${m.name}`)).map((m) => m.id)
    const comment: HifoxComment = {
      id: nextId('cm'),
      taskId: task.id,
      authorId: input.authorId,
      parentId: input.parentId,
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
        pushInbox(draft, { section: 'important', kind: 'mention', title: `${authorLabel} 在 ${task.id} 提及了 ${memberName(draft, mention)}`, body: input.body.trim().slice(0, 80), taskId: task.id, recipientIds: [mention] })
      }
    }
    // 关注任务的新评论 → 其他（PRD 2.6 事件清单：关注的任务有新评论）
    if (task.followerIds.length > 0 && !task.followerIds.includes(input.authorId)) {
      pushInbox(draft, { section: 'other', kind: 'status', title: `已关注任务 ${task.id} 有新评论`, body: `${authorLabel}：${input.body.trim().slice(0, 60)}`, taskId: task.id, recipientIds: task.followerIds.filter((id) => id !== input.authorId) })
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
      next.setDate(next.getDate() + 1)
      next.setHours(9, 0, 0, 0)
      until = next.getTime()
    } else {
      const next = new Date(base)
      next.setDate(next.getDate() + 7)
      next.setHours(9, 0, 0, 0)
      until = next.getTime()
    }
    // 任务级稍后：该任务所有未清理通知一并进入稍后
    const taskId = item.taskId
    for (const other of draft.inbox) {
      if (other.id === item.id || (taskId && other.taskId === taskId && !other.cleared)) other.snoozedUntil = new Date(until).toISOString()
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
    for (const other of draft.inbox) {
      if (other.id === item.id || (item.taskId && other.taskId === item.taskId && other.cleared)) other.cleared = false
    }
    return undefined
  }).snapshot
}
