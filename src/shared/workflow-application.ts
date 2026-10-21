/** Desktop workflow DTOs. Main resolves every root, scope, owner and executor. */
import { z } from 'zod'
import { workflowIdSchema, runRefSchema, workflowCursorSchema, workflowJsonSchema } from './workflow'
import type { CompiledWorkflow, ExecutionEvent, JournalSnapshot, WorkflowScope, RunRef } from './workflow'
import type { AcpSessionMeta } from './types'

export const managedTaskDirSchema = z.string().min(1).max(256).regex(/^[^\\/.:\u0000-\u001f]+$/).refine((s) => s !== 'archive' && s === s.trim())
export const workflowOriginSchema = z.object({ sessionId: workflowIdSchema, connectionGeneration: workflowIdSchema }).strict()
export const workflowPreviewInputSchema = z.object({
  taskDir: managedTaskDirSchema, flowId: workflowIdSchema, origin: workflowOriginSchema,
  inputs: z.record(workflowIdSchema, workflowJsonSchema).default({})
}).strict()
export const workflowStartInputSchema = z.object({ taskDir: managedTaskDirSchema, commandId: workflowIdSchema, previewId: workflowIdSchema }).strict()
export const workflowSnapshotInputSchema = z.object({ taskDir: managedTaskDirSchema, run: runRefSchema.optional() }).strict()
export const workflowEventsInputSchema = workflowSnapshotInputSchema.extend({ cursor: workflowCursorSchema.nullable().default(null), limit: z.number().int().min(1).max(200).default(100) }).strict()
export const workflowStopInputSchema = z.object({ taskDir: managedTaskDirSchema, commandId: workflowIdSchema, run: runRefSchema }).strict()
export const workflowArtifactInputSchema = workflowSnapshotInputSchema.extend({ ref: z.string().regex(/^wm-[0-9a-f]{64}$/) }).strict()
export type WorkflowPreviewInput = z.input<typeof workflowPreviewInputSchema>
export type WorkflowStartInput = z.infer<typeof workflowStartInputSchema>
export type WorkflowSnapshotInput = z.infer<typeof workflowSnapshotInputSchema>
export type WorkflowEventsInput = z.input<typeof workflowEventsInputSchema>
export type WorkflowStopInput = z.infer<typeof workflowStopInputSchema>
export type WorkflowArtifactInput = z.infer<typeof workflowArtifactInputSchema>
export type WorkflowOrigin = z.infer<typeof workflowOriginSchema>

export type WorkflowApplicationPreview = {
  previewId: string; expiresAt: number; scope: WorkflowScope; origin: WorkflowOrigin;
  flowId: string; graph: CompiledWorkflow['graph']; firstNodeId: string;
  materials: Array<{ ref: string; kind: string; version: string; source: string }>;
  executorBindings: Array<{ bindingId: string; engineId: string; engineVersion: string; adapterVersion: string }>;
  limitations: string[]
}
export type WorkflowApplicationAdmission = {
  commandId: string; status: 'committed' | 'duplicate'; run: RunRef; scope: WorkflowScope
}
export type WorkflowApplicationSnapshot = {
  scope: WorkflowScope; snapshot: JournalSnapshot | null; origin: WorkflowOrigin | null;
  graph: CompiledWorkflow['graph'] | null; nodes: Array<{
    nodeId: string; run: RunRef | null; state: string; attempts: number; sessionId: string | null; turnId: string | null;
    historySeq: number | null; historyCommitted: boolean; outputRefs: string[]
  }>;
  /** Current live facade facts only; history reads cannot recreate permission resolvers. */
  stageSessions: Array<Pick<AcpSessionMeta, 'sessionId' | 'connectionGeneration' | 'status' | 'pendingPermissions'>>;
  cursor: z.infer<typeof workflowCursorSchema> | null; recoveryRequired: boolean;
  composer: { target: 'ordinary' | 'managed'; feedback: 'unavailable'; reason: string | null }
}
export type WorkflowApplicationEventPage = {
  items: Array<{ event: ExecutionEvent; cursor: z.infer<typeof workflowCursorSchema>; payloadDigest: string }>;
  cursor: z.infer<typeof workflowCursorSchema>; resetRequired: boolean; hasMore: boolean
}
