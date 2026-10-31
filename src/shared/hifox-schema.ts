import { z } from 'zod'
import { teamRoleSchema } from './team-platform'
import { adoptTaskDeliveryProtocolSchema, taskDeliveryEventLinksSchema, taskDeliveryInputSchema, taskDeliveryStateSchema, taskTestRunInputSchema } from './task-delivery'

export const hifoxInitialTaskTypeSchema = z.enum(['需求', 'Bug', '任务', '内容'])
export const hifoxInitialTaskTypesSchema = z.array(hifoxInitialTaskTypeSchema).min(1).max(4)
  .refine((types) => new Set(types).size === types.length, '任务类型不能重复')

// Validate persisted data before exposing it to services. Additive fields are retained.
const id = z.string().min(1)
const ids = z.array(id)
const record = z.object({ id }).passthrough()
const priority = z.enum(['urgent', 'high', 'medium', 'low', 'none'])
export const hifoxTaskWorkKindSchema = z.enum(['code', 'general'])
export const hifoxTaskStageSchema = z.enum(['accepted', 'needs_info', 'design_ready', 'designing', 'design_review', 'dev_ready', 'planning', 'developing', 'testing', 'acceptance', 'done'])
export const hifoxTaskActionSchema = z.enum(['accept', 'arrange', 'request_info', 'supplement', 'decline', 'start_design', 'submit_design', 'approve_design', 'return_design', 'begin_development', 'approve_plan', 'submit_test', 'return_development', 'pass_test', 'accept_delivery', 'return_delivery', 'submit_delivery', 'reassign'])
export const hifoxTaskWorkflowArtifactSchema = z.object({
  id, kind: z.enum(['requirements', 'design', 'plan', 'implementation', 'test', 'acceptance', 'delivery']),
  body: z.string().trim().min(1), actorId: id, at: z.string(), checkedCriteria: z.array(z.string()).optional(), deliveryLinks: taskDeliveryEventLinksSchema.optional()
}).passthrough()
export const hifoxTaskWorkflowEventSchema = z.object({
  id, action: hifoxTaskActionSchema, fromStage: hifoxTaskStageSchema, toStage: hifoxTaskStageSchema,
  actorId: id, assigneeId: id.optional(), body: z.string().optional(), at: z.string(), checkedCriteria: z.array(z.string()).optional(), deliveryLinks: taskDeliveryEventLinksSchema.optional()
}).passthrough()
export const hifoxTaskWorkflowSchema = z.object({
  stage: hifoxTaskStageSchema, handlerId: id.optional(),
  resumeStage: hifoxTaskStageSchema.optional(), resumeAssigneeId: id.optional(),
  artifacts: z.array(hifoxTaskWorkflowArtifactSchema), history: z.array(hifoxTaskWorkflowEventSchema), deliveryState: taskDeliveryStateSchema.optional()
}).passthrough()
export const hifoxTransitionTaskInputSchema = z.object({
  taskId: id, action: hifoxTaskActionSchema, body: z.string().trim().max(1024 * 1024).optional(),
  assigneeId: id.optional(), executor: z.object({ kind: z.enum(['agent', 'crew']), id, name: z.string() }).strict().nullable().optional(),
  iterationId: id.optional(), workKind: hifoxTaskWorkKindSchema.optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(10000)).max(100).optional(), expectedStage: hifoxTaskStageSchema.optional(), expectedUpdatedAt: z.string().optional(),
  nextStage: z.enum(['design_ready', 'dev_ready']).optional(), checkedCriteria: z.array(z.string().trim().min(1).max(10000)).max(100).optional(),
  adoptDeliveryProtocol: adoptTaskDeliveryProtocolSchema.optional(),
  expectedDeliveryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  delivery: taskDeliveryInputSchema.optional(), deliveryId: id.optional(), testRun: taskTestRunInputSchema.optional(), testRunId: id.optional()
}).strict().superRefine((input, context) => {
  if (input.delivery && input.deliveryId) context.addIssue({ code: 'custom', message: 'Choose a saved delivery or a new delivery, not both' })
  if (input.testRun && input.testRunId) context.addIssue({ code: 'custom', message: 'Choose a saved test run or a new test run, not both' })
  if (input.adoptDeliveryProtocol && !['arrange', 'reassign'].includes(input.action)) context.addIssue({ code: 'custom', message: 'Explicit protocol adoption requires arrange or reassign' })
  if ((input.delivery || input.deliveryId) && !['submit_test', 'submit_delivery', 'pass_test', 'return_development', 'accept_delivery', 'return_delivery'].includes(input.action)) context.addIssue({ code: 'custom', message: 'Delivery reference is not valid for this action' })
  if (input.delivery && !['submit_test', 'submit_delivery'].includes(input.action)) context.addIssue({ code: 'custom', message: 'Only submission can create a delivery' })
  if ((input.testRun || input.testRunId) && !['pass_test', 'return_development', 'accept_delivery', 'return_delivery'].includes(input.action)) context.addIssue({ code: 'custom', message: 'Test result is not valid for this action' })
  if (input.testRun && !['pass_test', 'return_development'].includes(input.action)) context.addIssue({ code: 'custom', message: 'Only test review can record a test run' })
  if (input.action !== 'reassign') return
  if (input.assigneeId === undefined && input.executor === undefined && input.adoptDeliveryProtocol === undefined) context.addIssue({ code: 'custom', message: '转交任务需选择处理人或修改执行配置' })
  for (const field of ['workKind', 'acceptanceCriteria', 'iterationId', 'nextStage', 'checkedCriteria'] as const) {
    if (input[field] !== undefined) context.addIssue({ code: 'custom', path: [field], message: '转交不能修改工作类型、验收标准、版本或阶段' })
  }
})
export const hifoxVersionDeliverySchema = z.object({
  id, spaceId: id, sourceIterationId: id, targetIterationId: id,
  kind: z.enum(['code', 'artifact']), reference: z.string().trim().min(1).max(10000),
  name: z.string().trim().min(1).max(300).optional(), revision: z.string().trim().min(1).max(1000).optional(), actorId: id, at: z.string()
}).passthrough()
export const hifoxRecordVersionDeliveryInputSchema = hifoxVersionDeliverySchema.pick({
  sourceIterationId: true, targetIterationId: true, kind: true, reference: true, name: true, revision: true
}).strict()
const milestoneFields = {
  spaceId: id, name: z.string().trim().min(1).max(300), goal: z.string().trim().min(1).max(10000),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ownerId: id,
  requiredTaskIds: ids.max(2000), requiredIterationIds: ids.max(2000),
  requiredEvidence: z.array(z.object({ taskId: id, artifactId: id }).strict()).max(2000),
  predecessorIds: ids.max(2000)
}
export const hifoxMilestoneSchema = z.object({
  id, ...milestoneFields, status: z.enum(['planned', 'completed', 'cancelled']),
  createdAt: z.string(), updatedAt: z.string(), completedAt: z.string().optional(), completedBy: id.optional()
}).passthrough()
export const hifoxSaveMilestoneInputSchema = z.object({
  ...milestoneFields, id: id.optional(), status: z.enum(['planned', 'cancelled']).optional(), expectedUpdatedAt: z.string().optional()
}).strict()
export const hifoxMilestoneCommandInputSchema = z.object({ id, expectedUpdatedAt: z.string().min(1) }).strict()
export const hifoxCrewInputSchema = z.object({
  id: id.optional(), spaceId: id, name: z.string().trim().min(1).max(300),
  description: z.string().max(1024 * 1024).optional(), instructions: z.string().max(1024 * 1024).optional(), ownerId: id.nullable().optional(),
  captainAgentId: id.optional(), captainMemberId: id.optional(),
  memberRefs: z.array(z.object({ kind: z.enum(['agent', 'member']), id }).strict()).max(1000),
  exclusiveAgentIds: ids.max(2000).optional(), archived: z.boolean().optional()
}).strict().refine((input) => Number(input.captainAgentId !== undefined) + Number(input.captainMemberId !== undefined) === 1, '请选择且仅选择一名人员或 Agent 队长')
export const hifoxSnapshotSchema = z.object({
  spaces: z.array(record.extend({ name: z.string(), key: id, description: z.string().optional(), visibility: z.enum(['public', 'private']).optional(), ownerId: id.optional(), archived: z.boolean().optional(), memberIds: ids, multiAssignee: z.boolean(), taskSeq: z.number().int().nonnegative(), createdAt: z.string() })),
  members: z.array(record.extend({ name: z.string(), email: z.string().optional(), title: z.string().optional(), role: z.enum(['owner', 'admin', 'member']), projectRoles: z.array(teamRoleSchema).min(1).max(5).optional(), avatarHue: z.number(), joinedAt: z.string() })),
  taskTypes: z.array(record.extend({ spaceId: id, name: z.string(), requiredHints: z.array(z.string()).optional(), statusIds: ids.optional(), isDefault: z.boolean().optional() })),
  taskStatuses: z.array(record.extend({ spaceId: id, name: z.string(), category: z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled']), order: z.number() })),
  taskLabels: z.array(record.extend({ spaceId: id.optional(), name: z.string(), color: z.string(), archived: z.boolean().optional() })),
  tasks: z.array(record.extend({
    spaceId: id, title: z.string(), description: z.string().optional(), typeId: id.optional(), statusId: id,
    priority, assigneeIds: ids, creatorId: id, labelIds: ids, projectId: id.optional(), iterationIds: ids,
    parentTaskId: id.optional(), followerIds: ids,
    executor: z.object({ kind: z.enum(['agent', 'crew']), id, name: z.string() }).optional(),
    dispatch: z.object({ status: z.enum(['queued', 'waiting_runtime']), since: z.string(), note: z.string().optional() }).optional(),
    relations: z.array(z.object({ kind: z.enum(['blocks', 'related', 'duplicate']), taskId: id })),
    createdAt: z.string(), updatedAt: z.string(), completedAt: z.string().optional(), triagePending: z.boolean().optional(),
    workKind: hifoxTaskWorkKindSchema.optional(), acceptanceCriteria: z.array(z.string()).optional(), workflow: hifoxTaskWorkflowSchema.optional()
  })),
  comments: z.array(record.extend({ taskId: id, authorId: id, body: z.string(), mentions: ids, createdAt: z.string(), parentId: id.optional(), resolved: z.boolean().optional() })),
  activities: z.array(record.extend({ taskId: id, kind: z.string(), text: z.string(), at: z.string() })),
  projects: z.array(record.extend({ spaceId: id, name: z.string(), goal: z.string().optional(), ownerIds: ids, status: z.enum(['active', 'done', 'archived']), createdAt: z.string() })),
  iterations: z.array(record.extend({ spaceId: id, name: z.string(), goal: z.string().optional(), startDate: z.string(), endDate: z.string(), status: z.enum(['pending', 'active', 'completed']), taskIds: ids, predecessorId: id.optional() })),
  versionDeliveries: z.array(hifoxVersionDeliverySchema).default([]),
  milestones: z.array(hifoxMilestoneSchema).optional(),
  views: z.array(record.extend({
    spaceId: id, name: z.string(), groupBy: z.enum(['status', 'assignee', 'type', 'priority']), pinned: z.boolean().optional(),
    filter: z.object({ keyword: z.string().optional(), statusIds: ids.optional(), typeIds: ids.optional(), labelIds: ids.optional(), assigneeIds: ids.optional(), priorities: z.array(priority).optional(), iterationId: id.optional(), projectId: id.optional() }).passthrough()
  })),
  triageDecisions: z.array(z.object({ taskId: id, disposition: z.enum(['assign', 'iterate', 'park', 'close']), at: z.string(), actorId: id.optional(), note: z.string().optional() }).passthrough()),
  automations: z.array(record.extend({
    spaceId: id, name: z.string(), creatorId: id.optional(), enabled: z.boolean(), instruction: z.string().optional(), projectId: id.optional(),
    lastScheduledDate: z.string().optional(), lastRunAt: z.string().optional(),
    trigger: z.object({ kind: z.enum(['schedule', 'task_status', 'task_created', 'comment']), value: z.string().optional(), days: z.array(z.number().int().min(1).max(7)).optional() }),
    target: z.object({ kind: z.enum(['agent', 'crew', 'member', 'none']), id: id.optional(), name: z.string().optional() }),
    runs: z.array(record.extend({ at: z.string(), trigger: z.string(), outcome: z.enum(['done', 'waiting_runtime', 'skipped']), detail: z.string().optional() }))
  })),
  inbox: z.array(record.extend({ section: z.enum(['important', 'other']), kind: z.enum(['assign', 'mention', 'status', 'dispatch', 'automation', 'triage']), title: z.string(), body: z.string().optional(), taskId: id.optional(), spaceId: id.optional(), at: z.string(), read: z.boolean(), recipientIds: ids.optional(), snoozedUntil: z.string().optional(), cleared: z.boolean().optional() })),
  agents: z.array(record.extend({ spaceId: id, name: z.string(), description: z.string().optional(), instructions: z.string(), skillIds: ids, repositories: z.array(z.object({ name: z.string(), url: z.string().optional() })), runtimeKind: z.enum(['claude-code', 'codex', 'custom']), workingDirectory: z.enum(['repo', 'temp']), enabled: z.boolean(), archived: z.boolean().optional(), exclusiveCrewId: id.optional(), createdAt: z.string() })),
  skills: z.array(record.extend({ spaceId: id.optional(), name: z.string(), description: z.string().optional(), content: z.string(), createdAt: z.string() })),
  crews: z.array(record.extend({ spaceId: id, name: z.string(), description: z.string().optional(), instructions: z.string().optional(), ownerId: id.optional(), archived: z.boolean().optional(), captain: z.object({ kind: z.enum(['agent', 'member']), id, name: z.string() }), members: z.array(z.object({ kind: z.enum(['agent', 'member']), id, name: z.string() })), createdAt: z.string() }))
}).passthrough()
