import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as PlatformError from 'effect/PlatformError'
import * as Scope from 'effect/Scope'
import * as Sink from 'effect/Sink'
import * as Stdio from 'effect/Stdio'
import * as Stream from 'effect/Stream'

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk/experimental/v2'
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
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionId,
  SetProviderRequest,
  SetProviderResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk/experimental/v2'

import { AcpClient as T3AcpClient, make as makeT3AcpClient, type AcpPromptOptions } from '../t3-core/client'
import type * as T3Schema from '../t3-core/compat'
import { AcpRequestError as T3AcpRequestError, AcpTransportError as T3AcpTransportError, type AcpError as T3AcpError } from '../t3-core/errors'
import type { InitializeResponse as T3V2InitializeResponse } from '../t3-core/_generated/schema.gen'
import {
  ACP_V2_METHODS,
  type AcpClientNotification,
  type AcpClientRequest,
  type AcpVersionedInitialize,
} from './contract'
import { AcpProtocolError, incompatibleVersionError, invalidInitializeError } from './errors'

type T3Service = T3AcpClient['Service']

const MAX_INBOUND_FRAME_BYTES = 1024 * 1024
const MAX_PENDING_REQUESTS = 64

/**
 * Per-method request budgets applied at this adapter boundary, following the
 * T3 `AcpSessionRuntime` policy rather than the vendored RPC core. Session
 * setup and lifecycle use T3's 90s load budget; control calls keep the 30s
 * the previous hand-written wire used; cancel keeps T3's 15s. `session/prompt`
 * deliberately has no entry: it legitimately waits for idle completion and is
 * bounded by the turn-level guard in the runtime instead.
 */
export interface AcpV2TimeoutPolicy {
  readonly initializeMs: number
  readonly sessionMs: number
  readonly controlMs: number
  readonly cancelMs: number
}

export const ACP_V2_DEFAULT_TIMEOUTS: AcpV2TimeoutPolicy = {
  initializeMs: 30_000,
  sessionMs: 90_000,
  controlMs: 30_000,
  cancelMs: 15_000,
}

const SESSION_METHODS: ReadonlySet<string> = new Set([
  ACP_V2_METHODS.sessionNew,
  ACP_V2_METHODS.sessionResume,
  ACP_V2_METHODS.sessionList,
  ACP_V2_METHODS.sessionDelete,
  ACP_V2_METHODS.sessionFork,
  ACP_V2_METHODS.sessionClose,
])

const CONTROL_METHODS: ReadonlySet<string> = new Set([
  ACP_V2_METHODS.sessionSetConfigOption,
  ACP_V2_METHODS.providersList,
  ACP_V2_METHODS.providersSet,
  ACP_V2_METHODS.providersDisable,
  ACP_V2_METHODS.authLogin,
  ACP_V2_METHODS.authLogout,
  ACP_V2_METHODS.mcpMessage,
])

const timeoutMsFor = (method: string, policy: AcpV2TimeoutPolicy): number | undefined =>
  SESSION_METHODS.has(method) ? policy.sessionMs
    : CONTROL_METHODS.has(method) ? policy.controlMs
      : method === ACP_V2_METHODS.sessionCancel ? policy.cancelMs
        : undefined

export interface AcpV2ClientHandlers {
  readonly onNotification?: (notification: AcpClientNotification) => void
  readonly onRequest?: (request: AcpClientRequest) => Promise<unknown>
  readonly onProtocolError?: (error: AcpProtocolError) => void
}

/**
 * Promise facade over the vendored T3 `effect-acp` client. T3 owns framing,
 * schema validation, RPC correlation, prompt-insertion acknowledgement and
 * idle completion; this adapter only maps the app's SDK types and errors.
 */
export class AcpV2Client {
  private initialization: AcpVersionedInitialize | undefined
  private readonly scope = Scope.makeUnsafe()
  private acp: T3Service | undefined
  private readonly timeouts: AcpV2TimeoutPolicy
  private pendingRequests = 0

  private constructor(private readonly handlers: AcpV2ClientHandlers, timeouts: AcpV2TimeoutPolicy) {
    this.timeouts = timeouts
  }

