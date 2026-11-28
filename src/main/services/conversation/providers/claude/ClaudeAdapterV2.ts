import { randomUUID } from 'node:crypto'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ModelInfo, Options, PermissionMode, PermissionResult, Query, SDKMessage, SDKUserMessage, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import * as Effect from 'effect/Effect'
import type { ConversationDriverDescriptor } from '../../../../../shared/conversation/driverCatalog'
import type { ProviderInteractionMode, RuntimeMode } from '../../../../../shared/conversation/providerPolicy'
import type { OpenArtifactMcpGrant } from '../../../../../shared/open-artifact'
import { DaemonError } from '../../../../daemon/errors'
import { spawnCodexOwnedProcess, type CodexOwnedProcess } from '../codex/process-owner'
import { driverActionEvidence, driverConfigurationKey, hostUnsupported } from '../core/catalog'
import { claudeProvenanceStatPaths, createClaudeProvenanceResolver, readClaudeBindingMetadata } from '../core/model-provenance'
import { nativeImageAttachment, nativeTextAttachment } from '../core/attachment-input'
import {
  ConversationTurnOutcomeUnknownError, ConversationTurnRejectedError,
  type ConversationDriverRuntimeRequest, type ConversationDriverSession, type ConversationDriverOpenInput,
  type ConversationResumeThreadInput, type ConversationInterruptTurnInput,
  type ConversationRespondToRuntimeRequestInput, type ConversationDriverEventListener, type ConversationStartTurnContext,
} from '../registry'

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error))
const run = <Value>(action: () => Promise<Value>): Effect.Effect<Value, Error> => Effect.tryPromise({ try: action, catch: asError })
type SdkQuery = typeof import('@anthropic-ai/claude-agent-sdk').query
type SdkSessionInfo = typeof import('@anthropic-ai/claude-agent-sdk').getSessionInfo
type SdkInit = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>
const comparePath = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path

function physicalExecutable(file: string): string {
  const unpacked = file.replace(/\.asar(?=[\\/])/i, '.asar.unpacked')
  if (!isAbsolute(unpacked) || !statSync(unpacked).isFile()) throw new Error('Claude native executable is unavailable.')
  accessSync(unpacked, constants.X_OK)
  return realpathSync.native(unpacked)
}

export function claudeConfigurationKey(env: NodeJS.ProcessEnv = process.env, fingerprintKey?: Buffer): string {
  const home = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const files = [
    ...['settings.json', '.credentials.json'].map(file => join(home, file)),
    ...claudeProvenanceStatPaths(env),
  ].map(file => {
    try { const info = statSync(file); return [info.ino, info.size, info.mtimeMs] } catch { return null }
  })
  let resolvedBinary: unknown = null
  try {
    const exe = realpathSync.native(resolveClaudeSdkExecutablePath(env))
    const info = statSync(exe)
    resolvedBinary = [comparePath(exe), info.size, info.mtimeMs]
  } catch { /* unavailable */ }
  // 使用实际解析出的 Claude 可执行文件元数据替代整串易变 PATH，防止 IDE/npm 环境变量微调击穿缓存。
  return driverConfigurationKey([home, files, env.CLAUDE_EXECUTABLE ?? null, resolvedBinary, env.ANTHROPIC_BASE_URL,
    env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_OAUTH_TOKEN, env.ANTHROPIC_AUTH_TOKEN, env.CLAUDE_CODE_USE_BEDROCK, env.CLAUDE_CODE_USE_VERTEX], fingerprintKey)
}

/**
 * 稳定的 Claude 会话账号/端点绑定指纹：不绑定易变文件 mtime/size、OAuth access_token 刷新或二进制版本。
 */
export function claudeBindingKey(env: NodeJS.ProcessEnv = process.env, fingerprintKey?: Buffer): string {
  const meta = readClaudeBindingMetadata(env)
  return driverConfigurationKey([meta.configHome, meta.baseUrl, meta.useBedrock, meta.useVertex, meta.accountIdentity], fingerprintKey)
}

