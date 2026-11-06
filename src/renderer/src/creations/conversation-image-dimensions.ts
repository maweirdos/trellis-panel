import type { AcpImageMimeType } from '@shared/acp-images'

// Match the existing local document image budget. Frame totals also bound GIF work.
const MAX_DIMENSION = 8192
const MAX_PIXELS = 16 * 1024 * 1024
const MAX_GIF_FRAME_PIXELS = 64 * 1024 * 1024
type Size = { width: number; height: number }
type Result = 'valid' | 'too-large' | 'unknown'
const bounded = (size: Size): boolean => size.width > 0 && size.height > 0 && size.width <= MAX_DIMENSION && size.height <= MAX_DIMENSION && size.width * size.height <= MAX_PIXELS

/** Decode in small slices so a selected file cannot monopolize the renderer. */
export async function checkConversationImage(data: string, mime: AcpImageMimeType, current: () => boolean): Promise<Result> {
  if (!data.length || data.length % 4 !== 0) return 'unknown'
  const output = new Uint8Array(data.length / 4 * 3)
  let length = 0
  try {
    const sliceSize = 64 * 1024
    for (let offset = 0; offset < data.length; offset += sliceSize) {
      if (!current()) return 'unknown'
      const slice = data.slice(offset, offset + sliceSize)
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(slice) || offset + sliceSize < data.length && slice.includes('=')) return 'unknown'
      const decoded = atob(slice)
      for (let i = 0; i < decoded.length; i++) output[length++] = decoded.charCodeAt(i)
      if ((offset / sliceSize) % 8 === 7) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    if (!current()) return 'unknown'
    return inspect(output.subarray(0, length), mime)
  } catch { return 'unknown' }
}

function inspect(bytes: Uint8Array, mime: AcpImageMimeType): Result {
  const length = bytes.length
  const view = new DataView(bytes.buffer, bytes.byteOffset, length)
  const ascii = (offset: number, text: string): boolean => offset >= 0 && offset + text.length <= length && [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0))
  const sizeResult = (size: Size): Result => bounded(size) ? 'valid' : size.width && size.height ? 'too-large' : 'unknown'
  if (mime === 'image/png') {
    if (length < 33 || ![137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value) || view.getUint32(8) !== 13 || !ascii(12, 'IHDR')) return 'unknown'
    let offset = 8, chunks = 0, ended = false
    while (offset + 12 <= length && ++chunks <= 65536) {
      const size = view.getUint32(offset), end = offset + 12 + size
      if (end > length || ascii(offset + 4, 'acTL')) return 'unknown'
      if (ascii(offset + 4, 'IEND')) { ended = size === 0 && end === length; break }
      offset = end
    }
    if (!ended) return 'unknown'
    return sizeResult({ width: view.getUint32(16), height: view.getUint32(20) })
  }
  if (mime === 'image/jpeg') {
    if (length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return 'unknown'
    let offset = 2, segments = 0
    while (offset + 4 <= length && offset < 256 * 1024 && ++segments <= 1024) {
      if (bytes[offset++] !== 255) return 'unknown'
      while (offset < length && bytes[offset] === 255 && offset < 256 * 1024) offset++
      const marker = bytes[offset++]
      if (marker === 0xd9 || marker === 0xda || marker === undefined) return 'unknown'
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue
      if (offset + 2 > length) return 'unknown'
      const size = view.getUint16(offset)
      if (size < 2 || offset + size > length) return 'unknown'
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (size < 11 || bytes[offset + 7] === 0 || size !== 8 + 3 * bytes[offset + 7]) return 'unknown'
        return sizeResult({ height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) })
      }
      offset += size
    }
    return 'unknown'
  }
  if (mime === 'image/webp') {
    if (length < 20 || !ascii(0, 'RIFF') || !ascii(8, 'WEBP') || view.getUint32(4, true) !== length - 8) return 'unknown'
    let canvas: Size | null = null, frame: Size | null = null, chunks = 0, offset = 12
    const u24 = (i: number): number => bytes[i] + bytes[i + 1] * 256 + bytes[i + 2] * 65536
    while (offset + 8 <= length && ++chunks <= 256) {
      const n = view.getUint32(offset + 4, true), start = offset + 8, end = start + n
      if (end > length) return 'unknown'
      if (ascii(offset, 'ANIM') || ascii(offset, 'ANMF')) return 'unknown'
      if (ascii(offset, 'VP8X')) {
        if (n !== 10 || canvas || bytes[start] & 2) return 'unknown'
        canvas = { width: 1 + u24(start + 4), height: 1 + u24(start + 7) }
      } else if (ascii(offset, 'VP8L')) {
        if (n <= 5 || frame || bytes[start] !== 0x2f) return 'unknown'
        const packed = view.getUint32(start + 1, true)
        if (packed >>> 29) return 'unknown'
        frame = { width: 1 + (packed & 0x3fff), height: 1 + ((packed >>> 14) & 0x3fff) }
      } else if (ascii(offset, 'VP8 ')) {
        if (n <= 10 || frame || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a) return 'unknown'
        const tag = u24(start)
        if (tag & 1 || tag >>> 5 > n - 10) return 'unknown'
        frame = { width: view.getUint16(start + 6, true) & 0x3fff, height: view.getUint16(start + 8, true) & 0x3fff }
      }
      offset = end + (n % 2)
      if (offset > length) return 'unknown'
    }
    if (offset !== length || !frame || canvas && (canvas.width !== frame.width || canvas.height !== frame.height)) return 'unknown'
    return sizeResult(frame)
  }
  if (mime !== 'image/gif' || length < 14 || !ascii(0, 'GIF87a') && !ascii(0, 'GIF89a')) return 'unknown'
  const canvas = { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (!bounded(canvas)) return sizeResult(canvas)
  let offset = 13 + (bytes[10] & 0x80 ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0), blocks = 0, frames = 0, pixels = 0
  const subBlocks = (): boolean => {
    while (offset < length && ++blocks <= 65536) {
      const n = bytes[offset++]
      if (!n) return true
      if (offset + n > length) return false
      offset += n
    }
    return false
  }
  while (offset < length && blocks <= 65536) {
    const marker = bytes[offset++]
    if (marker === 0x3b) return frames && offset === length ? 'valid' : 'unknown'
    if (marker === 0x21) { if (offset >= length) return 'unknown'; offset++; if (!subBlocks()) return 'unknown'; continue }
    if (marker !== 0x2c || offset + 9 > length || ++frames > 512) return 'unknown'
    const x = view.getUint16(offset, true), y = view.getUint16(offset + 2, true)
    const frame = { width: view.getUint16(offset + 4, true), height: view.getUint16(offset + 6, true) }, flags = bytes[offset + 8]
    if (!bounded(frame)) return sizeResult(frame)
    if (x + frame.width > canvas.width || y + frame.height > canvas.height) return 'unknown'
    pixels += frame.width * frame.height
    if (pixels > MAX_GIF_FRAME_PIXELS) return 'too-large'
    offset += 9 + (flags & 0x80 ? 3 * (2 ** ((flags & 7) + 1)) : 0)
    if (offset >= length || bytes[offset] < 2 || bytes[offset] > 8) return 'unknown'
    offset++
    if (!subBlocks()) return 'unknown'
  }
  return 'unknown'
}
