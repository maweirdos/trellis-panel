import { z } from 'zod'
import type { OrchestrationV2DelegatedCompletionTaskDelivery } from './contracts'

const id = z.string().min(1).max(200)

export const conversationForkSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('latest_stable') }),
  z.strictObject({ type: z.literal('run'), runId: id }),
])

export const conversationHistoryReferenceSchema = z.strictObject({
  threadId: id,
  messageIds: z.array(id).min(1).max(16).optional(),
})

export const conversationHistoryReferencesSchema = z.array(conversationHistoryReferenceSchema).min(1).max(8)
export type ConversationHistoryReference = z.infer<typeof conversationHistoryReferenceSchema>

export interface ConversationDelegationCall {
  readonly nativeThreadId: string
  readonly nativeTurnId: string
  readonly callId: string
  readonly tool: 'delegate_task' | 'task_status' | 'task_cancel' | 'task_respond'
  readonly arguments: unknown
}

export interface ConversationDelegationReply {
  readonly success: boolean
  readonly text: string
}

export interface ConversationNativeSubagentEvent {
  readonly type: 'native-subagent'
  readonly turnId: string
  readonly turnIdSource?: 'native' | 'host'
  readonly activityId: string
  readonly title: string
  readonly status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
}

export interface ConversationThreadRelation {
  readonly id: string
  readonly kind: 'fork' | 'side-chat' | 'delegated' | 'native-activity'
  readonly parentThreadId: string
  readonly rootThreadId: string
  readonly parentRunId?: string
  readonly parentNodeId?: string
  readonly childThreadId?: string
  readonly childRunId?: string
  readonly activityId?: string
  readonly title: string
  readonly instanceId: string
  readonly model: string
  readonly access?: 'read-only'
  readonly status: 'idle' | 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'pending-reconciliation'
  readonly question?: { readonly requestId: string; readonly generation: number; readonly title: string }
  readonly completionWake?: 'always' | 'settled_only'
  readonly completionDelivery?: OrchestrationV2DelegatedCompletionTaskDelivery
  readonly result?: { readonly deliveryId: string; readonly state: 'available' | 'delivered' | 'read-only'; readonly text?: string }
  readonly continuation?: { readonly commandId: string; readonly runId: string }
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ConversationThreadRelations {
  readonly parent: ConversationThreadRelation | null
  readonly children: readonly ConversationThreadRelation[]
}
