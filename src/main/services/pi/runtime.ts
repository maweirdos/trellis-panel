import { spawn, execFile, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AcpRuntimeEvent, AcpRuntimeHandle, AcpRuntimeTurn, AcpRuntimeTurnResult, AcpPermissionDecision } from './runtime-port'
import type { AcpSessionRecord } from '../../../shared/types'
import { assertPiToolPath } from './tool-paths'
import { piConfiguredModels, piProjectMcp } from './models'
import { PI_FRAME_BYTES, PI_VERSION, piInitializeSchema, piOperationReceiptSchema, piPermissionSchema, piRequestIdSchema, piStateSchema, piTextMetaSchema, type PiActivity, type PiOperationReceipt, type PiState } from './protocol'
import { z } from 'zod'
import type { ConversationRuntime, ConversationRuntimeStatus } from './runtime-port'
import { acpProcessEnv, acpSpawnEnv, sessionAcpLaunchOptions } from '../../../shared/acp-launch-options'
import { readAcpStoredImages } from '../../../shared/acp-images'
import { readPiWebPreviewArtifact } from '../../../shared/pi-web-preview'
import { DESIGN_GENERATION_DIRECTORY, designGenerationSourcePathSchema, readDesignGenerationOutput } from '../../../shared/design-generation'
import { inspectPiWebPreviewEntry } from './engine/web-preview-entry'
import { prepareAgentRules, assertAgentRulesCurrent } from '../agent-rules'
import { composePiPromptPacket } from './prompt-context'
import { taskRule } from '../crux/task-progress-context'
import { reportTaskProgress } from '../crux/task-progress-events'
import type { AcpJobOwner } from '../workcopy-use/acp-jobs'
import { ownedDirectory } from '../private-conversations/files'

