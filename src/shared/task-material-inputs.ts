import { z } from 'zod'
import { teamTaskMaterialKindSchema } from './team-task-materials'

/** Metadata of a server-approved fixed version. Text is fetched through its original task ACL. */
export const taskMaterialInputReferenceSchema = z.object({
  documentId: z.string().uuid(), versionId: z.string().uuid(), kind: teamTaskMaterialKindSchema,
  spaceId: z.string().min(1).max(200), taskCreatedAt: z.string().min(1).max(100), title: z.string().min(1).max(300),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().positive().max(1024 * 1024)
}).strict()
export type TaskMaterialInputReference = z.infer<typeof taskMaterialInputReferenceSchema>
export function taskMaterialInputPath(reference: Pick<TaskMaterialInputReference, 'documentId' | 'versionId'>): string {
  const documentId = z.string().uuid().parse(reference.documentId), versionId = z.string().uuid().parse(reference.versionId)
  return `references/team/${documentId}/${versionId}.md`
}
