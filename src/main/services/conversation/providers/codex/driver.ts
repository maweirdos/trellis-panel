import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type * as Cause from 'effect/Cause'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { systemError, type PlatformError } from 'effect/PlatformError'
import * as Scope from 'effect/Scope'
import * as Stdio from 'effect/Stdio'
import * as Stream from 'effect/Stream'
import * as Sink from 'effect/Sink'
import * as Queue from 'effect/Queue'
import * as CodexClient from './app-server/client'
import { CodexAppServerRequestError } from './app-server/errors'
import { spawnCodexOwnedProcess, type CodexOwnedProcess } from './process-owner'
import { resolveNodeRuntime } from '../../../acp/managed-node'
import { buildCodexTurnStartParams, codexTimestamp, mapCodexTurnStatus, observeCodexTurns } from './CodexAdapterV2'
import { ConversationTurnOutcomeUnknownError, ConversationTurnRejectedError } from '../registry'
import type { ConversationDriverEventListener, ConversationDriverModel, ConversationDriverOpenInput, ConversationDriverSession, ConversationDriverTurnEvent } from '../registry'

const CODEX_CLIENT_NAME = 'crux-codex-app-server'
const TURN_COMPLETION_TIMEOUT = '30 minutes'
const REQUEST_TIMEOUT = '30 seconds'
const JSON_RPC_PRE_DISPATCH_REJECTIONS = new Set([-32600, -32601, -32602])

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error))
const pipeError = (method: 'read' | 'write', cause: unknown): PlatformError =>
  systemError({ _tag: 'Unknown', module: 'CodexAppServer', method, cause })

/**
 * Windows npm shims are `.cmd`/`.ps1`; a bare `codex` cannot be spawned without a shell.
 * Resolve the real Node entry so the daemon never relies on shell argument parsing.
 */
export const resolveCodexCommand = async (environment: NodeJS.ProcessEnv = process.env): Promise<{ readonly command: string; readonly args: readonly string[] }> => {
  const executable = environment.CODEX_EXECUTABLE
  if (executable && isAbsolute(executable)) {
    try { accessSync(executable, constants.X_OK); return { command: executable, args: ['app-server'] } } catch { /* fall through to PATH */ }
  }
  const directories = (environment.PATH ?? environment.Path ?? '').split(delimiter).filter(isAbsolute)
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd'] : ['']
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `codex${suffix}`)
      try { accessSync(candidate, constants.X_OK) } catch { continue }
      if (suffix !== '.cmd') return { command: candidate, args: ['app-server'] }
      const script = join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      try { accessSync(script, constants.R_OK) } catch { continue }
      const pathNode = directories.map(path => join(path, 'node.exe')).find(path => {
        try { accessSync(path, constants.X_OK); return true } catch { return false }
      })
      const node = await resolveNodeRuntime({ resourcesPath: process.resourcesPath, pathNode })
      return { command: node.path, args: [script, 'app-server'] }
    }
  }
  throw new Error('Codex executable was not found. Install the Codex CLI or set CODEX_EXECUTABLE to its absolute path.')
}

/** One app-server process, reused by every thread this host opens. */
export class CodexDriver implements ConversationDriverSession {
  private client: CodexClient.CodexAppServerClient['Service'] | undefined
  private stopped = false
  private readonly activeTurns = new Map<string, ConversationDriverEventListener>()

  private constructor(
    private readonly owned: CodexOwnedProcess,
    private readonly scope: Scope.Closeable,
    private readonly stoppedSignal: Deferred.Deferred<never, Error>,
  ) {}

