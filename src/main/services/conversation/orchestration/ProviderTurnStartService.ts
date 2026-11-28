import { DaemonError } from '../../../daemon/errors'
import { classifyConversationFailure } from '../../../../shared/conversation/failure-taxonomy'
import type { OpenArtifactMcpGrant } from '../../../../shared/open-artifact'
import type { RuntimeMode } from '../../../../shared/conversation/providerPolicy'
import type {
  ConversationDriverRegistration,
  ConversationDriverRegistry,
  ConversationDriverSession,
} from '../providers/registry'
import type { ConversationProjectionStore } from '../persistence/ProjectionStore'
import { ConversationDeadlineError, runBounded } from './EffectWorker'
import type { ProviderSessionManager } from './ProviderSessionManager'
import { decideProviderSessionTransition } from './ProviderSessionTransitionPolicy'

export interface ProviderTurnStartPorts {
  readonly projections: ConversationProjectionStore
  readonly sessions: ProviderSessionManager
  readonly driverRegistry: ConversationDriverRegistry
  readonly deadlines: { readonly thread: number }
  readonly shutdownSignal: AbortSignal
  isClosing(): boolean
  bindingFingerprint(registration: ConversationDriverRegistration): string
  bindingFingerprintMatches(stored: string | null | undefined, expected: string): boolean
}

export interface OpenedNativeThreadResult {
  readonly nativeThreadId: string
  readonly usedNativeFork?: boolean
  readonly recoveredFrom?: {
    readonly instance_id: string
    readonly native_thread_id: string
    readonly configuration_fingerprint: string | null
    readonly previous_run_id: string | null
  }
}

export interface NativeForkCandidate {
  readonly sourceNativeThreadId: string
  readonly sourceInstanceId: string
  readonly sourceNativeTurnId?: string
  readonly isLatestParentRun?: boolean
  readonly configurationFingerprint?: string | null
}

const failureMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * 引擎会话启动与恢复策略执行器：
 * 统一封装 `ProviderSessionTransitionPolicy` 裁决、原生 Fork 尝试、同账号自动恢复建链与跨账号/跨配置拦截。
 */
export class ProviderTurnStartService {
  constructor(private readonly ports: ProviderTurnStartPorts) {}

  canFallbackFromResumeFailure(error: unknown): boolean {
    if (this.ports.isClosing() || this.ports.shutdownSignal.aborted) return false
    return classifyConversationFailure({
      error,
      isDeadlineError: error instanceof ConversationDeadlineError,
    }).canAutoRecoverResume
  }

  assertNativeBindingConfiguration(threadId: string, fingerprint: string, instanceId: string): void {
    const stored = this.ports.projections.readNativeBindingOrRunFallback(threadId)
    if (!stored) return
    const decision = decideProviderSessionTransition({
      driverAvailable: true,
      isHandoffCommand: false,
      targetInstanceId: instanceId,
      targetBindingFingerprint: fingerprint,
      driverSupportsResume: true,
      allowResumeFallback: true,
      storedBinding: {
        instanceId: stored.instance_id,
        nativeThreadId: stored.native_thread_id,
        configurationFingerprint: stored.configuration_fingerprint,
      },
      fingerprintMatches: (prev, expected) => this.ports.bindingFingerprintMatches(prev, expected),
    })
    if (decision.type === 'require_handoff_confirm') {
      throw new DaemonError('E_CONFLICT', decision.reason)
    }
  }

  async openOrForkNativeThread(input: {
    readonly threadId: string
    readonly instanceId: string
    readonly model: string
    readonly cwd: string
    readonly driver: ConversationDriverSession
    readonly fresh?: boolean
    readonly artifactMcp?: OpenArtifactMcpGrant
    readonly allowResumeFallback?: boolean
    readonly expectedBindingFingerprint?: string
    readonly runtimeMode?: RuntimeMode
    readonly nativeFork?: NativeForkCandidate
  }): Promise<OpenedNativeThreadResult> {
    const { threadId, instanceId, model, cwd, driver, artifactMcp, runtimeMode, expectedBindingFingerprint } = input
    if (
      input.nativeFork
      && driver.forkThread
      && input.nativeFork.sourceInstanceId === instanceId
      && (!input.nativeFork.configurationFingerprint
        || !expectedBindingFingerprint
        || this.ports.bindingFingerprintMatches(input.nativeFork.configurationFingerprint, expectedBindingFingerprint))
    ) {
      try {
        const forkedId = await runBounded(
          driver.forkThread({
            sourceNativeThreadId: input.nativeFork.sourceNativeThreadId,
            cwd,
            model,
            runtimeMode,
            ...(!input.nativeFork.isLatestParentRun && input.nativeFork.sourceNativeTurnId
              ? { lastTurnId: input.nativeFork.sourceNativeTurnId }
              : {}),
          }),
          this.ports.deadlines.thread,
          '派生原生会话',
          this.ports.shutdownSignal,
        )
        if (forkedId && forkedId !== input.nativeFork.sourceNativeThreadId) {
          return { nativeThreadId: forkedId, usedNativeFork: true }
        }
      } catch (error) {
        if (this.ports.isClosing() || this.ports.shutdownSignal.aborted) throw error
        process.emitWarning(
          `Native thread fork failed for ${threadId}; falling back to portable fork context: ${failureMessage(error)}`,
          { code: 'CRUX_CONVERSATION_RECOVERY' },
        )
      }
    }

    return this.openNativeThread(
      threadId,
      instanceId,
      model,
      cwd,
      driver,
      Boolean(input.fresh),
      artifactMcp,
      Boolean(input.allowResumeFallback),
      expectedBindingFingerprint,
      runtimeMode,
    )
  }

