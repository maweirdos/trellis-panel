import { z } from 'zod'
import { openIdSchema, tenantKeySchema } from './vendor-http'

const MAX_CONTEXT_MESSAGES = 30
const MAX_CONTEXT_CHARS = 16_000
const RECENT_HISTORY_MS = 30 * 60 * 1000
export const messageIdSchema = z.string().regex(/^om_[\w-]{1,120}$/)
export const chatIdSchema = z.string().regex(/^oc_[\w-]{1,120}$/)
const threadIdSchema = z.string().regex(/^omt_[\w-]{1,120}$/)
const unionIdSchema = z.string().regex(/^on_[\w-]{1,120}$/)
const timeSchema = z.string().regex(/^\d{1,15}$/).transform(Number)
const maybeMessageId = z.union([messageIdSchema, z.literal('')]).optional()
const maybeThreadId = z.union([threadIdSchema, z.literal('')]).optional()
const bodySchema = z.object({ text: z.string().max(64 * 1024) })
const mentionSchema = z.object({ id: z.object({ open_id: openIdSchema }) })

const inbound = z.object({
  app_id: z.string(),
  tenant_key: tenantKeySchema,
  sender: z.object({
    sender_type: z.literal('user'),
    tenant_key: tenantKeySchema.optional(),
    sender_id: z.object({ open_id: openIdSchema, union_id: z.union([unionIdSchema, z.literal('')]).optional() })
  }),
  message: z.object({
    message_type: z.literal('text'),
    chat_type: z.enum(['group', 'p2p']),
    chat_id: chatIdSchema,
    message_id: messageIdSchema,
    create_time: timeSchema,
    root_id: maybeMessageId,
    parent_id: maybeMessageId,
    thread_id: maybeThreadId,
    content: z.string().max(64 * 1024),
    mentions: z.array(z.unknown()).max(100).default([])
  })
})

export interface FeishuMessage {
  tenantKey: string
  chatId: string
  messageId: string
  senderOpenId: string
  senderUnionId?: string
  text: string
  at: number
  threadId?: string
  parentId?: string
  rootId?: string
  isGroup: boolean
  mentionedOpenIds: string[]
}

export interface FeishuHistoryMessage { messageId: string; text: string; at: number; senderOpenId?: string }

function textContent(content: string): string | undefined {
  try {
    const parsed = bodySchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data.text.trim().slice(0, MAX_CONTEXT_CHARS) : undefined
  } catch { return undefined }
}

export function normalizeFeishuMessage(raw: unknown, appId: string): FeishuMessage | undefined {
  const result = inbound.safeParse(raw)
  if (!result.success) return undefined
  const { app_id, tenant_key, sender, message } = result.data
  if (app_id !== appId || (sender.tenant_key && sender.tenant_key !== tenant_key)) return undefined
  const text = textContent(message.content)
  if (!text) return undefined
  const mentionIds = new Set<string>()
  for (const rawMention of message.mentions) {
    const mention = mentionSchema.safeParse(rawMention)
    if (mention.success) mentionIds.add(mention.data.id.open_id)
  }
  return {
    tenantKey: tenant_key, chatId: message.chat_id, messageId: message.message_id,
    senderOpenId: sender.sender_id.open_id, senderUnionId: sender.sender_id.union_id || undefined,
    text, at: message.create_time, threadId: message.thread_id || undefined,
    rootId: message.root_id || undefined, parentId: message.parent_id || undefined,
    isGroup: message.chat_type === 'group',
    mentionedOpenIds: [...mentionIds]
  }
}

const remoteMessage = z.object({
  message_id: messageIdSchema, chat_id: chatIdSchema, thread_id: maybeThreadId, create_time: timeSchema,
  msg_type: z.literal('text'), deleted: z.boolean().optional(),
  sender: z.object({
    sender_type: z.literal('user'), tenant_key: tenantKeySchema.optional(),
    id: z.string().max(128).optional(), id_type: z.string().max(64).optional()
  }),
  body: z.object({ content: z.string().max(64 * 1024) })
})

export const historyPage = z.object({ data: z.object({ items: z.array(z.unknown()).max(MAX_CONTEXT_MESSAGES).default([]) }) })

export function historyQuery(message: FeishuMessage): URLSearchParams {
  const pageSize = MAX_CONTEXT_MESSAGES - (message.parentId ? 2 : 1)
  const params = new URLSearchParams({ sort_type: 'ByCreateTimeDesc', page_size: String(pageSize) })
  if (message.threadId) {
    params.set('container_id_type', 'thread')
    params.set('container_id', message.threadId)
  } else {
    params.set('container_id_type', 'chat')
    params.set('container_id', message.chatId)
    params.set('start_time', String(Math.max(0, Math.floor((message.at - RECENT_HISTORY_MS) / 1000))))
    params.set('end_time', String(Math.floor(message.at / 1000) + 1))
  }
  return params
}

function historyMessage(raw: unknown, trigger: FeishuMessage, isQuote: boolean): FeishuHistoryMessage | undefined {
  const parsed = remoteMessage.safeParse(raw)
  if (!parsed.success) return undefined
  const item = parsed.data
  if (item.message_id === trigger.messageId || item.chat_id !== trigger.chatId || item.deleted ||
    (item.sender.tenant_key && item.sender.tenant_key !== trigger.tenantKey) || item.create_time > trigger.at) return undefined

  if (isQuote && item.message_id !== trigger.parentId) return undefined
  if (trigger.threadId) {
    if (item.thread_id && item.thread_id !== trigger.threadId) return undefined
    if (isQuote && !item.thread_id && item.message_id !== trigger.rootId) return undefined
  } else if (item.thread_id || (!isQuote && item.create_time < trigger.at - RECENT_HISTORY_MS)) {
    return undefined
  }
  const text = textContent(item.body.content)
  const sender = !item.sender.id_type || item.sender.id_type === 'open_id' ? openIdSchema.safeParse(item.sender.id) : undefined
  return text ? { messageId: item.message_id, at: item.create_time, text, senderOpenId: sender?.data } : undefined
}

export function selectHistory(message: FeishuMessage, items: unknown[], referenced: unknown[]): FeishuHistoryMessage[] {
  const quote = referenced.map(item => historyMessage(item, message, true)).find(item => item !== undefined)
  const recent = items.flatMap(item => historyMessage(item, message, false) ?? [])
    .sort((left, right) => right.at - left.at || left.messageId.localeCompare(right.messageId))
  let chars = Math.max(0, MAX_CONTEXT_CHARS - message.text.length)
  const selected = new Map<string, FeishuHistoryMessage>()
  for (const item of quote ? [quote, ...recent] : recent) {
    if (chars === 0 || selected.size === MAX_CONTEXT_MESSAGES - 1) break
    if (selected.has(item.messageId)) continue
    const text = item.text.slice(0, chars)
    selected.set(item.messageId, { ...item, text })
    chars -= text.length
  }
  return [...selected.values()].sort((left, right) => left.at - right.at || left.messageId.localeCompare(right.messageId))
}
