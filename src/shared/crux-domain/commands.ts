import { z } from 'zod'
import { cruxConversationLinkSchema, cruxFeishuSourceSchema, cruxTaskOutputReviewPatchSchema, cruxTaskSharedMaterialSchema } from '../crux-schema'
import { taskSourceFiles } from '../task-source-files'
import type { CruxSnapshot, CruxSpace } from '../crux'
import { withCruxDomainSnapshot } from './store'
import * as core from './core'
import * as planning from './planning'
import * as agents from './agents'
import * as workflow from './workflow'
import { recordTaskDelivery } from './task-delivery'
import { recordTaskDeliveryInputSchema, type TaskDeliveryDependencies } from '../task-delivery'
import { cruxTaskHandoffSchema, cruxCrewInputSchema, cruxTaskWorkKindSchema, cruxTransitionTaskInputSchema, cruxRecordVersionDeliveryInputSchema, cruxSaveMilestoneInputSchema, cruxMilestoneCommandInputSchema, cruxInitialTaskTypesSchema } from '../crux-schema'

const id = z.string().min(1).max(256)
const ids = z.array(id).max(2000)
const name = z.string().trim().min(1).max(300)
const text = z.string().max(1024 * 1024)
const role = z.enum(['owner', 'admin', 'member'])
const priority = z.enum(['urgent', 'high', 'medium', 'low', 'none'])
const category = z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'])
const executor = z.object({ kind: z.enum(['agent', 'crew']), id, name }).strict()
const filter = z.object({ keyword: z.string().max(2000).optional(), statusIds: ids.optional(), typeIds: ids.optional(), labelIds: ids.optional(), assigneeIds: ids.optional(), priorities: z.array(priority).optional(), iterationId: id.optional(), projectId: id.optional() }).strict()
const taskFields = { title: name.optional(), description: text.optional(), typeId: id.nullable().optional(), statusId: id.optional(), priority: priority.optional(), assigneeIds: ids.optional(), executor: executor.nullable().optional(), labelIds: ids.optional(), projectId: id.nullable().optional(), iterationIds: ids.optional(), parentTaskId: id.nullable().optional(), workKind: cruxTaskWorkKindSchema.optional(), acceptanceCriteria: cruxTransitionTaskInputSchema.shape.acceptanceCriteria }
const taskPatch = z.object({ ...taskFields, expectedTitle: text.optional(), expectedPostDescription: text.optional(), expectedDescription: text.optional(), followerToggle: id.optional(), bindConversation: cruxConversationLinkSchema.optional(),
  clarification: z.object({ commentId: id, action: z.enum(['confirm', 'withdraw']), expectedCount: z.number().int().nonnegative(), reason: z.string().trim().max(500).optional() }).strict().optional(),
  sharedMaterial: cruxTaskSharedMaterialSchema.optional(), outputReview: cruxTaskOutputReviewPatchSchema.optional()
}).strict()
const agentFields = { spaceId: id, name, description: text.optional(), instructions: text.min(1), skillIds: ids.optional(), repositories: z.array(z.object({ name, url: z.string().max(2048).optional() }).strict()).max(128).optional(), runtimeKind: z.enum(['claude-code', 'codex', 'custom']).optional(), workingDirectory: z.enum(['repo', 'temp']).optional(), enabled: z.boolean().optional(), archived: z.boolean().optional() }
const inboxSelection = { ids: ids.optional(), all: z.boolean().optional(), section: z.enum(['important', 'other']).optional() }

