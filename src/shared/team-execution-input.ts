import { z } from 'zod'
import { teamCommandIdSchema, teamDigestSchema, teamIdSchema } from './team-platform'
import { teamTaskRefSchema, teamExecutionBundleRefSchema, teamExecutionWorkflowRefSchema } from './team-task-execution'
import { executionStageSchema, portableWorkflowDefinitionSchema, portableWorkflowNodeSchema } from './workflow/portable-definition'
import { workflowIdSchema } from './workflow/identity'
import { taskInputCanonical } from './team-task-inputs'
import { executionArtifactRefSchema, executionCreationRefSchema } from './team-execution-artifacts'

const count = z.number().int().nonnegative().safe()
const body = { bodyDigest: teamDigestSchema, byteLength: count.max(1024 * 1024) }
/** Resource selections are path segments; dot segments cannot survive URL normalization. */
export const executionInputSelectionIdSchema = workflowIdSchema.refine(value => value !== '.' && value !== '..', 'Execution selection identity cannot be a URL dot segment')
  .refine(value => { try { encodeURIComponent(value); return true } catch { return false } }, 'Execution selection identity must be well-formed Unicode')
export const executionInputSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('governance'), packageId: teamIdSchema, versionId: teamIdSchema }).strict(),
  z.object({ kind: z.literal('confirmed-document'), documentId: teamIdSchema, versionId: teamIdSchema }).strict(),
  executionArtifactRefSchema,
  executionCreationRefSchema,
  z.object({ kind: z.literal('agent-instructions'), roleId: workflowIdSchema }).strict(),
  z.object({ kind: z.literal('skill'), roleId: workflowIdSchema, skillId: workflowIdSchema }).strict()
])
export const executionInputSelectionSchema = z.object({
  id: executionInputSelectionIdSchema, phaseId: workflowIdSchema, nodeId: workflowIdSchema, stage: executionStageSchema,
  order: count.max(1000), reason: z.string().min(1).max(1000), required: z.boolean(),
  delivery: z.enum(['full', 'partial', 'index-only', 'omitted']), source: executionInputSourceSchema
}).strict().superRefine((value, ctx) => {
  if (value.required && value.delivery !== 'full') ctx.addIssue({ code: 'custom', message: 'Required inputs must request full delivery' })
})
export const executionInputCommandSchema = z.object({
  contractVersion: z.literal(2), kind: z.literal('capture'), commandId: teamCommandIdSchema, task: teamTaskRefSchema,
  expectedEpoch: teamIdSchema, expectedActorId: teamIdSchema, expectedDeviceId: teamIdSchema.nullable(),
  expectedExecutionId: teamIdSchema, expectedGeneration: count.min(1),
  roles: z.array(z.object({ roleId: workflowIdSchema, agentId: workflowIdSchema, expectedDigest: teamDigestSchema }).strict()).min(1).max(32),
  selections: z.array(executionInputSelectionSchema).min(1).max(128)
}).strict().superRefine((value, ctx) => {
  if (new Set(value.roles.map(role => role.roleId)).size !== value.roles.length) ctx.addIssue({ code: 'custom', message: 'Duplicate role selection' })
  if (new Set(value.selections.map(item => item.id)).size !== value.selections.length) ctx.addIssue({ code: 'custom', message: 'Duplicate selection identity' })
  const positions = value.selections.map(item => JSON.stringify([item.nodeId, item.order]))
  if (new Set(positions).size !== positions.length) ctx.addIssue({ code: 'custom', message: 'Duplicate stage selection order' })
})
export const executionInputAgentContentSchema = z.object({ agentId: workflowIdSchema, instructions: z.string().max(128 * 1024),
  skills: z.array(z.object({ skillId: workflowIdSchema, name: z.string().min(1).max(300), description: z.string().max(2000).nullable(), content: z.string().max(128 * 1024) }).strict()).max(32) }).strict()
export function executionInputAgentDigestText(raw: z.infer<typeof executionInputAgentContentSchema>): string { return taskInputCanonical(executionInputAgentContentSchema.parse(raw)) }
const capturedAgent = z.object({ roleId: workflowIdSchema, agentId: workflowIdSchema, digest: teamDigestSchema,
  instructions: z.object(body).strict(), skills: z.array(z.object({ skillId: workflowIdSchema, name: z.string().min(1).max(300), description: z.string().max(2000).nullable(), ...body }).strict()).max(32) }).strict()
