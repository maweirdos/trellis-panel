import { z } from 'zod'
import type { IpcFail } from './ipc-errors'
import { cruxWorkQuerySchema } from './crux-work'
import { teamTaskProgressDtoSchema, teamTaskProgressStateSchema } from './team-task-progress'
import type { AcpSessionRecord, AcpPromptResult } from './types'
import type { AcpHistoryEventPage } from './acp-history'

export const cruxProgressQuerySchema = cruxWorkQuerySchema
export const cruxProgressTakeoverSchema = z.object({ expectedGeneration: z.number().int().nonnegative().safe(), expectedBindingId: z.string().uuid().nullable() }).strict()
export const cruxProgressStartSchema = cruxProgressQuerySchema.extend({
  engine: z.enum(['pi', 'acp']), agentId: z.string().min(1).max(200).regex(/^[\w.-]+$/).optional(), takeover: cruxProgressTakeoverSchema.optional()
}).strict()
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
  session: cruxProgressSessionSchema.nullable(), inputVersion: z.string(),
  creationSessionId: z.string().max(256).optional(), creationRecoveryRequired: z.boolean().optional(),
  workcopyRoot: z.string().max(8192).optional(),
  dispatch: z.enum(['not_sent', 'dispatching', 'sent', 'unknown']),
  /** An app-managed working directory is an application permission scope, not an OS sandbox. */
  managedDirectory: z.boolean()
}).strict()
export const cruxProgressValueSchema = z.object({
  workspaceKey: z.string(), taskId: z.string(), server: teamTaskProgressDtoSchema.nullable(),
  freshness: z.enum(['remote', 'pending', 'cached-offline']), local: cruxProgressLocalSchema.nullable()
}).strict()
export const cruxProgressSendSchema = cruxProgressQuerySchema.extend({ text: z.string().trim().min(1).max(128 * 1024), expectedConnectionGeneration: z.string().min(1).max(200) }).strict()
export const cruxProgressRespondSchema = cruxProgressQuerySchema.extend({ requestId: z.string().min(1).max(200), optionId: z.string().min(1).max(1000), expectedConnectionGeneration: z.string().min(1).max(200) }).strict()
export const cruxProgressEventsSchema = cruxProgressQuerySchema.extend({ before: z.string().max(2048).optional(), after: z.string().max(2048).optional(), limit: z.number().int().min(1).max(800).optional() }).strict()
export type CruxProgressQuery = z.infer<typeof cruxProgressQuerySchema>
export type CruxProgressStartInput = z.infer<typeof cruxProgressStartSchema>
export type CruxProgressReportInput = z.infer<typeof cruxProgressReportSchema>
export type CruxProgressSession = z.infer<typeof cruxProgressSessionSchema>
export type CruxProgressValue = z.infer<typeof cruxProgressValueSchema>
export type CruxProgressResult = { ok: true; value: CruxProgressValue } | (IpcFail & { value?: CruxProgressValue; outcomeUnknown?: boolean })
/** Native-only. Browser hosting leaves this capability absent. Poll status for bounded summaries. */
export interface CruxProgressApi {
  status(input: CruxProgressQuery): Promise<CruxProgressResult>
  start(input: CruxProgressStartInput): Promise<CruxProgressResult>
  report(input: CruxProgressReportInput): Promise<CruxProgressResult>
  retry(input: CruxProgressQuery): Promise<CruxProgressResult>
  detach(input: CruxProgressQuery): Promise<CruxProgressResult>
  conversation?(input: CruxProgressQuery): Promise<{ ok: true; session: AcpSessionRecord } | IpcFail>
  events?(input: z.infer<typeof cruxProgressEventsSchema>): Promise<AcpHistoryEventPage | IpcFail>
  send?(input: z.infer<typeof cruxProgressSendSchema>): Promise<AcpPromptResult>
  respond?(input: z.infer<typeof cruxProgressRespondSchema>): Promise<{ ok: true } | IpcFail>
  cancel?(input: CruxProgressQuery): Promise<{ ok: true } | IpcFail>
  resume?(input: CruxProgressQuery): Promise<{ ok: true; sessionId: string } | IpcFail>
}
