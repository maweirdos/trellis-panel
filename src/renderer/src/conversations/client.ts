import type { ConversationApi, ConversationResult } from '@shared/private-conversations'
import { api, hasIpc } from '../api'

export function conversationClient(): ConversationApi | null {
  return hasIpc && api.conversations ? api.conversations : null
}

export function conversationValue<T>(result: ConversationResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

export function conversationError(cause: unknown): string {
  return cause instanceof Error ? cause.message : '操作未确认，请重试。'
}
