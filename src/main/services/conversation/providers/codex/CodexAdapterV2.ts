import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import type { OrchestrationV2ProviderTurn } from '../../../../../shared/conversation/contracts'
import type { ConversationAttachmentContent } from '../../../../../shared/conversation/attachments'
import type { ConversationNativeSubagentEvent } from '../../../../../shared/conversation/thread-relations'
import { nativeImageAttachment, nativeTextAttachment } from '../core/attachment-input'
import type { ConversationDriverTurnEvent, ConversationDriverWorkItem } from '../registry'
import type { CodexAppServerClient } from './app-server/client'
import type {
  V2ItemCompletedNotification__ThreadItem, V2ItemStartedNotification__ThreadItem,
  V2TurnCompletedNotification__ThreadItem, V2TurnCompletedNotification__TurnStatus,
  V2TurnPlanUpdatedNotification, V2TurnStartParams,
} from './app-server/schema'

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
  input: {
    nativeThreadId: string; cwd: string; model: string; text: string; effort?: string;
    attachments?: readonly ConversationAttachmentContent[]; managedExecution?: boolean
  },
): V2TurnStartParams => ({
  threadId: input.nativeThreadId,
  input: [{ type: 'text', text: input.text, text_elements: [] }, ...(input.attachments ?? []).map(content => {
    if (content.attachment.type !== 'image') return { type: 'text' as const, text: nativeTextAttachment(content), text_elements: [] }
    const image = nativeImageAttachment(content)
    return { type: 'image' as const, url: `data:${image.mimeType};base64,${image.data}` }
  })],
  cwd: input.cwd,
  model: input.model,
  ...(input.effort === undefined ? {} : { effort: input.effort }),
  approvalPolicy: 'never',
  sandboxPolicy: input.managedExecution ? codexWorkspaceWritePolicy(input.cwd) : { type: 'readOnly', networkAccess: false },
})

export const codexWorkspaceWritePolicy = (cwd: string) => ({
  type: 'workspaceWrite' as const,
  writableRoots: [cwd],
  excludeSlashTmp: true,
  excludeTmpdirEnvVar: true,
  networkAccess: false,
})

type CodexThreadItem = V2ItemStartedNotification__ThreadItem | V2ItemCompletedNotification__ThreadItem
  | V2TurnCompletedNotification__ThreadItem

function clipText(text: string, maximum: number): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maximum).trimEnd()
}

function toolLabel(name: string, fallback: string): string {
  const trimmed = name.trim()
  return /^[a-z][\w.-]{0,79}$/i.test(trimmed) ? trimmed : fallback
}

function workStatus(status: 'inProgress' | 'completed' | 'failed' | 'declined'): 'running' | 'completed' | 'failed' | 'cancelled' {
  if (status === 'inProgress') return 'running'
  if (status === 'declined') return 'cancelled'
  return status
}

function mapCodexWorkItem(item: CodexThreadItem, complete: boolean): ConversationDriverWorkItem | undefined {
  const nativeItemId = item.id
  if (!nativeItemId || nativeItemId.length > 512) return undefined
  switch (item.type) {
    case 'commandExecution':
      return { kind: 'tool', nativeItemId, label: '运行命令', status: workStatus(item.status) }
    case 'fileChange':
      return { kind: 'tool', nativeItemId, label: '修改文件', status: workStatus(item.status) }
    case 'mcpToolCall':
      return { kind: 'tool', nativeItemId, label: toolLabel(item.tool, 'MCP 工具'), status: workStatus(item.status) }
    case 'dynamicToolCall':
      return { kind: 'tool', nativeItemId, label: toolLabel(item.tool, '调用工具'), status: workStatus(item.status) }
    case 'webSearch':
      return { kind: 'tool', nativeItemId, label: '搜索网页', status: complete ? 'completed' : 'running' }
    case 'imageView':
      return { kind: 'tool', nativeItemId, label: '查看图片', status: complete ? 'completed' : 'running' }
    case 'plan': {
      const markdown = complete && clipText(item.text, 8_000)
      return markdown ? { kind: 'proposed-plan', nativeItemId, markdown } : undefined
    }
    default:
      return undefined
  }
}

