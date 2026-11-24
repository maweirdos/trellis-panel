import { z } from 'zod'
import { conversationKnowledgeAttachmentSchema, conversationKnowledgeReferenceSchema } from './knowledge-reference'
import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
} from './chatAttachment'

export const CONVERSATION_ATTACHMENT_CONTENT_MAX_BYTES = 128 * 1024 * 1024
export const ConversationAttachmentIdSchema = z.string().regex(/^[a-z0-9_-]{1,128}$/i)
export const ConversationAttachmentIdsSchema = z.array(ConversationAttachmentIdSchema).max(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
export const ConversationAttachmentDraftIdSchema = z.string().min(1).max(128).regex(/^[\w.-]+$/)
const threadId = z.string().min(1).max(200).regex(/^[\w.-]+$/)
export const ConversationAttachmentDraftTargetSchema = z.strictObject({
  draftId: ConversationAttachmentDraftIdSchema,
  threadId: threadId.optional(),
  requestId: threadId.optional(),
  generation: z.number().int().positive().safe().optional(),
})
export const ConversationAttachmentReadSchema = z.strictObject({
  threadId,
  attachmentId: ConversationAttachmentIdSchema,
})
export const conversationAttachmentReferenceFields = {
  draftId: ConversationAttachmentDraftIdSchema.optional(),
  attachmentIds: ConversationAttachmentIdsSchema.optional(),
}

export interface ConversationAttachmentReferences {
  readonly draftId?: string
  readonly attachmentIds?: readonly string[]
}

export const ConversationAttachmentBytesInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(255).regex(/^[^/\\:\u0000-\u001f\u007f]+$/),
  mimeType: z.string().max(100).optional(),
  bytes: z.custom<Uint8Array>(value => value instanceof Uint8Array).refine(bytes =>
    bytes.byteLength > 0 && bytes.byteLength <= PROVIDER_SEND_TURN_MAX_FILE_BYTES, '附件超出可接收的大小。'),
  source: z.literal('pasted-text').optional(),
})

export type ConversationAttachmentBytesInput = z.input<typeof ConversationAttachmentBytesInputSchema>

export const ConversationAttachmentWireBytesSchema = ConversationAttachmentDraftTargetSchema.extend(
  ConversationAttachmentBytesInputSchema.omit({ bytes: true }).shape,
).extend({
  data: z.string().min(4).max(4 * Math.ceil(PROVIDER_SEND_TURN_MAX_FILE_BYTES / 3)),
})
export const ConversationAttachmentWireKnowledgeSchema = ConversationAttachmentDraftTargetSchema.extend({
  knowledge: conversationKnowledgeAttachmentSchema,
})

export type ConversationAttachmentDraftTarget = z.infer<typeof ConversationAttachmentDraftTargetSchema>
export type ConversationAttachmentStageInput = { cwd: string } & ConversationAttachmentDraftTarget &
  (ConversationAttachmentBytesInput | { knowledge: z.input<typeof conversationKnowledgeReferenceSchema> })

export interface ConversationAttachmentClaimInput {
  readonly threadId: string
  readonly claimId: string
  readonly attachmentIds: readonly string[]
}

export interface ConversationAttachmentLocator {
  readonly threadId: string
  readonly attachmentId: string
}

export type StagedConversationAttachment = ChatAttachment & { readonly sha256: string; readonly expiresAt: number }

export interface ConversationAttachmentContent {
  readonly attachment: ChatAttachment
  readonly sha256: string
  readonly bytes: Uint8Array
}

export interface ConversationAttachmentLimits {
  readonly count?: number
  readonly fileBytes?: number
  readonly imageBytes?: number
  readonly totalImageBytes?: number
  readonly totalBytes?: number
}

export function conversationAttachmentLimitError(
  attachments: readonly Pick<ChatAttachment, 'type' | 'mimeType' | 'sizeBytes'>[],
  limits: ConversationAttachmentLimits = {},
): string | undefined {
  if (attachments.length > (limits.count ?? PROVIDER_SEND_TURN_MAX_ATTACHMENTS)) return '附件数量超出当前模型允许的上限。'
  const standardError = getProviderAttachmentLimitError(attachments)
  if (standardError) return standardError
  let totalBytes = 0
  let totalImageBytes = 0
  for (const attachment of attachments) {
    const image = attachment.type === 'image'
    const singleLimit = image
      ? Math.min(limits.imageBytes ?? Infinity, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
      : Math.min(limits.fileBytes ?? Infinity, PROVIDER_SEND_TURN_MAX_FILE_BYTES)
    if (attachment.sizeBytes > singleLimit) return '单个附件超出允许的大小。'
    totalBytes += attachment.sizeBytes
    if (image) totalImageBytes += attachment.sizeBytes
  }
  if (totalBytes > Math.min(limits.totalBytes ?? Infinity, CONVERSATION_ATTACHMENT_CONTENT_MAX_BYTES)) return '附件总大小超出允许的上限。'
  if (totalImageBytes > (limits.totalImageBytes ?? Infinity)) return '图片总大小超出当前模型允许的上限。'
}
