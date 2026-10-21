import { realpathSync, statSync, openSync, readSync, closeSync, opendirSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { TaskConversationError } from '../types'

export const MAX_ITEMS = 500
export const MAX_JSON_BYTES = 2 * 1024 * 1024
export const MAX_JSONL_SLICE = 128 * 1024
export const MAX_SCAN_FILES = 256
export const NATIVE_BUSY_MS = 50

/** Codex stores Windows extended-length drive paths (\\\\?\\D:\\...) in its index. */
export function ordinaryPath(path: string): string {
  return process.platform === 'win32' && /^\\\\\?\\[a-zA-Z]:\\/.test(path) ? path.slice(4) : path
}
export function pathKey(path: string): string {
  const normal = resolve(ordinaryPath(path)).replace(/\\/g, '/').replace(/\/$/, '')
  return process.platform === 'win32' ? normal.toLowerCase() : normal
}
export function inside(root: string, path: string): boolean {
  const rel = relative(ordinaryPath(root), ordinaryPath(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
export function canonicalRoot(root: string): string {
  if (typeof root !== 'string' || !isAbsolute(root) || /[\x00-\x1f]/.test(root)) throw new TaskConversationError('E_INVALID_ARG', '项目路径无效')
  const canonical = ordinaryPath(realpathSync(ordinaryPath(root)))
  if (!statSync(canonical).isDirectory()) throw new TaskConversationError('E_NOT_FOUND', '项目目录不存在')
  return canonical
}
export function projectCwd(root: string, cwd: string): string | null {
  if (!isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd)) return null
  try {
    const canonical = ordinaryPath(realpathSync(ordinaryPath(cwd)))
    return statSync(canonical).isDirectory() && inside(root, canonical) ? canonical : null
  } catch { return null }
}
export function ownedPath(root: string, file: string): string {
  const canonical = ordinaryPath(realpathSync(ordinaryPath(file)))
  if (!inside(realpathSync(ordinaryPath(root)), canonical)) throw new TaskConversationError('E_UNAVAILABLE', '原生元信息路径不属于来源目录')
  return canonical
}
/** Read a fixed byte budget even if another process grows/replaces the file. */
export function readBounded(file: string, limit = MAX_JSON_BYTES, tail = false): string {
  const fd = openSync(file, 'r')
  try {
    const size = statSync(file).size
    if (!tail && size > limit) throw new TaskConversationError('E_UNAVAILABLE', '元信息文件超过读取上限')
    const buffer = Buffer.alloc(Math.min(size, limit))
    const start = tail ? Math.max(0, size - limit) : 0
    const bytes = readSync(fd, buffer, 0, buffer.length, start)
    const text = buffer.subarray(0, bytes).toString('utf8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally { closeSync(fd) }
}
export function readEdges(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(MAX_JSONL_SLICE)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, bytes).toString('utf8')
    return head + '\n' + readBounded(file, MAX_JSONL_SLICE, true)
  } finally { closeSync(fd) }
}
export function boundedEntries(directory: string, limit = MAX_SCAN_FILES): { names: string[]; truncated: boolean } {
  const names: string[] = []
  const dir = opendirSync(directory)
  try {
    let entry = dir.readSync()
    while (entry && names.length <= limit) { names.push(entry.name); entry = dir.readSync() }
    return { names: names.slice(0, limit), truncated: names.length > limit || entry !== null }
  } finally { dir.closeSync() }
}
export function safeId(id: string): boolean { return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(id) }
export function nativeSessionId(source: string, id: string): boolean {
  return source === 'zcode' ? safeId(id) : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}
export function timestamp(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : 0
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0
}