export function resolveClaudeSdkExecutablePath(env: NodeJS.ProcessEnv): string {
  const explicit = env.CLAUDE_EXECUTABLE
  const directories = (env.PATH ?? env.Path ?? '').split(delimiter).filter(isAbsolute)
  const nativePackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const nativeName = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidates = explicit ? [explicit] : directories.flatMap(directory => process.platform === 'win32' ? [
    join(directory, 'claude.exe'),
    join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    join(directory, '..', 'Packages', 'Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe', 'claude.exe'),
  ] : [join(directory, 'claude')])
  if (!explicit) {
    if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', nativePackage, nativeName))
    try { candidates.push(join(dirname(createRequire(__filename).resolve(`${nativePackage}/package.json`)), nativeName)) } catch { }
  }
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || (process.platform === 'win32' && extname(candidate).toLowerCase() !== '.exe')) continue
    try { return physicalExecutable(candidate) } catch { continue }
  }
  throw new DaemonError('E_UNAVAILABLE', '没有找到已配置的 Claude CLI 原生可执行文件。')
}

class ClaudeOwnedTransport extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly ready: Promise<CodexOwnedProcess>
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  private closing: Promise<void> | undefined

  constructor(input: ConversationDriverOpenInput, opts: SpawnOptions, generation: string) {
    super()
    this.on('error', () => undefined)
    this.stdin.on('error', () => undefined)
    this.stdout.on('error', () => undefined)
    const launched = spawnCodexOwnedProcess({
      ...input, instanceId: `${input.instanceId}:${generation}`, ownerKind: 'claude',
      command: opts.command, args: opts.args, cwd: opts.cwd ?? input.cwd, env: opts.env,
    })
    this.ready = launched.then(async owned => {
      const child = owned.child
      child.on('error', error => this.emit('error', error))
      child.stderr.resume()
      child.stdin.on('error', error => this.emit('error', error))
      child.once('exit', (code, signal) => {
        this.exitCode = code
        this.signalCode = signal
        this.stdout.end()
        this.emit('exit', code, signal)
      })
      try { await owned.ready }
      catch (error) { await owned.close(); throw error }
      if (this.killed) await owned.close()
      else {
        this.stdin.pipe(child.stdin)
        child.stdout.pipe(this.stdout)
      }
      return owned
    })
    void this.ready.catch(error => {
      this.stdout.end()
      this.emit('error', asError(error))
    })
    opts.signal.addEventListener('abort', () => { this.kill() }, { once: true })
  }

  kill(): boolean {
    this.killed = true
    void this.close().catch(error => this.emit('error', asError(error)))
    return true
  }

  close(): Promise<void> {
    this.killed = true
    this.stdin.end()
    return this.closing ??= this.ready.then(owned => owned.close()).catch(error => {
      this.closing = undefined
      throw error
    })
  }
}

class ClaudeInput implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = []
  private wake: (() => void) | undefined
  private ended = false

  send(message: SDKUserMessage): void {
    if (this.ended) throw new ConversationTurnRejectedError('Claude 输入通道已经关闭。')
    this.pending.push(message)
    this.wake?.()
  }

  close(): void { this.ended = true; this.pending = []; this.wake?.() }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.ended) {
      const message = this.pending.shift()
      if (message) yield message
      else await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}

function deadline<Value>(operation: Promise<Value>, ms: number, detail: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(detail)), ms) })
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer))
}

type Turn = {
  readonly id: string
  readonly publish: ConversationDriverEventListener
  readonly done: (error?: Error) => void
  accepted: boolean
  interruptionRequested: boolean
  interruptionObserved: boolean
  item: string | undefined
}

class ClaudeThread {
  readonly input = new ClaudeInput()
  readonly query: Query
  private nativeIdentityConfirmed = false
  active?: Turn
  control?: Promise<unknown>
  ended = false

