import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  AgentCapabilities,
  CloseSessionRequest,
  DisableProviderRequest,
  ForkSessionRequest,
  ListProvidersRequest,
  ListSessionsRequest,
  LoginAuthRequest,
  LogoutAuthRequest,
  NewSessionResponse,
  ReplayFrom,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionResponse,
  SessionConfigOption,
  SetProviderRequest,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk/experimental/v2'
import { AcpV2Client } from './client'
import type { AcpClientNotification, AcpClientRequest } from './contract'
import { AcpProtocolError } from './errors'
import { applySessionUpdate, createSessionState, type NormalizedSessionState } from './normalize'
import type { SessionEntity } from './normalize'
import { emptyAggregate, envDigest, type AcpV2NativeAggregate, type AcpV2NativeRecord, type AcpV2NativeStore } from './persistence'
import type { AcpJobOwner } from '../../workcopy-use/acp-jobs'
import type { AcpV2McpServer, AcpV2PromptContent, AcpV2Runtime, AcpV2RuntimeEvent, AcpV2RuntimeHandle, AcpV2Turn, AcpV2TurnResult } from './types'

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000
const PROCESS_EXIT_TIMEOUT_MS = 5_000
const STDERR_LIMIT = 3_000

interface NativeLaunch {
  readonly launchId: string
  readonly purpose: 'agent' | 'command-probe'
  readonly scope: Readonly<{ kind: 'runtime-session'; sessionKey: string } | { kind: 'runtime-probe'; agent: string }>
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

interface NativeStarted extends NativeLaunch { readonly pid: number; readonly startedAt: string }
interface NativeExit extends NativeStarted { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null; readonly exitedAt: string }

export interface AcpV2ProcessOwner {
  spawn(launch: NativeLaunch, options: SpawnOptions): ChildProcess
  spawned(started: NativeStarted): Promise<void>
  cleanup(started: NativeStarted): Promise<void>
  cleanupAll(): Promise<void>
}

export interface AcpV2RuntimeOptions {
  readonly agentId: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly store: AcpV2NativeStore
  readonly transport?: { readonly input: NodeJS.ReadableStream; readonly output: NodeJS.WritableStream }
  readonly processOwner?: AcpJobOwner
  readonly mcpServers?: () => AcpV2McpServer[]
  readonly prepareSpawn?: (launch: NativeLaunch) => Promise<{ appendArgs?: readonly string[]; env?: Record<string, string> } | { appendArgs?: readonly string[]; env?: Record<string, string> }>
  readonly onBeforeSpawn?: (launch: NativeLaunch) => Promise<void> | void
  readonly onSpawned?: (started: NativeStarted) => Promise<void> | void
  readonly onSpawnFailed?: (failure: NativeLaunch & { error: unknown; failedAt: string }) => Promise<void> | void
  readonly onExit?: (exit: NativeExit) => Promise<void> | void
  readonly onDisconnect?: (error: unknown) => void
}

class EventQueue implements AsyncIterable<AcpV2RuntimeEvent> {
  private readonly values: AcpV2RuntimeEvent[] = []
  private wake?: () => void
  private ended = false

  push(value: AcpV2RuntimeEvent): void {
    if (this.ended) return
    this.values.push(value)
    this.wake?.()
    this.wake = undefined
  }

