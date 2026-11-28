/**
 * 纯函数会话切换策略决策器（M4.1）：
 * 集中裁决原生线程复用、断点恢复、自动恢复式接力、跨账号确认与明确拒绝，
 * 避免多个位置各自做指纹校验与分支判断造成状态机冲突。
 */
export type ProviderSessionTransitionDecision =
  | { readonly type: 'reuse'; readonly nativeThreadId: string }
  | { readonly type: 'resume_existing'; readonly nativeThreadId: string; readonly allowDeterministicFallback: boolean }
  | { readonly type: 'create_fresh' }
  | { readonly type: 'create_with_handoff'; readonly mode: 'explicit_handoff' | 'resume_unsupported_fallback' }
  | { readonly type: 'require_handoff_confirm'; readonly reason: string }
  | { readonly type: 'reject'; readonly code: 'E_UNAVAILABLE' | 'E_CONFLICT'; readonly reason: string }

export interface ProviderSessionTransitionInput {
  readonly driverAvailable: boolean
  readonly isHandoffCommand: boolean
  readonly targetInstanceId: string
  readonly targetBindingFingerprint: string
  readonly driverSupportsResume: boolean
  readonly allowResumeFallback: boolean
  readonly storedBinding?: {
    readonly instanceId: string
    readonly nativeThreadId: string
    readonly configurationFingerprint: string | null
  }
  readonly loadedHandle?: {
    readonly matchesTargetDriver: boolean
    readonly nativeThreadId: string
  }
  readonly fingerprintMatches: (stored: string | null | undefined, expected: string) => boolean
}

export function decideProviderSessionTransition(input: ProviderSessionTransitionInput): ProviderSessionTransitionDecision {
  if (!input.driverAvailable) {
    return { type: 'reject', code: 'E_UNAVAILABLE', reason: '目标引擎实例当前不可用。' }
  }
  if (input.isHandoffCommand) {
    return { type: 'create_with_handoff', mode: 'explicit_handoff' }
  }
  if (input.storedBinding) {
    if (input.storedBinding.instanceId !== input.targetInstanceId) {
      return { type: 'reject', code: 'E_UNAVAILABLE', reason: '当前引擎无法按原身份接回此对话。' }
    }
    if (
      input.storedBinding.configurationFingerprint
      && !input.fingerprintMatches(input.storedBinding.configurationFingerprint, input.targetBindingFingerprint)
    ) {
      return { type: 'require_handoff_confirm', reason: '此对话属于原引擎账号或配置，请恢复原配置后继续。' }
    }
    if (input.loadedHandle?.matchesTargetDriver && input.loadedHandle.nativeThreadId === input.storedBinding.nativeThreadId) {
      return { type: 'reuse', nativeThreadId: input.loadedHandle.nativeThreadId }
    }
    if (!input.driverSupportsResume) {
      if (input.allowResumeFallback) {
        return { type: 'create_with_handoff', mode: 'resume_unsupported_fallback' }
      }
      return { type: 'reject', code: 'E_UNAVAILABLE', reason: '当前引擎无法按原身份接回此对话。' }
    }
    return {
      type: 'resume_existing',
      nativeThreadId: input.storedBinding.nativeThreadId,
      allowDeterministicFallback: input.allowResumeFallback,
    }
  }
  if (input.loadedHandle?.matchesTargetDriver) {
    return { type: 'reuse', nativeThreadId: input.loadedHandle.nativeThreadId }
  }
  return { type: 'create_fresh' }
}
