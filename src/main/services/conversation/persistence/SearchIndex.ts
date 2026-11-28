import type { DatabaseSync } from 'node:sqlite'
import type { ConversationSearchMatch } from '../../../../shared/conversation/desktop'

function normalizeIndexText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function buildFtsMatchQuery(rawQuery: string): string | null {
  const tokens = rawQuery
    .trim()
    .split(/\s+/)
    .map(token => token.replace(/["*^():]/g, '').trim())
    .filter(token => token.length > 0 && !/^(AND|OR|NOT|NEAR)$/i.test(token))
  if (!tokens.length) return null
  return tokens.map(token => `"${token.replace(/"/g, '""')}"*`).join(' AND ')
}

function createExcerpt(source: string, query: string, maxLength = 96): string {
  const clean = normalizeIndexText(source)
  if (!clean) return ''
  const lower = clean.toLowerCase()
  const idx = lower.indexOf(query.toLowerCase())
  if (idx === -1) {
    return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1)}…`
  }
  const lead = Math.max(0, idx - 24)
  const tail = Math.min(clean.length, idx + query.length + (maxLength - 24 - query.length))
  const prefix = lead > 0 ? '…' : ''
  const suffix = tail < clean.length ? '…' : ''
  return `${prefix}${clean.slice(lead, tail)}${suffix}`
}

/**
 * 会话全文检索索引（基于 SQLite FTS5，并对 CJK 连续中文子串自动互补匹配）。
 * 严格遵循 owner_id / space_id / project_id 与 deleted_at / archived_at 隔离过滤。
 */
export class ConversationSearchIndex {
  private readonly ftsAvailable: boolean

  constructor(private readonly database: DatabaseSync) {
    this.ftsAvailable = Boolean(
      this.database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_v2_message_fts'",
      ).get(),
    )
  }

  isFtsAvailable(): boolean {
    return this.ftsAvailable
  }

  ensureBackfilled(): void {
    if (!this.ftsAvailable) return
    const existing = this.database.prepare('SELECT 1 FROM conversation_v2_message_fts LIMIT 1').get()
    if (existing) return
    try {
      this.database.exec(`
        INSERT INTO conversation_v2_message_fts (thread_id, message_id, role, title, body)
        SELECT m.thread_id, m.message_id, m.role, t.title, COALESCE(CAST(json_extract(m.payload_json, '$.text') AS TEXT), '')
        FROM conversation_v2_projection_messages m
        JOIN conversation_v2_projection_threads t ON t.thread_id = m.thread_id
        WHERE t.deleted_at IS NULL AND m.streaming = 0 AND m.role IN ('user', 'assistant', 'system')
      `)
    } catch {
      // 忽略首次回填时的非致命索引异常
    }
  }

  upsertMessage(input: {
    readonly threadId: string
    readonly messageId: string
    readonly role: string
    readonly title: string
    readonly body: string
  }): void {
    if (!this.ftsAvailable) return
    try {
      this.database.prepare('DELETE FROM conversation_v2_message_fts WHERE message_id = ?').run(input.messageId)
      this.database.prepare(
        'INSERT INTO conversation_v2_message_fts (thread_id, message_id, role, title, body) VALUES (?, ?, ?, ?, ?)',
      ).run(input.threadId, input.messageId, input.role, normalizeIndexText(input.title), normalizeIndexText(input.body))
    } catch {
      // 索引写入失败不得阻断核心主链路消息持久化
    }
  }

  updateThreadTitle(threadId: string, title: string): void {
    if (!this.ftsAvailable) return
    try {
      const normalized = normalizeIndexText(title)
      const count = (this.database.prepare('SELECT COUNT(*) AS count FROM conversation_v2_message_fts WHERE thread_id = ?')
        .get(threadId) as { count: number }).count
      if (count > 0) {
        this.database.prepare('UPDATE conversation_v2_message_fts SET title = ? WHERE thread_id = ?').run(normalized, threadId)
      } else {
        this.database.prepare(
          "INSERT INTO conversation_v2_message_fts (thread_id, message_id, role, title, body) VALUES (?, ?, 'system', ?, '')",
        ).run(threadId, `title:${threadId}`, normalized)
      }
    } catch {
      // 忽略索引标题同步异常
    }
  }

  removeMessages(messageIds: readonly string[]): void {
    if (!this.ftsAvailable || !messageIds.length) return
    try {
      const placeholders = messageIds.map(() => '?').join(',')
      this.database.prepare(`DELETE FROM conversation_v2_message_fts WHERE message_id IN (${placeholders})`).run(...messageIds)
    } catch {
      // 忽略清理异常
    }
  }

  removeThread(threadId: string): void {
    if (!this.ftsAvailable) return
    try {
      this.database.prepare('DELETE FROM conversation_v2_message_fts WHERE thread_id = ?').run(threadId)
    } catch {
      // 忽略清理异常
    }
  }

  search(input: {
    readonly ownerId: string
    readonly spaceId: string
    readonly projectId: string
    readonly query: string
    readonly archived?: boolean
    readonly limit?: number
  }): readonly ConversationSearchMatch[] {
    const query = input.query.trim()
    if (!query) return []
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 50)
    const archivedFlag = Number(input.archived ?? false)
    const byThread = new Map<string, ConversationSearchMatch>()

    const recordMatch = (candidate: ConversationSearchMatch): void => {
      const existing = byThread.get(candidate.threadId)
      if (!existing) {
        byThread.set(candidate.threadId, candidate)
        return
      }
      if (existing.matchedField === 'title' && candidate.matchedField === 'body') {
        byThread.set(candidate.threadId, candidate)
      }
    }

    if (this.ftsAvailable) {
      const ftsQuery = buildFtsMatchQuery(query)
      if (ftsQuery) {
        try {
          const ftsRows = this.database.prepare(`
            SELECT f.thread_id, t.title AS thread_title, f.message_id, f.role, r.ordinal AS run_ordinal,
              f.body, t.updated_at
            FROM conversation_v2_message_fts f
            JOIN conversation_v2_projection_threads t ON t.thread_id = f.thread_id
            LEFT JOIN conversation_v2_projection_messages m ON m.message_id = f.message_id
            LEFT JOIN conversation_v2_projection_runs r ON r.run_id = m.run_id
            WHERE conversation_v2_message_fts MATCH ?
              AND t.owner_id = ? AND t.space_id = ? AND t.project_id = ?
              AND t.deleted_at IS NULL AND (t.archived_at IS NOT NULL) = ?
            ORDER BY bm25(conversation_v2_message_fts), t.updated_at DESC
            LIMIT ?
          `).all(ftsQuery, input.ownerId, input.spaceId, input.projectId, archivedFlag, limit * 3) as Array<{
            thread_id: string
            thread_title: string
            message_id: string
            role: 'user' | 'assistant' | 'system'
            run_ordinal: number | null
            body: string
            updated_at: string
          }>
          for (const row of ftsRows) {
            const bodyHasQuery = row.body.toLowerCase().includes(query.toLowerCase()) || Boolean(row.body.trim())
            const isTitlePlaceholder = row.message_id.startsWith('title:')
            const matchedField: 'title' | 'body' = !isTitlePlaceholder && bodyHasQuery ? 'body' : 'title'
            recordMatch({
              threadId: row.thread_id,
              threadTitle: row.thread_title,
              messageId: isTitlePlaceholder ? null : row.message_id,
              role: isTitlePlaceholder ? null : row.role,
              runOrdinal: row.run_ordinal,
              snippet: matchedField === 'body' ? createExcerpt(row.body, query) : createExcerpt(row.thread_title, query),
              matchedField,
              updatedAt: row.updated_at,
            })
          }
        } catch {
          // FTS 查询语法容错，继续交由下方 CJK/子串路径兜底
        }
      }
    }

    // 对 CJK 中文连续短语及未满配额结果补充精确子串扫描（SQLite unicode61 不会按字分词）
    if (byThread.size < limit) {
      const bodyRows = this.database.prepare(`
        SELECT m.thread_id, t.title AS thread_title, m.message_id, m.role, r.ordinal AS run_ordinal,
          CAST(json_extract(m.payload_json, '$.text') AS TEXT) AS body, t.updated_at
        FROM conversation_v2_projection_messages m
        JOIN conversation_v2_projection_threads t ON t.thread_id = m.thread_id
        LEFT JOIN conversation_v2_projection_runs r ON r.run_id = m.run_id
        WHERE t.owner_id = ? AND t.space_id = ? AND t.project_id = ?
          AND t.deleted_at IS NULL AND (t.archived_at IS NOT NULL) = ?
          AND m.streaming = 0 AND m.role IN ('user', 'assistant', 'system')
          AND instr(lower(CAST(json_extract(m.payload_json, '$.text') AS TEXT)), lower(?)) > 0
        ORDER BY t.updated_at DESC, m.created_at DESC
        LIMIT ?
      `).all(input.ownerId, input.spaceId, input.projectId, archivedFlag, query, limit * 2) as Array<{
        thread_id: string
        thread_title: string
        message_id: string
        role: 'user' | 'assistant' | 'system'
        run_ordinal: number | null
        body: string
        updated_at: string
      }>
      for (const row of bodyRows) {
        recordMatch({
          threadId: row.thread_id,
          threadTitle: row.thread_title,
          messageId: row.message_id,
          role: row.role,
          runOrdinal: row.run_ordinal,
          snippet: createExcerpt(row.body, query),
          matchedField: 'body',
          updatedAt: row.updated_at,
        })
      }
    }

    if (byThread.size < limit) {
      const titleRows = this.database.prepare(`
        SELECT thread_id, title, updated_at
        FROM conversation_v2_projection_threads
        WHERE owner_id = ? AND space_id = ? AND project_id = ?
          AND deleted_at IS NULL AND (archived_at IS NOT NULL) = ?
          AND instr(lower(title), lower(?)) > 0
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(input.ownerId, input.spaceId, input.projectId, archivedFlag, query, limit) as Array<{
        thread_id: string
        title: string
        updated_at: string
      }>
      for (const row of titleRows) {
        recordMatch({
          threadId: row.thread_id,
          threadTitle: row.title,
          messageId: null,
          role: null,
          runOrdinal: null,
          snippet: createExcerpt(row.title, query),
          matchedField: 'title',
          updatedAt: row.updated_at,
        })
      }
    }

    return [...byThread.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
  }
}
