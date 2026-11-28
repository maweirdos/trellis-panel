import type { ConversationProjectedWorkItem } from '../../../shared/conversation/command-runtime'
import { patchRows } from '../my/git/patch'

export interface TurnChangedFileEntry {
  readonly path: string
  readonly kind: 'added' | 'modified' | 'deleted' | 'renamed'
  readonly additions: number
  readonly deletions: number
}

export type ChangedFileTreeNode =
  | {
      readonly kind: 'directory'
      readonly name: string
      readonly fullPath: string
      readonly children: readonly ChangedFileTreeNode[]
    }
  | {
      readonly kind: 'file'
      readonly name: string
      readonly file: TurnChangedFileEntry
    }

function normalizeChangeKind(raw: string | undefined): TurnChangedFileEntry['kind'] {
  const lower = (raw ?? '').toLowerCase()
  if (lower.includes('add') || lower === 'create' || lower === 'a') return 'added'
  if (lower.includes('del') || lower.includes('rem') || lower === 'd') return 'deleted'
  if (lower.includes('ren') || lower.includes('mov') || lower === 'r') return 'renamed'
  return 'modified'
}

function normalizePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim()
}

export function extractRunChangedFiles(
  turnItems: readonly ConversationProjectedWorkItem[],
  runId: string,
): readonly TurnChangedFileEntry[] {
  const byPath = new Map<string, { kind: TurnChangedFileEntry['kind']; additions: number; deletions: number }>()
  for (const item of turnItems) {
    if (item.runId !== runId || item.type !== 'file_change') continue
    const rows = item.diffStr ? patchRows(item.diffStr) : []
    const itemAdded = rows.filter((row) => row.kind === 'add').length
    const itemRemoved = rows.filter((row) => row.kind === 'remove').length
    const changes = item.changes?.length
      ? item.changes.map((change) => ({ path: change.path, operation: change.operation }))
      : item.fileName
        ? [{ path: item.fileName, operation: 'modified' }]
        : []
    const shareAdded = changes.length === 1 ? itemAdded : 0
    const shareRemoved = changes.length === 1 ? itemRemoved : 0
    for (const change of changes) {
      const cleaned = normalizePath(change.path)
      if (!cleaned) continue
      const existing = byPath.get(cleaned)
      const nextKind = normalizeChangeKind(change.operation)
      if (existing) {
        existing.additions += shareAdded
        existing.deletions += shareRemoved
        if (nextKind === 'deleted' || existing.kind !== 'added') existing.kind = nextKind
      } else {
        byPath.set(cleaned, { kind: nextKind, additions: shareAdded, deletions: shareRemoved })
      }
    }
  }
  return [...byPath.entries()]
    .map(([path, meta]) => ({ path, kind: meta.kind, additions: meta.additions, deletions: meta.deletions }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

interface MutableDirNode {
  name: string
  fullPath: string
  dirs: Map<string, MutableDirNode>
  files: TurnChangedFileEntry[]
}

function finalizeTree(dir: MutableDirNode): readonly ChangedFileTreeNode[] {
  const result: ChangedFileTreeNode[] = []
  const sortedDirs = [...dir.dirs.values()].sort((left, right) => left.name.localeCompare(right.name))
  for (let child of sortedDirs) {
    // 压缩单子目录链（如 src/renderer/src），避免无意义的深层嵌套
    let collapsedName = child.name
    let collapsedPath = child.fullPath
    while (child.dirs.size === 1 && child.files.length === 0) {
      const only = child.dirs.values().next().value
      if (!only) break
      collapsedName = `${collapsedName}/${only.name}`
      collapsedPath = only.fullPath
      child = only
    }
    result.push({
      kind: 'directory',
      name: collapsedName,
      fullPath: collapsedPath,
      children: finalizeTree(child),
    })
  }
  const sortedFiles = [...dir.files].sort((left, right) => left.path.localeCompare(right.path))
  for (const file of sortedFiles) {
    const baseName = file.path.split('/').at(-1) ?? file.path
    result.push({ kind: 'file', name: baseName, file })
  }
  return result
}

export function buildChangedFileTree(files: readonly TurnChangedFileEntry[]): readonly ChangedFileTreeNode[] {
  const root: MutableDirNode = { name: '', fullPath: '', dirs: new Map(), files: [] }
  for (const file of files) {
    const segments = normalizePath(file.path).split('/').filter(Boolean)
    if (segments.length <= 1) {
      root.files.push(file)
      continue
    }
    let current = root
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]
      const nextPath = current.fullPath ? `${current.fullPath}/${segment}` : segment
      let nextDir = current.dirs.get(segment)
      if (!nextDir) {
        nextDir = { name: segment, fullPath: nextPath, dirs: new Map(), files: [] }
        current.dirs.set(segment, nextDir)
      }
      current = nextDir
    }
    current.files.push(file)
  }
  return finalizeTree(root)
}
