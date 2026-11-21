import { z } from 'zod'
import { acpPermissionReviewSchema } from './acp-permission-review'
import { executionCodeSourceSchema } from './team-execution-artifacts'
import { teamDigestSchema } from './team-platform'
import { databaseDeliveryCaptureRequestSchema } from './database-delivery'
import { workflowIdSchema } from './workflow/identity'
import { executionContextManifestSchema, platformReferenceDeliveryReceiptSchema } from './team-execution-input'
import { teamTaskRefSchema } from './team-task-execution'
import { nativeTaskFailureSchema } from './native-task-failure'

const uuid = z.string().uuid()
const databaseDelivery = databaseDeliveryCaptureRequestSchema.omit({ operation: true, preparationId: true, files: true }).extend({
  implementationOutputId: workflowIdSchema, reportOutputId: workflowIdSchema
}).strict()
const relativeFile = z.string().min(1).max(4096).refine(path => !path.includes('\\') && !path.includes(':')
  && !path.includes('\0') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.')), 'Select a regular engineering-relative output')
export const nativeTaskOutputSelectionSchema = z.object({ outputId: workflowIdSchema,
  source: z.discriminatedUnion('kind', [z.object({ kind: z.literal('file'), relativePath: relativeFile }).strict(),
    z.object({ kind: z.literal('assistant') }).strict()]) }).strict()
export const nativeTaskStartSchema = z.object({ operation: z.literal('start'), dispatchId: uuid, preparationId: uuid,
  engine: z.object({ agentId: z.enum(['pi', 'codex', 'claude']), profileId: z.string().min(1).max(200).regex(/^[\w.-]+$/).optional() }).strict(),
  instruction: z.string().min(1).max(32000), databaseDelivery: databaseDelivery.optional(), outputs: z.array(nativeTaskOutputSelectionSchema).max(16),
  expectedConfigurationDigest: teamDigestSchema.optional(),
  sharing: z.object({ task: teamTaskRefSchema, outputIds: z.array(workflowIdSchema).min(1).max(16) }).strict().optional()
}).strict().refine(value => new Set(value.outputs.map(item => item.outputId)).size === value.outputs.length, 'Duplicate output selection')
export const nativeTaskSelectedCodeSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('selected-files'), outputIds: z.array(workflowIdSchema).min(1).max(16) }).strict(),
  executionCodeSourceSchema.options[2],
  z.object({ kind: z.literal('git-patch'), repositoryId: z.string().min(1).max(300), base: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), outputId: workflowIdSchema }).strict()])
export const nativeTaskExecutionRequestSchema = z.discriminatedUnion('operation', [nativeTaskStartSchema,
  z.object({ operation: z.literal('report'), dispatchId: uuid, outputIds: z.array(workflowIdSchema).min(1).max(16),
    remainingWork: z.string().max(8192), code: nativeTaskSelectedCodeSchema, finalize: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal('permission'), dispatchId: uuid, requestId: z.string().min(1).max(200), optionId: z.string().min(1).max(1000) }).strict(),
  z.object({ operation: z.literal('stop'), dispatchId: uuid }).strict(),
  z.object({ operation: z.literal('reconcile'), dispatchId: uuid, retryOutputs: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal('finish'), dispatchId: uuid, code: nativeTaskSelectedCodeSchema.optional() }).strict()
])
export const nativeTaskOutputSyncSchema = z.object({
  state: z.enum(['captured', 'pending', 'unknown', 'denied', 'failed', 'needs-code', 'confirmed']),
  attempts: z.number().int().nonnegative(), nextAttemptAt: z.number().int().nonnegative().nullable(),
  error: z.string().max(500).nullable()
}).strict()
/** Private native receipt. Shared task records receive only T04 refs and bounded progress. */
export const nativeTaskExecutionResultSchema = z.object({ dispatchId: uuid, preparationId: uuid,
  boundary: z.literal('node-attempt'), scope: z.object({ executionId: z.string(), generation: z.number().int().positive(),
    nodeId: workflowIdSchema, attempt: z.number().int().positive(), inputDigest: teamDigestSchema }).strict().nullable(),
  state: z.enum(['starting', 'running', 'idle', 'failed', 'stop-requested', 'stopped', 'unknown']),
  native: z.object({ sessionId: z.string(), connectionGeneration: z.string().nullable(), backendSessionId: z.string().nullable(),
    agentSessionId: z.string().nullable(), agentId: z.enum(['pi', 'codex', 'claude']), configurationDigest: teamDigestSchema.nullable(),
    adapterVersion: z.string().nullable(), modelId: z.string().nullable(),
    turnId: z.string().nullable(), promptDigest: teamDigestSchema.nullable(), promptWritten: z.boolean(),
    outcome: z.enum(['completed', 'cancelled', 'failed']).nullable() }).strict(),
  outputs: z.array(z.object({ outputId: workflowIdSchema, bodyDigest: teamDigestSchema, byteLength: z.number().int().nonnegative() }).strict()).max(16),
  manifest: z.object({ versionId: z.string(), digest: teamDigestSchema }).strict().nullable(),
  checkpoint: z.object({ versionId: z.string(), digest: teamDigestSchema }).strict().nullable(),
  context: executionContextManifestSchema.nullable(), referenceDelivery: platformReferenceDeliveryReceiptSchema.optional(),
  cleanupConfirmed: z.boolean(), pendingCommands: z.array(uuid).max(64),
  /** Fresh runtime projection of private non-send/cleanup evidence, never a client grant. */
  canRetry: z.boolean().optional(),
  /** A finished, cleaned attempt may be explicitly run again; never an automatic replay. */
  canRestart: z.boolean().optional(),
  failure: nativeTaskFailureSchema.optional(),
  outputSync: nativeTaskOutputSyncSchema.optional(), finalized: z.boolean().optional(),
  permissions: z.array(z.object({ requestId: z.string(), tool: z.string().nullable(), expiresAt: z.number().nullable(),
    sessionId: z.string().optional(), connectionGeneration: z.string().optional(), turnId: z.string().optional(),
    reviewContext: acpPermissionReviewSchema.optional(),
    options: z.array(z.object({ optionId: z.string(), name: z.string(), kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']) }).strict()).max(32) }).strict()).max(32)
}).strict()
export type NativeTaskStart = z.infer<typeof nativeTaskStartSchema>
export type NativeTaskExecutionRequest = z.infer<typeof nativeTaskExecutionRequestSchema>
export type NativeTaskExecutionResult = z.infer<typeof nativeTaskExecutionResultSchema>
/** Reserved controls cannot launch, submit outputs, authorize a directory or select another task. */
export function isBoundedNativeTaskControl(method: string, wire: unknown): boolean {
  if (method !== 'runtime.taskExecution' || !wire || typeof wire !== 'object' || !('inline' in wire)) return false
  const value = nativeTaskExecutionRequestSchema.safeParse(wire.inline)
  return value.success && ['stop', 'reconcile', 'permission'].includes(value.data.operation)
}
