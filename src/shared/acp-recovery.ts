/** Explicit same-session recovery contracts. Values are candidates until acpx acknowledges them. */
export interface AcpRecoverModelInput {
  /** Exact model ID previously advertised/acknowledged by this session. */
  modelId: string
  /** Connection generation visible when the recovery affordance was rendered. */
  expectedConnectionGeneration: string
}

export type AcpRecoveryKind = 'model-unavailable' | 'connection-failed'

/** Non-secret presentation state for a failed recovery attempt. */
export interface AcpRecoveryState {
  kind: AcpRecoveryKind
  /** True only after runtime.setModel acknowledged the requested exact ID. */
  modelConfirmed?: boolean
  confirmedModelId?: string
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
