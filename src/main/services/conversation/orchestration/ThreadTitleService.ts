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
const AI_TITLE_TIMEOUT_MS = 6_000
const MAX_FORK_ANCESTOR_DEPTH = 3

export interface ThreadTitleGeneratorInput {
  readonly threadId: string
  readonly userText: string
  readonly assistantText?: string
  readonly inheritedTitle?: string
  readonly signal: AbortSignal
}

export type ThreadTitleGenerator = (input: ThreadTitleGeneratorInput) => Promise<string | null | undefined>

function cleanTitleCandidate(raw: string): string {
  let text = raw
    .replace(/^\/artifacts\b[^\n\r]*/im, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[#>*\-\d.)\s"「『“']+/, '')
    .replace(/["」』”']+$/, '')
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

export function deriveSmartThreadTitle(userText: string, assistantText?: string, inheritedTitle?: string): string {
  const userCandidate = cleanTitleCandidate(userText)
  let chosen = userCandidate
  if (chosen.length <= 4 && assistantText?.trim()) {
    const assistantCandidate = cleanTitleCandidate(assistantText)
    if (assistantCandidate.length > chosen.length) {
      chosen = assistantCandidate
    }
  }
  if (chosen.length <= 2 && inheritedTitle?.trim()) {
    chosen = cleanTitleCandidate(inheritedTitle)
  }
  if (!chosen) return '新对话'
  return chosen.length <= 36 ? chosen : `${chosen.slice(0, 35).trimEnd()}…`
}

function sanitizeGeneratedTitle(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = cleanTitleCandidate(raw)
  if (!cleaned || cleaned.length < 2) return null
  return cleaned.length <= 36 ? cleaned : `${cleaned.slice(0, 35).trimEnd()}…`
}

/**
 * 异步无感标题提炼与按需重生成服务（对齐 t3code ThreadTitleRegenerationService）：
 * 1) 首轮个人对话完成结算后，若仍为占位标题且未被手动重命名，自动提炼简洁语义标题；
 * 2) 若宿主注入了轻量 AI 标题生成器（`generateTitle`），异步请求并带超时保护，失败平滑回退规则提炼；
 * 3) 对派生分支（`forkedFrom`）在自身消息不足时向上回溯最多 3 层父线程上下文；
 * 4) 严格尊重手动重命名（`title_source = 'manual'` / `titleRenamed = true`），落盘前二次复核防竞态覆盖。
 */
export class ThreadTitleService {
  private readonly inFlightRefinements = new Map<string, AbortController>()

  constructor(
    private readonly database: DatabaseSync,
    private readonly eventSink: ConversationEventSink,
    private readonly commands: ThreadCommands,
    private readonly searchIndex: ConversationSearchIndex,
    private readonly generateTitle?: ThreadTitleGenerator,
  ) {}

  shutdown(): void {
    for (const controller of this.inFlightRefinements.values()) {
      controller.abort()
    }
    this.inFlightRefinements.clear()
  }

  private collectForkContext(payload: Record<string, unknown>, threadId: string): {
    readonly inheritedTitle?: string
    readonly inheritedUserText?: string
    readonly inheritedAssistantText?: string
  } {
    const seen = new Set<string>([threadId])
    let currentPayload = payload
    for (let depth = 0; depth < MAX_FORK_ANCESTOR_DEPTH; depth += 1) {
      const forkedFrom = currentPayload.forkedFrom as { threadId?: string } | null | undefined
      const parentId = typeof forkedFrom?.threadId === 'string' ? forkedFrom.threadId : null
      if (!parentId || seen.has(parentId)) break
      seen.add(parentId)
      const parentRow = this.database.prepare(`
        SELECT title, payload_json
        FROM conversation_v2_projection_threads
        WHERE thread_id = ? AND deleted_at IS NULL
      `).get(parentId) as { title: string; payload_json: string } | undefined
      if (!parentRow) break
      const parentMsgs = this.database.prepare(`
        SELECT role, CAST(json_extract(payload_json, '$.text') AS TEXT) AS text
        FROM conversation_v2_projection_messages
        WHERE thread_id = ? AND streaming = 0 AND role IN ('user', 'assistant')
        ORDER BY created_at ASC, message_id ASC LIMIT 4
      `).all(parentId) as Array<{ role: string; text: string | null }>
      const userMsg = parentMsgs.find(m => m.role === 'user')?.text ?? ''
      const assistantMsg = parentMsgs.find(m => m.role === 'assistant')?.text ?? ''
      if (userMsg.trim() || assistantMsg.trim() || parentRow.title.trim()) {
        return {
          inheritedTitle: parentRow.title.trim() || undefined,
          inheritedUserText: userMsg.trim() || undefined,
          inheritedAssistantText: assistantMsg.trim() || undefined,
        }
      }
      currentPayload = JSON.parse(parentRow.payload_json) as Record<string, unknown>
    }
    return {}
  }

  private commitRefinedTitle(threadId: string, nextTitle: string, requirePlaceholder: boolean): boolean {
    const threadRow = this.database.prepare(`
      SELECT title, title_source, payload_json
      FROM conversation_v2_projection_threads
      WHERE thread_id = ? AND deleted_at IS NULL AND archived_at IS NULL
    `).get(threadId) as { title: string; title_source: string; payload_json: string } | undefined
    if (!threadRow) return false
    const payload = JSON.parse(threadRow.payload_json) as Record<string, unknown>
    if (requirePlaceholder && (threadRow.title_source !== 'placeholder' || payload.titleRenamed === true)) {
      return false
    }
    if (!requirePlaceholder && threadRow.title_source === 'manual' && payload.titleRenamed === true) {
      return false
    }

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

    const forkCtx = this.collectForkContext(payload, threadId)
    const userText = (messages.find(item => item.role === 'user')?.text ?? '').trim() || forkCtx.inheritedUserText || ''
    const assistantText = (messages.find(item => item.role === 'assistant')?.text ?? '').trim() || forkCtx.inheritedAssistantText || ''
    if (!userText && !assistantText && !forkCtx.inheritedTitle) return false

    const fallbackTitle = deriveSmartThreadTitle(userText, assistantText, forkCtx.inheritedTitle)
    if (!this.generateTitle) {
      return this.commitRefinedTitle(threadId, fallbackTitle, true)
    }

    // 异步轻量 AI 生成，不阻塞回合完成；若用户在此期间手动重命名则放弃写入。
    this.inFlightRefinements.get(threadId)?.abort()
    const controller = new AbortController()
    this.inFlightRefinements.set(threadId, controller)
    const timer = setTimeout(() => controller.abort(), AI_TITLE_TIMEOUT_MS)
    void Promise.resolve()
      .then(() => this.generateTitle!({
        threadId,
        userText: userText.slice(0, 1200),
        ...(assistantText ? { assistantText: assistantText.slice(0, 1200) } : {}),
        ...(forkCtx.inheritedTitle ? { inheritedTitle: forkCtx.inheritedTitle } : {}),
        signal: controller.signal,
      }))
      .then(generated => {
        if (controller.signal.aborted) return
        const resolved = sanitizeGeneratedTitle(generated) ?? fallbackTitle
        this.commitRefinedTitle(threadId, resolved, true)
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          this.commitRefinedTitle(threadId, fallbackTitle, true)
        }
      })
      .finally(() => {
        clearTimeout(timer)
        if (this.inFlightRefinements.get(threadId) === controller) {
          this.inFlightRefinements.delete(threadId)
        }
      })
    return true
  }

  async regenerateTitle(
    command: Extract<ConversationThreadCommand, { type: 'thread.title.regenerate' }>,
    authority: ConversationAuthority,
  ): Promise<ConversationThreadCommandState> {
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

    const payload = JSON.parse(threadRow.payload_json) as Record<string, unknown>
    const forkCtx = this.collectForkContext(payload, command.threadId)
    const userText = (firstUser?.text ?? '').trim() || forkCtx.inheritedUserText || threadRow.title
    const assistantText = (latestAssistant?.text ?? '').trim() || forkCtx.inheritedAssistantText || undefined
    let nextTitle = deriveSmartThreadTitle(userText, assistantText, forkCtx.inheritedTitle)

    if (this.generateTitle) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), AI_TITLE_TIMEOUT_MS)
      try {
        const aiTitle = await this.generateTitle({
          threadId: command.threadId,
          userText: userText.slice(0, 1200),
          ...(assistantText ? { assistantText: assistantText.slice(0, 1200) } : {}),
          ...(forkCtx.inheritedTitle ? { inheritedTitle: forkCtx.inheritedTitle } : {}),
          signal: controller.signal,
        })
        const sanitized = sanitizeGeneratedTitle(aiTitle)
        if (sanitized) nextTitle = sanitized
      } catch {
        // AI 标题生成失败时无感回退本地提炼
      } finally {
        clearTimeout(timer)
      }
    }

    const nowIso = new Date().toISOString()
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
