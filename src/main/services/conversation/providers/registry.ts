import * as Effect from 'effect/Effect'
import { ProviderDriverKind, ProviderInstanceId } from '../../../../shared/conversation/providerInstance'
import type { ProviderApprovalDecision, ProviderUserInputAnswers } from '../../../../shared/conversation/providerPolicy'
import type { ProviderOptionSelections } from '../../../../shared/conversation/model'
import type { ConversationAttachmentContent } from '../../../../shared/conversation/attachments'
import type { ChatAttachment } from '../../../../shared/conversation/chatAttachment'
import type { ConversationRuntimeQuestion } from '../../../../shared/conversation/command-runtime'
import type { ConversationDelegationCall, ConversationDelegationReply, ConversationNativeSubagentEvent } from '../../../../shared/conversation/thread-relations'
import { DaemonError } from '../../../daemon/errors'
import type { ConversationDriverDescriptor, ConversationDriverModel } from '../../../../shared/conversation/driverCatalog'
import type { ProviderAdapterV2, ProviderAdapterV2Event } from './core/ProviderAdapter'
import { RASTER_ATTACHMENTS, type ConversationPromptAttachmentSupport } from './core/attachment-input'
import { codexConfigurationKey } from './codex/driver'
import { reconcileCodexProcessClosed } from './codex/process-owner'
import { claudeConfigurationKey } from './claude/ClaudeAdapterV2'
import { openCodeConfigurationKey } from './opencode/OpenCode2Server'
import { listRegisteredAcpDrivers } from './acp/driver'

export type { ConversationDriverDescriptor, ConversationDriverModel } from '../../../../shared/conversation/driverCatalog'

type AdapterIdentity = Pick<ProviderAdapterV2['Service'], 'instanceId' | 'driver'>
type ProviderTurnStatus = Extract<ProviderAdapterV2Event, { type: 'provider_turn.updated' }>['providerTurn']['status']

export interface ConversationResumeThreadInput {
  readonly nativeThreadId: string
  readonly cwd: string
  readonly model: string
}

export interface ConversationInterruptTurnInput {
  readonly nativeThreadId: string
  readonly turnId: string
}

export interface ConversationSteerTurnInput extends ConversationInterruptTurnInput {
  readonly text: string
}

export type ConversationRuntimeResponse =
  | { readonly kind: 'approval'; readonly decision: ProviderApprovalDecision; readonly feedback?: string }
  | { readonly kind: 'user-input'; readonly answers: ProviderUserInputAnswers; readonly attachments?: {
      readonly questionId: string; readonly contents: readonly ConversationAttachmentContent[]
    } }

export interface ConversationRespondToRuntimeRequestInput extends ConversationInterruptTurnInput {
  readonly nativeRequestId: string
  readonly response: ConversationRuntimeResponse
}

export type ConversationDriverRuntimeRequest =
  | { readonly kind: 'approval'; readonly title: string; readonly details?: string; readonly options: readonly { readonly decision: ProviderApprovalDecision; readonly label: string; readonly optionId?: string }[] }
  | { readonly kind: 'user-input'; readonly title: string; readonly questions: readonly ConversationRuntimeQuestion[] }

export type ConversationDriverWorkItem =
  | {
      readonly kind: 'tool'
      readonly nativeItemId: string
      readonly label: string
      readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
      readonly fileChanges?: readonly {
        readonly path: string
        readonly operation: 'add' | 'delete' | 'update'
        readonly diff?: string
      }[]
    }
  | {
      readonly kind: 'proposed-plan'
      readonly nativeItemId: string
      readonly markdown: string
    }
  | {
      readonly kind: 'plan-steps'
      readonly steps: ReadonlyArray<{ readonly text: string; readonly status: 'pending' | 'running' | 'completed' }>
      readonly explanation?: string
    }

/** The callback is scoped to its native thread. Its first nonempty text event is the first response evidence. */
export type ConversationDriverTurnEvent = { readonly turnId: string; readonly turnIdSource?: 'native' | 'host' } & (
  | { readonly type: 'turn-receipt' }
  | { readonly type: 'turn-accepted'; readonly nativeStartedAt?: string }
  | { readonly type: 'text-delta' | 'text-final'; readonly itemId: string; readonly text: string }
  | { readonly type: 'turn-completed'; readonly status: ProviderTurnStatus; readonly error?: string }
  | { readonly type: 'runtime-request'; readonly nativeRequestId: string; readonly request: ConversationDriverRuntimeRequest }
  | { readonly type: 'background-work'; readonly pending: boolean; readonly nativeWorkId?: string }
  | { readonly type: 'work-item'; readonly item: ConversationDriverWorkItem }
  | ConversationNativeSubagentEvent
  | {
      readonly type: 'usage'
      readonly usage: {
        readonly inputTokens: number
        readonly outputTokens: number
        readonly cachedInputTokens?: number
        readonly reasoningOutputTokens?: number
        readonly contextWindow?: number
      }
    }
)

