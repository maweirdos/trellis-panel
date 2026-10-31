import { z } from 'zod'
import { teamTaskMaterialCommandSchema, teamTaskMaterialReceiptSchema } from '../../../../shared/team-task-materials'
import { teamDigestSchema, teamCommandIdSchema } from '../../../../shared/team-platform'
import { hifoxMaterialPendingSchema } from '../../../../shared/hifox-task-materials'
import type { HifoxWorkspaceContext } from '../../../../shared/hifox-remote'
import type { DesktopTeamConnection } from '../../../../shared/team-desktop'
import { taskMaterialTransportPinSchema, type TaskMaterialTransportPin, type TaskMaterialsTransport } from '../../team-platform/task-materials-transport'

export const materialCommandFileSchema = z.object({
  version: z.literal(1), pin: taskMaterialTransportPinSchema, generation: z.number().int().nonnegative().safe(),
  createdAt: z.number().int().nonnegative().safe(), command: teamTaskMaterialCommandSchema
}).strict()
export const materialJournalRowSchema = hifoxMaterialPendingSchema.extend({
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
  workspaceStatus(): Promise<HifoxWorkspaceContext>
  workspaceGeneration(): number
  withService<T>(action: (service: MaterialTeamSession) => Promise<T>): Promise<T>
}
