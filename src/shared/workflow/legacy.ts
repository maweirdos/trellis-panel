/** Read-only clean-room adapters; never rewrite legacy files or infer business success. */
import { z } from 'zod'
import { localTaskRefSchema, workflowIdSchema, workflowJsonSchema, type LocalTaskRef, type WorkflowJson } from './identity'
import { legacyFlowSchema, workflowDefinitionSchema, type WorkflowDefinition } from './definition'
import { executorBindingSchema, type ExecutorBinding } from './contracts'
import { definitionRefSchema, type DefinitionRef } from './identity'

export const legacyTaskRecordSchema = z.object({ id: workflowIdSchema, status: z.string() }).catchall(workflowJsonSchema)
export type LegacyTaskSnapshot = { localTask: LocalTaskRef; trellisTaskId: string; localStatus: string; original: WorkflowJson }

export function snapshotLegacyTask(raw: unknown, verifiedLocalTask: LocalTaskRef): LegacyTaskSnapshot {
  const record = legacyTaskRecordSchema.parse(raw)
  return {
    localTask: localTaskRefSchema.parse(verifiedLocalTask),
    trellisTaskId: record.id,
    localStatus: record.status,
    original: workflowJsonSchema.parse(JSON.parse(JSON.stringify(record)))
  }
}

export type LegacyFlowAdaptation =
  | { ok: true; definition: WorkflowDefinition; original: WorkflowJson }
  | { ok: false; code: 'UNSUPPORTED_LEGACY_FLOW'; issues: string[]; original: WorkflowJson }

/** The supplied version/scope/executor are verified by the application boundary, never guessed. */
export function adaptLegacyFlow(raw: unknown, ref: DefinitionRef, executor: ExecutorBinding): LegacyFlowAdaptation {
  const original = workflowJsonSchema.parse(JSON.parse(JSON.stringify(workflowJsonSchema.parse(raw))))
  const parsed = legacyFlowSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, code: 'UNSUPPORTED_LEGACY_FLOW', issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`), original }
  const result = workflowDefinitionSchema.safeParse({ contractVersion: 1, ref: definitionRefSchema.parse(ref), flow: parsed.data, defaultExecutor: executorBindingSchema.parse(executor), nodeBindings: [], trellisPhases: {} })
  if (!result.success) return { ok: false, code: 'UNSUPPORTED_LEGACY_FLOW', issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`), original }
  return { ok: true, definition: result.data, original }
}
