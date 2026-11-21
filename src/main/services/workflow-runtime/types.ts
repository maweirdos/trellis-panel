/** Clean-room managed execution boundaries; parsing never grants project access. */
import { z } from 'zod'
import { workflowIdSchema, workflowTimestampSchema, workflowDigestSchema, materialVersionSchema } from '../../../shared/workflow'
import type { AcpSessionRecord, AcpSessionMeta, AcpStateEvent, TimelineEvent, AcpPromptOptions } from '../../../shared/types'
import type { IpcFail } from '../../../shared/ipc-errors'
import type { AcpHistoryPersistence } from '../../../shared/acp-history'
import type { AcpHistoryEventPage } from '../../../shared/acp-history'
import type { PreparedMaterials } from '../acp/materials'

/** Project reading is valid before a local Trellis task or managed run exists. */
export const materialOwnerSchema = z.object({
  projectId: workflowIdSchema,
  repositoryId: workflowIdSchema,
  workspaceId: workflowIdSchema,
  taskRef: workflowIdSchema.nullable()
}).strict()
export type MaterialOwner = z.infer<typeof materialOwnerSchema>
export const workflowMaterialRefSchema = z.string().regex(/^wm-[0-9a-f]{64}$/)
export const storedMaterialMetadataSchema = z.object({
  schemaVersion: z.literal(1), ref: workflowMaterialRefSchema, owner: materialOwnerSchema,
  material: materialVersionSchema, byteLength: z.number().int().nonnegative().safe(),
  capturedAt: workflowTimestampSchema, bodyDigest: workflowDigestSchema
}).strict()
export type StoredMaterialMetadata = z.infer<typeof storedMaterialMetadataSchema>
export type StoredWorkflowMaterial = StoredMaterialMetadata & { text: string }

export class WorkflowRuntimeError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'SCOPE_CHANGED' | 'MATERIAL_CHANGED' | 'MATERIAL_UNAVAILABLE' | 'STORE_UNAVAILABLE' | 'STORE_CORRUPTED' | 'CAPACITY_EXCEEDED' | 'EXECUTOR_UNAVAILABLE' | 'OUTCOME_UNKNOWN' | 'MISSING_BASELINE', message: string) {
    super(message)
    this.name = 'WorkflowRuntimeError'
  }
}

export type WorkflowAcpState = AcpStateEvent & { historyPersistence?: AcpHistoryPersistence }
export type WorkflowAcpObserver = {
  scope: { projectRoot: string; sessionId?: string; connectionGeneration?: string }
  event?: (event: TimelineEvent) => void
  state?: (event: WorkflowAcpState) => void
}
export type WorkflowAcpTurnIdentity = { sessionId: string; turnId: string; connectionGeneration?: string }
/** Backend-only argument. Never expose this through AcpPromptOptions or preload. */
export type WorkflowPreparedPrompt = {
  materials: PreparedMaterials
  /** Fixed shared stage context; supplied only by an authenticated backend owner. */
  executionContext?: import('../agent-rules').PreparedExecutionAgentRules
  /** Atomic current-node input; mutually exclusive with the legacy context. */
  platformInput?: import('../platform-reference-delivery').PlatformPreparedInput
  /** Synchronous durable barrier immediately before the native send boundary. */
  onPlatformDelivery?: (receipt: import('../../../shared/team-execution-input').PlatformReferenceDeliveryReceipt) => void
  assertActive: () => void
  onAdmitted?: (identity: WorkflowAcpTurnIdentity) => void
  onPromptWritten?: (identity: WorkflowAcpTurnIdentity) => void
}

/** Facade-owned processes, approvals, native sessions, leases and history stay intact. */
export interface WorkflowAcpPort {
  create(root: string, input: { agentId: string; profileId?: string; taskDir: string }): Promise<{ ok: true; sessionId: string } | IpcFail>
  list(root: string): { ok: true; sessions: AcpSessionRecord[] } | IpcFail
  get(root: string, sessionId: string): Promise<{ ok: true; session: AcpSessionMeta } | IpcFail>
  historyEvents(root: string, sessionId: string, input?: { limit?: number }): Promise<AcpHistoryEventPage | IpcFail>
  prompt(root: string, sessionId: string, text: string, options?: AcpPromptOptions, prepared?: WorkflowPreparedPrompt): Promise<{ ok: true; turnId: string } | IpcFail>
  cancel(root: string, sessionId: string): Promise<{ ok: true } | IpcFail>
  end(root: string, sessionId: string): Promise<{ ok: true } | IpcFail>
  resume(root: string, sessionId: string): Promise<{ ok: true; sessionId: string } | IpcFail>
  flushHistory(): Promise<void>
  persistence(sessionId: string): AcpHistoryPersistence
  observe(observer: WorkflowAcpObserver): () => void
}
