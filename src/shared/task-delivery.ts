import { z } from 'zod'

const id = z.string().trim().min(1).max(256)
const text = z.string().trim().min(1).max(4000)
const serial = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const unique = <T>(items: T[]): boolean => new Set(items).size === items.length
const ids = z.array(id).max(100).refine(unique, 'Duplicate identity')
const stamp = { actorId: id, at: z.string().datetime() }

/** Opaque source identities, not URLs or machine paths. Authority resolves fixed bytes and ACLs. */
export const taskMaterialReferenceSchema = z.object({
  sourceKind: z.enum(['creation', 'document', 'code', 'artifact', 'check', 'data_recipe', 'dataset']),
  sourceId: id, revision: id, digest
}).strict()
const materials = z.array(taskMaterialReferenceSchema).max(40).refine(
  (items) => unique(items.map((item) => JSON.stringify(item))), 'Duplicate material reference')
export const taskAcceptanceItemSchema = z.object({ id, text }).strict()
const criteria = z.array(taskAcceptanceItemSchema).min(1).max(100).refine(
  (items) => unique(items.map((item) => item.id)), 'Duplicate acceptance item')
export const requirementBaselineInputSchema = z.object({ criteria, materials, reason: text }).strict()
export const requirementBaselineSchema = requirementBaselineInputSchema.extend({ id, taskId: id, number: serial, digest, ...stamp }).strict()
export const taskDeliveryRolesSchema = z.object({ testOwnerId: id.optional(), acceptanceOwnerId: id.optional(), productOwnerId: id.optional() }).strict()
export const adoptTaskDeliveryProtocolSchema = z.object({ version: z.literal(2), baseline: requirementBaselineInputSchema, roles: taskDeliveryRolesSchema }).strict()

export const taskTestEnvironmentSchema = z.object({
  id, revision: id, kind: z.enum(['isolated', 'staging']), deployedRevision: id, entrypoint: text, accountRole: text
}).strict()
export const taskTestDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none'), reason: text }).strict(),
  z.object({ kind: z.literal('manual'), instructions: text, cleanup: text, recipe: taskMaterialReferenceSchema.optional() }).strict(),
  z.object({ kind: z.literal('dataset'), recipe: taskMaterialReferenceSchema, dataset: taskMaterialReferenceSchema, preparationReceiptId: id, cleanup: text }).strict()
])
export const taskTestCaseSchema = z.object({
  id, criterionId: id, title: text, preconditions: text, entrypoint: text, accountRole: text, data: taskTestDataSchema,
  steps: z.array(z.object({ id, instruction: text, expectedResult: text }).strict()).min(1).max(30)
    .refine((items) => unique(items.map((item) => item.id)), 'Duplicate test step')
}).strict()
export const taskTestPackageSchema = z.object({
  scope: text, excludedScope: z.string().trim().max(4000),
  cases: z.array(taskTestCaseSchema).min(1).max(100).refine((items) => unique(items.map((item) => item.id)), 'Duplicate test case')
}).strict()
export const taskDeliveryInputSchema = z.object({
  baselineId: id,
  manifest: z.array(z.object({
    criterionId: id, implementation: z.enum(['implemented', 'not_implemented']), change: text, entrypoint: text,
    verification: z.enum(['unverified', 'evidence_attached']), evidence: materials, remainingRisk: text
  }).strict()).min(1).max(100).refine((items) => unique(items.map((item) => item.criterionId)), 'Duplicate manifest item'),
  materials, environment: taskTestEnvironmentSchema.optional(), testPackage: taskTestPackageSchema.optional(),
  completionRecord: text.optional()
}).strict()
export const taskDeliverySchema = taskDeliveryInputSchema.extend({
  id, taskId: id, number: serial, ...stamp, verification: z.enum(['pending', 'verified'])
}).strict()
export const taskTestRunInputSchema = z.object({
  deliveryId: id, baselineId: id, environment: taskTestEnvironmentSchema, summary: text,
  results: z.array(z.object({
    caseId: id,
    steps: z.array(z.object({
      stepId: id, outcome: z.enum(['passed', 'failed', 'blocked', 'skipped']), actualResult: text, evidence: materials
    }).strict()).max(30).refine((items) => unique(items.map((item) => item.stepId)), 'Duplicate step result')
  }).strict()).max(100).refine((items) => unique(items.map((item) => item.caseId)), 'Duplicate case result')
}).strict()
export const taskTestRunSchema = taskTestRunInputSchema.extend({
  id, taskId: id, ...stamp, verification: z.enum(['pending', 'verified']), readinessReceiptId: id.optional()
}).strict()

