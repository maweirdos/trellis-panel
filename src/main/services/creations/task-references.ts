import type { z } from 'zod'
import type { creationListSchema } from '../../../shared/creations'
import { creationMaterialReferenceSchema, type CreationMaterialReference } from '../../../shared/creation-materials'
import type { CruxWorkQuery } from '../../../shared/crux-work'

export function selectTaskCreationReferences(query: CruxWorkQuery, result: z.output<typeof creationListSchema>): CreationMaterialReference[] {
  if (result.hasMore || result.items.length > 20) throw new Error('任务关联创作超过 20 份，请按工作范围拆分任务后准备材料')
  return result.items.flatMap(item => {
    const adopted = item.adoptions.filter(reference => reference.taskId === query.taskId).at(-1)
    return adopted ? [creationMaterialReferenceSchema.parse({ ...adopted, creationId: item.creationId, kind: item.kind })] : []
  })
}
