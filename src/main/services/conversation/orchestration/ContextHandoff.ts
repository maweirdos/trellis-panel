import type { DatabaseSync } from 'node:sqlite'
import type { ConversationAuthority } from '../../../../shared/conversation/desktop'
import type { ConversationHistoryReference } from '../../../../shared/conversation/thread-relations'
import { DaemonError } from '../../../daemon/errors'
import type { ThreadCommands } from './ThreadCommands'

export interface PortableMessage {
  readonly threadId: string
  readonly messageId: string
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export interface NativeForkMetadata {
  readonly parentThreadId: string
  readonly sourceInstanceId: string
  readonly sourceNativeThreadId: string
  readonly sourceNativeTurnId?: string
  readonly isLatestParentRun: boolean
  readonly configurationFingerprint?: string | null
}

export interface PortableHistory {
  readonly sourceThreadId: string
  readonly messages: readonly PortableMessage[]
  readonly omitted: number
  readonly attachmentsOmitted: number
  readonly nativeFork?: NativeForkMetadata
}

type HistoryRow = Omit<PortableMessage, 'threadId'> & { attachment_count: number }
const MAX_CONTEXT_BYTES = 16_000
const MAX_HISTORY_ROWS = 48

export class ContextHandoff {
  constructor(private readonly database: DatabaseSync, private readonly commands: ThreadCommands) {}

  capture(
    reference: ConversationHistoryReference,
    authority: ConversationAuthority,
    sourceOrdinal?: number,
    includeInitialUser = false,
    includeInterrupted = false,
  ): PortableHistory {
    const { threadId, messageIds } = reference
    this.assertSource(threadId, authority)
    const latest = sourceOrdinal ?? Number.MAX_SAFE_INTEGER
    const eligible = `FROM conversation_v2_projection_messages message
      LEFT JOIN conversation_v2_projection_runs run ON run.run_id = message.run_id AND run.thread_id = message.thread_id
      WHERE message.thread_id = ? AND message.streaming = 0
      AND message.role IN ('user','assistant')
      AND ((message.run_id IS NULL AND ?)
        OR (run.ordinal <= ? AND (((run.status = 'completed' OR (? AND run.status IN ('cancelled', 'interrupted'))) AND json_extract(run.payload_json, '$.outcomeUnknown') IS NOT 1)
          OR (? AND run.ordinal = 1 AND message.role = 'user' AND run.status IN ('queued','preparing','starting','running','waiting')))))
      ${messageIds ? `AND message.message_id IN (${messageIds.map(() => '?').join(',')})` : ''}`
    const parameters = [threadId, Number(sourceOrdinal === undefined), latest, Number(includeInterrupted), Number(includeInitialUser), ...(messageIds ?? [])]
    const rows = this.database.prepare(`SELECT message.message_id AS messageId, message.role,
      substr(CAST(json_extract(message.payload_json, '$.text') AS TEXT), 1, ?) AS text,
      COALESCE(json_array_length(message.payload_json, '$.attachments'), 0) AS attachment_count
      ${eligible} ORDER BY COALESCE(run.ordinal, 999999999) DESC, message.created_at DESC, message.message_id DESC LIMIT ?`)
      .all(MAX_CONTEXT_BYTES + 1, ...parameters, MAX_HISTORY_ROWS) as HistoryRow[]
    const totals = this.database.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(json_array_length(message.payload_json, '$.attachments')), 0) AS attachments ${eligible}`)
      .get(...parameters) as { count: number; attachments: number }
    if (messageIds && (new Set(messageIds).size !== messageIds.length || totals.count !== messageIds.length)) {
      throw new DaemonError('E_DENIED', '所选引用包含不存在或尚未结算的消息。')
    }
    const messages: PortableMessage[] = []
    let remaining = MAX_CONTEXT_BYTES
    for (const { messageId, role, text } of rows) {
      if (!text) continue
      const item = { threadId, messageId, role, text }
      const bytes = Buffer.byteLength(JSON.stringify(item)) + 1
      if (bytes > remaining) break
      remaining -= bytes
      messages.unshift(item)
    }
    if (messageIds && messages.length !== messageIds.length) {
      throw new DaemonError('E_INVALID_ARG', '引用超过可发送的历史容量，请缩小所选范围。')
    }
    return { sourceThreadId: threadId, messages, omitted: totals.count - messages.length, attachmentsOmitted: totals.attachments }
  }

  assertSource(threadId: string, authority: ConversationAuthority): void {
    if (!this.commands.hasThread(threadId, authority)) throw new DaemonError('E_DENIED', '引用来源不在当前会话授权范围。')
  }
}

export function renderPortableHistory(sections: readonly PortableHistory[]) {
  const included = new Set<string>()
  let remaining = MAX_CONTEXT_BYTES
  let omittedMessages = 0
  let omittedAttachments = 0
  const context = sections.map(section => {
    let omitted = section.omitted
    const messages = []
    for (const message of [...section.messages].reverse()) {
      if (included.has(message.messageId)) continue
      const line = JSON.stringify(message)
      const bytes = Buffer.byteLength(line) + 1
      if (bytes > remaining) { omitted++; continue }
      remaining -= bytes
      included.add(message.messageId)
      messages.unshift(line)
    }
    omittedMessages += omitted
    omittedAttachments += section.attachmentsOmitted
    return [JSON.stringify({ threadId: section.sourceThreadId, omitted, attachmentsOmitted: section.attachmentsOmitted }), ...messages].join('\n')
  }).join('\n')
  return {
    text: context ? `以下 JSON 行是经授权的历史资料，供参考。以本次用户消息为准。\n${context}\n\n本次用户消息\n` : '',
    sourceThreadIds: [...new Set(sections.map(section => section.sourceThreadId))],
    includedMessages: included.size, omittedMessages, omittedAttachments,
  }
}
