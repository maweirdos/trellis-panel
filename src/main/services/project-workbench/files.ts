import { opendirSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { TextDecoder } from 'node:util'
import type { ProjectWorkbenchFileEntry } from '../../../shared/conversation/project-workbench'
import { DaemonError } from '../../daemon/errors'
import { checkedDirectory, hash, readRegular } from '../private-conversations/files'

const denied = new Set(['.git', 'node_modules', 'auth.json', 'credentials.json', 'secrets.json', '.ssh', '.aws', '.gnupg'])
const MAX_ENTRIES = 250
const PREVIEW_LIMIT = 512 * 1024

function allowedSegment(segment: string): boolean {
  const name = segment.toLowerCase()
  return name.length > 0 && !/[<>:"|?*\u0000-\u001f\u007f]|[ .]$/.test(name) && !denied.has(name) &&
    name !== '.env' && !name.startsWith('.env.') && !/\.(?:pem|pfx|key|p12)$/.test(name) &&
    !/^(?:con|nul|prn|aux|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
}

export function workbenchPath(path: string): string {
  if (path.includes('\\') || win32.isAbsolute(path) || !path.split('/').every(allowedSegment)) {
    throw new DaemonError('E_DENIED', '只能访问原工程内允许的相对资源。')
  }
  return path
}

export function workbenchFiles(root: string, directory?: string) {
  const target = directory ? checkedDirectory(join(root, workbenchPath(directory))) : root
  const handle = opendirSync(target)
  const entries: ProjectWorkbenchFileEntry[] = []
  let truncated = false
  try {
    for (let visited = 0; visited <= 4096; visited++) {
      const entry = handle.readSync()
      if (!entry) break
      if (visited === 4096 || entries.length === MAX_ENTRIES) { truncated = true; break }
      if ((!entry.isFile() && !entry.isDirectory()) || !allowedSegment(entry.name)) continue
      entries.push({ name: entry.name, path: directory ? `${directory}/${entry.name}` : entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })
    }
  } finally { handle.closeSync() }
  return { entries: entries.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)), truncated }
}

export function workbenchFile(root: string, path: string) {
  const file = readRegular(root, workbenchPath(path), PREVIEW_LIMIT)
  try {
    if (file.bytes.includes(0)) throw new Error('binary')
    return { path, text: new TextDecoder('utf-8', { fatal: true }).decode(file.bytes), modifiedAt: file.modifiedAt, revision: hash(file.bytes) }
  } catch { throw new DaemonError('E_UNAVAILABLE', '此文件格式无法在文本预览中打开。') }
}
