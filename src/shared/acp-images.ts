/** Application attachment bounds, independent of a provider's own image limits. */
export const ACP_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type AcpImageMimeType = typeof ACP_IMAGE_MIME_TYPES[number]
export const ACP_IMAGE_MAX_COUNT = 8
export const ACP_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const ACP_IMAGES_MAX_BYTES = 20 * 1024 * 1024
export const ACP_IMAGE_MAX_BASE64 = Math.ceil(ACP_IMAGE_MAX_BYTES / 3) * 4

export interface AcpImageAttachment {
  id: string
  name: string
  mimeType: AcpImageMimeType
  /** Raw base64, without the data URL prefix. */
  data: string
}

export interface AcpStoredImage { id: string; name: string; mimeType: AcpImageMimeType }
export function readAcpStoredImages(value: unknown): AcpStoredImage[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, ACP_IMAGE_MAX_COUNT).filter((image): image is AcpStoredImage =>
    typeof image === 'object' && image !== null && typeof image.id === 'string' && /^[a-f0-9]{64}$/.test(image.id) &&
    typeof image.name === 'string' && image.name.length > 0 && image.name.length <= 255 && ACP_IMAGE_MIME_TYPES.includes(image.mimeType))
}

export function acpImageBytes(data: string): number {
  return data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
}

export function detectAcpImageMime(bytes: Uint8Array): AcpImageMimeType | undefined {
  if (bytes.length < 12) return undefined
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  const ascii = (start: number, end: number): string => String.fromCharCode(...bytes.subarray(start, end))
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

/** History is untrusted; only known raster MIME types can become image URLs. */
export function readAcpImages(value: unknown): AcpImageAttachment[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, ACP_IMAGE_MAX_COUNT).filter((image): image is AcpImageAttachment =>
    typeof image === 'object' && image !== null && typeof image.id === 'string' &&
    typeof image.name === 'string' && typeof image.data === 'string' && image.data.length <= ACP_IMAGE_MAX_BASE64 &&
    ACP_IMAGE_MIME_TYPES.includes(image.mimeType))
}