  close(): void {
    this.ended = true
    this.wake?.()
    this.wake = undefined
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AcpV2RuntimeEvent, void, unknown> {
    while (!this.ended || this.values.length > 0) {
      const value = this.values.shift()
      if (value !== undefined) yield value
      else if (!this.ended) await new Promise<void>(accept => { this.wake = accept })
    }
  }
}

interface ActiveTurn {
  readonly sessionId: string
  readonly signal: AbortController
  readonly queue: EventQueue
  readonly onPermissionRequest?: (request: RequestPermissionRequest, context: { signal: AbortSignal }) => Promise<RequestPermissionResponse | undefined>
  finish(result: AcpV2TurnResult): void
  finishStarted(error: unknown): void
}

export class AcpV2RuntimeOwner implements AcpV2Runtime {
  private child?: ChildProcessWithoutNullStreams
  private client?: AcpV2Client
  private capabilities?: AgentCapabilities
  private initialized?: Awaited<ReturnType<AcpV2Client['initialize']>>
  private runtimeHandle?: AcpV2RuntimeHandle
  private readonly sessions = new Map<string, NormalizedSessionState>()
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly launch: NativeLaunch
  private readonly store: AcpV2NativeStore
  private readonly effectiveArgs: readonly string[]
  private readonly effectiveEnv: Readonly<Record<string, string>>
  private readonly launchEnvDigest: string
  private startedAt?: string
  private closed?: Promise<void>
  private closedRecordId?: string
  private startPromise?: Promise<void>
  private ensureSessionPromise?: Promise<AcpV2RuntimeHandle>
  private startGeneration = 0
  private disconnected = false
  private stderr = ''

  constructor(private readonly options: AcpV2RuntimeOptions) {
    this.store = options.store
    this.launch = {
      launchId: randomUUID(),
      purpose: 'agent',
      scope: { kind: 'runtime-session', sessionKey: randomUUID() },
      command: options.argv[0] ?? '',
      args: options.argv.slice(1),
      cwd: options.cwd,
    }
    this.effectiveArgs = options.argv
    this.effectiveEnv = options.env
    this.launchEnvDigest = envDigest(options.env)
  }

  async ensureSession(input: { sessionKey: string; cwd: string; resumeSessionId?: string; nativeRecordId?: string }): Promise<AcpV2RuntimeHandle> {
    const existing = this.runtimeHandle
    if (existing !== undefined) {
      if (existing.sessionKey !== input.sessionKey || existing.cwd !== input.cwd) throw mismatchedSessionError()
      if (input.resumeSessionId !== undefined && existing.backendSessionId !== input.resumeSessionId) throw mismatchedSessionError()
      if (input.nativeRecordId !== undefined && existing.nativeRecordId !== input.nativeRecordId) throw mismatchedSessionError()
      return existing
    }
    if (input.resumeSessionId !== undefined && input.nativeRecordId === undefined) throw new AcpProtocolError('E_PROTOCOL', 'ACP v2 resume requires its native record')
    const adoptPromise = this.ensureSessionPromise ?? this.ensureSessionLocked(input)
    this.ensureSessionPromise = adoptPromise
    try { return await adoptPromise } finally { if (this.ensureSessionPromise === adoptPromise) this.ensureSessionPromise = undefined }
  }

  private async ensureSessionLocked(input: { sessionKey: string; cwd: string; resumeSessionId?: string; nativeRecordId?: string }): Promise<AcpV2RuntimeHandle> {
    const generation = ++this.startGeneration
    const starting = this.startPromise ?? this.start(generation, input.sessionKey)
    this.startPromise = starting
    try {
      await starting
      if (generation !== this.startGeneration) throw mismatchedSessionError()
      const handle = await this.adoptSession(input)
      if (generation !== this.startGeneration || this.runtimeHandle !== undefined) throw mismatchedSessionError()
      this.runtimeHandle = handle
      return handle
    } finally {
      if (this.startPromise === starting) this.startPromise = undefined
    }
  }

  async connectSession(input: { handle: AcpV2RuntimeHandle; assertActive?(): void }): Promise<void> {
    input.assertActive?.()
    await this.ensureSession({ sessionKey: input.handle.sessionKey, cwd: input.handle.cwd, resumeSessionId: input.handle.backendSessionId, nativeRecordId: input.handle.nativeRecordId })
    input.assertActive?.()
  }

