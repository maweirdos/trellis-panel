/** Revision intent DTOs; root/scope/executor ownership remains main-derived. */
import { z } from 'zod'
import { workflowIdSchema, runRefSchema, workflowJsonSchema, workflowScopeSchema, workflowDigestSchema, definitionRefSchema, workflowLayoutSchema } from './workflow'
import { managedTaskDirSchema } from './workflow-application'

export const workflowRevisionPreviewInputSchema = z.object({
  taskDir: managedTaskDirSchema, run: runRefSchema, flowId: workflowIdSchema,
  reason: z.string().trim().min(1).max(2000), boundary: z.enum(['after-current-stage', 'now']),
  startStepId: workflowIdSchema.optional(), inputs: z.record(workflowIdSchema, workflowJsonSchema).default({})
}).strict()
export const workflowRevisionAcceptInputSchema = z.object({ taskDir: managedTaskDirSchema, run: runRefSchema, previewId: workflowIdSchema, commandId: workflowIdSchema }).strict()
export const workflowRevisionStatusInputSchema = z.object({ taskDir: managedTaskDirSchema, commandId: workflowIdSchema }).strict()
export const workflowRevisionGraphSchema = z.object({
  nodes: z.array(z.object({ nodeId: z.string().min(1).max(4096), phaseId: workflowIdSchema, label: z.string().max(10000), kind: z.enum(['agent', 'tool', 'gate']) }).strict()).min(1).max(64),
  edges: z.array(z.object({ edgeId: z.string().min(1).max(20000), from: z.string().max(4096), to: z.string().max(4096), kind: z.enum(['sequence', 'retry', 'feedback', 'check']), maxRetries: z.number().int().nonnegative().optional() }).strict()).max(256),
  layout: workflowLayoutSchema
}).strict()
export const workflowRevisionImpactSchema = z.object({
  nodes: z.array(z.object({ stepId: workflowIdSchema, before: z.string().nullable(), after: z.string().nullable(), change: z.enum(['added', 'removed', 'changed', 'unchanged']), affected: z.boolean() }).strict()).max(128),
  edges: z.array(z.object({ before: z.string().nullable(), after: z.string().nullable(), change: z.enum(['added', 'removed', 'changed', 'unchanged']) }).strict()).max(512),
  affectedNodeIds: z.array(z.string()).max(128), preservedNodeIds: z.array(z.string()).max(128),
  materials: z.array(z.object({ ref: z.string().regex(/^wm-[0-9a-f]{64}$/), nodeId: z.string(), run: runRefSchema, state: z.string(), reuse: z.literal('input-only') }).strict()).max(256),
  pendingBoundaryOutput: z.string().nullable(), automaticExecutionReuse: z.literal(false)
}).strict()
export const workflowRevisionPreviewSchema = z.object({
  schemaVersion: z.literal(1), state: z.literal('saved'), previewId: workflowIdSchema,
  scope: workflowScopeSchema, taskDir: managedTaskDirSchema, target: runRefSchema,
  definition: definitionRefSchema, flowId: workflowIdSchema, reason: z.string().min(1).max(2000),
  boundary: z.enum(['after-current-stage', 'now']), startStepId: workflowIdSchema,
  before: workflowRevisionGraphSchema, after: workflowRevisionGraphSchema, impact: workflowRevisionImpactSchema,
  fingerprint: workflowDigestSchema, createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  metadataRef: z.string().regex(/^wm-[0-9a-f]{64}$/).optional(),
  limitations: z.array(z.string()).max(20)
}).strict()
export const workflowRevisionStateSchema = z.enum(['saved', 'waiting-boundary', 'stopping', 'stop-unconfirmed', 'stopped', 'successor-starting', 'running', 'adopted', 'failed', 'cancelled', 'recovery-required'])
export type WorkflowRevisionPreviewInput = z.input<typeof workflowRevisionPreviewInputSchema>
export type WorkflowRevisionAcceptInput = z.infer<typeof workflowRevisionAcceptInputSchema>
export type WorkflowRevisionStatusInput = z.infer<typeof workflowRevisionStatusInputSchema>
export type WorkflowRevisionPreview = z.infer<typeof workflowRevisionPreviewSchema>
export type WorkflowRevisionImpact = z.infer<typeof workflowRevisionImpactSchema>
export type WorkflowRevisionState = z.infer<typeof workflowRevisionStateSchema>
export type WorkflowRevisionStatus = {
  commandId: string; previewId: string; target: z.infer<typeof runRefSchema>;
  successor: z.infer<typeof runRefSchema> | null; state: WorkflowRevisionState;
  preview: WorkflowRevisionPreview; evidenceRefs: string[]; recoveryRequired: boolean; reason: string | null
}
