import { z } from 'zod'
import { hifoxSnapshotSchema } from './hifox-schema'
import { hifoxMutationNameSchema } from './hifox-domain/commands'
import type { HifoxSnapshot, HifoxMember } from './hifox'

export const hifoxRemoteCommandSchema = z.object({ commandId: z.string().uuid(), expectedEpoch: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), operation: hifoxMutationNameSchema, input: z.unknown() }).strict()
export type HifoxRemoteCommand = z.infer<typeof hifoxRemoteCommandSchema>
export const hifoxRemoteSnapshotSchema = z.object({ projectId: z.string().uuid(), instanceId: z.string().uuid(), epoch: z.string().uuid(), authorizationRevision: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), actor: hifoxSnapshotSchema.shape.members.element, canManage: z.boolean(), snapshot: hifoxSnapshotSchema, serverTime: z.number().int().nonnegative(), taskId: z.string().optional() }).strict()
export type HifoxRemoteSnapshot = { projectId: string; instanceId: string; epoch: string; authorizationRevision: number; revision: number; actor: HifoxMember; canManage: boolean; snapshot: HifoxSnapshot; serverTime: number; taskId?: string }
export const hifoxRemoteCommandReplySchema = z.object({ status: z.enum(['committed', 'duplicate']), commandId: z.string().uuid(), result: hifoxRemoteSnapshotSchema }).strict()

export type HifoxWorkspaceContext = {
  key: string
  connectionId: string | null
  projectId: string | null
  projectName: string | null
  actorId: string | null
  canManage: boolean
  revision: number
  state: 'local' | 'connected' | 'offline' | 'access-revoked'
  pendingCount: number
  error?: string
  origin?: string
  instanceId?: string
  epoch?: string
  authorizationRevision?: number
}
