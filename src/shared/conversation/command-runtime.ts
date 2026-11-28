import { z } from 'zod'
import type { ConversationEventPage, ConversationRunEvidence, ConversationWireEvent } from './desktop'
import type { OrchestrationV2AppThread, OrchestrationV2ConversationMessage, OrchestrationV2Run } from './contracts'
import { conversationAttachmentReferenceFields } from './attachments'
import type { ChatAttachment } from './chatAttachment'
import type { ProviderRequestKind, RuntimeMode, ProviderInteractionMode } from './providerPolicy'
import { modelSelectionIdSchema } from '../model-selection'
import {
  conversationForkSourceSchema, conversationHistoryReferencesSchema,
  type ConversationThreadRelation, type ConversationThreadRelations,
} from './thread-relations'

const id = z.string().min(1).max(200)
const text = z.string().max(120_000)
const base = { commandId: id, threadId: id }
const run = { ...base, runId: id }
const decision = z.enum(['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel'])
const answers = z.record(z.string().min(1).max(200), z.union([z.string().max(32_000), z.array(z.string().max(32_000)).max(64)]))
const model = modelSelectionIdSchema.refine(value => value === value.trim() && !/\p{Cc}/u.test(value), 'Invalid model ID.')
const instanceId = z.string().min(1).max(64).regex(/^[\w.-]+$/)
export const conversationModelOptionsSchema = z.array(z.strictObject({
  id: z.string().min(1).max(200).refine(value => value === value.trim()),
  value: z.union([z.string().min(1).max(200).refine(value => value === value.trim()), z.boolean()]),
})).min(1).max(32).refine(options => new Set(options.map(option => option.id)).size === options.length)

