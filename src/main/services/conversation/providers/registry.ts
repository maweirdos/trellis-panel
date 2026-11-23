import * as Effect from 'effect/Effect'
import { ProviderDriverKind, ProviderInstanceId } from '../../../../shared/conversation/providerInstance'
import { DaemonError } from '../../../daemon/errors'
import type { ProviderAdapterV2, ProviderAdapterV2Event } from './core/ProviderAdapter'

type AdapterIdentity = Pick<ProviderAdapterV2['Service'], 'instanceId' | 'driver'>
type ProviderTurnStatus = Extract<ProviderAdapterV2Event, { type: 'provider_turn.updated' }>['providerTurn']['status']

export interface ConversationDriverModel {
  readonly id: string
  readonly displayName: string
  readonly isDefault: boolean
}

/** The callback is scoped to its native thread. Its first nonempty text event is the first response evidence. */
export type ConversationDriverTurnEvent = { readonly turnId: string } & (
  | { readonly type: 'turn-receipt' }
  | { readonly type: 'turn-accepted'; readonly nativeStartedAt?: string }
  | { readonly type: 'text-delta' | 'text-final'; readonly itemId: string; readonly text: string }
  | { readonly type: 'turn-completed'; readonly status: ProviderTurnStatus; readonly error?: string }
)

export type ConversationDriverEventListener = (event: ConversationDriverTurnEvent) => void

export interface ConversationDriverSession {
  isAvailable(): boolean
  close(): Effect.Effect<void, Error>
  listModels(): Effect.Effect<readonly ConversationDriverModel[], Error>
  startThread(model: string, cwd: string): Effect.Effect<string, Error>
  startTurn(nativeThreadId: string, cwd: string, text: string, model: string, onEvent: ConversationDriverEventListener): Effect.Effect<string, Error>
}

export interface ConversationDriverOpenInput {
  readonly instanceId: string
  readonly directory: string
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  assertCanSpawn(): void
  onSpawn(session: ConversationDriverSession): void
}

export interface ConversationDriverRegistration {
  readonly instanceId: AdapterIdentity['instanceId']
  readonly driverKind: AdapterIdentity['driver']
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
  open: input => Effect.tryPromise({
    try: () => import('./codex/driver'),
    catch: cause => Object.assign(new DaemonError('E_UNAVAILABLE', '无法载入 Codex 对话驱动。'), { cause }),
  }).pipe(Effect.flatMap(({ CodexDriver }) => CodexDriver.open(input))),
}

export function createConversationDriverRegistry(
  additionalRegistrations: readonly ConversationDriverRegistration[] = [],
): ConversationDriverRegistry {
  const registrations = new Map<string, ConversationDriverRegistration>()
  for (const registration of [codex, ...additionalRegistrations]) {
    if (registrations.has(registration.instanceId)) {
      throw new DaemonError('E_CONFLICT', `对话引擎实例 ${registration.instanceId} 重复注册。`)
    }
    registrations.set(registration.instanceId, registration)
  }
  return {
    get: instanceId => registrations.get(instanceId),
    require(instanceId) {
      const registration = registrations.get(instanceId)
      if (!registration) throw new DaemonError('E_UNAVAILABLE', `对话引擎实例 ${instanceId} 尚未接入。`)
      return registration
    },
    list: () => [...registrations.values()],
  }
}

export const conversationDriverRegistry = createConversationDriverRegistry()
