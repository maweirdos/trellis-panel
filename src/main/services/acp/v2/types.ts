import type {
  CloseSessionRequest,
  DisableProviderRequest,
  ForkSessionRequest,
  ListProvidersRequest,
  ListSessionsRequest,
  LoginAuthRequest,
  LogoutAuthRequest,
  McpServer,
  PromptRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionId,
  SetSessionConfigOptionResponse,
  SetProviderRequest,
} from '@agentclientprotocol/sdk/experimental/v2'

export type AcpV2PermissionDecision = RequestPermissionResponse

export type AcpV2PermissionHandler = (
  request: RequestPermissionRequest,
  context: { signal: AbortSignal },
) => Promise<AcpV2PermissionDecision | undefined>

export interface AcpV2RuntimeHandle {
  readonly sessionKey: string
  readonly backend: 'acp-v2'
  readonly runtimeSessionName: string
  readonly cwd: string
  readonly nativeRecordId: string
  readonly backendSessionId: string
  readonly agentSessionId?: string
  readonly replayCursor?: string
}

export type AcpRuntimeHandle = AcpV2RuntimeHandle
export type AcpRuntimeTurn = AcpV2Turn
export type AcpRuntimeTurnResult = AcpV2TurnResult
export type AcpRuntimeEvent = AcpV2RuntimeEvent
export type AcpPermissionDecision = AcpV2PermissionDecision
export interface AcpProcessLaunch {
  readonly launchId: string
  readonly purpose: 'agent' | 'command-probe'
  readonly scope: Readonly<{ kind: 'runtime-session'; sessionKey: string } | { kind: 'runtime-probe'; agent: string }>
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}
export interface AcpProcessStarted extends AcpProcessLaunch { readonly pid: number; readonly startedAt: string }

export type AcpV2PromptContent = PromptRequest['prompt'][number]
export type AcpV2SessionConfigOption = SessionConfigOption
export type AcpV2SetConfigOptionResponse = SetSessionConfigOptionResponse
export type AcpV2ListSessionsRequest = ListSessionsRequest
export type AcpV2ListSessionsResponse = Awaited<ReturnType<AcpV2RuntimeOperations['listSessions']>>
export type AcpV2ForkRequest = ForkSessionRequest
export type AcpV2CloseRequest = CloseSessionRequest
export type AcpV2LoginRequest = LoginAuthRequest
export type AcpV2LogoutRequest = LogoutAuthRequest
export type AcpV2ProvidersRequest = ListProvidersRequest
export type AcpV2McpServer = McpServer

export type AcpV2RuntimeEvent =
  | { type: 'text_delta'; text: string; stream?: 'output' | 'thought'; tag?: string; messageId?: string; meta?: { origin?: string; kind?: string; source?: string } }
  | { type: 'status'; text: string; tag?: string; availableCommands?: Array<{ name: string; description?: string; hasInput?: boolean }> }
  | { type: 'tool_call'; text: string; tag?: string; toolCallId?: string; status?: string; title?: string; kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'think' | 'switch_mode' | 'other'; rawInput?: unknown; rawOutput?: unknown; content?: import('@agentclientprotocol/sdk').ToolCallContent[] }
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason?: string; _meta?: Record<string, unknown> | null }

export type AcpV2TurnResult =
  | { status: 'completed'; stopReason?: string }
  | { status: 'cancelled'; stopReason?: string }
  | { status: 'failed'; error: { message: string; code?: string; retryable?: boolean } }

export interface AcpV2Turn {
  readonly requestId: string
  readonly promptStarted: Promise<void>
  readonly events: AsyncIterable<AcpV2RuntimeEvent>
  readonly result: Promise<AcpV2TurnResult>
  cancel(input?: { reason?: string }): Promise<void>
  closeStream(input?: { reason?: string }): Promise<void>
}

export interface AcpV2RuntimeOperations {
  listSessions(params?: AcpV2ListSessionsRequest): Promise<{ sessions: Array<{ sessionId: SessionId; cwd: string; title?: string | null; updatedAt?: string | null }>; nextCursor?: string | null }>
  deleteSession(params: { sessionId: SessionId }): Promise<void>
  forkSession(params: AcpV2ForkRequest): Promise<{ sessionId: SessionId; configOptions?: AcpV2SessionConfigOption[] }>
  closeSession(params: AcpV2CloseRequest): Promise<unknown>
  login(params: AcpV2LoginRequest): Promise<unknown>
  logout(params: AcpV2LogoutRequest): Promise<unknown>
  listProviders(params?: AcpV2ProvidersRequest): Promise<unknown>
  setProvider(params: SetProviderRequest): Promise<unknown>
  disableProvider(params: DisableProviderRequest): Promise<unknown>
  requestPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse | undefined>
}

export interface AcpV2Runtime {
  ensureSession(input: { sessionKey: string; cwd: string; resumeSessionId?: string; nativeRecordId?: string }): Promise<AcpV2RuntimeHandle>
  connectSession(input: { handle: AcpV2RuntimeHandle; assertActive?(): void }): Promise<void>
  startTurn(input: { handle: AcpV2RuntimeHandle; prompt: AcpV2PromptContent[]; requestId: string; timeoutMs?: number; assertActive?(): void; onPermissionRequest?: AcpV2PermissionHandler }): AcpV2Turn
  setConfigOption(input: { handle: AcpV2RuntimeHandle; configId: string; value: string }): Promise<AcpV2SetConfigOptionResponse>
  getCapabilities(): { controls: string[]; promptCapabilities: { image: boolean; embeddedContext: boolean }; supportsList: boolean; supportsDelete: boolean; supportsFork: boolean; supportsResume: boolean; supportsAuth: boolean; supportsProviders: boolean }
  getStatus(input?: { handle?: AcpV2RuntimeHandle }): { configOptions: AcpV2SessionConfigOption[]; commands: Array<{ name: string; description?: string; input?: unknown }> }
  listSessions(params?: AcpV2ListSessionsRequest): Promise<{ sessions: Array<{ sessionId: SessionId; cwd: string; title?: string | null; updatedAt?: string | null }>; nextCursor?: string | null }>
  deleteSession(params: { sessionId: SessionId }): Promise<void>
  forkSession(params: AcpV2ForkRequest): Promise<{ sessionId: SessionId; configOptions?: AcpV2SessionConfigOption[] }>
  closeSession(params: AcpV2CloseRequest): Promise<unknown>
  login(params: AcpV2LoginRequest): Promise<unknown>
  logout(params: AcpV2LogoutRequest): Promise<unknown>
  listProviders(params?: AcpV2ProvidersRequest): Promise<unknown>
  setProvider(params: SetProviderRequest): Promise<unknown>
  disableProvider(params: DisableProviderRequest): Promise<unknown>
  confirmClosed(): Promise<void>
  shutdown(): Promise<void>
}