export const conversationThreadCommandSchema = z.discriminatedUnion('type', [
  z.object({
    ...base, ...conversationAttachmentReferenceFields, type: z.literal('message.dispatch'), messageId: id, text, model, instanceId,
    deliveryIntent: z.enum(['auto', 'steer']).optional(), options: conversationModelOptionsSchema.optional(),
    references: conversationHistoryReferencesSchema.optional(),
    manualContinuationOfRunId: id.optional(),
  }).strict(),
  z.object({ ...base, type: z.literal('queue.resume') }).strict(),
  z.object({ ...base, type: z.literal('thread.rename'), title: z.string().trim().min(1).max(500) }).strict(),
  z.object({ ...base, type: z.literal('thread.pin'), pinned: z.boolean() }).strict(),
  z.object({ ...base, type: z.literal('thread.archive'), archived: z.boolean() }).strict(),
  z.object({ ...base, type: z.literal('thread.delete'), onlyIfUnused: z.literal(true).optional() }).strict(),
  z.object({
    ...base, type: z.literal('thread.fork'), targetThreadId: id, sourcePoint: conversationForkSourceSchema,
    sideChat: z.boolean().optional(), readOnly: z.literal(true).optional(), title: z.string().trim().min(1).max(500).optional(),
    selection: z.strictObject({ instanceId, model, options: conversationModelOptionsSchema.optional() }).optional(),
  }).strict(),
  z.strictObject({ ...base, type: z.literal('thread.goal.set'), objective: z.string().trim().min(1).max(4_000) }),
  z.strictObject({ ...base, type: z.literal('thread.goal.pause') }),
  z.strictObject({ ...base, type: z.literal('thread.goal.resume') }),
  z.strictObject({ ...base, type: z.literal('thread.goal.clear') }),
  z.strictObject({ ...base, type: z.literal('thread.compact'), instructions: z.string().trim().min(1).max(4_000).optional() }),
  z.strictObject({
    ...base, type: z.literal('thread.handoff'), messageId: id, text: text.refine(value => value.trim().length > 0), instanceId, model,
    options: conversationModelOptionsSchema.optional(), references: conversationHistoryReferencesSchema.optional(),
  }),
  z.object({ ...run, ...conversationAttachmentReferenceFields, type: z.literal('queued-run.edit'), text }).strict(),
  z.object({ ...run, type: z.literal('queued-run.cancel') }).strict(),
  z.object({ ...run, type: z.literal('queued-run.start') }).strict(),
  z.object({ ...run, type: z.literal('queued-run.reorder'), beforeRunId: id.nullable() }).strict(),
  z.object({ ...run, type: z.literal('run.interrupt') }).strict(),
  z.object({ ...base, runId: id.optional(), type: z.literal('thread.stop') }).strict(),
  z.object({ ...base, childThreadId: id, force: z.boolean().optional(), type: z.literal('subagent.stop') }).strict(),
  z.object({ ...base, type: z.literal('usage-limit-recovery.cancel') }).strict(),
  z.object({ ...base, type: z.literal('usage-limit-recovery.retry-now') }).strict(),
  z.strictObject({ ...base, type: z.literal('thread.runtime-mode.set'), runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']) }),
  z.strictObject({ ...base, type: z.literal('thread.interaction-mode.set'), interactionMode: z.enum(['default', 'plan']) }),
  z.object({ ...base, type: z.literal('queued-message.promote-to-steer'), queuedRunId: id, targetRunId: id }).strict(),
  z.object({
    ...base, ...conversationAttachmentReferenceFields, type: z.literal('runtime-request.respond'), requestId: id, generation: z.number().int().positive().safe(),
    decision: decision.optional(), answers: answers.optional(), attachmentQuestionId: id.optional(),
  }).strict(),
  z.strictObject({
    ...base, type: z.literal('checkpoint.rollback'), targetRunId: id, boundary: z.enum(['before', 'after']), restoreFiles: z.boolean(),
  }),
  z.strictObject({
    ...base, type: z.literal('message.edit-and-rerun'), targetRunId: id, messageId: id,
    text: text.refine(value => value.trim().length > 0), restoreFiles: z.boolean(), instanceId, model,
    options: conversationModelOptionsSchema.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('provider.switch'),
    instanceId,
    model,
    options: conversationModelOptionsSchema.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('thread.merge_back'),
    sourceThreadId: id,
    summary: z.string().trim().min(1).max(16_000).optional(),
    messageIds: z.array(id).min(1).max(32).optional(),
  }),
  z.strictObject({ ...base, type: z.literal('thread.title.regenerate') }),
  z.strictObject({
    ...base,
    type: z.literal('thread.visit'),
    sequence: z.number().int().nonnegative().safe().optional(),
  }),
  z.strictObject({ ...base, type: z.literal('thread.mark-unread') }),
  z.strictObject({
    ...base,
    type: z.literal('thread.tag.set'),
    tags: z.array(z.string().trim().min(1).max(64).refine(value => !/\p{Cc}/u.test(value), 'Invalid thread tag.')).max(16),
  }),
  z.strictObject({
    ...base,
    type: z.literal('thread.snooze'),
    snoozedUntil: z.string().datetime().nullable(),
  }),
]).superRefine((input, context) => {
  if (input.type === 'message.dispatch' && input.manualContinuationOfRunId) {
    if (input.deliveryIntent === 'steer' || input.attachmentIds?.length || input.references?.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Manual continuation cannot steer or carry attachments/references.' })
    }
  } else if ((input.type === 'message.dispatch' || input.type === 'queued-run.edit') && !input.text.trim() && !input.attachmentIds?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide text or an attachment.' })
  }
  if ('attachmentIds' in input && input.attachmentIds?.length && (!input.draftId || (input.type === 'runtime-request.respond' && !input.answers))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Attachments require their draft and, for a runtime request, a user input answer.' })
  }
  if (input.type === 'runtime-request.respond' && input.attachmentQuestionId && !input.attachmentIds?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'An attachment question requires an attachment.' })
  }
  if (input.type === 'runtime-request.respond' && (input.decision === undefined) === (input.answers === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one decision or set of answers.' })
  }
  if (input.type === 'runtime-request.respond' && input.answers && new TextEncoder().encode(JSON.stringify(input.answers)).length > 120_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'The response exceeds the permitted size.' })
  }
})