export type ConversationDriverEventListener = (event: ConversationDriverTurnEvent) => void

export interface ConversationStartTurnContext {
  readonly requestId: string
  readonly modelOptions?: ProviderOptionSelections
  readonly attachments?: readonly ConversationAttachmentContent[]
  readonly delegation?: (call: ConversationDelegationCall) => Promise<ConversationDelegationReply>
  assertAuthorized?(): Promise<void>
  assertCurrent(): void
}

export interface ConversationCompactThreadInput {
  readonly nativeThreadId: string
  readonly cwd: string
  readonly model: string
  readonly instructions?: string
  readonly onEvent: ConversationDriverEventListener
  readonly context: ConversationStartTurnContext
}

export type ConversationThreadDetachConfirmation = 'unsubscribed' | 'notSubscribed' | 'notLoaded'

export interface ConversationDriverSession {
  isAvailable(): boolean
  close(): Effect.Effect<void, Error>
  listModels(): Effect.Effect<readonly ConversationDriverModel[], Error>
  describe?(): Effect.Effect<ConversationDriverDescriptor, Error>
  validatePromptAttachments?(attachments: readonly ChatAttachment[]): void
  startThread(model: string, cwd: string): Effect.Effect<string, Error>
  resumeThread?(input: ConversationResumeThreadInput): Effect.Effect<string, Error>
  detachThread?(input: { readonly nativeThreadId: string; assertCurrent(): void }): Effect.Effect<ConversationThreadDetachConfirmation, Error>
  canConfirmWindowsJobClose?(nativeThreadId: string): boolean
  interruptTurn?(input: ConversationInterruptTurnInput): Effect.Effect<void, Error>
  steerTurn?(input: ConversationSteerTurnInput): Effect.Effect<void, Error>
  respondToRuntimeRequest?(input: ConversationRespondToRuntimeRequestInput): Effect.Effect<void, Error>
  compactThread?(input: ConversationCompactThreadInput): Effect.Effect<string, Error>
  startTurn(nativeThreadId: string, cwd: string, text: string, model: string, onEvent: ConversationDriverEventListener, context?: ConversationStartTurnContext): Effect.Effect<string, Error>
}

export interface ConversationDriverOpenInput {
  readonly instanceId: string
  readonly ownerScope?: string
  readonly fingerprintKey?: Buffer
  readonly managedExecution?: true
  readonly worktreeWriter?: import('./codex/process-owner').CodexWorktreeWriter
  readonly directory: string
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  readonly ordinaryTask?: true
  assertCanSpawn(): void
  onSpawn(session: ConversationDriverSession): void
}

export interface ConversationDriverRegistration {
  readonly instanceId: AdapterIdentity['instanceId']
  readonly driverKind: AdapterIdentity['driver']
  readonly configurationKey?: (env?: NodeJS.ProcessEnv, fingerprintKey?: Buffer) => string
  readonly turnModelOptions?: true
  readonly ordinaryTaskAccess?: 'native-read-only' | 'tools-disabled'
  readonly planningAccess?: 'native-read-only'
  readonly executionAccess?: 'native-workspace-write'
  readonly delegatedWorktreeAccess?: 'native-workspace-write'
  readonly reconcileOwnerClosure?: (input: {
    readonly directory: string; readonly cwd: string; readonly instanceId: string; readonly ownerScope: string
    assertCurrent(): void
  }) => Promise<boolean>
  readonly promptAttachments?: ConversationPromptAttachmentSupport
  readonly open: (input: ConversationDriverOpenInput) => Effect.Effect<ConversationDriverSession, Error>
}

export class ConversationTurnOutcomeUnknownError extends Error {
  constructor(readonly turnId: string, options?: ErrorOptions) {
    super(turnId ? `The provider did not confirm the outcome of turn ${turnId}.` : 'The provider did not confirm receipt of the turn.', options)
    this.name = 'ConversationTurnOutcomeUnknownError'
  }
}

export class ConversationTurnRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConversationTurnRejectedError'
  }
}

export interface ConversationDriverRegistry {
  get(instanceId: string): ConversationDriverRegistration | undefined
  require(instanceId: string): ConversationDriverRegistration
  list(): readonly ConversationDriverRegistration[]
}

