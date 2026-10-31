import { z } from 'zod'
import { teamCodeResourceCommandSchema, teamCodeResourceListInputSchema, teamCodeResourceScopeIdSchema,
  type TeamCodeResourceCommandReply, type TeamCodeResourceList, type TeamTaskCodeResourceDto } from './team-code-resources'

const workspaceKey = z.string().min(1).max(1024)
export const hifoxResourceListSchema = teamCodeResourceListInputSchema.extend({ workspaceKey }).strict()
export const hifoxResourceTaskSchema = z.object({ workspaceKey, taskId: teamCodeResourceScopeIdSchema }).strict()
export const hifoxResourceCommandSchema = z.object({ workspaceKey, command: teamCodeResourceCommandSchema }).strict()
export const hifoxResourcePendingSchema = z.object({ workspaceKey }).strict()
export const hifoxResourceRecoverySchema = z.object({ workspaceKey, commandId: z.string().uuid() }).strict()
export type HifoxResourceReply<T> = { ok: true; value: T } | { ok: false; code: string; error: string; outcomeUnknown?: boolean }
export interface HifoxResourcePending {
  commandId: string
  kind: z.infer<typeof teamCodeResourceCommandSchema>['kind']
  state: 'pending' | 'unknown' | 'rejected'
  createdAt: number
  error: string | null
}
export interface HifoxCodeResourceApi {
  list(input: z.input<typeof hifoxResourceListSchema>): Promise<HifoxResourceReply<TeamCodeResourceList>>
  task(input: z.input<typeof hifoxResourceTaskSchema>): Promise<HifoxResourceReply<TeamTaskCodeResourceDto>>
  command(input: z.input<typeof hifoxResourceCommandSchema>): Promise<HifoxResourceReply<TeamCodeResourceCommandReply>>
  pending(input: z.input<typeof hifoxResourcePendingSchema>): Promise<HifoxResourceReply<HifoxResourcePending[]>>
  reconcile(input: z.input<typeof hifoxResourceRecoverySchema>): Promise<HifoxResourceReply<TeamCodeResourceCommandReply | null>>
  retry(input: z.input<typeof hifoxResourceRecoverySchema>): Promise<HifoxResourceReply<TeamCodeResourceCommandReply>>
}