export type ConversationThreadCommand = z.infer<typeof conversationThreadCommandSchema>
export type ConversationRuntimeRequestResponse = { readonly decision: z.infer<typeof decision> } | { readonly answers: z.infer<typeof answers> }

export interface ConversationThreadCommandState {
  readonly commandId: string
  readonly threadId: string
  readonly runId?: string
  readonly messageId?: string
  readonly requestId?: string
  readonly childThreadId?: string
  readonly acceptedAt: string
  readonly resultSequence: number
  readonly dispatch: 'accepted' | 'queued' | 'paused' | 'dispatching' | 'running' | 'completed' | 'failed' | 'cancelled' | 'pending-reconciliation'
  readonly detail?: string
}

export interface ConversationRuntimeRequest {
  readonly requestId: string
  readonly runId: string
  readonly generation: number
  readonly kind: 'approval' | 'user-input'
  readonly responseAttachments?: readonly ChatAttachment[]
  readonly responseAttachmentQuestionId?: string
  readonly payload:
    | {
        readonly kind: 'approval'
        readonly requestKind?: ProviderRequestKind
        readonly approvalScopeKey?: string
        readonly title: string
        readonly details?: string
        readonly options: readonly { readonly decision: z.infer<typeof decision>; readonly label: string }[]
      }
    | {
        readonly kind: 'user-input'
        readonly title: string
        readonly questions: readonly ConversationRuntimeQuestion[]
        readonly responseMode?: 'live' | 'message'
      }
  readonly createdAt: string
  readonly expiresAt?: string
  readonly status: 'pending' | 'responding' | 'resolved' | 'expired' | 'pending-reconciliation'
}

export interface ConversationRuntimeQuestion {
  readonly id: string
  readonly header?: string
  readonly prompt: string
  readonly choices?: readonly { readonly value: string; readonly label: string; readonly description?: string }[]
  readonly allowCustom?: boolean
  readonly acceptsTextAttachments?: true
}

export interface ConversationThreadEventCursor {
  readonly storageId: string
  readonly threadId: string
  readonly sequence: number
}

export interface ConversationThreadHistoryCursor {
  readonly storageId: string
  readonly threadId: string
  readonly beforeRunOrdinal: number
}

export interface ConversationRunLifecycle {
  readonly foregroundEnded: boolean
  readonly backgroundRunning: boolean
  readonly stopRequested: boolean
  readonly terminalEvidence?: ConversationNativeTerminalEvidence
}

export interface ConversationNativeTerminalEvidence {
  readonly status: string
  readonly observedAt: string
  readonly nativeTurnId?: string
}

export type ConversationProjectedWorkItem = Extract<
  Extract<ConversationWireEvent, { readonly type: 'turn-item.updated' }>['payload'],
  { readonly type: 'dynamic_tool' | 'command_execution' | 'file_search' | 'web_search' | 'proposed_plan' | 'todo_list' | 'file_change' | 'reasoning' | 'system_notice' }
>

export type ConversationThreadModes = {
  readonly runtimeMode: RuntimeMode
  readonly interactionMode: ProviderInteractionMode
}

export interface ConversationGoal {
  readonly source: 'application'
  readonly objective: string
  readonly status: 'active' | 'paused'
  readonly updatedAt: string
}

export interface ConversationTurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens?: number
  readonly reasoningOutputTokens?: number
  readonly contextWindow?: number
}

export interface ConversationCompaction {
  readonly trigger: 'manual' | 'idle'
  readonly instructions?: string
}

export interface ConversationHandoff {
  readonly sourceRunId: string
  readonly sourceInstanceId: string
  readonly targetInstanceId: string
  readonly sourceThreadIds: readonly string[]
  readonly includedMessages: number
  readonly omittedMessages: number
  readonly omittedAttachments: number
  readonly state: 'prepared' | 'accepted'
}

export interface ConversationUsageLimitRecovery {
  readonly threadId: string
  readonly runId: string
  readonly resumeAt: string
  readonly retryAfterMs: number
  readonly attempt: number
  readonly maxAttempts: number
  readonly status: 'scheduled' | 'cancelled' | 'triggered'
  readonly reason?: string
  readonly updatedAt: string
}

