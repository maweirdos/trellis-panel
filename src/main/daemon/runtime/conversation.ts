import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { openConversationDatabase } from '../../services/conversation/persistence/database'
import { ThreadMessageIntake } from '../../services/conversation/orchestration/ThreadMessageIntake'
import { ConversationEventSink } from '../../services/conversation/orchestration/EventSink'
import { ThreadCommands, lifecycleEvent, type ThreadEffectRow } from '../../services/conversation/orchestration/ThreadCommands'
import { ConversationDeadlineError, ConversationEffectWorker, awaitDeadline, runBounded } from '../../services/conversation/orchestration/EffectWorker'
import { decideThreadResume, THREAD_RESUME_MAX_REPLAY_EVENTS } from '../../services/conversation/orchestration/ThreadStream'
import {
  conversationDriverRegistry, ConversationTurnOutcomeUnknownError, ConversationTurnRejectedError,
  type ConversationDriverDescriptor, type ConversationDriverModel, type ConversationDriverRegistration, type ConversationDriverRegistry,
  type ConversationDriverSession, type ConversationDriverTurnEvent, type ConversationRuntimeResponse,
} from '../../services/conversation/providers/registry'
import { DaemonError } from '../errors'
import { pathKey } from '../../services/task-conversations/lib/paths'
import type { ConversationAuthority, ConversationCommandState, ConversationEventPage, ConversationHostEvent, ConversationRunEvidence } from '../../../shared/conversation/desktop'
import { ModelSelection, OrchestrationV2DomainEventJson, ProviderDriverKind, type OrchestrationV2DomainEvent } from '../../../shared/conversation/contracts'
import {
  conversationThreadCommandSchema, type ConversationRuntimeRequest, type ConversationRuntimeRequestResponse,
  type ConversationThreadCommand, type ConversationThreadCommandState, type ConversationThreadEventCursor, type ConversationThreadEventPage,
  type ConversationThreadHistoryCursor, type ConversationThreadHistoryPage, type ConversationThreadSnapshot,
  type ConversationNativeTerminalEvidence,
} from '../../../shared/conversation/command-runtime'

export interface ConversationRuntimePorts {
  directory: string
  driverRegistry?: ConversationDriverRegistry
  deadlines?: Partial<{ open: number; thread: number; turn: number; control: number; close: number }>
  assertOwner(): void
}

interface MessageRow { message_id: string; streaming: number; payload_json: string }
type CommandAuthority = ConversationAuthority & { assertCurrent(): void | Promise<void>; assertSpawnCurrent?(): void }
interface DriverIdentity { readonly projectId: string; readonly fingerprint: string }
interface ActiveTurn {
  readonly row: ThreadEffectRow
  readonly runId: string
  readonly ordinal: number
  readonly attemptId: string
  readonly driver: ConversationDriverSession
  readonly nativeThreadId: string
  readonly authority: CommandAuthority
  readonly configurationFingerprint: string
  controlTurnId?: string
  waitForControlTurn?: Promise<string | undefined>
  signalControlTurn?: (turnId?: string) => void
  hasNativeTurnId?: boolean
  background?: Set<string>
  backgroundOverflow?: boolean
  backgroundTimeout?: ReturnType<typeof setTimeout>
  terminal?: Extract<ConversationDriverTurnEvent, { type: 'turn-completed' }>
  terminalObservedAt?: string
}

const failureMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)
const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection)

/**
 * The new conversation kernel. It owns its storage and never reads legacy ACP history.
 * A turn is executed only by draining its outbox item, so a crash between intake and
 * dispatch leaves exactly one retryable intent instead of a second message.
 */
export class ConversationRuntime {
  private readonly database
  private readonly driverRegistry: ConversationDriverRegistry
  private readonly eventSink: ConversationEventSink
  private readonly intake: ThreadMessageIntake
  private readonly commands: ThreadCommands
  private readonly worker: ConversationEffectWorker
  private readonly storageId: string
  private readonly deadlines
  /** Spawned processes by project root; a thread never runs inside another project's process. */
  private readonly processes = new Map<string, { root: string; driver: ConversationDriverSession }>()
  /** Drivers whose handshake completed, by project root. */
  private readonly ready = new Map<string, DriverIdentity & { driver: ConversationDriverSession }>()
  private readonly driverOpenings = new Map<string, DriverIdentity & { root: string; opening: Promise<ConversationDriverSession> }>()
  private readonly driverFence = new AsyncLocalStorage<() => void>()
  private readonly dispatches = new Map<string, { root: string; work: Promise<void> }>()
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly authorizations = new Map<string, CommandAuthority>()
  private readonly loadedThreads = new Map<string, { driver: ConversationDriverSession; nativeThreadId: string }>()
  private readonly preparingDrivers = new Map<ConversationDriverSession, number>()
  private readonly uncertainDrivers = new WeakSet<ConversationDriverSession>()
  private readonly closingDrivers = new WeakMap<ConversationDriverSession, Promise<void>>()
  private readonly nativeRequests = new Map<string, { turn: ActiveTurn; nativeRequestId: string }>()
  private readonly unsettledTerminals = new Map<string, { turn: ActiveTurn; detail: string; terminal: ConversationNativeTerminalEvidence }>()
  private readonly shutdownController = new AbortController()
  private closing = false
  constructor(private readonly ports: ConversationRuntimePorts) {
    this.ports.assertOwner()
    this.database = openConversationDatabase(ports.directory)
    this.driverRegistry = ports.driverRegistry ?? conversationDriverRegistry
    this.eventSink = new ConversationEventSink(this.database)
    this.commands = new ThreadCommands(this.database, this.eventSink)
    this.intake = new ThreadMessageIntake(this.database, this.eventSink, this.commands)
    this.worker = new ConversationEffectWorker(this.database, this.eventSink)
    this.storageId = (this.database.prepare("SELECT value FROM conversation_meta WHERE key = 'storage_id'").get() as { value: string }).value
    this.deadlines = { open: 30_000, thread: 30_000, turn: 31 * 60_000, control: 15_000, close: 8_000, ...ports.deadlines }
    this.worker.recover()
  }

  private async ensureDriver(cwd: string, projectId: string, registration: ConversationDriverRegistration, assertCurrent: () => void): Promise<ConversationDriverSession> {
    this.ports.assertOwner()
    if (this.closing) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission is closed while the kernel shuts down.')
    const key = JSON.stringify([registration.instanceId, pathKey(cwd)])
    const fingerprint = this.configurationFingerprint(registration)
    const assertConfiguration = (): void => {
      const current = this.driverRegistry.get(registration.instanceId)
      if (!current || current.driverKind !== registration.driverKind || this.configurationFingerprint(current) !== fingerprint) {
        throw new DaemonError('E_CONFLICT', '对话引擎的原配置已变化，请重新选择已授权的配置。')
      }
    }
    assertCurrent()
    assertConfiguration()
    const ready = this.ready.get(key)
    if (ready?.projectId === projectId && ready.fingerprint === fingerprint && ready.driver.isAvailable() && !this.uncertainDrivers.has(ready.driver)) return ready.driver
    const existing = this.driverOpenings.get(key)
    if (existing) {
      if (existing.projectId !== projectId || existing.fingerprint !== fingerprint) {
        throw new DaemonError('E_BUSY', '原目录或配置的引擎启动尚未结束。')
      }
      const driver = await existing.opening
      assertCurrent()
      assertConfiguration()
      return driver
    }
    const identity = { projectId, fingerprint }
    const opening = Promise.resolve().then(() => this.runOpenDriver(key, cwd, identity, registration, assertConfiguration, assertCurrent))
    this.driverOpenings.set(key, { root: cwd, ...identity, opening })
    const driver = await opening
    assertCurrent()
    assertConfiguration()
    return driver
  }

  private configurationFingerprint(registration: ConversationDriverRegistration): string {
    return createHash('sha256').update(JSON.stringify([registration.driverKind, registration.configurationKey?.() ?? null])).digest('hex')
  }

