import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { externalConversationSchema, type ExternalConversation, type TaskConversationSource } from '../../../../shared/task-conversations'
import { MAX_ITEMS, NATIVE_BUSY_MS, ownedPath, pathKey, projectCwd, safeId, nativeSessionId, timestamp } from './paths'
import type { NativeIdentity } from '../types'

const rowSchema = z.object({
  sessionId: z.string().max(256), cwd: z.string().max(4096), title: z.string().max(4096).nullable(),
  updatedAt: z.union([z.number(), z.string(), z.null()]), role: z.enum(['user', 'subagent', 'unknown']).optional(),
  parentSessionId: z.string().max(256).nullable().optional()
})
type NativeColumns = {
  table: 'threads' | 'tasks'; id: string; cwd: string; title: string; updated: string
  predicate?: string; discoveryPredicate?: string; role?: string; parentSessionId?: string
}
export function conversation(source: TaskConversationSource, sessionId: string, cwd: string, title: string | null, updatedAt: unknown, titleSource: ExternalConversation['titleSource'] = 'native'): ExternalConversation {
  const trimmed = title?.trim().slice(0, 4096)
  return externalConversationSchema.parse({
    id: createHash('sha256').update(JSON.stringify([source, sessionId, pathKey(cwd)])).digest('hex'),
    source, sessionId, cwd, title: trimmed || sessionId, titleSource: trimmed ? titleSource : 'fallback',
    updatedAt: timestamp(updatedAt), capability: 'unavailable', unavailableReason: '正在核验原生打开能力'
  })
}
export function readNativeDatabase(sourceRoot: string, file: string, read: (db: DatabaseSync, columns: (table: string) => Set<string>) => ExternalConversation[]): ExternalConversation[] {
  const path = ownedPath(sourceRoot, file)
  if (!statSync(path).isFile() || statSync(path).size > 256 * 1024 * 1024) throw new Error('原生元信息库超过读取上限')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec(`PRAGMA busy_timeout=${NATIVE_BUSY_MS}; PRAGMA query_only=ON;`)
    return read(db, table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name))))
  } finally { db.close() }
}
export function projectRows(db: DatabaseSync, root: string, source: TaskConversationSource, columns: NativeColumns, requested: NativeIdentity[]): ExternalConversation[] {
  const { table, id, cwd, title, updated, predicate, discoveryPredicate, role, parentSessionId } = columns
  // All SQL identifiers originate in the adapter's schema allowlist. Values are bound.
  const slashes = `replace(${cwd},char(92),'/')`
  const normalizedCwd = process.platform === 'win32'
    ? `lower(rtrim(CASE WHEN substr(${slashes},1,4)='//?/' THEN substr(${slashes},5) ELSE ${slashes} END,'/'))` : cwd
  const key = pathKey(root)
  const requestedIds = requested.filter(item => item.source === source && safeId(item.sessionId)).slice(0, MAX_ITEMS).map(item => item.sessionId)
  const metadata = `${role ? `,${role} AS role` : ''}${parentSessionId ? `,${parentSessionId} AS parentSessionId` : ''}`
  const select = `SELECT ${id} AS sessionId,${cwd} AS cwd,substr(${title},1,4096) AS title,${updated} AS updatedAt${metadata} FROM ${table}`
  const condition = predicate ? ` AND (${predicate})` : ''
  const defaultCondition = discoveryPredicate ? ` AND (${discoveryPredicate})` : ''
  const sql = `${select} WHERE (${normalizedCwd}=? OR substr(${normalizedCwd},1,?)=?)${condition}${defaultCondition}
    ORDER BY ${updated} DESC LIMIT ?`
  const rows = db.prepare(sql).all(key, key.length + 1, `${key}/`, MAX_ITEMS + 1)
  // A saved old session must remain queryable even when the discovery page is full.
  if (requestedIds.length) rows.push(...db.prepare(`${select} WHERE ${id} IN (${requestedIds.map(() => '?').join(',')})${condition} LIMIT ?`).all(...requestedIds, MAX_ITEMS))
  const seen = new Set<string>()
  return rows.flatMap(raw => {
    const parsed = rowSchema.safeParse(raw)
    if (!parsed.success || !nativeSessionId(source, parsed.data.sessionId)) return []
    const data = parsed.data
    const canonical = projectCwd(root, data.cwd)
    if (!canonical) return []
    const item: ExternalConversation = { ...conversation(source, data.sessionId, canonical, data.title, data.updatedAt),
      ...(data.role ? { role: data.role } : {}),
      ...(data.parentSessionId && nativeSessionId('codex', data.parentSessionId) ? { parentSessionId: data.parentSessionId } : {}) }
    if (seen.has(item.id)) return []
    seen.add(item.id)
    return [item]
  })
}
