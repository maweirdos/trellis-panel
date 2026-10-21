import { nativeImage } from 'electron'
import { constants, promises as fs, type Stats } from 'node:fs'
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { detectAcpImageMime } from '../../../shared/acp-images'
import { IpcErrorCode, type IpcErrorCode as ErrorCode } from '../../../shared/ipc-errors'
import {
  KNOWLEDGE_DOCUMENT_IMAGE_MAX_BYTES, KNOWLEDGE_DOCUMENT_IMAGE_MAX_DIMENSION, KNOWLEDGE_DOCUMENT_IMAGE_MAX_PIXELS,
  type KnowledgeArtifactImage, type KnowledgeArtifactImageInput, type KnowledgeArtifactOpenLocalInput,
  type KnowledgeArtifactOpenLocalResult, type KnowledgeDocumentContext, type KnowledgeDocumentImageMime
} from '../../../shared/knowledge-document-assets'
import { getProjectGeneration, getProjectRoot } from '../../state'
import { artifactRead } from './materials'
import { knowledgeHash } from './repository'
import { openLocalDocumentLink } from '../local-document-links'

export class KnowledgeDocumentError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message) }
}
const invalid = (message: string): never => { throw new KnowledgeDocumentError(IpcErrorCode.InvalidArg, message) }
const denied = (message: string): never => { throw new KnowledgeDocumentError(IpcErrorCode.Denied, message) }
const within = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
const rootKey = (root: string): string => process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)

function capture(input: KnowledgeDocumentContext, senderCurrent: () => boolean) {
  const root = getProjectRoot()
  if (!root) throw new KnowledgeDocumentError(IpcErrorCode.NoProject, '请先打开文档所属项目。')
  if (/^[/\\]{2}/.test(root)) denied('不能读取网络共享中的文档资源。')
  const generation = getProjectGeneration()
  const current = (): boolean => senderCurrent() && generation === getProjectGeneration() && Boolean(getProjectRoot()) && rootKey(getProjectRoot() ?? '') === rootKey(root) && rootKey(input.expectedRoot) === rootKey(root)
  const assertCurrent = (): void => { if (!current()) throw new KnowledgeDocumentError(IpcErrorCode.Conflict, '项目或阅读窗口已变化，请重新打开文档。') }
  assertCurrent()
  const artifact = artifactRead(root, input.artifactId, input.revision)
  if (artifact.sessionId !== input.sessionId) denied('此文档不属于当前会话。')
  return { root: resolve(root), artifact, current, assertCurrent }
}

