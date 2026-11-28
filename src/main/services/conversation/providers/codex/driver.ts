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
import { buildCodexTurnStartParams, codexTimestamp, codexWorkspaceWritePolicy, mapCodexTurnStatus, observeCodexTurns } from './CodexAdapterV2'
import type { V2ThreadStartResponse__SandboxPolicy } from './app-server/schema'
import { codexArtifactTools, codexDelegationTools, CodexTurnTools } from './turn-tools'
import { ConversationTurnOutcomeUnknownError, ConversationTurnRejectedError } from '../registry'
import type { ConversationDriverEventListener, ConversationDriverModel, ConversationDriverOpenInput, ConversationDriverSession, ConversationDriverTurnEvent } from '../registry'
import type {
  ConversationCompactThreadInput, ConversationForkThreadInput, ConversationInterruptTurnInput, ConversationResumeThreadInput,
  ConversationStartTurnContext, ConversationSteerTurnInput,
} from '../registry'
import type { ConversationDriverDescriptor, ConversationDriverOption, ConversationDriverSkill, ConversationDriverSkillSource } from '../../../../../shared/conversation/driverCatalog'
import { DaemonError } from '../../../../daemon/errors'
import { driverActionEvidence, driverConfigurationKey, hostUnsupported, type MutableDriverActions } from '../core/catalog'
import { codexProvenanceStatPaths, createCodexProvenanceResolver, readCodexBindingMetadata } from '../core/model-provenance'

const CODEX_CLIENT_NAME = 'crux-codex-app-server'
const TURN_COMPLETION_TIMEOUT = '30 minutes'
const REQUEST_TIMEOUT = '30 seconds'
const TURN_EVENT_BUFFER_LIMIT = 256
const JSON_RPC_PRE_DISPATCH_REJECTIONS = new Set([-32600, -32601, -32602])
const REASONING_EFFORT = 'reasoningEffort'
const taskDisabledFeatures = ['apps', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use', 'hooks',
  'plugins', 'remote_plugin', 'multi_agent', 'multi_agent_v2', 'shell_tool', 'skill_mcp_dependency_install']
const reasoningEffortLabels: Readonly<Record<string, string>> = {
  none: '关', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高',
}

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error))
const definitiveStartRejection = (error: unknown): error is CodexAppServerRequestError =>
  error instanceof CodexAppServerRequestError && (error.operation === 'encode-payload' ||
    (error.operation === 'receive-response' && JSON_RPC_PRE_DISPATCH_REJECTIONS.has(error.code)))
const pipeError = (method: 'read' | 'write', cause: unknown): PlatformError =>
  systemError({ _tag: 'Unknown', module: 'CodexAppServer', method, cause })

function resolveCodexBinaryStamp(environment: NodeJS.ProcessEnv): unknown {
  const executable = environment.CODEX_EXECUTABLE
  if (executable && isAbsolute(executable)) {
    try {
      const info = statSync(executable)
      return [realpathSync.native(executable).toLowerCase(), info.size, info.mtimeMs]
    } catch { /* fall through */ }
  }
  const directories = (environment.PATH ?? environment.Path ?? '').split(delimiter).filter(isAbsolute)
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd'] : ['']
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `codex${suffix}`)
      try { accessSync(candidate, constants.X_OK) } catch { continue }
      const target = suffix === '.cmd' ? join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : candidate
      try {
        const info = statSync(target)
        return [realpathSync.native(target).toLowerCase(), info.size, info.mtimeMs]
      } catch { continue }
    }
  }
  return null
}

export function codexConfigurationKey(environment: NodeJS.ProcessEnv = process.env, fingerprintKey?: Buffer): string {
  const home = environment.CODEX_HOME || join(homedir(), '.codex')
  const artifacts = [
    ...['config.toml', 'auth.json'].map(file => join(home, file)),
    ...codexProvenanceStatPaths(environment),
  ].map(file => {
    try {
      const info = statSync(file)
      return [info.ino, info.mtimeMs, info.size]
    } catch { return null }
  })
  // 使用解析后的实际 Codex 二进制身份代替整串易变 PATH（避免 npm run dev / IDE 注入 node_modules/.bin 击穿缓存）。
  return driverConfigurationKey([home, artifacts, environment.CODEX_EXECUTABLE ?? null, resolveCodexBinaryStamp(environment),
    environment.OPENAI_BASE_URL, environment.OPENAI_API_KEY, environment.CODEX_API_KEY], fingerprintKey)
}

