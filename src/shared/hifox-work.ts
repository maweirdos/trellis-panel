import { z } from 'zod'
import type { IpcFail } from './ipc-errors'
import { hifoxTaskWorkKindSchema, hifoxTaskWorkflowArtifactSchema } from './hifox-schema'
import { creationMaterialReferenceSchema } from './creation-materials'

const sourceArtifact = hifoxTaskWorkflowArtifactSchema.pick({ id: true, kind: true, body: true, actorId: true, at: true }).extend({ kind: z.enum(['requirements', 'design', 'acceptance']) }).strict()
export const hifoxWorkMaterialSchema = z.object({
  title: z.string().min(1).max(500), description: z.string().default(''), workKind: hifoxTaskWorkKindSchema.default('code'),
  acceptanceCriteria: z.array(z.string()).default([]), artifacts: z.array(sourceArtifact).default([]),
  creationReferences: z.array(creationMaterialReferenceSchema).max(20).optional()
}).strict()
export type HifoxWorkMaterial = z.infer<typeof hifoxWorkMaterialSchema>

const id = z.string().min(1).max(256)
export const hifoxWorkQuerySchema = z.object({ workspaceKey: id, taskId: id }).strict()
/** projectRoot is an expected native binding/current root, never a renderer path grant. */
export const hifoxWorkPrepareSchema = hifoxWorkQuerySchema.extend({ projectRoot: z.string().min(1).max(8192).optional() }).strict()
export type HifoxWorkQuery = z.infer<typeof hifoxWorkQuerySchema>
export type HifoxWorkPrepareInput = z.infer<typeof hifoxWorkPrepareSchema>

export const hifoxWorkLocalSchema = z.object({
  projectRoot: z.string(), taskDir: z.string(), taskId: z.string(), relativeDir: z.string(),
  phase: z.enum(['plan', 'implement', 'review', 'completed', 'unknown']), archived: z.boolean()
}).strict()
export type HifoxWorkLocal = z.infer<typeof hifoxWorkLocalSchema>

export type HifoxWorkFailureReason =
  | 'invalid_input' | 'scope_changed' | 'access_locked' | 'not_handler' | 'cancelled'
  | 'project_invalid' | 'project_changed' | 'store_unavailable' | 'cli_failed'
  | 'outcome_unknown' | 'task_missing' | 'task_conflict' | 'source_changed' | 'prd_conflict'
export type HifoxWorkFailure = IpcFail & {
  reason: HifoxWorkFailureReason
  outcomeUnknown?: boolean
  reviewRequired?: boolean
  local?: HifoxWorkLocal
}
export type HifoxWorkResult =
  | { ok: true; workspaceKey: string; taskId: string; prepared: false; local: null }
  | {
      ok: true; workspaceKey: string; taskId: string; prepared: true; local: HifoxWorkLocal
      created: boolean; reused: boolean; sourceRevision: string; preparedRevision: string
      reviewRequired: boolean; prdModified: boolean; notes: string[]
    }
  | HifoxWorkFailure

/** Native desktop capability. Browser hosting must leave this bridge unavailable. */
export type HifoxWorkApi = {
  status(input: HifoxWorkQuery): Promise<HifoxWorkResult>
  prepare(input: HifoxWorkPrepareInput): Promise<HifoxWorkResult>
}