  static async connect(
    stream: { readonly input: NodeJS.ReadableStream; readonly output: NodeJS.WritableStream },
    handlers: AcpV2ClientHandlers = {},
    timeouts: Partial<AcpV2TimeoutPolicy> = {},
  ): Promise<AcpV2Client> {
    const client = new AcpV2Client(handlers, { ...ACP_V2_DEFAULT_TIMEOUTS, ...timeouts })
    let frameBytes = 0
    const stdio = Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromAsyncIterable(
        stream.input as AsyncIterable<Uint8Array>,
        cause => PlatformError.systemError({
          _tag: 'PermissionDenied',
          module: 'ACP',
          method: 'read-stdout',
          cause,
        }),
      ),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.promise(() => writeOutput(stream.output, chunk)),
        ),
      stderr: () => Sink.drain,
    })
    const acp = await Effect.runPromise(
      makeT3AcpClient({ ...stdio, stdin: stdio.stdin.pipe(Stream.mapEffect(chunk => {
        let offset = 0
        for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, offset)) {
          if (frameBytes + newline - offset > MAX_INBOUND_FRAME_BYTES) return Effect.fail(oversizeFrame())
          frameBytes = 0
          offset = newline + 1
        }
        frameBytes += chunk.byteLength - offset
        return frameBytes > MAX_INBOUND_FRAME_BYTES ? Effect.fail(oversizeFrame()) : Effect.succeed(chunk)
      })) }, {
        onTermination: (error: T3AcpError) => {
          handlers.onProtocolError?.(toProtocolError(error))
          return Effect.void
        },
      }).pipe(Effect.provideService(Scope.Scope, client.scope)),
    )
    client.acp = acp
    await Effect.runPromise(acp.handleSessionUpdate(notification => {
      handlers.onNotification?.({
        method: ACP_V2_METHODS.clientSessionUpdate,
        params: notification,
      })
      return Effect.void
    }))
    await Effect.runPromise(acp.handleRequestPermission((request, context) =>
      Effect.tryPromise({
        try: async () => {
          const response = await handlers.onRequest?.({
            method: ACP_V2_METHODS.clientRequestPermission,
            requestId: context.requestId,
            params: request as unknown as Extract<AcpClientRequest, { method: 'session/request_permission' }>['params'],
          })
          return (response ?? { outcome: { outcome: 'cancelled' } }) as never
        },
        catch: error =>
          new T3AcpRequestError({
            code: -32603,
            errorMessage: error instanceof Error ? error.message : String(error),
            operation: 'handle-request',
            cause: error,
          }),
      }),
    ))
    await Effect.runPromise(acp.handleElicitation((request, context) =>
      Effect.tryPromise({
        try: async () => {
          const response = await handlers.onRequest?.({
            method: ACP_V2_METHODS.clientCreateElicitation,
            requestId: context.requestId,
            params: request as unknown as Extract<AcpClientRequest, { method: 'elicitation/create' }>['params'],
          })
          return (response ?? { action: 'cancel' }) as never
        },
        catch: error =>
          new T3AcpRequestError({
            code: -32603,
            errorMessage: error instanceof Error ? error.message : String(error),
            operation: 'handle-request',
            cause: error,
          }),
      }),
    ))
    return client
  }

  async initialize(
    clientInfo: InitializeRequest['info'],
    clientCapabilities: InitializeRequest['capabilities'],
  ): Promise<AcpVersionedInitialize> {
    if (this.initialization !== undefined) throw new AcpProtocolError('E_PROTOCOL', 'ACP v2 connection is already initialized')
    const request: InitializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      info: clientInfo,
      capabilities: clientCapabilities,
    }
    let response: T3V2InitializeResponse | { readonly protocolVersion: number }
    try {
      response = await this.bounded(ACP_V2_METHODS.initialize, this.timeouts.initializeMs, this.requireT3().agent.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: clientInfo as never,
        clientCapabilities: clientCapabilities as never,
      }))
    } catch (error) {
      const typed = negotiateFailure(error)
      const failure = typed ?? toProtocolError(error)
      if (typed !== undefined || failure.type === 'E_TIMEOUT') await this.close().catch(() => undefined)
      throw failure
    }
    if (!('info' in response) || !('capabilities' in response)) {
      await this.close().catch(() => undefined)
      throw incompatibleVersionError(PROTOCOL_VERSION, response.protocolVersion)
    }
    const capabilities = (response.capabilities ?? {}) as AgentCapabilities
    this.initialization = {
      request,
      response: response as unknown as InitializeResponse,
      requestedVersion: PROTOCOL_VERSION,
      returnedVersion: PROTOCOL_VERSION,
      capabilities,
    }
    return this.initialization
  }

  get initialized(): AcpVersionedInitialize {
    if (this.initialization === undefined) throw new AcpProtocolError('E_PROTOCOL', 'ACP v2 connection is not initialized')
    return this.initialization
  }

  async login(params: LoginAuthRequest): Promise<LoginAuthResponse | undefined> {
    if (this.initialization && !this.initialized.response.authMethods?.some(method => method.methodId === params.methodId)) {
      throw unsupported(ACP_V2_METHODS.authLogin)
    }
    return this.operation(ACP_V2_METHODS.authLogin, () =>
      Effect.map(this.requireT3().agent.authenticate(params as never), response => response as unknown as LoginAuthResponse | undefined))
  }

  logout(params: LogoutAuthRequest): Promise<LogoutAuthResponse | undefined> {
    return this.operation(ACP_V2_METHODS.authLogout, () =>
      Effect.map(this.requireT3().agent.logout(params as never), response => response as unknown as LogoutAuthResponse | undefined))
  }

  listProviders(params: ListProvidersRequest = {}): Promise<ListProvidersResponse> {
    return this.operation(ACP_V2_METHODS.providersList, () =>
      Effect.map(this.requireT3().agent.listProviders(params as never), response => response as unknown as ListProvidersResponse))
  }

  setProvider(params: SetProviderRequest): Promise<SetProviderResponse | undefined> {
    return this.operation(ACP_V2_METHODS.providersSet, () =>
      Effect.map(this.requireT3().agent.setProvider(params as never), response => response as unknown as SetProviderResponse | undefined))
  }

  disableProvider(params: DisableProviderRequest): Promise<DisableProviderResponse | undefined> {
    return this.operation(ACP_V2_METHODS.providersDisable, () =>
      Effect.map(this.requireT3().agent.disableProvider(params as never), response => response as unknown as DisableProviderResponse | undefined))
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return this.operation(ACP_V2_METHODS.sessionNew, () =>
      Effect.map(this.requireT3().agent.createSession({
        cwd: params.cwd,
        mcpServers: (params.mcpServers ?? []) as never,
      }), response =>
        ({ sessionId: response.sessionId,
          ...(response.configOptions == null ? {} : { configOptions: nativeConfigOptions(response.configOptions) }) }) as unknown as NewSessionResponse))
  }

  listSessions(params: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    return this.operation(ACP_V2_METHODS.sessionList, () =>
      Effect.map(this.requireT3().agent.listSessions(params as never), response => response as unknown as ListSessionsResponse))
  }

  deleteSession(params: { readonly sessionId: SessionId }): Promise<void> {
    return this.operation(ACP_V2_METHODS.sessionDelete, () =>
      Effect.asVoid(this.requireT3().agent.deleteSession(params as never)))
  }

  forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    return this.operation(ACP_V2_METHODS.sessionFork, () =>
      Effect.map(this.requireT3().agent.forkSession(params as never), response =>
        ({ sessionId: response.sessionId, configOptions: nativeConfigOptions(response.configOptions) }) as unknown as ForkSessionResponse))
  }

  resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return this.operation(ACP_V2_METHODS.sessionResume, () =>
      Effect.map(this.requireT3().agent.resumeSession(params as never), response =>
        response.configOptions == null ? {} : { configOptions: nativeConfigOptions(response.configOptions) }))
  }

  closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse | undefined> {
    return this.operation(ACP_V2_METHODS.sessionClose, () =>
      Effect.map(this.requireT3().agent.closeSession(params as never), response => response as unknown as CloseSessionResponse | undefined))
  }

  setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    return this.operation(ACP_V2_METHODS.sessionSetConfigOption, () =>
      Effect.map(this.requireT3().agent.setSessionConfigOption({
        sessionId: params.sessionId,
        configId: params.configId,
        value: params.value,
        ...(params.type === 'boolean' ? { type: 'boolean' as const } : {}),
      } as never), response => ({ configOptions: nativeConfigOptions(response.configOptions) })))
  }

  /**
   * Resolves on insertion only when `onInsertion` is supplied; the returned
   * Promise still settles on idle completion or prompt failure, so callers can
   * acknowledge the write and keep waiting for the turn separately.
   */
  prompt(params: PromptRequest, options: AcpPromptOptions & { onDispatch?(): void } = {}): Promise<T3Schema.PromptResponse> {
    return this.operation(ACP_V2_METHODS.sessionPrompt, () => {
      const client = this.requireT3()
      options.onDispatch?.()
      return client.agent.prompt(params as never, options)
    })
  }

  mcpMessage(params: MessageMcpRequest): Promise<MessageMcpResponse> {
    return this.operation(ACP_V2_METHODS.mcpMessage, () =>
      Effect.map(this.requireT3().raw.request(ACP_V2_METHODS.mcpMessage, params as never), response => response as unknown as MessageMcpResponse))
  }

  cancelSession(params: CancelSessionNotification): Promise<void> {
    return this.operation(ACP_V2_METHODS.sessionCancel, () =>
      Effect.asVoid(this.requireT3().agent.cancel(params as never)))
  }

  cancel(): void {
    // T3 binds prompt completion to session idle and fails it when the scope closes.
  }

  async close(): Promise<void> {
    await Effect.runPromise(Scope.close(this.scope, Exit.void))
  }

  private requireT3(): T3Service {
    if (this.acp === undefined) throw new AcpProtocolError('E_PROTOCOL', 'ACP v2 client is not connected')
    return this.acp
  }

  private supportsSessionBaseline(): boolean {
    return this.initialization?.capabilities.session != null
  }

  private supportsProviders(): boolean {
    return this.initialization?.capabilities.providers !== undefined && this.initialization.capabilities.providers !== null
  }

  private hasAuthMethod(): boolean {
    return (this.initialization?.response.authMethods?.length ?? 0) > 0
  }

  /**
   * The single request choke point: capability fences, then one per-method
   * deadline. Methods return the T3 Effect itself so the timeout interrupts the
   * RPC fiber and a late reply is discarded. Prompt has no deadline here; see
   * ACP_V2_DEFAULT_TIMEOUTS.
   */
  private async operation<T>(method: string, run: () => Effect.Effect<T, T3AcpError>): Promise<T> {
    if (this.initialization === undefined) throw new AcpProtocolError('E_PROTOCOL', `ACP ${method} call before initialization`, { method })
    try {
      if (method === ACP_V2_METHODS.providersList || method === ACP_V2_METHODS.providersSet || method === ACP_V2_METHODS.providersDisable) {
        if (!this.supportsProviders()) throw unsupported(method)
      } else if (method === ACP_V2_METHODS.authLogin || method === ACP_V2_METHODS.authLogout) {
        if (!this.hasAuthMethod()) throw unsupported(method)
      } else if (!this.supportsSessionBaseline()) {
        throw unsupported(method)
      }
      const request = method !== ACP_V2_METHODS.sessionCancel
      if (request && this.pendingRequests >= MAX_PENDING_REQUESTS) throw new AcpProtocolError('E_PROTOCOL', 'ACP request capacity exceeded', { method })
      if (request) this.pendingRequests++
      try {
        const timeoutMs = timeoutMsFor(method, this.timeouts)
        const effect = Effect.suspend(run)
        if (timeoutMs === undefined) return await Effect.runPromise(effect)
        return await this.bounded(method, timeoutMs, effect)
      } finally {
        if (request) this.pendingRequests--
      }
    } catch (error) {
      throw toProtocolError(error)
    }
  }

  private async bounded<T>(method: string, timeoutMs: number, effect: Effect.Effect<T, T3AcpError>): Promise<T> {
    const outcome = await Effect.runPromise(Effect.timeoutOption(effect, timeoutMs))
    if (Option.isNone(outcome)) throw timeoutError(method, timeoutMs)
    return outcome.value
  }
}