  constructor(
    query: SdkQuery,
    options: Options,
    private readonly transport: () => ClaudeOwnedTransport | undefined,
    private readonly confirm?: (message: SdkInit) => void,
    readonly model?: string,
    private readonly sessionId?: string,
    readonly artifactMcpUrl?: string,
  ) {
    this.query = query({ prompt: this.input, options })
    void this.consume()
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query) this.onMessage(message)
      this.disconnected(new Error('Claude SDK 关闭了事件流。'))
    } catch (error) { this.disconnected(asError(error)) }
  }

  private disconnected(error: Error): void {
    this.ended = true
    this.active?.done(new ConversationTurnOutcomeUnknownError('', { cause: error }))
  }

  private onMessage(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      this.confirm?.(message)
      this.nativeIdentityConfirmed = true
      return
    }
    const turn = this.active
    if (!turn || message.session_id !== this.sessionId || !this.nativeIdentityConfirmed) return
    const identity = { turnId: turn.id, turnIdSource: 'host' as const }
    const echoed = 'user_message_uuid' in message && message.user_message_uuid === turn.id
      || 'user_message_uuids' in message && message.user_message_uuids?.includes(turn.id)
      || message.type === 'user' && message.uuid === turn.id
    if (echoed && !turn.accepted) {
      turn.accepted = true
      turn.publish({ type: 'turn-accepted', ...identity })
    }
    if (!turn.accepted) return
    if (message.type === 'stream_event' && !message.parent_tool_use_id) {
      if (message.event.type === 'message_start') turn.item = message.event.message.id
      if (message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
        turn.publish({ type: 'text-delta', ...identity, itemId: `${turn.item ?? turn.id}:${message.event.index}`, text: message.event.delta.text })
      }
    }
    if (message.type === 'assistant' && !message.parent_tool_use_id) {
      for (const [index, content] of message.message.content.entries()) {
        if (content.type === 'text') turn.publish({ type: 'text-final', ...identity, itemId: `${message.message.id}:${index}`, text: content.text })
        if (content.type === 'tool_use') {
          const itemId = content.id || `${message.message.id}:tool:${index}`
          const inputObj = content.input && typeof content.input === 'object' && !Array.isArray(content.input)
            ? content.input as Record<string, unknown>
            : {}
          const lowerName = content.name.toLowerCase()
          const item: import('../registry').ConversationDriverWorkItem = lowerName === 'bash'
            ? {
                kind: 'command-execution',
                nativeItemId: itemId,
                command: typeof inputObj.command === 'string' && inputObj.command.trim() ? inputObj.command.trim().slice(0, 200) : 'Bash',
                status: 'completed',
              }
            : lowerName === 'glob' || lowerName === 'grep'
              ? {
                  kind: 'file-search',
                  nativeItemId: itemId,
                  ...(typeof inputObj.pattern === 'string' && inputObj.pattern.trim() ? { pattern: inputObj.pattern.trim().slice(0, 200) } : {}),
                  status: 'completed',
                }
              : lowerName === 'websearch' || lowerName === 'webfetch'
                ? {
                    kind: 'web-search',
                    nativeItemId: itemId,
                    ...(typeof (inputObj.query ?? inputObj.url) === 'string' ? { query: String(inputObj.query ?? inputObj.url).trim().slice(0, 200) } : {}),
                    status: 'completed',
                  }
                : {
                    kind: 'tool',
                    nativeItemId: itemId,
                    label: content.name,
                    status: 'completed',
                  }
          turn.publish({ type: 'work-item', ...identity, item })
        }
      }
    }
    if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
      turn.publish({ type: 'background-work', ...identity, pending: message.tasks.length > 0 })
    }
    if (message.type === 'result') {
      if (message.user_message_uuid && !echoed) return
      const failed = message.subtype !== 'success' || message.is_error
      const error = message.subtype === 'success' ? (message.is_error ? message.result : undefined) : message.errors.join('\n')
      turn.interruptionObserved = turn.interruptionRequested
        && (message.terminal_reason === 'aborted_streaming' || message.terminal_reason === 'aborted_tools')
      turn.publish({ type: 'turn-completed', ...identity, status: turn.interruptionObserved ? 'interrupted' : failed ? 'failed' : 'completed', error })
      this.active = undefined
      turn.done()
    }
  }

  async close(): Promise<void> {
    this.input.close()
    try { this.query.close() }
    finally { await this.transport()?.close() }
  }

  hasOwnedTransport(): boolean {
    return this.transport() !== undefined
  }
}

export class ClaudeDriver implements ConversationDriverSession {
  private readonly threads = new Map<string, ClaudeThread>()
  private readonly allThreads = new Set<ClaudeThread>()
  private readonly pendingPermissions = new Map<string, {
    readonly threadId: string
    readonly turnId: string
    readonly resolve: (result: PermissionResult) => void
  }>()
  private catalog?: Promise<{ models: readonly ModelInfo[]; version?: string }>
  private stopped = false
  private resumeVerified = false
  private interruptVerified = false