function safeRelative(value: string): string {
  if (!value || value.length > 4096 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value) || /%(?![\da-f]{2})/i.test(value) || /%2f|%5c/i.test(value)) return invalid('图片需要有效的项目相对路径。')
  let decoded: string
  try { decoded = decodeURIComponent(value).replace(/\\/g, '/') } catch { return invalid('图片路径编码无效。') }
  if (!decoded || decoded.startsWith('/') || isAbsolute(decoded) || /[\u0000-\u001f\u007f<>:"|?*%#]/.test(decoded)) return invalid('仅支持项目内的相对图片，不会访问网络或任意文件地址。')
  if (decoded.split('/').some(part => part !== '.' && part !== '..' && (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) return invalid('图片路径包含不支持的文件名。')
  return decoded
}

/** Walk before realpath/open so an untrusted junction cannot contact a share. */
async function authorizeFile(root: string, target: string): Promise<Stats> {
  if (!within(root, target) || /^[/\\]{2}/.test(target)) return denied('文档资源不能超出当前项目。')
  const base = parse(target).root
  const segments = relative(base, target).split(sep)
  if (segments.length > 128) return denied('文档资源路径过深。')
  let cursor = base
  let stat: Stats | undefined
  for (const segment of segments) {
    cursor = join(cursor, segment)
    stat = await fs.lstat(cursor)
    if (stat.isSymbolicLink()) return denied('不能通过符号链接或目录联接读取文档资源。')
    if (cursor !== target && !stat.isDirectory()) throw new KnowledgeDocumentError(IpcErrorCode.NotFound, '文档资源不存在。')
  }
  if (!stat?.isFile()) return denied('文档资源必须是普通文件。')
  const canonicalRoot = await fs.realpath(root)
  const canonical = await fs.realpath(target)
  if (!within(canonicalRoot, canonical) || /^[/\\]{2}/.test(canonical)) return denied('文档资源的实际路径不在当前项目。')
  await fs.access(canonical, constants.R_OK)
  return stat
}

async function readBounded(root: string, target: string, maxBytes: number, assertCurrent: () => void): Promise<Buffer> {
  const before = await authorizeFile(root, target)
  if (before.size > maxBytes) return denied(`文档资源超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB 限制。`)
  assertCurrent()
  const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) return denied('文档资源已变化，请重新打开。')
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxBytes || length !== stat.size) return denied('文档资源在读取时发生变化或超出限制。')
    const after = await file.stat()
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return denied('文档资源在读取时发生变化，请重试。')
    const currentPath = await authorizeFile(root, target)
    if (currentPath.dev !== after.dev || currentPath.ino !== after.ino || currentPath.size !== after.size) return denied('文档资源在读取时已被替换，请重试。')
    assertCurrent()
    return buffer.subarray(0, length)
  } finally { await file.close() }
}

function dimensions(bytes: Buffer, mime: KnowledgeDocumentImageMime): { width: number; height: number } | null {
  if (mime === 'image/png') return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null
  if (mime === 'image/webp') {
    if (bytes.readUInt32LE(4) !== bytes.length - 8) return null
    let canvas: { width: number; height: number } | null = null
    let frame: { width: number; height: number } | null = null
    let chunks = 0
    for (let offset = 12; offset + 8 <= bytes.length;) {
      if (++chunks > 256) return null
      const kind = bytes.toString('ascii', offset, offset + 4)
      const size = bytes.readUInt32LE(offset + 4), start = offset + 8
      if (start + size > bytes.length) return null
      if (kind === 'ANIM' || kind === 'ANMF') return null
      if (kind === 'VP8X') {
        if (size !== 10 || canvas || bytes[start] & 0x02) return null
        canvas = { width: 1 + bytes.readUIntLE(start + 4, 3), height: 1 + bytes.readUIntLE(start + 7, 3) }
      }
      if (kind === 'VP8L' && size > 5 && bytes[start] === 0x2f) {
        if (frame) return null
        const packed = bytes.readUInt32LE(start + 1)
        if (packed >>> 29) return null
        frame = { width: 1 + (packed & 0x3fff), height: 1 + ((packed >>> 14) & 0x3fff) }
      }
      if (kind === 'VP8 ' && size > 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) {
        if (frame) return null
        const tag = bytes.readUIntLE(start, 3)
        if (tag & 1 || tag >>> 5 > size - 10) return null
        frame = { width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff }
      }
      offset = start + size + (size % 2)
      if (offset > bytes.length) return null
      if (offset === bytes.length) return frame && (!canvas || canvas.width === frame.width && canvas.height === frame.height) ? frame : null
    }
    return null
  }
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return null
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xd9 || marker === 0xda) return null
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue
    if (offset + 2 > bytes.length) return null
    const size = bytes.readUInt16BE(offset)
    if (size < 2 || offset + size > bytes.length) return null
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return size >= 7 ? { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) } : null
    offset += size
  }
  return null
}
function boundedDimensions(size: { width: number; height: number } | null): boolean {
  return Boolean(size && size.width > 0 && size.height > 0 && size.width <= KNOWLEDGE_DOCUMENT_IMAGE_MAX_DIMENSION && size.height <= KNOWLEDGE_DOCUMENT_IMAGE_MAX_DIMENSION && size.width * size.height <= KNOWLEDGE_DOCUMENT_IMAGE_MAX_PIXELS)
}
function ioFailure(error: unknown): never {
  if (error instanceof KnowledgeDocumentError) throw error
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new KnowledgeDocumentError(IpcErrorCode.NotFound, '本地文档资源不存在，可能已移动或删除。')
  if (code === 'EACCES' || code === 'EPERM') return denied('没有读取此文档资源的权限。')
  throw new KnowledgeDocumentError(IpcErrorCode.Io, '文档资源读取失败，请重新打开后重试。')
}