export const executionInputResourceSchema = z.object({ selection: executionInputSelectionSchema, title: z.string().min(1).max(300), ...body }).strict()
export const executionInputSchema = z.object({
  contractVersion: z.literal(2), executionId: teamIdSchema, task: teamTaskRefSchema, epoch: teamIdSchema,
  generation: count.min(1), actorId: teamIdSchema, deviceId: teamIdSchema.nullable(), inputBundle: teamExecutionBundleRefSchema,
  workflow: teamExecutionWorkflowRefSchema, definition: portableWorkflowDefinitionSchema,
  agents: z.array(capturedAgent).min(1).max(32), resources: z.array(executionInputResourceSchema).min(1).max(128),
  capturedAt: count, digest: teamDigestSchema
}).strict().superRefine((value, ctx) => {
  if (value.workflow.definitionId !== value.definition.definitionId || value.workflow.revision !== value.definition.revision) ctx.addIssue({ code: 'custom', message: 'Captured definition and execution workflow differ' })
  if (new Set(value.agents.map(agent => agent.roleId)).size !== value.agents.length || value.definition.roles.length !== value.agents.length || value.agents.some(agent => !value.definition.roles.some(role => role.id === agent.roleId))) ctx.addIssue({ code: 'custom', message: 'Captured logical role set differs' })
  if (new Set(value.resources.map(resource => resource.selection.id)).size !== value.resources.length) ctx.addIssue({ code: 'custom', message: 'Duplicate captured resource selection' })
  const positions = new Set<string>()
  for (const resource of value.resources) {
    const node = value.definition.nodes.find(item => item.id === resource.selection.nodeId), position = JSON.stringify([resource.selection.nodeId, resource.selection.order])
    if (!node || node.kind !== 'agent' || node.phaseId !== resource.selection.phaseId || node.stage !== resource.selection.stage || positions.has(position)) ctx.addIssue({ code: 'custom', message: 'Captured selection stage/order differs from its definition' })
    positions.add(position)
  }
})
export function executionInputDigestText(raw: z.infer<typeof executionInputSchema>): string {
  const { digest: _digest, ...content } = executionInputSchema.parse(raw)
  return taskInputCanonical(content)
}
export const executionInputViewSchema = z.object({ contractVersion: z.literal(2), purpose: z.enum(['history', 'use']),
  input: executionInputSchema, currentBundle: teamExecutionBundleRefSchema.nullable(),
  resources: z.array(z.object({ selectionId: executionInputSelectionIdSchema, status: z.enum(['available', 'withdrawn', 'unavailable']) }).strict()).max(128)
}).strict()
export const executionInputResourceViewSchema = z.object({ contractVersion: z.literal(2), inputDigest: teamDigestSchema,
  resource: executionInputResourceSchema, status: z.enum(['available', 'withdrawn', 'unavailable']), text: z.string().max(1024 * 1024).nullable() }).strict()
export const executionInputReceiptSchema = z.object({ contractVersion: z.literal(2), commandId: teamCommandIdSchema,
  task: teamTaskRefSchema, epoch: teamIdSchema, actorId: teamIdSchema, deviceId: teamIdSchema.nullable(),
  executionId: teamIdSchema, generation: count.min(1), inputDigest: teamDigestSchema, requestDigest: teamDigestSchema, committedAt: count }).strict()
export const executionInputCommandReplySchema = z.object({ status: z.enum(['committed', 'duplicate']), commandId: teamCommandIdSchema, result: executionInputReceiptSchema }).strict()
export const executionInputReadQuerySchema = z.object({ contractVersion: z.coerce.number().pipe(z.literal(2)),
  instanceId: teamIdSchema, spaceId: teamTaskRefSchema.shape.spaceId, taskCreatedAt: teamTaskRefSchema.shape.taskCreatedAt, purpose: z.enum(['history', 'use']) }).strict()
export const executionContextReceiptSchema = z.object({ selection: executionInputSelectionSchema, sourceDigest: teamDigestSchema,
  sourceBytes: count, deliveredDigest: teamDigestSchema.nullable(), deliveredBytes: count, deliveredChars: count,
  status: z.enum(['full', 'partial', 'index-only', 'omitted', 'unavailable']), reason: z.enum(['selected', 'context-budget', 'withdrawn', 'unavailable']) }).strict()
export const executionContextManifestSchema = z.object({ contractVersion: z.literal(2), state: z.literal('prepared'),
  inputDigest: teamDigestSchema, nodeId: workflowIdSchema, phaseId: workflowIdSchema, stage: executionStageSchema,
  instructionDigest: teamDigestSchema, instructionBytes: count, entries: z.array(executionContextReceiptSchema).max(24),
  serializedBytes: count.max(8192), envelopeBytes: z.object({ acp: count.max(8192), pi: count.max(8192) }).strict(), packetDigest: teamDigestSchema }).strict()
