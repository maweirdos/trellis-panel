/** Main-only integration contract. Parsing is not remote authorization. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { materialVersionSchema, workflowDigestSchema, workflowIdSchema, type WorkflowScope, type RunRef } from '../../../shared/workflow'
import { WorkflowMaterialStore, type PreparedWorkflowContext } from '../workflow-runtime'
import { WorkflowApplicationError } from './types'

export const WORKFLOW_FEEDBACK_META = '__trellisWorkflowFeedback'
export const applicationFeedbackBatchSchema = z.object({
  instanceId: workflowIdSchema, batchId: workflowIdSchema,
  revision: z.number().int().positive().safe(), manifestDigest: workflowDigestSchema,
  timing: z.enum(['boundary', 'now', 'after-run'])
}).strict()
const externalSource = z.object({ kind: z.literal('external'), instanceId: workflowIdSchema, objectId: workflowIdSchema }).strict()
const materialInputSchema = z.object({
  source: externalSource, version: workflowIdSchema,
  kind: materialVersionSchema.shape.kind, sourceDigest: workflowDigestSchema,
  text: z.string().max(1024 * 1024), purpose: z.enum(['baseline', 'delta']),
  reason: z.string().min(1).max(1000)
}).strict()
const resolvedSchema = z.object({ batch: applicationFeedbackBatchSchema, materials: z.array(materialInputSchema).min(2).max(50) }).strict()
const pinSchema = z.object({ ref: z.string().regex(/^wm-[0-9a-f]{64}$/), purpose: z.enum(['baseline', 'delta']), material: materialVersionSchema }).strict()
export const applicationFeedbackMetadataSchema = z.object({ schemaVersion: z.literal(1), batch: applicationFeedbackBatchSchema, pins: z.array(pinSchema).min(2).max(50) }).strict()
export type ApplicationFeedbackBatch = z.infer<typeof applicationFeedbackBatchSchema>
export type ApplicationFeedbackMetadata = z.infer<typeof applicationFeedbackMetadataSchema>
export type ApplicationFeedbackMaterialInput = z.infer<typeof materialInputSchema>
export type ApplicationFeedbackResolver = (context: { scope: WorkflowScope; taskDir: string }) => Promise<{
  batch: ApplicationFeedbackBatch; materials: ApplicationFeedbackMaterialInput[];
  /** Recheck original connection/current remote ACL and exact selected manifest. */
  assertCurrent: () => void | Promise<void>
}>
export type PreparedApplicationFeedback = {
  metadata: ApplicationFeedbackMetadata;
  selections: Array<{ owner: WorkflowScope; ref: string; purpose: 'baseline' | 'delta'; reason: string }>;
  assertCurrent: () => void | Promise<void>
}
export type ApplicationFeedbackPreview<T> = { preview: T; feedback: ApplicationFeedbackMetadata; predecessor: RunRef | null }

export async function captureApplicationFeedback(store: WorkflowMaterialStore, context: { scope: WorkflowScope; taskDir: string }, resolver: ApplicationFeedbackResolver): Promise<PreparedApplicationFeedback> {
  const returned = await resolver({ scope: { ...context.scope }, taskDir: context.taskDir })
  if (typeof returned?.assertCurrent !== 'function') throw new WorkflowApplicationError('INVALID_INPUT', 'A main-owned current authorization assertion is required for selected feedback')
  const selected = resolvedSchema.parse({ batch: returned.batch, materials: returned.materials })
  if (!selected.materials.some((item) => item.purpose === 'baseline') || !selected.materials.some((item) => item.purpose === 'delta' && item.kind === 'feedback')) throw new WorkflowApplicationError('INVALID_INPUT', 'Selected feedback needs its fixed baseline and feedback delta')
  const identities = new Set<string>()
  const pins: ApplicationFeedbackMetadata['pins'] = []
  const selections: PreparedApplicationFeedback['selections'] = []
  for (const input of selected.materials) {
    const identity = JSON.stringify([input.source, input.version])
    if (identities.has(identity)) throw new WorkflowApplicationError('INVALID_INPUT', 'Selected feedback contains duplicate source versions')
    identities.add(identity)
    if (input.source.instanceId !== selected.batch.instanceId) throw new WorkflowApplicationError('SCOPE_CHANGED', 'Selected feedback sources belong to another service instance')
    const bytes = Buffer.from(input.text, 'utf8')
    if (bytes.toString('utf8') !== input.text || createHash('sha256').update(bytes).digest('hex') !== input.sourceDigest) throw new WorkflowApplicationError('MATERIAL_CHANGED', 'Selected feedback source digest does not match its exact Unicode bytes')
    const material = await store.captureText({ owner: context.scope, source: input.source, kind: input.kind, text: input.text, version: input.version })
    pins.push({ ref: material.ref, purpose: input.purpose, material: material.material })
    selections.push({ owner: { ...context.scope }, ref: material.ref, purpose: input.purpose, reason: input.reason })
  }
  await returned.assertCurrent()
  return { metadata: applicationFeedbackMetadataSchema.parse({ schemaVersion: 1, batch: selected.batch, pins }), selections, assertCurrent: returned.assertCurrent }
}

/** A prefix of feedback is not proof the complete selected opinion was supplied. */
export function assertApplicationFeedbackIncluded(context: PreparedWorkflowContext, selected?: PreparedApplicationFeedback): void {
  if (!selected) return
  for (const pin of selected.metadata.pins) {
    const entry = context.entries.find((candidate) => candidate.ref === pin.ref)
    if (!entry || entry.material.inclusion !== 'full' || entry.material.includedDigest !== pin.material.sourceDigest) throw new WorkflowApplicationError('CAPACITY_EXCEEDED', 'The complete selected feedback and baseline must fit the admitted context budget; narrow the batch before adoption')
  }
}
