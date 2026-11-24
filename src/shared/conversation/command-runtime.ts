import { z } from 'zod'
import type { ConversationEventPage, ConversationRunEvidence, ConversationWireEvent } from './desktop'
import type { OrchestrationV2AppThread, OrchestrationV2ConversationMessage, OrchestrationV2Run } from './contracts'
import { modelSelectionIdSchema } from '../model-selection'

const id = z.string().min(1).max(200)
const text = z.string().min(1).max(120_000).refine(value => value.trim().length > 0)
const base = { commandId: id, threadId: id }
const run = { ...base, runId: id }
const decision = z.enum(['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel'])
const answers = z.record(z.string().min(1).max(200), z.union([z.string().max(32_000), z.array(z.string().max(32_000)).max(64)]))
const model = modelSelectionIdSchema.refine(value => value === value.trim() && !/\p{Cc}/u.test(value), 'Invalid model ID.')
const instanceId = z.string().min(1).max(64).regex(/^[\w.-]+$/)

export const conversationThreadCommandSchema = z.discriminatedUnion('type', [
  z.object({
    ...base, type: z.literal('message.dispatch'), messageId: id, text, model, instanceId,
    deliveryIntent: z.enum(['auto', 'steer']).optional(),
  }).strict(),
  z.object({ ...base, type: z.literal('queue.resume') }).strict(),
  z.object({ ...run, type: z.literal('queued-run.edit'), text }).strict(),
  z.object({ ...run, type: z.literal('queued-run.cancel') }).strict(),
  z.object({ ...run, type: z.literal('queued-run.start') }).strict(),
  z.object({ ...run, type: z.literal('queued-run.reorder'), beforeRunId: id.nullable() }).strict(),
  z.object({ ...run, type: z.literal('run.interrupt') }).strict(),
  z.object({ ...base, type: z.literal('queued-message.promote-to-steer'), queuedRunId: id, targetRunId: id }).strict(),
  z.object({
    ...base, type: z.literal('runtime-request.respond'), requestId: id, generation: z.number().int().positive().safe(),
    decision: decision.optional(), answers: answers.optional(),
  }).strict(),
]).superRefine((input, context) => {
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
  readonly payload:
    | { readonly kind: 'approval'; readonly title: string; readonly details?: string; readonly options: readonly { readonly decision: z.infer<typeof decision>; readonly label: string }[] }
    | { readonly kind: 'user-input'; readonly title: string; readonly questions: readonly { readonly id: string; readonly prompt: string; readonly choices?: readonly { readonly value: string; readonly label: string }[] }[] }
  readonly createdAt: string
  readonly expiresAt?: string
  readonly status: 'pending' | 'responding' | 'resolved' | 'expired' | 'pending-reconciliation'
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

export interface ConversationThreadSnapshot {
  readonly thread: OrchestrationV2AppThread
  readonly runs: ReadonlyArray<OrchestrationV2Run & ConversationRunEvidence & { readonly lifecycle?: ConversationRunLifecycle }>
  readonly messages: readonly OrchestrationV2ConversationMessage[]
  readonly cursor: ConversationThreadEventCursor
  readonly asOfSequence: number
  readonly historyCursor: ConversationThreadHistoryCursor | null
  readonly queuePaused: boolean
  readonly runtimeRequests: readonly ConversationRuntimeRequest[]
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
  readonly historyCursor: ConversationThreadHistoryCursor | null
}

type LifecyclePayload =
  | { readonly kind: 'queue'; readonly paused: boolean }
  | { readonly kind: 'dispatch'; readonly status: 'preparing' | 'dispatching' | 'unknown' }
  | { readonly kind: 'run'; readonly phase: 'foreground-ended' | 'background-running' | 'settled' | 'stop-requested' | 'stop-unconfirmed' }
  | { readonly kind: 'terminal-evidence'; readonly evidence: ConversationNativeTerminalEvidence }
  | { readonly kind: 'request'; readonly request: ConversationRuntimeRequest }

export interface ConversationLifecycleEvent {
  readonly id: string
  readonly threadId: string
  readonly runId?: string
  readonly occurredAt: string
  readonly type: 'crux.lifecycle'
  readonly payload: LifecyclePayload
}
