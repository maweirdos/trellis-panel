/** Additive, clean-room facts/contracts. Validation does not grant authorization. */
import { z } from 'zod'
import {
  WORKFLOW_CONTRACT_VERSION, definitionRefSchema, runRefSchema, stepRefSchema,
  versionedAssetRefSchema, workflowDigestSchema, workflowIdSchema, workflowJsonSchema,
  workflowRevisionSchema, workflowScopeSchema, workflowTimestampSchema
} from './identity'
import type { VersionedAssetRef } from './identity'

function checkUniqueAssetVersions(refs: VersionedAssetRef[], context: z.RefinementCtx, path: string): void {
  const seen = new Set<string>()
  refs.forEach((ref, index) => {
    const key = JSON.stringify([ref.assetId, ref.version])
    if (seen.has(key)) context.addIssue({ code: 'custom', path: [path, index], message: 'Duplicate immutable asset identity/version; deduplicate identical references before pinning' })
    seen.add(key)
  })
}

export const capabilityFactSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('supported'), evidenceRef: workflowIdSchema }).strict(),
  z.object({ status: z.literal('unsupported'), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal('unknown'), reason: z.string().min(1) }).strict()
])
export const executorBindingSchema = z.object({
  bindingId: workflowIdSchema,
  engineId: workflowIdSchema,
  engineVersion: workflowIdSchema,
  adapterVersion: workflowIdSchema,
  configuration: versionedAssetRefSchema,
  capabilities: z.record(workflowIdSchema, capabilityFactSchema)
}).strict()
export type ExecutorBinding = z.infer<typeof executorBindingSchema>
export type CapabilityFact = z.infer<typeof capabilityFactSchema>

export const assetVisibilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal'), ownerId: workflowIdSchema }).strict(),
  z.object({ kind: z.literal('project'), projectId: workflowIdSchema }).strict(),
  z.object({ kind: z.literal('team'), teamId: workflowIdSchema }).strict()
])
export const agentRoleRevisionSchema = z.object({
  ref: versionedAssetRefSchema,
  visibility: assetVisibilitySchema,
  methods: z.array(versionedAssetRefSchema),
  instructionDigest: workflowDigestSchema
}).strict().superRefine((value, context) => checkUniqueAssetVersions(value.methods, context, 'methods'))

const relativeMaterialPath = z.string().min(1).refine((value) => !/^[\\/]|^[a-zA-Z]:/.test(value) && !value.split(/[\\/]/).includes('..'), 'Material paths must be workspace-relative')
export const materialSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('trellis-file'), relativePath: relativeMaterialPath }).strict(),
  z.object({ kind: z.literal('published'), publicationId: workflowIdSchema }).strict(),
  z.object({ kind: z.literal('external'), instanceId: workflowIdSchema, objectId: workflowIdSchema }).strict()
])
export const materialVersionSchema = z.object({
  materialId: workflowIdSchema,
  version: workflowIdSchema,
  kind: z.enum(['product-requirement', 'trellis-prd', 'design', 'spec', 'code', 'feedback', 'other']),
  source: materialSourceSchema,
  sourceDigest: workflowDigestSchema.nullable()
}).strict()
export const contextMaterialSchema = z.object({
  material: materialVersionSchema,
  inclusion: z.enum(['full', 'truncated', 'index-only', 'unavailable']),
  includedDigest: workflowDigestSchema.nullable(),
  reason: z.string().nullable()
}).strict().superRefine((value, context) => {
  if ((value.inclusion === 'full' || value.inclusion === 'truncated') && (!value.material.sourceDigest || !value.includedDigest)) context.addIssue({ code: 'custom', message: 'Included content needs full source and provided-content digests' })
  if (value.inclusion === 'full' && value.material.sourceDigest !== value.includedDigest) context.addIssue({ code: 'custom', message: 'Full inclusion must match the source digest' })
  if ((value.inclusion === 'index-only' || value.inclusion === 'unavailable') && value.includedDigest !== null) context.addIssue({ code: 'custom', message: 'Non-content inclusion cannot claim a provided-content digest' })
})
export const contextManifestSchema = z.object({
  scope: workflowScopeSchema,
  instruction: z.string(),
  inputs: z.record(workflowIdSchema, workflowJsonSchema),
  materials: z.array(contextMaterialSchema),
  engineeringBaseline: versionedAssetRefSchema.nullable(),
  outputContract: versionedAssetRefSchema,
  budgetBytes: z.number().int().nonnegative().safe(),
  complete: z.boolean()
}).strict().superRefine((value, context) => {
  const seen = new Set<string>()
  value.materials.forEach((entry, index) => {
    const key = JSON.stringify([entry.material.source, entry.material.materialId, entry.material.version])
    if (seen.has(key)) context.addIssue({ code: 'custom', path: ['materials', index], message: 'Duplicate material source/version' })
    seen.add(key)
  })
})
export type ContextManifest = z.infer<typeof contextManifestSchema>