  private async runOpenDriver(
    key: string, cwd: string, identity: DriverIdentity, registration: ConversationDriverRegistration,
    assertConfiguration: () => void, assertCurrent: () => void,
  ): Promise<ConversationDriverSession> {
    let ownedByOpening: { root: string; driver: ConversationDriverSession } | undefined
    let openPhase: 'opening' | 'ready' | 'abandoned' = 'opening'
    try {
      const owned = this.processes.get(key)
      if (owned) {
        if (this.preparingDrivers.has(owned.driver) || [...this.activeTurns.values()].some(turn => turn.driver === owned.driver)) {
          throw new DaemonError('E_BUSY', '同目录的引擎仍由原运行持有。')
        }
        await this.closeOwned(key, owned)
      }
      if (this.closing) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission closed while the engine was starting.')
      assertConfiguration()
      assertCurrent()
      const driver = await runBounded(registration.open({
        instanceId: registration.instanceId,
        directory: this.ports.directory,
        cwd,
        assertCanSpawn: () => {
          this.ports.assertOwner()
          if (this.closing || openPhase === 'abandoned') throw new DaemonError('E_UNAVAILABLE', 'Conversation admission closed while the engine was starting.')
          assertConfiguration()
          if (openPhase === 'opening') assertCurrent()
          else {
            const fence = this.driverFence.getStore()
            if (!fence || this.ready.get(key)?.driver !== ownedByOpening?.driver) {
              throw new DaemonError('E_DENIED', '引擎启动操作缺少当前工程授权。')
            }
            fence()
          }
        },
        onSpawn: spawned => {
          const slot = { root: cwd, driver: spawned }
          ownedByOpening = slot
          if (this.processes.has(key)) throw new DaemonError('E_BUSY', '引擎目录仍由原进程持有。')
          this.processes.set(key, slot)
          if (this.closing || openPhase === 'abandoned') void this.closeOwned(key, slot).catch(() => {})
        },
      }), this.deadlines.open, '启动会话引擎', this.shutdownController.signal)
      if (this.closing) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission closed while the engine was starting.')
      assertConfiguration()
      assertCurrent()
      if (ownedByOpening?.driver !== driver) throw new DaemonError('E_CONFLICT', '引擎握手和本机所有者不一致。')
      this.ready.set(key, { ...identity, driver })
      openPhase = 'ready'
      return driver
    } catch (error) {
      openPhase = 'abandoned'
      if (ownedByOpening) await this.closeOwned(key, ownedByOpening).catch(() => {})
      throw error
    } finally {
      this.driverOpenings.delete(key)
    }
  }

  private closeOwned(key: string, owned: { root: string; driver: ConversationDriverSession }): Promise<void> {
    let closing = this.closingDrivers.get(owned.driver)
    if (!closing) {
      closing = Promise.resolve().then(() => Effect.runPromise(owned.driver.close())).then(() => {
        if (this.processes.get(key) === owned) {
          this.processes.delete(key)
          this.ready.delete(key)
        }
        for (const [threadId, loaded] of this.loadedThreads) {
          if (loaded.driver === owned.driver) this.loadedThreads.delete(threadId)
        }
      }).finally(() => this.closingDrivers.delete(owned.driver))
      this.closingDrivers.set(owned.driver, closing)
    }
    return awaitDeadline(closing, this.deadlines.close, '关闭原引擎进程')
  }

  async listModels(cwd: string, projectId: string, instanceId: string, assertCurrent: () => void): Promise<readonly ConversationDriverModel[]> {
    const registration = this.driverRegistry.require(instanceId)
    const fingerprint = this.configurationFingerprint(registration)
    const driver = await this.ensureDriver(cwd, projectId, registration, assertCurrent)
    assertCurrent()
    const unpin = this.pinPreparation(driver)
    try {
      const models = await this.driverFence.run(assertCurrent, () => runBounded(driver.listModels(), this.deadlines.thread, '读取模型'))
      assertCurrent()
      this.assertDriverFingerprint(instanceId, fingerprint)
      return models
    } finally {
      unpin()
    }
  }

  async describeDriver(cwd: string, projectId: string, instanceId: string, assertCurrent: () => void): Promise<ConversationDriverDescriptor> {
    assertCurrent()
    const registration = this.driverRegistry.require(instanceId)
    const fingerprint = this.configurationFingerprint(registration)
    const driver = await this.ensureDriver(cwd, projectId, registration, assertCurrent)
    assertCurrent()
    if (!driver.describe) throw new DaemonError('E_UNAVAILABLE', '当前对话驱动没有已验证的能力目录。')
    const describe = driver.describe.bind(driver)
    const unpin = this.pinPreparation(driver)
    try {
      const result = await this.driverFence.run(assertCurrent, () => runBounded(describe(), this.deadlines.thread, '读取引擎能力'))
      assertCurrent()
      this.assertDriverFingerprint(instanceId, fingerprint)
      return result
    } finally {
      unpin()
    }
  }

  createThread(input: ConversationAuthority & {
    readonly title?: string
    readonly text: string
    readonly model: string
    readonly instanceId: string
    readonly commandId: string
    readonly messageId?: string
    readonly assertCurrent: () => void
  }): ConversationCommandState {
    this.ports.assertOwner()
    if (this.closing) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission is closed.')
    input.assertCurrent()
    if (input.binding.kind !== 'personal') throw new DaemonError('E_DENIED', '任务会话须通过受控任务入口。')
    const existing = this.eventSink.readReceipt(input.commandId)
    const original = existing?.commandType === 'thread.create' &&
      this.commands.hasThread(existing.threadId, input) ? this.database.prepare(`SELECT provider
        FROM conversation_v2_projection_runs WHERE thread_id = ? AND ordinal = 1`).get(existing.threadId) as { provider: string } | undefined : undefined
    if (existing && !original) throw new DaemonError('E_CONFLICT', '此命令编号已用于另一个请求。')
    const registration = original ? undefined : this.driverRegistry.require(input.instanceId)
    const driverKind = registration?.driverKind ?? Schema.decodeUnknownSync(ProviderDriverKind)(original?.provider)
    const accepted = this.intake.launchThread({
      projectId: input.projectId, ownerId: input.ownerId, spaceId: input.spaceId, title: input.title ?? '',
      text: input.text, driverKind, modelSelection: decodeModelSelection({ instanceId: input.instanceId, model: input.model }),
      commandId: input.commandId, messageId: input.messageId,
    }, input, registration ? this.configurationFingerprint(registration) : undefined)
    if ('conflict' in accepted) throw new DaemonError('E_CONFLICT', accepted.conflict)
    if (!accepted.committed) return this.commandState(accepted.receipt)
    this.authorizations.set(input.commandId, input)
    this.scheduleNext(accepted.receipt.threadId, input)
    return { ...accepted.receipt, dispatch: 'accepted' }
  }