interface PiRuntimeOptions {
  assertExecutionCurrent?(): Promise<void>
  meta: AcpSessionRecord
  argv: string[]
  dataDirectory: string
  windowsJobLauncher?: string
  nativeJobs?: AcpJobOwner
  initialModelId?: string
  mcpServers(): Array<{ name: string; config: Record<string, unknown> }>
  onState(state: PiState, mode: string): void
  onBeforeSpawn(): void
  onSpawned(): void
  onExit(): void
  onCleanupFailure?(message: string): void
}
type Pending = { accept(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
const pipedProcess = (child: ChildProcess): child is ChildProcessWithoutNullStreams => Boolean(child.stdin && child.stdout && child.stderr)
class ActivityQueue implements AsyncIterable<AcpRuntimeEvent> {
  private values: AcpRuntimeEvent[] = []
  private wake?: () => void
  private ended = false
  push(value: AcpRuntimeEvent): void { if (!this.ended) { this.values.push(value); this.wake?.(); this.wake = undefined } }
  close(): void { this.ended = true; this.wake?.(); this.wake = undefined }
  async *[Symbol.asyncIterator](): AsyncGenerator<AcpRuntimeEvent> {
    while (!this.ended || this.values.length) {
      const value = this.values.shift()
      if (value) yield value
      else if (!this.ended) await new Promise<void>(accept => { this.wake = accept })
    }
  }
}
type Running = { input: AcpRuntimeTurnInput; abort: AbortController; queue: ActivityQueue; accepted(result: PiOperationReceipt): void; rejectAccepted(error: Error): void; acceptedReceipt: Promise<PiOperationReceipt>; started(): void; rejectStarted(error: Error): void; finish(result: AcpRuntimeTurnResult): void; startedAcknowledged: boolean; terminalObserved: boolean; error?: string }
type AcpRuntimeTurnInput = Parameters<ConversationRuntime['startTurn']>[0]
export type PiSdkTurn = AcpRuntimeTurn & { commandAccepted: Promise<PiOperationReceipt>; hasNativeSettlement(): boolean; requestCancel(): Promise<void> }
const operationResponse = z.object({ accepted: z.literal(true), replayed: z.boolean(), receipt: piOperationReceiptSchema }).strict()
export class PiInputRejectedError extends Error {}
export class PiInputUncertainError extends Error {}

/** Native SDK-process adapter. No ACP initialize/session frames are sent to this process. */
export class PiConversationRuntime implements ConversationRuntime {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<string, Pending>()
  private running?: Running
  private state?: PiState
  private initializing?: Promise<AcpRuntimeHandle>
  private closing = false
  private closed?: Promise<void>
  private mode: string
  private readonly configured = piConfiguredModels()
  private readonly projectMcp
  private readonly secrets: string[]
  private pathRoot?: string
  private pathCwd?: string
  constructor(private options: PiRuntimeOptions) {
    const launch = sessionAcpLaunchOptions(options.meta, process.platform)
    if (launch.args?.length) throw new Error('Pi SDK 不支持额外启动参数；请清除执行引擎或 Agent 的参数后重试')
    if (options.meta.launchOptionsSnapshot && !options.meta.backendSessionId && !launch.modelId) options.meta.launchOptionsSnapshot.modelId = this.configured.defaultModelId
    this.mode = options.meta.currentModeId ?? 'workspace'
    this.projectMcp = piProjectMcp(options.meta.projectRoot, options.meta.profileSnapshot)
    this.secrets = [...this.configured.models.map(model => model.apiKey), this.configured.proxy?.url ?? ''].filter(key => key.length > 0)
  }
  private safe(value: string): string { for (const secret of this.secrets) value = value.split(secret).join('[redacted]'); return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]') }
  private error(error: unknown): Error {
    const message = this.safe(error instanceof Error ? error.message : String(error))
    return Object.assign(new Error(message), message.includes('PI_MODEL_UNAVAILABLE') ? { code: 'PI_MODEL_UNAVAILABLE' } : {})
  }
  private handle(): AcpRuntimeHandle {
    const meta = this.options.meta
    return {
      sessionKey: meta.sessionId,
      backend: 'acp-v2',
      runtimeSessionName: meta.sessionId,
      cwd: meta.cwd ?? meta.projectRoot,
      nativeRecordId: meta.nativeRecordId ?? '',
      backendSessionId: this.state?.sessionId ?? meta.backendSessionId ?? meta.sessionId,
      agentSessionId: this.state?.sessionId ?? meta.agentSessionId,
    }
  }
  private write(value: unknown): Promise<void> {
    const child = this.child
    if (!child || child.stdin.destroyed || !child.stdin.writable) return Promise.reject(new Error('Pi 执行进程已断开'))
    const bytes = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(bytes) > PI_FRAME_BYTES) return Promise.reject(new Error('Pi 请求超过传输限制'))
    return new Promise((accept, reject) => child.stdin.write(bytes, error => error ? reject(this.error(error)) : accept()))
  }
  private async call(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<unknown> {
    const id = randomUUID()
    const result = new Promise<unknown>((accept, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Pi ${method} 等待超时`))
        if (method !== 'shutdown' && method !== 'abort') this.stopAfterProtocolFailure()
      }, timeoutMs)
      this.pending.set(id, { accept, reject, timer })
    })
    // Return the observed response promise immediately: a blocked pipe write must
    // not strand its deadline rejection before the caller can attach a handler.
    void this.write({ id, method, params }).catch(error => {
      const pending = this.pending.get(id)
      if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(this.error(error)) }
    })
    return result
  }
  private finish(result: AcpRuntimeTurnResult): void {
    const run = this.running
    if (!run) return
    this.running = undefined
    run.abort.abort()
    const unresolved = new PiInputUncertainError(result.status === 'failed' ? result.error.message : 'Pi 输入未确认写入')
    run.rejectAccepted(unresolved)
    if (!run.startedAcknowledged) run.rejectStarted(unresolved)
    run.queue.close(); run.finish(result)
  }
  private receive(value: unknown): void {
    if (!value || typeof value !== 'object') throw new Error('Pi 响应格式无效')
    const message = value as Record<string, unknown>
    if (message.type === 'response' && typeof message.id === 'string') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.id)
      if (message.ok === true) pending.accept(message.result)
      else pending.reject(new PiInputRejectedError(this.error(typeof message.error === 'string' ? message.error : 'Pi 请求失败').message))
    } else if (message.type === 'task_progress' && typeof message.id === 'string') {
      const id = message.id
      const owner = this.running
      const valid = Boolean(owner && message.requestId === owner.input.requestId && !owner.abort.signal.aborted && !this.closing && this.options.meta.taskProgress)
      const summary: unknown = JSON.parse(JSON.stringify(message.summary, (_key, item: unknown) => typeof item === 'string' ? this.safe(item) : item))
      const report = valid ? reportTaskProgress(this.options.meta, summary) : Promise.reject(new Error('The original task turn is no longer active'))
      void report.then(() => this.write({ type: 'task_progress_response', id, ok: true }), () => this.write({ type: 'task_progress_response', id, ok: false })).catch(() => {})
    } else if (message.type === 'permission' && typeof message.id === 'string') {
      const id = message.id
      void this.permission(message.requestId, message.request).then(allow => this.write({ type: 'permission_response', id, allow }), error => this.write({ type: 'permission_response', id, allow: false, reason: this.error(error).message })).catch(() => {})
    } else if (message.type === 'event' && message.event && typeof message.event === 'object') {
      const original = message.event as PiActivity
      if (original.type === 'text_delta' && original.meta?.piText !== undefined) {
        const block = piTextMetaSchema.parse(original.meta.piText)
        if (typeof original.text !== 'string' || block.messageId !== original.messageId || (block.blockType === 'thinking' ? 'thought' : 'output') !== original.stream ||
          block.operation === 'replace' && !block.authority) throw new Error('Pi text block identity is invalid')
        if (original.meta.phase !== undefined && original.meta.phase !== 'commentary' && original.meta.phase !== 'final_answer') throw new Error('Pi text phase is invalid')
      }
      const images = original.type === 'text_delta' ? readAcpStoredImages(original.meta?.piImages) : []
      const preview = original.type === 'text_delta' ? readPiWebPreviewArtifact(original.meta?.piWebPreview) : null
      const rawDesign = original.type === 'tool_call' && original.title === 'design_open' && original.status === 'completed'
        ? readDesignGenerationOutput((original.rawOutput as { details?: { designOutput?: unknown } } | undefined)?.details?.designOutput) : null
      const projectedDesign = original.type === 'text_delta' ? readDesignGenerationOutput(original.meta?.designOutput) : null
      const machineFields = new Set(['type', 'id', 'toolCallId', 'name', 'status', 'tag', 'phase', 'stream', 'messageId', 'operationId', 'blockType', 'operation', 'providerMessageId', 'authority'])
      const event = JSON.parse(JSON.stringify(original, (key, item: unknown) => typeof item === 'string' && !machineFields.has(key) ? this.safe(item) : item)) as PiActivity
      if (event.type === 'tool_call' && original.type === 'tool_call' && original.title === 'design_open') event.title = original.title
      if (event.type === 'text_delta' && images.length) event.meta = { ...event.meta, piImages: images }
      if (event.type === 'text_delta' && preview) event.meta = { ...event.meta, piWebPreview: {
        ...preview, title: preview.title.split('[redacted]').map(part => this.safe(part)).join('[redacted]').slice(0, 160)
      } }
      // Preserve verified generated identities through this second redaction boundary, as for preview paths.
      if (event.type === 'tool_call' && rawDesign) {
        const output = event.rawOutput as { details?: Record<string, unknown> }
        event.rawOutput = { ...output, details: { ...output.details, designOutput: {
          ...rawDesign, title: rawDesign.title.split('[redacted]').map(part => this.safe(part)).join('[redacted]').slice(0, 200)
        } } }
      }
      if (event.type === 'text_delta' && projectedDesign) event.meta = { ...event.meta, designOutput: {
        ...projectedDesign, title: projectedDesign.title.split('[redacted]').map(part => this.safe(part)).join('[redacted]').slice(0, 200)
      } }
      const run = this.running
      if (!run || message.requestId !== run.input.requestId) return
      if (event.type === 'status' && ['pi_prompt_started', 'pi_operation_started'].includes(event.tag ?? '')) {
        run.startedAcknowledged = true; run.started(); return
      }
      if (event.type === 'status' && event.tag === 'pi_settled') {
        run.terminalObserved = true
        if (event.phase === 'failed') this.finish({ status: 'failed', error: { message: run.error ?? event.text ?? 'Pi 执行失败' } })
        else this.finish({ status: event.phase === 'cancelled' ? 'cancelled' : 'completed', stopReason: event.phase === 'cancelled' ? 'cancelled' : 'end_turn' })
        return
      }
      if (event.type === 'error') run.error = event.message === 'Nothing to compact (session too small)' ? '会话上下文较短，暂不需要压缩' : event.message
      run.queue.push(event)
    }
  }
  private failed(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.finish({ status: 'failed', error: { message: this.running?.error ?? error.message } })
  }
  private stopAfterProtocolFailure(): void {
    void this.shutdown().catch(error => {
      const failure = this.error(error)
      this.options.onCleanupFailure?.(failure.message)
      this.failed(failure)
    })
  }
  async findSession(): Promise<AcpRuntimeHandle | undefined> {
    return this.options.meta.pi?.sessionFile && existsSync(this.options.meta.pi.sessionFile) ? this.handle() : undefined
  }
  async ensureSession(input: Parameters<ConversationRuntime['ensureSession']>[0]): Promise<AcpRuntimeHandle> {
    if (input.sessionKey !== this.options.meta.sessionId || input.agent !== 'pi') throw new Error('Pi 会话归属不匹配')
    if (this.state) return this.handle()
    return this.initializing ??= this.initialize()
  }
  private async initialize(): Promise<AcpRuntimeHandle> {
    if (this.closing) throw new Error('Pi 会话已停止')
    const launch = sessionAcpLaunchOptions(this.options.meta, process.platform)
    const restoring = Boolean(this.options.meta.pi?.sessionFile)
    const modelId = restoring ? undefined : launch.modelId ?? this.configured.defaultModelId
    const requestedModelId = restoring ? this.options.initialModelId : modelId
    if (requestedModelId && !this.configured.models.some(model => model.selectionId === requestedModelId)) throw Object.assign(new Error('保存的 Pi 模型已不可用；请从原会话的已保存候选中显式选择模型后恢复'), { code: 'PI_MODEL_UNAVAILABLE' })
    const [node, entry] = this.options.argv
    if (!node || !entry || !isAbsolute(node) || !isAbsolute(entry)) throw new Error('Pi 需要绝对 Node 和引擎入口路径')
    const pathRoot = realpathSync(this.options.meta.projectRoot)
    const pathCwd = realpathSync(this.options.meta.cwd ?? this.options.meta.projectRoot)
    const cwdRelative = relative(pathRoot, pathCwd)
    if (cwdRelative === '..' || cwdRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(cwdRelative)) throw new Error('Pi 工作目录超出当前项目的物理目录')
    this.pathRoot = pathRoot; this.pathCwd = pathCwd
    this.options.onBeforeSpawn()
    let env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (process.env[key]) env[key] = process.env[key]
    env = acpSpawnEnv(env, acpProcessEnv(launch, process.platform), process.platform)
    // User tools keep precedence; the shipped Node is a fallback for stdio MCP/scripts.
    const inheritedPath = env.PATH ?? env.Path ?? ''
    delete env.Path
    env.PATH = [inheritedPath, dirname(node)].filter(Boolean).join(delimiter)
    const launcher = this.options.windowsJobLauncher
    const legacyWindows = process.platform === 'win32' && !this.options.nativeJobs
    if (legacyWindows && (!launcher || !isAbsolute(launcher) || !existsSync(launcher))) throw new Error('Pi Windows 进程容器入口缺失，请重新安装应用')
    const command = legacyWindows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : node
    const args = legacyWindows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher ?? '',
      '-ExecutableBase64', Buffer.from(node).toString('base64'), '-EntryBase64', Buffer.from(entry).toString('base64')] : [entry]
    const nativeLaunch = { launchId: randomUUID(), purpose: 'agent' as const, scope: { kind: 'runtime-session' as const, sessionKey: this.options.meta.sessionId }, command, args, cwd: pathCwd }
    const child = this.options.nativeJobs ? this.options.nativeJobs.spawn(nativeLaunch, { cwd: pathCwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(command, args, { cwd: pathCwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    if (!pipedProcess(child)) throw new Error('Pi 原生进程缺少受管 stdio')
    this.child = child
    const streamError = (error: Error): void => {
      if (this.closing) return
      this.failed(this.error(error)); this.stopAfterProtocolFailure()
    }
    child.stdin.on('error', streamError)
    child.stdout.on('error', streamError)
    child.stderr.on('error', streamError)
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > PI_FRAME_BYTES) { this.failed(new Error('Pi 输出超过传输限制')); this.stopAfterProtocolFailure(); return }
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        try { this.receive(JSON.parse(line)) } catch { this.failed(new Error('Pi 执行进程返回无效消息')); this.stopAfterProtocolFailure(); return }
      }
    })
    // Diagnostics are deliberately bounded and never copy credentials/configuration to history.
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr = this.safe((stderr + chunk.toString('utf8')).slice(-3000)) })
    child.once('error', error => { this.failed(this.error(error)); this.options.onExit() })
    child.once('exit', code => {
      if (code === 70 && legacyWindows) this.options.onCleanupFailure?.('Pi Windows 进程容器清理未确认')
      this.failed(new Error(this.closing ? 'Pi 执行进程已关闭' : `Pi 执行进程意外退出${stderr ? `：${stderr}` : ''}`))
      this.options.onExit()
    })
    if (this.options.nativeJobs) {
      if (!child.pid) throw new Error('Pi 原生进程启动失败')
      await this.options.nativeJobs.spawned({ ...nativeLaunch, pid: child.pid, startedAt: new Date().toISOString() })
      this.options.onSpawned()
    } else child.once('spawn', () => this.options.onSpawned())
    const meta = this.options.meta
    const sessionDir = ownedDirectory(this.options.dataDirectory, `pi/sessions/${createHash('sha256').update(meta.projectRoot).digest('hex')}/${meta.sessionId}`)
    const sessionFile = meta.pi?.sessionFile
    if (sessionFile) {
      const local = relative(sessionDir, resolve(sessionFile))
      if (!local || local.startsWith('..') || isAbsolute(local) || !existsSync(sessionFile)) throw new Error('原 Pi 会话文件缺失或超出所属目录，历史已保留')
    }
    if (meta.agentRulesManifest) await assertAgentRulesCurrent(meta.projectRoot, meta.agentRulesManifest)
    const rules = meta.platformExecution ? undefined : await prepareAgentRules({ projectRoot: meta.projectRoot, taskDir: meta.taskDir, teamTask: meta.taskProgress, additionalRules: meta.taskProgress ? [taskRule(meta.taskProgress)] : undefined })
    if (meta.agentRulesManifest && rules?.manifest.digest !== meta.agentRulesManifest.digest) throw new Error('项目规范版本已变化，请显式采用后重新连接')
    meta.agentRulesManifest = rules?.manifest
    const initialized = await this.call('initialize', piInitializeSchema.parse({ root: pathRoot, cwd: pathCwd,
      sessionDir, sessionFile, agentDir: ownedDirectory(this.options.dataDirectory, 'pi/agent'), models: this.configured.models,
      proxy: this.configured.proxy,
      modelId, recoveryModelId: restoring ? this.options.initialModelId : undefined, thinkingLevel: meta.configOptions?.find(option => option.id === 'thinking')?.currentValue ?? 'off',
      skillPaths: meta.platformExecution ? [] : meta.profileSnapshot?.skillPaths?.map(path => join(meta.projectRoot, path)) ?? [], instructions: meta.platformExecution ? '' : [meta.profileSnapshot?.instructions ?? '', rules?.instructions ?? ''].filter(Boolean).join('\n\n'),
      taskProgress: Boolean(meta.taskProgress),
      mcpServers: [...this.options.mcpServers(), ...this.projectMcp.servers] }), 60_000)
    this.state = piStateSchema.parse(initialized)
    if (meta.backendSessionId && this.state.sessionId !== meta.backendSessionId) throw new Error('原 Pi 会话身份不匹配')
    this.options.onState(this.state, this.mode)
    return this.handle()
  }
  async connectSession(input: Parameters<ConversationRuntime['connectSession']>[0]): Promise<void> {
    input.assertActive?.(); await this.ensureSession({ sessionKey: this.options.meta.sessionId, agent: 'pi', mode: 'persistent' }); input.assertActive?.()
  }
  getCapabilities(): ReturnType<ConversationRuntime['getCapabilities']> { return Promise.resolve({ controls: ['session/set_mode', 'session/set_model', 'session/set_config_option', 'session/status'] }) }
  async getStatus(): Promise<ConversationRuntimeStatus> {
    if (this.state) this.options.onState(this.state, this.mode)
    return { ...this.handle(), models: {
      availableModelIds: this.configured.models.map(model => model.selectionId) },
      availableCommands: [{ name: 'compact', description: '压缩当前会话上下文' }] }
  }
  private async configure(input: Record<string, unknown>): Promise<void> {
    this.assertConfiguration()
    if (this.closing) throw new Error('Pi 会话正在停止，请重新连接后配置')
    try { this.state = piStateSchema.parse(await this.call('configure', input)); this.options.onState(this.state, this.mode) }
    catch (error) {
      try { await this.shutdown() } catch (cleanup) { this.options.onCleanupFailure?.(this.error(cleanup).message) }
      throw error
    }
  }
  private assertConfiguration(): void {
    if (piConfiguredModels().revision !== this.configured.revision) throw new Error('AI 模型或凭据配置已改变，请重新连接 Pi 会话后再发送')
    if (piProjectMcp(this.options.meta.projectRoot, this.options.meta.profileSnapshot).revision !== this.projectMcp.revision) throw new Error('项目 MCP 配置已改变，请重新连接 Pi 会话后再发送')
  }
  async setModel(input: Parameters<ConversationRuntime['setModel']>[0]): Promise<void> { input.assertActive?.(); await this.configure({ modelId: input.model }); input.assertActive?.() }
  async setMode(input: Parameters<ConversationRuntime['setMode']>[0]): Promise<void> {
    input.assertActive?.()
    if (this.closing) throw new Error('Pi 会话正在停止，请重新连接后配置')
    if (!['read-only', 'workspace', 'full-access'].includes(input.mode)) throw new Error('Pi 权限模式无效')
    this.mode = input.mode; this.options.meta.currentModeId = input.mode
  }
  async setConfigOption(input: Parameters<ConversationRuntime['setConfigOption']>[0]): Promise<void> {
    input.assertActive?.()
    if (input.key !== 'thinking' || !['off', 'low', 'medium', 'high'].includes(input.value)) throw new Error('Pi 配置选项无效')
    await this.configure({ thinkingLevel: input.value }); input.assertActive?.()
  }
  get available(): boolean {
    const child = this.child
    return Boolean(this.state && !this.closing && child && child.exitCode === null && child.signalCode === null && child.stdin.writable)
  }
  liveHandle(): AcpRuntimeHandle | undefined { return this.available ? this.handle() : undefined }
  async steer(turnId: string, requestId: string, text: string): Promise<PiOperationReceipt> {
    const run = this.running
    if (!run || run.input.requestId !== turnId || run.abort.signal.aborted || this.closing) throw new PiInputRejectedError('Pi 原回合已结束或不可插话')
    // The worker owns the "SDK user message started" fact. Requiring the host to have
    // already observed that frame would reject a legitimate steer during its transit.
    await run.acceptedReceipt.catch((error: Error) => {
      throw error instanceof PiInputRejectedError ? error : new PiInputRejectedError(`Pi 原回合尚未确认接纳：${error.message}`)
    })
    if (this.running !== run || run.abort.signal.aborted || this.closing) throw new PiInputRejectedError('Pi 原回合已结束或不可插话')
    run.input.assertActive?.()
    this.assertConfiguration()
    const response = operationResponse.parse(await this.call('steer', { turnId, requestId, text }))
    if (this.running !== run || run.abort.signal.aborted) throw new PiInputRejectedError('Pi 原回合已结束或不可插话')
    if (response.receipt.requestId !== requestId || response.receipt.kind !== 'steer') throw new PiInputUncertainError('Pi 插话回执身份不一致')
    return response.receipt
  }
  startTurn(input: AcpRuntimeTurnInput): PiSdkTurn {
    return this.startOperation(input, 'prompt')
  }
  compact(input: AcpRuntimeTurnInput, instructions?: string): ReturnType<PiConversationRuntime['startTurn']> {
    return this.startOperation(input, 'compact', instructions)
  }
  private startOperation(input: AcpRuntimeTurnInput, method: 'prompt' | 'compact', instructions?: string): ReturnType<PiConversationRuntime['startTurn']> {
    const queue = new ActivityQueue(), abort = new AbortController()
    let started: () => void = () => {}, rejectStarted: (error: Error) => void = () => {}, finish: (value: AcpRuntimeTurnResult) => void = () => {}
    let accepted: (receipt: PiOperationReceipt) => void = () => {}, rejectAccepted: (error: Error) => void = () => {}
    const commandAccepted = new Promise<PiOperationReceipt>((resolve, reject) => { accepted = resolve; rejectAccepted = reject })
    const promptStarted = new Promise<void>((accept, reject) => { started = accept; rejectStarted = reject })
    const result = new Promise<AcpRuntimeTurnResult>(accept => { finish = accept })
    void commandAccepted.catch(() => {})
    void promptStarted.catch(() => {})
    const run: Running = { input, queue, abort, accepted, rejectAccepted, acceptedReceipt: commandAccepted, started, rejectStarted, finish, startedAcknowledged: false, terminalObserved: false }
    if (this.running || this.closing) {
      const error = new PiInputRejectedError('Pi 会话不可接纳新回合')
      rejectAccepted(error); rejectStarted(error); queue.close(); finish({ status: 'failed', error: { message: error.message } })
    }
    else {
      this.running = run
      let submitted = false
      void (async () => {
        input.assertActive?.()
        this.assertConfiguration()
        const requestId = piRequestIdSchema.parse(input.requestId)
        const packet = method === 'compact' ? { instructions } : composePiPromptPacket(input)
        submitted = true
        const response = operationResponse.parse(await this.call(method, { ...packet, requestId }))
        if (response.receipt.requestId !== requestId) throw new Error('Pi 返回了另一条输入的回执')
        run.accepted(response.receipt)
        if (response.replayed) {
          const receipt = response.receipt
          if (receipt.startedAt) { run.startedAcknowledged = true; run.started() }
          const status = receipt.state
          run.terminalObserved = status === 'completed' || status === 'cancelled' || status === 'failed'
          if (status === 'completed' || status === 'cancelled') this.finish({ status, stopReason: status === 'completed' ? 'end_turn' : 'cancelled' })
          else if (status === 'failed') this.finish({ status, error: { message: 'Pi 原操作已失败' } })
          else throw new PiInputUncertainError('Pi 原输入已接纳，尚无结束凭据')
        }
      })().catch(async error => {
        if (this.running !== run) return
        const message = this.error(error).message
        run.error = message; run.queue.push({ type: 'error', message })
        const rejected = !submitted || error instanceof PiInputRejectedError
        const reason = rejected ? new PiInputRejectedError(message) : new PiInputUncertainError(message)
        run.rejectAccepted(reason)
        if (!run.startedAcknowledged) run.rejectStarted(reason)
        if (!rejected) {
          try { await this.shutdown() } catch (cleanup) { this.options.onCleanupFailure?.(this.error(cleanup).message) }
        }
        if (this.running === run) this.finish({ status: 'failed', error: { message } })
      })
    }
    const timer = setTimeout(() => { void cancel().catch(async error => {
      if (this.running !== run) return
      run.queue.push({ type: 'error', message: `Pi 回合超时，正在停止执行进程：${this.error(error).message}` })
      try { await this.shutdown() } catch (cleanup) { this.failed(this.error(cleanup)) }
    }) }, input.timeoutMs ?? 30 * 60_000)
    void result.finally(() => clearTimeout(timer))
    const requestCancel = async (): Promise<void> => {
      if (this.running !== run) throw new PiInputRejectedError('Pi 原操作已结束')
      await commandAccepted
      if (this.running !== run) throw new PiInputRejectedError('Pi 原操作已结束')
      abort.abort()
      await this.call('cancel', { requestId: input.requestId }, 10_000)
    }
    const cancel = async (): Promise<void> => {
      if (this.running !== run) return
      let settlementTimer: NodeJS.Timeout | undefined
      try {
        await Promise.race([(async () => { await requestCancel(); await result })(),
          new Promise<never>((_, reject) => { settlementTimer = setTimeout(() => reject(new Error('Pi 取消未在 10 秒内确认结束，正在停止引擎')), 10_000) })])
      } catch (error) {
        if (this.running !== run) return
        run.queue.push({ type: 'error', message: this.error(error).message })
        try { await this.shutdown() } catch (cleanup) { this.failed(this.error(cleanup)); throw cleanup }
      } finally { if (settlementTimer) clearTimeout(settlementTimer) }
    }
    return { requestId: input.requestId, events: queue, promptStarted, commandAccepted, hasNativeSettlement: () => run.terminalObserved, requestCancel, result, cancel, closeStream: cancel }
  }
  private async permission(requestId: unknown, value: unknown): Promise<boolean> {
    const request = piPermissionSchema.parse(value), run = this.running
    if (!run || requestId !== run.input.requestId || run.abort.signal.aborted || this.closing) return false
    await this.options.assertExecutionCurrent?.()
    if (this.running !== run || run.abort.signal.aborted || this.closing) return false
    run.input.assertActive?.()
    this.assertConfiguration()
    const read = (request.name === 'report_progress' && Boolean(this.options.meta.taskProgress)) || ['preview_web', 'read', 'grep', 'find', 'ls', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(request.name)
      || ['knowledge_search', 'knowledge_read', 'knowledge_context', 'knowledge_document_read', 'knowledge_task_read'].some(name => request.name === `mcp__trellis_knowledge__${name}`)
    const pathTool = ['preview_web', 'design_open', 'read', 'write', 'edit', 'grep', 'find', 'ls'].includes(request.name)
    const assertPath = (): string[] => {
      if (!pathTool) return []
      const root = this.pathRoot, cwd = this.pathCwd
      if (!root || !cwd || !isAbsolute(request.homeDir) || relative(cwd, request.cwd) !== '' ||
        relative(root, realpathSync(this.options.meta.projectRoot)) !== '' || relative(cwd, realpathSync(this.options.meta.cwd ?? this.options.meta.projectRoot)) !== '') throw new Error('Pi 工作目录或项目归属已改变')
      if (request.name === 'design_open') {
        const paths = assertPiToolPath(root, root, request.homeDir, 'write', DESIGN_GENERATION_DIRECTORY)
        if (Array.isArray(request.args.pages)) for (const page of request.args.pages) {
          if (page && typeof page === 'object' && 'sourcePath' in page && page.sourcePath != null) {
            paths.push(...assertPiToolPath(root, root, request.homeDir, 'read', designGenerationSourcePathSchema.parse(page.sourcePath)))
          }
        }
        return paths
      }
      const raw = request.args.path
      if (typeof raw !== 'string' && !(raw === undefined && ['grep', 'find', 'ls'].includes(request.name))) throw new Error('工具路径无效')
      if (request.name === 'preview_web') return [inspectPiWebPreviewEntry(root, raw as string).file]
      const path = ['grep', 'find', 'ls'].includes(request.name) && !raw ? '.' : raw as string
      return assertPiToolPath(root, cwd, request.homeDir, request.name, path)
    }
    const initialPaths = assertPath()
    if (this.mode === 'read-only' && !read) return false
    if (read || this.mode === 'full-access') return true
    const handler = run.input.onPermissionRequest
    if (!handler) return false
    const kind = request.name === 'bash' || request.name === 'powershell' ? 'execute' as const : ['write', 'edit', 'design_open'].includes(request.name) ? 'edit' as const : 'other' as const
    const rawInput = this.safe(JSON.stringify(request.args)).slice(0, 2500)
    const decision: AcpPermissionDecision | undefined = await handler({ sessionId: this.state?.sessionId ?? this.options.meta.sessionId, inferredKind: kind,
      raw: { sessionId: this.state?.sessionId ?? this.options.meta.sessionId, toolCall: { toolCallId: request.toolCallId, title: `${request.name} · ${rawInput}`, kind, rawInput: request.args },
        options: [{ optionId: 'allow-once', kind: 'allow_once', name: '允许本次' }, { optionId: 'deny', kind: 'reject_once', name: '拒绝' }] } }, { signal: run.abort.signal })
    run.input.assertActive?.()
    await this.options.assertExecutionCurrent?.()
    run.input.assertActive?.()
    this.assertConfiguration()
    const finalPaths = assertPath()
    if (initialPaths.length !== finalPaths.length || initialPaths.some((path, index) => relative(path, finalPaths[index] ?? '') !== '')) throw new Error('工具路径在授权期间发生变化')
    return !run.abort.signal.aborted && decision?.outcome.outcome === 'selected' && decision.outcome.optionId === 'allow-once'
  }
  shutdown(): Promise<void> {
    return this.closed ??= (async () => {
      this.closing = true; this.running?.abort.abort()
      const child = this.child
      if (!child) return
      if (this.options.nativeJobs) {
        try { if (child.exitCode === null && child.signalCode === null) await this.call('shutdown', {}, 1500) } catch { /* The original Job remains authoritative. */ }
        await this.options.nativeJobs.cleanupAll()
        this.failed(new Error('Pi 会话已停止'))
        return
      }
      if (child.exitCode === 70 && process.platform === 'win32') throw new Error('Pi Windows 进程容器清理未确认，请重试结束会话')
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>(accept => child.once('exit', () => accept()))
      try { await this.call('shutdown', {}, 5000) } catch { /* Exact child tree is the bounded shutdown fallback. */ }
      child.stdin.end()
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([exited, new Promise<void>((accept, reject) => { timer = setTimeout(() => {
          if (!child.pid || child.exitCode !== null) { accept(); return }
          if (process.platform === 'win32') execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => error && child.exitCode === null ? reject(new Error('Pi 进程树清理未确认，请重试结束会话')) : accept())
          else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }; accept() }
        }, 3000) })])
        if (child.exitCode === null && child.signalCode === null) await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Pi 进程退出未确认')), 5000))])
      } finally { if (timer) clearTimeout(timer) }
      this.failed(new Error('Pi 会话已停止'))
      if (child.exitCode === 70 && process.platform === 'win32') throw new Error('Pi Windows 进程容器清理未确认')
    })().catch(error => { this.closed = undefined; throw error })
  }
}
