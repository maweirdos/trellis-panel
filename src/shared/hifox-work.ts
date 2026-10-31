import { z } from 'zod'
import type { IpcFail } from './ipc-errors'
import { hifoxTaskWorkKindSchema, hifoxTaskWorkflowArtifactSchema } from './hifox-schema'
import { creationMaterialReferenceSchema } from './creation-materials'
import { taskMaterialInputReferenceSchema } from './task-material-inputs'
import { governanceVersionSchema } from './team-governance'

export const hifoxGovernanceInputSchema = z.object({
  bundleId: z.string().uuid(), revision: z.number().int().positive().safe(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  rules: z.array(governanceVersionSchema).max(64), template: governanceVersionSchema.nullable()
}).strict()
export type HifoxGovernanceInput = z.infer<typeof hifoxGovernanceInputSchema>
export type HifoxTeamInputSelection = { references: z.infer<typeof taskMaterialInputReferenceSchema>[]; governance?: HifoxGovernanceInput }
export function hifoxGovernanceInputPath(kind: 'rule' | 'workflow-template', packageId: string, versionId: string): string {
  z.string().uuid().parse(packageId); z.string().uuid().parse(versionId)
  return `references/${kind === 'rule' ? 'rules' : 'templates'}/${packageId}/${versionId}.md`
}

const sourceArtifact = hifoxTaskWorkflowArtifactSchema.pick({ id: true, kind: true, body: true, actorId: true, at: true }).extend({ kind: z.enum(['requirements', 'design', 'acceptance']) }).strict()
export const hifoxWorkMaterialSchema = z.object({
  title: z.string().min(1).max(500), description: z.string().default(''), workKind: hifoxTaskWorkKindSchema.default('code'),
  acceptanceCriteria: z.array(z.string()).default([]), artifacts: z.array(sourceArtifact).default([]),
  creationReferences: z.array(creationMaterialReferenceSchema).max(20).optional(),
  teamMaterialReferences: z.array(taskMaterialInputReferenceSchema).max(4).optional(), governance: hifoxGovernanceInputSchema.optional()
}).strict()
export type HifoxWorkMaterial = z.infer<typeof hifoxWorkMaterialSchema>

const id = z.string().min(1).max(256)
export const hifoxWorkQuerySchema = z.object({ workspaceKey: id, taskId: id }).strict()
/** projectRoot is an expected native binding/current root, never a renderer path grant. */
export const hifoxWorkPrepareSchema = hifoxWorkQuerySchema.extend({ projectRoot: z.string().min(1).max(8192).optional(), candidateId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
export type HifoxWorkQuery = z.infer<typeof hifoxWorkQuerySchema>
export type HifoxWorkPrepareInput = z.infer<typeof hifoxWorkPrepareSchema>

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const hifoxDevelopmentRefSchema = z.object({ contextId: id, generation: z.number().int().positive().safe() }).strict()
export const hifoxDevelopmentContextSchema = hifoxDevelopmentRefSchema.extend({
  taskCreatedAt: z.string().min(1).max(64), inputVersion: digest, branch: z.string().max(4096).nullable(), head: z.string().max(128).nullable()
}).strict()
export type HifoxDevelopmentRef = z.infer<typeof hifoxDevelopmentRefSchema>
export type HifoxDevelopmentContext = z.infer<typeof hifoxDevelopmentContextSchema>
export const hifoxDevelopmentTargetSchema = hifoxWorkQuerySchema.extend({ expected: hifoxDevelopmentRefSchema }).strict()
export type HifoxDevelopmentTarget = z.infer<typeof hifoxDevelopmentTargetSchema>
export const hifoxWorkChangeSchema = hifoxWorkQuerySchema.extend({
  commandId: z.string().uuid(), expected: hifoxDevelopmentRefSchema, expectedInputVersion: digest,
  mode: z.enum(['choose-copy', 'adopt-inputs']), candidateId: digest.optional()
}).strict().refine((input) => input.mode === 'choose-copy' || input.candidateId === undefined, 'Input adoption retains the original copy')
export type HifoxWorkChangeInput = z.infer<typeof hifoxWorkChangeSchema>

export const hifoxWorkResourceBindingSchema = z.object({
  resourceId: z.string().uuid(), selectionRevision: z.number().int().positive(), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  taskCreatedAt: z.string().min(1).max(64), projectIdentity: z.string().regex(/^[a-f0-9]{64}$/)
}).strict()
export type HifoxWorkResourceBinding = z.infer<typeof hifoxWorkResourceBindingSchema>

export const hifoxWorkLocalSchema = z.object({
  projectRoot: z.string(), taskDir: z.string(), taskId: z.string(), relativeDir: z.string(),
  phase: z.enum(['plan', 'implement', 'review', 'completed', 'unknown']), archived: z.boolean(),
  resourceBinding: hifoxWorkResourceBindingSchema.optional(), development: hifoxDevelopmentContextSchema.optional()
}).strict()
export type HifoxWorkLocal = z.infer<typeof hifoxWorkLocalSchema>

export const hifoxDevelopmentSummarySchema = z.object({
  ref: hifoxDevelopmentRefSchema, projectRoot: z.string().min(1).max(8192), title: z.string().max(500),
  taskDir: z.string().nullable(), inputVersion: digest, taskCreatedAt: z.string().nullable(),
  branch: z.string().nullable(), head: z.string().nullable(), createdAt: z.number().nullable(),
  stage: z.enum(['registered', 'dispatching', 'failed', 'uncertain', 'cli_created', 'ready']),
  resourceId: z.string().uuid().nullable(), changeCommandId: z.string().uuid().nullable(), previousContextId: id.nullable()
}).strict()
export type HifoxDevelopmentSummary = z.infer<typeof hifoxDevelopmentSummarySchema>
export const hifoxProjectCandidateSchema = z.object({ id: digest, resourceId: z.string().uuid(), projectRoot: z.string().max(8192), projectIdentity: digest, checkedAt: z.number().int().nonnegative() }).strict()
export type HifoxProjectCandidate = z.infer<typeof hifoxProjectCandidateSchema>
export type HifoxDevelopmentView = {
  ok: true; active: HifoxDevelopmentSummary | null; history: HifoxDevelopmentSummary[]; historyHasMore: boolean;
  candidates: HifoxProjectCandidate[]; currentInputVersion: string | null; sourceError?: string; sourceReason?: HifoxWorkFailureReason
} | HifoxWorkFailure

export type HifoxWorkFailureReason =
  | 'invalid_input' | 'scope_changed' | 'access_locked' | 'not_handler' | 'cancelled'
  | 'project_invalid' | 'project_changed' | 'store_unavailable' | 'cli_failed'
  | 'outcome_unknown' | 'task_missing' | 'task_conflict' | 'source_changed' | 'prd_conflict'
  | 'resource_required' | 'resource_changed' | 'repository_mismatch'
  | 'material_review_required' | 'binding_review_required' | 'workcopy_in_use'
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
  development(input: HifoxWorkQuery): Promise<HifoxDevelopmentView>
  change(input: HifoxWorkChangeInput): Promise<HifoxWorkResult>
}
