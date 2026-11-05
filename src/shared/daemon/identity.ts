import { z } from 'zod'

export const processOwnerSchema = z.object({ pid: z.number().int().positive(), startedAt: z.string().min(1).max(128), userId: z.string().min(1).max(256), executable: z.string().min(1).max(4096) }).strict()
export const workspaceGrantSchema = z.object({
  workspaceId: z.string().min(1).max(128), root: z.string().min(1).max(4096),
  grantId: z.string().uuid(), revision: z.number().int().positive().safe()
}).strict()
export type ProcessOwner = z.infer<typeof processOwnerSchema>
export type WorkspaceGrant = z.infer<typeof workspaceGrantSchema>
