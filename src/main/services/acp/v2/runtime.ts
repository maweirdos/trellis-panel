import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { makeSessionStart } from '../t3-core/acp-session-start'
import { sessionUpdateIsReplay } from '../t3-core/runtime-model'
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
import { AcpV2Client, type AcpV2TimeoutPolicy } from './client'
import type { AcpClientNotification, AcpClientRequest } from './contract'
import { AcpProtocolError } from './errors'
import { acceptsPromptIdle, applySessionUpdate, createSessionState, hasAcpCapability, replaceSessionConfigOptions, type NormalizedSessionState } from './normalize'
import type { SessionEntity } from './normalize'
import { emptyAggregate, envDigest, type AcpV2NativeAggregate, type AcpV2NativeRecord, type AcpV2NativeStore } from './persistence'
import type { AcpJobOwner } from '../../workcopy-use/acp-jobs'
import type { AcpV2McpServer, AcpV2PromptContent, AcpV2Runtime, AcpV2RuntimeEvent, AcpV2RuntimeHandle, AcpV2Turn, AcpV2TurnResult } from './types'

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000
/**
 * Grace after the turn deadline before the owner is terminated. It matches the
 * 10s cancel budget `acp.ts` already promises for user-initiated cancel, so the
 * deadline and the Stop button cannot disagree about how long a cancel may take.
 */
const TURN_CANCEL_GRACE_MS = 10_000
const PROCESS_EXIT_TIMEOUT_MS = 5_000
const STDERR_LIMIT = 3_000
const STARTUP_UPDATE_LIMIT = 256
const STARTUP_UPDATE_BYTES = 1024 * 1024
const AGGREGATE_WRITE_DELAY_MS = 100

type SessionUpdateNotification = Extract<AcpClientNotification, { method: 'session/update' }>

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
  readonly projectRoot?: string
  readonly env: Readonly<Record<string, string>>
  readonly store: AcpV2NativeStore
  readonly transport?: { readonly input: NodeJS.ReadableStream; readonly output: NodeJS.WritableStream }
  /** Per-method request budgets; omitted entries take the T3-aligned `ACP_V2_DEFAULT_TIMEOUTS`. */
  readonly timeouts?: Partial<AcpV2TimeoutPolicy>
  readonly processOwner?: AcpJobOwner
  readonly mcpServers?: () => AcpV2McpServer[]
  readonly redactSnapshot?: <T>(value: T) => T
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
  promptDispatched: boolean
  userMessageId?: string
  readonly onPermissionRequest?: (request: RequestPermissionRequest, context: { signal: AbortSignal }) => Promise<RequestPermissionResponse | undefined>
  finish(result: AcpV2TurnResult): void
  finishStarted(error: unknown): void
}

type SessionRequest = { sessionKey: string; cwd: string; resumeSessionId?: string; nativeRecordId?: string }

export class AcpV2RuntimeOwner implements AcpV2Runtime {
  private child?: ChildProcessWithoutNullStreams
  private client?: AcpV2Client
  private capabilities?: AgentCapabilities
  private initialized?: Awaited<ReturnType<AcpV2Client['initialize']>>
  private runtimeHandle?: AcpV2RuntimeHandle
  private readonly sessions = new Map<string, NormalizedSessionState>()
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private launch?: NativeLaunch
  private readonly store: AcpV2NativeStore
  private readonly effectiveArgs: readonly string[]
  private readonly effectiveEnv: Readonly<Record<string, string>>
  private readonly launchEnvDigest: string
  private startedAt?: string
  private closed?: Promise<void>
  private closedRecordId?: string
  private readonly sessionStart = makeSessionStart(
    (request: SessionRequest) => this.openSession(request),
    (left, right) => left.sessionKey === right.sessionKey && left.cwd === right.cwd
      && left.resumeSessionId === right.resumeSessionId && left.nativeRecordId === right.nativeRecordId,
    mismatchedSessionError,
  )
  private readonly startupUpdates: SessionUpdateNotification[] = []
  private startupUpdateBytes = 0
  private initialRecord?: { id: string; write: Promise<void> }
  private aggregateTimer?: NodeJS.Timeout
  private recordWrite: Promise<void> = Promise.resolve()
  private disconnected = false
  private stderr = ''

