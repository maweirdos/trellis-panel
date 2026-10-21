/** Main-owned desktop bridge; credentials and trusted local material bodies stay in main. */
import { z } from 'zod'
import { desktopPublicationBaseSchema, type DesktopTeamApi, type DesktopTeamOutbox } from './team-desktop'
import { managedTaskDirSchema } from './workflow-application'
import { runRefSchema } from './workflow'
import { fixedDocumentTokenSchema } from './document-windows'
export type TeamDesktopReply<T> = { ok: true; value: T } | { ok: false; code: string; error: string; outcomeUnknown: boolean }
export const desktopWorkflowPublicationSchema = desktopPublicationBaseSchema.extend({ source: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task-run'), taskDir: managedTaskDirSchema, run: runRefSchema, ref: z.string().regex(/^wm-[0-9a-f]{64}$/) }).strict(),
  z.object({ kind: z.literal('workspace-recovery'), run: runRefSchema, ref: z.string().regex(/^wm-[0-9a-f]{64}$/) }).strict(),
  z.object({ kind: z.literal('fixed-document'), token: fixedDocumentTokenSchema }).strict()
]) }).strict()
export type DesktopWorkflowPublicationInput = z.infer<typeof desktopWorkflowPublicationSchema>
export type TeamDesktopChange = { connectionId: string | null; reason: 'updated' | 'background-error'; occurredAt: number }
export type TeamDesktopBridgeApi = {
  [K in keyof DesktopTeamApi]: (...args: Parameters<DesktopTeamApi[K]>) => Promise<TeamDesktopReply<Awaited<ReturnType<DesktopTeamApi[K]>>>>
} & {
  queueWorkflowMaterial(expectedRoot: string, input: DesktopWorkflowPublicationInput): Promise<TeamDesktopReply<DesktopTeamOutbox>>
  onChanged(callback: (event: TeamDesktopChange) => void): () => void
}
