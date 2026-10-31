import { z } from 'zod'
import { teamCommandIdSchema, teamIdSchema } from './team-platform'
import { teamTaskProgressResourceIdSchema } from './team-task-progress'
import {
  teamTaskMaterialScopeSchema, teamTaskMaterialListInputSchema, teamTaskMaterialCommandSchema,
  teamTaskMaterialHistorySchema, teamTaskMaterialSubmissionsSchema,
  type TeamTaskMaterialList, type TeamTaskMaterialView, type TeamTaskMaterialCommandReply, type TeamTaskMaterialReceipt
} from './team-task-materials'

export const hifoxMaterialScopeSchema = teamTaskMaterialScopeSchema.extend({
  workspaceKey: z.string().min(1).max(2048), taskId: teamTaskProgressResourceIdSchema
}).strict()
export const hifoxMaterialListSchema = hifoxMaterialScopeSchema.extend({
  cursor: teamTaskMaterialListInputSchema.shape.cursor, limit: teamTaskMaterialListInputSchema.shape.limit
}).strict()
export const hifoxMaterialReadSchema = hifoxMaterialScopeSchema.extend({ documentId: teamIdSchema, versionId: teamIdSchema.optional() }).strict()
export const hifoxMaterialHistorySchema = hifoxMaterialListSchema.extend({ documentId: teamIdSchema }).strict()
export const hifoxMaterialCommandSchema = hifoxMaterialScopeSchema.extend({ command: teamTaskMaterialCommandSchema }).strict()
export const hifoxMaterialRecoverySchema = hifoxMaterialScopeSchema.extend({ commandId: teamCommandIdSchema }).strict()
export const hifoxMaterialPendingSchema = z.object({
  commandId: teamCommandIdSchema, action: z.enum(['create', 'saveDraft', 'setAccess', 'submit', 'approve', 'reject']),
  documentId: teamIdSchema.nullable(), state: z.enum(['pending', 'unknown', 'rejected']),
  createdAt: z.number().int().nonnegative(), errorCode: z.string().nullable(), error: z.string().nullable(), outcomeUnknown: z.boolean()
}).strict()

export type HifoxMaterialScope = z.infer<typeof hifoxMaterialScopeSchema>
export type HifoxMaterialListInput = z.input<typeof hifoxMaterialListSchema>
export type HifoxMaterialReadInput = z.input<typeof hifoxMaterialReadSchema>
export type HifoxMaterialHistoryInput = z.input<typeof hifoxMaterialHistorySchema>
export type HifoxMaterialCommandInput = z.input<typeof hifoxMaterialCommandSchema>
export type HifoxMaterialRecoveryInput = z.input<typeof hifoxMaterialRecoverySchema>
export type HifoxMaterialPending = z.infer<typeof hifoxMaterialPendingSchema>
export type HifoxMaterialReply<T> = { ok: true; value: T } | { ok: false; code: string; error: string; outcomeUnknown?: boolean }

/** Main owns identity, complete body validation and original-command recovery. No renderer verification grants. */
export interface HifoxTaskMaterialsApi {
  list(input: HifoxMaterialListInput): Promise<HifoxMaterialReply<TeamTaskMaterialList>>
  read(input: HifoxMaterialReadInput): Promise<HifoxMaterialReply<TeamTaskMaterialView>>
  versions(input: HifoxMaterialHistoryInput): Promise<HifoxMaterialReply<z.infer<typeof teamTaskMaterialHistorySchema>>>
  submissions(input: HifoxMaterialHistoryInput): Promise<HifoxMaterialReply<z.infer<typeof teamTaskMaterialSubmissionsSchema>>>
  command(input: HifoxMaterialCommandInput): Promise<HifoxMaterialReply<TeamTaskMaterialCommandReply>>
  pending(input: HifoxMaterialScope): Promise<HifoxMaterialReply<HifoxMaterialPending[]>>
  reconcile(input: HifoxMaterialRecoveryInput): Promise<HifoxMaterialReply<TeamTaskMaterialReceipt | null>>
  retry(input: HifoxMaterialRecoveryInput): Promise<HifoxMaterialReply<TeamTaskMaterialCommandReply>>
}