/**
 * 稳定的会话账号/端点绑定指纹：仅覆盖配置目录、当前 provider/base_url 与稳定账号标识，
 * 不包含易变文件 mtime/size、OAuth access_token 刷新或 CC Switch 目录缓存变动。
 */
export function codexBindingKey(environment: NodeJS.ProcessEnv = process.env, fingerprintKey?: Buffer): string {
  const meta = readCodexBindingMetadata(environment)
  return driverConfigurationKey([meta.configHome, meta.activeProvider, meta.activeBaseUrl, meta.authMode, meta.accountIdentity], fingerprintKey)
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
interface ActiveCodexTurn {
  readonly notify: ConversationDriverEventListener
  readonly identifyCompaction?: (turnId: string) => void
  readonly context?: ConversationStartTurnContext
  turnId?: string
}

export class CodexDriver implements ConversationDriverSession {
  private client: CodexClient.CodexAppServerClient['Service'] | undefined
  private stopped = false
  private readonly activeTurns = new Map<string, ActiveCodexTurn>()
  private readonly tools = new CodexTurnTools(threadId => this.activeTurns.get(threadId))
  private readonly observedTurns = new Map<string, Set<string>>()
  private readonly actions: MutableDriverActions = {}

  private constructor(
    private readonly owned: CodexOwnedProcess,
    private readonly scope: Scope.Closeable,
    private readonly stoppedSignal: Deferred.Deferred<never, Error>,
    private readonly configurationKey: string,
    private readonly cwd?: string,
    private readonly ordinaryTask = false,
    private readonly managedExecution = false,
    private readonly ownerScope?: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  static readonly open = (input: ConversationDriverOpenInput): Effect.Effect<CodexDriver, Error> =>
    Effect.gen(function* () {
      const environment = input.env ?? process.env
      const launch = yield* Effect.tryPromise({ try: () => resolveCodexCommand(environment), catch: asError })
      const stoppedSignal = yield* Deferred.make<never, Error>()
      const inputQueue = yield* Queue.unbounded<Uint8Array, PlatformError | Cause.Done>()
      const owned = yield* Effect.tryPromise({
        try: () => spawnCodexOwnedProcess({
          ...launch, instanceId: input.ownerScope === undefined ? input.instanceId : JSON.stringify([input.instanceId, input.ownerScope]),
          directory: input.directory, cwd: input.cwd, assertCanSpawn: input.assertCanSpawn,
          env: { ...environment, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: CODEX_CLIENT_NAME },
          worktreeWriter: input.worktreeWriter,
        }),
        catch: asError,
      })
      const scope = yield* Scope.make()
      const child = owned.child
      const driver = new CodexDriver(owned, scope, stoppedSignal, codexConfigurationKey(environment, input.fingerprintKey),
        input.cwd, input.ordinaryTask, input.managedExecution, input.ownerScope, environment)
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
      yield* observeCodexTurns(client, (threadId, event) => driver.activeTurns.get(threadId)?.notify(event),
        (threadId, turnId) => driver.activeTurns.get(threadId)?.identifyCompaction?.(turnId))
      yield* client.handleServerRequest('item/tool/call', driver.tools.delegate)
      yield* client.handleServerRequest('item/tool/requestUserInput', driver.tools.ask)
      yield* client.handleServerRequest('item/commandExecution/requestApproval', driver.tools.approveCommand)
      yield* client.handleServerRequest('item/fileChange/requestApproval', driver.tools.approveFileChange)
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
      const resolveProvenance = createCodexProvenanceResolver(this.env)
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
        const provenance = resolveProvenance(model.model)
        return {
          id: model.model,
          displayName: model.displayName ?? model.model,
          isDefault: model.isDefault === true,
          ...(provenance.providerId ? { providerId: provenance.providerId } : {}),
          group: provenance.group,
        }
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
          const source: ConversationDriverSkillSource = /\/\.(?:codex|agents)\/plugins\//u.test(skill.path.replaceAll('\\', '/'))
            ? 'app' : skill.scope === 'user' ? 'personal' : skill.scope === 'admin' ? 'other' : skill.scope
          return [{
            name: skill.name,
            displayName: skill.interface?.displayName?.trim().slice(0, 160) || undefined,
            description: (skill.shortDescription ?? skill.interface?.shortDescription ?? skill.description)?.trim().slice(0, 240) || undefined,
            source,
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
        ...(!this.managedExecution && { execution: hostUnsupported('当前 Codex 线程固定为只读模式。') }),
        toolApproval: this.ordinaryTask || this.managedExecution
          ? hostUnsupported('当前任务 Codex 线程使用策略审批规则。')
          : { state: 'verified', source: 'host-policy', detail: '已接入命令与文件修改交互式审批桥接。' },
        ...this.actions,
      }),
    })))

  private verifyThread(
    response: {
      readonly thread: { readonly id: string }; readonly cwd: string; readonly model: string
      readonly sandbox: V2ThreadStartResponse__SandboxPolicy; readonly approvalPolicy: unknown
    },
    model: string,
    cwd: string,
    expectedId?: string,
  ): string {
    if (response.model !== model) throw new Error(`Codex 将 ${model} 解析为 ${response.model}。请选择目录中可用的模型。`)
    const within = (path: string): boolean => {
      const physical = realpathSync.native(path)
      return process.platform === 'win32' ? physical.toLowerCase() === cwd.toLowerCase() : physical === cwd
    }
    const sandbox = response.sandbox
    const delegatedWriter = this.managedExecution && this.ownerScope?.startsWith('delegated:')
    const scopeConfirmed = this.managedExecution
      ? sandbox.type === 'workspaceWrite' && sandbox.networkAccess !== true && sandbox.excludeSlashTmp === true
        && sandbox.excludeTmpdirEnvVar === true && (sandbox.writableRoots ?? []).every(within)
        && (!delegatedWriter || sandbox.networkAccess === false)
      : this.ordinaryTask
        ? sandbox.type === 'readOnly' && sandbox.networkAccess !== true
        : sandbox.type === 'readOnly' || sandbox.type === 'workspaceWrite' || sandbox.type === 'dangerFullAccess'
    if (delegatedWriter && sandbox.type === 'readOnly') {
      throw new DaemonError('E_UNAVAILABLE', 'Codex 返回的是只读沙箱。独立工作树已准备，子回合尚未发送。')
    }
    const approvalOk = this.ordinaryTask || this.managedExecution
      ? response.approvalPolicy === 'never'
      : response.approvalPolicy === 'untrusted' || response.approvalPolicy === 'on-request' || response.approvalPolicy === 'never'
    if (!within(response.cwd) || !scopeConfirmed || !approvalOk || (expectedId !== undefined && response.thread.id !== expectedId)) {
      throw new Error('Codex 未确认原生会话、物理工程目录或允许的沙箱范围。')
    }
    if (this.managedExecution) {
      this.actions.execution = { state: 'unknown', source: 'native-session', detail: '原生线程确认了工作副本写入范围。实际执行以该任务产生的代码和检查证据为准。' }
    } else if (this.ordinaryTask) {
      this.actions.readOnly = { state: 'verified', source: 'native-session', detail: '原生线程确认 readOnly 和 never。' }
      this.actions.planning = this.actions.readOnly
    }
    return response.thread.id
  }

  private taskThreadConfig(cwd: string): Effect.Effect<Record<string, boolean | number | string | string[]> | undefined, Error> {
    if (!this.ordinaryTask && !this.managedExecution) {
      return Effect.succeed({ 'features.default_mode_request_user_input': true })
    }
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
            ...taskDisabledFeatures.filter(name => !this.managedExecution || name !== 'shell_tool')
              .map(name => [`features.${name}`, false] as const),
            ...servers.map(name => [`mcp_servers.${name}.enabled`, false] as const),
            ['features.skip_host_skill_discovery', true] as const,
            ['web_search', 'disabled'] as const,
            ...(this.ownerScope?.startsWith('planning:') ? [
              ['project_doc_max_bytes', 0] as const,
              ['project_doc_fallback_filenames', [] as string[]] as const,
            ] : []),
            ...(this.ownerScope?.startsWith('delegated:') ? [
              ['features.default_mode_request_user_input', true] as const,
            ] : []),
            ...(this.managedExecution ? [
              ['sandbox_workspace_write.writable_roots', [cwd]] as const,
              ['sandbox_workspace_write.exclude_tmpdir_env_var', true] as const,
              ['sandbox_workspace_write.exclude_slash_tmp', true] as const,
              ['sandbox_workspace_write.network_access', false] as const,
            ] : []),
          ])
        },
        catch: asError,
      })),
      Effect.mapError(asError),
    )
  }

  private verifyTaskTools(threadId: string): Effect.Effect<string, Error> {
    if (!this.ordinaryTask && !this.managedExecution) return Effect.succeed(threadId)
    return this.guard(this.requireClient().request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 128 })).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.flatMap(result => result.nextCursor || result.data.some(server => server.runtimeStatus !== 'disabled' || Object.keys(server.tools).length)
        ? Effect.fail(new DaemonError('E_DENIED', 'Codex 未确认任务会话禁用 MCP 工具。'))
        : Effect.succeed(threadId)),
      Effect.mapError(asError),
    )
  }

  private resolveThreadPolicy(runtimeMode?: import('../../../../../shared/conversation/providerPolicy').RuntimeMode): {
    readonly approvalPolicy: 'untrusted' | 'on-request' | 'never'
    readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  } {
    if (this.ordinaryTask) return { approvalPolicy: 'never', sandbox: 'read-only' }
    if (this.managedExecution) return { approvalPolicy: 'never', sandbox: 'workspace-write' }
    if (runtimeMode === 'full-access') return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    if (runtimeMode === 'auto' || runtimeMode === 'auto-accept-edits') return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
    return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }
  }

  readonly startThread = (
    model: string, cwd: string, _artifactMcp?: unknown, runtimeMode?: import('../../../../../shared/conversation/providerPolicy').RuntimeMode,
  ): Effect.Effect<string, Error> => {
    const client = this.requireClient()
    const policy = this.resolveThreadPolicy(runtimeMode)
    return this.taskThreadConfig(cwd).pipe(
      Effect.flatMap(config => this.guard(client.request('thread/start', {
        model, cwd, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, ...(config && { config }),
        ...(!this.ordinaryTask && !this.managedExecution && { dynamicTools: [...codexDelegationTools, ...codexArtifactTools] }),
      }))),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.flatMap(response => Effect.try({
        try: () => this.verifyThread(response, model, cwd),
        catch: asError,
      })),
      Effect.flatMap(threadId => this.verifyTaskTools(threadId)),
      Effect.mapError(asError),
    )
  }

  readonly resumeThread = ({ nativeThreadId, model, cwd }: ConversationResumeThreadInput): Effect.Effect<string, Error> => {
    const policy = this.resolveThreadPolicy()
    return this.taskThreadConfig(cwd).pipe(
      Effect.flatMap(config => this.guard(this.requireClient().request('thread/resume', {
        threadId: nativeThreadId, model, cwd, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox,
        excludeTurns: true, ...(config && { config }),
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
  }

  readonly forkThread: NonNullable<ConversationDriverSession['forkThread']> = input => {
    const policy = this.resolveThreadPolicy(input.runtimeMode)
    return this.taskThreadConfig(input.cwd).pipe(
      Effect.flatMap(config => this.guard(this.requireClient().request('thread/fork', {
        threadId: input.sourceNativeThreadId,
        model: input.model,
        cwd: input.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        excludeTurns: true,
        ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
        ...(config && { config }),
      }))),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.flatMap(response => Effect.try({
        try: () => {
          const forkedId = this.verifyThread(response, input.model, input.cwd)
          if (forkedId === input.sourceNativeThreadId) {
            throw new Error('Codex 原生派生返回了与原线程相同的线程编号。')
          }
          return forkedId
        },
        catch: asError,
      })),
      Effect.flatMap(threadId => this.verifyTaskTools(threadId)),
      Effect.mapError(asError),
    )
  }

  readonly rollbackThread: NonNullable<ConversationDriverSession['rollbackThread']> = ({ nativeThreadId, numTurns }) => {
    const driver = this
    return Effect.gen(function* () {
      if (driver.activeTurns.has(nativeThreadId)) {
        return yield* Effect.fail(new DaemonError('E_BUSY', 'Codex 原线程仍持有活动回合，无法原地回退。'))
      }
      if (!Number.isInteger(numTurns) || numTurns <= 0) return
      const client = driver.requireClient()
      let remaining = numTurns
      let beforeTurnId: string | undefined
      let cursor: string | null = null
      const visited = new Set<string | null>()
      while (remaining > 0) {
        if (visited.has(cursor)) {
          return yield* Effect.fail(new Error('Codex 回合历史分页游标重复，无法确认回退位置。'))
        }
        visited.add(cursor)
        const page: { readonly data: ReadonlyArray<{ readonly id: string }>; readonly nextCursor?: string | null } = yield* driver.guard(client.request('thread/turns/list', {
          threadId: nativeThreadId,
          cursor,
          limit: Math.min(remaining, 100),
          sortDirection: 'desc',
          itemsView: 'summary',
        })).pipe(Effect.timeout(REQUEST_TIMEOUT))
        for (const turn of page.data) {
          beforeTurnId = turn.id
          if (--remaining === 0) break
        }
        cursor = page.nextCursor ?? null
        if (cursor === null) break
      }
      if (beforeTurnId === undefined) {
        yield* driver.guard(client.request('thread/read', { threadId: nativeThreadId, includeTurns: false }))
          .pipe(Effect.timeout(REQUEST_TIMEOUT))
      } else {
        yield* driver.guard(client.request('thread/revert', { threadId: nativeThreadId, beforeTurnId }))
          .pipe(Effect.timeout(REQUEST_TIMEOUT))
      }
      driver.observedTurns.delete(nativeThreadId)
    }).pipe(Effect.mapError(asError))
  }

  readonly detachThread: NonNullable<ConversationDriverSession['detachThread']> = ({ nativeThreadId, assertCurrent }) =>
    Effect.suspend(() => {
      try {
        assertCurrent()
        if (this.activeTurns.has(nativeThreadId)) throw new DaemonError('E_BUSY', 'Codex 原线程仍持有活动回合。')
        return this.guard(this.requireClient().request('thread/unsubscribe', { threadId: nativeThreadId }))
      } catch (error) {
        return Effect.fail(asError(error))
      }
    }).pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.map(({ status }) => {
      this.observedTurns.delete(nativeThreadId)
      return status
    }), Effect.mapError(asError))

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

  readonly respondToRuntimeRequest: NonNullable<ConversationDriverSession['respondToRuntimeRequest']> = input =>
    this.activeControl(input).pipe(Effect.andThen(this.tools.respond(input)))

  private rememberTurn(threadId: string, turnId: string): void {
    const known = this.observedTurns.get(threadId) ?? new Set<string>()
    known.add(turnId)
    if (known.size > TURN_EVENT_BUFFER_LIMIT) {
      const oldest = known.values().next().value
      if (oldest !== undefined) known.delete(oldest)
    }
    this.observedTurns.set(threadId, known)
  }

  readonly compactThread = (input: ConversationCompactThreadInput): Effect.Effect<string, Error> => {
    const driver = this
    const { nativeThreadId: threadId, context, onEvent } = input
    return Effect.gen(function* () {
      if (input.instructions?.trim()) return yield* Effect.fail(new ConversationTurnRejectedError('Codex 原生压缩不接受额外指令。'))
      yield* driver.verifyTaskTools(threadId).pipe(Effect.mapError(cause => new ConversationTurnRejectedError(cause.message, { cause })))
      if (context.assertAuthorized) {
        yield* Effect.tryPromise({ try: context.assertAuthorized, catch: cause => new ConversationTurnRejectedError(asError(cause).message, { cause }) })
      }
      yield* Effect.try({ try: context.assertCurrent, catch: cause => new ConversationTurnRejectedError(asError(cause).message, { cause }) })
      if (driver.stopped || driver.activeTurns.has(threadId)) return yield* Effect.fail(new ConversationTurnRejectedError('Codex 原线程仍持有活动回合。'))

      const completion = yield* Deferred.make<string, Error>()
      const priorTurns = driver.observedTurns.get(threadId)
      const pending: ConversationDriverTurnEvent[] = []
      let acknowledged = false
      let candidate: string | undefined
      let failed = false
      const fail = (cause: unknown): void => {
        failed = true
        Effect.runSync(Deferred.fail(completion, new ConversationTurnOutcomeUnknownError(active.turnId ?? '', { cause })))
      }
      const deliver: ConversationDriverEventListener = event => {
        if (failed || event.turnId !== active.turnId) return
        try {
          onEvent(event)
          if (event.type === 'turn-completed' && event.status !== 'running') {
            if (event.status === 'completed') {
              driver.actions.compact = { state: 'verified', source: 'native-session', detail: '原生压缩由同一回合的压缩记录和终态确认。' }
            }
            Effect.runSync(Deferred.succeed(completion, event.turnId))
          }
        } catch (cause) { fail(cause) }
      }
      const bind = (): void => {
        if (failed || !acknowledged || !candidate || active.turnId) return
        active.turnId = candidate
        driver.rememberTurn(threadId, candidate)
        deliver({ type: 'turn-receipt', turnId: candidate })
        for (const event of pending.splice(0)) deliver(event)
      }
      const active: ActiveCodexTurn = {
        notify(event) {
          if (active.turnId) return deliver(event)
          if (failed || priorTurns?.has(event.turnId)) return
          if (pending.length >= TURN_EVENT_BUFFER_LIMIT) return fail(new Error('Codex 原生压缩待核对事件超过上限。'))
          pending.push(event)
        },
        identifyCompaction(turnId) {
          if (active.turnId === turnId || priorTurns?.has(turnId) || failed) return
          if (candidate && candidate !== turnId) return fail(new Error('同一压缩窗口出现多个原生回合。'))
          candidate = turnId
          bind()
        },
      }
      driver.activeTurns.set(threadId, active)
      return yield* Effect.gen(function* () {
        yield* driver.guard(driver.requireClient().request('thread/compact/start', { threadId })).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError(error => pending.length === 0 && !candidate && !failed && definitiveStartRejection(error)
            ? new ConversationTurnRejectedError(error.message, { cause: error })
            : new ConversationTurnOutcomeUnknownError('', { cause: error })),
        )
        acknowledged = true
        bind()
        return yield* driver.guard(Deferred.await(completion)).pipe(
          Effect.timeout(TURN_COMPLETION_TIMEOUT),
          Effect.mapError(error => new ConversationTurnOutcomeUnknownError(active.turnId ?? '', { cause: error })),
        )
      }).pipe(Effect.ensuring(Effect.sync(() => { driver.activeTurns.delete(threadId) })))
    }).pipe(Effect.mapError(asError))
  }

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
          if (early.length < TURN_EVENT_BUFFER_LIMIT) early.push(event)
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
      const active: ActiveCodexTurn = { notify: receive, context }
      driver.activeTurns.set(threadId, active)
      return yield* Effect.gen(function* () {
        const params = yield* Effect.try({
          try: () => buildCodexTurnStartParams({
            nativeThreadId: threadId, cwd, model, text, effort, attachments: context?.attachments,
            managedExecution: driver.managedExecution,
            ordinaryTask: driver.ordinaryTask,
            runtimeMode: context?.runtimeMode,
            interactionMode: context?.interactionMode,
          }),
          catch: error => new ConversationTurnRejectedError(asError(error).message, { cause: error }),
        })
        const started = yield* driver.guard(client.request('turn/start', params)).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError(error => early.length === 0 && definitiveStartRejection(error)
            ? new ConversationTurnRejectedError(error.message, { cause: error })
            : new ConversationTurnOutcomeUnknownError('', { cause: error })),
        )
        turnId = started.turn.id
        active.turnId = turnId
        driver.rememberTurn(threadId, turnId)
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
      }).pipe(Effect.ensuring(Effect.sync(() => {
        driver.tools.settle(threadId, turnId)
        driver.activeTurns.delete(threadId)
      })))
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