function mapCodexPlan(payload: V2TurnPlanUpdatedNotification): ConversationDriverWorkItem {
  const explanation = payload.explanation ? clipText(payload.explanation, 1_000) : undefined
  return {
    kind: 'plan-steps',
    steps: payload.plan.slice(0, 24).map((step, index) => ({
      text: clipText(step.step, 240) || `步骤 ${index + 1}`,
      status: step.status === 'inProgress' ? 'running' : step.status,
    })),
    ...(explanation && { explanation }),
  }
}

function codexNativeActivities(item: CodexThreadItem, turnId: string): readonly ConversationNativeSubagentEvent[] {
  const title = 'Codex 子代理'
  if (item.type === 'subAgentActivity') return [{
    type: 'native-subagent', turnId, activityId: item.agentThreadId || item.id, title,
    status: item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'cancelled' : 'running',
  }]
  if (item.type !== 'collabAgentToolCall') return []
  const receivers = Array.from(new Set(item.receiverThreadIds)).slice(0, 32)
  if (!receivers.length) return [{
    type: 'native-subagent', turnId, activityId: item.id, title,
    status: item.status === 'inProgress' ? 'running' : item.status === 'interrupted' ? 'cancelled' : item.status,
  }]
  return receivers.map(activityId => {
    const native = Object.hasOwn(item.agentsStates, activityId) ? item.agentsStates[activityId]?.status : undefined
    const status = native === 'completed' ? 'completed'
      : native === 'interrupted' || native === 'shutdown' ? 'cancelled'
        : native === 'notFound' || native === 'errored' || (!native && item.status === 'failed') ? 'failed'
          : native === 'pendingInit' ? 'waiting' : 'running'
    return { type: 'native-subagent', turnId, activityId, title, status }
  })
}

export const observeCodexTurns = Effect.fn('CodexAdapterV2.observeTurns')(function* (
  client: CodexAppServerClient['Service'],
  emit: (threadId: string, event: ConversationDriverTurnEvent) => void,
  identifyCompaction: (threadId: string, turnId: string) => void,
) {
  const emitWorkItem = (threadId: string, turnId: string, nativeItem: CodexThreadItem, complete: boolean): void => {
    if (nativeItem.type === 'contextCompaction') identifyCompaction(threadId, turnId)
    for (const event of codexNativeActivities(nativeItem, turnId)) emit(threadId, event)
    const item = mapCodexWorkItem(nativeItem, complete)
    if (item) emit(threadId, { type: 'work-item', turnId, item })
  }
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
  yield* client.handleServerNotification('item/started', payload => Effect.sync(() =>
    emitWorkItem(payload.threadId, payload.turnId, payload.item, false),
  ))
  yield* client.handleServerNotification('turn/plan/updated', payload => Effect.sync(() =>
    emit(payload.threadId, { type: 'work-item', turnId: payload.turnId, item: mapCodexPlan(payload) }),
  ))
  yield* client.handleServerNotification('thread/tokenUsage/updated', ({ threadId, turnId, tokenUsage }) => Effect.sync(() => {
    const { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens } = tokenUsage.last
    const contextWindow = tokenUsage.modelContextWindow
    if (![inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) return
    emit(threadId, { type: 'usage', turnId, usage: {
      inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens,
      ...(contextWindow != null && Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    } })
  }))
  yield* client.handleServerNotification('item/completed', payload => Effect.sync(() => {
    if (payload.item.type === 'agentMessage') {
      emit(payload.threadId, { type: 'text-final', text: payload.item.text, itemId: payload.item.id, turnId: payload.turnId })
    } else emitWorkItem(payload.threadId, payload.turnId, payload.item, true)
  }))
  yield* client.handleServerNotification('turn/completed', payload => Effect.sync(() => {
    for (const item of payload.turn.items) {
      if (item.type === 'agentMessage') {
        emit(payload.threadId, { type: 'text-final', text: item.text, itemId: item.id, turnId: payload.turn.id })
      } else emitWorkItem(payload.threadId, payload.turn.id, item, true)
    }
    emit(payload.threadId, {
      type: 'turn-completed', turnId: payload.turn.id,
      status: mapCodexTurnStatus(payload.turn.status), error: payload.turn.error?.message,
    })
  }))
})