  private resolvePermissionMode(runtimeMode?: RuntimeMode, interactionMode?: ProviderInteractionMode): PermissionMode {
    if (this.opts.ordinaryTask || this.opts.managedExecution) return 'dontAsk'
    if (interactionMode === 'plan') return 'plan'
    if (runtimeMode === 'full-access') return 'bypassPermissions'
    if (runtimeMode === 'auto') return 'auto'
    if (runtimeMode === 'auto-accept-edits') return 'acceptEdits'
    return 'default'
  }

  private constructor(
    private readonly opts: ConversationDriverOpenInput,
    private readonly env: NodeJS.ProcessEnv,
    private readonly executable: string,
    private readonly configurationKey: string,
    private readonly bindingKey: string,
    private readonly query: SdkQuery,
    private readonly sessionInfo: SdkSessionInfo,
  ) {}

  static readonly open = (input: ConversationDriverOpenInput): Effect.Effect<ClaudeDriver, Error> => run(async () => {
    input.assertCanSpawn()
    const env = { ...(input.env ?? process.env) }
    const { query, getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk')
    const driver = new ClaudeDriver(
      input,
      env,
      resolveClaudeSdkExecutablePath(env),
      claudeConfigurationKey(env, input.fingerprintKey),
      claudeBindingKey(env, input.fingerprintKey),
      query,
      getSessionInfo,
    )
    input.assertCanSpawn()
    input.onSpawn(driver)
    return driver
  })

  isAvailable(): boolean { return !this.stopped }

  private assertCurrent(cwd = this.opts.cwd): void {
    this.opts.assertCanSpawn()
    const actual = realpathSync.native(cwd)
    const original = realpathSync.native(this.opts.cwd)
    if (this.stopped || (process.platform === 'win32' ? actual.toLowerCase() !== original.toLowerCase() : actual !== original)
      || claudeBindingKey(this.env, this.opts.fingerprintKey) !== this.bindingKey || resolveClaudeSdkExecutablePath(this.env) !== this.executable) {
      throw new DaemonError('E_CONFLICT', 'Claude SDK 实例、配置或工程目录已变化。')
    }
  }

  private create(
    id?: string,
    selected?: ModelInfo,
    resume = false,
    artifactMcp?: OpenArtifactMcpGrant,
    permissionMode: PermissionMode = this.resolvePermissionMode(),
  ): ClaudeThread {
    this.assertCurrent()
    let transport: ClaudeOwnedTransport | undefined
    const generation = id ?? 'catalog'
    const interactivePermissions = !this.opts.ordinaryTask && !this.opts.managedExecution
    const mcpServers: Options['mcpServers'] = artifactMcp
      ? {
          'open-artifact': {
            type: 'http',
            url: artifactMcp.url,
            headers: Object.fromEntries(artifactMcp.headers.map(header => [header.name, header.value])),
            alwaysLoad: true
          }
        }
      : {}
    let thread!: ClaudeThread
    const canUseTool: Options['canUseTool'] | undefined = interactivePermissions
      ? (toolName, input, options) => {
          const turn = thread?.active
          if (!turn || !id || options.signal.aborted) {
            return Promise.resolve({ behavior: 'deny', message: '当前会话无活动回合。', interrupt: false })
          }
          const nativeRequestId = options.toolUseID || randomUUID()
          const commandPreview = typeof input.command === 'string' && input.command.trim()
            ? input.command.trim().slice(0, 160)
            : undefined
          const pathPreview = typeof input.file_path === 'string' && input.file_path.trim()
            ? input.file_path.trim().slice(0, 160)
            : typeof input.path === 'string' && input.path.trim()
              ? input.path.trim().slice(0, 160)
              : undefined
          const requestKind = toolName.toLowerCase() === 'bash'
            ? 'command'
            : ['edit', 'write', 'multiedit', 'notebookedit'].includes(toolName.toLowerCase())
              ? 'file-change'
              : 'permission'
          const detail = commandPreview ?? pathPreview
          const scopeKey = `claude:${toolName.toLowerCase()}:${(detail ?? 'any').toLowerCase().slice(0, 80)}`
          const request: ConversationDriverRuntimeRequest = {
            kind: 'approval',
            requestKind,
            approvalScopeKey: scopeKey,
            title: commandPreview ? `Claude 请求执行：${commandPreview}` : `Claude 请求使用工具：${toolName}`,
            ...(detail ? { details: detail } : {}),
            options: [
              { decision: 'accept', label: '允许本次' },
              { decision: 'acceptForSession', label: '本会话允许' },
              { decision: 'decline', label: '拒绝' },
              { decision: 'cancel', label: '取消回合' },
            ],
          }
          return new Promise<PermissionResult>((resolve) => {
            const settle = (result: PermissionResult): void => {
              options.signal.removeEventListener('abort', abort)
              this.pendingPermissions.delete(nativeRequestId)
              resolve(result)
            }
            const abort = (): void => settle({ behavior: 'deny', message: '操作已取消。', interrupt: true })
            this.pendingPermissions.set(nativeRequestId, { threadId: id, turnId: turn.id, resolve: settle })
            options.signal.addEventListener('abort', abort, { once: true })
            try {
              turn.publish({ type: 'runtime-request', turnId: turn.id, turnIdSource: 'host', nativeRequestId, request })
            } catch {
              settle({ behavior: 'deny', message: '无法发送审批请求。', interrupt: false })
            }
          })
        }
      : undefined
    thread = new ClaudeThread(this.query, {
      cwd: this.opts.cwd,
      env: this.env,
      pathToClaudeCodeExecutable: this.executable,
      permissionMode,
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(interactivePermissions ? { canUseTool } : { tools: [] }),
      settingSources: ['user'],
      mcpServers,
      ...(artifactMcp ? { allowedTools: ['mcp__open-artifact__*'] } : {}),
      strictMcpConfig: true,
      persistSession: id !== undefined,
      includePartialMessages: true,
      extraArgs: { 'replay-user-messages': null },
      ...(id ? (resume ? { resume: id } : { sessionId: id }) : {}),
      ...(selected ? { model: selected.value } : {}),
      spawnClaudeCodeProcess: options => {
        if (transport) throw new DaemonError('E_CONFLICT', 'Claude SDK 不能在同一 Job 代次下重新启动。')
        const cwd = options.cwd ?? this.opts.cwd
        this.assertCurrent(cwd)
        if (comparePath(physicalExecutable(options.command)) !== comparePath(this.executable)) {
          throw new DaemonError('E_DENIED', 'Claude SDK 启动来源与授权的物理 CLI 不一致。')
        }
        transport = new ClaudeOwnedTransport(this.opts, { ...options, cwd, command: this.executable }, generation)
        return transport
      },
    }, () => transport, id && selected ? message => {
      const modeMatches = interactivePermissions ? true : message.permissionMode === 'dontAsk'
      if (message.session_id !== id
        || comparePath(realpathSync.native(message.cwd)) !== comparePath(realpathSync.native(this.opts.cwd))
        || ![selected.value, selected.resolvedModel].includes(message.model) || !modeMatches) {
        throw new DaemonError('E_CONFLICT', 'Claude 未确认所选模型、工程范围或原生会话身份。')
      }
      if (resume) this.resumeVerified = true
    } : undefined, selected?.value, id, artifactMcp?.url)
    this.allThreads.add(thread)
    return thread
  }

  private async remove(thread: ClaudeThread): Promise<void> {
    await thread.close()
    this.allThreads.delete(thread)
  }

  private readCatalog(): Promise<{ models: readonly ModelInfo[]; version?: string }> {
    return this.catalog ??= (async () => {
      const probe = this.create()
      try {
        const [init, models] = await deadline(Promise.all([probe.query.initializationResult(), probe.query.supportedModels()]), 20_000, 'Claude SDK 模型目录读取超时。')
        if (!init.account || models.length === 0) throw new DaemonError('E_UNAVAILABLE', 'Claude SDK 未返回当前账号的模型目录。')
        return { models }
      } finally { await this.remove(probe) }
    })().catch(error => { this.catalog = undefined; throw error })
  }

  readonly describe = () => run(async (): Promise<ConversationDriverDescriptor> => {
    this.assertCurrent()
    const { models, version } = await this.readCatalog()
    const resolveProvenance = createClaudeProvenanceResolver(this.env)
    return {
      observedAt: new Date().toISOString(), configurationKey: this.configurationKey, source: 'native-catalog', version,
      models: models.map(model => {
        const provenance = resolveProvenance(model.value)
        return {
          id: model.value,
          displayName: model.displayName,
          isDefault: model.value === 'default',
          ...(provenance.providerId ? { providerId: provenance.providerId } : {}),
          group: provenance.group,
        }
      }),
      options: models.flatMap(model => model.supportedEffortLevels?.length ? [{
        id: `${model.value}:effort`, label: '推理强度', category: 'reasoning',
        choices: model.supportedEffortLevels.map(value => ({ value, label: value })),
      }] : []),
      actions: driverActionEvidence({
        chat: { state: 'verified', source: 'native-catalog', detail: 'Claude SDK 返回了当前配置的模型目录。' },
        planning: hostUnsupported('该入口还未接入团队规划授权。'),
        execution: hostUnsupported('该入口未启用执行工具。'),
        goalPause: hostUnsupported('Claude SDK 的回合中断不提供独立目标暂停或恢复。'),
        toolApproval: (!this.opts.ordinaryTask && !this.opts.managedExecution)
          ? { state: 'verified', source: 'host-policy', detail: '已接入 Claude 工具交互式审批桥接。' }
          : hostUnsupported('当前 Claude 入口没有启用会请求审批的工具。'),
        ...(this.resumeVerified && { resume: { state: 'verified', source: 'native-session', detail: '原生 SDK 已恢复原会话。' } as const }),
        ...(this.interruptVerified && { cancel: { state: 'verified', source: 'native-session', detail: '观察到原轮中断及最终回执。' } as const }),
      }),
    }
  })

  readonly listModels = () => this.describe().pipe(Effect.map(catalog => catalog.models))

  private async ensure(id: string, model: string, cwd: string, resume: boolean, artifactMcp?: OpenArtifactMcpGrant, runtimeMode?: RuntimeMode): Promise<string> {
    this.assertCurrent(cwd)
    const available = (await this.readCatalog()).models.find(item => item.value === model)
    if (!available) throw new DaemonError('E_UNAVAILABLE', `Claude SDK 未报告模型 ${model}。`)
    const previous = this.threads.get(id)
    if (previous && !previous.ended) {
      if (previous.model !== model) throw new DaemonError('E_CONFLICT', 'Claude 原生线程仍绑定另一模型。')
      if (!artifactMcp || previous.artifactMcpUrl === artifactMcp.url) return id
      await this.remove(previous)
      resume = true
    } else if (previous) {
      await this.remove(previous)
    }
    if (resume) {
      const saved = await deadline(this.sessionInfo(id, { dir: cwd }), 5_000, 'Claude 原生会话检查超时。')
      if (saved?.sessionId !== id || !saved.cwd
        || comparePath(realpathSync.native(saved.cwd)) !== comparePath(realpathSync.native(cwd))) {
        throw new DaemonError('E_CONFLICT', 'Claude 未在原工程找到要恢复的原生会话。')
      }
    }
    const thread = this.create(id, available, resume, artifactMcp, this.resolvePermissionMode(runtimeMode))
    try {
      await deadline(thread.query.initializationResult(), 30_000, 'Claude SDK 未确认初始化。')
      this.threads.set(id, thread)
      return id
    } catch (error) { await this.remove(thread); throw error }
  }

  readonly startThread = (model: string, cwd: string, artifactMcp?: OpenArtifactMcpGrant, runtimeMode?: RuntimeMode) =>
    run(() => this.ensure(randomUUID(), model, cwd, false, artifactMcp, runtimeMode))
  readonly resumeThread = ({ nativeThreadId, cwd, model, artifactMcp }: ConversationResumeThreadInput) =>
    run(() => this.ensure(nativeThreadId, model, cwd, true, artifactMcp))

  readonly startTurn = (id: string, cwd: string, text: string, model: string, publish: ConversationDriverEventListener, context?: ConversationStartTurnContext) => run(async () => {
    this.assertCurrent(cwd)
    let thread = this.threads.get(id)
    if (thread && !thread.ended && !thread.active && !thread.control && context?.artifactMcp && thread.artifactMcpUrl !== context.artifactMcp.url) {
      await this.ensure(id, model, cwd, true, context.artifactMcp, context.runtimeMode)
      thread = this.threads.get(id)
    }
    if (!thread || thread.ended || thread.active || thread.control) throw new ConversationTurnRejectedError('Claude 原会话没有可用回合。')
    if (thread.model !== model) throw new ConversationTurnRejectedError('Claude 当前原生会话未绑定所选模型。')
    if (!this.opts.ordinaryTask && !this.opts.managedExecution) {
      const desiredMode = this.resolvePermissionMode(context?.runtimeMode, context?.interactionMode)
      await thread.query.setPermissionMode(desiredMode).catch(() => undefined)
    }
    let content: SDKUserMessage['message']['content'] = text
    if (context?.attachments?.length) {
      try {
        content = [{ type: 'text', text }, ...context.attachments.map(attachment => {
          if (attachment.attachment.type !== 'image') return { type: 'text' as const, text: nativeTextAttachment(attachment) }
          const { mimeType, data } = nativeImageAttachment(attachment)
          return { type: 'image' as const, source: { type: 'base64' as const, media_type: mimeType, data } }
        })]
      } catch (cause) { throw new ConversationTurnRejectedError(asError(cause).message, { cause }) }
    }
    const uuid = randomUUID()
    let active: Turn | undefined
    const settled = new Promise<void>((resolve, reject) => {
      active = { id: uuid, publish, accepted: false, interruptionRequested: false, interruptionObserved: false, item: undefined, done: error => error ? reject(error) : resolve() }
      thread.active = active
      thread.input.send({ type: 'user', uuid, session_id: id, message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' } })
    })
    try { await deadline(settled, 30 * 60_000, 'Claude 未报告本回合的最终结果。') }
    catch (cause) {
      if (cause instanceof ConversationTurnRejectedError) throw cause
      await this.remove(thread).catch(() => undefined)
      throw new ConversationTurnOutcomeUnknownError('', { cause })
    } finally {
      if (thread.active === active) thread.active = undefined
      for (const [requestId, pending] of [...this.pendingPermissions.entries()]) {
        if (pending.threadId === id && pending.turnId === uuid) {
          this.pendingPermissions.delete(requestId)
          pending.resolve({ behavior: 'deny', message: '回合已结束。', interrupt: false })
        }
      }
    }
    if (active?.interruptionObserved) this.interruptVerified = true
    return ''
  })

  readonly respondToRuntimeRequest = ({ nativeThreadId, turnId, nativeRequestId, response }: ConversationRespondToRuntimeRequestInput) => run(async () => {
    const entry = this.pendingPermissions.get(nativeRequestId)
    if (!entry || entry.threadId !== nativeThreadId || entry.turnId !== turnId) {
      throw new DaemonError('E_CONFLICT', 'Claude 审批请求与当前活动回合不匹配。')
    }
    if (response.kind !== 'approval') {
      throw new DaemonError('E_CONFLICT', 'Claude 暂仅支持工具审批应答。')
    }
    if (response.decision === 'accept' || response.decision === 'acceptForSession' || response.decision === 'acceptAlways') {
      entry.resolve({ behavior: 'allow' })
      return
    }
    if (response.decision === 'cancel') {
      entry.resolve({ behavior: 'deny', message: '用户取消了当前回合。', interrupt: true })
      return
    }
    entry.resolve({ behavior: 'deny', message: '用户拒绝了该工具操作。', interrupt: false })
  })

  readonly interruptTurn = ({ nativeThreadId, turnId }: ConversationInterruptTurnInput) => run(async () => {
    const thread = this.threads.get(nativeThreadId)
    const active = thread?.active
    if (!thread || !active || active.id !== turnId || !active.accepted) throw new DaemonError('E_CONFLICT', 'Claude 控制请求与当前活动回合不一致。')
    if (thread.control) { await thread.control; return }
    active.interruptionRequested = true
    const control = deadline(thread.query.interrupt(), 15_000, 'Claude 未确认提交回合中断。')
    thread.control = control
    try { await control }
    catch (error) { await this.remove(thread).catch(() => undefined); throw error }
    finally { if (thread.control === control) thread.control = undefined }
  })

  readonly canConfirmWindowsJobClose = (nativeThreadId: string): boolean => {
    const thread = this.threads.get(nativeThreadId)
    return process.platform === 'win32' && thread !== undefined && this.allThreads.has(thread) && thread.hasOwnedTransport()
  }

  readonly close = () => run(async () => {
    this.stopped = true
    for (const [requestId, pending] of [...this.pendingPermissions.entries()]) {
      this.pendingPermissions.delete(requestId)
      pending.resolve({ behavior: 'deny', message: 'Claude 会话已关闭。', interrupt: true })
    }
    const closed = await Promise.allSettled([...this.allThreads].map(thread => this.remove(thread)))
    if (closed.some(result => result.status === 'rejected')) throw new DaemonError('E_UNKNOWN', '部分 Claude SDK Job 尚未确认退出。', 'unknown')
  })
}