const timeoutError = (method: string, timeoutMs: number): AcpProtocolError =>
  new AcpProtocolError('E_TIMEOUT', `ACP v2 request timed out after ${timeoutMs}ms: ${method}`, { method })

const oversizeFrame = (): T3AcpTransportError => new T3AcpTransportError({
  operation: 'read-input-stream',
  cause: new AcpProtocolError('E_MESSAGE_TOO_LARGE', `ACP frame exceeds ${MAX_INBOUND_FRAME_BYTES} bytes`, { maxMessageBytes: MAX_INBOUND_FRAME_BYTES }),
})

const writeOutput = async (output: NodeJS.WritableStream, chunk: string | Uint8Array): Promise<void> => {
  await new Promise<void>((resolve, reject) => output.write(chunk, error => error == null ? resolve() : reject(error)))
}

const unsupported = (method: string): AcpProtocolError =>
  new AcpProtocolError('E_UNSUPPORTED_CAPABILITY', `ACP v2 capability is unavailable: ${method}`, { method })

const PROMPT_REJECTION_CODES = new Set([-32600, -32601, -32602, -32000, -32002])

/**
 * T3's compat model names the option key `id`; the app, its projection and its
 * persisted v2 records use the SDK-native `configId`. Convert once here so the
 * runtime and persistence never see two shapes.
 */
