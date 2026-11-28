import type { OrchestrationV2DomainEventJson } from './orchestrationV2'
import type { ConversationFailureClass } from './failure-taxonomy'
import type { ConversationTaskBinding } from './task-scope'

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
  | ConversationTaskBinding
  | {
    readonly kind: 'planning'
    readonly planningId: string
    readonly taskId: string
    readonly taskCreatedAt: string
    readonly assigneeGeneration: number
    readonly materialRevision: string
  }
  | {
    readonly kind: 'task'
    readonly mode?: 'execution'
    readonly taskId: string
    readonly taskCreatedAt?: string
    readonly executionId: string
    readonly nodeId: string
    readonly generation?: number
    readonly attempt?: number
    readonly assigneeGeneration: number
    readonly materialRevision: string
    readonly codeRevision: string | null
  }

export interface ConversationAuthority extends ConversationProjectScope {
  readonly ownerId: string
  readonly spaceId: string
  readonly binding: ConversationBinding
  readonly knowledgePageId?: string
}

export interface ConversationRunEvidence {
  readonly nativeTurnId?: string
  readonly nativeStartedAt?: string
  readonly engineAcceptedAt?: string
  readonly firstOutputAt?: string
  readonly outcomeUnknown?: true
  readonly outcomeUnknownAt?: string
  readonly failure?: string
  readonly failureClass?: ConversationFailureClass
  readonly retryAfterMs?: number
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

export interface ConversationSearchMatch {
  readonly threadId: string
  readonly threadTitle: string
  readonly messageId: string | null
  readonly role: 'user' | 'assistant' | 'system' | null
  readonly runOrdinal: number | null
  readonly snippet: string
  readonly matchedField: 'title' | 'body'
  readonly updatedAt: string
}

export interface ConversationAggregatedSearchMatch extends ConversationSearchMatch {
  readonly cwd: string
  readonly source: 'work' | 'code'
  readonly projectName: string
}

export interface ConversationCheckpointDiffFile {
  readonly path: string
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed'
  readonly additions: number
  readonly deletions: number
}

export interface ConversationCheckpointDiffResult {
  readonly threadId: string
  readonly runId: string
  readonly fromPhase: 'before' | 'after'
  readonly toPhase: 'before' | 'after' | 'workspace'
  readonly files: readonly ConversationCheckpointDiffFile[]
  readonly diff: string
  readonly truncated: boolean
}

export const CONVERSATION_READ_PAGE_LIMIT = 100
