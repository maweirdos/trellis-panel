import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import * as Schema from 'effect/Schema'
import { DaemonError } from '../../../daemon/errors'
import type { ConversationThreadCommand, ConversationThreadCommandState } from '../../../../shared/conversation/command-runtime'
import { OrchestrationV2DomainEventJson } from '../../../../shared/conversation/contracts'
import type { ConversationAuthority } from '../../../../shared/conversation/desktop'
import type { ConversationSearchIndex } from '../persistence/SearchIndex'
import type { ConversationEventSink } from './EventSink'
import type { ThreadCommands } from './ThreadCommands'

const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)

const FILLER_PREFIX_RE = /^(?:请帮我|麻烦帮我|请帮忙|帮我|帮忙|请问|我想|能不能|能否|可以|请|Help me\s+|Please\s+|Can you\s+|Could you\s+)/i

function cleanTitleCandidate(raw: string): string {
  let text = raw
    .replace(/^\/artifacts\b[^\n\r]*/im, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[#>*\-\d.)\s]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  while (FILLER_PREFIX_RE.test(text)) {
    const next = text.replace(FILLER_PREFIX_RE, '').trim()
    if (!next || next === text) break
    text = next
  }
  const firstClause = text.split(/[。！？?!\n\r]/u).map(part => part.trim()).find(Boolean) ?? text
  return firstClause.replace(/[，,、；;：:]+$/u, '').trim()
}

export function deriveSmartThreadTitle(userText: string, assistantText?: string): string {
  const userCandidate = cleanTitleCandidate(userText)
  let chosen = userCandidate
  if (chosen.length <= 4 && assistantText?.trim()) {
    const assistantCandidate = cleanTitleCandidate(assistantText)
    if (assistantCandidate.length > chosen.length) {
      chosen = assistantCandidate
    }
  }
  if (!chosen) return '新对话'
  return chosen.length <= 36 ? chosen : `${chosen.slice(0, 35).trimEnd()}…`
}

/**
 * 异步无感标题提炼与按需重生成服务：
 * 1) 首轮个人对话完成结算后，若仍为占位标题且未被手动重命名，自动提炼简洁语义标题；
 * 2) 严格尊重手动重命名（`title_source = 'manual'` / `titleRenamed = true`），永不覆盖用户标题；
 * 3) 支持 `thread.title.regenerate` 命令显式重新生成并同步 FTS5 索引。
 */
export class ThreadTitleService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly eventSink: ConversationEventSink,
    private readonly commands: ThreadCommands,
    private readonly searchIndex: ConversationSearchIndex,
  ) {}

  maybeAutoRefineAfterFirstTurn(threadId: string): boolean {
    const threadRow = this.database.prepare(`
      SELECT title, title_source, payload_json
      FROM conversation_v2_projection_threads
      WHERE thread_id = ? AND deleted_at IS NULL AND archived_at IS NULL
    `).get(threadId) as { title: string; title_source: string; payload_json: string } | undefined
    if (!threadRow || threadRow.title_source !== 'placeholder') return false

    const payload = JSON.parse(threadRow.payload_json) as Record<string, unknown>
    if (payload.titleRenamed === true) return false

    const completedCount = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM conversation_v2_projection_runs
      WHERE thread_id = ? AND status = 'completed'
    `).get(threadId) as { count: number }).count
    if (completedCount !== 1) return false

    const firstRun = this.database.prepare(`
      SELECT run_id FROM conversation_v2_projection_runs
      WHERE thread_id = ? AND status = 'completed'
      ORDER BY ordinal ASC LIMIT 1
    `).get(threadId) as { run_id: string } | undefined
    if (!firstRun) return false

    const messages = this.database.prepare(`
      SELECT role, CAST(json_extract(payload_json, '$.text') AS TEXT) AS text
      FROM conversation_v2_projection_messages
      WHERE thread_id = ? AND run_id = ? AND streaming = 0 AND role IN ('user', 'assistant')
      ORDER BY created_at ASC, message_id ASC
    `).all(threadId, firstRun.run_id) as Array<{ role: string; text: string | null }>

    const userText = messages.find(item => item.role === 'user')?.text ?? ''
    const assistantText = messages.find(item => item.role === 'assistant')?.text ?? ''
    if (!userText.trim() && !assistantText.trim()) return false

    const nextTitle = deriveSmartThreadTitle(userText, assistantText)
    const nowIso = new Date().toISOString()
    const nextPayload: Record<string, unknown> = {
      ...payload,
      title: nextTitle,
      titleRenamed: false,
      updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : nowIso,
    }
    const event = decodeEvent({
      id: randomUUID(),
      threadId,
      occurredAt: nowIso,
      type: 'thread.metadata-updated',
      payload: nextPayload,
    })

    this.eventSink.commit({ events: [event] }, () => {
      this.database.prepare(`
        UPDATE conversation_v2_projection_threads
        SET title = ?, title_source = 'auto', payload_json = ?
        WHERE thread_id = ?
      `).run(nextTitle, JSON.stringify(nextPayload), threadId)
      this.searchIndex.updateThreadTitle(threadId, nextTitle)
    })
    return true
  }

  regenerateTitle(
    command: Extract<ConversationThreadCommand, { type: 'thread.title.regenerate' }>,
    authority: ConversationAuthority,
  ): ConversationThreadCommandState {
    const threadRow = this.database.prepare(`
      SELECT title, archived_at, payload_json
      FROM conversation_v2_projection_threads
      WHERE thread_id = ? AND deleted_at IS NULL
    `).get(command.threadId) as { title: string; archived_at: string | null; payload_json: string } | undefined
    if (!threadRow) throw new DaemonError('E_CONFLICT', '原会话已删除。')
    if (threadRow.archived_at !== null) throw new DaemonError('E_CONFLICT', '请先恢复已归档的会话。')

    const firstUser = this.database.prepare(`
      SELECT CAST(json_extract(payload_json, '$.text') AS TEXT) AS text
      FROM conversation_v2_projection_messages
      WHERE thread_id = ? AND role = 'user' AND streaming = 0
      ORDER BY created_at ASC, message_id ASC LIMIT 1
    `).get(command.threadId) as { text: string | null } | undefined

    const latestAssistant = this.database.prepare(`
      SELECT CAST(json_extract(payload_json, '$.text') AS TEXT) AS text
      FROM conversation_v2_projection_messages
      WHERE thread_id = ? AND role = 'assistant' AND streaming = 0
      ORDER BY created_at DESC, message_id DESC LIMIT 1
    `).get(command.threadId) as { text: string | null } | undefined

    const nextTitle = deriveSmartThreadTitle(firstUser?.text ?? threadRow.title, latestAssistant?.text ?? undefined)
    const nowIso = new Date().toISOString()
    const payload = JSON.parse(threadRow.payload_json) as Record<string, unknown>
    const nextPayload: Record<string, unknown> = {
      ...payload,
      title: nextTitle,
      titleRenamed: false,
      updatedAt: nowIso,
    }
    const event = decodeEvent({
      id: randomUUID(),
      threadId: command.threadId,
      occurredAt: nowIso,
      type: 'thread.metadata-updated',
      payload: nextPayload,
    })

    return this.commands.commit(command, authority, {
      target: { detail: nextTitle },
      events: [event],
      apply: () => {
        this.database.prepare(`
          UPDATE conversation_v2_projection_threads
          SET title = ?, title_source = 'auto', updated_at = ?, payload_json = ?
          WHERE thread_id = ?
        `).run(nextTitle, nowIso, JSON.stringify(nextPayload), command.threadId)
        this.searchIndex.updateThreadTitle(command.threadId, nextTitle)
      },
    })
  }
}
