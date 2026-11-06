import { ZipReaderStream } from '@zip.js/zip.js/index-native.js'
import { zipSync } from 'fflate'
import mammoth from 'mammoth'
import { DocxPreviewLimitError } from '../../../shared/docx-preview'

const MAX_INPUT = 8 * 1024 * 1024
const MAX_ENTRY = 6 * 1024 * 1024
const MAX_TOTAL = 24 * 1024 * 1024
const MAX_ENTRIES = 512
const MAX_HTML = 2 * 1024 * 1024
const MAX_NAME_BYTES = 1024

function invalidArchive(): never { throw new DocxPreviewLimitError('invalid-document') }

/** Validate the original central-directory CRC and actual output before repacking. */
async function checkedArchive(bytes: Uint8Array): Promise<Uint8Array> {
  if (!bytes.length) invalidArchive()
  if (bytes.length > MAX_INPUT) throw new DocxPreviewLimitError('input-limit')
  const archive = new ZipReaderStream({
    strictness: 'strict', checkCrc32: true, checkOverlappingEntry: true,
    checkLocalDirectory: true, checkLocalFilename: true,
    useWebWorkers: false, useCompressionStream: true
  })
  const pump = new Blob([bytes as BlobPart]).stream().pipeTo(archive.writable)
  void pump.catch(() => {})
  const list = archive.readable.getReader()
  const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>
  const names = new Set<string>()
  let total = 0, declared = 0, count = 0, completed = false
  try {
    while (true) {
      const next = await list.read()
      if (next.done) { completed = true; break }
      const entry = next.value
      if (++count > MAX_ENTRIES) throw new DocxPreviewLimitError('entry-count-limit')
      const name = entry.filename, parts = name.split('/')
      if (name.endsWith('/')) parts.pop()
      if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.includes(':')) || name.startsWith('/') || name.includes('\\') || name.includes('\0') || entry.rawFilename.length > MAX_NAME_BYTES || entry.encrypted || entry.symlink || !entry.bitFlag || typeof entry.bitFlag.dataDescriptor !== 'boolean' || entry.bitFlag.dataDescriptor || entry.compressionMethod !== 0 && entry.compressionMethod !== 8 || typeof entry.crc32 !== 'number' || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) invalidArchive()
      const key = parts.join('/').normalize('NFC').toLowerCase()
      if (names.has(key)) invalidArchive()
      names.add(key)
      if (entry.uncompressedSize > MAX_ENTRY) throw new DocxPreviewLimitError('entry-size-limit')
      declared += entry.uncompressedSize
      if (declared > MAX_TOTAL) throw new DocxPreviewLimitError('archive-size-limit')
      if (!entry.readable) invalidArchive()
      const stream = entry.readable.getReader(), chunks: Uint8Array[] = []
      let actual = 0
      try {
        while (true) {
          const data = await stream.read()
          if (data.done) break
          const chunk = data.value
          actual += chunk.length; total += chunk.length
          if (actual > MAX_ENTRY) throw new DocxPreviewLimitError('entry-size-limit')
          if (total > MAX_TOTAL) throw new DocxPreviewLimitError('archive-size-limit')
          chunks.push(chunk)
        }
      } catch (error) {
        void stream.cancel().catch(() => {})
        throw error
      }
      if (actual !== entry.uncompressedSize || entry.directory && actual !== 0) invalidArchive()
      if (!entry.directory) {
        const content = new Uint8Array(actual)
        let offset = 0
        for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length }
        files[name] = content
      }
    }
    await pump
    if (!names.has('[content_types].xml') || !names.has('word/document.xml')) invalidArchive()
    return zipSync(files, { level: 0 })
  } catch (error) {
    if (error instanceof DocxPreviewLimitError) throw error
    throw new DocxPreviewLimitError('invalid-document')
  } finally {
    if (!completed) await list.cancel().catch(() => {})
    list.releaseLock()
    await pump.catch(() => {})
  }
}

self.onmessage = (event: MessageEvent<unknown>): void => {
  void (async () => {
    try {
      if (!(event.data instanceof ArrayBuffer)) throw new Error('invalid-input')
      const archive = await checkedArchive(new Uint8Array(event.data))
      let omittedImages = 0
      const result = await mammoth.convertToHtml({ arrayBuffer: archive.buffer as ArrayBuffer }, {
        externalFileAccess: false,
        includeEmbeddedStyleMap: false,
        convertImage: mammoth.images.imgElement(async () => { omittedImages++; return { src: '' } })
      })
      if (new TextEncoder().encode(result.value).length > MAX_HTML) throw new DocxPreviewLimitError('html-size-limit')
      self.postMessage({ ok: true, html: result.value, omittedImages })
    } catch (error) {
      self.postMessage({ ok: false, code: error instanceof DocxPreviewLimitError ? error.code : 'invalid-document' })
    }
  })()
}
