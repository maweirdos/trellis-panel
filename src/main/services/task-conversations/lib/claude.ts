import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ExternalConversation } from '../../../../shared/task-conversations'
import type { NativeIdentity, NativeHistoryFile } from '../types'
import { boundedEntries, MAX_ITEMS, ownedPath, pathKey, projectCwd, readBounded, readEdges, safeId, nativeSessionId, timestamp } from './paths'
import { conversation } from './native-sqlite'

const metadataSchema = z.object({
  type: z.string().optional(), sessionId: z.string().optional(), cwd: z.string().optional(),
  isSidechain: z.boolean().optional(),
  customTitle: z.string().optional(), summary: z.string().optional(), timestamp: z.union([z.number(), z.string()]).optional()
})
const indexSchema = z.object({ entries: z.array(z.object({
  sessionId: z.string(), projectPath: z.string().optional(), customTitle: z.string().optional(),
  summary: z.string().optional(), modified: z.union([z.string(), z.number()]).optional()
})).max(10000) })
type Indexed = z.infer<typeof indexSchema>['entries'][number]

function readSession(sourceRoot: string, file: string, root: string, id: string, indexed?: Indexed): ExternalConversation | null {
  if (!nativeSessionId('claude-code', id)) return null
  const path = ownedPath(sourceRoot, file)
  if (!statSync(path).isFile()) return null
  let cwd: string | null = null
  let nativeTitle = indexed?.customTitle
  let summary = indexed?.summary
  let updatedAt = timestamp(indexed?.modified)
  // Only named metadata fields are retained. Transcript bodies are neither exposed nor cached.
  for (const line of readEdges(path).split('\n')) {
    let raw: unknown
    try { raw = JSON.parse(line) } catch { continue }
    const parsed = metadataSchema.safeParse(raw)
    if (!parsed.success) continue
    const item = parsed.data
    if (item.isSidechain === true) return null
    if (item.sessionId && item.sessionId !== id) return null
    if (item.sessionId === id && item.cwd) {
      const canonical = projectCwd(root, item.cwd)
      if (!canonical || (cwd && pathKey(cwd) !== pathKey(canonical))) return null
      cwd = canonical
    }
    if (item.type === 'custom-title' && item.sessionId === id && item.customTitle) nativeTitle = item.customTitle
    if (item.type === 'summary' && item.summary) summary = item.summary
    updatedAt = Math.max(updatedAt, timestamp(item.timestamp))
  }
  // Index paths alone never prove that an existing history file belongs to this project.
  if (!cwd || (indexed?.projectPath && pathKey(indexed.projectPath) !== pathKey(cwd))) return null
  return conversation('claude-code', id, cwd, nativeTitle || summary || null, updatedAt || Math.floor(statSync(path).mtimeMs), nativeTitle ? 'native' : 'summary')
}
export function readClaude(sourceRoot: string, root: string, requested: NativeIdentity[], histories: NativeHistoryFile[] = []): { items: ExternalConversation[]; truncated: boolean } {
  const projects = ownedPath(sourceRoot, join(sourceRoot, 'projects'))
  const listing = boundedEntries(projects)
  const items: ExternalConversation[] = []
  let truncated = listing.truncated
  let remaining = 256
  // Project directory names are only a scanning hint; every result requires file metadata cwd.
  const expected = root.replace(/[^a-zA-Z0-9]/g, '-')
  const exact = join(projects, expected)
  const matching = listing.names.filter(name => {
    const normal = process.platform === 'win32' ? name.toLowerCase() : name
    const prefix = process.platform === 'win32' ? expected.toLowerCase() : expected
    return normal === prefix || normal.startsWith(`${prefix}-`)
  })
  const partitions = [...new Set([...(existsSync(exact) ? [expected] : []), ...matching])]
  for (const partition of partitions) {
    const dir = ownedPath(sourceRoot, join(projects, partition))
    const indexFile = join(dir, 'sessions-index.json')
    const indexed = new Map<string, Indexed>()
    if (existsSync(indexFile)) {
      const parsed = indexSchema.safeParse(JSON.parse(readBounded(ownedPath(sourceRoot, indexFile))))
      if (!parsed.success) throw new Error('Claude 会话索引 schema 不受支持')
      for (const item of parsed.data.entries) if (safeId(item.sessionId)) indexed.set(item.sessionId, item)
    }
    const files = boundedEntries(dir, remaining)
    truncated ||= files.truncated
    const ids = new Set<string>()
    for (const item of requested) if (item.source === 'claude-code' && safeId(item.sessionId)) ids.add(item.sessionId)
    for (const name of files.names) if (name.endsWith('.jsonl')) ids.add(name.slice(0, -6))
    for (const id of [...ids].slice(0, MAX_ITEMS)) {
      if (remaining-- <= 0) { truncated = true; break }
      const file = join(dir, `${id}.jsonl`)
      if (!existsSync(file)) continue
      const item = readSession(sourceRoot, file, root, id, indexed.get(id))
      if (item) { items.push(item); histories.push({ conversation: item, sourceRoot, file }) }
    }
  }
  return { items, truncated }
}
