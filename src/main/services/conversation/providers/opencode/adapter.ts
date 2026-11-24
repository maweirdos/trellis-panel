import { realpathSync } from 'node:fs'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import type { OpenCodeClient } from '@opencode/client/effect'
import type { ConversationDriverDescriptor } from '../../../../../shared/conversation/driverCatalog'
import { DaemonError } from '../../../../daemon/errors'
import type { CodexOwnedProcess } from '../codex/process-owner'
import { driverActionEvidence, hostUnsupported } from '../core/catalog'
import {
  ConversationTurnOutcomeUnknownError, ConversationTurnRejectedError,
  type ConversationDriverOpenInput, type ConversationDriverSession, type ConversationDriverEventListener,
  type ConversationResumeThreadInput, type ConversationInterruptTurnInput, type ConversationSteerTurnInput,
} from '../registry'
import { subscribeOpenCode, type OpenCodeNativeEvent } from './OpenCode2Client'
import { openCodeConfigurationKey, openCodeServer } from './OpenCode2Server'

type OpenCodeSdk = typeof import('@opencode/client/effect')
const unavailable = (detail: string): DaemonError => new DaemonError('E_UNAVAILABLE', detail)
const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error))
const run = <Value>(action: () => Promise<Value>): Effect.Effect<Value, Error> => Effect.tryPromise({ try: action, catch: asError })
const samePath = (left: string, right: string): boolean => process.platform === 'win32'
  ? realpathSync.native(left).toLowerCase() === realpathSync.native(right).toLowerCase()
  : realpathSync.native(left) === realpathSync.native(right)
const clearPromptRejections = new Set(['InvalidRequestError', 'ConflictError', 'UnauthorizedError', 'CommandNotFoundError', 'SkillNotFoundError'])
const denyAll = [{ action: '*', resource: '*', effect: 'deny' as const }]

type ActiveTurn = {
  readonly id: string
  readonly publish: ConversationDriverEventListener
  readonly finish: (error?: unknown) => void
  delivered: boolean
  started: boolean
  interrupted: boolean
  submittedControls: Set<string>
}

export class OpenCodeDriver implements ConversationDriverSession {
  private readonly turns = new Map<string, ActiveTurn>()
  private readonly sessions = new Map<string, string>()
  private readonly unsettled = new Set<string>()
  private readonly controls = new Map<string, Promise<unknown>>()
  private readonly abort = new AbortController()
  private owned?: CodexOwnedProcess
  private client?: OpenCodeClient
  private eventReader?: Promise<void>
  private version?: string
  private stopped = false
  private resumeVerified = false
  private cancelVerified = false

  private constructor(
    private readonly input: ConversationDriverOpenInput,
    private readonly sdk: OpenCodeSdk,
    private readonly configurationKey: string,
  ) {}

  static readonly open = (input: ConversationDriverOpenInput): Effect.Effect<OpenCodeDriver, Error> => run(async () => {
    const sdk = await import('@opencode/client/effect')
    const driver = new OpenCodeDriver(input, sdk, openCodeConfigurationKey(input.env))
    input.assertCanSpawn()
    input.onSpawn(driver)
    try {
      const server = await openCodeServer({ ...input, assertCanSpawn: () => driver.assertCurrent() }, handle => { driver.owned = handle })
      const events = await subscribeOpenCode(server.url, server.password, driver.abort.signal)
      driver.assertCurrent()
      driver.client = server.client
      driver.version = server.version
      driver.eventReader = Effect.runPromise(Stream.runForEach(events, event => Effect.sync(() => driver.receive(event))))
        .then(() => driver.transportEnded(new Error('OpenCode 关闭了原生事件流。')), error => driver.transportEnded(error))
      return driver
    } catch (error) { await Effect.runPromise(driver.close()); throw error }
  })

  isAvailable(): boolean { return !this.stopped && this.client !== undefined }

  private assertCurrent(cwd = this.input.cwd): void {
    this.input.assertCanSpawn()
    if (this.stopped || !samePath(cwd, this.input.cwd) || openCodeConfigurationKey(this.input.env) !== this.configurationKey) {
      throw new DaemonError('E_CONFLICT', 'OpenCode 运行实例、配置或工程目录已经变化。')
    }
  }

  private requireClient(): OpenCodeClient {
    if (!this.client || !this.isAvailable()) throw unavailable('OpenCode v2 连接尚未就绪或已经断开。')
    return this.client
  }

