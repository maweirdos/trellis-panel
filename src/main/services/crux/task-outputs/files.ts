import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveAuthorizedDocumentPath } from '../../documents/paths'
import { nativeRootKey } from '../task-workspace-records'
import { MAX_OUTPUT_BYTES, TaskOutputError } from './types'

export const outputHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
export function outputFileStamp(root: string, relative: string): string {
  const info = statSync(physical(root, relative))
  if (!info.isFile() || info.nlink !== 1 || info.size > MAX_OUTPUT_BYTES) throw new TaskOutputError('OUTPUT_SIZE_OR_LINK', '受管正文必须是单份普通文件，且不超过 1 MiB')
  return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])
}
function physical(root: string, relative: string): string {
  const value = resolveAuthorizedDocumentPath(root, relative)
  if (!value.ok || !value.exists || nativeRootKey(value.canonicalPath) !== nativeRootKey(resolve(root, relative))) throw new TaskOutputError('OUTPUT_PATH_CHANGED', '受管文件已移除、越界或被重定向；原同步意图已保留')
  return value.canonicalPath
}
/** Exact, bounded UTF-8 without following redirected paths or accepting torn descriptor reads. */
export function readOutputFile(root: string, relative: string, limit = MAX_OUTPUT_BYTES): { text: string; digest: string; byteLength: number; mtime: number } {
  const descriptor = openSync(physical(root, relative), 'r')
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new TaskOutputError('OUTPUT_SIZE_OR_LINK', '受管正文必须是单份普通文件，且不超过 1 MiB')
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) { const n = readSync(descriptor, buffer, length, buffer.length - length, null); if (!n) break; length += n }
    for (const info of [fstatSync(descriptor), statSync(physical(root, relative))]) {
      if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size || info.mtimeMs !== before.mtimeMs || info.ctimeMs !== before.ctimeMs || info.nlink !== 1 || length !== before.size) throw new TaskOutputError('OUTPUT_UNSTABLE', '文件仍在保存或已被替换，尚未上传')
    }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)) }
    catch { throw new TaskOutputError('OUTPUT_ENCODING', '受管文件必须是完整 UTF-8 文本') }
    return { text, digest: outputHash(text), byteLength: length, mtime: before.mtimeMs }
  } finally { closeSync(descriptor) }
}
