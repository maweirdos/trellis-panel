import type { AcpRuntimeEvent, AcpRuntimeTurn, AcpRuntimeTurnResult, AcpPermissionDecision, AcpRuntimeHandle } from '../acp/v2'

export type { AcpRuntimeEvent, AcpRuntimeTurn, AcpRuntimeTurnResult, AcpPermissionDecision, AcpRuntimeHandle }

export type ConversationRuntimePermissionRequest = {
  readonly sessionId: string
  readonly raw: {
    readonly sessionId: string
    readonly toolCall: {
      readonly toolCallId: string
      readonly title?: string
      readonly kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'think' | 'switch_mode' | 'other'
      readonly rawInput?: unknown
    }
    readonly options: ReadonlyArray<{ readonly optionId: string; readonly name: string; readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }>
    readonly _meta?: Record<string, unknown>
  }
  readonly inferredKind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'think' | 'switch_mode' | 'other'
}

export type ConversationRuntime = {
  ensureSession(input: { sessionKey: string; agent?: string; cwd?: string; mode?: 'persistent' | 'ephemeral'; resumeSessionId?: string; nativeRecordId?: string; sessionOptions?: Record<string, unknown> }): Promise<AcpRuntimeHandle>
  findSession(input: { sessionKey: string; agent?: string }): Promise<AcpRuntimeHandle | undefined>
  connectSession(input: { handle: AcpRuntimeHandle; assertActive?(): void }): Promise<void>
  startTurn(input: {
    handle: AcpRuntimeHandle
    requestId: string
    text: string
    context?: Array<{ uri: string; mimeType?: string; text: string }>
    attachments?: Array<{ data: string; mediaType: string }>
    timeoutMs?: number
    assertActive?(): void
    onPermissionRequest?(request: ConversationRuntimePermissionRequest, context: { signal: AbortSignal }): Promise<AcpPermissionDecision | undefined>
  }): AcpRuntimeTurn
  getCapabilities(): Promise<{ controls: string[]; configOptionKeys?: string[] }>
  getStatus(input?: { handle?: AcpRuntimeHandle }): Promise<{ summary?: string; models?: { availableModelIds: string[] }; usage?: Record<string, unknown>; details?: Record<string, unknown>; availableCommands?: Array<{ name: string; description?: string; hasInput?: boolean }> }>
  setModel(input: { handle: AcpRuntimeHandle; model: string; assertActive?(): void }): Promise<void>
  setMode(input: { handle: AcpRuntimeHandle; mode: string; assertActive?(): void }): Promise<void>
  setConfigOption(input: { handle: AcpRuntimeHandle; key: string; value: string; assertActive?(): void }): Promise<void>
  confirmClosed?(): Promise<void>
  shutdown(): Promise<void>
}

export type ConversationRuntimeHandle = AcpRuntimeHandle
export type ConversationRuntimeStatus = Awaited<ReturnType<ConversationRuntime['getStatus']>>
