import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { extname } from 'node:path'
import * as Effect from 'effect/Effect'
import { CreateElicitationRequest, ElicitationPropertySchema, type ContentBlock, type SessionConfigOption } from '@agentclientprotocol/sdk/experimental/v2'
import type { ChatAttachment } from '../../../../../shared/conversation/chatAttachment'
import { ProviderDriverKind, ProviderInstanceId } from '../../../../../shared/conversation/providerInstance'
import type { ConversationDriverDescriptor, ConversationDriverOption } from '../../../../../shared/conversation/driverCatalog'
import type { ProviderApprovalDecision } from '../../../../../shared/conversation/providerPolicy'
import { DaemonError } from '../../../../daemon/errors'
import { listLocalProviders, resolveAdmittedLocalProvider } from '../../../acp/local-providers'
import { AcpProtocolError, AcpV2Client, ACP_V2_METHODS, normalizeSessionConfigOption } from '../../../acp/v2'
import type { AcpClientNotification, AcpClientRequest, AcpVersionedInitialize } from '../../../acp/v2'
import { acpContentBlockDisplayText, sessionUpdateIsReplay } from '../../../acp/t3-core/runtime-model'
import { type CodexOwnedProcess, spawnCodexOwnedProcess } from '../codex/process-owner'
import { driverActionEvidence, driverConfigurationKey, hostUnsupported, type MutableDriverActions } from '../core/catalog'
import { ACP_ATTACHMENTS, assertPromptAttachments, nativeImageAttachment, nativeTextAttachment, TEXT_ATTACHMENTS } from '../core/attachment-input'
import type { ConversationDriverRuntimeRequest, ConversationRuntimeResponse, ConversationRespondToRuntimeRequestInput } from '../registry'
import {
  ConversationTurnOutcomeUnknownError, ConversationTurnRejectedError,
  type ConversationDriverEventListener, type ConversationDriverOpenInput,
  type ConversationDriverRegistration, type ConversationDriverSession, type ConversationDriverTurnEvent,
  type ConversationInterruptTurnInput, type ConversationResumeThreadInput, type ConversationStartTurnContext,
} from '../registry'

const toEffect = <Value>(run: () => Promise<Value>): Effect.Effect<Value, Error> =>
  Effect.tryPromise({ try: run, catch: error => error instanceof Error ? error : new Error(String(error)) })

type AcpSessionConfig = { readonly sessionId: string; options: readonly SessionConfigOption[] }
type PendingRuntimeResponse = { readonly resolve: (response: ConversationRuntimeResponse) => void; readonly reject: (error: Error) => void }
type Turn = {
  readonly turnId: string
  readonly publish: ConversationDriverEventListener
  readonly fallbackItemId: string
  readonly buffered: ConversationDriverTurnEvent[]
  cancelRequested: boolean
  acknowledged: boolean
  overflow: boolean
  readonly runtimeRequests: Map<string, PendingRuntimeResponse>
}

const permissionDecision = (kind: string): ProviderApprovalDecision =>
  kind === 'allow_once' ? 'accept' : kind === 'allow_always' ? 'acceptAlways' : kind === 'reject_once' ? 'decline' : 'cancel'