  async command(input: ConversationThreadCommand, authority: CommandAuthority): Promise<ConversationThreadCommandState> {
    const command = conversationThreadCommandSchema.parse(input)
    await this.assertCurrent(command.threadId, authority)
    const prior = this.commands.replay(command, authority)
    if (prior) return this.withUnsettledTerminal(prior)
    const active = this.activeTurns.get(command.threadId)
    switch (command.type) {
      case 'message.dispatch': {
        const registration = this.driverRegistry.require(command.instanceId)
        const selection = {
          driverKind: registration.driverKind,
          modelSelection: decodeModelSelection({ instanceId: registration.instanceId, model: command.model }),
          configurationFingerprint: this.configurationFingerprint(registration),
        }
        if (command.deliveryIntent === 'steer') {
          const turn = this.requireControlTurn(active, 'steerTurn')
          if (turn.configurationFingerprint !== selection.configurationFingerprint) {
            throw new DaemonError('E_CONFLICT', '原回合使用的引擎配置已变化。')
          }
          const state = this.commands.appendMessage(command, authority, selection, {
            targetRunId: turn.runId, targetAttemptId: turn.attemptId,
          })
          this.scheduleControl(command, authority, turn, state.runId)
          return state
        }
        const receipt = this.commands.appendMessage(command, authority, selection)
        this.authorizations.set(command.commandId, authority)
        this.scheduleNext(command.threadId, authority)
        return receipt
      }
      case 'queue.resume':
      case 'queued-run.start':
      case 'queued-run.edit':
      case 'queued-run.reorder':
      case 'queued-run.cancel': {
        const cancelled = command.type === 'queued-run.cancel' ? this.commands.effectForRun(command.threadId, command.runId) : undefined
        const receipt = this.commands.queue(command, authority)
        if (cancelled) this.authorizations.delete(cancelled.command_id)
        if (command.type === 'queue.resume' || command.type === 'queued-run.start') this.scheduleNext(command.threadId, authority)
        return receipt
      }
      case 'run.interrupt':
        return this.acceptStop(command, authority, active)
      case 'queued-message.promote-to-steer': {
        const turn = this.requireControlTurn(active, 'steerTurn', command.targetRunId)
        const run = this.commands.requireQueued(command.threadId, command.queuedRunId)
        const source = this.commands.effectForRun(command.threadId, run.run_id)
        if (!source) throw new DaemonError('E_CONFLICT', '队列项身份已失效。')
        const receipt = this.commands.commit(command, authority, {
          target: { run_id: run.run_id },
          hostEvents: [lifecycleEvent(command.threadId, { kind: 'dispatch', status: 'preparing' }, run.run_id)],
          apply: () => {
            this.commands.insertEffect(command, 'provider-turn.steer', {
              runId: run.run_id, targetRunId: turn.runId, targetAttemptId: turn.attemptId, sourceEffectId: source.effect_id,
            })
            this.database.prepare("UPDATE conversation_v2_effect_outbox SET status = 'cancelled', last_error = ? WHERE effect_id = ? AND status = 'pending'")
              .run('队列项已转交原回合的插话命令。', source.effect_id)
            this.database.prepare("UPDATE conversation_v2_projection_runs SET status = 'starting', payload_json = json_set(payload_json, '$.status', 'starting') WHERE run_id = ?").run(run.run_id)
          },
        })
        this.authorizations.delete(source.command_id)
        this.scheduleControl(command, authority, turn, run.run_id)
        return receipt
      }
      case 'runtime-request.respond': {
        const request = this.commands.request(command.threadId, command.requestId)
        const bound = this.nativeRequests.get(command.requestId)
        if (!request || request.status !== 'pending' || !bound || request.generation !== command.generation || bound.turn !== active) {
          throw new DaemonError('E_CONFLICT', '原审批或提问已失效。')
        }
        const turn = this.requireControlTurn(active, 'respondToRuntimeRequest', request.runId)
        this.requestResponse(request, command)
        const responding = { ...request, status: 'responding' as const }
        const receipt = this.commands.commit(command, authority, {
          target: { run_id: turn.runId, request_id: request.requestId },
          hostEvents: [lifecycleEvent(command.threadId, { kind: 'request', request: responding }, turn.runId)],
          apply: () => {
            this.commands.writeRequest(command.threadId, responding, turn.hasNativeTurnId ? turn.controlTurnId : null)
            this.commands.insertEffect(command, 'runtime-request.respond', {
              runId: turn.runId, requestId: request.requestId, targetAttemptId: turn.attemptId,
            })
          },
        })
        this.scheduleControl(command, authority, turn)
        return receipt
      }
    }
  }

  private requireControlTurn(
    turn: ActiveTurn | undefined, capability: 'steerTurn' | 'respondToRuntimeRequest', expectedRunId?: string,
  ): ActiveTurn & { controlTurnId: string } {
    if (!turn || !turn.controlTurnId || turn.terminal || (expectedRunId && turn.runId !== expectedRunId)) {
      throw new DaemonError('E_CONFLICT', '找不到对应的活动回合。')
    }
    this.worker.assertAttempt(turn.row, turn.attemptId)
    if (!turn.driver[capability]) throw new DaemonError('E_UNAVAILABLE', '当前引擎不支持该操作。')
    return { ...turn, controlTurnId: turn.controlTurnId }
  }

  private acceptStop(
    command: Extract<ConversationThreadCommand, { type: 'run.interrupt' }>, authority: CommandAuthority, turn?: ActiveTurn,
  ): ConversationThreadCommandState {
    const { threadId, runId } = command
    const run = this.commands.run(threadId, runId)
    const source = this.commands.effectForRun(threadId, runId)
    if (!run || !source || !['pending', 'running'].includes(source.status)) {
      throw new DaemonError('E_CONFLICT', '原运行已结束。')
    }
    const attempt = this.worker.attempt(source.effect_id)
    const exactTurn = turn?.runId === runId ? turn : undefined
    const alreadySubmitted = attempt && this.database.prepare(`SELECT 1 FROM conversation_v2_effect_outbox
      WHERE effect_type = 'provider-turn.interrupt' AND status IN ('pending', 'running', 'succeeded')
        AND json_extract(payload_json, '$.targetAttemptId') = ?`).get(attempt.attempt_id)
    const canSubmit = exactTurn?.driver.interruptTurn !== undefined && !exactTurn.terminal && !alreadySubmitted
    const expiredRequests = exactTurn ? this.expiringRequests(exactTurn) : []
    const occurredAt = new Date().toISOString()
    const wasPending = source.status === 'pending'
    const detail = canSubmit || wasPending || attempt?.phase === 'preparing' ? undefined : '队列已暂停。引擎未确认原回合停止。'
    const cancelledRun = { ...JSON.parse(run.payload_json), status: 'cancelled', completedAt: occurredAt }
    const result = this.commands.commit(command, authority, {
      target: { run_id: runId, detail: detail ?? null },
      events: wasPending ? [decodeEvent({ id: randomUUID(), threadId, runId, occurredAt, type: 'run.updated', payload: cancelledRun })] : [],
      hostEvents: [
        lifecycleEvent(threadId, { kind: 'queue', paused: true }, runId, occurredAt),
        lifecycleEvent(threadId, { kind: 'run', phase: detail ? 'stop-unconfirmed' : 'stop-requested' }, runId, occurredAt),
        ...expiredRequests.map(request => lifecycleEvent(threadId, { kind: 'request', request }, runId, occurredAt)),
      ],
      apply: () => {
        this.commands.setPaused(threadId, true)
        if (wasPending) {
          this.database.prepare("UPDATE conversation_v2_effect_outbox SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE effect_id = ? AND status = 'pending'")
            .run(occurredAt, occurredAt, source.effect_id)
          this.database.prepare("UPDATE conversation_v2_projection_runs SET status = 'cancelled', payload_json = ?, completed_at = ? WHERE run_id = ?")
            .run(JSON.stringify(cancelledRun), occurredAt, runId)
        } else {
          this.worker.requestStop(source)
          for (const request of expiredRequests) this.commands.writeRequest(threadId, request, null)
        }
        if (canSubmit) this.commands.insertEffect(command, 'provider-turn.interrupt', { runId, targetAttemptId: exactTurn.attemptId })
      },
    })
    if (exactTurn) this.clearRequestBindings(exactTurn)
    if (wasPending) this.authorizations.delete(source.command_id)
    if (canSubmit) this.scheduleControl(command, authority, exactTurn)
    return result
  }

  private requestResponse(request: ConversationRuntimeRequest, response: Extract<ConversationThreadCommand, { type: 'runtime-request.respond' }> | ConversationRuntimeRequestResponse): ConversationRuntimeResponse {
    if (request.payload.kind === 'approval' && 'decision' in response && response.decision &&
      request.payload.options.some(option => option.decision === response.decision)) {
      return { kind: 'approval', decision: response.decision }
    }
    if (request.payload.kind === 'user-input' && 'answers' in response && response.answers) {
      const questions = new Set(request.payload.questions.map(question => question.id))
      if (Object.keys(response.answers).length && Object.keys(response.answers).every(id => questions.has(id))) {
        return { kind: 'user-input', answers: response.answers }
      }
    }
    throw new DaemonError('E_INVALID_ARG', '回答不符合原审批或提问的选项。')
  }

  private scheduleControl(command: ConversationThreadCommand, authority: CommandAuthority, target: ActiveTurn, steerRunId?: string): void {
    const turn = this.activeTurns.get(command.threadId)
    if (!turn || turn.attemptId !== target.attemptId) return
    this.scheduleWork(command.commandId, authority, () => this.drainControl(command, authority, turn, steerRunId))
  }

