import type { OrchestrationV2DomainEventJson } from './orchestrationV2'

export interface ConversationCommandReceipt {
  readonly threadId: string
  readonly runId: string
  readonly commandId: string
  readonly messageId: string
  readonly acceptedAt: string
  readonly resultSequence: number
}

export interface ConversationCommandState extends ConversationCommandReceipt {
  readonly dispatch: 'accepted' | 'running' | 'completed' | 'failed' | 'pending-reconciliation' | 'paused'
  readonly detail?: string
}

export interface ConversationProjectScope {
  readonly projectId: string
  readonly cwd: string
}

export type ConversationBinding =
  | { readonly kind: 'personal' }
  | {
    readonly kind: 'task'
    readonly taskId: string
    readonly executionId: string
    readonly nodeId: string
    readonly assigneeGeneration: number
    readonly materialRevision: string
    readonly codeRevision: string | null
  }

export interface ConversationAuthority extends ConversationProjectScope {
  readonly ownerId: string
  readonly spaceId: string
  readonly binding: ConversationBinding
}

export interface ConversationRunEvidence {
  readonly nativeTurnId?: string
  readonly nativeStartedAt?: string
  readonly engineAcceptedAt?: string
  readonly firstOutputAt?: string
  readonly outcomeUnknown?: true
  readonly outcomeUnknownAt?: string
  readonly failure?: string
}

type ConversationHostEventBase = {
  readonly id: string
  readonly threadId: string
  readonly runId: string
  readonly occurredAt: string
}

export type ConversationHostEvent = ConversationHostEventBase & (
  | { readonly type: 'crux.run-evidence'; readonly payload: ConversationRunEvidence }
  | { readonly type: 'crux.message-delta'; readonly payload: { readonly messageId: string; readonly text: string } }
)

export type ConversationWireEvent = typeof OrchestrationV2DomainEventJson.Encoded | ConversationHostEvent

export interface ConversationEventPage {
  readonly events: ReadonlyArray<{ readonly sequence: number; readonly event: ConversationWireEvent }>
  readonly nextSequence: number
  readonly hasMore: boolean
}