export const nativeConfigOptions = (
  options: ReadonlyArray<T3Schema.SessionConfigOption> | null | undefined,
): SessionConfigOption[] =>
  (options ?? []).map(({ id, ...option }) => ({ ...option, configId: id }) as SessionConfigOption)

const toProtocolError = (error: unknown): AcpProtocolError => {
  if (error instanceof AcpProtocolError) return error
  if (error instanceof T3AcpTransportError && error.cause instanceof AcpProtocolError) return error.cause
  const message = error instanceof Error ? error.message : String(error)
  const tag = (error as { readonly _tag?: unknown } | null)?._tag
  const code = (error as { readonly code?: unknown } | null)?.code
  const method = (error as { readonly method?: unknown } | null)?.method
  const type: AcpProtocolError['type'] =
    tag === 'AcpTransportError' || tag === 'AcpInputStreamEndedError' ? 'E_DISCONNECTED'
      : tag === 'AcpProcessExitedError' ? 'E_DISCONNECTED'
        : tag === 'AcpProtocolParseError' ? 'E_MALFORMED_FRAME'
          : typeof code === 'number' ? 'E_REMOTE'
            : 'E_PROTOCOL'
  return new AcpProtocolError(type, message, {
    ...(typeof code === 'number' ? { code } : {}),
    ...(typeof method === 'string' ? { method } : {}),
    ...(error instanceof T3AcpRequestError && error.method === ACP_V2_METHODS.sessionPrompt
      && error.operation === 'receive-response' && PROMPT_REJECTION_CODES.has(error.code) ? { promptRejected: true } : {}),
    cause: error,
  })
}

/**
 * Maps the vendored core's synthetic initialize rejection. The core reports
 * both a real major-version mismatch and a schema-invalid same-version reply
 * through one `AcpRequestError`; they must not share a result. A different
 * major is `E_INCOMPATIBLE`. An equal major means the reply carried the right
 * version but the wrong shape, which is `E_PROTOCOL`, not a version conflict.
 */
const negotiateFailure = (error: unknown): AcpProtocolError | undefined => {
  if (error === null || typeof error !== 'object' || (error as T3AcpError)._tag !== 'AcpRequestError') return undefined
  const data = (error as { readonly data?: unknown }).data
  if (typeof data !== 'object' || data === null) return undefined
  const requestedVersion = (data as { readonly requestedVersion?: unknown }).requestedVersion
  const returnedVersion = (data as { readonly returnedVersion?: unknown }).returnedVersion
  if (typeof requestedVersion !== 'number' || typeof returnedVersion !== 'number') return undefined
  if (requestedVersion !== returnedVersion) return incompatibleVersionError(requestedVersion, returnedVersion)
  return invalidInitializeError(returnedVersion, error)
}
