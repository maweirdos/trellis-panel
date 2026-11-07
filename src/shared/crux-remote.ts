import { z } from 'zod'
import { cruxSnapshotSchema } from './crux-schema'
import { cruxMutationNameSchema } from './crux-domain/commands'
import type { CruxSnapshot, CruxMember } from './crux'

export const cruxRemoteCommandSchema = z.object({ commandId: z.string().uuid(), expectedEpoch: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), operation: cruxMutationNameSchema, input: z.unknown() }).strict()
export type CruxRemoteCommand = z.infer<typeof cruxRemoteCommandSchema>
export const cruxRemoteSnapshotSchema = z.object({ projectId: z.string().uuid(), instanceId: z.string().uuid(), epoch: z.string().uuid(), authorizationRevision: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), actor: cruxSnapshotSchema.shape.members.element, canManage: z.boolean(), snapshot: cruxSnapshotSchema, serverTime: z.number().int().nonnegative(), taskId: z.string().optional() }).strict()
export type CruxRemoteSnapshot = { projectId: string; instanceId: string; epoch: string; authorizationRevision: number; revision: number; actor: CruxMember; canManage: boolean; snapshot: CruxSnapshot; serverTime: number; taskId?: string }
export const cruxRemoteCommandReplySchema = z.object({ status: z.enum(['committed', 'duplicate']), commandId: z.string().uuid(), result: cruxRemoteSnapshotSchema }).strict()

export type CruxWorkspaceContext = {
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
