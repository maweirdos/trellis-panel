import { join } from 'node:path'
import { boundedEntries } from './paths'
import { projectRows, readNativeDatabase } from './native-sqlite'
import type { ExternalConversation } from '../../../../shared/task-conversations'
import type { NativeIdentity } from '../types'

export function isCodexSubagent(conversation: Pick<ExternalConversation, 'source' | 'role'>): boolean {
  return conversation.source === 'codex' && conversation.role === 'subagent'
}
export function readCodex(sourceRoot: string, root: string, requested: NativeIdentity[]): ExternalConversation[] {
  const { names } = boundedEntries(sourceRoot)
  const file = names.filter(name => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0]
  if (!file) throw new Error('未找到 Codex 本机元信息索引')
  return readNativeDatabase(sourceRoot, join(sourceRoot, file), (db, columns) => {
    const fields = columns('threads')
    if (!['id', 'cwd', 'title'].every(name => fields.has(name)) || (!fields.has('updated_at_ms') && !fields.has('updated_at'))) {
      throw new Error('Codex 元信息索引 schema 不受支持')
    }
    const threadSource = fields.has('thread_source') ? "lower(trim(coalesce(thread_source,'')))" : "''"
    // Keep malformed/absent/older source metadata unknown; never inspect titles or user-event flags.
    const parent = fields.has('source') ? `CASE WHEN typeof(source)='text' AND length(source)<=16384 AND json_valid(source)
      THEN CASE WHEN json_type(source,'$.subagent.thread_spawn.parent_thread_id')='text'
        THEN json_extract(source,'$.subagent.thread_spawn.parent_thread_id') ELSE NULL END ELSE NULL END` : 'NULL'
    const explicitChild = `(${threadSource}='subagent' OR (typeof(${parent})='text' AND length(${parent})>0))`
    return projectRows(db, root, 'codex', {
      table: 'threads', id: 'id', cwd: 'cwd',
      title: fields.has('name') ? "coalesce(nullif(name,''),title)" : 'title',
      updated: fields.has('updated_at_ms') ? (fields.has('updated_at') ? 'coalesce(updated_at_ms,updated_at*1000)' : 'updated_at_ms') : 'updated_at*1000',
      role: `CASE WHEN ${explicitChild} THEN 'subagent' WHEN ${threadSource}='user' THEN 'user' ELSE 'unknown' END`,
      parentSessionId: `CASE WHEN typeof(${parent})='text' AND length(${parent})<=256 THEN ${parent} ELSE NULL END`,
      // Requested-ID reads intentionally omit this condition to preserve explicit old child bindings.
      discoveryPredicate: `NOT ${explicitChild}`
    }, requested)
  })
}