export const cruxMutationInputSchemas = {
  createSpace: z.object({ name, key: name, description: text.optional(), visibility: z.enum(['public', 'private']).optional(), initialTaskTypes: cruxInitialTaskTypesSchema.optional() }).strict(),
  updateSpace: z.object({ id, name: name.optional(), description: text.optional(), multiAssignee: z.boolean().optional(), visibility: z.enum(['public', 'private']).optional(), archived: z.boolean().optional() }).strict(),
  joinSpace: z.object({ spaceId: id, memberId: id.optional() }).strict(),
  inviteMember: z.object({ name, email: z.string().max(320).optional(), title: text.optional(), role: role.optional(), spaceId: id.optional() }).strict(),
  updateMember: z.object({ id, name: name.optional(), email: z.string().max(320).optional(), title: text.optional(), role: role.optional() }).strict(),
  removeMember: z.object({ id }).strict(),
  setSpaceMembers: z.object({ spaceId: id, memberIds: ids }).strict(),
  createTaskType: z.object({ spaceId: id, name, requiredHints: z.array(z.string().max(2000)).max(50).optional(), statusIds: ids.optional() }).strict(),
  updateTaskType: z.object({ id, name: name.optional(), statusIds: ids.optional() }).strict(),
  removeTaskType: z.object({ id }).strict(),
  createTaskStatus: z.object({ spaceId: id, name, category }).strict(),
  removeTaskStatus: z.object({ id }).strict(),
  createLabel: z.object({ spaceId: id.optional(), name, color: z.string().max(100).optional() }).strict(),
  archiveLabel: z.object({ id }).strict(),
  createTask: z.object({ ...taskFields, spaceId: id, title: name, creatorId: id.optional(), typeId: id.optional(), triagePending: z.boolean().optional(), lightweightSource: z.literal('conversation').optional(), handoff: cruxTaskHandoffSchema.optional(), bindConversation: cruxConversationLinkSchema.optional(), feishuSource: cruxFeishuSourceSchema.optional() }).strict(),
  updateTask: z.object({ id, patch: taskPatch }).strict(),
  restoreLightweightTask: z.object({ taskId: id, expectedUpdatedAt: z.string().min(1), statusId: id.optional(), assigneeIds: ids.max(2000).optional() }).strict(),
  transitionTask: cruxTransitionTaskInputSchema,
  recordTaskDelivery: recordTaskDeliveryInputSchema,
  removeTask: z.object({ id }).strict(),
  addRelation: z.object({ taskId: id, relation: z.object({ kind: z.enum(['blocks', 'related', 'duplicate']), taskId: id }).strict() }).strict(),
  removeRelation: z.object({ taskId: id, targetTaskId: id }).strict(),
  addComment: z.object({ taskId: id, body: text.min(1), authorId: id, parentId: id.optional(), sourceId: z.string().uuid().optional(), sourceFiles: taskSourceFiles.optional() }).strict(),
  resolveComment: z.object({ id, resolved: z.boolean() }).strict(),
  createProject: z.object({ spaceId: id, name, goal: text.optional(), ownerIds: ids.optional() }).strict(),
  updateProject: z.object({ id, name: name.optional(), goal: text.optional(), ownerIds: ids.optional(), status: z.enum(['active', 'done', 'archived']).optional() }).strict(),
  createIteration: z.object({ spaceId: id, name, goal: text.optional(), startDate: z.string().max(10), endDate: z.string().max(10), taskIds: ids.optional(), predecessorId: id.optional() }).strict(),
  updateIteration: z.object({ id, name: name.optional(), goal: text.optional(), startDate: z.string().max(10).optional(), endDate: z.string().max(10).optional(), taskIds: ids.optional(), status: z.enum(['pending', 'active', 'completed']).optional(), predecessorId: id.nullable().optional() }).strict(),
  completeIteration: z.object({ id, carryOver: z.enum(['backlog', 'next']).optional() }).strict(),
  recordVersionDelivery: cruxRecordVersionDeliveryInputSchema,
  saveMilestone: cruxSaveMilestoneInputSchema,
  completeMilestone: cruxMilestoneCommandInputSchema,
  removeMilestone: cruxMilestoneCommandInputSchema,
  saveView: z.object({ id: id.optional(), spaceId: id, name, filter, groupBy: z.enum(['status', 'assignee', 'type', 'priority']) }).strict(),
  removeView: z.object({ id }).strict(),
  triage: z.object({ taskId: id, disposition: z.enum(['assign', 'iterate', 'park', 'close']), assigneeIds: ids.optional(), iterationId: id.optional(), actorId: id.optional(), note: text.optional(), expectedUpdatedAt: z.string().min(1).optional() }).strict(),
  saveAutomation: z.object({ id: id.optional(), spaceId: id, name, enabled: z.boolean().optional(), trigger: z.object({ kind: z.enum(['schedule', 'task_status', 'task_created', 'comment']), value: z.string().max(2000).optional(), days: z.array(z.number().int().min(1).max(7)).max(7).optional() }).strict(), target: z.object({ kind: z.enum(['agent', 'crew', 'member', 'none']), id: id.optional(), name: name.optional() }).strict(), instruction: text.optional(), projectId: id.optional() }).strict(),
  toggleAutomation: z.object({ id, enabled: z.boolean() }).strict(),
  removeAutomation: z.object({ id }).strict(),
  runAutomation: z.object({ id }).strict(),
  markInboxRead: z.object(inboxSelection).strict(),
  snoozeInbox: z.object({ id, option: z.enum(['20m', '2h', 'tomorrow', 'nextweek']) }).strict(),
  clearInbox: z.object(inboxSelection).strict(),
  restoreInbox: z.object({ id }).strict(),
  saveAgent: z.object({ id: id.optional(), ...agentFields }).strict(),
  removeAgent: z.object({ id }).strict(),
  saveSkill: z.object({ id: id.optional(), spaceId: id.optional(), name, description: text.optional(), content: text.min(1) }).strict(),
  removeSkill: z.object({ id }).strict(),
  saveCrew: cruxCrewInputSchema,
  removeCrew: z.object({ id }).strict()
} as const

