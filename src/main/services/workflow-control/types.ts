/** Clean-room durable workflow DTOs; application authorization remains main-owned. */
import { z } from 'zod'
import {
  executionEventSchema, journalCommitSchema, runManifestSchema, workflowCursorSchema,
  workflowOperationSchema, workflowOwnerSchema, workflowRunSchema, workflowScopeSchema,
  workflowStepSchema, workflowIdSchema, workflowTimestampSchema, workflowJsonSchema,
  materialVersionSchema
} from '../../../shared/workflow'

export const MAX_CONTROL_REQUEST_BYTES = 4 * 1024 * 1024
export const MAX_CONTROL_PENDING_BYTES = 16 * 1024 * 1024
export const MAX_CONTROL_PENDING_REQUESTS = 64
export const CONTROL_REQUEST_TIMEOUT_MS = 15_000
export const DEFAULT_OWNER_TTL_MS = 30_000
export const MAX_CONTROL_EVENTS_PER_COMMIT = 512

export type WorkflowRun = z.infer<typeof workflowRunSchema>
export type WorkflowOperation = z.infer<typeof workflowOperationSchema>
export type WorkflowOwner = z.infer<typeof workflowOwnerSchema>
export type WorkflowCursor = z.infer<typeof workflowCursorSchema>
export type WorkflowScope = z.infer<typeof workflowScopeSchema>
export const workspaceIdentitySchema = workflowScopeSchema.omit({ taskRef: true }).strict()
export type WorkspaceIdentity = z.infer<typeof workspaceIdentitySchema>
export type ExecutionEvent = z.infer<typeof executionEventSchema>

export const commitInputSchema = z.object({
  journal: journalCommitSchema,
  manifests: z.array(runManifestSchema).default([])
}).strict()
export type WorkflowCommitInput = z.infer<typeof commitInputSchema>

export const leaseInputSchema = z.object({
  scope: workflowScopeSchema,
  ownerId: workflowIdSchema,
  ttlMs: z.number().int().min(1_000).max(300_000).default(DEFAULT_OWNER_TTL_MS)
}).strict()
export type LeaseInput = z.infer<typeof leaseInputSchema>
export type WorkspaceLease = {
  scope: WorkflowScope
  owner: WorkflowOwner
  pid: number
  leaseUntil: number
  state: 'active' | 'recovery-required' | 'released'
  recoveryRequired: boolean
}
export type LeaseResult = { status: 'acquired' | 'renewed'; lease: WorkspaceLease } | { status: 'owner-conflict'; lease: WorkspaceLease }

export const ownerScopeInputSchema = z.object({ scope: workflowScopeSchema, owner: workflowOwnerSchema }).strict()
export const eventPageInputSchema = z.object({
  scope: workflowScopeSchema,
  cursor: workflowCursorSchema.nullable().default(null),
  limit: z.number().int().min(1).max(200).default(100)
}).strict()
export type EventPageInput = z.infer<typeof eventPageInputSchema>
export type StoredWorkflowEvent = { event: ExecutionEvent; cursor: WorkflowCursor; payloadDigest: string }
export type WorkflowEventPage = { items: StoredWorkflowEvent[]; cursor: WorkflowCursor; resetRequired: boolean; hasMore: boolean }

export const operationInputSchema = ownerScopeInputSchema.extend({ operationId: workflowIdSchema }).strict()
export const settleOperationInputSchema = operationInputSchema.extend({
  state: z.enum(['confirmed', 'failed', 'outcome-unknown']),
  result: workflowJsonSchema.nullable(),
  evidenceRefs: z.array(workflowIdSchema).min(1)
}).strict()
export const reconcileOperationInputSchema = operationInputSchema.extend({
  status: z.enum(['confirmed', 'unresolved', 'conflict']),
  result: workflowJsonSchema.nullable(),
  evidenceRefs: z.array(workflowIdSchema).min(1)
}).strict()
export type OperationRecord = {
  operation: WorkflowOperation
  attempts: number
  dispatchedAt: number | null
  updatedAt: number
  evidenceRefs: string[]
}

export const stepRecordSchema = workflowStepSchema.extend({
  owner: workflowOwnerSchema,
  inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  materialRefs: z.array(materialVersionSchema),
  outputRefs: z.array(materialVersionSchema),
  sessionId: workflowIdSchema.nullable(),
  turnId: workflowIdSchema.nullable(),
  historySeq: z.number().int().nonnegative().safe().nullable(),
  historyCommitted: z.boolean(),
  updatedAt: workflowTimestampSchema
}).strict().superRefine((value, context) => {
  if (value.historyCommitted && (value.sessionId === null || value.historySeq === null)) context.addIssue({ code: 'custom', message: 'Committed history needs actual session and sequence references' })
})
export type WorkflowStepRecord = z.infer<typeof stepRecordSchema>

export type WorkflowControlHealth = {
  state: 'active'
  baseSchemaVersion: number
  workflowSchemaVersion: number
  journalMode: string
  synchronous: number
  databasePath: string
}

export class WorkflowControlError extends Error {
  constructor(public readonly code: string, message: string, public readonly outcomeUnknown = false) {
    super(message)
    this.name = 'WorkflowControlError'
  }
}

export type WorkflowControlOperation =
  | { op: 'init'; runtimeDir: string }
  | { op: 'claim'; input: LeaseInput }
  | { op: 'workspace-owner'; input: WorkspaceIdentity }
  | { op: 'renew'; input: LeaseInput; owner: WorkflowOwner }
  | { op: 'release'; scope: WorkflowScope; owner: WorkflowOwner }
  | { op: 'recover-process'; scope: WorkflowScope; expectedOwner: WorkflowOwner }
  | { op: 'reserve'; command: unknown; owner: WorkflowOwner }
  | { op: 'cancel-command'; scope: WorkflowScope; commandId: string; owner: WorkflowOwner; evidenceRefs: string[] }
  | { op: 'commit'; input: WorkflowCommitInput }
  | { op: 'load'; scope: WorkflowScope; run: { runId: string; revision: number } }
  | { op: 'head'; scope: WorkflowScope }
  | { op: 'events'; input: EventPageInput }
  | { op: 'append'; report: unknown }
  | { op: 'command'; scope: WorkflowScope; commandId: string }
  | { op: 'operation'; scope: WorkflowScope; operationId: string }
  | { op: 'pending'; scope: WorkflowScope; owner: WorkflowOwner; limit: number }
  | { op: 'dispatch'; input: z.infer<typeof operationInputSchema> }
  | { op: 'settle'; input: z.infer<typeof settleOperationInputSchema> }
  | { op: 'reconcile'; input: z.infer<typeof reconcileOperationInputSchema> }
  | { op: 'step'; record: WorkflowStepRecord }
  | { op: 'steps'; scope: WorkflowScope; run: { runId: string; revision: number } }
  | { op: 'sync-page'; scope: WorkflowScope; limit: number }
  | { op: 'sync-confirm'; scope: WorkflowScope; deliveryIds: string[] }
  | { op: 'alias-read'; taskRef: string }
  | { op: 'alias-upsert'; taskRef: string; trellisTaskId: string | null; dir: string }
  | { op: 'health' }
  | { op: 'close' }

export type WorkflowControlRequest = WorkflowControlOperation & { requestId: number }
export type WorkflowControlResponse = { requestId: number; ok: true; value: unknown } | { requestId: number; ok: false; code: string; error: string; outcomeUnknown: boolean }