function toNativeResponse(
  method: string,
  response: ConversationRuntimeResponse,
  options: readonly { readonly decision: ProviderApprovalDecision; readonly label: string; readonly optionId: string }[],
): unknown {
  if (method === ACP_V2_METHODS.clientCreateElicitation) {
    if (response.kind !== 'user-input') return { action: 'cancel' }
    if (!response.attachments) return { action: 'accept', content: response.answers }
    const { questionId, contents } = response.attachments
    const answer = response.answers[questionId]
    if (typeof answer !== 'string') return { action: 'cancel' }
    return { action: 'accept', content: { ...response.answers, [questionId]: [answer, ...contents.map(nativeTextAttachment)].join('\n\n') } }
  }
  if (method === ACP_V2_METHODS.clientRequestPermission) {
    if (response.kind !== 'approval' || response.decision === 'cancel') return { outcome: { outcome: 'cancelled' } }
    const option = options?.find(candidate => candidate.decision === response.decision)
    return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

function modelOption(options: readonly SessionConfigOption[]) {
  const modelOptions = options.map(normalizeSessionConfigOption).filter(option => option?.category === 'model')
  if (modelOptions.length !== 1 || modelOptions[0]?.type !== 'select') {
    throw new DaemonError('E_UNAVAILABLE', 'ACP v2 实例未报告唯一可核对的模型选项。')
  }
  return modelOptions[0]
}

function catalogOptions(options: readonly SessionConfigOption[]): ConversationDriverOption[] {
  return options.flatMap(raw => {
    const option = normalizeSessionConfigOption(raw)
    if (!option) return []
    const grouped = new Map<string, string>()
    if ('options' in raw && Array.isArray(raw.options)) {
      for (const entry of raw.options) {
        if ('options' in entry && 'name' in entry && typeof entry.name === 'string' && Array.isArray(entry.options)) {
          for (const choice of entry.options) {
            if (typeof choice.value === 'string') grouped.set(choice.value, entry.name)
          }
        }
      }
    }
    return [{
      id: option.id,
      label: option.name,
      category: option.category,
      current: option.currentValue,
      choices: option.options.map(choice => ({ value: choice.value, label: choice.name, group: grouped.get(choice.value) })),
    }]
  })
}

class RegisteredAcpDriver implements ConversationDriverSession {
  private client: AcpV2Client | undefined
  private handshake: AcpVersionedInitialize | undefined
  private stopped = false
  private catalogSession: Promise<AcpSessionConfig> | undefined
  private readonly sessions = new Map<string, AcpSessionConfig>()
  private readonly turns = new Map<string, Turn>()
  private controlBarrier: Promise<void> = Promise.resolve()
  private readonly observedAction: MutableDriverActions = {}

  constructor(
    private readonly process: CodexOwnedProcess,
    private readonly input: ConversationDriverOpenInput,
    private readonly configurationKey: string,
  ) {}

  async initialize(): Promise<void> {
    this.process.child.stderr.resume()
    this.process.child.on('error', () => { this.stopped = true })
    this.process.child.once('exit', () => { this.stopped = true })
    this.process.child.stdin.on('error', () => { this.stopped = true })
    this.input.onSpawn(this)
    await this.process.ready
    this.input.assertCanSpawn()
    this.client = await AcpV2Client.connect({ input: this.process.child.stdout, output: this.process.child.stdin }, {
      onNotification: notification => this.notify(notification),
      onRequest: async request => this.respond(request),
      onProtocolError: () => { this.stopped = true },
    })
    this.handshake = await this.client.initialize({ name: 'crux', version: '0.1.0' }, { elicitation: { form: {} } })
    if (!this.handshake.capabilities.session) throw new DaemonError('E_UNAVAILABLE', '该 ACP v2 实例未声明会话能力。')
  }

  isAvailable(): boolean { return !this.stopped && this.handshake !== undefined }

  private connection(): AcpV2Client {
    if (!this.client || !this.isAvailable()) throw new DaemonError('E_UNAVAILABLE', 'ACP v2 实例尚未完成握手或已经断开。')
    return this.client
  }

  private directory(cwd: string): string {
    this.input.assertCanSpawn()
    const actual = realpathSync.native(cwd)
    const original = realpathSync.native(this.input.cwd)
    if (process.platform === 'win32' ? actual.toLowerCase() !== original.toLowerCase() : actual !== original) {
      throw new DaemonError('E_DENIED', 'ACP 会话目录不属于原工程绑定。')
    }
    return actual
  }

  private async create(cwd: string): Promise<AcpSessionConfig> {
    const result = await this.connection().newSession({ cwd: this.directory(cwd), mcpServers: [] })
    const config = { sessionId: result.sessionId, options: result.configOptions ?? [] }
    this.sessions.set(result.sessionId, config)
    return config
  }

  private preview(): Promise<AcpSessionConfig> {
    return this.catalogSession ??= this.create(this.input.cwd).catch(error => { this.catalogSession = undefined; throw error })
  }

  readonly describe = () => toEffect(async (): Promise<ConversationDriverDescriptor> => {
    const config = await this.preview()
    const model = modelOption(config.options)
    const options = catalogOptions(config.options)
    const choices = options.find(option => option.id === model.id)?.choices ?? []
    return {
      source: 'native-session', configurationKey: this.configurationKey, observedAt: new Date().toISOString(),
      version: this.handshake?.response.info.version,
      models: choices.map(choice => ({ id: choice.value, displayName: choice.label, isDefault: choice.value === model.currentValue, group: choice.group })),
      options, selectedModel: model.currentValue,
      actions: driverActionEvidence({
        chat: { state: 'verified', source: 'native-session', detail: 'ACP v2 握手及原生模型目录已经确认。' },
        planning: hostUnsupported('ACP 扩展未提供 Crux 可强制执行的只读边界。'),
        execution: hostUnsupported('ACP 扩展的工具权限无法按团队执行授权逐项确认。'),
        toolApproval: hostUnsupported('当前会话自动拒绝客户端权限请求。'),
        ...this.observedAction,
      }),
    }
  })

  readonly listModels = () => this.describe().pipe(Effect.map(descriptor => descriptor.models))

  private async applyModel(session: AcpSessionConfig, model: string): Promise<string> {
    const option = modelOption(session.options)
    if (!option.options.some(choice => choice.value === model)) throw new DaemonError('E_UNAVAILABLE', `ACP v2 实例未报告模型 ${model}。`)
    if (option.currentValue !== model) {
      const result = await this.connection().setConfigOption({ sessionId: session.sessionId, configId: option.id, type: 'id', value: model })
      if (modelOption(result.configOptions).currentValue !== model) throw new DaemonError('E_UNAVAILABLE', 'ACP v2 实例没有确认选中的模型。')
      session.options = result.configOptions
      this.observedAction.modelSwitch = { state: 'verified', source: 'native-session', detail: '原生配置回执确认所选模型。' }
    }
    return session.sessionId
  }

  readonly startThread = (model: string, cwd: string) => toEffect(async () => {
    this.directory(cwd)
    const pending = this.catalogSession
    this.catalogSession = undefined
    return this.applyModel(pending ? await pending : await this.create(cwd), model)
  })

  readonly resumeThread = ({ nativeThreadId: id, model, cwd }: ConversationResumeThreadInput) => toEffect(async () => {
    const previous = this.sessions.get(id)
    if (previous) { this.directory(cwd); return this.applyModel(previous, model) }
    if (!this.handshake?.capabilities.session) throw new DaemonError('E_UNAVAILABLE', '该 ACP v2 实例未声明原生会话能力。')
    const result = await this.connection().resumeSession({ sessionId: id, cwd: this.directory(cwd), mcpServers: [] })
    const session = { sessionId: id, options: result.configOptions ?? [] }
    this.sessions.set(id, session)
    const resumed = await this.applyModel(session, model)
    this.observedAction.resume = { state: 'verified', source: 'native-session', detail: '原生 ACP 会话恢复已确认。' }
    return resumed
  })

  readonly validatePromptAttachments = (attachments: readonly ChatAttachment[]): void => {
    assertPromptAttachments(attachments, this.handshake?.capabilities.session?.prompt?.image ? ACP_ATTACHMENTS : TEXT_ATTACHMENTS)
  }

  readonly startTurn = (id: string, cwd: string, text: string, model: string, publish: ConversationDriverEventListener, context?: ConversationStartTurnContext) => toEffect(async () => {
    this.directory(cwd)
    const client = this.connection()
    if (this.turns.has(id)) throw new ConversationTurnRejectedError('ACP v2 原会话已有运行。')
    const turn: Turn = {
      turnId: randomUUID(), publish, fallbackItemId: `acp-item-${randomUUID()}`, buffered: [], cancelRequested: false, acknowledged: false, overflow: false,
      runtimeRequests: new Map(),
    }
    const identity = { turnId: turn.turnId, turnIdSource: 'host' as const }
    const prompt: ContentBlock[] = [{ type: 'text', text }]
    try {
      this.validatePromptAttachments((context?.attachments ?? []).map(content => content.attachment))
      for (const content of context?.attachments ?? []) {
        prompt.push(content.attachment.type === 'image'
          ? { type: 'image', ...nativeImageAttachment(content) }
          : { type: 'text', text: nativeTextAttachment(content) })
      }
    } catch (cause) { throw new ConversationTurnRejectedError(cause instanceof Error ? cause.message : String(cause), { cause }) }
    this.turns.set(id, turn)
    try {
      const session = this.sessions.get(id)
      if (!session) throw new ConversationTurnRejectedError('ACP v2 原会话不可用。')
      await this.applyModel(session, model).catch(cause => { throw new ConversationTurnRejectedError('ACP v2 未确认所选模型。', { cause }) })
      await this.controlBarrier
      if (!this.isAvailable() || this.turns.get(id) !== turn || turn.cancelRequested) {
        throw new ConversationTurnRejectedError('ACP v2 回合在派发前已经停止。')
      }
    } catch (cause) {
      this.turns.delete(id)
      throw cause
    }
    let dispatched = false
    const deadline = setTimeout(() => { this.stopped = true; void this.close().pipe(Effect.runPromise).catch(() => undefined) }, 30 * 60_000)
    this.input.assertCanSpawn()
    try {
      const result = await client.prompt({ sessionId: id, prompt }, {
        onDispatch: () => { dispatched = true },
        onInsertion: () => {
          if (this.turns.get(id) !== turn || turn.cancelRequested) return
          turn.acknowledged = true
          turn.publish({ type: 'turn-accepted', ...identity })
          for (const event of turn.buffered) turn.publish(event)
        },
      })
      if (!turn.acknowledged || turn.overflow) throw new ConversationTurnOutcomeUnknownError('')
      const cancelled = turn.cancelRequested && result.stopReason === 'cancelled'
      this.observedAction.cancel = {
        state: cancelled ? 'verified' : 'unknown', source: 'native-session',
        detail: cancelled ? '原生 idle 明确返回 cancelled。' : '当前实例尚未证明可按回合停止。',
      }
      turn.publish({ type: 'turn-completed', ...identity,
        status: result.error ? 'failed' : result.stopReason === 'cancelled' ? 'cancelled' : 'completed',
        ...(result.error ? { error: result.error.message } : {}),
      })
      if (turn.runtimeRequests.size) this.observedAction.toolApproval = { state: 'verified', source: 'native-session', detail: '原生权限或输入请求已按请求 ID 关联并答复。' }
      return ''
    } catch (cause) {
      if (!dispatched || (this.turns.get(id) === turn && !turn.acknowledged && !turn.buffered.length && cause instanceof AcpProtocolError && cause.details.promptRejected)) {
        throw new ConversationTurnRejectedError(cause instanceof Error ? cause.message : 'ACP v2 拒绝了本轮请求。', { cause })
      }
      throw new ConversationTurnOutcomeUnknownError('', { cause })
    } finally {
      clearTimeout(deadline)
      for (const pending of turn.runtimeRequests.values()) pending.reject(new DaemonError('E_CONFLICT', 'ACP v2 回合已经结束。'))
      turn.runtimeRequests.clear()
      this.turns.delete(id)
    }
  })

  private async respond(request: AcpClientRequest): Promise<unknown> {
    if (!('requestId' in request)) return { outcome: { outcome: 'cancelled' } }
    const cancelled = request.method === ACP_V2_METHODS.clientCreateElicitation
      ? { action: 'cancel' }
      : { outcome: { outcome: 'cancelled' } }
    const { params } = request
    if (request.requestId === null || !('sessionId' in params) || typeof params.sessionId !== 'string') return cancelled
    const sessionId = params.sessionId
    const turn = this.turns.get(sessionId)
    if (!this.isAvailable() || !this.sessions.has(sessionId) || !turn || turn.cancelRequested) return cancelled
    const nativeRequestId = String(request.requestId)
    if (turn.runtimeRequests.has(nativeRequestId)) return cancelled

    const options = request.method === ACP_V2_METHODS.clientRequestPermission
      ? request.params.options.flatMap(option => {
          const decision = permissionDecision(option.kind)
          return decision === 'cancel' ? [] : [{ decision, label: option.name, optionId: option.optionId }]
        })
      : []
    let payload: ConversationDriverRuntimeRequest
    if (request.method === ACP_V2_METHODS.clientRequestPermission) {
      if (!options.length) return cancelled
      payload = {
        kind: 'approval', title: request.params.title, details: request.params.description ?? undefined,
        options: [...options, { decision: 'cancel', label: '取消' }],
      }
    } else {
      if (!CreateElicitationRequest.isForm(request.params)) return cancelled
      const questions = []
      for (const [id, property] of Object.entries(request.params.requestedSchema.properties ?? {})) {
        if (!ElicitationPropertySchema.isString(property)) return cancelled
        const choices = property.oneOf?.map(option => ({ value: option.const, label: option.title }))
          ?? property.enum?.map(value => ({ value, label: value }))
        const acceptsTextAttachments = !choices && property.minLength == null && property.maxLength == null && property.pattern == null && property.format == null
        questions.push({
          id, prompt: property.description ?? property.title ?? id, ...(choices ? { choices } : {}),
          ...(acceptsTextAttachments ? { acceptsTextAttachments: true as const } : {}),
        })
      }
      if (!questions.length) return cancelled
      payload = { kind: 'user-input', title: request.params.message, questions }
    }
    const answer = new Promise<ConversationRuntimeResponse>((resolve, reject) => {
      turn.runtimeRequests.set(nativeRequestId, { resolve, reject })
      turn.publish({ type: 'runtime-request', turnId: turn.turnId, turnIdSource: 'host', nativeRequestId, request: payload })
    })
    try {
      const response = await answer
      if (!this.isAvailable() || this.turns.get(sessionId) !== turn || turn.cancelRequested) return cancelled
      return toNativeResponse(request.method, response, options)
    } catch {
      return cancelled
    }
    finally { turn.runtimeRequests.delete(nativeRequestId) }
  }

  private notify(notification: AcpClientNotification): void {
    if (notification.method !== ACP_V2_METHODS.clientSessionUpdate || sessionUpdateIsReplay(notification.params)) return
    const { sessionId, update } = notification.params
    const turn = this.turns.get(sessionId)
    if (!turn) return
    const identity = { turnId: turn.turnId, turnIdSource: 'host' as const }
    const event: ConversationDriverTurnEvent | undefined = update.sessionUpdate === 'agent_message_chunk'
      ? { type: 'text-delta', ...identity, itemId: update.messageId ?? turn.fallbackItemId, text: acpContentBlockDisplayText(update.content) ?? '' }
      : update.sessionUpdate === 'agent_message' && update.content
        ? { type: 'text-final', ...identity, itemId: update.messageId, text: update.content.map(acpContentBlockDisplayText).filter(Boolean).join('\n') }
        : undefined
    if (!event) return
    if (turn.acknowledged) turn.publish(event)
    else if (turn.buffered.length < 256) turn.buffered.push(event)
    else turn.overflow = true
  }

  readonly interruptTurn = ({ nativeThreadId: id, turnId }: ConversationInterruptTurnInput) => toEffect(async () => {
    const turn = this.turns.get(id)
    if (!turn || turn.turnId !== turnId) throw new DaemonError('E_CONFLICT', 'ACP 控制请求与当前活动回合不一致。')
    turn.cancelRequested = true
    // Serialize behind an earlier cancel so a late notification cannot reach the next turn.
    const operation = this.controlBarrier.then(async () => {
      if (this.turns.get(id) !== turn) return
      await this.connection().cancelSession({ sessionId: id })
    })
    this.controlBarrier = operation.catch(() => undefined)
    await operation
  })

  readonly respondToRuntimeRequest = ({ nativeThreadId: id, turnId, nativeRequestId, response }: ConversationRespondToRuntimeRequestInput) => toEffect(async () => {
    const turn = this.turns.get(id)
    if (!turn || turn.turnId !== turnId) throw new DaemonError('E_CONFLICT', 'ACP 运行请求与当前活动回合不一致。')
    const pending = turn.runtimeRequests.get(nativeRequestId)
    if (!pending) throw new DaemonError('E_CONFLICT', 'ACP 运行请求已经结束或不存在。')
    pending.resolve(response)
  })

  readonly canConfirmWindowsJobClose = (nativeThreadId: string): boolean =>
    process.platform === 'win32' && this.sessions.has(nativeThreadId)

  readonly close = () => toEffect(async () => {
    this.stopped = true
    try { await this.client?.close() }
    finally { await this.process.close() }
  })
}

export function listRegisteredAcpDrivers(userData: string): readonly ConversationDriverRegistration[] {
  return listLocalProviders(userData).filter(provider => provider.enabled).map(provider => {
    const resolve = () => resolveAdmittedLocalProvider(userData, provider.id)
    const configurationKey = (): string => {
      const record = resolve()
      return driverConfigurationKey([record.provenance, record.argv, record.env])
    }
    return {
      instanceId: ProviderInstanceId.make(provider.id),
      driverKind: ProviderDriverKind.make('acp'),
      promptAttachments: ACP_ATTACHMENTS,
      configurationKey,
      open: input => toEffect(async () => {
        const record = resolve()
        if (input.instanceId !== record.id) throw new DaemonError('E_DENIED', 'ACP 进程来源与所选实例不一致。')
        if (process.platform === 'win32' && extname(record.executable).toLowerCase() !== '.exe') {
          throw new DaemonError('E_UNAVAILABLE', 'ACP v2 扩展需要已登记的本地原生可执行文件。')
        }
        const expected = configurationKey()
        const owned = await spawnCodexOwnedProcess({
          ...input, ownerKind: 'acp-v2', command: record.executable, args: record.argv,
          env: { ...(input.env ?? process.env), ...Object.fromEntries(record.env.map(entry => [entry.key, entry.value])) },
          assertCanSpawn() {
            input.assertCanSpawn()
            if (configurationKey() !== expected) throw new DaemonError('E_CONFLICT', 'ACP 扩展来源已变化。')
          },
        })
        const session = new RegisteredAcpDriver(owned, input, expected)
        try { await session.initialize(); return session }
        catch (error) { await Effect.runPromise(session.close()); throw error }
      }),
    }
  })
}
