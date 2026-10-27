import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACP_IMAGE_MAX_BASE64, ACP_IMAGE_MAX_BYTES, acpImageBytes, detectAcpImageMime, type AcpImageMimeType } from '../../../shared/acp-images'

export interface PiImageReference { id: string; name: string; mimeType: AcpImageMimeType }

function imageDirectory(sessionDir: string): string {
  const root = realpathSync(sessionDir)
  const path = join(root, 'images')
  try { mkdirSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('Pi 图片目录不安全')
  return path
}

export function savePiImage(sessionDir: string, data: string, mimeType?: string): PiImageReference {
  if (data.length < 4 || data.length > ACP_IMAGE_MAX_BASE64 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || acpImageBytes(data) > ACP_IMAGE_MAX_BYTES) throw new Error('Pi 图片内容或大小无效')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) throw new Error('Pi 图片编码无效')
  const detected = detectAcpImageMime(bytes)
  if (!detected || (mimeType && mimeType !== detected)) throw new Error('Pi 图片格式无效')
  const id = createHash('sha256').update(bytes).digest('hex')
  const path = join(imageDirectory(sessionDir), id)
  const temporary = join(imageDirectory(sessionDir), `.${randomUUID()}.tmp`)
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    try { linkSync(temporary, path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = readPiImage(sessionDir, id)
      if (existing.mimeType !== detected || existing.data !== data) throw new Error('Pi 图片存储冲突')
    }
  } finally { unlinkSync(temporary) }
  return { id, name: `图片.${detected === 'image/jpeg' ? 'jpg' : detected.slice(6)}`, mimeType: detected }
}

export function readPiImage(sessionDir: string, id: string): { mimeType: AcpImageMimeType; data: string } {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Pi 图片标识无效')
  const path = join(imageDirectory(sessionDir), id)
  if (lstatSync(path).isSymbolicLink()) throw new Error('Pi 图片路径不安全')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < 12 || stat.size > ACP_IMAGE_MAX_BYTES) throw new Error('Pi 图片文件无效')
    const bytes = readFileSync(fd)
    const mimeType = detectAcpImageMime(bytes)
    if (!mimeType || createHash('sha256').update(bytes).digest('hex') !== id) throw new Error('Pi 图片文件校验失败')
    return { mimeType, data: bytes.toString('base64') }
  } finally { closeSync(fd) }
}
