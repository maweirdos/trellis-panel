import { z } from 'zod'

export const knowledgeReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source'), sourceId: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ kind: z.literal('project'), relativePath: z.string().min(1).max(4096), displayedRevision: z.string().regex(/^[a-f0-9]{16}$/) }),
])

export const conversationKnowledgeReferenceSchema = z.strictObject({
  reference: knowledgeReferenceSchema,
  selectionToken: z.string().regex(/^[a-f0-9]{64}$/),
  projectGeneration: z.number().int().nonnegative().safe(),
})

export const conversationKnowledgeAttachmentSchema = conversationKnowledgeReferenceSchema.extend({ pageId: z.uuid() })

export type ConversationKnowledgeReference = z.infer<typeof conversationKnowledgeReferenceSchema>
export type ConversationKnowledgeAttachment = z.infer<typeof conversationKnowledgeAttachmentSchema>
