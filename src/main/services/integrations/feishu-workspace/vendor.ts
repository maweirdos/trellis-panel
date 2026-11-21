import { createHash } from 'node:crypto'
import { z } from 'zod'
import { getSettings } from '../../store'
import { IntegrationError } from '../types'
import { authorizeDevice, registerApplication, type FeishuRegistrationInput } from './vendor-auth'
import {
  assertCredentials, assertNotAborted, FeishuHttp, openIdSchema, parseResponse,
  tokenSchema, type FeishuAuthorizationInput, type FeishuCredentials
} from './vendor-http'
import { chatIdSchema, historyPage, historyQuery, messageIdSchema, selectHistory, type FeishuHistoryMessage, type FeishuMessage } from './vendor-messages'
import { listenForMessages, type FeishuProxy, type FeishuStreamCallbacks } from './vendor-stream'

export type { FeishuCredentials } from './vendor-http'
export type { FeishuHistoryMessage, FeishuMessage } from './vendor-messages'

const MESSAGES_PATH = '/open-apis/im/v1/messages'
const CHATS_PATH = '/open-apis/im/v1/chats'
const CHAT_PAGE_SIZE = 50
const tokenResponse = z.object({ tenant_access_token: tokenSchema, expire: z.number().int().positive().max(86_400) })
const botResponse = z.object({ bot: z.object({ open_id: openIdSchema, app_name: z.string().trim().min(1).max(120).optional() }) })
const replyResponse = z.object({ data: z.object({ message_id: messageIdSchema }) })
const chatsResponse = z.object({ data: z.object({
  items: z.array(z.object({
    chat_id: chatIdSchema, name: z.string().max(256).optional(),
    chat_mode: z.string().max(32).optional(), chat_status: z.string().max(32).optional()
  })).max(CHAT_PAGE_SIZE).default([]),
  has_more: z.boolean().default(false), page_token: z.string().max(2048).optional()
}) })

export function createFeishuVendor(options: { http?: FeishuHttp; proxy?: FeishuProxy } = {}) {
  const http = options.http ?? new FeishuHttp()
  const proxy = options.proxy ?? (() => getSettings().proxy)
  const tokens = new Map<string, { token: string; expiresAt: number }>()
  const cacheKey = (credentials: FeishuCredentials) => createHash('sha256').update(`${credentials.appId}:${credentials.appSecret}`).digest('hex')

  async function tenantToken(credentials: FeishuCredentials, signal?: AbortSignal, recheck = false): Promise<string> {
    assertCredentials(credentials)
    assertNotAborted(signal)
    const key = cacheKey(credentials)
    const cached = tokens.get(key)
    if (!recheck && cached && cached.expiresAt > Date.now() + 60_000) return cached.token
    tokens.delete(key)
    const response = await http.api('/open-apis/auth/v3/tenant_access_token/internal', {
      payload: { app_id: credentials.appId, app_secret: credentials.appSecret }, signal
    })
    assertNotAborted(signal)
    const result = parseResponse(tokenResponse, response)
    if (tokens.size >= 100) {
      const oldest = tokens.keys().next().value
      if (oldest !== undefined) tokens.delete(oldest)
    }
    tokens.set(key, { token: result.tenant_access_token, expiresAt: Date.now() + result.expire * 1000 })
    return result.tenant_access_token
  }

  return {
    register(input: FeishuRegistrationInput): Promise<FeishuCredentials> {
      return registerApplication(http, input)
    },
    authorizeAccount(credentials: FeishuCredentials, input: FeishuAuthorizationInput) {
      return authorizeDevice(http, credentials, input)
    },
    async verify(credentials: FeishuCredentials, signal?: AbortSignal): Promise<{ name: string; botOpenId: string }> {
      const token = await tenantToken(credentials, signal, true)
      const { bot } = parseResponse(botResponse, await http.api('/open-apis/bot/v3/info', { token, signal }))
      return { name: bot.app_name ?? '飞书机器人', botOpenId: bot.open_id }
    },
    async listen(credentials: FeishuCredentials, callbacks: FeishuStreamCallbacks): Promise<{ close(): void }> {
      const listener = await listenForMessages(http, credentials, callbacks, proxy)
      return {
        close() {
          tokens.delete(cacheKey(credentials))
          listener.close()
        }
      }
    },
    async listChats(credentials: FeishuCredentials, signal?: AbortSignal): Promise<Array<{ id: string; name: string }>> {
      const token = await tenantToken(credentials, signal)
      const params = new URLSearchParams({ page_size: String(CHAT_PAGE_SIZE), sort_type: 'ByCreateTimeAsc' })
      const readPage = async () => parseResponse(chatsResponse, await http.api(`${CHATS_PATH}?${params}`, { token, signal })).data
      const first = await readPage()
      const rooms = new Map<string, { id: string; name: string }>()
      const add = (items: typeof first.items) => {
        for (const item of items) {
          if (item.chat_mode === 'p2p' || (item.chat_status && item.chat_status !== 'normal')) continue
          rooms.set(item.chat_id, { id: item.chat_id, name: item.name?.trim() || item.chat_id })
        }
      }
      add(first.items)
      if (first.has_more) {
        if (!first.page_token) throw new IntegrationError('飞书群列表缺少分页位置', 'upstream')
        params.set('page_token', first.page_token)
        add((await readPage()).items)
      }
      return [...rooms.values()]
    },
    async history(credentials: FeishuCredentials, message: FeishuMessage, signal?: AbortSignal): Promise<FeishuHistoryMessage[]> {
      if (!message.isGroup) return []
      const token = await tenantToken(credentials, signal)
      const readItems = async (path: string) => parseResponse(historyPage, await http.api(path, { token, signal })).data.items
      const [recent, quoted] = await Promise.allSettled([
        readItems(`${MESSAGES_PATH}?${historyQuery(message)}`),
        message.parentId && messageIdSchema.safeParse(message.parentId).success
          ? readItems(`${MESSAGES_PATH}/${message.parentId}`)
          : Promise.resolve([])
      ])
      assertNotAborted(signal)
      if (recent.status === 'rejected' && (quoted.status === 'rejected' || !quoted.value.length)) throw recent.reason
      return selectHistory(message, recent.status === 'fulfilled' ? recent.value : [], quoted.status === 'fulfilled' ? quoted.value : [])
    },
    async reply(credentials: FeishuCredentials, messageId: string, text: string, uuid: string, signal?: AbortSignal): Promise<void> {
      if (!messageIdSchema.safeParse(messageId).success || !z.uuid().safeParse(uuid).success || !text.trim() || text.length > 4000) {
        throw new IntegrationError('飞书回复参数无效', 'invalid')
      }
      const token = await tenantToken(credentials, signal)
      const result = await http.api(`${MESSAGES_PATH}/${messageId}/reply`, {
        token, signal, mutates: true, payload: { msg_type: 'text', content: JSON.stringify({ text }), uuid }
      })
      if (!replyResponse.safeParse(result).success) throw new IntegrationError('飞书回复结果无法确认', 'uncertain')
    }
  }
}