export const runManifestSchema = z.object({
  contractVersion: z.literal(WORKFLOW_CONTRACT_VERSION),
  scope: workflowScopeSchema,
  run: runRefSchema,
  definition: definitionRefSchema,
  roles: z.array(agentRoleRevisionSchema),
  executors: z.array(executorBindingSchema),
  extensions: z.array(versionedAssetRefSchema),
  context: contextManifestSchema,
  inputFingerprint: workflowDigestSchema,
  recordedAt: workflowTimestampSchema
}).strict().superRefine((value, context) => {
  if (JSON.stringify(value.scope) !== JSON.stringify(value.context.scope)) context.addIssue({ code: 'custom', path: ['context', 'scope'], message: 'Manifest context scope differs from run scope' })
  const ids = new Set<string>()
  value.executors.forEach((executor, index) => {
    if (ids.has(executor.bindingId)) context.addIssue({ code: 'custom', path: ['executors', index], message: 'Duplicate executor binding' })
    ids.add(executor.bindingId)
  })
  checkUniqueAssetVersions(value.roles.map((role) => role.ref), context, 'roles')
  checkUniqueAssetVersions(value.extensions, context, 'extensions')
  const pinned = [
    ...value.roles.flatMap((role) => [role.ref, ...role.methods]),
    ...value.executors.map((executor) => executor.configuration),
    ...value.extensions, value.context.outputContract,
    ...(value.context.engineeringBaseline ? [value.context.engineeringBaseline] : [])
  ]
  const digests = new Map<string, string>()
  pinned.forEach((ref) => {
    const key = JSON.stringify([ref.assetId, ref.version]); const previous = digests.get(key)
    if (previous !== undefined && previous !== ref.digest) context.addIssue({ code: 'custom', message: 'Conflicting immutable asset digest across adopted manifest references' })
    digests.set(key, ref.digest)
  })
})
export type RunManifest = z.infer<typeof runManifestSchema>

export const runStateSchema = z.enum(['planned', 'queued', 'dispatched', 'running', 'waiting', 'stopping', 'stopped', 'verified', 'failed', 'cancelled', 'outcome-unknown'])
export const workflowRunSchema = z.object({
  contractVersion: z.literal(WORKFLOW_CONTRACT_VERSION),
  scope: workflowScopeSchema,
  run: runRefSchema,
  definition: definitionRefSchema,
  state: runStateSchema,
  predecessor: runRefSchema.nullable(),
  createdAt: workflowTimestampSchema
}).strict().superRefine((value, context) => {
  if (value.predecessor && value.predecessor.runId === value.run.runId && value.predecessor.revision >= value.run.revision) context.addIssue({ code: 'custom', path: ['predecessor'], message: 'Predecessor must be an earlier revision' })
})
export const workflowStepSchema = z.object({ scope: workflowScopeSchema, step: stepRefSchema, state: runStateSchema }).strict()

export const workflowCommandSchema = z.object({
  contractVersion: z.literal(WORKFLOW_CONTRACT_VERSION),
  commandId: workflowIdSchema,
  scope: workflowScopeSchema,
  runId: workflowIdSchema,
  expectedRevision: workflowRevisionSchema,
  kind: z.enum(['start', 'adopt-revision', 'request-stop', 'reconcile']),
  payloadDigest: workflowDigestSchema,
  payload: workflowJsonSchema,
  requestedAt: workflowTimestampSchema
}).strict()
export const commandAdmissionSchema = z.object({
  commandId: workflowIdSchema,
  status: z.enum(['accepted', 'duplicate', 'revision-conflict', 'payload-conflict', 'rejected']),
  operationId: workflowIdSchema.nullable()
}).strict()
export const operationStateSchema = z.enum(['pending', 'dispatched', 'confirmed', 'failed', 'outcome-unknown'])
export const workflowOperationSchema = z.object({
  operationId: workflowIdSchema,
  commandId: workflowIdSchema,
  scope: workflowScopeSchema,
  run: runRefSchema,
  state: operationStateSchema,
  ownerId: workflowIdSchema.nullable(),
  fencingToken: z.number().int().nonnegative().safe(),
  result: workflowJsonSchema.nullable()
}).strict()

export const eventAttributionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assigned'), scope: workflowScopeSchema, run: runRefSchema, step: stepRefSchema.nullable(), sessionId: workflowIdSchema.nullable(), turnId: workflowIdSchema.nullable(), historySeq: z.number().int().nonnegative().safe().nullable() }).strict(),
  z.object({ kind: z.literal('unassigned'), reason: z.string().min(1) }).strict()
]).superRefine((value, context) => {
  if (value.kind === 'assigned' && value.step && (value.step.runId !== value.run.runId || value.step.revision !== value.run.revision)) context.addIssue({ code: 'custom', path: ['step'], message: 'Step/run attribution mismatch' })
})
export const executionEventSchema = z.object({
  contractVersion: z.literal(WORKFLOW_CONTRACT_VERSION),
  eventId: workflowIdSchema,
  source: z.enum(['platform', 'trellis', 'filesystem', 'engine', 'jira', 'human']),
  type: workflowIdSchema,
  attribution: eventAttributionSchema,
  occurredAt: workflowTimestampSchema,
  receivedAt: workflowTimestampSchema,
  epoch: workflowIdSchema,
  sequence: z.number().int().nonnegative().safe(),
  payload: workflowJsonSchema
}).strict()
export const contextReceiptSchema = z.object({
  eventId: workflowIdSchema,
  scope: workflowScopeSchema,
  step: stepRefSchema,
  receiver: workflowIdSchema,
  stage: z.enum(['prepared', 'assembled', 'emitted-to-host', 'tool-read', 'check-result']),
  material: materialVersionSchema,
  includedDigest: workflowDigestSchema.nullable(),
  evidenceRef: workflowIdSchema
}).strict()
export type WorkflowCommand = z.infer<typeof workflowCommandSchema>
export type ExecutionEvent = z.infer<typeof executionEventSchema>
export type AgentRoleRevision = z.infer<typeof agentRoleRevisionSchema>
export type MaterialVersion = z.infer<typeof materialVersionSchema>
export type ContextMaterial = z.infer<typeof contextMaterialSchema>
export type WorkflowRun = z.infer<typeof workflowRunSchema>
export type WorkflowStep = z.infer<typeof workflowStepSchema>
export type WorkflowOperation = z.infer<typeof workflowOperationSchema>
export type CommandAdmission = z.infer<typeof commandAdmissionSchema>
export type ContextReceipt = z.infer<typeof contextReceiptSchema>