  readonly describe = () => run(async (): Promise<ConversationDriverDescriptor> => {
    this.assertCurrent()
    const catalog = await Effect.runPromise(this.requireClient().model.list({
      location: { directory: this.sdk.AbsolutePath.make(this.input.cwd) },
    }).pipe(Effect.timeout('8 seconds')))
    return {
      source: 'native-catalog', configurationKey: this.configurationKey, observedAt: new Date().toISOString(), version: this.version,
      models: catalog.data.map(model => ({ id: `${model.providerID}/${model.id}`, displayName: model.name, isDefault: false, providerId: model.providerID })),
      options: catalog.data.filter(model => model.variants.length).map(model => ({
        id: `${model.providerID}/${model.id}:variant`, label: '模型变体', category: 'reasoning',
        choices: model.variants.map(variant => ({ value: variant.id, label: variant.id })),
      })),
      actions: driverActionEvidence({
        chat: { state: 'verified', source: 'native-catalog', detail: '已核对原生 v2 HTTP 服务和模型目录。' },
        planning: hostUnsupported('OpenCode 原生服务尚未接入团队规划权限。'),
        execution: hostUnsupported('当前 OpenCode 会话禁止工具运行。'),
        toolApproval: hostUnsupported('当前会话采用拒绝工具的固定规则。'),
        ...(this.resumeVerified && { resume: { state: 'verified', source: 'native-session', detail: '已读取并核对相同原生会话。' } as const }),
        ...(this.cancelVerified && { cancel: { state: 'verified', source: 'native-session', detail: '已收到匹配的原生中断结束事件。' } as const }),
      }),
    }
  })

  readonly listModels = () => this.describe().pipe(Effect.map(descriptor => descriptor.models))

  private verifyThread(
    session: { id: string; location: { directory: string }; model?: { providerID: string; id: string }; permissions?: readonly { action: string; resource: string; effect: string }[] },
    model: string,
    cwd: string,
  ): string {
    const selected = session.model && `${session.model.providerID}/${session.model.id}`
    const lastPermission = session.permissions?.at(-1)
    if (selected !== model || !samePath(session.location.directory, cwd)
      || lastPermission?.action !== '*' || lastPermission.resource !== '*' || lastPermission.effect !== 'deny') {
      throw new DaemonError('E_CONFLICT', 'OpenCode 未确认所选模型、工程根或工具禁止规则。')
    }
    this.sessions.set(session.id, model)
    return session.id
  }

  readonly startThread = (model: string, cwd: string) => run(async () => {
    this.assertCurrent(cwd)
    if (!(await Effect.runPromise(this.listModels())).some(candidate => candidate.id === model)) {
      throw unavailable(`OpenCode 未报告所选模型 ${model}。`)
    }
    const created = await Effect.runPromise(this.requireClient().session.create({
      location: this.sdk.Location.PublicRef.make({ directory: this.sdk.AbsolutePath.make(cwd) }),
      model: this.sdk.Model.Ref.parse(model),
      permissions: denyAll,
    }))
    return this.verifyThread(created, model, cwd)
  })

  readonly resumeThread = ({ nativeThreadId, cwd, model }: ConversationResumeThreadInput) => run(async () => {
    this.assertCurrent(cwd)
    const session = await Effect.runPromise(this.requireClient().session.get({ sessionID: this.sdk.Session.ID.make(nativeThreadId) }))
    if (session.id !== nativeThreadId) throw new DaemonError('E_CONFLICT', 'OpenCode 原生恢复返回了其他会话。')
    const id = this.verifyThread(session, model, cwd)
    this.resumeVerified = true
    return id
  })

  readonly startTurn = (id: string, cwd: string, text: string, model: string, publish: ConversationDriverEventListener) => run(async () => {
    this.assertCurrent(cwd)
    if (this.sessions.get(id) !== model || this.turns.has(id) || this.controls.has(id) || this.unsettled.has(id)) {
      throw new ConversationTurnRejectedError('OpenCode 原会话未确认模型或仍有未结算回合。')
    }
    const client = this.requireClient()
    const sessionID = this.sdk.Session.ID.make(id)
    const occupied = await Effect.runPromise(client.session.active().pipe(Effect.timeout('5 seconds'))).catch(cause => {
      throw new ConversationTurnRejectedError('OpenCode 活动检查未确认，未提交本次消息。', { cause })
    })
    if (Object.hasOwn(occupied, id) || this.turns.has(id) || this.controls.has(id) || this.unsettled.has(id)) {
      throw new ConversationTurnRejectedError('OpenCode 原会话仍有活动回合。')
    }
    const requestId = this.sdk.SessionMessage.ID.create()
    let finish: ActiveTurn['finish'] = () => undefined
    const completion = new Promise<void>((resolve, reject) => { finish = error => error === undefined ? resolve() : reject(error) })
    void completion.catch(() => undefined)
    const turn: ActiveTurn = { id: requestId, publish, finish, delivered: false, started: false, interrupted: false, submittedControls: new Set() }
    this.turns.set(id, turn)
    const timeout = setTimeout(() => finish(new ConversationTurnOutcomeUnknownError('')), 30 * 60_000)
    try {
      const submitted = await Effect.runPromise(Effect.result(client.session.prompt({ sessionID, id: requestId, text })))
      if (submitted._tag === 'Failure') {
        if (!turn.delivered && !turn.started && clearPromptRejections.has(submitted.failure._tag)) {
          throw new ConversationTurnRejectedError('OpenCode 原生服务明确拒绝了本轮输入。', { cause: submitted.failure })
        }
        throw new ConversationTurnOutcomeUnknownError('', { cause: submitted.failure })
      }
      await completion
      return ''
    } catch (error) {
      if (error instanceof ConversationTurnRejectedError) throw error
      this.unsettled.add(id)
      throw new ConversationTurnOutcomeUnknownError('', { cause: error })
    } finally { clearTimeout(timeout); this.turns.delete(id) }
  })