  private async drainControl(command: ConversationThreadCommand, authority: CommandAuthority, turn: ActiveTurn, steerRunId?: string): Promise<void> {
    const { threadId } = command
    const effect = this.commands.effect(command.commandId)
    if (!effect || effect.status !== 'pending' || this.closing) return
    const controlAttemptId = this.worker.claim(effect)
    if (!controlAttemptId) return
    let dispatched = false
    try {
      await this.assertCurrent(threadId, authority)
      this.assertThreadScope(threadId, turn.authority)
      const turnId = turn.controlTurnId ?? (command.type === 'run.interrupt' && turn.waitForControlTurn
        ? await awaitDeadline(turn.waitForControlTurn, this.deadlines.control, '等待原回合编号') : undefined)
      await this.assertCurrent(threadId, authority)
      this.assertThreadScope(threadId, turn.authority)
      if (this.activeTurns.get(threadId) !== turn || !turnId || turn.terminal || !this.worker.canObserve(turn.row, turn.attemptId)) {
        throw new DaemonError('E_CONFLICT', '原生回合已结束或换代。')
      }
      if (command.type !== 'run.interrupt') this.worker.assertAttempt(turn.row, turn.attemptId)
      const input = { nativeThreadId: turn.nativeThreadId, turnId }
      let invoke: (() => Effect.Effect<void, Error>) | undefined
      if (command.type === 'run.interrupt' && turn.driver.interruptTurn) {
        const interruptTurn = turn.driver.interruptTurn.bind(turn.driver)
        invoke = () => interruptTurn(input)
      } else if ((command.type === 'message.dispatch' || command.type === 'queued-message.promote-to-steer') && steerRunId && turn.driver.steerTurn) {
        const steerTurn = turn.driver.steerTurn.bind(turn.driver)
        const text = this.commands.readUserMessage(steerRunId).text
        invoke = () => steerTurn({ ...input, text })
      } else if (command.type === 'runtime-request.respond' && turn.driver.respondToRuntimeRequest) {
        const request = this.commands.request(threadId, command.requestId)
        const bound = this.nativeRequests.get(command.requestId)
        if (!request || request.status !== 'responding' || !bound || bound.turn !== turn || request.generation !== command.generation) {
          throw new DaemonError('E_CONFLICT', '原审批或提问已不再可操作。')
        }
        const response = this.requestResponse(request, command)
        const respond = turn.driver.respondToRuntimeRequest.bind(turn.driver)
        invoke = () => respond({ ...input, nativeRequestId: bound.nativeRequestId, response })
      }
      if (!invoke) throw new DaemonError('E_UNAVAILABLE', '当前引擎未提供此项操作。')
      this.worker.markDispatched(effect, controlAttemptId, input.nativeThreadId, () => {}, turn.hasNativeTurnId ? turnId : undefined)
      dispatched = true
      const operation = invoke
      await this.driverFence.run(() => {
        this.assertSpawnAuthority(threadId, authority)
        if (this.activeTurns.get(threadId) !== turn || turn.controlTurnId !== turnId || turn.terminal || !this.worker.canObserve(turn.row, turn.attemptId)) {
          throw new DaemonError('E_CONFLICT', '原生回合已结束或换代。')
        }
      }, () => runBounded(operation(), this.deadlines.control, '对原回合执行控制', this.shutdownController.signal))
      if (!this.worker.isOwned(effect)) return
      if (command.type === 'run.interrupt') {
        this.database.prepare('UPDATE conversation_v2_effect_outbox SET last_error = ? WHERE effect_id = ?')
          .run('停止已递交。正在等待原回合的结束证据。', effect.effect_id)
        return
      }
      this.settleControl(command, effect, 'succeeded', steerRunId)
    } catch (error) {
      if (!this.worker.isOwned(effect)) return
      const status = dispatched && !(error instanceof ConversationTurnRejectedError) ? 'unknown' : 'failed'
      this.settleControl(command, effect, status, steerRunId, failureMessage(error))
    }
  }

  private settleControl(
    command: ConversationThreadCommand, effect: ThreadEffectRow, status: 'succeeded' | 'failed' | 'unknown', steerRunId?: string, detail?: string,
  ): void {
    const occurredAt = new Date().toISOString()
    const { threadId } = command
    const request = command.type === 'runtime-request.respond' ? this.commands.request(threadId, command.requestId) : undefined
    const updatedRequest = request && {
      ...request,
      status: status === 'succeeded' ? 'resolved' as const
        : status === 'unknown' ? 'pending-reconciliation' as const
          : this.nativeRequests.has(request.requestId) ? 'pending' as const : 'expired' as const,
    }
    const run = steerRunId ? this.commands.run(threadId, steerRunId) : undefined
    const runStatus = status === 'succeeded' ? 'completed' : status === 'unknown' ? 'waiting' : 'failed'
    const runPayload = run && {
      ...JSON.parse(run.payload_json), status: runStatus, completedAt: status === 'unknown' ? null : occurredAt,
    }
    this.eventSink.commit({
      commandId: command.commandId,
      events: runPayload && steerRunId ? [decodeEvent({ id: randomUUID(), threadId, runId: steerRunId, occurredAt, type: 'run.updated', payload: runPayload })] : [],
      hostEvents: [
        ...(updatedRequest ? [lifecycleEvent(threadId, { kind: 'request', request: updatedRequest }, updatedRequest.runId, occurredAt)] : []),
        ...(command.type === 'run.interrupt' ? [lifecycleEvent(threadId, { kind: 'run', phase: 'stop-unconfirmed' }, command.runId, occurredAt)] : []),
      ],
    }, () => {
      if (status === 'unknown') this.worker.markUnknown(effect, occurredAt, detail ?? '控制结果待按原命令核对。')
      else this.worker.releaseClaim(effect, occurredAt, status, detail)
      if (runPayload && steerRunId) {
        this.database.prepare('UPDATE conversation_v2_projection_runs SET status = ?, completed_at = ?, payload_json = ? WHERE run_id = ?')
          .run(runStatus, runPayload.completedAt, JSON.stringify(runPayload), steerRunId)
        if (status === 'unknown') this.applyTurnEvidence(steerRunId, { outcomeUnknown: true, outcomeUnknownAt: occurredAt })
        if (status === 'unknown') this.commands.setPaused(threadId, true)
      }
      if (updatedRequest) {
        this.commands.writeRequest(threadId, updatedRequest, null)
        if (updatedRequest.status === 'resolved') this.nativeRequests.delete(updatedRequest.requestId)
      }
    })
  }

  private scheduleNext(threadId: string, current: CommandAuthority): void {
    if (this.closing) return
    const commandId = this.commands.nextCommand(threadId)
    if (!commandId || this.dispatches.has(commandId)) return
    const authority = this.authorizations.get(commandId) ?? current
    this.scheduleWork(commandId, authority, () => this.drainOne(commandId, authority), () => {
      this.authorizations.delete(commandId)
      this.scheduleNext(threadId, current)
    })
  }

  private scheduleWork(commandId: string, authority: CommandAuthority, execute: () => Promise<void>, after?: () => void): void {
    const work = Promise.resolve().then(execute).then(() => true)
      .catch(() => {
        process.emitWarning(`Unable to settle conversation command ${commandId}.`, { code: 'CRUX_CONVERSATION_SETTLEMENT' })
        return false
      })
      .then(completed => {
        this.dispatches.delete(commandId)
        if (completed) after?.()
      })
    this.dispatches.set(commandId, { root: authority.cwd, work })
  }

  private async assertCurrent(threadId: string, authority: CommandAuthority): Promise<void> {
    this.assertThreadScope(threadId, authority)
    await awaitDeadline(Promise.resolve(authority.assertCurrent()), this.deadlines.control, '复核工程授权')
    this.assertThreadScope(threadId, authority)
  }

  private assertThreadScope(threadId: string, authority: ConversationAuthority): void {
    this.ports.assertOwner()
    if (this.closing) throw new DaemonError('E_UNAVAILABLE', '会话内核正在关闭。')
    if (!this.commands.hasThread(threadId, authority)) throw new DaemonError('E_DENIED', '此会话不在当前授权范围。')
  }

  private assertSpawnAuthority(threadId: string, authority: CommandAuthority): void {
    this.assertThreadScope(threadId, authority)
    if (authority.assertSpawnCurrent) {
      authority.assertSpawnCurrent()
      return
    }
    const current = authority.assertCurrent()
    if (current) {
      void current.catch(() => {})
      throw new DaemonError('E_DENIED', '此会话缺少本机启动时的同步授权校验。')
    }
  }

  private assertDriverFingerprint(instanceId: string, expected: string): void {
    const registration = this.driverRegistry.get(instanceId)
    if (!registration || this.configurationFingerprint(registration) !== expected) {
      throw new DaemonError('E_CONFLICT', '对话引擎的原配置已变化。')
    }
  }