  async openNativeThread(
    threadId: string,
    instanceId: string,
    model: string,
    cwd: string,
    driver: ConversationDriverSession,
    fresh = false,
    artifactMcp?: OpenArtifactMcpGrant,
    allowResumeFallback = false,
    expectedBindingFingerprint?: string,
    runtimeMode?: RuntimeMode,
  ): Promise<OpenedNativeThreadResult> {
    const loaded = this.ports.sessions.loadedThreads.get(threadId)
    const existing = fresh ? undefined : this.ports.projections.readNativeBindingOrRunFallback(threadId)
    const registration = this.ports.driverRegistry.get(instanceId)
    const targetFingerprint = expectedBindingFingerprint ?? (registration ? this.ports.bindingFingerprint(registration) : '')
    const decision = decideProviderSessionTransition({
      driverAvailable: driver.isAvailable(),
      isHandoffCommand: fresh,
      targetInstanceId: instanceId,
      targetBindingFingerprint: targetFingerprint,
      driverSupportsResume: Boolean(driver.resumeThread),
      allowResumeFallback,
      ...(existing ? {
        storedBinding: {
          instanceId: existing.instance_id,
          nativeThreadId: existing.native_thread_id,
          configurationFingerprint: existing.configuration_fingerprint,
        },
      } : {}),
      ...(loaded ? {
        loadedHandle: {
          matchesTargetDriver: loaded.driver === driver,
          nativeThreadId: loaded.nativeThreadId,
        },
      } : {}),
      fingerprintMatches: (stored, expected) => this.ports.bindingFingerprintMatches(stored, expected),
    })

    if (decision.type === 'reject') {
      throw new DaemonError(decision.code, decision.reason)
    }
    if (decision.type === 'require_handoff_confirm') {
      throw new DaemonError('E_CONFLICT', decision.reason)
    }
    if (decision.type === 'reuse') {
      return { nativeThreadId: decision.nativeThreadId }
    }

    const startRecoveredThread = async (reason: unknown): Promise<OpenedNativeThreadResult> => {
      process.emitWarning(
        `Recovering thread ${threadId} in a fresh native session after resume failure: ${failureMessage(reason)}`,
        { code: 'CRUX_CONVERSATION_RECOVERY' },
      )
      this.ports.sessions.loadedThreads.delete(threadId)
      const replacementId = await runBounded(
        driver.startThread(model, cwd, artifactMcp, runtimeMode),
        this.ports.deadlines.thread,
        '建立接力原生会话',
        this.ports.shutdownSignal,
      )
      if (!replacementId || (existing && replacementId === existing.native_thread_id)) {
        this.ports.sessions.uncertainDrivers.add(driver)
        throw new DaemonError('E_CONFLICT', '引擎未能为上下文恢复创建新的原生会话。')
      }
      const previousRunId = existing
        ? this.ports.projections.latestSettledNativeRunId(threadId, existing.native_thread_id, existing.instance_id)
        : null
      return {
        nativeThreadId: replacementId,
        recoveredFrom: existing ? {
          instance_id: existing.instance_id,
          native_thread_id: existing.native_thread_id,
          configuration_fingerprint: existing.configuration_fingerprint,
          previous_run_id: previousRunId,
        } : undefined,
      }
    }

    if (decision.type === 'create_with_handoff' && decision.mode === 'resume_unsupported_fallback') {
      return startRecoveredThread(new Error('Driver does not support native resumeThread.'))
    }

    try {
      const nativeThreadId = decision.type === 'resume_existing' && driver.resumeThread
        ? await runBounded(
          driver.resumeThread({ nativeThreadId: decision.nativeThreadId, cwd, model, ...(artifactMcp ? { artifactMcp } : {}) }),
          this.ports.deadlines.thread,
          '恢复原生会话',
          this.ports.shutdownSignal,
        )
        : await runBounded(driver.startThread(model, cwd, artifactMcp, runtimeMode), this.ports.deadlines.thread, '建立原生会话', this.ports.shutdownSignal)
      if (!nativeThreadId || (decision.type === 'resume_existing' && nativeThreadId !== decision.nativeThreadId)) {
        this.ports.sessions.uncertainDrivers.add(driver)
        throw new DaemonError('E_CONFLICT', '引擎没有确认原生会话身份。')
      }
      return { nativeThreadId }
    } catch (error) {
      if (decision.type === 'resume_existing' && decision.allowDeterministicFallback && this.canFallbackFromResumeFailure(error)) {
        return startRecoveredThread(error)
      }
      if (error instanceof ConversationDeadlineError) this.ports.sessions.uncertainDrivers.add(driver)
      throw error
    }
  }
}