export const executionContextPacketSchema = z.object({ contractVersion: z.literal(2), inputDigest: teamDigestSchema, executionId: teamIdSchema,
  node: portableWorkflowNodeSchema.options[0], roleInstructions: z.string().max(128 * 1024),
  sources: z.array(executionContextReceiptSchema.extend({ text: z.string().nullable() }).strict()).max(24) }).strict()
export type ExecutionInput = z.infer<typeof executionInputSchema>
export type ExecutionInputCommand = z.infer<typeof executionInputCommandSchema>
export type ExecutionInputView = z.infer<typeof executionInputViewSchema>
export type ExecutionInputResource = z.infer<typeof executionInputResourceSchema>
export type ExecutionInputReceipt = z.infer<typeof executionInputReceiptSchema>
export type ExecutionContextManifest = z.infer<typeof executionContextManifestSchema>
/** Implemented by the authenticated source owner; no local Trellis locator is required. */
export interface ExecutionInputSource {
  read(): Promise<ExecutionInputView>
  readResource(selectionId: string): Promise<z.infer<typeof executionInputResourceViewSchema>>
}

/** Additive native delivery evidence; captured inputs and legacy packets stay unchanged. */
export const PLATFORM_REFERENCE_BUDGET_BYTES = 32 * 1024
export const platformReferenceScopeSchema = z.object({ task: teamTaskRefSchema, epoch: teamIdSchema,
  executionId: teamIdSchema, generation: count.min(1), nodeId: workflowIdSchema, attempt: count.min(1), inputDigest: teamDigestSchema }).strict()
export const platformReferenceSourceReceiptSchema = z.object({ resource: executionInputResourceSchema,
  sourceDigest: teamDigestSchema, sourceBytes: count, sourceChars: count,
  renderedDigest: teamDigestSchema, renderedBytes: count, renderedChars: count }).strict()
export const platformReferenceAggregateSchema = z.object({ version: z.literal(1), scope: platformReferenceScopeSchema,
  controlPacketDigest: teamDigestSchema, controlInstructionDigest: teamDigestSchema, instructionDigest: teamDigestSchema,
  sources: z.array(platformReferenceSourceReceiptSchema).max(24),
  renderedDigest: teamDigestSchema, renderedBytes: count.max(PLATFORM_REFERENCE_BUDGET_BYTES), renderedChars: count,
  framingBytes: count.min(256).max(16384), aggregateBytes: count.max(PLATFORM_REFERENCE_BUDGET_BYTES), digest: teamDigestSchema }).strict()
export const platformReferenceDeliveryReceiptSchema = platformReferenceAggregateSchema.extend({
  state: z.enum(['prepared', 'admitted', 'not-sent', 'unknown', 'written']),
  native: z.object({ sessionId: z.string().min(1).max(512), connectionGeneration: z.string().min(1).max(512), turnId: z.string().min(1).max(512) }).strict().optional()
}).strict().superRefine((value, ctx) => {
  if (value.state !== 'prepared' && value.state !== 'not-sent' && !value.native) ctx.addIssue({ code: 'custom', message: 'Native delivery evidence requires its original turn identity' })
  if (value.aggregateBytes !== value.renderedBytes + value.framingBytes) ctx.addIssue({ code: 'custom', message: 'Reference aggregate byte accounting differs' })
  const ids = value.sources.map(item => item.resource.selection.id), orders = value.sources.map(item => item.resource.selection.order)
  if (new Set(ids).size !== ids.length || new Set(orders).size !== orders.length || orders.some((order, i) => i > 0 && order <= orders[i - 1])) ctx.addIssue({ code: 'custom', message: 'Reference receipts must be unique and ordered' })
  if (value.sources.some(item => item.resource.selection.nodeId !== value.scope.nodeId || item.resource.selection.source.kind !== 'confirmed-document'
    || !item.resource.selection.required || item.resource.selection.delivery !== 'full' || item.sourceDigest !== item.resource.bodyDigest
    || item.sourceBytes !== item.resource.byteLength || item.sourceChars > item.sourceBytes || item.renderedBytes < item.sourceBytes
    || item.renderedChars < item.sourceChars) || value.sources.reduce((sum, item) => sum + item.renderedBytes, 0) > value.renderedBytes) ctx.addIssue({ code: 'custom', message: 'Reference receipts differ from their captured source scope or byte accounting' })
})
export type PlatformReferenceScope = z.infer<typeof platformReferenceScopeSchema>
export type PlatformReferenceAggregate = z.infer<typeof platformReferenceAggregateSchema>
export type PlatformReferenceDeliveryReceipt = z.infer<typeof platformReferenceDeliveryReceiptSchema>
