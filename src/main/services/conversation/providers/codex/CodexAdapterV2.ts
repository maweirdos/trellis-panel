import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import type { OrchestrationV2ProviderTurn } from '../../../../../shared/conversation/contracts'
import type { ConversationDriverTurnEvent } from '../registry'
import type { CodexAppServerClient } from './app-server/client'
import type { V2TurnCompletedNotification__TurnStatus, V2TurnStartParams } from './app-server/schema'

export function codexTimestamp(seconds: number): DateTime.Utc {
  return DateTime.makeUnsafe(seconds * 1000)
}

export function mapCodexTurnStatus(
  status: V2TurnCompletedNotification__TurnStatus,
): OrchestrationV2ProviderTurn['status'] {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'interrupted':
      return 'interrupted'
    case 'failed':
      return 'failed'
    case 'inProgress':
      return 'running'
  }
}

export const buildCodexTurnStartParams = (
  input: { nativeThreadId: string; cwd: string; model: string; text: string },
): V2TurnStartParams => ({
  threadId: input.nativeThreadId,
  input: [{ type: 'text', text: input.text, text_elements: [] }],
  cwd: input.cwd,
  model: input.model,
  approvalPolicy: 'never',
  sandboxPolicy: { type: 'readOnly', networkAccess: false },
})

export const observeCodexTurns = Effect.fn('CodexAdapterV2.observeTurns')(function* (
  client: CodexAppServerClient['Service'],
  emit: (threadId: string, event: ConversationDriverTurnEvent) => void,
) {
  yield* client.handleServerNotification('turn/started', payload => Effect.sync(() => {
    const startedAt = payload.turn.startedAt
    emit(payload.threadId, {
      type: 'turn-accepted', turnId: payload.turn.id,
      ...(typeof startedAt === 'number' ? { nativeStartedAt: DateTime.formatIso(codexTimestamp(startedAt)) } : {}),
    })
  }))
  yield* client.handleServerNotification('item/agentMessage/delta', payload => Effect.sync(() =>
    emit(payload.threadId, { type: 'text-delta', text: payload.delta, itemId: payload.itemId, turnId: payload.turnId }),
  ))
  yield* client.handleServerNotification('item/completed', payload => Effect.sync(() => {
    if (payload.item.type === 'agentMessage') {
      emit(payload.threadId, { type: 'text-final', text: payload.item.text, itemId: payload.item.id, turnId: payload.turnId })
    }
  }))
  yield* client.handleServerNotification('turn/completed', payload => Effect.sync(() => {
    for (const item of payload.turn.items) {
      if (item.type === 'agentMessage') {
        emit(payload.threadId, { type: 'text-final', text: item.text, itemId: item.id, turnId: payload.turn.id })
      }
    }
    emit(payload.threadId, {
      type: 'turn-completed', turnId: payload.turn.id,
      status: mapCodexTurnStatus(payload.turn.status), error: payload.turn.error?.message,
    })
  }))
})