  startTurn(input: { handle: AcpV2RuntimeHandle; prompt: AcpV2PromptContent[]; requestId: string; timeoutMs?: number; assertActive?(): void; onPermissionRequest?: ActiveTurn['onPermissionRequest'] }): AcpV2Turn {
    this.assertSession(input.handle)
    const controller = new AbortController()
    const queue = new EventQueue()
    let settle: (value: AcpV2TurnResult) => void = () => undefined
    let rejectStarted: (error: unknown) => void = () => undefined
    let acknowledgeStart: (() => void) | undefined
    const result = new Promise<AcpV2TurnResult>(resolve => { settle = resolve })
    const promptStarted = new Promise<void>((resolve, reject) => {
      acknowledgeStart = resolve
      rejectStarted = reject
    })
    const activeTurn: ActiveTurn = { sessionId: input.handle.backendSessionId, signal: controller, queue, onPermissionRequest: input.onPermissionRequest, finish: settle, finishStarted: rejectStarted }
    this.activeTurns.set(input.requestId, activeTurn)
    const timer = setTimeout(() => { void cancel({ reason: `ACP v2 turn timed out after ${input.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS}ms` }).catch(() => undefined) }, input.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS)
    void result.finally(() => clearTimeout(timer))
    void (async () => {
      try {
        input.assertActive?.()
        this.assertSession(input.handle)
        await this.requireClient().prompt({ sessionId: input.handle.backendSessionId, prompt: input.prompt })
        acknowledgeStart?.()
        acknowledgeStart = undefined
      } catch (error) {
        this.finishTurn(input.requestId, activeTurn, { status: 'failed', error: { message: error instanceof Error ? error.message : String(error) } }, new Error(error instanceof Error ? error.message : String(error)))
        acknowledgeStart = undefined
      }
    })()
    const cancel = async (cancelInput?: { reason?: string }): Promise<void> => {
      if (controller.signal.aborted) return
      controller.abort()
      try {
        await this.requireClient().cancelSession({
          sessionId: input.handle.backendSessionId,
          ...(cancelInput?.reason === undefined ? {} : { _meta: { reason: cancelInput.reason } }),
        })
      } catch (error) {
        if (!this.disconnected) queue.push({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { requestId: input.requestId, promptStarted, events: queue, result, cancel, closeStream: cancel }
  }

  async setConfigOption(input: { handle: AcpV2RuntimeHandle; configId: string; value: string }): Promise<SetSessionConfigOptionResponse> {
    this.assertSession(input.handle)
    const response = await this.requireClient().setConfigOption({ sessionId: input.handle.backendSessionId, configId: input.configId, value: input.value, type: 'id' })
    const state = this.ensureSessionState(input.handle.backendSessionId)
    for (const option of response.configOptions) state.configOptions.set(option.configId, option)
    await this.persistRecord(input.handle, response.configOptions)
    return response
  }

  getCapabilities(): ReturnType<AcpV2Runtime['getCapabilities']> {
    const session = this.capabilities?.session
    return {
      controls: session === undefined ? [] : ['session/set_config_option', 'session/status'],
      promptCapabilities: {
        image: session?.prompt?.image != null,
        embeddedContext: session?.prompt?.embeddedContext != null,
      },
      supportsList: session !== undefined && session !== null,
      supportsDelete: session?.delete !== undefined && session?.delete !== null,
      supportsFork: session?.fork !== undefined && session?.fork !== null,
      supportsResume: session !== undefined && session !== null,
      supportsAuth: (this.initialized?.response.authMethods?.length ?? 0) > 0,
      supportsProviders: this.capabilities?.providers !== undefined && this.capabilities.providers !== null,
    }
  }

  getStatus(input?: { handle?: AcpV2RuntimeHandle }): ReturnType<AcpV2Runtime['getStatus']> {
    const state = input?.handle === undefined ? undefined : this.sessions.get(input.handle.backendSessionId)
    return { configOptions: [...(state?.configOptions.values() ?? [])], commands: [...(state?.commands.values() ?? [])] }
  }

  async listSessions(params?: ListSessionsRequest): Promise<{ sessions: Array<{ sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }>; nextCursor?: string | null }> {
    if (this.capabilities?.session == null) throw unsupported('session/list')
    return this.requireClient().listSessions(params)
  }

  async deleteSession(params: { sessionId: string }): Promise<void> {
    if (this.capabilities?.session?.delete == null) throw unsupported('session/delete')
    await this.requireClient().deleteSession(params)
    if (this.runtimeHandle?.backendSessionId === params.sessionId) await this.shutdown('closed')
  }

  async forkSession(params: ForkSessionRequest): Promise<{ sessionId: string; configOptions?: SessionConfigOption[] }> {
    if (this.capabilities?.session?.fork == null) throw unsupported('session/fork')
    return this.requireClient().forkSession(params)
  }

  async closeSession(params: CloseSessionRequest): Promise<unknown> {
    if (this.capabilities?.session == null) throw unsupported('session/close')
    const response = await this.requireClient().closeSession(params)
    if (this.runtimeHandle?.backendSessionId === params.sessionId) await this.shutdown('closed')
    return response
  }

  async login(params: LoginAuthRequest): Promise<unknown> {
    if ((this.initialized?.response.authMethods?.length ?? 0) === 0) throw unsupported('auth/login')
    return this.requireClient().login(params)
  }

  async logout(params: LogoutAuthRequest): Promise<unknown> {
    if ((this.initialized?.response.authMethods?.length ?? 0) === 0) throw unsupported('auth/logout')
    return this.requireClient().logout(params)
  }

  async listProviders(params?: ListProvidersRequest): Promise<unknown> {
    if (this.capabilities?.providers === undefined || this.capabilities.providers === null) throw unsupported('providers/list')
    return this.requireClient().listProviders(params)
  }

  async setProvider(params: SetProviderRequest): Promise<unknown> {
    if (this.capabilities?.providers === undefined || this.capabilities.providers === null) throw unsupported('providers/set')
    return this.requireClient().setProvider(params)
  }

  async disableProvider(params: DisableProviderRequest): Promise<unknown> {
    if (this.capabilities?.providers === undefined || this.capabilities.providers === null) throw unsupported('providers/disable')
    return this.requireClient().disableProvider(params)
  }

  shutdown(cleanupState: 'closed' | 'uncertain' = 'uncertain'): Promise<void> {
    this.closed ??= (async () => {
      this.disconnected = true
      for (const [requestId, turn] of [...this.activeTurns]) {
        turn.signal.abort()
        this.finishTurn(requestId, turn, { status: 'failed', error: { message: 'ACP v2 runtime disconnected' } }, new Error('ACP v2 runtime disconnected'))
      }
      const child = this.child
      const handle = this.runtimeHandle
      try {
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          if (handle !== undefined && this.capabilities?.session != null) await this.client?.closeSession({ sessionId: handle.backendSessionId }).catch(() => undefined)
          child.stdin.end()
          await awaitExit(child)
        }
      } finally {
        if (child !== undefined && this.options.processOwner !== undefined && child.pid !== undefined) {
          await this.options.processOwner.cleanup(this.nativeStarted(child))
        }
        this.closedRecordId = handle?.nativeRecordId
        if (handle !== undefined) await this.store.setCleanupState(handle.nativeRecordId, cleanupState)
        this.runtimeHandle = undefined
        this.sessions.clear()
      }
    })().catch(error => { this.closed = undefined; throw error })
    return this.closed
  }

  async confirmClosed(): Promise<void> {
    if (this.closed === undefined) return
    if (this.closedRecordId === undefined) return
    await this.store.setCleanupState(this.closedRecordId, 'closed')
  }

  private async start(generation: number, sessionKey: string): Promise<void> {
    if (this.disconnected || this.closed !== undefined) throw new AcpProtocolError('E_CLOSED', 'ACP v2 runtime is already stopped')
    if (this.client !== undefined) return
    const launch = { ...this.launch, scope: { kind: 'runtime-session' as const, sessionKey } }
    try {
    const providedStream = this.options.transport
      await this.options.onBeforeSpawn?.(launch)
      if (generation !== this.startGeneration) throw mismatchedSessionError()
      const prepared = await this.options.prepareSpawn?.(launch)
      const args = [...launch.args, ...(prepared?.appendArgs ?? [])]
      const env = { ...this.effectiveEnv, ...(prepared?.env ?? {}) }
      let childStream: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } | undefined
      if (providedStream === undefined) {
            const child = this.options.processOwner !== undefined
              ? this.options.processOwner.spawn(launch, { cwd: this.options.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
              : spawn(launch.command, args, { cwd: this.options.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
            if (!hasStreams(child)) throw new Error('ACP v2 process lacks managed stdio')
            this.child = child
            childStream = { input: child.stdout, output: child.stdin }
        child.stderr.on('data', (chunk: Buffer) => { this.stderr = sanitizeStderr((this.stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT)) })
        child.once('error', error => {
          this.handleDisconnect()
          void this.options.onSpawnFailed?.({ ...launch, error, failedAt: new Date().toISOString() })
          void this.markUncertain()
          this.options.onDisconnect?.(error)
        })
        child.once('exit', (exitCode, signal) => {
          const exited = this.nativeStarted(child)
          this.handleDisconnect()
          void this.options.onExit?.({ ...exited, exitCode, signal, exitedAt: new Date().toISOString() })
          void this.markUncertain()
          this.options.onDisconnect?.(new Error(`ACP v2 process exited${this.stderr.length > 0 ? `: ${this.stderr}` : ''}`))
        })
        if (child.pid === undefined) throw new Error('ACP v2 process spawn failed')
        this.startedAt = new Date().toISOString()
        const started = { ...launch, pid: child.pid, startedAt: this.startedAt }
        if (this.options.processOwner !== undefined) await this.options.processOwner.spawned(started)
        await this.options.onSpawned?.(started)
      }
      if (generation !== this.startGeneration) throw mismatchedSessionError()
      const stream = providedStream ?? childStream
      if (stream === undefined) throw new Error('ACP v2 transport is unavailable')
      const client = AcpV2Client.connect(stream, {
        onNotification: notification => this.receiveNotification(notification),
        onRequest: request => this.receiveRequest(request),
        onProtocolError: error => {
          this.handleDisconnect()
          void this.markUncertain()
          this.options.onDisconnect?.(error)
        },
      }, { maxMessageBytes: 1024 * 1024, requestTimeoutMs: 30_000, maxPendingRequests: 64 })
      this.client = client
      this.initialized = await client.initialize({ name: 'trellis-panel', version: '0.1.0' }, {})
      this.capabilities = this.initialized.capabilities
    } catch (error) {
      if (generation !== this.startGeneration) throw mismatchedSessionError()
      await this.options.onSpawnFailed?.({ ...launch, error, failedAt: new Date().toISOString() })
      if (this.child !== undefined && this.options.processOwner !== undefined && this.child.pid !== undefined) {
        await this.options.processOwner.cleanup(this.nativeStarted(this.child)).catch(() => undefined)
      }
      if (this.child !== undefined) this.child.kill('SIGKILL')
      this.client?.close()
      this.client = undefined
      this.initialized = undefined
      this.capabilities = undefined
      this.disconnected = true
      throw error
    }
  }

  private async adoptSession(input: { sessionKey: string; cwd: string; resumeSessionId?: string; nativeRecordId?: string }): Promise<AcpV2RuntimeHandle> {
    if (input.resumeSessionId === undefined || input.nativeRecordId === undefined) {
      const response = await this.newSession({ cwd: input.cwd })
      return this.createHandle(input, response.sessionId, response.configOptions ?? [])
    }
    const response = await this.resumeSession({
      sessionKey: input.sessionKey,
      cwd: input.cwd,
      resumeSessionId: input.resumeSessionId,
      nativeRecordId: input.nativeRecordId,
    })
    return this.createHandle(input, input.resumeSessionId, response.configOptions ?? [])
  }

  private async createHandle(input: { sessionKey: string; cwd: string; nativeRecordId?: string }, nativeSessionId: string, configOptions: SessionConfigOption[]): Promise<AcpV2RuntimeHandle> {
    if (nativeSessionId.length === 0) throw new Error('ACP v2 session identity is invalid')
    const state = this.ensureSessionState(nativeSessionId)
    const handle: AcpV2RuntimeHandle = { sessionKey: input.sessionKey, backend: 'acp-v2', runtimeSessionName: input.sessionKey, cwd: input.cwd, nativeRecordId: input.nativeRecordId ?? randomUUID(), backendSessionId: nativeSessionId, replayCursor: state.replayCursor }
    for (const option of configOptions) this.ensureSessionState(nativeSessionId).configOptions.set(option.configId, option)
    await this.saveRecord(handle, configOptions, state.replayCursor, 'live')
    return handle
  }

  private async newSession(input: { cwd: string }): Promise<NewSessionResponse> {
    if (this.capabilities?.session == null) throw unsupported('session/new')
    const servers = this.options.mcpServers === undefined ? undefined : this.options.mcpServers()
    const params: { cwd: string; mcpServers?: AcpV2McpServer[] } = { cwd: input.cwd }
    if (servers !== undefined && servers.length > 0) params.mcpServers = servers
    return this.requireClient().newSession(params)
  }

  private async resumeSession(input: { sessionKey: string; cwd: string; resumeSessionId: string; nativeRecordId: string }): Promise<ResumeSessionResponse> {
    if (this.capabilities?.session == null) throw unsupported('session/resume')
    const record = await this.store.load(input.nativeRecordId)
    if (record === undefined
      || record.schemaVersion !== 2
      || record.sessionKey !== input.sessionKey
      || record.cwd !== input.cwd
      || record.nativeSessionId !== input.resumeSessionId
      || record.cleanupState === 'live'
      || record.launch.argv.length !== this.effectiveArgs.length
      || record.launch.argv.some((value, index) => value !== this.effectiveArgs[index])
      || record.launch.envDigest !== this.launchEnvDigest) throw new AcpProtocolError('E_PROTOCOL', 'ACP v2 native record identity or launch provenance mismatch')
    this.restoreAggregate(record)
    const servers = this.options.mcpServers === undefined ? undefined : this.options.mcpServers()
    const params: { sessionId: string; cwd: string; replayFrom: ReplayFrom; mcpServers?: AcpV2McpServer[] } = {
      sessionId: input.resumeSessionId,
      cwd: input.cwd,
      replayFrom: record.replayCursor === undefined ? { type: 'start' } : { type: '_trellis_cursor', cursor: record.replayCursor },
      ...(servers === undefined || servers.length === 0 ? {} : { mcpServers: servers }),
    }
    const response = await this.requireClient().resumeSession(params)
    return response
  }

  private receiveNotification(notification: AcpClientNotification): void {
    if (notification.method !== 'session/update' || this.disconnected) return
    const state = this.ensureSessionState(notification.params.sessionId)
    const applied = applySessionUpdate(state, notification.params)
    if (applied.events.length > 0) {
      for (const turn of [...this.activeTurns.values()].filter(turn => turn.sessionId === notification.params.sessionId)) {
        for (const event of applied.events) turn.queue.push(event)
      }
      void this.persistAggregate(notification.params.sessionId, state)
    }
    const active = [...this.activeTurns].filter(([, item]) => item.sessionId === notification.params.sessionId)
    if (applied.terminal === undefined || active.length === 0) return
    for (const [requestId, turn] of active) {
      this.finishTurn(requestId, turn, applied.terminal.error === undefined
        ? { status: applied.terminal.stopReason === 'cancelled' ? 'cancelled' : 'completed', stopReason: applied.terminal.stopReason }
        : { status: 'failed', error: applied.terminal.error })
    }
  }

  private async receiveRequest(request: AcpClientRequest): Promise<unknown> {
    if (request.method !== 'session/request_permission') throw new Error('Unsupported ACP v2 client request')
    const running = [...this.activeTurns.values()].find(turn => turn.sessionId === request.params.sessionId)
    if (running?.onPermissionRequest === undefined) return { outcome: { outcome: 'cancelled' } }
    return await running.onPermissionRequest(request.params, { signal: running.signal.signal }) ?? { outcome: { outcome: 'cancelled' } }
  }

  private finishTurn(requestId: string, turn: ActiveTurn, result: AcpV2TurnResult, startedError?: Error): void {
    if (this.activeTurns.get(requestId) !== turn) return
    this.activeTurns.delete(requestId)
    turn.queue.push({ type: 'done', stopReason: result.status === 'failed' ? undefined : result.stopReason })
    turn.queue.close()
    if (startedError !== undefined) turn.finishStarted(startedError)
    turn.finish(result)
  }


  private handleDisconnect(): void {
    this.disconnected = true
    for (const [requestId, turn] of [...this.activeTurns]) {
      this.finishTurn(requestId, turn, { status: 'failed', error: { message: 'ACP v2 runtime disconnected' } }, new Error('ACP v2 runtime disconnected'))
    }
  }

  private ensureSessionState(sessionId: string): NormalizedSessionState {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created = createSessionState()
    this.sessions.set(sessionId, created)
    return created
  }

  private nativeStarted(child: ChildProcess): NativeStarted {
    if (child.pid === undefined || this.startedAt === undefined) throw new Error('ACP v2 native launch identity is unavailable')
    return { ...this.launch, pid: child.pid, startedAt: this.startedAt }
  }

  private assertSession(handle: AcpV2RuntimeHandle): void {
    if (this.runtimeHandle === undefined
      || this.runtimeHandle.nativeRecordId !== handle.nativeRecordId
      || this.runtimeHandle.backendSessionId !== handle.backendSessionId
      || this.runtimeHandle.sessionKey !== handle.sessionKey) throw new AcpProtocolError('E_CLOSED', 'ACP v2 session is not connected')
  }

  private requireClient(): AcpV2Client {
    if (this.client === undefined || this.disconnected) throw new AcpProtocolError('E_CLOSED', 'ACP v2 runtime is not connected')
    return this.client
  }

  private async saveRecord(handle: AcpV2RuntimeHandle, configOptions: SessionConfigOption[], replayCursor: string | undefined, cleanupState: 'live' | 'closed' | 'uncertain'): Promise<void> {
    if (this.initialized === undefined || this.capabilities === undefined) throw new AcpProtocolError('E_PROTOCOL', 'ACP v2 connection is not initialized')
    await this.store.save({
      schemaVersion: 2,
      recordId: handle.nativeRecordId,
      sessionKey: handle.sessionKey,
      cwd: handle.cwd,
      launch: { argv: [...this.effectiveArgs], envDigest: this.launchEnvDigest },
      negotiated: {
        protocolVersion: 2,
        agent: {
          name: this.initialized.response.info.name,
          title: this.initialized.response.info.title ?? null,
          version: this.initialized.response.info.version,
        },
        capabilities: this.capabilities,
      },
      nativeSessionId: handle.backendSessionId,
          replayCursor: this.ensureSessionState(handle.backendSessionId).replayCursor ?? replayCursor,
      configOptions,
      aggregate: this.aggregateFor(handle.backendSessionId),
      cleanupState,
      updatedAt: Date.now(),
    })
  }

  private async persistRecord(handle: AcpV2RuntimeHandle, configOptions: SessionConfigOption[]): Promise<void> {
    await this.persistAggregate(handle.backendSessionId, this.ensureSessionState(handle.backendSessionId), configOptions)
  }

  private async persistAggregate(sessionId: string, state: NormalizedSessionState, configOptions?: SessionConfigOption[]): Promise<void> {
    const handle = this.runtimeHandle
    if (handle === undefined || handle.backendSessionId !== sessionId || this.disconnected) return
    const options = configOptions ?? [...state.configOptions.values()]
    await this.saveRecord(handle, options, state.replayCursor, 'live')
  }

  private async markUncertain(): Promise<void> {
    const handle = this.runtimeHandle
    if (handle !== undefined) await this.store.setCleanupState(handle.nativeRecordId, 'uncertain').catch(() => undefined)
  }

  private aggregateFor(sessionId: string): AcpV2NativeAggregate {
    const state = this.ensureSessionState(sessionId)
    return {
      ...emptyAggregate(),
      messages: [...state.entities.messages.entries()].map(([nativeId, entity]) => ({ nativeId, revision: entity.revision, value: entity.value })),
      toolCalls: [...state.entities.toolCalls.entries()].map(([nativeId, entity]) => ({ nativeId, revision: entity.revision, value: entity.value })),
      plans: [...state.entities.plans.entries()].map(([nativeId, entity]) => ({ nativeId, revision: entity.revision, value: entity.value })),
      terminal: [...state.entities.terminal.entries()].map(([nativeId, entity]) => ({ nativeId, revision: entity.revision, value: entity.value })),
      sessionInfo: [...state.entities.sessionInfo.entries()].map(([nativeId, entity]) => ({ nativeId, revision: entity.revision, value: entity.value })),
      notices: [...state.entities.notices.entries()].map(([nativeId, entity]) => ({ nativeId, revision: entity.revision, value: entity.value })),
      revisionOrder: [...state.revisionOrder],
      replayCursor: state.replayCursor,
    }
  }

  private restoreAggregate(record: AcpV2NativeRecord): void {
    const state = this.ensureSessionState(record.nativeSessionId)
    state.replayCursor = record.aggregate.replayCursor ?? record.replayCursor
    for (const revision of record.aggregate.revisionOrder) if (state.seenRevisions.size < 256) {
      state.seenRevisions.add(revision)
      state.revisionOrder.push(revision)
    }
    const restore = <TValue>(target: Map<string, SessionEntity<TValue>>, values: ReadonlyArray<{ nativeId: string; revision: string; value: unknown }>): void => {
      for (const entity of values) target.set(entity.nativeId, { nativeId: entity.nativeId, revision: entity.revision, value: entity.value as TValue })
    }
    restore(state.entities.messages, record.aggregate.messages)
    restore(state.entities.toolCalls, record.aggregate.toolCalls)
    restore(state.entities.plans, record.aggregate.plans)
    restore(state.entities.terminal, record.aggregate.terminal)
    restore(state.entities.sessionInfo, record.aggregate.sessionInfo)
    restore(state.entities.notices, record.aggregate.notices)
    for (const option of record.configOptions) state.configOptions.set(option.configId, option)
  }
}

const mismatchedSessionError = (): AcpProtocolError => new AcpProtocolError('E_CONFLICT', 'ACP v2 owner is already bound to another session/runtime identity')
const unsupported = (method: string): AcpProtocolError => new AcpProtocolError('E_UNSUPPORTED_CAPABILITY', `ACP v2 capability is unavailable: ${method}`, { method })
const awaitExit = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  const exited = new Promise<void>(accept => child.once('exit', accept))
  await Promise.race([exited, new Promise<void>(accept => setTimeout(accept, PROCESS_EXIT_TIMEOUT_MS).unref())])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await Promise.race([exited, new Promise<void>(accept => setTimeout(accept, PROCESS_EXIT_TIMEOUT_MS).unref())])
}
const hasStreams = (child: ChildProcess): child is ChildProcessWithoutNullStreams => Boolean(child.stdin && child.stdout && child.stderr)
const sanitizeStderr = (value: string): string => value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/\b(api[_-]?key|token|password|secret)\b\s*[:=]\s*\S+/gi, '$1 [redacted]')
