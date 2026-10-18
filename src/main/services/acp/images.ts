import { z } from 'zod'
import { ACP_IMAGE_MAX_BASE64, ACP_IMAGE_MAX_BYTES, ACP_IMAGE_MAX_COUNT, ACP_IMAGE_MIME_TYPES, ACP_IMAGES_MAX_BYTES, acpImageBytes, detectAcpImageMime } from '../../../shared/acp-images'

export const promptImagesSchema = z.array(z.object({
  id: z.string().min(1).max(200).regex(/^[\w.-]+$/),
  name: z.string().min(1).max(255),
  mimeType: z.enum(ACP_IMAGE_MIME_TYPES),
  data: z.string().min(4).max(ACP_IMAGE_MAX_BASE64)
})).max(ACP_IMAGE_MAX_COUNT).superRefine((images, context) => {
  let total = 0
  const ids = new Set<string>()
  for (const [index, image] of images.entries()) {
    const bytes = acpImageBytes(image.data)
    total += bytes
    // Validate before decoding, so Buffer's permissive base64 parser cannot accept junk.
    if (ids.has(image.id) || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || bytes > ACP_IMAGE_MAX_BYTES ||
      detectAcpImageMime(Buffer.from(image.data.slice(0, 32), 'base64')) !== image.mimeType) {
      context.addIssue({ code: 'custom', path: [index], message: '图片内容、格式或大小无效（支持 PNG、JPEG、WebP、GIF，每张最多 10 MB）' })
    }
    ids.add(image.id)
  }
  if (total > ACP_IMAGES_MAX_BYTES) context.addIssue({ code: 'custom', message: '图片总大小不能超过 20 MB' })
})
