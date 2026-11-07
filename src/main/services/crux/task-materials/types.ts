import { z } from 'zod'
import { teamTaskMaterialCommandSchema, teamTaskMaterialReceiptSchema } from '../../../../shared/team-task-materials'
import { teamDigestSchema, teamCommandIdSchema } from '../../../../shared/team-platform'
import { cruxMaterialPendingSchema } from '../../../../shared/crux-task-materials'
import type { CruxWorkspaceContext } from '../../../../shared/crux-remote'
import type { DesktopTeamConnection } from '../../../../shared/team-desktop'
import { taskMaterialTransportPinSchema, type TaskMaterialTransportPin, type TaskMaterialsTransport } from '../../team-platform/task-materials-transport'

export const materialCommandFileSchema = z.object({
  version: z.literal(1), pin: taskMaterialTransportPinSchema, generation: z.number().int().nonnegative().safe(),
  createdAt: z.number().int().nonnegative().safe(), command: teamTaskMaterialCommandSchema
}).strict()
export const materialJournalRowSchema = cruxMaterialPendingSchema.extend({
  commandId: teamCommandIdSchema, state: z.enum(['pending', 'unknown', 'rejected', 'committed']),
  commandDigest: teamDigestSchema, commandBytes: z.number().int().positive(), receipt: teamTaskMaterialReceiptSchema.nullable()
}).strict()
export const materialJournalSchema = z.object({
  version: z.literal(1), pin: taskMaterialTransportPinSchema, rows: z.array(materialJournalRowSchema).max(512)
}).strict()
export type MaterialJournal = z.infer<typeof materialJournalSchema>
export type MaterialJournalRow = z.infer<typeof materialJournalRowSchema>
export type MaterialOwner = { pin: TaskMaterialTransportPin; generation: number }
export interface MaterialTeamSession {
  connections(): Promise<DesktopTeamConnection[]>
  withTaskMaterialsTransport<T>(pin: TaskMaterialTransportPin, assertCurrent: () => Promise<void>, action: (transport: TaskMaterialsTransport) => Promise<T>): Promise<T>
}
export interface MaterialHost {
  workspaceStatus(): Promise<CruxWorkspaceContext>
  workspaceGeneration(): number
  withService<T>(action: (service: MaterialTeamSession) => Promise<T>): Promise<T>
}
