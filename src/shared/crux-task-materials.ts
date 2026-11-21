import { z } from 'zod'
import { sourcePartQuery, sourcePartData, sourcePartReply } from './task-source-files'
import { teamCommandIdSchema, teamIdSchema } from './team-platform'
import { teamTaskProgressResourceIdSchema } from './team-task-progress'
import {
  teamTaskMaterialScopeSchema, teamTaskMaterialListInputSchema, teamTaskMaterialCommandSchema,
  teamTaskMaterialHistorySchema, teamTaskMaterialSubmissionsSchema,
  type TeamTaskMaterialList, type TeamTaskMaterialView, type TeamTaskMaterialCommandReply, type TeamTaskMaterialReceipt
} from './team-task-materials'

export const cruxMaterialScopeSchema = teamTaskMaterialScopeSchema.extend({
  workspaceKey: z.string().min(1).max(2048), taskId: teamTaskProgressResourceIdSchema
}).strict()
export const cruxSourcePartSchema = cruxMaterialScopeSchema.extend({ ...sourcePartQuery.shape, data: sourcePartData.optional() }).strict()
export const cruxMaterialListSchema = cruxMaterialScopeSchema.extend({
  cursor: teamTaskMaterialListInputSchema.shape.cursor, limit: teamTaskMaterialListInputSchema.shape.limit
}).strict()
export const cruxMaterialReadSchema = cruxMaterialScopeSchema.extend({ documentId: teamIdSchema, versionId: teamIdSchema.optional() }).strict()
export const cruxMaterialHistorySchema = cruxMaterialListSchema.extend({ documentId: teamIdSchema }).strict()
export const cruxMaterialCommandSchema = cruxMaterialScopeSchema.extend({ command: teamTaskMaterialCommandSchema }).strict()
export const cruxMaterialRecoverySchema = cruxMaterialScopeSchema.extend({ commandId: teamCommandIdSchema }).strict()
export const cruxMaterialPendingSchema = z.object({
  commandId: teamCommandIdSchema, action: z.enum(['create', 'saveDraft', 'setAccess', 'submit', 'approve', 'reject']),
  documentId: teamIdSchema.nullable(), state: z.enum(['pending', 'unknown', 'rejected']),
  createdAt: z.number().int().nonnegative(), errorCode: z.string().nullable(), error: z.string().nullable(), outcomeUnknown: z.boolean()
}).strict()

export type CruxMaterialScope = z.infer<typeof cruxMaterialScopeSchema>
export type CruxMaterialListInput = z.input<typeof cruxMaterialListSchema>
export type CruxMaterialReadInput = z.input<typeof cruxMaterialReadSchema>
export type CruxMaterialHistoryInput = z.input<typeof cruxMaterialHistorySchema>
export type CruxMaterialCommandInput = z.input<typeof cruxMaterialCommandSchema>
export type CruxMaterialRecoveryInput = z.input<typeof cruxMaterialRecoverySchema>
export type CruxMaterialPending = z.infer<typeof cruxMaterialPendingSchema>
export type CruxMaterialReply<T> = { ok: true; value: T } | { ok: false; code: string; error: string; outcomeUnknown?: boolean }

/** Main owns identity, complete body validation and original-command recovery. No renderer verification grants. */
export interface CruxTaskMaterialsApi {
  sourcePart(input: z.infer<typeof cruxSourcePartSchema>): Promise<CruxMaterialReply<z.infer<typeof sourcePartReply>>>
  list(input: CruxMaterialListInput): Promise<CruxMaterialReply<TeamTaskMaterialList>>
  read(input: CruxMaterialReadInput): Promise<CruxMaterialReply<TeamTaskMaterialView>>
  versions(input: CruxMaterialHistoryInput): Promise<CruxMaterialReply<z.infer<typeof teamTaskMaterialHistorySchema>>>
  submissions(input: CruxMaterialHistoryInput): Promise<CruxMaterialReply<z.infer<typeof teamTaskMaterialSubmissionsSchema>>>
  command(input: CruxMaterialCommandInput): Promise<CruxMaterialReply<TeamTaskMaterialCommandReply>>
  pending(input: CruxMaterialScope): Promise<CruxMaterialReply<CruxMaterialPending[]>>
  reconcile(input: CruxMaterialRecoveryInput): Promise<CruxMaterialReply<TeamTaskMaterialReceipt | null>>
  retry(input: CruxMaterialRecoveryInput): Promise<CruxMaterialReply<TeamTaskMaterialCommandReply>>
}