  static readonly open = (input: ConversationDriverOpenInput): Effect.Effect<CodexDriver, Error> =>
    Effect.gen(function* () {
      const environment = input.env ?? process.env
      const launch = yield* Effect.tryPromise({ try: () => resolveCodexCommand(environment), catch: asError })
      const stoppedSignal = yield* Deferred.make<never, Error>()
      const inputQueue = yield* Queue.unbounded<Uint8Array, PlatformError | Cause.Done>()
      const owned = yield* Effect.tryPromise({
        try: () => spawnCodexOwnedProcess({
          ...launch, instanceId: input.instanceId, directory: input.directory, cwd: input.cwd, assertCanSpawn: input.assertCanSpawn,
          env: { ...environment, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: CODEX_CLIENT_NAME },
        }),
        catch: asError,
      })
      const scope = yield* Scope.make()
      const child = owned.child
      const driver = new CodexDriver(owned, scope, stoppedSignal)
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-16_384) })
      child.on('error', error => driver.stopTransport(error))
      child.stdin.on('error', error => driver.stopTransport(error))
      child.once('exit', (code, signal) => {
        driver.stopTransport(new Error(stderr.trim() || `Codex App Server process exited (${signal ?? code}).`))
      })
      input.onSpawn(driver)
      yield* driver.guard(Effect.tryPromise({ try: () => owned.ready, catch: asError }))
      yield* Effect.try({ try: input.assertCanSpawn, catch: asError })
      void (async () => {
        try {
          for await (const chunk of child.stdout) {
            if (!await Effect.runPromise(Queue.offer(inputQueue, chunk as Uint8Array))) break
          }
          Effect.runSync(Queue.end(inputQueue))
        } catch (error) {
          Effect.runSync(Queue.fail(inputQueue, pipeError('read', error)))
        }
      })()
      const stdio = Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.fromQueue(inputQueue),
        stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.tryPromise({
          try: () => new Promise<void>((resolve, reject) => {
            child.stdin.write(chunk, error => error ? reject(error) : resolve())
          }),
          catch: error => pipeError('write', error),
        })),
        stderr: () => Sink.drain,
      })
      yield* Scope.addFinalizer(scope, Queue.end(inputQueue))
      const client = yield* CodexClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope))
      driver.client = client
      yield* client.awaitTermination.pipe(
        Effect.catch(error => Effect.sync(() => driver.stopTransport(asError(error)))),
        Effect.forkIn(scope),
      )
      yield* observeCodexTurns(client, (threadId, event) => driver.activeTurns.get(threadId)?.(event))
      yield* driver.guard(client.request('initialize', { clientInfo: { name: CODEX_CLIENT_NAME, title: 'Crux', version: '0.1.0' }, capabilities: { experimentalApi: true } })).pipe(Effect.timeout(REQUEST_TIMEOUT))
      yield* driver.guard(client.notify('initialized', undefined))
      return driver
    }).pipe(
      Effect.mapError(asError),
    )

  private stopTransport(error: Error): void {
    this.stopped = true
    Effect.runSync(Deferred.fail(this.stoppedSignal, error))
  }

  private requireClient(): CodexClient.CodexAppServerClient['Service'] {
    if (!this.client) throw new Error('Codex app-server has not completed its handshake.')
    return this.client
  }

  /**
   * Races an effect against process exit so no RPC waits on a dead app-server. A turn/start whose
   * receipt is lost is reported as unknown: the prompt may already be inside the engine.
   */
  private guard<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | Error> {
    const stopped = Deferred.await(this.stoppedSignal)
    return this.stopped ? stopped : Effect.raceFirst(effect, stopped)
  }

  isAvailable(): boolean { return !this.stopped }

  /** The live child process, when one has been spawned. */
  process(): ChildProcessWithoutNullStreams { return this.owned.child }
  readonly listModels = (): Effect.Effect<readonly ConversationDriverModel[], Error> => {
    const client = this.requireClient()
    return this.guard(client.request('model/list', {})).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.map(response => response.data.map(model => ({ id: model.model, displayName: model.displayName ?? model.model, isDefault: model.isDefault === true }))),
      Effect.mapError(asError),
    )
  }

  readonly startThread = (model: string, cwd: string): Effect.Effect<string, Error> => {
    const client = this.requireClient()
    return this.guard(client.request('thread/start', { model, cwd, approvalPolicy: 'never', sandbox: 'read-only' })).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.flatMap(response => Effect.try({
        try: () => {
          if (response.model !== model) throw new Error(`Codex 将 ${model} 解析为 ${response.model}。请选择目录中可用的模型。`)
          const physicalCwd = realpathSync.native(response.cwd)
          if ((process.platform === 'win32' ? physicalCwd.toLowerCase() !== cwd.toLowerCase() : physicalCwd !== cwd)
            || response.sandbox.type !== 'readOnly' || response.approvalPolicy !== 'never') {
            throw new Error('Codex 未确认当前工程目录和只读模式。')
          }
          return response.thread.id
        },
        catch: asError,
      })),
      Effect.mapError(asError),
    )
  }

  /**
   * Registers listeners before turn/start so the first delta is never lost, then resolves
   * only when Codex reports turn/completed for this exact turn. A late completion belonging
   * to another turn never settles this one.
   */
  readonly startTurn = (threadId: string, cwd: string, text: string, model: string, listener: ConversationDriverEventListener): Effect.Effect<string, Error> => {
    const client = this.requireClient()
    const driver = this
    return Effect.gen(function* () {
      if (driver.stopped || driver.activeTurns.has(threadId)) return yield* Effect.fail(new ConversationTurnRejectedError('Codex thread is unavailable for a new turn.'))
      const completion = yield* Deferred.make<void, Error>()
      let turnId: string | undefined
      let overflow = false
      let accepted = false
      const early: ConversationDriverTurnEvent[] = []
      const receive: ConversationDriverEventListener = event => {
        if (!turnId) {
          if (early.length < 256) early.push(event)
          else overflow = true
          return
        }
        if (event.turnId !== turnId) return
        try {
          if (event.type === 'turn-receipt') {
            listener(event)
            return
          }
          if (!accepted) {
            accepted = true
            listener(event.type === 'turn-accepted' ? event : { type: 'turn-accepted', turnId })
          }
          if (event.type === 'turn-accepted') return
          listener(event)
          if (event.type === 'turn-completed' && event.status !== 'running') Effect.runSync(Deferred.succeed(completion, undefined))
        } catch (error) {
          Effect.runSync(Deferred.fail(completion, asError(error)))
        }
      }
      driver.activeTurns.set(threadId, receive)
      return yield* Effect.gen(function* () {
        const started = yield* driver.guard(client.request('turn/start', buildCodexTurnStartParams({ nativeThreadId: threadId, cwd, model, text }))).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError(error => error instanceof CodexAppServerRequestError
            && early.length === 0
            && (error.operation === 'encode-payload'
              || (error.operation === 'receive-response' && JSON_RPC_PRE_DISPATCH_REJECTIONS.has(error.code)))
            ? new ConversationTurnRejectedError(error.message, { cause: error })
            : new ConversationTurnOutcomeUnknownError('', { cause: error })),
        )
        turnId = started.turn.id
        receive({ type: 'turn-receipt', turnId })
        if (overflow) return yield* Effect.fail(new ConversationTurnOutcomeUnknownError(turnId))
        for (const event of early) receive(event)
        if (started.turn.startedAt !== null && started.turn.startedAt !== undefined) {
          receive({ type: 'turn-accepted', turnId, nativeStartedAt: DateTime.formatIso(codexTimestamp(started.turn.startedAt)) })
        }
        if (started.turn.status !== 'inProgress') {
          for (const item of started.turn.items) {
            if (item.type === 'agentMessage') receive({ type: 'text-final', turnId, itemId: item.id, text: item.text })
          }
          receive({ type: 'turn-completed', turnId, status: mapCodexTurnStatus(started.turn.status), error: started.turn.error?.message })
        }
        yield* driver.guard(Deferred.await(completion)).pipe(
          Effect.timeout(TURN_COMPLETION_TIMEOUT),
          Effect.mapError(error => new ConversationTurnOutcomeUnknownError(started.turn.id, { cause: error })),
        )
        return turnId
      }).pipe(Effect.ensuring(Effect.sync(() => { driver.activeTurns.delete(threadId) })))
    }).pipe(Effect.mapError(asError))
  }

  /**
   * Kills the app-server and resolves only when the OS confirms the process exited.
   * A deadline that fires without an exit rejects: an unconfirmed kill is reported, not assumed.
   */
  readonly close = (): Effect.Effect<void, Error> => {
    const driver = this
    return Effect.sync(() => driver.stopTransport(new Error('Codex App Server is closing.'))).pipe(
      Effect.andThen(Scope.close(driver.scope, Exit.void)),
      Effect.ensuring(Effect.promise(() => driver.owned.close())),
      Effect.catchDefect(error => Effect.fail(asError(error))),
    )
  }
}
