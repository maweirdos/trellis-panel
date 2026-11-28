import type { DatabaseSync } from 'node:sqlite'
import type { ConversationSearchMatch } from '../../../../shared/conversation/desktop'
import type { ConversationSearchIndex } from '../persistence/SearchIndex'

export interface ThreadInlineMatch {
  readonly messageId: string
  readonly role: string
  readonly snippet: string
  readonly matchCount: number
}

function countOccurrences(haystack: string, needle: string): number {
  const source = haystack.toLowerCase()
  const target = needle.toLowerCase()
  if (!target) return 0
  let count = 0
  let offset = 0
  while (true) {
    const idx = source.indexOf(target, offset)
    if (idx === -1) break
    count += 1
    offset = idx + target.length
  }
  return count
}

/**
 * 会话内容搜索服务：
 * 提供跨会话全文检索（委托给 FTS5/CJK ConversationSearchIndex）与单个会话内消息匹配定位。
 */
export class ThreadSearchService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly searchIndex: ConversationSearchIndex,
  ) {}

  searchThreads(
    ownerId: string,
    spaceId: string,
    projectId: string,
    filter: { readonly query: string; readonly archived?: boolean; readonly limit?: number },
  ): readonly ConversationSearchMatch[] {
    return this.searchIndex.search({
      ownerId,
      spaceId,
      projectId,
      query: filter.query,
      archived: filter.archived,
      limit: filter.limit,
    })
  }

  findInThread(threadId: string, rawQuery: string): readonly ThreadInlineMatch[] {
    const query = rawQuery.trim()
    if (!query) return []
    const rows = this.database.prepare(`
      SELECT message_id, role, CAST(json_extract(payload_json, '$.text') AS TEXT) AS text
      FROM conversation_v2_projection_messages
      WHERE thread_id = ? AND streaming = 0 AND role IN ('user', 'assistant', 'system')
        AND instr(lower(CAST(json_extract(payload_json, '$.text') AS TEXT)), lower(?)) > 0
      ORDER BY created_at ASC, message_id ASC
      LIMIT 200
    `).all(threadId, query) as Array<{ message_id: string; role: string; text: string | null }>

    return rows.flatMap(row => {
      const text = (row.text ?? '').trim()
      if (!text) return []
      const matchCount = countOccurrences(text, query)
      if (!matchCount) return []
      const compact = text.replace(/\s+/g, ' ')
      const idx = compact.toLowerCase().indexOf(query.toLowerCase())
      const lead = Math.max(0, idx - 24)
      const tail = Math.min(compact.length, idx + query.length + 48)
      const snippet = `${lead > 0 ? '…' : ''}${compact.slice(lead, tail)}${tail < compact.length ? '…' : ''}`
      return [{ messageId: row.message_id, role: row.role, snippet, matchCount }]
    })
  }
}
