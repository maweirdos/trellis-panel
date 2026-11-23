import type { SetStateAction } from 'react'

export interface OptimisticUserMessage {
  readonly id: string
  readonly role: 'user'
  readonly text: string
  readonly createdAt: string
}

export interface OptimisticUserMessages {
  readonly threadId: string
  readonly messages: OptimisticUserMessage[]
}

export function emptyOptimisticUserMessages(threadId: string): OptimisticUserMessages {
  return { threadId, messages: [] }
}

export function reconcileOptimisticUserMessages(
  state: OptimisticUserMessages,
  threadId: string,
  acknowledgedIds: ReadonlySet<string>,
): OptimisticUserMessages {
  if (state.threadId !== threadId) return emptyOptimisticUserMessages(threadId)
  if (!state.messages.some((message) => acknowledgedIds.has(message.id))) return state
  const messages: OptimisticUserMessage[] = []
  for (const message of state.messages) {
    if (!acknowledgedIds.has(message.id)) messages.push(message)
  }
  return { ...state, messages }
}

export function applyOptimisticUserMessagesAction(
  state: OptimisticUserMessages,
  threadId: string,
  action: SetStateAction<OptimisticUserMessage[]>,
): OptimisticUserMessages {
  if (state.threadId !== threadId) return state
  const next = typeof action === 'function' ? action(state.messages) : action
  const unchanged =
    next.length === state.messages.length &&
    next.every((message, index) => message === state.messages[index])
  return unchanged ? state : { ...state, messages: next }
}
