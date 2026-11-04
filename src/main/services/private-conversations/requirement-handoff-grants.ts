import { z } from 'zod'
import { requirementDesignEvidenceSchema, requirementDesignGrantSchema, requirementKnowledgeGrantSchema } from '../../../shared/conversation-requirements'
import { requirementKnowledgeSourceSnapshotSchema } from '../../../shared/conversation-requirement-knowledge'

/** A knowledge snapshot is eligible only when the fixed manifest identifies its explicit selection. */
export function assertRequirementHandoffGrants(raw: unknown): void {
  const manifest = z.object({
    knowledgeEvidence: z.array(requirementKnowledgeSourceSnapshotSchema).max(128).default([]),
    knowledgeGrant: requirementKnowledgeGrantSchema.optional(),
    designEvidence: z.array(requirementDesignEvidenceSchema).max(16).default([]),
    designGrant: requirementDesignGrantSchema.optional(),
    operations: z.array(z.object({ id: z.string().uuid(), knowledge: z.array(z.object({ sourceId: z.string().uuid(), returnedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough()) }).passthrough()).max(128).default([])
  }).passthrough().parse(raw)
  const key = (value: { sourceId: string; returnedRevision: string }): string => JSON.stringify([value.sourceId, value.returnedRevision])
  const sources = new Set(manifest.knowledgeEvidence.map(key))
  if (sources.size !== manifest.knowledgeEvidence.length) throw new Error('知识交接清单包含重复摘录')
  const grants = manifest.knowledgeGrant?.sources ?? []
  const direct = manifest.knowledgeGrant?.version === 2 ? manifest.knowledgeGrant.direct : undefined
  if (sources.size && !manifest.knowledgeGrant) throw new Error('知识摘录缺少明确的逐条交接授权')
  if (new Set(grants.map(value => JSON.stringify([value.operationId, value.sourceId, value.returnedRevision]))).size !== grants.length) throw new Error('知识交接授权包含重复选择')
  const directSources = direct?.sources ?? []
  for (const ref of directSources) {
    const source = manifest.knowledgeEvidence.find(item => key(item) === key(ref))
    if (!source || JSON.stringify(source.selection) !== JSON.stringify(direct?.selection)) throw new Error('直接交接摘录不属于所选连接与知识库')
  }
  const selected = new Set([...grants, ...directSources].map(key))
  if (sources.size !== selected.size || [...sources].some(value => !selected.has(value))) throw new Error('知识摘录与逐条交接授权不一致')
  for (const grant of grants) {
    const operation = manifest.operations.find(item => item.id === grant.operationId)
    if (!operation || !operation.knowledge.some(item => key(item) === key(grant))) throw new Error('知识交接授权不属于原操作来源')
  }
  for (const operation of manifest.operations) for (const item of operation.knowledge) {
    if (!grants.some(grant => grant.operationId === operation.id && key(grant) === key(item))) throw new Error('操作来源含未明确授权的知识摘录')
  }
  const design = manifest.designEvidence, designSources = manifest.designGrant?.sources ?? []
  const sourceKey = (value: unknown): string => JSON.stringify(value)
  if (design.length && !manifest.designGrant) throw new Error('设计文件缺少明确的逐条交接授权')
  if (design.length !== designSources.length || new Set(design.map(value => sourceKey(value.source))).size !== design.length || new Set(designSources.map(sourceKey)).size !== designSources.length || design.some(value => value.revision !== value.source.revision || !designSources.some(source => sourceKey(source) === sourceKey(value.source)))) throw new Error('设计文件与逐条交接授权不一致')
}
