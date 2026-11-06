import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ConversationFile } from '../../../shared/private-conversations'

export const FILE_LIMIT = 16 * 1024 * 1024
export class FileSizeLimitError extends Error { constructor() { super('文件超过大小限制') } }
const extensions = new Set(['.md', '.txt', '.html', '.htm', '.pdf', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.csv', '.tsv', '.json', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.sql', '.xml', '.docx', '.xlsx', '.pptx', '.zip', '.mp3', '.wav', '.mp4', '.glb', '.gltf', '.wasm'])
const ignored = new Set(['node_modules', 'vendor', 'dist', 'build', '__pycache__', 'coverage', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'auth.json', 'credentials.json', 'secrets.json'])
export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export const pathKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
function inside(root: string, value: string): boolean { const part = relative(root, value); return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`) }
export function checkedDirectory(root: string): string {
  if (!isAbsolute(root)) throw new Error('需要已授权的绝对目录')
  const actual = realpathSync.native(root)
  if (!statSync(actual).isDirectory() || pathKey(actual) !== pathKey(resolve(root)) || lstatSync(root).isSymbolicLink()) throw new Error('目录已被重定向，请重新选择')
  return actual
}
export function directoryIdentity(root: string): string {
  const info = statSync(checkedDirectory(root), { bigint: true })
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`
}
/** Publish a native save selection without truncating or writing its existing inode. */
export function saveSelectedFile(file: string, bytes: Buffer, current: () => void): void {
  if (!isAbsolute(file) || bytes.length > FILE_LIMIT) throw new Error('保存文件路径或大小无效')
  const directory = checkedDirectory(dirname(file)), identity = directoryIdentity(directory), target = join(directory, basename(file))
  const fingerprint = (path: string): string | null => {
    try {
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || pathKey(realpathSync.native(path)) !== pathKey(path)) throw new Error('不能覆盖链接或非普通文件')
      return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  const original = fingerprint(target), temporary = join(directory, `.conversation-export-${randomUUID()}.tmp`)
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  const opened = fstatSync(descriptor)
  let published = false
  try {
    if (!opened.isFile() || opened.nlink !== 1 || directoryIdentity(directory) !== identity) throw new Error('保存目录或临时文件已变化')
    current(); writeFileSync(descriptor, bytes); fsyncSync(descriptor)
    const saved = fstatSync(descriptor), named = lstatSync(temporary)
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino || named.nlink !== 1 || saved.nlink !== 1 || named.size !== bytes.length || saved.size !== bytes.length || directoryIdentity(directory) !== identity || fingerprint(target) !== original) throw new Error('保存目标已变化，未覆盖原文件')
    current()
    // Rename replaces the selected directory entry; a late destination link
    // cannot redirect a write into another file's contents.
    renameSync(temporary, target); published = true
    const final = lstatSync(target)
    if (!final.isFile() || final.isSymbolicLink() || final.dev !== opened.dev || final.ino !== opened.ino || final.nlink !== 1 || final.size !== bytes.length || directoryIdentity(directory) !== identity) throw new Error('保存完成状态未确认，请核对所选目标')
  } finally {
    closeSync(descriptor)
    if (!published) {
      try { const retained = lstatSync(temporary); if (retained.isFile() && !retained.isSymbolicLink() && retained.dev === opened.dev && retained.ino === opened.ino && directoryIdentity(directory) === identity) unlinkSync(temporary) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.emitWarning('会话导出临时文件清理未确认', { code: 'TRELLIS_CONVERSATION_EXPORT_CLEANUP' }) }
    }
  }
}
function components(root: string, file: string, create = false): string {
  const base = checkedDirectory(root)
  if (!file || isAbsolute(file) || file.includes('\0') || file.replaceAll('\\', '/').split('/').some(part => !part || part === '.' || part === '..' || part.includes(':') || /[ .]$/.test(part))) throw new Error('会话文件路径无效')
  const target = resolve(base, file)
  if (!inside(base, target)) throw new Error('文件超出原会话目录')
  let current = base
  for (const part of relative(base, dirname(target)).split(sep).filter(Boolean)) {
    current = join(current, part)
    if (create) { try { mkdirSync(current) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error } }
    const info = lstatSync(current)
    if (!info.isDirectory() || info.isSymbolicLink() || pathKey(realpathSync.native(current)) !== pathKey(current)) throw new Error('文件目录含链接或已被重定向')
  }
  return target
}
export function ownedDirectory(root: string, directory: string): string {
  const target = components(root, `${directory}/.directory`, true)
  return dirname(target)
}
export function readRegular(root: string, file: string, limit = FILE_LIMIT): { bytes: Buffer; path: string; modifiedAt: number; fileIdentity: string } {
  const target = components(root, file), named = lstatSync(target)
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || pathKey(realpathSync.native(target)) !== pathKey(target)) throw new Error('文件必须是普通文件，不能使用链接')
  if (named.size > limit) throw new FileSizeLimitError()
  const descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.nlink !== 1) throw new Error('文件不可读')
    if (before.size > limit) throw new FileSizeLimitError()
    const bytes = Buffer.alloc(before.size + 1)
    let count = 0
    while (count < bytes.length) { const n = readSync(descriptor, bytes, count, bytes.length - count, null); if (!n) break; count += n }
    for (const after of [fstatSync(descriptor), lstatSync(components(root, file))]) {
      if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1 || count !== before.size) throw new Error('文件在读取时改变，请重新选择')
    }
    const identity = fstatSync(descriptor, { bigint: true })
    return { bytes: bytes.subarray(0, count), path: target, modifiedAt: before.mtimeMs, fileIdentity: hash(`${identity.dev}:${identity.ino}:${identity.birthtimeNs}`) }
  } finally { closeSync(descriptor) }
}
export function fileMetadata(root: string, file: string, kind: 'input' | 'output'): ConversationFile & { fileIdentity: string } {
  const actual = readRegular(root, file)
  const storedName = basename(file)
  const name = kind === 'input' ? storedName.replace(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-/i, '') : storedName
  return { id: hash(file.replaceAll('\\', '/')), name, relativePath: file.replaceAll('\\', '/'), kind, bytes: actual.bytes.length, revision: hash(actual.bytes), modifiedAt: actual.modifiedAt, fileIdentity: actual.fileIdentity }
}
export function importSelectedFiles(root: string, directory: string, selected: string[]): ConversationFile[] {
  if (selected.length > 16) throw new Error('每次最多选择 16 个文件')
  const destination = ownedDirectory(root, directory), result: ConversationFile[] = []
  const prepared: Array<{ name: string; bytes: Buffer }> = []
  let total = 0
  for (const file of selected) {
    if (!isAbsolute(file)) throw new Error('原生文件选择无效')
    const actual = realpathSync.native(file)
    if (pathKey(actual) !== pathKey(resolve(file))) throw new Error('所选文件含重定向，请直接选择原文件')
    const source = readRegular(dirname(actual), basename(actual))
    total += source.bytes.length
    if (total > 64 * 1024 * 1024) throw new Error('所选文件总大小超过 64 MiB')
    const safeName = basename(actual).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-180)
    prepared.push({ name: `${randomUUID()}-${safeName}`, bytes: source.bytes })
  }
  try {
    for (const source of prepared) {
      const file = relative(root, join(destination, source.name)), target = components(root, file)
      writeFileSync(target, source.bytes, { flag: 'wx', mode: 0o600 })
      const { fileIdentity: _fileIdentity, ...metadata } = fileMetadata(root, file, 'input')
      result.push(metadata)
    }
    return result
  } catch (error) { removeImportedFiles(root, result); throw error }
}
export function removeImportedFiles(root: string, files: ConversationFile[]): void {
  for (const file of files) {
    const actual = readRegular(root, file.relativePath)
    if (hash(actual.bytes) !== file.revision) throw new Error('选入文件已改变，未删除其新内容')
    unlinkSync(actual.path)
  }
}
/** Recheck the eligibility of a previously discovered path without enumerating the directory. */
export function eligibleWorkspaceFile(file: string, kind: 'input' | 'output', inputs: string[], managed: boolean): boolean {
  const parts = file.split('/')
  if (!file || file.includes('\\') || parts.some(part => !part || part === '.' || part === '..')) return false
  const known = inputs.some(input => input.replaceAll('\\', '/') === file)
  if (kind === 'input') return known
  if (known || parts.length > 9 || !extensions.has(extname(file).toLowerCase())) return false
  for (let index = 0; index < parts.length; index++) {
    const name = parts[index].toLowerCase(), current = parts.slice(0, index + 1).join('/')
    if (name.startsWith('.') || ignored.has(name) || managed && index === 0 && name === 'inputs' || /(?:secret|credential|api[-_]?key|password|token)(?:[._-]|$)/i.test(name)) return false
    if (managed && index < parts.length - 1 && /^outputs\/requirements\/[a-f0-9-]{36}\/(?:operations|confirmations|sources)$/i.test(current)) return false
  }
  return true
}
export function workspaceFiles(root: string, inputs: string[], managed = false): Array<ConversationFile & { fileIdentity: string }> {
  checkedDirectory(root)
  const result: Array<ConversationFile & { fileIdentity: string }> = []
  const known = new Set(inputs.map(file => file.replaceAll('\\', '/')))
  for (const file of known) { try { result.push(fileMetadata(root, file, 'input')) } catch { /* Missing or changed imported files are not advertised as available. */ } }
  let scanned = 0, bytes = result.reduce((sum, file) => sum + file.bytes, 0)
  const visit = (directory: string, depth: number): void => {
    if (depth > 8 || scanned >= 4000 || result.length >= 300 || bytes >= 64 * 1024 * 1024) return
    const target = directory ? dirname(components(root, `${directory}/.entry`)) : checkedDirectory(root)
    const stream = opendirSync(target)
    try {
    if (directory) components(root, `${directory}/.entry`)
    for (let entry = stream.readSync(); entry; entry = stream.readSync()) {
      if (++scanned > 4000 || result.length >= 300 || bytes >= 64 * 1024 * 1024) break
      const name = entry.name.toLowerCase()
      if (name.startsWith('.') || ignored.has(name) || managed && !directory && name === 'inputs' || /(?:secret|credential|api[-_]?key|password|token)(?:[._-]|$)/i.test(name)) continue
      const file = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      // Workbench command inputs and candidates are not user output materials.
      if (managed && entry.isDirectory() && /^outputs\/requirements\/[a-f0-9-]{36}\/(?:operations|confirmations|sources)$/i.test(file)) continue
      if (entry.isDirectory()) { visit(file, depth + 1); continue }
      if (!entry.isFile() || known.has(file) || !extensions.has(extname(name))) continue
      try { const value = fileMetadata(root, file, 'output'); bytes += value.bytes; result.push(value) } catch { /* Ineligible/unstable files are excluded, never fabricated. */ }
    }
    } finally { stream.closeSync() }
  }
  visit('', 0)
  return result
}