export type CruxMutationName = keyof typeof cruxMutationInputSchemas
export const cruxMutationNames = Object.keys(cruxMutationInputSchemas) as [CruxMutationName, ...CruxMutationName[]]
export const cruxMutationNameSchema = z.enum(cruxMutationNames)

const mutations = {
  createSpace: core.createSpace, updateSpace: core.updateSpace, joinSpace: core.joinSpace,
  inviteMember: core.inviteMember, updateMember: core.updateMember, removeMember: core.removeMember, setSpaceMembers: core.setSpaceMembers,
  createTaskType: core.createTaskType, updateTaskType: core.updateTaskType, removeTaskType: core.removeTaskType,
  createTaskStatus: core.createTaskStatus, removeTaskStatus: core.removeTaskStatus, createLabel: core.createLabel, archiveLabel: core.archiveLabel,
  createTask: core.createTask, updateTask: core.updateTask, restoreLightweightTask: core.restoreLightweightTask, transitionTask: workflow.transitionTask, recordTaskDelivery, removeTask: core.removeTask, addRelation: core.addRelation, removeRelation: core.removeRelation,
  addComment: core.addComment, resolveComment: core.resolveComment,
  createProject: planning.createProject, updateProject: planning.updateProject,
  createIteration: planning.createIteration, updateIteration: planning.updateIteration, completeIteration: planning.completeIteration, recordVersionDelivery: planning.recordVersionDelivery,
  saveMilestone: planning.saveMilestone, completeMilestone: planning.completeMilestone, removeMilestone: planning.removeMilestone,
  saveView: planning.saveView, removeView: planning.removeView, triage: planning.triage,
  saveAutomation: planning.saveAutomation, toggleAutomation: planning.toggleAutomation, removeAutomation: planning.removeAutomation, runAutomation: planning.runAutomation,
  markInboxRead: core.markInboxRead, snoozeInbox: core.snoozeInbox, clearInbox: core.clearInbox, restoreInbox: core.restoreInbox,
  saveAgent: agents.saveAgent, removeAgent: agents.removeAgent, saveSkill: agents.saveSkill, removeSkill: agents.removeSkill, saveCrew: agents.saveCrew, removeCrew: agents.removeCrew
} satisfies Record<CruxMutationName, unknown>

