import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
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
import type { ConversationInterruptTurnInput, ConversationResumeThreadInput, ConversationStartTurnContext, ConversationSteerTurnInput } from '../registry'
import type { ConversationDriverDescriptor, ConversationDriverOption, ConversationDriverSkill } from '../../../../../shared/conversation/driverCatalog'
import { DaemonError } from '../../../../daemon/errors'
import { driverActionEvidence, driverConfigurationKey, hostUnsupported, type MutableDriverActions } from '../core/catalog'

const CODEX_CLIENT_NAME = 'crux-codex-app-server'
const TURN_COMPLETION_TIMEOUT = '30 minutes'
const REQUEST_TIMEOUT = '30 seconds'
const JSON_RPC_PRE_DISPATCH_REJECTIONS = new Set([-32600, -32601, -32602])
const REASONING_EFFORT = 'reasoningEffort'
const taskDisabledFeatures = ['apps', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use', 'hooks',
  'plugins', 'remote_plugin', 'multi_agent', 'multi_agent_v2', 'shell_tool', 'skill_mcp_dependency_install']
const reasoningEffortLabels: Readonly<Record<string, string>> = {
  none: '关', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高',
}

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error))
const pipeError = (method: 'read' | 'write', cause: unknown): PlatformError =>
  systemError({ _tag: 'Unknown', module: 'CodexAppServer', method, cause })

