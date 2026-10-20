/** Clean-room platform contracts. No third-party implementation is copied here. */
import { z } from 'zod'

export const WORKFLOW_CONTRACT_VERSION = 1 as const
export const workflowIdSchema = z.string().min(1).max(512).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), 'Identity must not have surrounding whitespace or control characters')
export const workflowRevisionSchema = z.number().int().positive().safe()
export const workflowTimestampSchema = z.number().int().nonnegative().safe()
export const workflowDigestSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a full SHA-256 digest')
export const workflowJsonSchema = z.json()
export type WorkflowJson = z.infer<typeof workflowJsonSchema>

export const projectRefSchema = z.object({ projectId: workflowIdSchema }).strict()
export const jiraIssueRefSchema = z.object({ instanceId: workflowIdSchema, issueId: workflowIdSchema }).strict()
export const jiraVersionRefSchema = z.object({ instanceId: workflowIdSchema, versionId: workflowIdSchema }).strict()
export const localTaskRefSchema = z.object({ repositoryId: workflowIdSchema, workspaceId: workflowIdSchema, taskRef: workflowIdSchema }).strict()
export const workflowScopeSchema = localTaskRefSchema.extend({ projectId: workflowIdSchema }).strict()
export const definitionRefSchema = z.object({ definitionId: workflowIdSchema, revision: workflowRevisionSchema }).strict()
export const versionedAssetRefSchema = z.object({ assetId: workflowIdSchema, version: workflowIdSchema, digest: workflowDigestSchema }).strict()
export const runRefSchema = z.object({ runId: workflowIdSchema, revision: workflowRevisionSchema }).strict()
export const stepRefSchema = runRefSchema.extend({ nodeId: z.string().min(1).max(4096), attempt: workflowRevisionSchema }).strict()

export type ProjectRef = z.infer<typeof projectRefSchema>
export type JiraIssueRef = z.infer<typeof jiraIssueRefSchema>
export type JiraVersionRef = z.infer<typeof jiraVersionRefSchema>
export type LocalTaskRef = z.infer<typeof localTaskRefSchema>
export type WorkflowScope = z.infer<typeof workflowScopeSchema>
export type DefinitionRef = z.infer<typeof definitionRefSchema>
export type VersionedAssetRef = z.infer<typeof versionedAssetRefSchema>
export type RunRef = z.infer<typeof runRefSchema>
export type StepRef = z.infer<typeof stepRefSchema>

/** JSON tuples avoid delimiter collisions; IDs are opaque, not display labels or paths. */
export function jiraIssueIdentity(ref: JiraIssueRef): string {
  const value = jiraIssueRefSchema.parse(ref)
  return JSON.stringify(['jira-issue', value.instanceId, value.issueId])
}

export function localTaskIdentity(ref: LocalTaskRef): string {
  const value = localTaskRefSchema.parse(ref)
  return JSON.stringify(['local-task', value.repositoryId, value.workspaceId, value.taskRef])
}

export function workflowScopeIdentity(ref: WorkflowScope): string {
  const value = workflowScopeSchema.parse(ref)
  return JSON.stringify(['scope', value.projectId, value.repositoryId, value.workspaceId, value.taskRef])
}

export function workflowNodeIdentity(ref: DefinitionRef, phaseId: string, stepId: string): string {
  const value = definitionRefSchema.parse(ref)
  return JSON.stringify(['workflow-node', value.definitionId, value.revision, workflowIdSchema.parse(phaseId), workflowIdSchema.parse(stepId)])
}

export function stepInstanceIdentity(scope: WorkflowScope, step: StepRef): string {
  const value = stepRefSchema.parse(step)
  return JSON.stringify(['step-instance', workflowScopeIdentity(scope), value.runId, value.revision, value.nodeId, value.attempt])
}

export const issueLinkSchema = z.object({
  projectId: workflowIdSchema,
  issue: jiraIssueRefSchema,
  issueKey: workflowIdSchema.optional(),
  remoteStatus: z.string(),
  remoteUpdatedAt: workflowTimestampSchema.nullable(),
  versions: z.array(jiraVersionRefSchema)
}).strict().superRefine((value, context) => {
  const seen = new Set<string>()
  value.versions.forEach((version, index) => {
    if (version.instanceId !== value.issue.instanceId) context.addIssue({ code: 'custom', path: ['versions', index], message: 'Jira version belongs to another instance' })
    if (seen.has(version.versionId)) context.addIssue({ code: 'custom', path: ['versions', index], message: 'Duplicate Jira version identity' })
    seen.add(version.versionId)
  })
})

