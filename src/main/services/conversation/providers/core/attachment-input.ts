import { ACP_IMAGE_MAX_COUNT, ACP_IMAGES_MAX_BYTES, detectAcpImageMime, type AcpImageMimeType } from '../../../../../shared/acp-images'
import type { ConversationAttachmentContent } from '../../../../../shared/conversation/attachments'
import { isProviderSendTurnSupportedImageMimeType, type ChatAttachment } from '../../../../../shared/conversation/chatAttachment'
import { DaemonError } from '../../../../daemon/errors'

export interface ConversationPromptAttachmentSupport {
  readonly text?: true
  readonly image?: { readonly count: number; readonly totalBytes: number }
}

export const TEXT_ATTACHMENTS: ConversationPromptAttachmentSupport = { text: true }
export const RASTER_ATTACHMENTS: ConversationPromptAttachmentSupport = {
  text: true, image: { count: 8, totalBytes: 20 * 1024 * 1024 },
}
export const PI_ATTACHMENTS: ConversationPromptAttachmentSupport = {
  text: true, image: { count: ACP_IMAGE_MAX_COUNT, totalBytes: ACP_IMAGES_MAX_BYTES },
}
export const ACP_ATTACHMENTS: ConversationPromptAttachmentSupport = {
  text: true, image: { count: 4, totalBytes: 512 * 1024 },
}
const TEXT_ATTACHMENT_MAX_BYTES = 128 * 1024
export const ANSWER_ATTACHMENT_MAX_BYTES = 24 * 1024
const textFileExtension = /\.(?:c|cc|cpp|cs|css|go|h|hpp|java|js|jsx|json|kt|md|mjs|ps1|py|rb|rs|sh|sql|toml|ts|tsx|txt|xml|ya?ml)$/i

function isTextAttachment(attachment: ChatAttachment): boolean {
  return attachment.type === 'file' && (
    /^text\/(?!html\b)[a-z0-9.+-]+$/i.test(attachment.mimeType)
    || ['application/json', 'application/xml'].includes(attachment.mimeType)
    || (attachment.mimeType === 'application/octet-stream' && textFileExtension.test(attachment.name))
  )
}

export function assertPromptAttachments(
  attachments: readonly ChatAttachment[] | undefined,
  support: ConversationPromptAttachmentSupport | undefined,
  textLimit = TEXT_ATTACHMENT_MAX_BYTES,
): void {
  let imageCount = 0
  let imageBytes = 0
  let textBytes = 0
  for (const attachment of attachments ?? []) {
    if (attachment.type === 'image' && support?.image && isProviderSendTurnSupportedImageMimeType(attachment.mimeType)) {
      imageCount++
      imageBytes += attachment.sizeBytes
      if (imageCount > support.image.count || imageBytes > support.image.totalBytes) {
        throw new DaemonError('E_INVALID_ARG', '图片数量或总大小超出原生引擎上限。')
      }
    } else if (support?.text && isTextAttachment(attachment)) {
      textBytes += attachment.sizeBytes
      if (textBytes > textLimit) throw new DaemonError('E_INVALID_ARG', '文本附件总大小超出原生输入上限。')
    } else {
      throw new DaemonError('E_UNAVAILABLE', `当前引擎无法交付附件类型 ${attachment.mimeType}。`)
    }
  }
}

export function nativeTextAttachment(content: ConversationAttachmentContent): string {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content.bytes) }
  catch { throw new DaemonError('E_INVALID_ARG', `附件 ${content.attachment.name} 不是有效的 UTF-8 文本。`) }
  if (text.includes('\0')) throw new DaemonError('E_INVALID_ARG', `附件 ${content.attachment.name} 含二进制内容。`)
  return `[Attachment ${JSON.stringify(content.attachment.name)}]\n${text}\n[End attachment]`
}

export function nativeImageAttachment(content: ConversationAttachmentContent): { mimeType: AcpImageMimeType; data: string } {
  const mimeType = detectAcpImageMime(content.bytes)
  if (!mimeType || mimeType !== content.attachment.mimeType) {
    throw new DaemonError('E_INVALID_ARG', `附件 ${content.attachment.name} 的图片类型与内容不一致。`)
  }
  return { mimeType, data: Buffer.from(content.bytes.buffer, content.bytes.byteOffset, content.bytes.byteLength).toString('base64') }
}
