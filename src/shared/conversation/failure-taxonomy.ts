/**
 * 对话失败的统一强类型分类与面向用户的呈现映射。
 * 后端落库与恢复策略、前端错误卡片与操作按钮共同消费本模块，避免正则猜测或文案与按钮割裂。
 */

export type ConversationFailureClass =
  | 'account_or_config_mismatch'
  | 'session_not_found'
  | 'session_in_use'
  | 'usage_limit'
  | 'auth_required'
  | 'context_window_exceeded'
  | 'transient_network'
  | 'cancelled'
  | 'unknown_outcome'
  | 'generic'

export interface ConversationFailureClassification {
  readonly failureClass: ConversationFailureClass
  readonly retryAfterMs?: number
  readonly canAutoRecoverResume: boolean
}

export interface FailedRunIssuePresentation {
  readonly title: string
  readonly reason: string
  readonly uncertain: boolean
  readonly actionKind: 'handoff' | 'retry' | 'refresh' | 'none'
  readonly actionLabel?: string
}

const UNSAFE_RESUME_DAEMON_CODES = new Set(['E_BUSY', 'E_DENIED', 'E_UNKNOWN', 'E_CONFLICT'])

const ACCOUNT_OR_CONFIG_MISMATCH_PATTERN =
  /此对话属于原引擎账号或配置|原配置已变化|原引擎配置指纹已变化|configuration fingerprint/i
const SESSION_IN_USE_PATTERN =
  /is closing|in use|already loaded|\bbusy\b|timed out|timeout|aborted|尚未确认完成|仍在运行/i
const USAGE_LIMIT_PATTERN =
  /rate[\s_-]?limit|usage[\s_-]?limit|too many requests|\b429\b|quota exceeded|try again in|限流|额度/i
const AUTH_REQUIRED_PATTERN =
  /unauthorized|unauthenticated|invalid api key|authentication failed|login required|token expired|\b401\b|\b403\b|未登录|凭据已失效|鉴权/i
const CONTEXT_WINDOW_PATTERN =
  /context[\s_-]?length|context[\s_-]?window|too many tokens|maximum context|prompt is too long|上下文.*超|超出上下文/i
const SESSION_NOT_FOUND_PATTERN =
  /not found|no conversation found|no such thread|missing thread|unknown thread|cannot resume|session.*expired|无法恢复原会话|原生会话.*不存在/i
const TRANSIENT_NETWORK_PATTERN =
  /econnreset|econnrefused|etimedout|socket hang up|fetch failed|network error|\b502\b|\b503\b|\b504\b|网络/i
const CANCELLED_PATTERN = /cancelled|canceled|interrupted|用户停止|已停止|已取消/i

export function parseRetryAfterMs(message: string): number | undefined {
  const secMatch = /(?:retry(?:\s+after)?|try again in|wait)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds|秒)/i.exec(message)
  if (secMatch) {
    const ms = Math.round(Number(secMatch[1]) * 1_000)
    return Number.isFinite(ms) && ms > 0 ? ms : undefined
  }
  const minMatch = /(?:retry(?:\s+after)?|try again in|wait)\s+(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes|分钟)/i.exec(message)
  if (minMatch) {
    const ms = Math.round(Number(minMatch[1]) * 60_000)
    return Number.isFinite(ms) && ms > 0 ? ms : undefined
  }
  return undefined
}

export function extractFailureMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return error == null ? '' : String(error)
}

export function extractFailureCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return undefined
}