export function codexConfigurationKey(environment: NodeJS.ProcessEnv = process.env): string {
  const home = environment.CODEX_HOME || join(homedir(), '.codex')
  const artifacts = ['config.toml', 'auth.json'].map(file => {
    try {
      const info = statSync(join(home, file))
      return [info.ino, info.mtimeMs, info.size]
    } catch { return null }
  })
  return driverConfigurationKey([home, artifacts, environment.CODEX_EXECUTABLE, environment.PATH ?? environment.Path,
    environment.OPENAI_BASE_URL, environment.OPENAI_API_KEY, environment.CODEX_API_KEY])
}

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
  private readonly activeTurns = new Map<string, { notify: ConversationDriverEventListener; turnId?: string }>()
  private readonly actions: MutableDriverActions = {}

  private constructor(
    private readonly owned: CodexOwnedProcess,
    private readonly scope: Scope.Closeable,
    private readonly stoppedSignal: Deferred.Deferred<never, Error>,
    private readonly configurationKey: string,
    private readonly cwd?: string,
    private readonly ordinaryTask = false,
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
      const driver = new CodexDriver(owned, scope, stoppedSignal, codexConfigurationKey(environment), input.cwd, input.ordinaryTask)
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
      yield* observeCodexTurns(client, (threadId, event) => driver.activeTurns.get(threadId)?.notify(event))
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
  private nativeModels() {
    const client = this.requireClient()
    return this.guard(client.request('model/list', {})).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.map(response => response.data.filter(model => !model.hidden)),
      Effect.mapError(asError),
    )
  }

  private readonly modelEfforts = new Map<string, ConversationDriverOption>()

  private modelCatalog() {
    return this.nativeModels().pipe(Effect.map(nativeModels => {
      this.modelEfforts.clear()
      const models: ConversationDriverModel[] = nativeModels.map(model => {
        const choices = model.supportedReasoningEfforts.map(({ reasoningEffort }) => ({
          value: reasoningEffort, label: reasoningEffortLabels[reasoningEffort] ?? reasoningEffort,
        }))
        if (choices.length) {
          this.modelEfforts.set(model.model, {
            id: REASONING_EFFORT, label: '推理强度', category: 'reasoning', modelId: model.model, turnSelectable: true,
            current: choices.some(choice => choice.value === model.defaultReasoningEffort) ? model.defaultReasoningEffort : undefined,
            choices,
          })
        }
        return { id: model.model, displayName: model.displayName ?? model.model, isDefault: model.isDefault === true }
      })
      return { models, options: [...this.modelEfforts.values()] }
    }))
  }

  readonly listModels = (): Effect.Effect<readonly ConversationDriverModel[], Error> =>
    this.modelCatalog().pipe(Effect.map(catalog => catalog.models))

  private nativeSkills(): Effect.Effect<readonly ConversationDriverSkill[] | undefined> {
    const cwd = this.cwd
    if (!cwd || this.ordinaryTask) return Effect.succeed(undefined)
    return this.guard(this.requireClient().request('skills/list', { cwds: [cwd] })).pipe(
      Effect.timeout('2 seconds'),
      Effect.map(({ data }) => {
        const seen = new Set<string>()
        const matching = data.find(entry => process.platform === 'win32'
          ? entry.cwd.toLowerCase() === cwd.toLowerCase() : entry.cwd === cwd)
        return matching?.skills.flatMap(skill => {
          if (!skill.enabled || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/u.test(skill.name) ||
            !/[a-zA-Z]/u.test(skill.name) || seen.has(skill.name)) return []
          seen.add(skill.name)
          return [{
            name: skill.name,
            displayName: skill.interface?.displayName?.trim().slice(0, 160) || undefined,
            description: (skill.shortDescription ?? skill.interface?.shortDescription ?? skill.description)?.trim().slice(0, 240) || undefined,
          }]
        }).slice(0, 256)
      }),
      Effect.catch(() => Effect.succeed(undefined)),
    )
  }

  readonly describe = (): Effect.Effect<ConversationDriverDescriptor, Error> =>
    Effect.all({ catalog: this.modelCatalog(), skills: this.nativeSkills() }, { concurrency: 'unbounded' }).pipe(Effect.map(({ catalog, skills }) => ({
      source: 'native-catalog', observedAt: new Date().toISOString(), configurationKey: this.configurationKey, ...catalog,
      ...(skills?.length ? { skills } : {}),
      actions: driverActionEvidence({
        chat: { state: 'verified', source: 'native-catalog', detail: '原生 app-server 已返回模型目录。' },
        steer: { state: 'verified', source: 'host-policy', detail: 'turn/steer 绑定当前原生回合，回执确认目标回合。' },
        planning: hostUnsupported('团队规划的批准工具和项目资料边界尚未接入该入口。'),
        execution: hostUnsupported('当前 Codex 线程固定为只读模式。'),
        toolApproval: hostUnsupported('当前 Codex 线程拒绝临时审批。'),
        ...this.actions,
      }),
    })))

  private verifyThread(
    response: { readonly thread: { readonly id: string }; readonly cwd: string; readonly model: string; readonly sandbox: { readonly type: string }; readonly approvalPolicy: unknown },
    model: string,
    cwd: string,
    expectedId?: string,
  ): string {
    if (response.model !== model) throw new Error(`Codex 将 ${model} 解析为 ${response.model}。请选择目录中可用的模型。`)
    const physicalCwd = realpathSync.native(response.cwd)
    if ((process.platform === 'win32' ? physicalCwd.toLowerCase() !== cwd.toLowerCase() : physicalCwd !== cwd)
      || response.sandbox.type !== 'readOnly' || response.approvalPolicy !== 'never'
      || (expectedId !== undefined && response.thread.id !== expectedId)) {
      throw new Error('Codex 未确认原生会话身份、工程目录与只读模式。')
    }
    this.actions.readOnly = { state: 'verified', source: 'native-session', detail: '原生线程确认 readOnly 和 never。' }
    return response.thread.id
  }

  private taskThreadConfig(cwd: string): Effect.Effect<Record<string, boolean | string> | undefined, Error> {
    if (!this.ordinaryTask) return Effect.succeed(undefined)
    return this.guard(this.requireClient().request('config/read', { cwd })).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.flatMap(({ config }) => Effect.try({
        try: () => {
          const raw = config.mcp_servers
          if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
            throw new DaemonError('E_CONFLICT', '无法核实 Codex 配置中的 MCP 工具。')
          }
          const servers = Object.keys(raw ?? {})
          if (servers.some(name => !/^[\w-]+$/.test(name))) throw new DaemonError('E_CONFLICT', 'Codex MCP 工具无法安全禁用。')
          return Object.fromEntries([
            ...taskDisabledFeatures.map(name => [`features.${name}`, false] as const),
            ...servers.map(name => [`mcp_servers.${name}.enabled`, false] as const),
            ['features.skip_host_skill_discovery', true] as const,
            ['web_search', 'disabled'] as const,
          ])
        },
        catch: asError,
      })),
      Effect.mapError(asError),
    )
  }

  private verifyTaskTools(threadId: string): Effect.Effect<string, Error> {
    if (!this.ordinaryTask) return Effect.succeed(threadId)
    return this.guard(this.requireClient().request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 128 })).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.flatMap(result => result.nextCursor || result.data.some(server => server.runtimeStatus !== 'disabled' || Object.keys(server.tools).length)
        ? Effect.fail(new DaemonError('E_DENIED', 'Codex 未确认任务会话禁用 MCP 工具。'))
        : Effect.succeed(threadId)),
      Effect.mapError(asError),
    )
  }

  readonly startThread = (model: string, cwd: string): Effect.Effect<string, Error> => {
    const client = this.requireClient()
    return this.taskThreadConfig(cwd).pipe(
      Effect.flatMap(config => this.guard(client.request('thread/start', { model, cwd, approvalPolicy: 'never', sandbox: 'read-only', ...(config && { config }) }))),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.flatMap(response => Effect.try({
        try: () => this.verifyThread(response, model, cwd),
        catch: asError,
      })),
      Effect.flatMap(threadId => this.verifyTaskTools(threadId)),
      Effect.mapError(asError),
    )
  }

  readonly resumeThread = ({ nativeThreadId, model, cwd }: ConversationResumeThreadInput): Effect.Effect<string, Error> =>
    this.taskThreadConfig(cwd).pipe(
      Effect.flatMap(config => this.guard(this.requireClient().request('thread/resume', {
        threadId: nativeThreadId, model, cwd, approvalPolicy: 'never', sandbox: 'read-only', excludeTurns: true, ...(config && { config }),
      }))),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.flatMap(response => Effect.try({
        try: () => {
          const original = this.verifyThread(response, model, cwd, nativeThreadId)
          this.actions.resume = { state: 'verified', source: 'native-session', detail: '原生恢复回执确认了同一线程。' }
          return original
        },
        catch: asError,
      })),
      Effect.flatMap(threadId => this.verifyTaskTools(threadId)),
      Effect.mapError(asError),
    )

  readonly detachThread: NonNullable<ConversationDriverSession['detachThread']> = ({ nativeThreadId, assertCurrent }) =>
    Effect.suspend(() => {
      try {
        assertCurrent()
        if (this.activeTurns.has(nativeThreadId)) throw new DaemonError('E_BUSY', 'Codex 原线程仍持有活动回合。')
        return this.guard(this.requireClient().request('thread/unsubscribe', { threadId: nativeThreadId }))
      } catch (error) {
        return Effect.fail(asError(error))
      }
    }).pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.map(({ status }) => status), Effect.mapError(asError))

  private activeControl({ nativeThreadId, turnId }: ConversationInterruptTurnInput): Effect.Effect<void, DaemonError> {
    return Effect.suspend(() => turnId && this.activeTurns.get(nativeThreadId)?.turnId === turnId
      ? Effect.void
      : Effect.fail(new DaemonError('E_CONFLICT', 'Codex 控制请求与当前活动回合不一致。')))
  }

  readonly interruptTurn = (input: ConversationInterruptTurnInput): Effect.Effect<void, Error> =>
    this.activeControl(input).pipe(Effect.flatMap(() =>
      this.guard(this.requireClient().request('turn/interrupt', { threadId: input.nativeThreadId, turnId: input.turnId })),
    ), Effect.timeout(REQUEST_TIMEOUT), Effect.asVoid, Effect.mapError(asError))

  readonly steerTurn = (input: ConversationSteerTurnInput): Effect.Effect<void, Error> =>
    this.activeControl(input).pipe(Effect.flatMap(() =>
      this.guard(this.requireClient().request('turn/steer', {
        threadId: input.nativeThreadId, expectedTurnId: input.turnId, input: [{ type: 'text', text: input.text, text_elements: [] }],
      })),
    ), Effect.timeout(REQUEST_TIMEOUT), Effect.asVoid, Effect.mapError(asError))

  /**
   * Registers listeners before turn/start so the first delta is never lost, then resolves
   * only when Codex reports turn/completed for this exact turn. A late completion belonging
   * to another turn never settles this one.
   */
  readonly startTurn = (
    threadId: string, cwd: string, text: string, model: string, listener: ConversationDriverEventListener,
    context?: ConversationStartTurnContext,
  ): Effect.Effect<string, Error> => {
    const client = this.requireClient()
    const driver = this
    return Effect.gen(function* () {
      yield* driver.verifyTaskTools(threadId).pipe(Effect.mapError(cause => new ConversationTurnRejectedError(cause.message, { cause })))
      let effort: string | undefined
      if (context?.modelOptions?.length) {
        const selected = context.modelOptions[0]
        if (context.modelOptions.length !== 1 || selected.id !== REASONING_EFFORT || typeof selected.value !== 'string') {
          return yield* Effect.fail(new ConversationTurnRejectedError('当前 Codex 回合仅接受目录提供的推理强度。'))
        }
        if (!driver.modelEfforts.has(model)) {
          yield* driver.modelCatalog().pipe(Effect.mapError(error => new ConversationTurnRejectedError(error.message, { cause: error })))
        }
        if (!driver.modelEfforts.get(model)?.choices.some(choice => choice.value === selected.value)) {
          return yield* Effect.fail(new ConversationTurnRejectedError('此 Codex 模型不支持所选推理强度。'))
        }
        effort = selected.value
      }
      if (context?.assertAuthorized) {
        yield* Effect.tryPromise({ try: context.assertAuthorized, catch: cause => new ConversationTurnRejectedError(asError(cause).message, { cause }) })
      }
      yield* Effect.try({ try: () => context?.assertCurrent(), catch: cause => new ConversationTurnRejectedError(asError(cause).message, { cause }) })
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
      const active: { notify: ConversationDriverEventListener; turnId?: string } = { notify: receive }
      driver.activeTurns.set(threadId, active)
      return yield* Effect.gen(function* () {
        const params = yield* Effect.try({
          try: () => buildCodexTurnStartParams({ nativeThreadId: threadId, cwd, model, text, effort, attachments: context?.attachments }),
          catch: error => new ConversationTurnRejectedError(asError(error).message, { cause: error }),
        })
        const started = yield* driver.guard(client.request('turn/start', params)).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError(error => error instanceof CodexAppServerRequestError
            && early.length === 0
            && (error.operation === 'encode-payload'
              || (error.operation === 'receive-response' && JSON_RPC_PRE_DISPATCH_REJECTIONS.has(error.code)))
            ? new ConversationTurnRejectedError(error.message, { cause: error })
            : new ConversationTurnOutcomeUnknownError('', { cause: error })),
        )
        turnId = started.turn.id
        active.turnId = turnId
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