  private async openNativeThread(threadId: string, instanceId: string, model: string, cwd: string, driver: ConversationDriverSession): Promise<string> {
    const loaded = this.loadedThreads.get(threadId)
    if (loaded?.driver === driver) return loaded.nativeThreadId
    const existing = this.database.prepare(`SELECT instance_id, native_thread_id FROM conversation_v2_native_bindings WHERE thread_id = ?
      UNION ALL SELECT provider_instance_id, provider_thread_id FROM conversation_v2_projection_runs
        WHERE thread_id = ? AND provider_thread_id IS NOT NULL LIMIT 1`)
      .get(threadId, threadId) as { instance_id: string; native_thread_id: string } | undefined
    if (existing && (existing.instance_id !== instanceId || !driver.resumeThread)) {
      throw new DaemonError('E_UNAVAILABLE', '当前引擎无法按原身份接回此对话。')
    }
    try {
      const nativeThreadId = existing && driver.resumeThread
        ? await runBounded(driver.resumeThread({ nativeThreadId: existing.native_thread_id, cwd, model }), this.deadlines.thread, '恢复原生会话', this.shutdownController.signal)
        : await runBounded(driver.startThread(model, cwd), this.deadlines.thread, '建立原生会话', this.shutdownController.signal)
      if (!nativeThreadId || (existing && nativeThreadId !== existing.native_thread_id)) {
        this.uncertainDrivers.add(driver)
        throw new DaemonError('E_CONFLICT', '引擎没有确认原生会话身份。')
      }
      return nativeThreadId
    } catch (error) {
      if (error instanceof ConversationDeadlineError) this.uncertainDrivers.add(driver)
      throw error
    }
  }

  private pinPreparation(driver: ConversationDriverSession): () => void {
    this.preparingDrivers.set(driver, (this.preparingDrivers.get(driver) ?? 0) + 1)
    return () => {
      const remaining = (this.preparingDrivers.get(driver) ?? 1) - 1
      if (remaining) this.preparingDrivers.set(driver, remaining)
      else this.preparingDrivers.delete(driver)
    }
  }

  private assertNativeBindingConfiguration(threadId: string, fingerprint: string): void {
    const binding = this.database.prepare('SELECT configuration_fingerprint FROM conversation_v2_native_bindings WHERE thread_id = ?')
      .get(threadId) as { configuration_fingerprint: string } | undefined
    if (binding?.configuration_fingerprint && binding.configuration_fingerprint !== fingerprint) {
      throw new DaemonError('E_CONFLICT', '此对话属于原引擎账号或配置，请恢复原配置后继续。')
    }
  }

  private async drainOne(commandId: string, authority: CommandAuthority): Promise<void> {
    this.ports.assertOwner()
    const row = this.commands.effect(commandId)
    if (!row || row.status !== 'pending' || this.closing || this.commands.nextCommand(row.thread_id) !== commandId) return
    const runId = this.worker.runId(row)
    if (!runId) throw new Error('The accepted operation has no run.')
    const { cwd, projectId } = authority
    const threadId = row.thread_id
    const attemptId = this.worker.claim(row)
    if (!attemptId) return
    let turn: ActiveTurn | undefined
    let unpin: (() => void) | undefined
    try {
      await this.assertCurrent(threadId, authority)
      this.worker.assertAttempt(row, attemptId)
      const run = this.commands.run(threadId, runId)
      if (!run) throw new Error('The accepted run is missing.')
      const selection = (JSON.parse(run.payload_json) as { modelSelection: { instanceId: string; model: string } }).modelSelection
      const registration = this.driverRegistry.require(selection.instanceId)
      const expectedFingerprint = this.configurationFingerprint(registration)
      const admittedFingerprint = this.worker.configurationFingerprint(row)
      if (admittedFingerprint && admittedFingerprint !== expectedFingerprint) {
        throw new DaemonError('E_CONFLICT', '排队时选定的引擎配置已失效。')
      }
      this.assertNativeBindingConfiguration(threadId, expectedFingerprint)
      const fence = (): void => {
        this.assertSpawnAuthority(threadId, authority)
        this.assertDriverFingerprint(selection.instanceId, expectedFingerprint)
        this.worker.assertAttempt(row, attemptId)
      }
      const driver = await this.ensureDriver(cwd, projectId, registration, fence)
      unpin = this.pinPreparation(driver)
      await this.assertCurrent(threadId, authority)
      fence()
      const nativeThreadId = await this.driverFence.run(fence, () =>
        this.openNativeThread(threadId, selection.instanceId, selection.model, cwd, driver))
      await this.assertCurrent(threadId, authority)
      fence()
      const prompt = this.commands.readUserMessage(runId).text
      const startedAt = new Date().toISOString()
      const payload = { ...JSON.parse(run.payload_json), status: 'running', providerThreadId: nativeThreadId, startedAt }
      this.worker.markDispatched(row, attemptId, nativeThreadId, () => {
        this.database.prepare("UPDATE conversation_v2_projection_runs SET provider_thread_id = ?, status = 'running', payload_json = ? WHERE run_id = ?")
          .run(nativeThreadId, JSON.stringify(payload), runId)
        this.database.prepare(`INSERT INTO conversation_v2_native_bindings (thread_id, instance_id, native_thread_id, configuration_fingerprint)
          VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET native_thread_id = excluded.native_thread_id,
          configuration_fingerprint = COALESCE(conversation_v2_native_bindings.configuration_fingerprint, excluded.configuration_fingerprint)`)
          .run(threadId, selection.instanceId, nativeThreadId, expectedFingerprint)
      }, undefined, [decodeEvent({ type: 'run.updated', id: randomUUID(), threadId, runId, occurredAt: startedAt, payload })])
      this.loadedThreads.set(threadId, { driver, nativeThreadId })
      const active: ActiveTurn = { row, runId, ordinal: run.ordinal, attemptId, driver, nativeThreadId, authority, configurationFingerprint: expectedFingerprint }
      active.waitForControlTurn = new Promise(resolve => { active.signalControlTurn = resolve })
      turn = active
      this.activeTurns.set(threadId, active)
      unpin()
      unpin = undefined
      const acceptedTurnId = await this.driverFence.run(fence, () => runBounded(
        driver.startTurn(nativeThreadId, cwd, prompt, selection.model, event => this.observeTurn(active, event), {
          requestId: row.command_id, assertCurrent: fence,
        }),
        this.deadlines.turn, '等待原回合结束', this.shutdownController.signal,
      ))
      if (!this.worker.isOwned(row)) return
      if (!active.terminal || active.terminal.turnId !== acceptedTurnId || active.terminal.status === 'running') {
        throw new ConversationTurnOutcomeUnknownError(active.hasNativeTurnId ? active.controlTurnId ?? '' : '')
      }
      this.finishForeground(active)
    } catch (error) {
      if (!this.worker.isOwned(row)) return
      const attempt = this.worker.attempt(row.effect_id)
      if (attempt?.phase === 'unknown' && this.closing) return
      if (turn?.terminal && turn.terminal.status !== 'running') {
        this.finishForeground(turn)
      } else if (attempt?.phase === 'dispatching' && (!(error instanceof ConversationTurnRejectedError) || turn?.controlTurnId)) {
        const nativeTurnId = attempt.native_turn_id ?? (error instanceof ConversationTurnOutcomeUnknownError && turn?.hasNativeTurnId !== false ? error.turnId : '')
        this.settleUnknown(row, runId, nativeTurnId, new Date().toISOString(), '引擎派发或本地结算结果待核对。')
      } else {
        const stopped = attempt?.stop_requested === 1
        const detail = stopped ? '引擎派发前已停止。' : failureMessage(error)
        this.settleOutcome(row, threadId, runId, stopped ? 'cancelled' : 'failed', detail, stopped ? 'cancelled' : 'failed', new Date().toISOString())
      }
    } finally {
      unpin?.()
      turn?.signalControlTurn?.()
      if (this.activeTurns.get(threadId) === turn && this.worker.attempt(row.effect_id)?.phase === 'settled') {
        this.activeTurns.delete(threadId)
      }
    }
  }

