/** Read-only recovery requests carry no task scope, owner, path or native grant. */
import { z } from 'zod'
import { runRefSchema, type WorkflowScope } from './workflow'
import type { WorkflowApplicationSnapshot } from './workflow-application'

export const workflowWorkspaceRecoveryInputSchema = z.object({ run: runRefSchema.optional() }).strict()
export const workflowRecoveryArtifactInputSchema = z.object({ run: runRefSchema, ref: z.string().regex(/^wm-[0-9a-f]{64}$/) }).strict()
export type WorkflowWorkspaceRecoveryInput = z.infer<typeof workflowWorkspaceRecoveryInputSchema>
export type WorkflowRecoveryArtifactInput = z.infer<typeof workflowRecoveryArtifactInputSchema>
export type WorkflowRecoverySource = {
  state: 'unknown' | 'available' | 'missing' | 'ambiguous' | 'unavailable';
  alias: { currentDir: string; trellisTaskId: string | null; status: 'verified' | 'pending_confirmation' | 'missing' } | null;
  /** Exact taskRef matches for display only, never permission to mutate a path. */
  candidates: string[]; reason: string | null
}
export type WorkflowWorkspaceRecovery = {
  scope: WorkflowScope | null;
  ownership: { state: 'active' | 'recovery-required' | 'released'; leaseUntil: number; recoveryRequired: boolean } | null;
  projection: WorkflowApplicationSnapshot | null;
  source: WorkflowRecoverySource
}