export function classifyConversationFailure(input: {
  readonly error?: unknown
  readonly message?: string
  readonly code?: string
  readonly outcomeUnknown?: boolean
  readonly isDeadlineError?: boolean
}): ConversationFailureClassification {
  if (input.outcomeUnknown) {
    return { failureClass: 'unknown_outcome', canAutoRecoverResume: false }
  }
  const code = input.code ?? extractFailureCode(input.error)
  const message = input.message ?? extractFailureMessage(input.error)
  if (input.isDeadlineError) {
    return { failureClass: 'session_in_use', canAutoRecoverResume: false }
  }
  if (ACCOUNT_OR_CONFIG_MISMATCH_PATTERN.test(message)) {
    return { failureClass: 'account_or_config_mismatch', canAutoRecoverResume: false }
  }
  if (code === 'E_BUSY' || code === 'E_UNKNOWN' || SESSION_IN_USE_PATTERN.test(message)) {
    return { failureClass: 'session_in_use', canAutoRecoverResume: false }
  }
  if (USAGE_LIMIT_PATTERN.test(message)) {
    const retryAfterMs = parseRetryAfterMs(message)
    return { failureClass: 'usage_limit', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), canAutoRecoverResume: false }
  }
  if (code === 'E_DENIED' || AUTH_REQUIRED_PATTERN.test(message)) {
    return { failureClass: 'auth_required', canAutoRecoverResume: false }
  }
  if (CONTEXT_WINDOW_PATTERN.test(message)) {
    return { failureClass: 'context_window_exceeded', canAutoRecoverResume: false }
  }
  if (SESSION_NOT_FOUND_PATTERN.test(message)) {
    return { failureClass: 'session_not_found', canAutoRecoverResume: !UNSAFE_RESUME_DAEMON_CODES.has(code ?? '') }
  }
  if (TRANSIENT_NETWORK_PATTERN.test(message)) {
    return { failureClass: 'transient_network', canAutoRecoverResume: false }
  }
  if (CANCELLED_PATTERN.test(message)) {
    return { failureClass: 'cancelled', canAutoRecoverResume: false }
  }
  return { failureClass: 'generic', canAutoRecoverResume: !UNSAFE_RESUME_DAEMON_CODES.has(code ?? '') }
}

export function presentFailedRunIssue(input: {
  readonly modelLabel: string
  readonly failure?: string
  readonly failureClass?: ConversationFailureClass
  readonly outcomeUnknown?: boolean
  readonly canHandoff: boolean
  readonly canRetry: boolean
}): FailedRunIssuePresentation {
  if (input.outcomeUnknown) {
    return {
      title: `${input.modelLabel} 的送达或回复结果待核对`,
      reason: input.failure?.trim() || '引擎派发或本地结算结果待核对，请刷新核对后再操作。',
      uncertain: true,
      actionKind: 'refresh',
      actionLabel: '刷新结果',
    }
  }
  const failureClass = input.failureClass ?? classifyConversationFailure({ message: input.failure }).failureClass
  const rawReason = input.failure?.trim() || '引擎未能完成本轮执行。'
  if (failureClass === 'account_or_config_mismatch') {
    if (input.canHandoff) {
      return {
        title: `${input.modelLabel} 账号或配置已变化`,
        reason: '当前引擎账号或配置与原会话不同，可使用当前配置带入历史上下文原地继续。',
        uncertain: false,
        actionKind: 'handoff',
        actionLabel: '用当前配置接力继续',
      }
    }
    return {
      title: `${input.modelLabel} 账号或配置已变化`,
      reason: '此对话绑定了原引擎账号或配置，请恢复原配置后继续。',
      uncertain: false,
      actionKind: 'none',
    }
  }
  if (failureClass === 'context_window_exceeded' && input.canHandoff) {
    return {
      title: `${input.modelLabel} 上下文已满`,
      reason: '当前原生上下文长度超出模型上限，可新建原生线程并带入近期历史继续。',
      uncertain: false,
      actionKind: 'handoff',
      actionLabel: '带历史新建线程继续',
    }
  }
  if (failureClass === 'usage_limit') {
    return {
      title: `${input.modelLabel} 触发限流`,
      reason: rawReason,
      uncertain: false,
      actionKind: input.canRetry ? 'retry' : 'none',
      ...(input.canRetry ? { actionLabel: '重试' } : {}),
    }
  }
  if (failureClass === 'auth_required') {
    return {
      title: `${input.modelLabel} 鉴权失败`,
      reason: rawReason,
      uncertain: false,
      actionKind: input.canRetry ? 'retry' : 'none',
      ...(input.canRetry ? { actionLabel: '重试' } : {}),
    }
  }
  return {
    title: `${input.modelLabel} 执行失败`,
    reason: rawReason,
    uncertain: false,
    actionKind: input.canRetry ? 'retry' : 'none',
    ...(input.canRetry ? { actionLabel: '重试' } : {}),
  }
}