export const taskDeliveryIssueInputSchema = z.object({
  kind: z.enum(['product_question', 'defect']), baselineId: id, criterionIds: ids.min(1), title: text, assigneeId: id,
  deliveryId: id.optional(), testRunId: id.optional(), caseId: id.optional(), stepId: id.optional(),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']).optional(), priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
  blocksClosure: z.boolean(), evidence: materials
}).strict().superRefine((value, context) => {
  if (value.kind === 'defect' && (!value.deliveryId || !value.testRunId || !value.caseId || !value.stepId || !value.severity || !value.priority)) {
    context.addIssue({ code: 'custom', message: 'Defects require delivery, test run, case, step, severity and priority' })
  }
})
export const taskDeliveryIssueSchema = taskDeliveryIssueInputSchema.safeExtend({ id, taskId: id, ...stamp, verification: z.enum(['pending', 'verified']).optional() })
export const taskDeliveryIssueDecisionInputSchema = z.object({
  issueId: id, decision: z.enum(['resolved', 'waived', 'reopened']), reason: text, evidence: materials, testRunId: id.optional()
}).strict()
export const taskDeliveryIssueDecisionSchema = taskDeliveryIssueDecisionInputSchema.extend({ id, ...stamp }).strict()
export const taskClosureDecisionSchema = z.object({
  id, taskId: id, baselineId: id, deliveryId: id, testRunId: id.optional(), criterionIds: ids.min(1), gateReceiptId: id, ...stamp
}).strict()
export const taskDeliveryEventLinksSchema = z.object({
  baselineId: id.optional(), deliveryId: id.optional(), testRunId: id.optional(), closureId: id.optional(), deliveryRevision: serial.optional()
}).strict()
export const taskDeliveryStateSchema = z.object({
  version: z.literal(2), revision: serial, roles: taskDeliveryRolesSchema,
  currentBaselineId: id, approvedBaselineId: id.optional(), currentDeliveryId: id.optional(), passedTestRunId: id.optional(),
  baselines: z.array(requirementBaselineSchema).max(100), deliveries: z.array(taskDeliverySchema).max(200),
  testRuns: z.array(taskTestRunSchema).max(1000), issues: z.array(taskDeliveryIssueSchema).max(500),
  issueDecisions: z.array(taskDeliveryIssueDecisionSchema).max(2000), closures: z.array(taskClosureDecisionSchema).max(100),
  events: z.array(z.object({ id, operation: id, ...stamp, revision: serial, reason: text.optional() }).strict()).max(4000)
}).strict()

/** Every v2 write has both a task fence and a monotonic delivery ledger fence. */
const command = { taskId: id, expectedUpdatedAt: z.string(), expectedDeliveryRevision: serial }
export const recordTaskDeliveryInputSchema = z.discriminatedUnion('operation', [
  z.object({ ...command, operation: z.literal('adopt'), protocol: adoptTaskDeliveryProtocolSchema }).strict(),
  z.object({ ...command, operation: z.literal('baseline'), baseline: requirementBaselineInputSchema }).strict(),
  z.object({ ...command, operation: z.literal('roles'), roles: taskDeliveryRolesSchema, reason: text }).strict(),
  z.object({ ...command, operation: z.literal('delivery'), delivery: taskDeliveryInputSchema }).strict(),
  z.object({ ...command, operation: z.literal('test_run'), testRun: taskTestRunInputSchema }).strict(),
  z.object({ ...command, operation: z.literal('issue'), issue: taskDeliveryIssueInputSchema }).strict(),
  z.object({ ...command, operation: z.literal('issue_decision'), decision: taskDeliveryIssueDecisionInputSchema }).strict()
])

export type TaskMaterialReference = z.infer<typeof taskMaterialReferenceSchema>
export type RequirementBaseline = z.infer<typeof requirementBaselineSchema>
export type RequirementBaselineInput = z.infer<typeof requirementBaselineInputSchema>
export type TaskDeliveryRoles = z.infer<typeof taskDeliveryRolesSchema>
export type AdoptTaskDeliveryProtocol = z.infer<typeof adoptTaskDeliveryProtocolSchema>
export type TaskDelivery = z.infer<typeof taskDeliverySchema>
export type TaskDeliveryInput = z.infer<typeof taskDeliveryInputSchema>
export type TaskTestRun = z.infer<typeof taskTestRunSchema>
export type TaskTestRunInput = z.infer<typeof taskTestRunInputSchema>
export type TaskDeliveryIssueInput = z.infer<typeof taskDeliveryIssueInputSchema>
export type TaskDeliveryIssueDecisionInput = z.infer<typeof taskDeliveryIssueDecisionInputSchema>
export type TaskDeliveryState = z.infer<typeof taskDeliveryStateSchema>
export type TaskDeliveryEventLinks = z.infer<typeof taskDeliveryEventLinksSchema>
export type RecordTaskDeliveryInput = z.infer<typeof recordTaskDeliveryInputSchema>

export type TaskDeliveryAuthorityContext = {
  taskId: string; taskCreatedAt: string; spaceId: string; actorId: string; recipientIds: string[]; deliveryRevision: number
}
/** Server/main only. Read-only implementations recheck the original source/epoch and ACL inside the owned transaction.
 * Async adapters may prefetch, then expose a synchronous, revision-fenced resolver. Never deserialize these from a command.
 */
export interface TaskDeliveryDependencies {
  digestBody(body: string): string
  /** readable means every recipient can read this exact immutable revision. */
  verifyMaterial(context: TaskDeliveryAuthorityContext, reference: TaskMaterialReference): { readable: boolean; digest: string }
  /** Validate the actual isolated/staging target, deployment and all dataset preparation receipts against the fixed recipes.
   * A renderer's environment kind or preparationReceiptId is not evidence of execution or readiness.
   */
  verifyTestReadiness(context: TaskDeliveryAuthorityContext, delivery: TaskDelivery): {
    ready: boolean; receiptId: string; environmentId: string; environmentRevision: string; deployedRevision: string
  }
  /** Include source review/business blockers, design deviations and required independent code-owner review for self-fixes. */
  checkClosure(context: TaskDeliveryAuthorityContext, delivery: TaskDelivery): {
    receiptId: string; blockers: Array<{ id: string; kind: 'product_question' | 'defect' | 'review'; message: string }>
  }
}