const codex: ConversationDriverRegistration = {
  instanceId: ProviderInstanceId.make('codex'),
  driverKind: ProviderDriverKind.make('codex'),
  configurationKey: codexConfigurationKey,
  turnModelOptions: true,
  ordinaryTaskAccess: 'native-read-only',
  planningAccess: 'native-read-only',
  executionAccess: 'native-workspace-write',
  delegatedWorktreeAccess: 'native-workspace-write',
  reconcileOwnerClosure: reconcileCodexProcessClosed,
  promptAttachments: RASTER_ATTACHMENTS,
  open: input => Effect.tryPromise({
    try: () => import('./codex/driver'),
    catch: cause => Object.assign(new DaemonError('E_UNAVAILABLE', '无法载入 Codex 对话驱动。'), { cause }),
  }).pipe(Effect.flatMap(({ CodexDriver }) => CodexDriver.open(input))),
}

const claude: ConversationDriverRegistration = {
  instanceId: ProviderInstanceId.make('claude'),
  driverKind: ProviderDriverKind.make('claudeCode'),
  configurationKey: claudeConfigurationKey,
  promptAttachments: RASTER_ATTACHMENTS,
  open: input => Effect.tryPromise({
    try: () => import('./claude/ClaudeAdapterV2'),
    catch: cause => Object.assign(new DaemonError('E_UNAVAILABLE', '无法载入 Claude SDK 对话驱动。'), { cause }),
  }).pipe(Effect.flatMap(({ ClaudeDriver }) => ClaudeDriver.open(input))),
}

const opencode: ConversationDriverRegistration = {
  instanceId: ProviderInstanceId.make('opencode'),
  driverKind: ProviderDriverKind.make('opencode'),
  configurationKey: openCodeConfigurationKey,
  ordinaryTaskAccess: 'tools-disabled',
  promptAttachments: RASTER_ATTACHMENTS,
  open: input => Effect.tryPromise({
    try: () => import('./opencode/adapter'),
    catch: cause => Object.assign(new DaemonError('E_UNAVAILABLE', '无法载入 OpenCode v2 对话驱动。'), { cause }),
  }).pipe(Effect.flatMap(({ OpenCodeDriver }) => OpenCodeDriver.open(input))),
}

export function createConversationDriverRegistry(
  additionalRegistrations: readonly ConversationDriverRegistration[] = [],
  dynamicRegistrations: () => readonly ConversationDriverRegistration[] = () => [],
  fingerprintKey?: Buffer,
): ConversationDriverRegistry {
  const bind = (registration: ConversationDriverRegistration): ConversationDriverRegistration => {
    if (!fingerprintKey) return registration
    const configuration = registration.configurationKey
    return {
      ...registration,
      ...(configuration && { configurationKey: env => configuration(env, fingerprintKey) }),
      open: input => registration.open({ ...input, fingerprintKey }),
    }
  }
  const registrations = new Map<string, ConversationDriverRegistration>()
  for (const registration of [codex, ...additionalRegistrations]) {
    if (registrations.has(registration.instanceId)) {
      throw new DaemonError('E_CONFLICT', `对话引擎实例 ${registration.instanceId} 重复注册。`)
    }
    registrations.set(registration.instanceId, bind(registration))
  }
  const list = (): ConversationDriverRegistration[] => {
    const result = new Map(registrations)
    for (const registration of dynamicRegistrations()) {
      if (result.has(registration.instanceId)) throw new DaemonError('E_CONFLICT', `对话引擎实例 ${registration.instanceId} 重复注册。`)
      result.set(registration.instanceId, bind(registration))
    }
    return [...result.values()]
  }
  const get = (instanceId: string): ConversationDriverRegistration | undefined =>
    registrations.get(instanceId) ?? list().find(registration => registration.instanceId === instanceId)
  return {
    get,
    require(instanceId) {
      const registration = get(instanceId)
      if (!registration) throw new DaemonError('E_UNAVAILABLE', `对话引擎实例 ${instanceId} 尚未接入。`)
      return registration
    },
    list,
  }
}

export function createNativeConversationDriverRegistry(
  userData?: string,
  additionalRegistrations: readonly ConversationDriverRegistration[] = [],
  fingerprintKey?: Buffer,
): ConversationDriverRegistry {
  return createConversationDriverRegistry([claude, opencode, ...additionalRegistrations],
    () => userData ? listRegisteredAcpDrivers(userData) : [], fingerprintKey)
}

export const conversationDriverRegistry = createConversationDriverRegistry()
