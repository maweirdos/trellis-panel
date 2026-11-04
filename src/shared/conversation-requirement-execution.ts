import { z } from 'zod'
import type { AcpSessionMeta, ProjectSnapshot } from './types'
import type { RequirementTask } from './conversation-requirements'

export const requirementExecutionPrepareSchema = z.object({
  commandId: z.string().uuid(), expectedHandoffCommandId: z.string().uuid(), expectedPlanRevision: z.string().uuid(),
  agentId: z.string().min(1).max(100).regex(/^[\w.-]+$/), profileId: z.string().min(1).max(200).optional(),
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), reviewClassification: z.enum(['lightweight', 'complex']).optional(),
  planningWrite: z.object({ file: z.enum(['design.md', 'implement.md']), body: z.string().max(200_000).refine(value => new TextEncoder().encode(value).byteLength <= 256 * 1024), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict().optional()
}).strict()
export type RequirementExecutionPrepare = z.infer<typeof requirementExecutionPrepareSchema>
/** Preparation activates the task; only the existing managed preview/start may run stages. */
export interface RequirementExecutionPreparation {
  commandId: string
  state: 'review-required' | 'not-admitted' | 'preparing' | 'prepared' | 'failed' | 'uncertain'
  review?: { digest: string; files: Array<{ path: string; digest: string; text: string }> }
  /** This call only observes/reconciles the original preparation; it admits no new native effect. */
  existing?: boolean
  /** Explicitly not admitted; the caller may check again under the same command ID. */
  retryable?: boolean
  task: RequirementTask
  activation: { contextKey: string; taskPath: string; scope: 'preparation'; verified: boolean }
  session?: AcpSessionMeta
  origin?: { sessionId: string; connectionGeneration: string }
  snapshot?: ProjectSnapshot
  detail?: string
}
