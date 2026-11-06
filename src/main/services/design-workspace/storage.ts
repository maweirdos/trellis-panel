import { readdirSync } from 'node:fs'
import { z } from 'zod'
import { DESIGN_MAX_PAGES, type DesignFrame, type DesignPage } from '../../../shared/design-workspace'
import { IpcErrorCode } from '../../../shared/ipc-errors'
import { checkedDirectory, hash, ownedDirectory } from '../private-conversations/files'
import { utf8, writeRevision } from '../private-conversations/requirement-files'
import { readDesignRecord } from './interrupted-publication'
import { designSnapshotSchema, DesignWorkspaceError, type DesignSnapshot } from './types'

export const DESIGN_RECORD_LIMIT = 512 * 1024
export class DesignStorage {
  constructor(private readonly directory: () => string) {}
  root(): string { return ownedDirectory(checkedDirectory(this.directory()), 'design-workspace') }
  read<T>(path: string, schema: z.ZodType<T>, limit = DESIGN_RECORD_LIMIT): { value: T; digest: string } | null {
    const actual = readDesignRecord(this.root(), path, limit)
    if (!actual) return null
    return { value: schema.parse(JSON.parse(utf8(actual.bytes))), digest: hash(actual.bytes) }
  }
  write<T>(path: string, schema: z.ZodType<T>, value: T, expected: string | null, current: () => void, limit = DESIGN_RECORD_LIMIT): void {
    const bytes = Buffer.from(JSON.stringify(schema.parse(value)))
    if (bytes.length > limit) throw new DesignWorkspaceError('设计记录超过存储上限，原内容已保留', IpcErrorCode.Busy)
    const root = this.root()
    current()
    const original = readDesignRecord(root, path, limit)
    if (original?.finishPublication) {
      schema.parse(JSON.parse(utf8(original.bytes)))
      if (hash(original.bytes) !== expected) throw new DesignWorkspaceError('文件已改变；未覆盖实际文件', IpcErrorCode.Conflict)
      original.finishPublication(current)
    }
    writeRevision(root, path, bytes, expected, current)
  }
  ids(directory: 'documents' | 'conversations'): string[] {
    const root = ownedDirectory(this.root(), directory)
    const names = readdirSync(root)
    if (names.length > 5000) throw new DesignWorkspaceError('设计索引超过读取上限', IpcErrorCode.Busy)
    return names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => name.slice(0, -5))
  }
  snapshot(documentId: string, revision: string): DesignSnapshot {
    z.string().uuid().parse(documentId); z.string().regex(/^[a-f0-9]{64}$/).parse(revision)
    const value = this.read(`revisions/${documentId}/${revision}.json`, designSnapshotSchema, 2 * 1024 * 1024)?.value
    if (!value || value.revision !== revision || snapshotRevision(value.title, value.pages, value.frames) !== revision) throw new DesignWorkspaceError('设计修订不存在或内容摘要已改变', IpcErrorCode.Conflict)
    validateFrames(value.pages, value.frames)
    return value
  }
  saveSnapshot(documentId: string, value: DesignSnapshot, current: () => void): void {
    const path = `revisions/${documentId}/${value.revision}.json`, original = this.read(path, designSnapshotSchema, 2 * 1024 * 1024)
    if (original) {
      if (JSON.stringify(original.value) !== JSON.stringify(value)) throw new DesignWorkspaceError('既有设计修订已改变，未覆盖历史')
      current(); return
    }
    this.write(path, designSnapshotSchema, value, null, current, 2 * 1024 * 1024)
  }
}
export function validateFrames(pages: DesignPage[], frames: DesignFrame[]): void {
  const pageIds = new Set(pages.map(page => page.id)), ids = new Set<string>(), framed = new Set<string>()
  if (frames.length !== pages.length || frames.length > DESIGN_MAX_PAGES) throw new DesignWorkspaceError('每个页面必须对应一个画框', IpcErrorCode.InvalidArg)
  for (const frame of frames) {
    const key = frame.id.toLowerCase()
    if (ids.has(key) || framed.has(frame.pageId) || !pageIds.has(frame.pageId)) throw new DesignWorkspaceError('画框身份重复或页面关联无效', IpcErrorCode.InvalidArg)
    ids.add(key); framed.add(frame.pageId)
  }
}
export function defaultFrames(pages: DesignPage[], original: DesignFrame[] = []): DesignFrame[] {
  let x = 0
  return pages.map(page => {
    const previous = original.find(frame => frame.pageId === page.id)
    const frame = previous ?? { id: page.id, pageId: page.id, x, y: 0, width: page.width, height: page.height }
    x = Math.max(x, frame.x + frame.width + 80)
    return frame
  })
}
export function snapshotRevision(title: string, pages: DesignPage[], frames: DesignFrame[]): string { return hash(JSON.stringify({ title, pages, frames })) }
export function makeSnapshot(title: string, pages: DesignPage[], frames: DesignFrame[]): DesignSnapshot {
  validateFrames(pages, frames)
  return designSnapshotSchema.parse({ title, pages, frames, revision: snapshotRevision(title, pages, frames) })
}
