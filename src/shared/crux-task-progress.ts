import { z } from 'zod'
import type { IpcFail } from './ipc-errors'
import { cruxWorkQuerySchema } from './crux-work'
import { teamTaskProgressDtoSchema, teamTaskProgressStateSchema } from './team-task-progress'

export const cruxProgressQuerySchema = cruxWorkQuerySchema
export const cruxProgressTakeoverSchema = z.object({ expectedGeneration: z.number().int().nonnegative().safe(), expectedBindingId: z.string().uuid().nullable() }).strict()
const summary = z.string().trim().min(1).max(500).refine(value => !/[\r\n\u0000-\u001f\u007f]/.test(value), 'Use a short single-line summary')
/** Entire summary replacement. Null clears a previous step/blocker. No tool/log/token fields. */
export const cruxProgressReportSchema = cruxProgressQuerySchema.extend({
  activity: teamTaskProgressStateSchema, step: summary.nullable(), blocker: summary.nullable(), takeover: cruxProgressTakeoverSchema.optional()
}).strict()
export const cruxProgressSessionSchema = z.object({
  sessionId: z.string(), backendSessionId: z.string().nullable(), connectionGeneration: z.string(),
  projectRoot: z.string(), cwd: z.string(), taskDir: z.string().nullable(), engine: z.enum(['pi', 'acp'])
}).strict()
export const cruxProgressLocalSchema = z.object({
  state: z.enum(['preparing', 'binding', 'active', 'releasing', 'detached', 'stopped']),
  pendingCount: z.number().int().nonnegative(), outcomeUnknown: z.boolean(), errorCode: z.string().nullable(),
  ownsBinding: z.boolean(),
  inputVersion: z.string(),
  cleanupRequired: z.boolean()
}).strict()
export const cruxProgressValueSchema = z.object({
  workspaceKey: z.string(), taskId: z.string(), server: teamTaskProgressDtoSchema.nullable(),
  freshness: z.enum(['remote', 'pending', 'cached-offline']), local: cruxProgressLocalSchema.nullable()
}).strict()
export type CruxProgressQuery = z.infer<typeof cruxProgressQuerySchema>
export type CruxProgressReportInput = z.infer<typeof cruxProgressReportSchema>
export type CruxProgressSession = z.infer<typeof cruxProgressSessionSchema>
export type CruxProgressValue = z.infer<typeof cruxProgressValueSchema>
export type CruxProgressResult = { ok: true; value: CruxProgressValue } | (IpcFail & { value?: CruxProgressValue; outcomeUnknown?: boolean })
/** Native-only. Browser hosting leaves this capability absent. Poll status for bounded summaries. */
export interface CruxProgressApi {
  status(input: CruxProgressQuery): Promise<CruxProgressResult>
  report(input: CruxProgressReportInput): Promise<CruxProgressResult>
  retry(input: CruxProgressQuery): Promise<CruxProgressResult>
  detach(input: CruxProgressQuery): Promise<CruxProgressResult>
}
