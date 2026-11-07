import { z } from 'zod'
import type { IpcFail } from './ipc-errors'
import { cruxTaskWorkKindSchema, cruxTaskWorkflowArtifactSchema } from './crux-schema'
import { creationMaterialReferenceSchema } from './creation-materials'
import { taskMaterialInputReferenceSchema } from './task-material-inputs'
import { governanceVersionSchema } from './team-governance'

export const cruxGovernanceInputSchema = z.object({
  bundleId: z.string().uuid(), revision: z.number().int().positive().safe(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  rules: z.array(governanceVersionSchema).max(64), template: governanceVersionSchema.nullable()
}).strict()
export type CruxGovernanceInput = z.infer<typeof cruxGovernanceInputSchema>
export type CruxTeamInputSelection = { references: z.infer<typeof taskMaterialInputReferenceSchema>[]; governance?: CruxGovernanceInput }
export function cruxGovernanceInputPath(kind: 'rule' | 'workflow-template', packageId: string, versionId: string): string {
  z.string().uuid().parse(packageId); z.string().uuid().parse(versionId)
  return `references/${kind === 'rule' ? 'rules' : 'templates'}/${packageId}/${versionId}.md`
}

const sourceArtifact = cruxTaskWorkflowArtifactSchema.pick({ id: true, kind: true, body: true, actorId: true, at: true }).extend({ kind: z.enum(['requirements', 'design', 'acceptance']) }).strict()
export const cruxWorkMaterialSchema = z.object({
  title: z.string().min(1).max(500), description: z.string().default(''), workKind: cruxTaskWorkKindSchema.default('code'),
  acceptanceCriteria: z.array(z.string()).default([]), artifacts: z.array(sourceArtifact).default([]),
  creationReferences: z.array(creationMaterialReferenceSchema).max(20).optional(),
  teamMaterialReferences: z.array(taskMaterialInputReferenceSchema).max(4).optional(), governance: cruxGovernanceInputSchema.optional()
}).strict()
export type CruxWorkMaterial = z.infer<typeof cruxWorkMaterialSchema>

const id = z.string().min(1).max(256)
export const cruxWorkQuerySchema = z.object({ workspaceKey: id, taskId: id }).strict()
/** projectRoot is an expected native binding/current root, never a renderer path grant. */
export const cruxWorkPrepareSchema = cruxWorkQuerySchema.extend({ projectRoot: z.string().min(1).max(8192).optional(), candidateId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
export type CruxWorkQuery = z.infer<typeof cruxWorkQuerySchema>
export type CruxWorkPrepareInput = z.infer<typeof cruxWorkPrepareSchema>

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const cruxDevelopmentRefSchema = z.object({ contextId: id, generation: z.number().int().positive().safe() }).strict()
export const cruxDevelopmentContextSchema = cruxDevelopmentRefSchema.extend({
  taskCreatedAt: z.string().min(1).max(64), inputVersion: digest, branch: z.string().max(4096).nullable(), head: z.string().max(128).nullable()
}).strict()
export type CruxDevelopmentRef = z.infer<typeof cruxDevelopmentRefSchema>
export type CruxDevelopmentContext = z.infer<typeof cruxDevelopmentContextSchema>
export const cruxDevelopmentTargetSchema = cruxWorkQuerySchema.extend({ expected: cruxDevelopmentRefSchema }).strict()
export type CruxDevelopmentTarget = z.infer<typeof cruxDevelopmentTargetSchema>
export const cruxWorkChangeSchema = cruxWorkQuerySchema.extend({
  commandId: z.string().uuid(), expected: cruxDevelopmentRefSchema, expectedInputVersion: digest,
  mode: z.enum(['choose-copy', 'adopt-inputs']), candidateId: digest.optional()
}).strict().refine((input) => input.mode === 'choose-copy' || input.candidateId === undefined, 'Input adoption retains the original copy')
export type CruxWorkChangeInput = z.infer<typeof cruxWorkChangeSchema>

export const cruxWorkResourceBindingSchema = z.object({
  resourceId: z.string().uuid(), selectionRevision: z.number().int().positive(), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  taskCreatedAt: z.string().min(1).max(64), projectIdentity: z.string().regex(/^[a-f0-9]{64}$/)
}).strict()
export type CruxWorkResourceBinding = z.infer<typeof cruxWorkResourceBindingSchema>

export const cruxWorkLocalSchema = z.object({
  projectRoot: z.string(), taskDir: z.string(), taskId: z.string(), relativeDir: z.string(),
  phase: z.enum(['plan', 'implement', 'review', 'completed', 'unknown']), archived: z.boolean(),
  resourceBinding: cruxWorkResourceBindingSchema.optional(), development: cruxDevelopmentContextSchema.optional()
}).strict()
export type CruxWorkLocal = z.infer<typeof cruxWorkLocalSchema>

export const cruxDevelopmentSummarySchema = z.object({
  ref: cruxDevelopmentRefSchema, projectRoot: z.string().min(1).max(8192), title: z.string().max(500),
  taskDir: z.string().nullable(), inputVersion: digest, taskCreatedAt: z.string().nullable(),
  branch: z.string().nullable(), head: z.string().nullable(), createdAt: z.number().nullable(),
  stage: z.enum(['registered', 'dispatching', 'failed', 'uncertain', 'cli_created', 'ready']),
  resourceId: z.string().uuid().nullable(), changeCommandId: z.string().uuid().nullable(), previousContextId: id.nullable()
}).strict()
export type CruxDevelopmentSummary = z.infer<typeof cruxDevelopmentSummarySchema>
export const cruxProjectCandidateSchema = z.object({ id: digest, resourceId: z.string().uuid(), projectRoot: z.string().max(8192), projectIdentity: digest, checkedAt: z.number().int().nonnegative() }).strict()
export type CruxProjectCandidate = z.infer<typeof cruxProjectCandidateSchema>
export type CruxDevelopmentView = {
  ok: true; active: CruxDevelopmentSummary | null; history: CruxDevelopmentSummary[]; historyHasMore: boolean;
  candidates: CruxProjectCandidate[]; currentInputVersion: string | null; sourceError?: string; sourceReason?: CruxWorkFailureReason
} | CruxWorkFailure

export type CruxWorkFailureReason =
  | 'invalid_input' | 'scope_changed' | 'access_locked' | 'not_handler' | 'cancelled'
  | 'project_invalid' | 'project_changed' | 'store_unavailable' | 'cli_failed'
  | 'outcome_unknown' | 'task_missing' | 'task_conflict' | 'source_changed' | 'prd_conflict'
  | 'resource_required' | 'resource_changed' | 'repository_mismatch'
  | 'material_review_required' | 'binding_review_required' | 'workcopy_in_use'
export type CruxWorkFailure = IpcFail & {
  reason: CruxWorkFailureReason
  outcomeUnknown?: boolean
  reviewRequired?: boolean
  local?: CruxWorkLocal
}
export type CruxWorkResult =
  | { ok: true; workspaceKey: string; taskId: string; prepared: false; local: null }
  | {
      ok: true; workspaceKey: string; taskId: string; prepared: true; local: CruxWorkLocal
      created: boolean; reused: boolean; sourceRevision: string; preparedRevision: string
      reviewRequired: boolean; prdModified: boolean; notes: string[]
    }
  | CruxWorkFailure

/** Native desktop capability. Browser hosting must leave this bridge unavailable. */
export type CruxWorkApi = {
  status(input: CruxWorkQuery): Promise<CruxWorkResult>
  prepare(input: CruxWorkPrepareInput): Promise<CruxWorkResult>
  development(input: CruxWorkQuery): Promise<CruxDevelopmentView>
  change(input: CruxWorkChangeInput): Promise<CruxWorkResult>
}