export class CruxSpaceAccessError extends core.CruxError {}

export function canReadCruxSpace(space: CruxSpace, actorId: string): boolean {
  return space.visibility !== 'private' || space.memberIds.includes(actorId)
}

const scopedCollections = ['taskTypes', 'taskStatuses', 'taskLabels', 'tasks', 'projects', 'iterations', 'versionDeliveries', 'milestones', 'views', 'automations', 'agents', 'skills', 'crews'] as const
type ScopedCollection = typeof scopedCollections[number]
const targetCollections: Partial<Record<CruxMutationName, ScopedCollection | 'spaces' | 'comments'>> = {
  updateSpace: 'spaces', updateTaskType: 'taskTypes', removeTaskType: 'taskTypes', removeTaskStatus: 'taskStatuses', archiveLabel: 'taskLabels',
  updateTask: 'tasks', restoreLightweightTask: 'tasks', removeTask: 'tasks', resolveComment: 'comments', updateProject: 'projects', updateIteration: 'iterations', completeIteration: 'iterations', removeView: 'views',
  saveMilestone: 'milestones', completeMilestone: 'milestones', removeMilestone: 'milestones',
  saveAutomation: 'automations', toggleAutomation: 'automations', removeAutomation: 'automations', runAutomation: 'automations',
  saveAgent: 'agents', removeAgent: 'agents', saveSkill: 'skills', removeSkill: 'skills', saveCrew: 'crews', removeCrew: 'crews'
}
const referenceCollections: Record<string, ScopedCollection | 'comments'> = {
  taskId: 'tasks', taskIds: 'tasks', targetTaskId: 'tasks', parentTaskId: 'tasks', parentId: 'comments',
  typeId: 'taskTypes', typeIds: 'taskTypes', statusId: 'taskStatuses', statusIds: 'taskStatuses', labelIds: 'taskLabels',
  projectId: 'projects', iterationId: 'iterations', iterationIds: 'iterations', predecessorId: 'iterations', sourceIterationId: 'iterations', targetIterationId: 'iterations', skillIds: 'skills', captainAgentId: 'agents', exclusiveAgentIds: 'agents'
  , requiredTaskIds: 'tasks', requiredIterationIds: 'iterations', predecessorIds: 'milestones'
}

function spaceGate(snapshot: CruxSnapshot, actorId?: string): (spaceId: string, metadata?: boolean, restoring?: boolean) => void {
  const actor = actorId ? snapshot.members.find((member) => member.id === actorId) : undefined
  if (actorId && !actor) throw new CruxSpaceAccessError('当前成员没有空间访问权限')
  return (spaceId, metadata = false, restoring = false) => {
    const space = snapshot.spaces.find((entry) => entry.id === spaceId)
    if (!space || (actorId && !canReadCruxSpace(space, actorId) && !(metadata && actor?.role !== 'member'))) throw new CruxSpaceAccessError('空间不存在或当前成员没有访问权限')
    if (space.archived && !restoring) throw new core.CruxError('空间已停用，请先恢复空间')
  }
}

