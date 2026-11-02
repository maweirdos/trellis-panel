import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { REQUIREMENT_BODY_BYTES } from '../../../shared/conversation-requirements'
import { checkedDirectory, directoryIdentity, hash, ownedDirectory, pathKey, readRegular, saveSelectedFile } from './files'

export class RequirementError extends Error {
  constructor(message: string, readonly code: 'E_CONFLICT' | 'E_DENIED' | 'E_INVALID_ARG' | 'E_IO' | 'E_NOT_FOUND' | 'E_BUSY' = 'E_CONFLICT') { super(message) }
}
export function readOptional(root: string, path: string, limit = REQUIREMENT_BODY_BYTES): ReturnType<typeof readRegular> | null {
  try { return readRegular(root, path, limit) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new RequirementError('需求文件必须是完整 UTF-8 文本', 'E_INVALID_ARG') }
}
export function writeRevision(root: string, path: string, bytes: Buffer, expected: string | null, current: () => void): void {
  const directory = ownedDirectory(root, dirname(path).replaceAll('\\', '/'))
  const target = join(directory, basename(path)), directoryId = directoryIdentity(directory)
  const assert = (): void => {
    current()
    if (directoryIdentity(directory) !== directoryId) throw new RequirementError('保存目录已变化')
    const actual = readOptional(root, path, Math.max(2 * 1024 * 1024, bytes.length))
    if ((actual ? hash(actual.bytes) : null) !== expected) throw new RequirementError('文件已改变；未覆盖实际文件')
  }
  assert()
  if (expected !== null) { saveSelectedFile(target, bytes, assert); return }
  const temporary = join(directory, `.requirement-${randomUUID()}.tmp`), descriptor = openSync(temporary, 'wx', 0o600)
  const opened = fstatSync(descriptor)
  let closed = false
  try {
    writeFileSync(descriptor, bytes); fsyncSync(descriptor); closeSync(descriptor); closed = true
    const actual = readRegular(root, relative(root, temporary), Math.max(bytes.length, REQUIREMENT_BODY_BYTES))
    if (hash(actual.bytes) !== hash(bytes)) throw new RequirementError('临时文件保存校验失败', 'E_IO')
    assert()
    try { linkSync(temporary, target) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RequirementError('目标已存在，未覆盖'); throw error }
    unlinkSync(temporary)
  } catch (error) {
    if (!closed) { try { closeSync(descriptor) } catch { /* Preserve the original save failure. */ } }
    try { const info = lstatSync(temporary); if (info.isFile() && !info.isSymbolicLink() && info.dev === opened.dev && info.ino === opened.ino && directoryIdentity(directory) === directoryId) unlinkSync(temporary) } catch { /* Original target is never used as cleanup authority. */ }
    throw error
  }
}
export function trellisTarget(root: string): { root: string; identity: string } {
  const canonical = checkedDirectory(root)
  for (const directory of ['.trellis', '.trellis/tasks', '.trellis/scripts']) {
    const value = checkedDirectory(join(canonical, directory))
    if (pathKey(value) !== pathKey(join(canonical, directory))) throw new RequirementError('Trellis 目录包含重定向', 'E_DENIED')
  }
  readRegular(canonical, '.trellis/scripts/task.py', 1024 * 1024)
  readRegular(canonical, '.trellis/workflow.md', 1024 * 1024)
  return { root: canonical, identity: directoryIdentity(canonical) }
}