  constructor(private readonly options: AcpV2RuntimeOptions) {
    this.store = options.store
    this.effectiveArgs = options.argv
    this.effectiveEnv = options.env
    this.launchEnvDigest = envDigest(options.env)
  }

  async ensureSession(input: SessionRequest): Promise<AcpV2RuntimeHandle> {
    this.assertOpen()
    if (this.sessionStart.starting() !== undefined) return this.sessionStart.start({ ...input })
    const existing = this.runtimeHandle
    if (existing !== undefined) {
      if (existing.sessionKey !== input.sessionKey || existing.cwd !== input.cwd) throw mismatchedSessionError()
      if (input.resumeSessionId !== undefined && existing.backendSessionId !== input.resumeSessionId) throw mismatchedSessionError()
      if (input.nativeRecordId !== undefined && existing.nativeRecordId !== input.nativeRecordId) throw mismatchedSessionError()
      return existing
    }
    if (input.resumeSessionId !== undefined && input.nativeRecordId === undefined) throw new AcpProtocolError('E_PROTOCOL', 'ACP v2 resume requires its native record')
    return this.sessionStart.start({ ...input })
  }

  private async openSession(input: SessionRequest): Promise<AcpV2RuntimeHandle> {
    try {
      await this.start(input.sessionKey)
      this.assertOpen()
      const handle = await this.adoptSession(input)
      this.assertOpen()
      const receivedDuringWrite = this.flushStartupUpdates(handle.backendSessionId)
      this.runtimeHandle = handle
      this.initialRecord = undefined
      if (receivedDuringWrite) {
        await this.persistRecord(handle, undefined)
        this.assertOpen()
      }
      return handle
    } catch (error) {
      try { await this.shutdown('closed') }
      catch (cleanup) { throw new AggregateError([error, cleanup], `${error instanceof Error ? error.message : String(error)}; ACP runtime cleanup could not be confirmed`, { cause: error }) }
      throw error
    }
  }

  async connectSession(input: { handle: AcpV2RuntimeHandle; assertActive?(): void }): Promise<void> {
    input.assertActive?.()
    await this.ensureSession({ sessionKey: input.handle.sessionKey, cwd: input.handle.cwd, resumeSessionId: input.handle.backendSessionId, nativeRecordId: input.handle.nativeRecordId })
    input.assertActive?.()
  }