  private observeTurn(turn: ActiveTurn, event: ConversationDriverTurnEvent): void {
    const { row, runId } = turn
    if (this.closing || !event.turnId || event.turnId.length > 512 || this.activeTurns.get(row.thread_id) !== turn || !this.worker.canObserve(row, turn.attemptId)) return
    this.ports.assertOwner()
    if (turn.controlTurnId && turn.controlTurnId !== event.turnId) return
    turn.controlTurnId = event.turnId
    turn.signalControlTurn?.(event.turnId)
    turn.hasNativeTurnId ??= event.turnIdSource !== 'host'
    const nativeTurnId = turn.hasNativeTurnId ? event.turnId : undefined
    const state = this.worker.attempt(row.effect_id)
    if (!state) return
    if (event.type === 'turn-receipt' || event.type === 'turn-accepted') {
      const accepted = event.type === 'turn-accepted'
      this.recordTurnEvidence(row.thread_id, runId, {
        ...(nativeTurnId ? { nativeTurnId } : {}),
        ...(accepted ? { engineAcceptedAt: new Date().toISOString() } : {}),
        ...(accepted && event.nativeStartedAt ? { nativeStartedAt: event.nativeStartedAt } : {}),
      }, () => {
        if (nativeTurnId) this.worker.recordNativeTurn(row, nativeTurnId)
      })
    }
    if ((event.type === 'text-delta' || event.type === 'text-final') && event.text && event.itemId && !state.foreground_ended) {
      this.writeAssistantText(row.thread_id, runId, event.itemId, event.text, event.type === 'text-final')
    }
    if (event.type === 'runtime-request' && !state.foreground_ended && !state.stop_requested) {
      const requestId = `request_${createHash('sha256').update(JSON.stringify([turn.attemptId, event.nativeRequestId])).digest('hex')}`
      if (!event.nativeRequestId || event.nativeRequestId.length > 512 || this.commands.request(row.thread_id, requestId) ||
        this.nativeRequests.size >= 256 || Buffer.byteLength(JSON.stringify(event.request)) > 64 * 1024) return
      const request: ConversationRuntimeRequest = {
        requestId, runId, generation: turn.ordinal, kind: event.request.kind,
        payload: event.request, createdAt: new Date().toISOString(), status: 'pending',
      }
      this.eventSink.commit({ hostEvents: [lifecycleEvent(row.thread_id, { kind: 'request', request }, runId)] }, () => {
        this.commands.writeRequest(row.thread_id, request, nativeTurnId ?? null)
        this.commands.bindNativeRequest(requestId, turn.attemptId, event.nativeRequestId)
      })
      this.nativeRequests.set(requestId, { turn, nativeRequestId: event.nativeRequestId })
    }
    if (event.type === 'background-work') {
      const token = event.nativeWorkId ? createHash('sha256').update(event.nativeWorkId).digest('hex') : '*'
      turn.background ??= new Set()
      const previous = turn.background.size
      if (event.pending && (previous < 512 || turn.background.has(token))) turn.background.add(token)
      else if (event.pending) turn.backgroundOverflow = true
      else if (event.nativeWorkId) turn.background.delete(token)
      else {
        turn.background.clear()
        turn.backgroundOverflow = false
      }
      if (previous === 0 && turn.background.size > 0) {
        this.eventSink.commit({ hostEvents: [lifecycleEvent(row.thread_id, { kind: 'run', phase: 'background-running' }, runId)] }, () => {
          this.database.prepare('UPDATE conversation_v2_dispatch_attempts SET background_running = 1 WHERE effect_id = ?').run(row.effect_id)
        })
      }
      if (state.foreground_ended && !turn.backgroundOverflow && turn.background.size === 0 && turn.terminal) {
        this.finishForeground(turn)
      }
    }
    if (event.type === 'turn-completed' && event.status !== 'running') {
      turn.terminal ??= event
      turn.terminalObservedAt ??= new Date().toISOString()
      if (state.phase === 'unknown' || state.foreground_ended) this.finishForeground(turn)
    }
  }

  private finishForeground(turn: ActiveTurn): void {
    const terminal = turn.terminal
    if (!terminal || !this.worker.isOwned(turn.row)) return
    const { row, runId } = turn
    const threadId = row.thread_id
    const evidence: ConversationNativeTerminalEvidence = {
      status: terminal.status, observedAt: turn.terminalObservedAt ?? new Date().toISOString(),
      ...(turn.hasNativeTurnId ? { nativeTurnId: terminal.turnId } : {}),
    }
    try {
      const state = this.worker.attempt(row.effect_id)
      if (!state?.foreground_ended) {
        const expiredRequests = this.expiringRequests(turn)
        this.eventSink.commit({ hostEvents: [
          lifecycleEvent(threadId, { kind: 'run', phase: 'foreground-ended' }, runId, evidence.observedAt),
          lifecycleEvent(threadId, { kind: 'terminal-evidence', evidence }, runId, evidence.observedAt),
          ...expiredRequests.map(request => lifecycleEvent(threadId, { kind: 'request', request }, runId, evidence.observedAt)),
        ] }, () => {
          this.worker.recordNativeTerminal(row, evidence)
          this.database.prepare('UPDATE conversation_v2_dispatch_attempts SET foreground_ended = 1 WHERE effect_id = ?').run(row.effect_id)
          for (const request of expiredRequests) this.commands.writeRequest(threadId, request, null)
          this.settleStopFromTerminal(turn, evidence.observedAt)
        })
        this.clearRequestBindings(turn)
      }
      if (turn.background?.size || turn.backgroundOverflow) {
        turn.backgroundTimeout ??= setTimeout(() => {
          if (!this.closing && this.worker.canObserve(row, turn.attemptId)) {
            this.retainTerminalForReconciliation(turn, evidence, '前台回合已结束，原后台工作仍待核对。')
          }
        }, this.deadlines.turn).unref()
        return
      }
      this.settleTerminal(turn)
      this.unsettledTerminals.delete(row.command_id)
    } catch {
      this.retainTerminalForReconciliation(turn, evidence, '收到原生回合终态，但本地结算未完成，待按原命令核对。')
    }
  }

  private retainTerminalForReconciliation(turn: ActiveTurn, terminal: ConversationNativeTerminalEvidence, detail: string): void {
    const { row, runId } = turn
    try {
      this.settleUnknown(row, runId, terminal.nativeTurnId ?? '', new Date().toISOString(), detail, terminal)
      this.unsettledTerminals.delete(row.command_id)
    } catch {
      this.unsettledTerminals.set(row.command_id, { turn, detail, terminal })
      process.emitWarning(`Unable to persist native terminal evidence for conversation command ${row.command_id}.`, { code: 'CRUX_CONVERSATION_SETTLEMENT' })
    }
  }

  private settleTerminal(turn: ActiveTurn): void {
    const terminal = turn.terminal
    if (!terminal || terminal.status === 'running') return
    const { row, runId } = turn
    const status = terminal.status === 'completed' ? 'completed'
      : terminal.status === 'interrupted' ? 'interrupted' : terminal.status === 'cancelled' ? 'cancelled' : 'failed'
    const outboxStatus = status === 'completed' ? 'succeeded' : status === 'failed' ? 'failed' : 'cancelled'
    if (turn.backgroundTimeout) clearTimeout(turn.backgroundTimeout)
    this.settleOutcome(row, row.thread_id, runId, status, terminal.error, outboxStatus, new Date().toISOString(), turn)
    if (this.activeTurns.get(row.thread_id) === turn) this.activeTurns.delete(row.thread_id)
    if (!this.dispatches.has(row.command_id)) this.scheduleNext(row.thread_id, turn.authority)
  }

  private expiringRequests(turn: ActiveTurn): ConversationRuntimeRequest[] {
    const expired: ConversationRuntimeRequest[] = []
    for (const [requestId, { turn: owner }] of this.nativeRequests) {
      if (turn !== owner) continue
      const request = this.commands.request(turn.row.thread_id, requestId)
      if (request?.status === 'pending') expired.push({ ...request, status: 'expired' })
    }
    return expired
  }

  private clearRequestBindings(turn: ActiveTurn): void {
    for (const [requestId, { turn: owner }] of this.nativeRequests) {
      if (turn === owner) this.nativeRequests.delete(requestId)
    }
  }

