import { z } from 'zod'
import { teamCodeResourceCommandSchema, teamCodeResourceListInputSchema, teamCodeResourceScopeIdSchema,
  type TeamCodeResourceCommandReply, type TeamCodeResourceList, type TeamTaskCodeResourceDto } from './team-code-resources'

const workspaceKey = z.string().min(1).max(1024)
export const cruxResourceListSchema = teamCodeResourceListInputSchema.extend({ workspaceKey }).strict()
export const cruxResourceTaskSchema = z.object({ workspaceKey, taskId: teamCodeResourceScopeIdSchema }).strict()
export const cruxResourceCommandSchema = z.object({ workspaceKey, command: teamCodeResourceCommandSchema }).strict()
export const cruxResourcePendingSchema = z.object({ workspaceKey }).strict()
export const cruxResourceRecoverySchema = z.object({ workspaceKey, commandId: z.string().uuid() }).strict()
export type CruxResourceReply<T> = { ok: true; value: T } | { ok: false; code: string; error: string; outcomeUnknown?: boolean }
export interface CruxResourcePending {
  commandId: string
  kind: z.infer<typeof teamCodeResourceCommandSchema>['kind']
  state: 'pending' | 'unknown' | 'rejected'
  createdAt: number
  error: string | null
}
export interface CruxCodeResourceApi {
  list(input: z.input<typeof cruxResourceListSchema>): Promise<CruxResourceReply<TeamCodeResourceList>>
  task(input: z.input<typeof cruxResourceTaskSchema>): Promise<CruxResourceReply<TeamTaskCodeResourceDto>>
  command(input: z.input<typeof cruxResourceCommandSchema>): Promise<CruxResourceReply<TeamCodeResourceCommandReply>>
  pending(input: z.input<typeof cruxResourcePendingSchema>): Promise<CruxResourceReply<CruxResourcePending[]>>
  reconcile(input: z.input<typeof cruxResourceRecoverySchema>): Promise<CruxResourceReply<TeamCodeResourceCommandReply | null>>
  retry(input: z.input<typeof cruxResourceRecoverySchema>): Promise<CruxResourceReply<TeamCodeResourceCommandReply>>
}