export interface ConversationCheckpointSummary {
  readonly checkpointId: string
  readonly threadId: string
  readonly runId: string
  readonly phase: 'before' | 'after'
  readonly cwd: string
  readonly gitTreeRef: string | null
  readonly headRef: string | null
  readonly dirtyFileCount: number
  readonly untrackedCount: number
  readonly status: 'captured' | 'skipped' | 'failed'
  readonly detail?: string
  readonly createdAt: string
}

export interface ConversationThreadSnapshot {
  readonly thread: OrchestrationV2AppThread
  readonly runs: ReadonlyArray<OrchestrationV2Run & ConversationRunEvidence & {
    readonly lifecycle?: ConversationRunLifecycle
    readonly usage?: ConversationTurnUsage
    readonly compaction?: ConversationCompaction
    readonly handoff?: ConversationHandoff
  }>
  readonly messages: readonly OrchestrationV2ConversationMessage[]
  readonly turnItems?: readonly ConversationProjectedWorkItem[]
  readonly cursor: ConversationThreadEventCursor
  readonly asOfSequence: number
  readonly historyCursor: ConversationThreadHistoryCursor | null
  readonly queuePaused: boolean
  readonly runtimeRequests: readonly ConversationRuntimeRequest[]
  readonly relations?: ConversationThreadRelations
  readonly goal?: ConversationGoal | null
  readonly usageLimitRecovery?: ConversationUsageLimitRecovery | null
  readonly checkpoints?: readonly ConversationCheckpointSummary[]
}

export interface ConversationLifecycleEventPage extends Omit<ConversationEventPage, 'events'> {
  readonly events: ReadonlyArray<{ readonly sequence: number; readonly event: ConversationWireEvent | ConversationLifecycleEvent }>
}

export type ConversationThreadEventPage = (ConversationLifecycleEventPage & {
  readonly kind: 'events'
  readonly cursor: ConversationThreadEventCursor
}) | {
  readonly kind: 'reset'
  readonly snapshot: ConversationThreadSnapshot
}

export interface ConversationThreadHistoryPage {
  readonly runs: ConversationThreadSnapshot['runs']
  readonly messages: ConversationThreadSnapshot['messages']
  readonly turnItems?: ConversationThreadSnapshot['turnItems']
  readonly historyCursor: ConversationThreadHistoryCursor | null
}

type LifecyclePayload =
  | { readonly kind: 'queue'; readonly paused: boolean }
  | { readonly kind: 'dispatch'; readonly status: 'preparing' | 'dispatching' | 'unknown' }
  | { readonly kind: 'run'; readonly phase: 'foreground-ended' | 'background-running' | 'settled' | 'stop-requested' | 'stop-unconfirmed' }
  | { readonly kind: 'terminal-evidence'; readonly evidence: ConversationNativeTerminalEvidence }
  | { readonly kind: 'request'; readonly request: ConversationRuntimeRequest }
  | { readonly kind: 'relation'; readonly relation: ConversationThreadRelation; readonly removed?: true }
  | { readonly kind: 'goal'; readonly goal: ConversationGoal | null }
  | { readonly kind: 'usage'; readonly usage: ConversationTurnUsage }
  | { readonly kind: 'compaction'; readonly compaction: ConversationCompaction }
  | { readonly kind: 'handoff'; readonly handoff: ConversationHandoff }
  | { readonly kind: 'usage-limit-recovery'; readonly recovery: ConversationUsageLimitRecovery | null }
  | { readonly kind: 'checkpoint'; readonly checkpoint: ConversationCheckpointSummary }
  | { readonly kind: 'thread-reset'; readonly reason: 'rollback' | 'edit-and-rerun' }

export interface ConversationLifecycleEvent {
  readonly id: string
  readonly threadId: string
  readonly runId?: string
  readonly occurredAt: string
  readonly type: 'crux.lifecycle'
  readonly payload: LifecyclePayload
}