  private settleStopFromTerminal(turn: ActiveTurn, settled: string): void {
    const terminal = turn.terminal
    if (!terminal || terminal.status === 'running') return
    const stops = this.database.prepare(`SELECT * FROM conversation_v2_effect_outbox WHERE thread_id = ?
      AND effect_type = 'provider-turn.interrupt' AND status = 'running' AND json_extract(payload_json, '$.targetAttemptId') = ?`)
      .all(turn.row.thread_id, turn.attemptId) as unknown as ThreadEffectRow[]
    for (const stop of stops) {
      if (this.worker.isOwned(stop)) this.worker.releaseClaim(stop, settled, 'succeeded', terminal.status === 'interrupted' || terminal.status === 'cancelled'
        ? '收到原回合停止证据。' : `原回合结束为 ${terminal.status}。`)
    }
  }

  private runEvidenceEvent(threadId: string, runId: string, evidence: ConversationRunEvidence, occurredAt: string): ConversationHostEvent {
    return { id: randomUUID(), threadId, runId, occurredAt, type: 'crux.run-evidence', payload: evidence }
  }

  private recordTurnEvidence(threadId: string, runId: string, evidence: ConversationRunEvidence, apply?: () => void): void {
    this.ports.assertOwner()
    const event = this.runEvidenceEvent(threadId, runId, evidence, new Date().toISOString())
    this.eventSink.commit({ hostEvents: [event] }, () => {
      this.applyTurnEvidence(runId, evidence)
      apply?.()
    })
  }

  private applyTurnEvidence(runId: string, evidence: ConversationRunEvidence): void {
    this.database.prepare('UPDATE conversation_v2_projection_runs SET payload_json = json_patch(payload_json, ?) WHERE run_id = ?').run(JSON.stringify(evidence), runId)
  }

  /** A dispatch failure leaves the run visibly failed with the actual cause; it never looks running. */
  /**
   * Settles the run, its assistant message and the outbox row in one transaction. Normal and
   * exceptional paths share this, so a reader never observes run/outbox disagreement.
   */
  private settleOutcome(row: ThreadEffectRow, threadId: string, runId: string, status: string, detail: string | undefined, outboxStatus: 'succeeded' | 'failed' | 'cancelled', settled: string, turn?: ActiveTurn): void {
    this.ports.assertOwner()
    const run = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_runs WHERE run_id = ?').get(runId) as { payload_json: string } | undefined
    const outputs = this.database.prepare("SELECT payload_json FROM conversation_v2_projection_messages WHERE run_id = ? AND role = 'assistant'").all(runId) as { payload_json: string }[]
    const events: OrchestrationV2DomainEvent[] = []
    if (run) events.push(decodeEvent({
      type: 'run.updated', id: randomUUID(), threadId, runId, occurredAt: settled,
      payload: { ...JSON.parse(run.payload_json), status, completedAt: settled },
    }))
    for (const output of outputs) events.push(decodeEvent({
      type: 'message.updated', id: randomUUID(), threadId, runId, occurredAt: settled,
      payload: { ...JSON.parse(output.payload_json), streaming: false, updatedAt: settled },
    }))
    this.eventSink.commit({ commandId: row.command_id, events, hostEvents: [
      lifecycleEvent(threadId, { kind: 'run', phase: 'settled' }, runId, settled),
      ...(detail ? [this.runEvidenceEvent(threadId, runId, { failure: detail }, settled)] : []),
    ] }, () => {
      this.settleRun(threadId, runId, status, detail, settled)
      this.worker.releaseClaim(row, settled, outboxStatus, detail)
      if (turn) this.settleStopFromTerminal(turn, settled)
    })
  }

  private settleUnknown(row: ThreadEffectRow, runId: string, nativeTurnId: string, settled: string, detail: string, terminal?: ConversationNativeTerminalEvidence): void {
    this.ports.assertOwner()
    const evidence: ConversationRunEvidence = { outcomeUnknown: true, outcomeUnknownAt: settled, failure: detail, ...(nativeTurnId ? { nativeTurnId } : {}) }
    const threadId = row.thread_id
    this.eventSink.commit({ commandId: row.command_id, hostEvents: [
      this.runEvidenceEvent(threadId, runId, evidence, settled),
      lifecycleEvent(threadId, { kind: 'dispatch', status: 'unknown' }, runId, settled),
      lifecycleEvent(threadId, { kind: 'queue', paused: true }, runId, settled),
      ...(terminal ? [lifecycleEvent(threadId, { kind: 'terminal-evidence', evidence: terminal }, runId, settled)] : []),
    ] }, () => {
      this.applyTurnEvidence(runId, evidence)
      if (terminal) this.worker.recordNativeTerminal(row, terminal)
      this.worker.markUnknown(row, settled, detail)
      this.commands.setPaused(threadId, true)
    })
  }

