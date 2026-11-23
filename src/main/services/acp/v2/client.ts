import {
  AGENT_METHODS,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk/experimental/v2'
import type {
  AgentCapabilities,
  CancelSessionNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  DisableProviderRequest,
  DisableProviderResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListProvidersRequest,
  ListProvidersResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoginAuthRequest,
  LoginAuthResponse,
  LogoutAuthRequest,
  LogoutAuthResponse,
  MessageMcpRequest,
  MessageMcpResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionId,
  SetProviderRequest,
  SetProviderResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk/experimental/v2'

import {
  ACP_V2_METHODS,
  initializeResultSchema,
  operationSchemas,
  type AcpVersionedInitialize,
} from './contract'
import { AcpProtocolError, incompatibleVersionError, invalidInitializeError } from './errors'
import { AcpJsonRpcWire, routeClientWire, type WireClientRouter, type WireLimits } from './wire'

export type AcpV2ClientHandlers = WireClientRouter & {
  readonly onProtocolError?: (error: AcpProtocolError) => void
}

export class AcpV2Client {
  private initialization: AcpVersionedInitialize | undefined

  constructor(
    private readonly wire: AcpJsonRpcWire,
    private readonly handlers: AcpV2ClientHandlers = {},
  ) {
    routeClientWire(wire, handlers)
    wire.onClose((error) => handlers.onProtocolError?.(error))
  }

  static connect(
    stream: { readonly input: NodeJS.ReadableStream; readonly output: NodeJS.WritableStream },
    handlers: AcpV2ClientHandlers = {},
    limits?: WireLimits,
  ): AcpV2Client {
    return new AcpV2Client(new AcpJsonRpcWire(stream, limits), handlers)
  }

  async initialize(clientInfo: InitializeRequest['info'], clientCapabilities: InitializeRequest['capabilities']): Promise<AcpVersionedInitialize> {
    if (this.initialization !== undefined) throw new AcpProtocolError('E_PROTOCOL', 'ACP v2 connection is already initialized')
    const request: InitializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      info: clientInfo,
      capabilities: clientCapabilities,
    }
    const rawResult = await this.wire.request<unknown>({ method: AGENT_METHODS.initialize, params: request })
    const parsed = initializeResultSchema.safeParse(rawResult)
    const returnedVersion = readReturnedVersion(rawResult)
    if (!parsed.success) {
      const error = invalidInitializeError(returnedVersion, parsed.error)
      this.wire.close(error)
      throw error
    }
    if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
      const error = incompatibleVersionError(PROTOCOL_VERSION, parsed.data.protocolVersion)
      this.wire.close(error)
      throw error
    }
    const response = parsed.data as InitializeResponse
    const negotiatedCapabilities = response.capabilities
    if (negotiatedCapabilities === undefined) throw invalidInitializeError(response.protocolVersion)
    this.initialization = {
      request,
      response,
      requestedVersion: PROTOCOL_VERSION,
      returnedVersion: response.protocolVersion,
      capabilities: negotiatedCapabilities,
    }
    return this.initialization as AcpVersionedInitialize
  }

  get initialized(): AcpVersionedInitialize {
    if (this.initialization === undefined) throw new AcpProtocolError('E_PROTOCOL', 'ACP v2 connection is not initialized')
    return this.initialization
  }

  login(params: LoginAuthRequest): Promise<LoginAuthResponse | undefined> {
    return this.operation('E_AUTH', params, async () => {
      if (!this.hasAuthMethod()) throw unsupported(ACP_V2_METHODS.authLogin)
      return this.call<LoginAuthResponse | undefined>(ACP_V2_METHODS.authLogin, params)
    })
  }

  logout(params: LogoutAuthRequest): Promise<LogoutAuthResponse | undefined> {
    return this.operation('E_AUTH', params, async () => {
      if (!this.hasAuthMethod()) throw unsupported(ACP_V2_METHODS.authLogout)
      return this.call<LogoutAuthResponse | undefined>(ACP_V2_METHODS.authLogout, params)
    })
  }

  listProviders(params: ListProvidersRequest = {}): Promise<ListProvidersResponse> {
    return this.operation('E_PROVIDER', params, async () => {
      if (!this.supportsProviders()) throw unsupported(ACP_V2_METHODS.providersList)
      return this.call<ListProvidersResponse>(ACP_V2_METHODS.providersList, params)
    })
  }

  setProvider(params: SetProviderRequest): Promise<SetProviderResponse | undefined> {
    return this.operation('E_PROVIDER', params, async () => {
      if (!this.supportsProviders()) throw unsupported(ACP_V2_METHODS.providersSet)
      return this.call<SetProviderResponse | undefined>(ACP_V2_METHODS.providersSet, params)
    })
  }

  disableProvider(params: DisableProviderRequest): Promise<DisableProviderResponse | undefined> {
    return this.operation('E_PROVIDER', params, async () => {
      if (!this.supportsProviders()) throw unsupported(ACP_V2_METHODS.providersDisable)
      return this.call<DisableProviderResponse | undefined>(ACP_V2_METHODS.providersDisable, params)
    })
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return this.operation('E_SESSION', params, async () => {
      if (!this.supportsSessionBaseline()) throw unsupported(ACP_V2_METHODS.sessionNew)
      return this.call<NewSessionResponse>(ACP_V2_METHODS.sessionNew, params)
    })
  }

  listSessions(params: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    return this.operation('E_SESSION', params, async () => {
      if (this.initialization?.capabilities.session == null) throw unsupported(ACP_V2_METHODS.sessionList)
      return this.call<ListSessionsResponse>(ACP_V2_METHODS.sessionList, params)
    })
  }

  deleteSession(params: { readonly sessionId: SessionId }): Promise<void> {
    return this.operation('E_SESSION', params, async () => {
      if (!this.supportsDelete()) throw unsupported(ACP_V2_METHODS.sessionDelete)
      await this.call<unknown>(ACP_V2_METHODS.sessionDelete, params)
    })
  }

  forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    return this.operation('E_SESSION', params, async () => {
      if (!this.supportsFork()) throw unsupported(ACP_V2_METHODS.sessionFork)
      return this.call<ForkSessionResponse>(ACP_V2_METHODS.sessionFork, params)
    })
  }

  resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return this.operation('E_SESSION', params, async () => {
      if (this.initialization?.capabilities.session == null) throw unsupported(ACP_V2_METHODS.sessionResume)
      return this.call<ResumeSessionResponse>(ACP_V2_METHODS.sessionResume, params)
    })
  }

  closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse | undefined> {
    return this.operation('E_SESSION', params, async () => {
      if (this.initialization?.capabilities.session == null) throw unsupported(ACP_V2_METHODS.sessionClose)
      return this.call<CloseSessionResponse | undefined>(ACP_V2_METHODS.sessionClose, params)
    })
  }

  setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    return this.operation('E_SESSION', params, async () => {
      if (!this.supportsSessionBaseline()) throw unsupported(ACP_V2_METHODS.sessionSetConfigOption)
      return this.call<SetSessionConfigOptionResponse>(ACP_V2_METHODS.sessionSetConfigOption, params)
    })
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.operation('E_SESSION', params, async () => {
      if (!this.supportsSessionBaseline()) throw unsupported(ACP_V2_METHODS.sessionPrompt)
      return this.call<PromptResponse>(ACP_V2_METHODS.sessionPrompt, params)
    })
  }

  mcpMessage(params: MessageMcpRequest): Promise<MessageMcpResponse> {
    return this.operation('E_MCP', params, async () => {
      if (!this.supportsSessionBaseline()) throw unsupported(ACP_V2_METHODS.mcpMessage)
      return this.call<MessageMcpResponse>(ACP_V2_METHODS.mcpMessage, params)
    })
  }

  async cancelSession(params: CancelSessionNotification): Promise<void> {
    if (this.initialization === undefined) throw new AcpProtocolError('E_PROTOCOL', 'ACP session cancel call before initialization')
    if (!this.supportsSessionBaseline()) throw unsupported(ACP_V2_METHODS.sessionCancel)
    await this.wire.notify(ACP_V2_METHODS.sessionCancel, params)
  }

  cancel(method: string, requestId?: string | number): void {
    this.wire.cancel(method, requestId)
  }

  close(): void {
    this.wire.close()
  }

  private supportsSessionBaseline(): boolean {
    return this.initialization?.capabilities.session != null
  }

  private async call<T>(method: keyof typeof operationSchemas, params: unknown): Promise<T> {
    const schemas = operationSchemas[method]
    const parsedParams = schemas.params.safeParse(params)
    if (!parsedParams.success) throw new AcpProtocolError('E_PROTOCOL', `ACP v2 request is invalid: ${String(method)}`, { method: String(method), cause: parsedParams.error })
    const rawResult = await this.wire.request<unknown>({ method: String(method), params })
    const parsedResult = schemas.result.safeParse(rawResult)
    if (!parsedResult.success) throw new AcpProtocolError('E_PROTOCOL', `ACP v2 response is invalid: ${String(method)}`, { method: String(method), cause: parsedResult.error })
    return parsedResult.data as T
  }

  private supportsProviders(): boolean {
    return this.initialization?.capabilities.providers !== undefined && this.initialization.capabilities.providers !== null
  }

  private supportsDelete(): boolean {
    return this.supportsSessionBaseline() && this.initialization?.capabilities.session?.delete != null
  }

  private supportsFork(): boolean {
    return this.supportsSessionBaseline() && this.initialization?.capabilities.session?.fork != null
  }

  private hasAuthMethod(): boolean {
    const authMethods = this.initialization?.response.authMethods
    return authMethods !== undefined && authMethods.length > 0
  }

  private async operation<TParams, TResult>(category: string, params: TParams, run: () => Promise<TResult>): Promise<TResult> {
    this.assertNotUninitialized(category, params)
    return run()
  }

  private assertNotUninitialized(category: string, params: unknown): void {
    if (this.initialization === undefined) {
      throw new AcpProtocolError('E_PROTOCOL', `ACP ${category} call before initialization`, {
        method: category,
        cause: params,
      })
    }
  }
}

const unsupported = (method: string): AcpProtocolError =>
  new AcpProtocolError('E_UNSUPPORTED_CAPABILITY', `ACP v2 capability is unavailable: ${method}`, { method })

const readReturnedVersion = (result: unknown): number | null => {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null
  const version = (result as { readonly protocolVersion?: unknown }).protocolVersion
  return typeof version === 'number' && Number.isInteger(version) ? version : null
}