  startTurn(input: { handle: AcpV2RuntimeHandle; prompt: AcpV2PromptContent[]; requestId: string; timeoutMs?: number; assertActive?(): void; onPermissionRequest?: ActiveTurn['onPermissionRequest'] }): AcpV2Turn {
    this.assertSession(input.handle)
    if (this.activeTurns.size > 0) throw new AcpProtocolError('E_CONFLICT', 'An ACP turn is already active')
    const controller = new AbortController()
    const queue = new EventQueue()
    let settle: (value: AcpV2TurnResult) => void = () => undefined
    let rejectStarted: (error: unknown) => void = () => undefined
    let acknowledgeStart: (() => void) | undefined
    const promptIdle = { terminal: false }
    const result = new Promise<AcpV2TurnResult>(resolve => { settle = resolve })
    const promptStarted = new Promise<void>((resolve, reject) => {
      acknowledgeStart = resolve
      rejectStarted = reject
    })
    const activeTurn: ActiveTurn = { sessionId: input.handle.backendSessionId, signal: controller, queue, promptDispatched: false,
      onPermissionRequest: input.onPermissionRequest, finish: settle, finishStarted: rejectStarted }
    this.activeTurns.set(input.requestId, activeTurn)
    const deadlineMs = input.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    let deadlineTimer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined
    const clearDeadline = (): void => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      deadlineTimer = undefined
      graceTimer = undefined
    }
    deadlineTimer = setTimeout(() => {
      void cancel({ reason: `ACP v2 turn timed out after ${deadlineMs}ms` }).catch(() => undefined)
      graceTimer = setTimeout(() => this.terminateTurnAfterIgnoredCancel(input.requestId, activeTurn, deadlineMs), TURN_CANCEL_GRACE_MS)
    }, deadlineMs)
    void result.finally(clearDeadline)
    void (async () => {
      try {
        input.assertActive?.()
        this.assertSession(input.handle)
        const outcome = await this.requireClient().prompt(
          { sessionId: input.handle.backendSessionId, prompt: input.prompt },
          {
            onDispatch: () => { activeTurn.promptDispatched = true },
            onInsertion: () => {
              if (this.activeTurns.get(input.requestId) !== activeTurn) return
              acknowledgeStart?.()
              acknowledgeStart = undefined
            },
            acceptIdle: notification => acceptsPromptIdle(promptIdle, this.sessions.get(notification.sessionId), notification),
          },
        )
        if (this.aggregateTimer !== undefined) {
          this.clearAggregateTimer()
          await this.persistRecord(input.handle, undefined)
        }
        this.finishTurn(input.requestId, activeTurn, outcome.error != null
          ? { status: 'failed', error: { message: outcome.error.message, code: String(outcome.error.code) } }
          : { status: outcome.stopReason === 'cancelled' ? 'cancelled' : 'completed', stopReason: outcome.stopReason ?? undefined })
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.finishTurn(input.requestId, activeTurn, { status: 'failed', error: { message: failure.message } }, failure)
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
    return { requestId: input.requestId, promptStarted, get promptDispatched() { return activeTurn.promptDispatched }, events: queue, result, cancel, closeStream: cancel }
  }

  private terminateTurnAfterIgnoredCancel(requestId: string, turn: ActiveTurn, deadlineMs: number): void {
    if (this.activeTurns.get(requestId) !== turn) return
    const message = `ACP v2 turn timed out after ${deadlineMs}ms; the agent did not settle within ${TURN_CANCEL_GRACE_MS}ms of cancellation`
    const error = new AcpProtocolError('E_TIMEOUT', message, { method: 'session/prompt' })
    this.finishTurn(requestId, turn, { status: 'failed', error: { message, code: error.type } }, error)
    this.handleDisconnect(error)
    void this.shutdown('uncertain').catch(() => undefined)
  }

  async setConfigOption(input: { handle: AcpV2RuntimeHandle; configId: string; value: string }): Promise<SetSessionConfigOptionResponse> {
    this.assertSession(input.handle)
    const state = this.ensureSessionState(input.handle.backendSessionId)
    const fields = { sessionId: input.handle.backendSessionId, configId: input.configId }
    const option = state.configOptions.get(input.configId)
    if (option?.type === 'boolean' && input.value !== 'true' && input.value !== 'false') {
      throw new AcpProtocolError('E_PROTOCOL', 'ACP v2 boolean config requires true or false')
    }
    const response = await this.requireClient().setConfigOption(option?.type === 'boolean'
      ? { ...fields, value: input.value === 'true', type: 'boolean' }
      : { ...fields, value: input.value, type: 'id' })
    replaceSessionConfigOptions(state, response.configOptions)
    await this.persistRecord(input.handle, response.configOptions)
    return response
  }

  getCapabilities(): ReturnType<AcpV2Runtime['getCapabilities']> {
    const session = this.capabilities?.session
    return {
      controls: session === undefined ? [] : ['session/set_config_option', 'session/status'],
      promptCapabilities: {
        image: hasAcpCapability(session?.prompt?.image),
        embeddedContext: hasAcpCapability(session?.prompt?.embeddedContext),
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
    return this.requireClient().login(params)
  }

  async logout(params: LogoutAuthRequest): Promise<unknown> {
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
      const graceful = !this.disconnected && cleanupState === 'closed'
      this.disconnected = true
      this.clearAggregateTimer()
      for (const [requestId, turn] of [...this.activeTurns]) {
        turn.signal.abort()
        const error = disconnectedPrompt()
        this.finishTurn(requestId, turn, { status: 'failed', error: { message: error.message, code: error.type } }, error)
      }
      const child = this.child
      const handle = this.runtimeHandle
      const recordId = handle?.nativeRecordId ?? this.initialRecord?.id
      try {
        if (graceful && handle !== undefined && this.capabilities?.session != null) {
          await this.client?.closeSession({ sessionId: handle.backendSessionId }).catch(() => undefined)
        }
        if (child?.pid !== undefined) {
          child.stdin.end()
          if (this.options.processOwner !== undefined) await this.options.processOwner.cleanup(this.nativeStarted(child))
          await awaitExit(child)
        }
        await this.initialRecord?.write.catch(() => undefined)
        if (handle !== undefined) await this.persistRecord(handle, undefined, cleanupState)
        else if (recordId !== undefined) await this.store.setCleanupState(recordId, cleanupState)
        this.closedRecordId = recordId
        this.initialRecord = undefined
        this.runtimeHandle = undefined
        this.child = undefined
        this.sessions.clear()
        this.clearStartupUpdates()
      } catch (error) {
        await this.initialRecord?.write.catch(() => undefined)
        await this.recordWrite
        if (recordId !== undefined) await this.store.setCleanupState(recordId, 'uncertain').catch(() => undefined)
        throw error
      } finally {
        await this.client?.close().catch(() => undefined)
        this.client = undefined
        this.initialized = undefined
        this.capabilities = undefined
      }
    })().catch(error => { this.closed = undefined; throw error })
    return this.closed
  }

  async confirmClosed(): Promise<void> {
    if (this.closed === undefined) return
    if (this.closedRecordId === undefined) return
    await this.store.setCleanupState(this.closedRecordId, 'closed')
  }

  private async start(sessionKey: string): Promise<void> {
    this.assertOpen()
    const launch: NativeLaunch = {
      launchId: randomUUID(), purpose: 'agent', scope: { kind: 'runtime-session', sessionKey },
      command: this.effectiveArgs[0] ?? '', args: this.effectiveArgs.slice(1), cwd: this.options.cwd,
    }
    this.launch = launch
    try {
      const providedStream = this.options.transport
      await this.options.onBeforeSpawn?.(launch)
      this.assertOpen()
      const prepared = await this.options.prepareSpawn?.(launch)
      this.assertOpen()
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
          this.handleDisconnect(error)
          void this.options.onSpawnFailed?.({ ...launch, error, failedAt: new Date().toISOString() })
        })
        child.once('exit', (exitCode, signal) => {
          const exited = this.nativeStarted(child)
          this.handleDisconnect(new Error(`ACP v2 process exited${this.stderr.length > 0 ? `: ${this.stderr}` : ''}`))
          void this.options.onExit?.({ ...exited, exitCode, signal, exitedAt: new Date().toISOString() })
        })
        if (child.pid === undefined) throw new Error('ACP v2 process spawn failed')
        this.startedAt = new Date().toISOString()
        const started = { ...launch, pid: child.pid, startedAt: this.startedAt }
        if (this.options.processOwner !== undefined) await this.options.processOwner.spawned(started)
        await this.options.onSpawned?.(started)
      }
      this.assertOpen()
      const stream = providedStream ?? childStream
      if (stream === undefined) throw new Error('ACP v2 transport is unavailable')
      const client = await AcpV2Client.connect(stream, {
        onNotification: notification => this.receiveNotification(notification),
        onRequest: request => this.receiveRequest(request),
        onProtocolError: error => this.handleDisconnect(error),
      }, this.options.timeouts)
      if (this.disconnected) await client.close()
      this.assertOpen()
      this.client = client
      const initialized = await client.initialize({ name: 'trellis-panel', version: '0.1.0' }, {})
      this.assertOpen()
      this.initialized = initialized
      this.capabilities = this.initialized.capabilities
    } catch (error) {
      await this.options.onSpawnFailed?.({ ...launch, error, failedAt: new Date().toISOString() })
      throw error
    }
  }

  private async adoptSession(input: SessionRequest): Promise<AcpV2RuntimeHandle> {
    if (input.resumeSessionId === undefined || input.nativeRecordId === undefined) {
      const response = await this.newSession({ cwd: input.cwd })
      return this.createHandle(input, response.sessionId, response.configOptions ?? undefined)
    }
    const response = await this.resumeSession({
      sessionKey: input.sessionKey,
      cwd: input.cwd,
      resumeSessionId: input.resumeSessionId,
      nativeRecordId: input.nativeRecordId,
    })
    return this.createHandle(input, input.resumeSessionId, response.configOptions ?? undefined)
  }

  private async createHandle(input: { sessionKey: string; cwd: string; nativeRecordId?: string }, nativeSessionId: string, configOptions?: SessionConfigOption[]): Promise<AcpV2RuntimeHandle> {
    this.assertOpen()
    if (nativeSessionId.length === 0) throw new Error('ACP v2 session identity is invalid')
    const state = this.ensureSessionState(nativeSessionId)
    if (configOptions !== undefined) replaceSessionConfigOptions(state, configOptions)
    this.flushStartupUpdates(nativeSessionId)
    const handle: AcpV2RuntimeHandle = { sessionKey: input.sessionKey, backend: 'acp-v2', runtimeSessionName: input.sessionKey, cwd: input.cwd, nativeRecordId: input.nativeRecordId ?? randomUUID(), backendSessionId: nativeSessionId, replayCursor: state.replayCursor }
    const write = this.persistRecord(handle, undefined)
    this.initialRecord = { id: handle.nativeRecordId, write }
    await write
    return handle
  }

  private flushStartupUpdates(sessionId: string): boolean {
    if (this.startupUpdates.length === 0) return false
    const state = this.ensureSessionState(sessionId)
    let changed = false
    for (const { params } of this.startupUpdates) {
      if (params.sessionId === sessionId && applySessionUpdate(state, params).changed) changed = true
    }
    this.clearStartupUpdates()
    return changed
  }

  private async newSession(input: { cwd: string }): Promise<NewSessionResponse> {
    if (this.capabilities?.session == null) throw unsupported('session/new')
    const servers = hasAcpCapability(this.capabilities.session.mcp?.http) ? this.options.mcpServers?.() : undefined
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
      || (record.projectRoot !== undefined && record.projectRoot !== this.options.projectRoot)
      || record.nativeSessionId !== input.resumeSessionId
      || record.cleanupState === 'live'
      || record.launch.argv.length !== this.effectiveArgs.length
      || record.launch.argv.some((value, index) => value !== this.effectiveArgs[index])
      || record.launch.envDigest !== this.launchEnvDigest) throw new AcpProtocolError('E_PROTOCOL', 'ACP v2 native record identity or launch provenance mismatch')
    this.restoreAggregate(record)
    const servers = hasAcpCapability(this.capabilities.session.mcp?.http) ? this.options.mcpServers?.() : undefined
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
    const { sessionId } = notification.params
    const opening = this.runtimeHandle === undefined ? this.sessionStart.starting() : undefined
    const knownSession = this.runtimeHandle?.backendSessionId ?? opening?.resumeSessionId
    if (knownSession !== undefined && sessionId !== knownSession) return
    if (knownSession === undefined || (opening !== undefined && this.initialRecord !== undefined)) {
      if (opening === undefined) return
      this.startupUpdateBytes += Buffer.byteLength(JSON.stringify(notification.params))
      if (this.startupUpdates.length >= STARTUP_UPDATE_LIMIT || this.startupUpdateBytes > STARTUP_UPDATE_BYTES) {
        const error = new AcpProtocolError('E_PROTOCOL', 'ACP v2 startup updates exceeded their buffer budget')
        this.handleDisconnect(error)
        void this.shutdown('uncertain').catch(() => undefined)
        return
      }
      this.startupUpdates.push(notification)
      return
    }
    const state = this.ensureSessionState(sessionId)
    const update = notification.params.update
    let promptTurnId: string | undefined
    for (const [turnId, turn] of this.activeTurns) {
      if (turn.sessionId !== sessionId) continue
      if (turn.promptDispatched && !sessionUpdateIsReplay(notification.params)
        && (update.sessionUpdate === 'user_message' || update.sessionUpdate === 'user_message_chunk') && update.messageId
        && (turn.userMessageId === update.messageId || (turn.userMessageId === undefined && !state.entities.messages.has(update.messageId)))) {
        turn.userMessageId = update.messageId
        promptTurnId = turnId
      }
      break
    }
    const applied = applySessionUpdate(state, notification.params, promptTurnId)
    for (const turn of this.activeTurns.values()) {
      if (turn.sessionId === sessionId) for (const event of applied.events) turn.queue.push(event)
    }
    if (applied.changed && this.runtimeHandle !== undefined && this.aggregateTimer === undefined) {
      const handle = this.runtimeHandle
      this.aggregateTimer = setTimeout(() => {
        this.aggregateTimer = undefined
        void this.persistRecord(handle, undefined).catch(error => this.handleDisconnect(error))
      }, AGGREGATE_WRITE_DELAY_MS)
      this.aggregateTimer.unref()
    }
  }

  private clearStartupUpdates(): void {
    this.startupUpdates.length = 0
    this.startupUpdateBytes = 0
  }

  private clearAggregateTimer(): void {
    if (this.aggregateTimer !== undefined) clearTimeout(this.aggregateTimer)
    this.aggregateTimer = undefined
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


  private handleDisconnect(error: Error): void {
    if (this.disconnected) return
    this.disconnected = true
    this.clearAggregateTimer()
    for (const [requestId, turn] of [...this.activeTurns]) {
      turn.signal.abort()
      const startedError = disconnectedPrompt()
      this.finishTurn(requestId, turn, { status: 'failed', error: { message: startedError.message, code: startedError.type } }, startedError)
    }
    if (this.runtimeHandle !== undefined) void this.persistRecord(this.runtimeHandle, undefined, 'uncertain').catch(() => undefined)
    this.options.onDisconnect?.(error)
  }

  private ensureSessionState(sessionId: string): NormalizedSessionState {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created = createSessionState()
    this.sessions.set(sessionId, created)
    return created
  }

  private nativeStarted(child: ChildProcess): NativeStarted {
    if (child.pid === undefined || this.startedAt === undefined || this.launch === undefined) throw new Error('ACP v2 native launch identity is unavailable')
    return { ...this.launch, pid: child.pid, startedAt: this.startedAt }
  }

  private assertOpen(): void {
    if (this.disconnected) throw new AcpProtocolError('E_CLOSED', 'ACP v2 runtime is already stopped')
  }

  private assertSession(handle: AcpV2RuntimeHandle): void {
    this.assertOpen()
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
      projectRoot: this.options.projectRoot,
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

  private persistRecord(handle: AcpV2RuntimeHandle, configOptions?: SessionConfigOption[], cleanupState: AcpV2NativeRecord['cleanupState'] = 'live'): Promise<void> {
    const write = this.recordWrite.then(() => {
      if (cleanupState === 'live' && this.disconnected) return
      const state = this.ensureSessionState(handle.backendSessionId)
      return this.saveRecord(handle, configOptions ?? [...state.configOptions.values()], state.replayCursor, cleanupState)
    })
    this.recordWrite = write.catch(() => undefined)
    return write
  }

  private aggregateFor(sessionId: string): AcpV2NativeAggregate {
    const state = this.ensureSessionState(sessionId)
    const snapshot = <T>(entities: Map<string, SessionEntity<T>>): AcpV2NativeAggregate['messages'] =>
      [...entities.values()].map(entity => this.options.redactSnapshot?.(entity) ?? entity)
    return {
      ...emptyAggregate(),
      messages: snapshot(state.entities.messages),
      toolCalls: snapshot(state.entities.toolCalls),
      plans: snapshot(state.entities.plans),
      terminal: snapshot(state.entities.terminal),
      sessionInfo: snapshot(state.entities.sessionInfo),
      notices: snapshot(state.entities.notices),
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
const disconnectedPrompt = (): AcpProtocolError => new AcpProtocolError('E_DISCONNECTED', 'ACP v2 runtime disconnected during the prompt', { method: 'session/prompt' })
const unsupported = (method: string): AcpProtocolError => new AcpProtocolError('E_UNSUPPORTED_CAPABILITY', `ACP v2 capability is unavailable: ${method}`, { method })
const waitForExit = (child: ChildProcess): Promise<boolean> => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return }
  const exited = (): void => { clearTimeout(timer); resolve(true) }
  const timer = setTimeout(() => { child.off('exit', exited); resolve(false) }, PROCESS_EXIT_TIMEOUT_MS)
  child.once('exit', exited)
})
const awaitExit = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (await waitForExit(child)) return
  child.kill('SIGKILL')
  if (!(await waitForExit(child))) throw new Error('ACP v2 process exit could not be confirmed')
}
const hasStreams = (child: ChildProcess): child is ChildProcessWithoutNullStreams => Boolean(child.stdin && child.stdout && child.stderr)
const sanitizeStderr = (value: string): string => value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/\b(api[_-]?key|token|password|secret)\b\s*[:=]\s*\S+/gi, '$1 [redacted]')