  /** One settlement for run, message streaming and thread activity; readers never see a split state. */
  private settleRun(threadId: string, runId: string, status: string, failure: string | undefined, settled: string): void {
    this.ports.assertOwner()
    const row = this.database.prepare('SELECT payload_json FROM conversation_v2_projection_runs WHERE run_id = ?').get(runId) as { payload_json: string } | undefined
    if (row) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>
      this.database.prepare('UPDATE conversation_v2_projection_runs SET status = ?, completed_at = ?, payload_json = ? WHERE run_id = ?')
        .run(status, settled, JSON.stringify({ ...payload, status, completedAt: settled, outcomeUnknown: undefined, outcomeUnknownAt: undefined, failure }), runId)
    }
    this.database.prepare(`UPDATE conversation_v2_projection_messages SET streaming = 0, updated_at = ?,
      payload_json = json_patch(payload_json, ?) WHERE run_id = ? AND role = 'assistant'`)
      .run(settled, JSON.stringify({ streaming: false, updatedAt: settled }), runId)
    this.database.prepare('UPDATE conversation_v2_projection_threads SET updated_at = ? WHERE thread_id = ?').run(settled, threadId)
  }



  private writeAssistantText(threadId: string, runId: string, itemId: string, text: string, final: boolean): void {
    this.ports.assertOwner()
    const messageId = `msg_${createHash('sha256').update(JSON.stringify([runId, itemId])).digest('hex')}`
    const existing = this.database.prepare('SELECT message_id, payload_json, streaming FROM conversation_v2_projection_messages WHERE message_id = ?')
      .get(messageId) as MessageRow | undefined
    const now = new Date().toISOString()
    if (!existing) {
      const projection = {
        createdBy: 'agent', creationSource: 'server', id: messageId, threadId, runId, nodeId: null, role: 'assistant',
        text, attachments: [], streaming: !final, createdAt: now, updatedAt: now,
      }
      const event = decodeEvent({ id: randomUUID(), threadId, runId, occurredAt: now, type: 'message.updated', payload: projection })
      const first = this.database.prepare("SELECT 1 FROM conversation_v2_projection_messages WHERE run_id = ? AND role = 'assistant' LIMIT 1").get(runId) === undefined
      const evidence = { firstOutputAt: now }
      this.eventSink.commit({ events: [event], hostEvents: first ? [this.runEvidenceEvent(threadId, runId, evidence, now)] : [] }, () => {
        this.database.prepare(`
          INSERT INTO conversation_v2_projection_messages (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
          VALUES (?, ?, ?, NULL, 'assistant', ?, ?, ?, ?)
        `).run(messageId, threadId, runId, final ? 0 : 1, now, now, JSON.stringify(projection))
        if (first) this.applyTurnEvidence(runId, evidence)
      })
      return
    }
    if (existing.streaming === 0) return
    const payload = JSON.parse(existing.payload_json) as { text: string }
    const projection = { ...payload, text: final ? text : payload.text + text, streaming: !final, updatedAt: now }
    const base = { id: randomUUID(), threadId, runId, occurredAt: now }
    this.eventSink.commit(final
      ? { events: [decodeEvent({ ...base, type: 'message.updated', payload: projection })] }
      : { hostEvents: [{ ...base, type: 'crux.message-delta', payload: { messageId, text } }] },
    () => {
      this.database.prepare('UPDATE conversation_v2_projection_messages SET payload_json = ?, updated_at = ?, streaming = ? WHERE message_id = ?')
        .run(JSON.stringify(projection), now, final ? 0 : 1, existing.message_id)
    })
  }



  listThreads(ownerId: string, spaceId: string, projectId: string): unknown {
    this.ports.assertOwner()
    return this.intake.listThreads(ownerId, spaceId, projectId)
  }

  readThread(threadId: string, ownerId: string, spaceId: string, projectId: string): ConversationThreadSnapshot | null {
    this.ports.assertOwner()
    return this.hasThread(threadId, ownerId, spaceId, projectId) ? this.snapshot(threadId) : null
  }

  private snapshot(threadId: string): ConversationThreadSnapshot | null {
    const projection = this.intake.readThread(threadId)
    if (!projection) return null
    const sequence = this.eventSink.latestSequence(threadId)
    const page = this.historyPage(threadId, projection)
    const unrecorded = [...this.unsettledTerminals.values()].find(entry => entry.turn.row.thread_id === threadId)
    return {
      thread: projection.thread,
      cursor: { storageId: this.storageId, threadId, sequence },
      asOfSequence: sequence,
      ...page,
      runs: unrecorded ? page.runs.map(run => run.id === unrecorded.turn.runId ? {
        ...run, outcomeUnknown: true, failure: unrecorded.detail,
        lifecycle: { foregroundEnded: true, backgroundRunning: !!unrecorded.turn.background?.size || !!unrecorded.turn.backgroundOverflow,
          stopRequested: run.lifecycle?.stopRequested ?? false, terminalEvidence: unrecorded.terminal },
      } : run) : page.runs,
      queuePaused: !!unrecorded || this.commands.isPaused(threadId),
      runtimeRequests: this.commands.requests(threadId),
    }
  }

  private hasThread(threadId: string, ownerId: string, spaceId: string, projectId: string): boolean {
    return this.database.prepare('SELECT 1 FROM conversation_v2_projection_threads WHERE thread_id = ? AND owner_id = ? AND space_id = ? AND project_id = ? AND deleted_at IS NULL')
      .get(threadId, ownerId, spaceId, projectId) !== undefined
  }

  readEvents(input: { threadId: string; afterSequence: number; limit?: number }, authority: ConversationAuthority): ConversationEventPage | null {
    this.ports.assertOwner()
    if (!this.commands.hasThread(input.threadId, authority)) return null
    return this.eventSink.readEventPage(input.threadId, input.afterSequence, input.limit ?? 50)
  }

  readEventDelta(input: { threadId: string; cursor: ConversationThreadEventCursor; limit?: number }, authority: ConversationAuthority): ConversationThreadEventPage | null {
    this.ports.assertOwner()
    const { threadId, cursor } = input
    if (!this.commands.hasThread(threadId, authority)) return null
    const highWater = this.eventSink.latestSequence(threadId)
    const valid = ![...this.unsettledTerminals.values()].some(entry => entry.turn.row.thread_id === threadId)
      && cursor.storageId === this.storageId && cursor.threadId === threadId && Number.isSafeInteger(cursor.sequence)
      && cursor.sequence >= 0 && (cursor.sequence === 0 || this.eventSink.hasSequence(threadId, cursor.sequence))
    const budget = valid ? this.eventSink.replaySize(threadId, cursor.sequence, THREAD_RESUME_MAX_REPLAY_EVENTS + 1) : undefined
    if (!budget || decideThreadResume({
      afterSequence: cursor.sequence, highWater, replayEventCount: budget.count, replayEncodedBytes: budget.bytes,
    }).mode === 'snapshot') {
      const snapshot = this.snapshot(threadId)
      return snapshot && { kind: 'reset', snapshot }
    }
    const page = this.eventSink.readLifecyclePage(threadId, cursor.sequence, this.pageLimit(input.limit, THREAD_RESUME_MAX_REPLAY_EVENTS))
    return { ...page, kind: 'events', cursor: { storageId: this.storageId, threadId, sequence: page.nextSequence } }
  }

  readHistory(input: { threadId: string; cursor: ConversationThreadHistoryCursor; limit?: number }, authority: ConversationAuthority): ConversationThreadHistoryPage | null {
    this.ports.assertOwner()
    const { threadId, cursor } = input
    if (!this.commands.hasThread(threadId, authority)) return null
    if (cursor.threadId !== threadId || cursor.storageId !== this.storageId || !Number.isSafeInteger(cursor.beforeRunOrdinal) || cursor.beforeRunOrdinal <= 1) {
      throw new DaemonError('E_RESET_REQUIRED', '对话历史游标已失效，请刷新快照。')
    }
    return this.historyPage(threadId, this.intake.readHistory(threadId, cursor.beforeRunOrdinal, this.pageLimit(input.limit, 32)))
  }

  private pageLimit(limit: number | undefined, maximum: number): number {
    return Number.isSafeInteger(limit) && typeof limit === 'number' ? Math.min(Math.max(limit, 1), maximum) : maximum
  }

  private historyPage(threadId: string, result: ReturnType<ThreadMessageIntake['readHistory']>): ConversationThreadHistoryPage {
    const earliest = result.runs[0]?.ordinal
    return {
      runs: result.runs, messages: result.messages,
      historyCursor: result.hasOlder && earliest !== undefined ? { storageId: this.storageId, threadId, beforeRunOrdinal: earliest } : null,
    }
  }

  readThreadCommand(input: { threadId: string; commandId: string }, authority: ConversationAuthority): ConversationThreadCommandState | null {
    this.ports.assertOwner()
    const result = this.commands.read(input.commandId, authority)
    return result?.threadId === input.threadId ? this.withUnsettledTerminal(result) : null
  }

  private withUnsettledTerminal(state: ConversationThreadCommandState): ConversationThreadCommandState {
    const retained = this.unsettledTerminals.get(state.commandId)
    return retained ? { ...state, dispatch: 'pending-reconciliation', detail: retained.detail } : state
  }

  private commandState(receipt: Omit<ConversationCommandState, 'dispatch'>): ConversationCommandState {
    const retained = this.unsettledTerminals.get(receipt.commandId)
    if (retained) return { ...receipt, dispatch: 'pending-reconciliation', detail: retained.detail }
    const row = this.commands.effect(receipt.commandId)
    const attempt = row && this.worker.attempt(row.effect_id)
    const active = this.dispatches.has(receipt.commandId)
    const dispatch = row?.status === 'succeeded' ? 'completed' : row?.status === 'failed' || row?.status === 'cancelled' ? 'failed'
      : row?.status === 'pending' ? this.commands.isPaused(receipt.threadId) ? 'paused' : 'accepted'
      : attempt?.phase === 'unknown' ? 'pending-reconciliation' : active || this.activeTurns.has(receipt.threadId) ? 'running' : 'pending-reconciliation'
    return { ...receipt, dispatch, ...(row?.last_error ? { detail: row.last_error } : {}) }
  }

  readCommand(commandId: string, ownerId: string, spaceId: string, projectId: string): ConversationCommandState | null {
    this.ports.assertOwner()
    const receipt = this.intake.readCommand(commandId, ownerId, spaceId, projectId)
    return receipt ? this.commandState(receipt) : null
  }

  activityCount(): number {
    return this.dispatches.size + this.driverOpenings.size
  }

  ownsWorkspace(within: (path: string) => boolean): boolean {
    return [...this.dispatches.values()].some(dispatch => within(dispatch.root))
      || [...this.driverOpenings.values()].some(entry => within(entry.root))
      || [...this.processes.values()].some(owned => within(owned.root))
  }

  /**
   * Closes every owned app-server. An unconfirmed exit is reported upward and the driver stays
   * recorded, so the owner never claims a clean shutdown while a process may still be alive.
   */
  async shutdown(): Promise<void> {
    this.closing = true
    this.shutdownController.abort(new DaemonError('E_UNAVAILABLE', '会话内核正在关闭。'))
    for (const turn of this.activeTurns.values()) {
      turn.signalControlTurn?.()
      if (turn.backgroundTimeout) clearTimeout(turn.backgroundTimeout)
    }
    const closes = await Promise.allSettled([...this.processes.entries()].map(([key, owned]) => this.closeOwned(key, owned)))
    const unconfirmed = closes.filter(result => result.status === 'rejected')
    await awaitDeadline(Promise.allSettled([
      ...[...this.driverOpenings.values()].map(entry => entry.opening),
      ...[...this.dispatches.values()].map(dispatch => dispatch.work),
    ]), this.deadlines.close, '等待原工作器退出').finally(() => this.worker.recover())
    if (unconfirmed.length > 0) throw new Error(`${unconfirmed.length} conversation engine process(es) did not confirm exit; their ownership is retained.`)
  }
}
