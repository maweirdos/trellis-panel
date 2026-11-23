/** Explicit same-session recovery contracts. Values are candidates until the agent acknowledges them. */
export interface AcpRecoverModelInput {
  /** Exact model ID previously advertised/acknowledged by this session. */
  modelId: string
  /** Connection generation visible when the recovery affordance was rendered. */
  expectedConnectionGeneration: string
}

export type AcpRecoveryKind = 'model-unavailable' | 'connection-failed'
export const ACP_RECOVERY_COMMIT_PENDING_MESSAGE = '原会话恢复记录尚未完全确认，请检查存储后重试原会话'

/** Non-secret presentation state for a failed recovery attempt. */
export interface AcpRecoveryState {
  kind: AcpRecoveryKind
  /** True only after runtime.setModel acknowledged the requested exact ID. */
  modelConfirmed?: boolean
  confirmedModelId?: string
  /** A native-record change and the Panel snapshot may need same-session reconciliation. */
  commitPending?: boolean
}

export type AcpRecoverModelResult = {
  ok: true
  sessionId: string
  modelConfirmed: boolean
  session: import('./types').AcpSessionRecord
} | (import('./ipc-errors').IpcFail & {
  modelConfirmed?: boolean
  session?: import('./types').AcpSessionRecord
})