export const localTaskBindingSchema = z.object({
  projectId: workflowIdSchema,
  issue: jiraIssueRefSchema,
  localTask: localTaskRefSchema,
  localStatus: z.string(),
  archived: z.boolean(),
  requiredForDelivery: z.boolean()
}).strict()

export const workCatalogSchema = z.object({
  contractVersion: z.literal(WORKFLOW_CONTRACT_VERSION),
  project: projectRefSchema,
  issues: z.array(issueLinkSchema),
  bindings: z.array(localTaskBindingSchema),
  requirementLinks: z.array(z.object({ requirement: versionedAssetRefSchema, issue: jiraIssueRefSchema }).strict()).optional()
}).strict().superRefine((value, context) => {
  const issues = new Set<string>()
  value.issues.forEach((issue, index) => {
    const key = jiraIssueIdentity(issue.issue)
    if (issue.projectId !== value.project.projectId) context.addIssue({ code: 'custom', path: ['issues', index], message: 'Issue project scope mismatch' })
    if (issues.has(key)) context.addIssue({ code: 'custom', path: ['issues', index], message: 'Duplicate scoped issue identity' })
    issues.add(key)
  })
  const bindings = new Set<string>()
  value.bindings.forEach((binding, index) => {
    const issueKey = jiraIssueIdentity(binding.issue)
    const key = JSON.stringify([issueKey, localTaskIdentity(binding.localTask)])
    if (binding.projectId !== value.project.projectId || !issues.has(issueKey)) context.addIssue({ code: 'custom', path: ['bindings', index], message: 'Binding has an unknown or foreign issue scope' })
    if (bindings.has(key)) context.addIssue({ code: 'custom', path: ['bindings', index], message: 'Duplicate issue/task binding' })
    bindings.add(key)
  })
  const requirementLinks = new Set<string>()
  const requirementDigests = new Map<string, string>()
  value.requirementLinks?.forEach((link, index) => {
    const key = JSON.stringify([link.requirement.assetId, link.requirement.version, jiraIssueIdentity(link.issue)])
    if (!issues.has(jiraIssueIdentity(link.issue)) || requirementLinks.has(key)) context.addIssue({ code: 'custom', path: ['requirementLinks', index], message: 'Unknown issue or duplicate requirement link' })
    requirementLinks.add(key)
    const versionKey = JSON.stringify([link.requirement.assetId, link.requirement.version]); const previous = requirementDigests.get(versionKey)
    if (previous !== undefined && previous !== link.requirement.digest) context.addIssue({ code: 'custom', path: ['requirementLinks', index], message: 'Conflicting immutable requirement version digest' })
    requirementDigests.set(versionKey, link.requirement.digest)
  })
})
export type WorkCatalog = z.infer<typeof workCatalogSchema>

export const versionScopeSchema = z.object({
  project: projectRefSchema,
  version: jiraVersionRefSchema,
  branches: z.array(z.object({ repositoryId: workflowIdSchema, branchRef: workflowIdSchema }).strict()),
  issues: z.array(jiraIssueRefSchema),
  query: z.string().min(1),
  queriedAt: workflowTimestampSchema,
  sourceTotal: z.number().int().nonnegative().safe().nullable(),
  complete: z.boolean()
}).strict().superRefine((value, context) => {
  const ids = new Set<string>()
  value.issues.forEach((issue, index) => {
    const identity = jiraIssueIdentity(issue)
    if (issue.instanceId !== value.version.instanceId || ids.has(identity)) context.addIssue({ code: 'custom', path: ['issues', index], message: 'Foreign or duplicate version issue identity' })
    ids.add(identity)
  })
  if (value.complete && value.sourceTotal !== value.issues.length) context.addIssue({ code: 'custom', path: ['complete'], message: 'A complete version scope needs a matching known source total' })
})
export type VersionScope = z.infer<typeof versionScopeSchema>