/** Resolve both existing objects and supplied references before the domain can inspect or change them. */
export function assertCruxSpaceMutation(snapshot: CruxSnapshot, operation: CruxMutationName, raw: unknown, actorId?: string): void {
  const input = cruxMutationInputSchemas[operation].parse(raw) as Record<string, unknown>
  const gate = spaceGate(snapshot, actorId)
  const checkRecord = (collection: ScopedCollection | 'comments', id: string): void => {
    const record = (snapshot[collection] ?? []).find((entry) => entry.id === id)
    if (!record) return // The owning domain reports missing references.
    if ('spaceId' in record && record.spaceId) gate(record.spaceId)
    if ('taskId' in record && typeof record.taskId === 'string') checkRecord('tasks', record.taskId)
  }
  const collection = targetCollections[operation]
  if (collection && typeof input.id === 'string') {
    if (collection === 'spaces') gate(input.id, true, input.archived === false && Object.keys(input).every((key) => key === 'id' || key === 'archived'))
    else checkRecord(collection, input.id)
  }
  if (typeof input.spaceId === 'string') gate(input.spaceId)
  if (operation === 'setSpaceMembers' && actorId) {
    const space = snapshot.spaces.find((entry) => entry.id === input.spaceId)
    const actor = snapshot.members.find((member) => member.id === actorId)
    if (space && !space.memberIds.includes(actorId) && (space.visibility === 'private' || actor?.role === 'member')) throw new CruxSpaceAccessError('需要已有空间成员管理成员列表')
  }
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return }
    const fields = value as Record<string, unknown>
    if (typeof fields.id === 'string' && (fields.kind === 'agent' || fields.kind === 'crew')) checkRecord(fields.kind === 'agent' ? 'agents' : 'crews', fields.id)
    for (const [key, child] of Object.entries(fields)) {
      const references = referenceCollections[key]
      if (references) for (const ref of Array.isArray(child) ? child : [child]) if (typeof ref === 'string') checkRecord(references, ref)
      visit(child)
    }
  }
  visit(input)
  if (operation === 'addRelation') {
    const relation = cruxMutationInputSchemas.addRelation.parse(raw)
    if (relation.relation.kind === 'blocks') {
      const pending = [relation.relation.taskId]
      const seen = new Set<string>()
      while (pending.length) {
        const id = pending.pop()
        if (!id) continue
        if (id === relation.taskId) throw new core.CruxError('任务阻塞依赖不能形成循环')
        if (seen.has(id)) continue
        seen.add(id)
        for (const target of snapshot.tasks.find((task) => task.id === id)?.relations ?? []) if (target.kind === 'blocks') pending.push(target.taskId)
      }
    }
  }
}

/** Catch reciprocal links and global-object cleanup that would write a second inaccessible or archived space. */
function assertChangedSpaces(before: CruxSnapshot, after: CruxSnapshot, operation: CruxMutationName, raw: unknown, actorId?: string): void {
  const gate = spaceGate(before, actorId)
  const spaceUpdate = operation === 'updateSpace' ? cruxMutationInputSchemas.updateSpace.parse(raw) : undefined
  const changed = <T extends { id: string }>(previous: T[], next: T[], check: (record: T) => void): void => {
    const old = new Map(previous.map((entry) => [entry.id, entry]))
    for (const record of next) {
      const original = old.get(record.id)
      if (JSON.stringify(original) !== JSON.stringify(record)) { if (original) check(original); check(record) }
      old.delete(record.id)
    }
    for (const record of old.values()) check(record)
  }
  for (const collection of scopedCollections) changed<{ id: string; spaceId?: string }>(before[collection] ?? [], after[collection] ?? [], (record) => {
    if (record.spaceId && before.spaces.some((space) => space.id === record.spaceId)) gate(record.spaceId, spaceUpdate?.id === record.spaceId && spaceUpdate.archived === true)
  })
  for (const collection of ['comments', 'activities'] as const) changed<{ id: string; taskId: string }>(before[collection], after[collection], (record) => {
    const task = before.tasks.find((entry) => entry.id === record.taskId) ?? after.tasks.find((entry) => entry.id === record.taskId)
    if (task && before.spaces.some((space) => space.id === task.spaceId)) gate(task.spaceId)
  })
  if (operation !== 'updateSpace') changed(before.spaces, after.spaces, (space) => {
    if (before.spaces.some((entry) => entry.id === space.id)) gate(space.id)
  })
}

