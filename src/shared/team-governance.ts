import { z } from 'zod'
import { cruxTaskStageSchema } from './crux-schema'
import { teamCommandIdSchema, teamCommandReplySchema, teamDigestSchema, teamIdSchema, teamPageInputSchema, teamPageSchema, type TeamCommandReply } from './team-platform'
import { teamTaskProgressResourceIdSchema } from './team-task-progress'
import { teamTaskMaterialKindSchema } from './team-task-materials'
import type { TaskInputBundle, TaskInputCandidates, TaskInputCommand, TaskInputRead, TaskInputReceipt, TaskInputScope, TaskInputDocumentView } from './team-task-inputs'
import type { TaskMaterialInputReference } from './task-material-inputs'
import { portableWorkflowDefinitionSchema } from './workflow/portable-definition'
import { teamTaskRefSchema } from './team-task-execution'
import { executionArtifactRefSchema } from './team-execution-artifacts'

const counter = z.number().int().nonnegative().safe()
const serial = counter.min(1)
const names = z.array(z.string().trim().min(1).max(300)).max(32)
const people = z.array(teamIdSchema).min(1).max(32).refine(ids => new Set(ids).size === ids.length, 'Duplicate person')
export const governanceIdentityShape = { instanceId: teamIdSchema, epoch: teamIdSchema, authorizationRevision: counter }
export const governanceSpaceIdSchema = teamTaskProgressResourceIdSchema
export const governanceScopeSchema = z.object({ workspaceKey: z.string().min(1).max(2048), spaceId: governanceSpaceIdSchema }).strict()
export const governanceApplicabilitySchema = z.object({ modules: names, paths: names, stages: z.array(cruxTaskStageSchema).max(11), taskTypeIds: z.array(governanceSpaceIdSchema).max(32) }).strict()
export const governanceNodeSchema = z.object({
  stage: cruxTaskStageSchema, label: z.string().trim().min(1).max(100),
  inputs: z.array(teamTaskMaterialKindSchema).max(4), outputs: z.array(teamTaskMaterialKindSchema).max(4),
  approvalRole: z.enum(['none', 'product', 'design', 'development', 'testing', 'space-owner'])
}).strict()
export const governanceSettingsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rule'), applicability: governanceApplicabilitySchema, obligation: z.enum(['required', 'recommended']), priority: z.number().int().min(0).max(1000), conflictKey: z.string().trim().max(100) }).strict(),
  z.object({ kind: z.literal('workflow-template'), preset: z.enum(['small-change', 'standard', 'custom']), execution: portableWorkflowDefinitionSchema.optional(), nodes: z.array(governanceNodeSchema).min(1).max(11).refine(nodes => new Set(nodes.map(node => node.stage)).size === nodes.length, 'Duplicate formal stage').refine(nodes => nodes.every((node, index) => index === 0 || cruxTaskStageSchema.options.indexOf(nodes[index - 1].stage) < cruxTaskStageSchema.options.indexOf(node.stage)), 'Nodes must retain the existing formal stage order') }).strict()
])
export const GOVERNANCE_PRESETS = {
  'small-change': [
    { stage: 'planning', label: '技术规划', inputs: ['prd'], outputs: ['implement'], approvalRole: 'development' },
    { stage: 'developing', label: '开发', inputs: ['prd', 'implement'], outputs: ['delivery-note'], approvalRole: 'none' },
    { stage: 'testing', label: '测试', inputs: ['delivery-note'], outputs: [], approvalRole: 'testing' },
    { stage: 'acceptance', label: '验收', inputs: ['prd', 'delivery-note'], outputs: [], approvalRole: 'testing' }
  ],
  standard: [
    { stage: 'designing', label: '设计', inputs: ['prd'], outputs: ['design'], approvalRole: 'none' },
    { stage: 'design_review', label: '设计评审', inputs: ['prd', 'design'], outputs: [], approvalRole: 'design' },
    { stage: 'planning', label: '技术规划', inputs: ['prd', 'design'], outputs: ['implement'], approvalRole: 'development' },
    { stage: 'developing', label: '开发', inputs: ['prd', 'design', 'implement'], outputs: ['delivery-note'], approvalRole: 'none' },
    { stage: 'testing', label: '测试', inputs: ['delivery-note'], outputs: [], approvalRole: 'testing' },
    { stage: 'acceptance', label: '验收', inputs: ['prd', 'delivery-note'], outputs: [], approvalRole: 'testing' }
  ]
} as const
/** Explicit engineering authoring preset; published settings keep the existing custom contract. */
export function createEngineeringImplementationPreset(): Extract<GovernanceSettings, { kind: 'workflow-template' }> {
  return governanceSettingsSchema.options[1].parse({
    kind: 'workflow-template', preset: 'custom',
    execution: portableWorkflowDefinitionSchema.parse({
      contractVersion: 2, definitionId: 'engineering-implementation', revision: 1, name: '工程实施',
      roles: [{ id: 'developer', instructions: '依据固定任务需求和工程规范完成实施，保留人工测试与验收。', requiredCapabilities: ['embeddedContext'] }],
      nodes: [{ kind: 'agent', id: 'implement', phaseId: 'engineering', stage: 'implement', name: '实施', roleId: 'developer',
        instruction: '完成原任务需求与验收条件要求的代码修改，执行适用检查，交付选定代码文件，并在实施报告中记录变更与检查结果。',
        requiredCapabilities: ['embeddedContext'], outputs: [
          { id: 'code', kind: 'selected-file', required: true },
          { id: 'report', kind: 'implementation-report', required: true }
        ] }]
    }),
    nodes: [
      { stage: 'planning', label: '技术规划', inputs: [], outputs: [], approvalRole: 'development' },
      { stage: 'developing', label: '开发', inputs: [], outputs: [], approvalRole: 'none' },
      { stage: 'testing', label: '测试', inputs: [], outputs: [], approvalRole: 'testing' },
      { stage: 'acceptance', label: '验收', inputs: [], outputs: [], approvalRole: 'testing' }
    ]
  })
}
export const governanceLessonOriginSchema = z.object({
  task: teamTaskRefSchema, artifact: executionArtifactRefSchema,
  base: z.object({ packageId: teamIdSchema, versionId: teamIdSchema, bodyDigest: teamDigestSchema, revision: serial }).strict()
}).strict()
export const governanceVersionSchema = z.object({
  packageId: teamIdSchema, versionId: teamIdSchema, number: serial, title: z.string().trim().min(1).max(300),
  bodyDigest: teamDigestSchema, byteLength: serial.max(1024 * 1024), settings: governanceSettingsSchema, authorId: teamIdSchema, createdAt: counter,
  lessonOrigin: governanceLessonOriginSchema.optional()
}).strict().refine(value => !value.lessonOrigin || value.settings.kind === 'rule', 'Only rules retain a lesson origin')
export const governancePackageSchema = z.object({
  projectId: teamIdSchema, spaceId: governanceSpaceIdSchema, packageId: teamIdSchema, kind: z.enum(['rule', 'workflow-template']),
  ownerId: teamIdSchema, maintainerIds: people, approverIds: people, revision: serial,
  status: z.enum(['draft', 'review', 'published', 'disabled']), draft: governanceVersionSchema,
  publicationActive: z.boolean(),
  submittedVersionId: teamIdSchema.nullable(), published: governanceVersionSchema.nullable(), withdrawnVersionIds: z.array(teamIdSchema).max(1000),
  publishedBy: teamIdSchema.nullable(), publishedAt: counter.nullable(), createdAt: counter, updatedAt: counter
}).strict()
const envelope = { commandId: teamCommandIdSchema, expectedEpoch: teamIdSchema, spaceId: governanceSpaceIdSchema }
const content = { title: z.string().trim().min(1).max(300), text: z.string().min(1).max(1024 * 1024), settings: governanceSettingsSchema }
const existing = { ...envelope, packageId: teamIdSchema, expectedRevision: serial }
export const governanceCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...envelope, action: z.literal('create'), maintainerIds: people, approverIds: people, ...content }).strict(),
  z.object({ ...existing, action: z.literal('saveDraft'), ...content, lessonOrigin: governanceLessonOriginSchema.optional() }).strict()
    .refine(value => !value.lessonOrigin || value.settings.kind === 'rule', 'Only a rule draft accepts a lesson origin'),
  z.object({ ...existing, action: z.literal('submit'), versionId: teamIdSchema }).strict(),
  z.object({ ...existing, action: z.literal('publish'), versionId: teamIdSchema }).strict(),
  z.object({ ...existing, action: z.literal('disable') }).strict(),
  z.object({ ...existing, action: z.literal('withdrawVersion'), versionId: teamIdSchema, reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ ...existing, action: z.literal('setAccess'), maintainerIds: people, approverIds: people }).strict()
])
export const governanceListQuerySchema = teamPageInputSchema.extend({ spaceId: governanceSpaceIdSchema }).strict()
export const governanceListSchema = z.object({ ...governanceIdentityShape, projectId: teamIdSchema, spaceId: governanceSpaceIdSchema, page: teamPageSchema(governancePackageSchema) }).strict()
export const governanceViewSchema = z.object({ ...governanceIdentityShape, package: governancePackageSchema, selected: governanceVersionSchema, text: z.string().min(1).max(1024 * 1024) }).strict()
export const governanceReceiptSchema = z.object({
  ...governanceIdentityShape, projectId: teamIdSchema, spaceId: governanceSpaceIdSchema,
  commandId: teamCommandIdSchema, action: z.enum(['create', 'saveDraft', 'submit', 'publish', 'disable', 'withdrawVersion', 'setAccess']),
  packageId: teamIdSchema, revision: serial, versionId: teamIdSchema.nullable(), actorId: teamIdSchema, deviceId: teamIdSchema.nullable(), committedAt: counter
}).strict()
export const governanceCommandReplySchema = teamCommandReplySchema(governanceReceiptSchema)
export const governanceListInputSchema = governanceScopeSchema.extend({ cursor: teamPageInputSchema.shape.cursor, limit: teamPageInputSchema.shape.limit }).strict()
export const governanceReadInputSchema = governanceScopeSchema.extend({ packageId: teamIdSchema, versionId: teamIdSchema.optional() }).strict()
export const governanceCommandInputSchema = governanceScopeSchema.extend({ command: governanceCommandSchema }).strict()
const taskIdentity = { taskId: teamTaskProgressResourceIdSchema, taskCreatedAt: z.string().min(1).max(100) }
export const governanceRecoveryScopeSchema = z.discriminatedUnion('lane', [
  governanceScopeSchema.extend({ lane: z.literal('governance') }).strict(),
  governanceScopeSchema.extend({ lane: z.literal('inputs'), ...taskIdentity }).strict()
])
export const governanceRecoveryInputSchema = z.discriminatedUnion('lane', [governanceRecoveryScopeSchema.options[0].extend({ commandId: teamCommandIdSchema }).strict(), governanceRecoveryScopeSchema.options[1].extend({ commandId: teamCommandIdSchema }).strict()])
export const governancePendingSchema = z.object({ commandId: teamCommandIdSchema, action: z.string().min(1).max(50), state: z.enum(['pending', 'unknown', 'rejected']), createdAt: counter, error: z.string().max(2000).nullable(), canRetry: z.boolean(), outcomeUnknown: z.boolean() }).strict()
export type GovernanceScope = z.infer<typeof governanceScopeSchema>
export type GovernanceSettings = z.infer<typeof governanceSettingsSchema>
export type GovernanceLessonOrigin = z.infer<typeof governanceLessonOriginSchema>
export type GovernanceVersion = z.infer<typeof governanceVersionSchema>
export type GovernancePackage = z.infer<typeof governancePackageSchema>
export type GovernanceCommand = z.infer<typeof governanceCommandSchema>
export type GovernanceReceipt = z.infer<typeof governanceReceiptSchema>
export type GovernanceRecoveryScope = z.infer<typeof governanceRecoveryScopeSchema>
export type GovernancePending = z.infer<typeof governancePendingSchema>
export type GovernanceReply<T> = { ok: true; value: T } | { ok: false; code: string; error: string; outcomeUnknown?: boolean }
export interface TeamGovernanceApi {
  readDocument(input: TaskInputScope & { reference: TaskMaterialInputReference }): Promise<GovernanceReply<TaskInputDocumentView>>
  list(input: z.input<typeof governanceListInputSchema>): Promise<GovernanceReply<z.infer<typeof governanceListSchema>>>
  read(input: z.input<typeof governanceReadInputSchema>): Promise<GovernanceReply<z.infer<typeof governanceViewSchema>>>
  command(input: z.input<typeof governanceCommandInputSchema>): Promise<GovernanceReply<z.infer<typeof governanceCommandReplySchema>>>
  inputs(input: TaskInputScope): Promise<GovernanceReply<TaskInputRead>>
  candidates(input: TaskInputScope): Promise<GovernanceReply<TaskInputCandidates>>
  adopt(input: TaskInputScope & { command: TaskInputCommand }): Promise<GovernanceReply<TeamCommandReply<TaskInputReceipt>>>
  inputRevision(input: TaskInputScope & { revision: number }): Promise<GovernanceReply<TaskInputBundle>>
  pending(input: GovernanceRecoveryScope): Promise<GovernanceReply<GovernancePending[]>>
  reconcile(input: z.infer<typeof governanceRecoveryInputSchema>): Promise<GovernanceReply<GovernanceReceipt | TaskInputReceipt | null>>
  retry(input: z.infer<typeof governanceRecoveryInputSchema>): Promise<GovernanceReply<{ status: 'committed' | 'duplicate'; commandId: string; result: GovernanceReceipt | TaskInputReceipt }>>
}
