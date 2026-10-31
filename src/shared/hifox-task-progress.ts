import { z } from 'zod'
import type { IpcFail } from './ipc-errors'
import { hifoxWorkQuerySchema } from './hifox-work'
import { teamTaskProgressDtoSchema, teamTaskProgressStateSchema } from './team-task-progress'
import type { AcpSessionRecord, AcpPromptResult } from './types'
import type { AcpHistoryEventPage } from './acp-history'

export const hifoxProgressQuerySchema = hifoxWorkQuerySchema
export const hifoxProgressTakeoverSchema = z.object({ expectedGeneration: z.number().int().nonnegative().safe(), expectedBindingId: z.string().uuid().nullable() }).strict()
export const hifoxProgressStartSchema = hifoxProgressQuerySchema.extend({
  engine: z.enum(['pi', 'acp']), agentId: z.string().min(1).max(200).regex(/^[\w.-]+$/).optional(), takeover: hifoxProgressTakeoverSchema.optional()
}).strict()
const summary = z.string().trim().min(1).max(500).refine(value => !/[\r\n\u0000-\u001f\u007f]/.test(value), 'Use a short single-line summary')
/** Entire summary replacement. Null clears a previous step/blocker. No tool/log/token fields. */
export const hifoxProgressReportSchema = hifoxProgressQuerySchema.extend({
  activity: teamTaskProgressStateSchema, step: summary.nullable(), blocker: summary.nullable(), takeover: hifoxProgressTakeoverSchema.optional()
}).strict()
export const hifoxProgressSessionSchema = z.object({
  sessionId: z.string(), backendSessionId: z.string().nullable(), connectionGeneration: z.string(),
  projectRoot: z.string(), cwd: z.string(), taskDir: z.string().nullable(), engine: z.enum(['pi', 'acp'])
}).strict()
export const hifoxProgressLocalSchema = z.object({
  state: z.enum(['preparing', 'binding', 'active', 'releasing', 'detached', 'stopped']),
  pendingCount: z.number().int().nonnegative(), outcomeUnknown: z.boolean(), errorCode: z.string().nullable(),
  ownsBinding: z.boolean(),
  session: hifoxProgressSessionSchema.nullable(), inputVersion: z.string(),
  creationSessionId: z.string().max(256).optional(), creationRecoveryRequired: z.boolean().optional(),
  workcopyRoot: z.string().max(8192).optional(),
  dispatch: z.enum(['not_sent', 'dispatching', 'sent', 'unknown']),
  /** An app-managed working directory is an application permission scope, not an OS sandbox. */
  managedDirectory: z.boolean()
}).strict()
export const hifoxProgressValueSchema = z.object({
  workspaceKey: z.string(), taskId: z.string(), server: teamTaskProgressDtoSchema.nullable(),
  freshness: z.enum(['remote', 'pending', 'cached-offline']), local: hifoxProgressLocalSchema.nullable()
}).strict()
export const hifoxProgressSendSchema = hifoxProgressQuerySchema.extend({ text: z.string().trim().min(1).max(128 * 1024), expectedConnectionGeneration: z.string().min(1).max(200) }).strict()
export const hifoxProgressRespondSchema = hifoxProgressQuerySchema.extend({ requestId: z.string().min(1).max(200), optionId: z.string().min(1).max(1000), expectedConnectionGeneration: z.string().min(1).max(200) }).strict()
export const hifoxProgressEventsSchema = hifoxProgressQuerySchema.extend({ before: z.string().max(2048).optional(), after: z.string().max(2048).optional(), limit: z.number().int().min(1).max(800).optional() }).strict()
export type HifoxProgressQuery = z.infer<typeof hifoxProgressQuerySchema>
export type HifoxProgressStartInput = z.infer<typeof hifoxProgressStartSchema>
export type HifoxProgressReportInput = z.infer<typeof hifoxProgressReportSchema>
export type HifoxProgressSession = z.infer<typeof hifoxProgressSessionSchema>
export type HifoxProgressValue = z.infer<typeof hifoxProgressValueSchema>
export type HifoxProgressResult = { ok: true; value: HifoxProgressValue } | (IpcFail & { value?: HifoxProgressValue; outcomeUnknown?: boolean })
/** Native-only. Browser hosting leaves this capability absent. Poll status for bounded summaries. */
export interface HifoxProgressApi {
  status(input: HifoxProgressQuery): Promise<HifoxProgressResult>
  start(input: HifoxProgressStartInput): Promise<HifoxProgressResult>
  report(input: HifoxProgressReportInput): Promise<HifoxProgressResult>
  retry(input: HifoxProgressQuery): Promise<HifoxProgressResult>
  detach(input: HifoxProgressQuery): Promise<HifoxProgressResult>
  conversation?(input: HifoxProgressQuery): Promise<{ ok: true; session: AcpSessionRecord } | IpcFail>
  events?(input: z.infer<typeof hifoxProgressEventsSchema>): Promise<AcpHistoryEventPage | IpcFail>
  send?(input: z.infer<typeof hifoxProgressSendSchema>): Promise<AcpPromptResult>
  respond?(input: z.infer<typeof hifoxProgressRespondSchema>): Promise<{ ok: true } | IpcFail>
  cancel?(input: HifoxProgressQuery): Promise<{ ok: true } | IpcFail>
  resume?(input: HifoxProgressQuery): Promise<{ ok: true; sessionId: string } | IpcFail>
}
