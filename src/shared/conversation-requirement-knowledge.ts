import { z } from 'zod'

const id = z.string().min(1).max(256)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const requirementKnowledgeConnectionSchema = z.object({ connectionId: id, connectionRevision: z.number().int().positive() }).strict()
export const requirementKnowledgeSelectionSchema = requirementKnowledgeConnectionSchema.extend({
  collectionIds: z.array(id).min(1).max(20).refine(values => new Set(values).size === values.length, '知识库不能重复')
}).strict()
export const requirementKnowledgeSourceRefSchema = z.object({ sourceId: z.string().uuid(), returnedRevision: digest }).strict()
export const requirementKnowledgeSourceSnapshotSchema = requirementKnowledgeSourceRefSchema.extend({
  selection: requirementKnowledgeSelectionSchema, instanceId: z.string().min(1).max(8192),
  collectionId: id, documentId: id, title: z.string().min(1).max(2000),
  excerpt: z.string().min(1).max(6000), contentHash: digest,
  fetchedAt: z.number().int().nonnegative(), truncated: z.boolean()
}).strict()
export const requirementKnowledgeSearchSchema = z.object({
  selection: requirementKnowledgeSelectionSchema,
  query: z.string().trim().min(1).max(2000), limit: z.number().int().min(1).max(12).default(6)
}).strict()
export type RequirementKnowledgeConnection = z.infer<typeof requirementKnowledgeConnectionSchema>
export type RequirementKnowledgeSelection = z.infer<typeof requirementKnowledgeSelectionSchema>
export type RequirementKnowledgeSourceRef = z.infer<typeof requirementKnowledgeSourceRefSchema>
/** returnedRevision identifies this returned excerpt and scope, not an upstream full-document revision. */
export type RequirementKnowledgeSourceSnapshot = z.infer<typeof requirementKnowledgeSourceSnapshotSchema>
export type RequirementKnowledgeSearchInput = z.input<typeof requirementKnowledgeSearchSchema>
export interface RequirementKnowledgeConnectionChoice extends RequirementKnowledgeConnection { name: string }
export interface RequirementKnowledgeCollection { id: string; name: string; knowledgeCount: number }
export interface RequirementKnowledgeItem extends RequirementKnowledgeSourceRef {
  title: string; summary: string; collectionId: string; documentId: string; truncated: boolean
}
export interface RequirementKnowledgeSearchResult {
  selection: RequirementKnowledgeSelection
  items: RequirementKnowledgeItem[]
  sources: RequirementKnowledgeSourceSnapshot[]
  partial: boolean
  omittedCount: number
}