export async function readKnowledgeArtifactImage(input: KnowledgeArtifactImageInput, senderCurrent: () => boolean = () => true): Promise<KnowledgeArtifactImage> {
  const owner = capture(input, senderCurrent)
  const image = safeRelative(input.src)
  const artifactPath = resolve(owner.root, safeRelative(owner.artifact.relativePath))
  if (!within(owner.root, artifactPath)) return denied('保存文档的路径不在当前项目。')
  const target = resolve(dirname(artifactPath), image)
  const formats: Record<string, KnowledgeDocumentImageMime> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
  const expected = formats[extname(target).toLowerCase()]
  if (!expected) return invalid('文档图片仅支持项目内的 PNG、JPEG 和 WebP。')
  try {
    const bytes = await readBounded(owner.root, target, KNOWLEDGE_DOCUMENT_IMAGE_MAX_BYTES, owner.assertCurrent)
    if (detectAcpImageMime(bytes) !== expected || !boundedDimensions(dimensions(bytes, expected))) return invalid('图片内容、格式或像素尺寸无效。')
    // nativeImage's portable decoder handles PNG/JPEG, not WebP. Static WebP
    // headers are bounded above; its actual decode is verified by the img host.
    const decoded = expected === 'image/webp' ? null : nativeImage.createFromBuffer(bytes)
    const size = decoded ? decoded.getSize() : dimensions(bytes, expected)
    if (decoded?.isEmpty() || !size || !boundedDimensions(size)) return invalid('图片无法安全解码或尺寸超出限制。')
    owner.assertCurrent()
    return { dataUrl: `data:${expected};base64,${bytes.toString('base64')}`, mimeType: expected, byteLength: bytes.length,
      contentHash: createHash('sha256').update(bytes).digest('hex'), width: size.width, height: size.height,
      relativePath: relative(owner.root, target).replace(/\\/g, '/'), resource: 'current-local' }
  } catch (error) { return ioFailure(error) }
}

export async function openKnowledgeArtifactLocal(input: KnowledgeArtifactOpenLocalInput, senderCurrent: () => boolean = () => true): Promise<KnowledgeArtifactOpenLocalResult> {
  const owner = capture(input, senderCurrent)
  const target = resolve(owner.root, safeRelative(owner.artifact.relativePath))
  if (extname(target).toLowerCase() !== '.md') return denied('当前入口仅支持已保存的 Markdown 文档。')
  try {
    const bytes = await readBounded(owner.root, target, 1024 * 1024, owner.assertCurrent)
    let body: string
    try { body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return invalid('本地文档不是有效的 UTF-8 Markdown。') }
    const currentRevision = knowledgeHash(body), differsFromPreview = currentRevision !== owner.artifact.revision
    if (differsFromPreview && !input.acknowledgeChangedFile) throw new KnowledgeDocumentError(IpcErrorCode.Conflict, '本地文件已是另一版本；弹窗仍显示所选保存版本。确认后可在本机打开当前文件，不会覆盖任何版本。')
    owner.assertCurrent()
    const result = await openLocalDocumentLink(pathToFileURL(target).href, owner.root, owner.current)
    if (!result.ok) throw new KnowledgeDocumentError(result.code, result.error)
    owner.assertCurrent()
    return { opened: true, currentRevision, differsFromPreview }
  } catch (error) { return ioFailure(error) }
}