  private receive(event: OpenCodeNativeEvent | { readonly type: 'unreadable-execution'; readonly sessionId: string }): void {
    if (event.type === 'unreadable-execution') {
      this.turns.get(event.sessionId)?.finish(new ConversationTurnOutcomeUnknownError(''))
      return
    }
    const data = event.data
    if (!('sessionID' in data) || typeof data.sessionID !== 'string') return
    const turn = this.turns.get(data.sessionID)
    if (!turn) return
    const identity = { turnId: turn.id, turnIdSource: 'host' as const }
    switch (event.type) {
      case 'session.inbox.delivered':
        if (turn.submittedControls.has(event.data.inboxID)) return
        if (event.data.inboxID !== turn.id || turn.delivered) {
          turn.finish(new ConversationTurnOutcomeUnknownError(''))
          return
        }
        turn.delivered = true
        turn.publish({ type: 'turn-accepted', ...identity })
        return
      case 'session.execution.started':
        if (turn.started) turn.finish(new ConversationTurnOutcomeUnknownError(''))
        else turn.started = true
        return
      case 'session.text.delta':
      case 'session.text.ended':
        if (turn.delivered && turn.started) {
          const itemId = `${event.data.assistantMessageID}:${event.data.ordinal}`
          if (event.type === 'session.text.delta') turn.publish({ type: 'text-delta', ...identity, itemId, text: event.data.delta })
          else turn.publish({ type: 'text-final', ...identity, itemId, text: event.data.text })
        }
        return
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        if (!turn.delivered || !turn.started) { turn.finish(new ConversationTurnOutcomeUnknownError('')); return }
        if (turn.interrupted && event.type === 'session.execution.interrupted') this.cancelVerified = true
        turn.publish({
          type: 'turn-completed', ...identity,
          status: event.type === 'session.execution.succeeded' ? 'completed' : event.type === 'session.execution.interrupted' ? 'interrupted' : 'failed',
          ...(event.type === 'session.execution.failed' ? { error: event.data.error.message } : {}),
        })
        turn.finish()
    }
  }

  private control<T>(input: ConversationInterruptTurnInput, action: (turn: ActiveTurn) => Promise<T>): Promise<void> {
    this.assertCurrent()
    const turn = this.turns.get(input.nativeThreadId)
    if (!turn || !turn.delivered || !turn.started || turn.id !== input.turnId || this.controls.has(input.nativeThreadId)) {
      throw new DaemonError('E_CONFLICT', 'OpenCode 控制请求不属于当前活动回合。')
    }
    const work = action(turn)
    this.controls.set(input.nativeThreadId, work)
    return work.then(() => undefined, error => {
      this.unsettled.add(input.nativeThreadId)
      throw error
    }).finally(() => this.controls.delete(input.nativeThreadId))
  }

  readonly interruptTurn = (input: ConversationInterruptTurnInput) => run(() => this.control(input, async turn => {
    turn.interrupted = true
    await Effect.runPromise(this.requireClient().session.interrupt({ sessionID: this.sdk.Session.ID.make(input.nativeThreadId) }))
  }))

  readonly steerTurn = (input: ConversationSteerTurnInput) => run(() => this.control(input, async turn => {
    const id = this.sdk.SessionMessage.ID.create()
    turn.submittedControls.add(id)
    await Effect.runPromise(this.requireClient().session.prompt({
      sessionID: this.sdk.Session.ID.make(input.nativeThreadId), id, text: input.text, delivery: 'steer',
    }))
  }))

  private transportEnded(cause: unknown): void {
    this.stopped = true
    for (const turn of this.turns.values()) turn.finish(new ConversationTurnOutcomeUnknownError('', { cause }))
  }

  readonly close = () => run(async () => {
    this.transportEnded(new Error('OpenCode 会话已关闭。'))
    this.abort.abort()
    try { await this.eventReader }
    finally { await this.owned?.close() }
  })
}