export function executeCruxDomain(snapshot: CruxSnapshot, operation: CruxMutationName, raw: unknown, actorId?: string, deliveryDependencies?: TaskDeliveryDependencies): { snapshot: CruxSnapshot; taskId?: string } {
  let input: unknown = cruxMutationInputSchemas[operation].parse(raw)
  if (operation === 'transitionTask' || operation === 'recordVersionDelivery' || operation === 'recordTaskDelivery' || operation === 'saveMilestone' || operation === 'completeMilestone' || operation === 'removeMilestone') {
    actorId ??= snapshot.members.find((member) => member.id === 'local-owner' && member.role === 'owner')?.id
    if (!actorId) throw new CruxSpaceAccessError('交接与交付记录需要已验证的当前成员身份')
  }
  assertCruxSpaceMutation(snapshot, operation, input, actorId)
  if (operation === 'updateTask') {
    const parsed = cruxMutationInputSchemas.updateTask.parse(input)
    if (parsed.patch.acceptanceCriteria !== undefined) {
      if (!actorId) throw new CruxSpaceAccessError('编辑分拣验收标准需要已验证的当前成员身份')
      const task = snapshot.tasks.find((entry) => entry.id === parsed.id)
      if (task && task.creatorId !== actorId && !workflow.isCruxTriageManager(snapshot, task.spaceId, actorId)) throw new CruxSpaceAccessError('只有创建人或本空间分拣管理员可以编辑分拣验收标准')
    }
  }
  if (operation === 'triage' && actorId) {
    const parsed = cruxMutationInputSchemas.triage.parse(input)
    const task = snapshot.tasks.find((entry) => entry.id === parsed.taskId)
    if (task && task.creatorId !== actorId && task.assigneeIds[0] !== actorId && !workflow.isCruxTriageManager(snapshot, task.spaceId, actorId)) throw new CruxSpaceAccessError('只有创建人、当前处理人或本空间分拣管理员可以分拣任务')
  }
  if (actorId) {
    if (operation === 'createSpace') input = { ...cruxMutationInputSchemas.createSpace.parse(input), actorId }
    if (operation === 'joinSpace') input = { ...cruxMutationInputSchemas.joinSpace.parse(input), memberId: actorId }
    if (operation === 'createTask') {
      const parsed = cruxMutationInputSchemas.createTask.parse(input)
      if (parsed.handoff?.material) throw new CruxSpaceAccessError('材料版本只能由团队材料保存回执关联')
      input = { ...parsed, creatorId: actorId }
    }
    if (operation === 'addComment') input = { ...cruxMutationInputSchemas.addComment.parse(input), authorId: actorId }
    if (operation === 'triage') input = { ...cruxMutationInputSchemas.triage.parse(input), actorId }
    if (operation === 'updateTask') {
      const parsed = cruxMutationInputSchemas.updateTask.parse(input)
      if (parsed.patch.followerToggle !== undefined) parsed.patch.followerToggle = actorId
      input = parsed
    }
  }
  const execute = mutations[operation] as (input: never, actorId?: string, dependencies?: TaskDeliveryDependencies) => unknown
  const result = withCruxDomainSnapshot(snapshot, () => execute(input as never, actorId, deliveryDependencies))
  assertChangedSpaces(snapshot, result.snapshot, operation, raw, actorId)
  if (actorId && operation === 'saveAutomation') {
    const input = cruxMutationInputSchemas.saveAutomation.parse(raw)
    const previous = new Set(snapshot.automations.map((rule) => rule.id))
    for (const rule of result.snapshot.automations) if (rule.id === input.id || !previous.has(rule.id)) rule.creatorId ??= actorId
  }
  const taskId = operation === 'createTask' && result.result && typeof result.result === 'object' && 'taskId' in result.result && typeof result.result.taskId === 'string' ? result.result.taskId : undefined
  return { snapshot: result.snapshot, ...(taskId ? { taskId } : {}) }
}
