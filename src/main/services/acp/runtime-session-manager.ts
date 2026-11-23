import { app } from 'electron'
import * as Effect from 'effect/Effect'
import type { AcpAgentConfig, AcpSessionStatus } from '../../../shared/types'
import { resolveAdmittedLocalProvider } from './local-providers'
import { ipcFail, IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import { make as makeKeyedLock } from './t3-core/keyed-lock'

export type AcpRuntimeReleaseReason =
  | 'turn-settled'
  | 'process-exit-verified'
  | 'explicit-stop-verified'
  | 'startup-failed-verified'
  | 'capacity-verified'
  | 'idle-verified'

export type AcpRuntimeReleaseClassification =
  | 'released-clean'
  | 'blocked-platform-owner'
  | 'blocked-managed-task'
  | 'blocked-active-turn'
  | 'blocked-admission'
  | 'blocked-permission'
  | 'blocked-unfinished-tool'
  | 'blocked-cleanup-uncertain'
  | 'blocked-directory-lease'
  | 'blocked-transient-state'
  | 'blocked-nonrecoverable'

export type AcpRuntimeDisconnectCause =
  | 'startup'
  | 'resume'
  | 'idle-release'
  | 'capacity-release'
  | 'user-stop'
  | 'application-shutdown'
  | 'process-exit'
  | 'protocol-error'
  | 'auth-failure'
  | 'cleanup-uncertain'
  | 'provider-error'

export type AcpRuntimeTelemetryReason = AcpRuntimeReleaseReason | 'startup-verified' | 'resume-verified'

export type AcpRuntimeTelemetryEvent =
  | 'startup'
  | 'resume'
  | 'release'
  | 'capacity-wait'
  | 'cleanup'
  | 'disconnect'

export type AcpRuntimeTelemetryDetailCode =
  | 'AGENT_STARTUP_FAILED'
  | 'AGENT_DISCONNECTED'
  | 'AGENT_SPAWN_ENOENT'
  | 'AUTH_REQUIRED'
  | 'SESSION_RESUME_REQUIRED'
  | 'QUEUE_PROTOCOL_MALFORMED_MESSAGE'
  | 'QUEUE_PROTOCOL_INVALID_JSON'
  | 'QUEUE_PROTOCOL_UNEXPECTED_RESPONSE'
  | 'UNKNOWN'

export const ACP_RUNTIME_PROVIDER_FAMILIES = [
  'codex',
  'claude',
  'opencode',
  'dsh',
  'zcode',
  'pi',
  'unknown',
] as const

export type AcpRuntimeProviderFamily = (typeof ACP_RUNTIME_PROVIDER_FAMILIES)[number]

export interface AcpRuntimeCapacityUsage {
  providerFamily: AcpRuntimeProviderFamily
  active: number
  reserved: number
  limit: number
}

export interface AcpRuntimeReleaseContext {
  reason: AcpRuntimeReleaseReason
  providerFamily: AcpRuntimeProviderFamily
}

export interface AcpRuntimeReleaseResult {
  classification: AcpRuntimeReleaseClassification
  reason: AcpRuntimeReleaseReason
  providerFamily: AcpRuntimeProviderFamily
}

export interface AcpRuntimeDisconnectTelemetry {
  event: AcpRuntimeTelemetryEvent
  cause: AcpRuntimeDisconnectCause
  providerFamily: AcpRuntimeProviderFamily
  conversationId: string
  runtimeSessionId: string
  reason: AcpRuntimeTelemetryReason
  cleanupConfirmed: boolean
  occurredAt: number
  durationMs: number
}

export interface AcpRuntimeCapacityOwnerView {
  sessionId: string
  providerFamily: AcpRuntimeProviderFamily
  lastUsedAt: number
  canResume: boolean
  hasNativeIdentity: boolean
  nativePersistenceConfirmed: boolean
  runtimeRecordAvailable: boolean
  platformOwned: boolean
  managedTaskOwner: boolean
  status: AcpSessionStatus
  accepting: boolean
  turnActive: boolean
  closing: boolean
  settling: boolean
  backgroundWork: boolean
  uncertainWork: boolean
  cleanupRequired: boolean
  leaseHeld: boolean
  pendingPermissions: boolean
  unfinishedTools: boolean
}

export interface AcpRuntimeReservationView {
  sessionId: string
  providerFamily: AcpRuntimeProviderFamily
}

export interface AcpRuntimeFamilyCapabilityDeclaration {
  processAccounting: 'independent-owner' | 'shared-provider-process'
  sharedProcess: boolean
  runtimeThreadCapacity: number
  ownerCapacity: number
}

export type AcpRuntimeFamilyCapability = Readonly<Record<AcpRuntimeProviderFamily, AcpRuntimeFamilyCapabilityDeclaration>>

export interface AcpRuntimeCapacityFailure extends IpcFail {
  family: AcpRuntimeCapacityUsage
  capacityReason: AcpRuntimeCapacityReason
  candidateId?: string
}

export type AcpRuntimeCapacityDecision =
  | { ok: true; family: AcpRuntimeCapacityUsage }
  | AcpRuntimeCapacityFailure

export type AcpRuntimeCapacityReason = AcpRuntimeReleaseClassification | 'capacity-release-required' | 'capacity-reserved'

export const RECENT_USE_PIN_MS = 10 * 60_000
export const IDLE_RELEASE_AFTER_MS = 30 * 60_000
export const IDLE_RELEASE_POLL_MS = 60_000
const OWNER_CAPACITY = 4
const UNKNOWN_OWNER_CAPACITY = 1
const ZCODE_RUNTIME_ID = 'zcode'
const MAX_TELEMETRY_DURATION_MS = 86_400_000

function independentOwnerCapability(ownerCapacity = OWNER_CAPACITY): AcpRuntimeFamilyCapabilityDeclaration {
  return { processAccounting: 'independent-owner', sharedProcess: false, runtimeThreadCapacity: 1, ownerCapacity }
}

export const ACP_RUNTIME_FAMILY_CAPABILITIES: AcpRuntimeFamilyCapability = {
  codex: independentOwnerCapability(),
  claude: independentOwnerCapability(),
  opencode: independentOwnerCapability(),
  dsh: independentOwnerCapability(),
  zcode: independentOwnerCapability(),
  pi: independentOwnerCapability(),
  unknown: independentOwnerCapability(UNKNOWN_OWNER_CAPACITY),
}

export function boundedProviderFamily(value: string): AcpRuntimeProviderFamily {
  return ACP_RUNTIME_PROVIDER_FAMILIES.includes(value as AcpRuntimeProviderFamily)
    ? value as AcpRuntimeProviderFamily
    : 'unknown'
}

function providerFamily(runtime: AcpAgentConfig | undefined, fallbackAgentId: string): AcpRuntimeProviderFamily {
  if (runtime?.launchKind === 'local') {
    try { return boundedProviderFamily(resolveAdmittedLocalProvider(app.getPath('userData'), runtime.id).agentId) }
    catch { return 'unknown' }
  }
  const runtimeId = runtime?.id ?? fallbackAgentId
  return boundedProviderFamily(runtimeId)
}

function familyUsage(family: AcpRuntimeProviderFamily, owners: Iterable<AcpRuntimeCapacityOwnerView>, reservations: Iterable<AcpRuntimeReservationView>): AcpRuntimeCapacityUsage {
  const capability = providerFamilyCapability(family)
  const reservedSessionIds = new Set<string>()
  let reserved = 0
  for (const reservation of reservations) {
    if (reservation.providerFamily !== family) continue
    reserved += 1
    reservedSessionIds.add(reservation.sessionId)
  }
  let active = 0
  for (const owner of owners) {
    if (owner.providerFamily !== family) continue
    if (!reservedSessionIds.has(owner.sessionId)) active += 1
  }
  return { providerFamily: family, active, reserved, limit: capability.ownerCapacity }
}

function releaseBlocked(owner: AcpRuntimeCapacityOwnerView): AcpRuntimeReleaseClassification | undefined {
  if (owner.platformOwned) return 'blocked-platform-owner'
  if (owner.managedTaskOwner) return 'blocked-managed-task'
  if (owner.turnActive || owner.status === 'busy') return 'blocked-active-turn'
  if (owner.accepting || owner.status === 'starting') return 'blocked-admission'
  if (owner.pendingPermissions || owner.status === 'awaiting_permission') return 'blocked-permission'
  if (owner.backgroundWork || owner.unfinishedTools) return 'blocked-unfinished-tool'
  if (owner.cleanupRequired || owner.uncertainWork) return 'blocked-cleanup-uncertain'
  if (owner.closing || owner.settling || owner.status === 'cancelling') return 'blocked-transient-state'
  if (owner.leaseHeld) return 'blocked-directory-lease'
  if (!owner.canResume || !owner.hasNativeIdentity || !owner.runtimeRecordAvailable) return 'blocked-nonrecoverable'
  if (!owner.nativePersistenceConfirmed && owner.providerFamily === ZCODE_RUNTIME_ID) return 'blocked-nonrecoverable'
  if (owner.status !== 'ready') return 'blocked-transient-state'
  return undefined
}

export function providerFamilyForRuntime(runtime: AcpAgentConfig | undefined, fallbackAgentId: string): AcpRuntimeProviderFamily {
  return providerFamily(runtime, fallbackAgentId)
}

export function providerFamilyCapability(providerFamily: AcpRuntimeProviderFamily): AcpRuntimeFamilyCapabilityDeclaration {
  return ACP_RUNTIME_FAMILY_CAPABILITIES[providerFamily]
}

export function classifyRuntimeRelease(owner: AcpRuntimeCapacityOwnerView, context: AcpRuntimeReleaseContext): AcpRuntimeReleaseResult {
  const blocked = releaseBlocked(owner)
  return {
    classification: blocked ?? 'released-clean',
    reason: context.reason,
    providerFamily: context.providerFamily,
  }
}

export function disconnectTelemetry(input: Omit<AcpRuntimeDisconnectTelemetry, 'event' | 'durationMs'> & { event?: AcpRuntimeTelemetryEvent; durationMs?: number }): AcpRuntimeDisconnectTelemetry {
  const end = Number.isFinite(input.occurredAt) ? input.occurredAt : Date.now()
  const rawDuration = typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ? input.durationMs : 0
  const { durationMs, ...fields } = input
  return {
    event: input.event ?? 'disconnect',
    ...fields,
    occurredAt: end,
    durationMs: Math.max(0, Math.min(MAX_TELEMETRY_DURATION_MS, Math.trunc(rawDuration))),
  }
}

export function runtimeTelemetryCause(trigger: 'user' | 'capacity' | 'shutdown' | 'idle', detailCode?: string): AcpRuntimeDisconnectCause {
  if (detailCode === 'AUTH_REQUIRED') return 'auth-failure'
  if (detailCode && detailCode.startsWith('QUEUE_PROTOCOL_')) return 'protocol-error'
  if (trigger === 'capacity') return 'capacity-release'
  if (trigger === 'idle') return 'idle-release'
  if (trigger === 'shutdown') return 'application-shutdown'
  return 'user-stop'
}

export function runtimeFailureCause(error: unknown): AcpRuntimeDisconnectCause {
  const detailCode = runtimeErrorDetailCode(error)
  if (detailCode === 'AUTH_REQUIRED') return 'auth-failure'
  if (detailCode?.startsWith('QUEUE_PROTOCOL_')) return 'protocol-error'
  return 'provider-error'
}

export function runtimeErrorDetailCode(error: unknown): AcpRuntimeTelemetryDetailCode | undefined {
  let current = error
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (typeof current === 'object' && 'detailCode' in current) {
      const value = (current as { detailCode?: unknown }).detailCode
      if (value === 'AGENT_STARTUP_FAILED' || value === 'AGENT_DISCONNECTED' || value === 'AGENT_SPAWN_ENOENT'
        || value === 'AUTH_REQUIRED' || value === 'SESSION_RESUME_REQUIRED' || value === 'QUEUE_PROTOCOL_MALFORMED_MESSAGE'
        || value === 'QUEUE_PROTOCOL_INVALID_JSON' || value === 'QUEUE_PROTOCOL_UNEXPECTED_RESPONSE') return value
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined
  }
  return undefined
}

export class RuntimeSessionManager {
  private readonly releaseLock = Effect.runSync(makeKeyedLock<AcpRuntimeProviderFamily>())

  constructor(
    private readonly owners: () => Iterable<AcpRuntimeCapacityOwnerView>,
    private readonly reservations: () => Iterable<AcpRuntimeReservationView>,
  ) {
    this.capacityReleaseClaims = new Map<string, { providerFamily: AcpRuntimeProviderFamily; sessionId: string }>()
  }

  private readonly capacityReleaseClaims: Map<string, { providerFamily: AcpRuntimeProviderFamily; sessionId: string }>

  familyFor(runtime: AcpAgentConfig | undefined, fallbackAgentId: string): AcpRuntimeProviderFamily {
    return providerFamily(runtime, fallbackAgentId)
  }

  usage(family: AcpRuntimeProviderFamily): AcpRuntimeCapacityUsage {
    const current = this.owners()
    const reservedKeys = this.reservations()
    const usage = familyUsage(family, current, reservedKeys)
    return structuredClone(usage)
  }

  reserve(family: AcpRuntimeProviderFamily, excludedSessionId?: string): AcpRuntimeCapacityDecision {
    const owners = [...this.owners()]
    const reservedKeys = this.reservations()
    const familyUsageValue = familyUsage(family, owners, reservedKeys)
    if (familyUsageValue.active + familyUsageValue.reserved >= familyUsageValue.limit) {
      if (this.hasCapacityReleaseClaim(family)) {
        return { ...ipcFail(IpcErrorCode.Busy, `${family} 运行连接正在释放，输入已保留，请稍后重试`), family: familyUsageValue, capacityReason: 'capacity-reserved' as const }
      }
      const candidates = owners.filter(owner => owner.sessionId !== excludedSessionId && owner.providerFamily === family)
      const idle = candidates.map(owner => ({ owner, blocked: releaseBlocked(owner) }))
        .filter((item): item is { owner: AcpRuntimeCapacityOwnerView; blocked: undefined } => item.blocked === undefined)
        .sort((left, right) => left.owner.lastUsedAt - right.owner.lastUsedAt || left.owner.sessionId.localeCompare(right.owner.sessionId))[0]
      if (!idle) {
        const classification = candidates.length
          ? candidates.map(owner => releaseBlocked(owner)).find((value): value is AcpRuntimeReleaseClassification => value !== undefined) ?? 'blocked-transient-state'
          : 'blocked-nonrecoverable'
        return { ...ipcFail(IpcErrorCode.Conflict, `${family} 运行连接已达 ${familyUsageValue.limit} 个，暂无该引擎家族内可安全释放的空闲连接；输入已保留，请稍后重试或结束不用的会话`), family: familyUsageValue, capacityReason: classification }
      }
      const candidateId = idle.owner.sessionId
      this.capacityReleaseClaims.set(candidateId, { providerFamily: family, sessionId: candidateId })
      return { ...ipcFail(IpcErrorCode.Conflict, `${family} 运行连接已满，需先释放 ${candidateId}`), family: familyUsageValue, candidateId, capacityReason: 'capacity-release-required' as const }
    }
    return { ok: true, family: familyUsageValue }
  }

  idleReleaseCandidates(now = Date.now(), idleAfter = IDLE_RELEASE_AFTER_MS, recentUsePin = RECENT_USE_PIN_MS): string[] {
    const cutoff = now - idleAfter
    return [...this.owners()]
      .filter(owner => owner.providerFamily && owner.lastUsedAt <= cutoff
        && now - owner.lastUsedAt >= recentUsePin
        && releaseBlocked(owner) === undefined)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.sessionId.localeCompare(right.sessionId))
      .map(owner => owner.sessionId)
  }

  release(owner: AcpRuntimeCapacityOwnerView, context: AcpRuntimeReleaseContext): AcpRuntimeReleaseResult {
    return classifyRuntimeRelease(owner, context)
  }

  withReleaseLock<T>(family: AcpRuntimeProviderFamily, release: () => Promise<T>): Promise<T> {
    return Effect.runPromise(this.releaseLock.withLock(family, Effect.tryPromise({ try: release, catch: error => error })))
  }

  releaseIfStillIdle(
    candidate: AcpRuntimeCapacityOwnerView,
    currentOwner: () => AcpRuntimeCapacityOwnerView | undefined,
    release: () => Promise<void>,
  ): Promise<void> {
    return this.withReleaseLock(candidate.providerFamily, async () => {
      if (this.hasCapacityReleaseClaim(candidate.providerFamily)) return
      const current = currentOwner()
      if (current === undefined || current.lastUsedAt !== candidate.lastUsedAt || current.providerFamily !== candidate.providerFamily
        || releaseBlocked(current) !== undefined) return
      await release()
    })
  }

  private hasCapacityReleaseClaim(family: AcpRuntimeProviderFamily): boolean {
    return [...this.capacityReleaseClaims.values()].some(claim => claim.providerFamily === family)
  }

  completeCapacityReleaseClaim(candidateId: string): void {
    this.capacityReleaseClaims.delete(candidateId)
  }

  isCapacityReleaseClaimed(candidateId: string): boolean {
    return this.capacityReleaseClaims.has(candidateId)
  }
}
