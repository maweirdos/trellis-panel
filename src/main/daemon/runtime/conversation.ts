import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { openConversationDatabase } from '../../services/conversation/persistence/database'
import { ConversationAttachmentStore } from '../../services/conversation/attachments'
import { conversationAttachmentDraftScope, prepareConversationAttachmentClaim } from '../../services/conversation/attachments/claims'
import { prepareConversationKnowledge } from '../../services/conversation/attachments/knowledge'
import type { ConversationKnowledgeAttachment } from '../../../shared/conversation/knowledge-reference'
import type { ConversationProjectRoleSelection } from '../../../shared/conversation/project-role'
import { expandAssistantCitationsForProvider } from '../../../shared/conversation/assistantCitationText'
import { ThreadMessageIntake } from '../../services/conversation/orchestration/ThreadMessageIntake'
import { ConversationEventSink } from '../../services/conversation/orchestration/EventSink'
import { ThreadCommands, lifecycleEvent, type ThreadEffectRow } from '../../services/conversation/orchestration/ThreadCommands'
import { completeThreadDeletion, recordThreadDeletionDetach } from '../../services/conversation/orchestration/ThreadDeletion'
import { ThreadRelations } from '../../services/conversation/orchestration/ThreadRelations'
import { compactionFromPayload, ThreadContinuation } from '../../services/conversation/orchestration/ThreadContinuation'
import { ContextHandoff, renderPortableHistory, type PortableHistory } from '../../services/conversation/orchestration/ContextHandoff'
import {
  DEFAULT_DELEGATION_WAIT_MS, MAX_DELEGATION_WAIT_MS, DelegatedWork, delegateTaskArguments, delegationOperationId,
  taskRespondArguments, taskStatusArguments,
} from '../../services/conversation/orchestration/DelegatedWork'
import {
  completionIntent, planDelegatedCompletionDelivery, requireUnchangedCompletion, type DelegatedCompletionIntent,
} from '../../services/conversation/orchestration/DelegatedCompletion'
import { ConversationDeadlineError, ConversationEffectWorker, awaitDeadline, runBounded } from '../../services/conversation/orchestration/EffectWorker'
import { decideThreadResume, THREAD_RESUME_MAX_REPLAY_EVENTS } from '../../services/conversation/orchestration/ThreadStream'
import { ANSWER_ATTACHMENT_MAX_BYTES, assertPromptAttachments, nativeTextAttachment, TEXT_ATTACHMENTS } from '../../services/conversation/providers/core/attachment-input'
import { DriverDescriptorCache, bundledFallbackDescriptor } from '../../services/conversation/providers/core/descriptor-cache'
import { resolveCodexCommand } from '../../services/conversation/providers/codex/driver'
import { resolveClaudeSdkExecutablePath } from '../../services/conversation/providers/claude/ClaudeAdapterV2'
import {
  conversationDriverRegistry, ConversationTurnOutcomeUnknownError, ConversationTurnRejectedError,
  type ConversationDriverDescriptor, type ConversationDriverModel, type ConversationDriverRegistration, type ConversationDriverRegistry,
  type ConversationDriverSession, type ConversationDriverTurnEvent, type ConversationDriverWorkItem, type ConversationRuntimeResponse,
} from '../../services/conversation/providers/registry'
import { DaemonError } from '../errors'
import type { WorkcopyUseRegistry } from '../../services/workcopy-use/registry'
import type { CodexWorktreeWriter } from '../../services/conversation/providers/codex/process-owner'
import { codexFileChangeEvidence } from '../../services/conversation/providers/codex/file-change-evidence'
import { resolveWorkcopy } from '../../services/workcopy-use/identity'
import { prepareDelegatedWorktree, recoverDelegatedWorktreePreparation, verifyDelegatedWorktree } from '../../services/conversation/orchestration/DelegatedWorktree'
import { pathKey } from '../../services/task-conversations/lib/paths'
import type { ConversationAuthority, ConversationCommandState, ConversationEventPage, ConversationHostEvent, ConversationRunEvidence } from '../../../shared/conversation/desktop'
import type {
  ConversationAttachmentBytesInput, ConversationAttachmentContent, ConversationAttachmentDraftTarget,
  ConversationAttachmentLocator, ConversationAttachmentReferences,
} from '../../../shared/conversation/attachments'
import { conversationAttachmentLimitError } from '../../../shared/conversation/attachments'
import type { ChatAttachment } from '../../../shared/conversation/chatAttachment'
import type { ConversationDelegationCall, ConversationDelegationReply, ConversationNativeSubagentEvent } from '../../../shared/conversation/thread-relations'
import type { ProviderOptionSelections } from '../../../shared/conversation/model'
import { ModelSelection, OrchestrationV2DomainEventJson, ProviderDriverKind, RunId, type OrchestrationV2DomainEvent, type OrchestrationV2Run } from '../../../shared/conversation/contracts'
import {
  conversationThreadCommandSchema, type ConversationRuntimeRequest, type ConversationRuntimeRequestResponse,
  type ConversationThreadCommand, type ConversationThreadCommandState, type ConversationThreadEventCursor, type ConversationThreadEventPage,
  type ConversationThreadHistoryCursor, type ConversationThreadHistoryPage, type ConversationThreadSnapshot,
  type ConversationNativeTerminalEvidence, type ConversationProjectedWorkItem,
  type ConversationHandoff, type ConversationLifecycleEvent, type ConversationTurnUsage,
} from '../../../shared/conversation/command-runtime'

export interface ConversationRuntimePorts {
  directory: string
  driverRegistry?: ConversationDriverRegistry
  workcopies?: WorkcopyUseRegistry
  deadlines?: Partial<{ open: number; thread: number; turn: number; control: number; close: number }>
  assertOwner(): void
}

interface MessageRow { message_id: string; streaming: number; payload_json: string }
type CommandAuthority = ConversationAuthority & {
  readonly taskContext?: string
  assertCurrent(): void | Promise<void>
  assertReadable?(): Promise<void>
  assertSpawnCurrent?(): void
}
interface DriverIdentity {
  readonly projectId: string
  readonly fingerprint: string
  readonly ordinaryTask: boolean
  readonly ownerScope?: string
  readonly managedExecution?: true
  readonly worktreeWriter?: CodexWorktreeWriter & { readonly projectRoot: string }
}

interface OwnedDriverSlot {
  readonly root: string
  readonly projectRoot?: string
  readonly driver: ConversationDriverSession
}

const driverSlotKey = (instanceId: string, cwd: string, ownerScope?: string): string =>
  JSON.stringify(ownerScope === undefined ? [instanceId, pathKey(cwd)] : [instanceId, pathKey(cwd), ownerScope])

function nativeTaskOwnerScope(authority: ConversationAuthority): string | undefined {
  if (authority.binding.kind === 'planning') return `planning:${authority.binding.planningId}`
  if (authority.binding.kind === 'task' && authority.binding.mode === 'execution') return `execution:${authority.projectId}`
  return undefined
}
interface ActiveTurn {
  readonly row: ThreadEffectRow
  readonly runId: string
  readonly ordinal: number
  readonly attemptId: string
  readonly driver: ConversationDriverSession
  readonly nativeThreadId: string
  readonly executionRoot: string
  readonly authority: CommandAuthority
  readonly configurationFingerprint: string
  readonly writerSlot?: string
  readonly completion?: DelegatedCompletionIntent
  completionAccepted?: boolean
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
const MAX_WORK_ITEMS_PER_RUN = 48
const MAX_WORK_ITEM_BYTES_PER_RUN = 24 * 1024

/**
 * The new conversation kernel. It owns its storage and never reads legacy ACP history.
 * A turn is executed only by draining its outbox item, so a crash between intake and
 * dispatch leaves exactly one retryable intent instead of a second message.
 */
export class ConversationRuntime {
  private readonly database
  private readonly driverRegistry: ConversationDriverRegistry
  private readonly eventSink: ConversationEventSink
  private readonly attachments: ConversationAttachmentStore
  private readonly intake: ThreadMessageIntake
  private readonly commands: ThreadCommands
  private readonly relations: ThreadRelations
  private readonly continuation: ThreadContinuation
  private readonly contextHandoff: ContextHandoff
  private readonly delegatedWork: DelegatedWork
  private readonly worker: ConversationEffectWorker
  private readonly storageId: string
  private readonly deadlines
  /** Spawned processes by project root; a thread never runs inside another project's process. */
  private readonly processes = new Map<string, OwnedDriverSlot>()
  /** Drivers whose handshake completed, by project root. */
  private readonly ready = new Map<string, DriverIdentity & { driver: ConversationDriverSession }>()
  private readonly driverOpenings = new Map<string, DriverIdentity & { root: string; opening: Promise<ConversationDriverSession>; background?: boolean }>()
  private readonly driverFence = new AsyncLocalStorage<() => void>()
  private readonly dispatches = new Map<string, { root: string; work: Promise<void> }>()
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly authorizations = new Map<string, CommandAuthority>()
  private readonly loadedThreads = new Map<string, { driver: ConversationDriverSession; nativeThreadId: string }>()
  private readonly preparingDrivers = new Map<ConversationDriverSession, number>()
  private readonly uncertainDrivers = new WeakSet<ConversationDriverSession>()
  private readonly closingDrivers = new WeakMap<ConversationDriverSession, Promise<void>>()
  private readonly verifiedDeletionCloses = new WeakMap<ConversationDriverSession, string>()
  private readonly nativeRequests = new Map<string, { turn: ActiveTurn; nativeRequestId: string }>()
  private readonly worktreePreparations = new Map<string, { runId: string; controller: AbortController }>()
  private readonly idleCompactions = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly delegationCalls = new Map<string, { input: string; result: Promise<ConversationDelegationReply> }>()
  private readonly delegationContinuationParents = new Map<string, ActiveTurn>()
  private readonly unsettledTerminals = new Map<string, { turn: ActiveTurn; detail: string; terminal: ConversationNativeTerminalEvidence }>()
  private readonly shutdownController = new AbortController()
  private readonly descriptorCache: DriverDescriptorCache
  private readonly backgroundPrewarms = new Set<string>()
  private closing = false
  constructor(private readonly ports: ConversationRuntimePorts) {
    this.ports.assertOwner()
    this.descriptorCache = new DriverDescriptorCache(ports.directory)
    this.database = openConversationDatabase(ports.directory)
    this.driverRegistry = ports.driverRegistry ?? conversationDriverRegistry
    this.eventSink = new ConversationEventSink(this.database)
    this.attachments = new ConversationAttachmentStore(this.database)
    this.commands = new ThreadCommands(this.database, this.eventSink, this.attachments)
    this.contextHandoff = new ContextHandoff(this.database, this.commands)
    this.relations = new ThreadRelations(this.database, this.commands, this.contextHandoff)
    this.delegatedWork = new DelegatedWork(this.database, this.commands, this.eventSink)
    this.continuation = new ThreadContinuation(this.database)
    this.intake = new ThreadMessageIntake(this.database, this.eventSink, this.commands, this.attachments)
    this.worker = new ConversationEffectWorker(this.database, this.eventSink)
    this.storageId = (this.database.prepare("SELECT value FROM conversation_meta WHERE key = 'storage_id'").get() as { value: string }).value
    this.deadlines = { open: 30_000, thread: 30_000, turn: 31 * 60_000, control: 15_000, close: 8_000, ...ports.deadlines }
    this.worker.recover()
    this.relations.reconcileAfterRecovery(this.eventSink)
    this.recoverWorktreePreparations()
  }

  private recoverWorktreePreparations(): void {
    const registry = this.ports.workcopies
    if (!registry) return
    for (const { operationId, parent } of this.delegatedWork.unboundWorktrees()) {
      const key = `worktree-recovery:${operationId}`
      const work = Promise.resolve().then(async () => {
        this.ports.assertOwner()
        const result = await recoverDelegatedWorktreePreparation({ directory: this.ports.directory, registry, operationId, pinnedParent: parent })
        if (result && !result.cleanupConfirmed) throw new Error('Worktree cleanup is unconfirmed.')
      }).catch(() => {
        process.emitWarning('原委派工作树准备清理待核对，保留原凭据。', { code: 'CRUX_DELEGATED_WORKTREE_RECOVERY' })
      }).finally(() => this.dispatches.delete(key))
      this.dispatches.set(key, { root: parent.canonicalRoot, work })
    }
  }

  private async ensureDriver(cwd: string, projectId: string, registration: ConversationDriverRegistration, assertCurrent: () => void, ordinaryTask = false,
    ownerScope?: string, managedExecution?: true, worktreeWriter?: DriverIdentity['worktreeWriter'], background = false) {
    this.ports.assertOwner()
    if (this.closing) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission is closed while the kernel shuts down.')
    const key = driverSlotKey(registration.instanceId, cwd, ownerScope)
    const fingerprint = this.configurationFingerprint(registration)
    const assertConfiguration = (): void => {
      const current = this.driverRegistry.get(registration.instanceId)
      if (!current || current.driverKind !== registration.driverKind || this.configurationFingerprint(current) !== fingerprint) {
        throw new DaemonError('E_CONFLICT', '对话引擎的原配置已变化，请重新选择已授权的配置。')
      }
    }
    assertCurrent()
    assertConfiguration()
    const owned = this.processes.get(key)
    if (owned && (this.closingDrivers.has(owned.driver) || this.verifiedDeletionCloses.has(owned.driver))) {
      throw new DaemonError('E_BUSY', '原引擎的关闭尚未确认完成。')
    }
    const reserve = (driver: ConversationDriverSession) => ({ driver, unpin: this.pinPreparation(driver) })
    const matches = (identity: DriverIdentity): boolean =>
      identity.projectId === projectId && identity.fingerprint === fingerprint && identity.ordinaryTask === ordinaryTask &&
      identity.managedExecution === managedExecution && identity.worktreeWriter?.expected.id === worktreeWriter?.expected.id
    const ready = this.ready.get(key)
    if (ready && matches(ready) &&
      ready.driver.isAvailable() && !this.uncertainDrivers.has(ready.driver)) return reserve(ready.driver)
    const existing = this.driverOpenings.get(key)
    if (existing) {
      if (!matches(existing)) {
        throw new DaemonError('E_BUSY', '原目录或配置的引擎启动尚未结束。')
      }
      // 若前台请求命中正在进行的后台预热，无缝接管并提升为前台优先级，避免重复启动。
      if (!background && existing.background) existing.background = false
      const driver = await existing.opening
      assertCurrent()
      assertConfiguration()
      return reserve(driver)
    }
    const identity = { projectId, fingerprint, ordinaryTask, ownerScope, managedExecution, worktreeWriter }
    const opening = Promise.resolve().then(() => this.runOpenDriver(key, cwd, identity, registration, assertConfiguration, assertCurrent))
    this.driverOpenings.set(key, { root: cwd, ...identity, opening, ...(background ? { background: true } : {}) })
    const driver = await opening
    assertCurrent()
    assertConfiguration()
    return reserve(driver)
  }

  private configurationFingerprint(registration: ConversationDriverRegistration): string {
    return createHash('sha256').update(JSON.stringify([registration.driverKind, registration.configurationKey?.() ?? null])).digest('hex')
  }

  private async runOpenDriver(
    key: string, cwd: string, identity: DriverIdentity, registration: ConversationDriverRegistration,
    assertConfiguration: () => void, assertCurrent: () => void,
  ): Promise<ConversationDriverSession> {
    let ownedByOpening: OwnedDriverSlot | undefined
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
        ownerScope: identity.ownerScope,
        managedExecution: identity.managedExecution,
        worktreeWriter: identity.worktreeWriter,
        directory: this.ports.directory,
        cwd,
        ...(identity.ordinaryTask && { ordinaryTask: true as const }),
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
          const slot = { root: cwd, driver: spawned, projectRoot: identity.worktreeWriter?.projectRoot }
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

  private closeOwned(key: string, owned: { root: string; driver: ConversationDriverSession }, deletion?: {
    readonly commandId: string
    verify(): void
    record(): void
  }): Promise<void> {
    let closing = this.closingDrivers.get(owned.driver)
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        deletion?.verify()
        if (!deletion || this.verifiedDeletionCloses.get(owned.driver) !== deletion.commandId) {
          await Effect.runPromise(owned.driver.close())
        }
        if (deletion) {
          this.verifiedDeletionCloses.set(owned.driver, deletion.commandId)
          deletion.record()
          this.verifiedDeletionCloses.delete(owned.driver)
        }
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

  private isOrdinaryTask(authority: Pick<ConversationAuthority, 'binding'>): boolean {
    return authority.binding.kind === 'task' && authority.binding.mode === 'conversation'
  }

  private requireDriver(instanceId: string, ordinaryTask: boolean): ConversationDriverRegistration {
    const registration = this.driverRegistry.require(instanceId)
    if (ordinaryTask && !registration.ordinaryTaskAccess) throw new DaemonError('E_UNAVAILABLE', '此引擎未确认普通任务所需的只读或工具限制。')
    return registration
  }

  async listModels(cwd: string, projectId: string, instanceId: string, assertCurrent: () => void, ordinaryTask = false): Promise<readonly ConversationDriverModel[]> {
    const registration = this.requireDriver(instanceId, ordinaryTask)
    const fingerprint = this.configurationFingerprint(registration)
    const { driver, unpin } = await this.ensureDriver(cwd, projectId, registration, assertCurrent, ordinaryTask)
    try {
      assertCurrent()
      const models = await this.driverFence.run(assertCurrent, () => runBounded(driver.listModels(), this.deadlines.thread, '读取模型'))
      assertCurrent()
      this.assertDriverFingerprint(instanceId, fingerprint)
      return models
    } finally {
      unpin()
    }
  }

  async describeDriver(cwd: string, projectId: string, instanceId: string, assertCurrent: () => void, ordinaryTask = false, ownerScope?: string): Promise<ConversationDriverDescriptor> {
    assertCurrent()
    const registration = this.requireDriver(instanceId, ordinaryTask)
    const fingerprint = this.configurationFingerprint(registration)
    const cacheLookup = {
      instanceId, driverKind: registration.driverKind, cwd, ordinaryTask, ownerScope, configurationFingerprint: fingerprint,
    }
    const key = driverSlotKey(registration.instanceId, cwd, ownerScope)
    const liveReady = this.ready.get(key)
    const hasLiveReady = liveReady !== undefined
      && liveReady.projectId === projectId
      && liveReady.fingerprint === fingerprint
      && liveReady.ordinaryTask === ordinaryTask
      && liveReady.driver.isAvailable()
      && !this.uncertainDrivers.has(liveReady.driver)

    // 借鉴 t3code ProviderRegistry & BUNDLED_MODEL_MANIFEST：
    // 1) 冷启动尚未拉起进程时，若配置指纹匹配的磁盘缓存存在，毫秒级返回缓存目录；
    // 2) 若首次尚未生成磁盘缓存但本机对应 CLI 已安装（普通个人会话），毫秒级返回内置静态兜底目录；
    // 两种情况下均立即在后台静默拉起真实驱动进程完成握手并落盘最新目录。
    if (!hasLiveReady) {
      const cached = this.descriptorCache.load(cacheLookup)
      if (cached) {
        if (!ordinaryTask && ownerScope === undefined) {
          this.descriptorCache.recordRecentSlot({ cwd, projectId, instanceId })
        }
        this.scheduleBackgroundDriverPrewarm(cwd, projectId, instanceId, registration, fingerprint, ordinaryTask, ownerScope)
        return cached
      }
      if (!ordinaryTask && ownerScope === undefined) {
        const cliInstalled = await this.isDriverCliInstalled(registration.driverKind)
        if (cliInstalled) {
          const fallback = bundledFallbackDescriptor(registration.driverKind, registration.configurationKey?.() ?? fingerprint)
          if (fallback) {
            this.descriptorCache.recordRecentSlot({ cwd, projectId, instanceId })
            this.scheduleBackgroundDriverPrewarm(cwd, projectId, instanceId, registration, fingerprint, ordinaryTask, ownerScope)
            return fallback
          }
        }
      }
    }

    const { driver, unpin } = await this.ensureDriver(cwd, projectId, registration, assertCurrent, ordinaryTask, ownerScope)
    try {
      assertCurrent()
      if (!driver.describe) throw new DaemonError('E_UNAVAILABLE', '当前对话驱动没有已验证的能力目录。')
      const describe = driver.describe.bind(driver)
      const result = await this.driverFence.run(assertCurrent, () => runBounded(describe(), this.deadlines.thread, '读取引擎能力'))
      assertCurrent()
      this.assertDriverFingerprint(instanceId, fingerprint)
      this.descriptorCache.save(cacheLookup, result)
      if (!ordinaryTask && ownerScope === undefined) {
        this.descriptorCache.recordRecentSlot({ cwd, projectId, instanceId })
      }
      return result
    } finally {
      unpin()
    }
  }

  /**
   * 后台单飞预热驱动进程并刷新磁盘目录缓存。
   * 仅做只读握手与目录查询，不创建对话或发送提示词；退出或配置变化时自动中止。
   */
  private scheduleBackgroundDriverPrewarm(
    cwd: string,
    projectId: string,
    instanceId: string,
    registration: ConversationDriverRegistration,
    fingerprint: string,
    ordinaryTask: boolean,
    ownerScope?: string,
  ): void {
    if (this.closing) return
    const key = driverSlotKey(registration.instanceId, cwd, ownerScope)
    if (this.backgroundPrewarms.has(key) || this.driverOpenings.has(key)) return
    this.backgroundPrewarms.add(key)
    const assertBackgroundCurrent = (): void => {
      this.ports.assertOwner()
      if (this.closing) throw new DaemonError('E_UNAVAILABLE', 'Conversation kernel is shutting down.')
      this.assertDriverFingerprint(instanceId, fingerprint)
    }
    setImmediate(() => {
      void (async () => {
        try {
          if (this.closing) return
          const { driver, unpin } = await this.ensureDriver(cwd, projectId, registration, assertBackgroundCurrent, ordinaryTask, ownerScope, undefined, undefined, true)
          try {
            if (this.closing || !driver.describe) return
            const describe = driver.describe.bind(driver)
            const result = await this.driverFence.run(assertBackgroundCurrent, () => runBounded(describe(), this.deadlines.thread, '预热引擎能力'))
            assertBackgroundCurrent()
            this.descriptorCache.save(
              { instanceId, driverKind: registration.driverKind, cwd, ordinaryTask, ownerScope, configurationFingerprint: fingerprint },
              result,
            )
          } finally {
            unpin()
          }
        } catch {
          // 后台预热失败静默忽略；用户实际发消息或主动刷新时会走正常前台错误反馈。
        } finally {
          this.backgroundPrewarms.delete(key)
        }
      })()
    })
  }

  private async isDriverCliInstalled(driverKind: string): Promise<boolean> {
    try {
      if (driverKind === 'codex') {
        await resolveCodexCommand(process.env)
        return true
      }
      if (driverKind === 'claudeCode') {
        resolveClaudeSdkExecutablePath(process.env)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * Daemon 启动就绪后调用：按最近活跃记录及默认托管目录在后台预热最多 2 个个人工作区驱动进程，
   * 让用户一进入界面或会话时，驱动进程已处于 ready 态可直接收发消息。
   */
  prewarmRecentDrivers(defaults: ReadonlyArray<{ cwd: string; projectId: string; instanceId: string }> = []): void {
    if (this.closing) return
    const combined = [...this.descriptorCache.listRecentSlots(), ...defaults]
    const seen = new Set<string>()
    let scheduled = 0
    for (const slot of combined) {
      if (scheduled >= 2) break
      const slotKey = `${pathKey(slot.cwd)}\0${slot.instanceId}`
      if (seen.has(slotKey)) continue
      seen.add(slotKey)
      if (!existsSync(slot.cwd)) continue
      const registration = this.driverRegistry.get(slot.instanceId)
      if (!registration) continue
      const fingerprint = this.configurationFingerprint(registration)
      this.scheduleBackgroundDriverPrewarm(slot.cwd, slot.projectId, slot.instanceId, registration, fingerprint, false)
      scheduled += 1
    }
  }

  private async attachmentDraftAuthority(target: ConversationAttachmentDraftTarget, authority: CommandAuthority) {
    if ((target.requestId === undefined) !== (target.generation === undefined) || (target.requestId && !target.threadId)) {
      throw new DaemonError('E_INVALID_ARG', '提问附件需要原会话、请求和代次。')
    }
    if (target.threadId) await this.assertCurrent(target.threadId, authority)
    else {
      await awaitDeadline(Promise.resolve(authority.assertCurrent()), this.deadlines.control, '复核附件草稿授权')
      this.ports.assertOwner()
      if (this.closing) throw new DaemonError('E_UNAVAILABLE', '会话内核正在关闭。')
    }
    if (target.requestId && target.threadId) {
      const request = this.commands.request(target.threadId, target.requestId)
      if (request?.kind !== 'user-input' || request.generation !== target.generation) {
        throw new DaemonError('E_CONFLICT', '原提问附件草稿已失效。')
      }
    }
    return conversationAttachmentDraftScope(authority, target)
  }

  async stageAttachment(target: ConversationAttachmentDraftTarget, input: ConversationAttachmentBytesInput, authority: CommandAuthority) {
    const scope = await this.attachmentDraftAuthority(target, authority)
    if (target.requestId && target.threadId) {
      const request = this.commands.request(target.threadId, target.requestId)
      const bound = this.nativeRequests.get(target.requestId)
      if (!request || request.status !== 'pending' || !bound || this.activeTurns.get(target.threadId) !== bound.turn || bound.turn.terminal) {
        throw new DaemonError('E_CONFLICT', '原提问已失效。')
      }
      if (request.payload.kind !== 'user-input' || !request.payload.questions.some(question => question.acceptsTextAttachments)) {
        throw new DaemonError('E_UNAVAILABLE', '原生提问没有支持附件的文本字段。')
      }
    }
    return this.attachments.stageBytes(scope, input, target.requestId ? { totalBytes: ANSWER_ATTACHMENT_MAX_BYTES } : undefined)
  }

  async stageKnowledgeAttachment(target: ConversationAttachmentDraftTarget, knowledge: ConversationKnowledgeAttachment, authority: CommandAuthority) {
    if (target.requestId || authority.binding.kind !== 'personal' || (target.threadId && this.commands.isArchived(target.threadId))) {
      throw new DaemonError('E_DENIED', '只能将资料加入原工程中可编辑的会话草稿。')
    }
    const scope = await this.attachmentDraftAuthority(target, { ...authority, knowledgePageId: knowledge.pageId })
    return this.attachments.stageKnowledge(scope, knowledge)
  }

  async listAttachments(target: ConversationAttachmentDraftTarget, authority: CommandAuthority) {
    const scope = await this.attachmentDraftAuthority(target, authority)
    return this.attachments.listDraft(scope)
  }

  async releaseAttachment(target: ConversationAttachmentDraftTarget & { readonly attachmentId: string }, authority: CommandAuthority) {
    const scope = await this.attachmentDraftAuthority(target, authority)
    return this.attachments.releaseDraft(scope, target.attachmentId)
  }

  async readAttachment(input: ConversationAttachmentLocator, authority: CommandAuthority): Promise<ConversationAttachmentContent | null> {
    this.assertThreadScope(input.threadId, authority)
    await awaitDeadline(Promise.resolve(authority.assertReadable?.() ?? authority.assertCurrent()), this.deadlines.control, '复核附件读取授权')
    this.assertThreadScope(input.threadId, authority)
    return this.attachments.readClaimed({ ownerId: authority.ownerId, spaceId: authority.spaceId, root: authority.cwd }, input)
  }

  readAttachmentContents(threadId: string, attachments: readonly ChatAttachment[] | undefined, authority: ConversationAuthority): readonly ConversationAttachmentContent[] {
    if (!attachments?.length) return []
    this.assertThreadScope(threadId, authority)
    const limitError = conversationAttachmentLimitError(attachments)
    if (limitError) throw new DaemonError('E_INVALID_ARG', limitError)
    const scope = { ownerId: authority.ownerId, spaceId: authority.spaceId, root: authority.cwd }
    return attachments.map(attachment => {
      const content = this.attachments.readClaimed(scope, { threadId, attachmentId: attachment.id })
      if (!content) throw new DaemonError('E_CONFLICT', '找不到原会话附件。')
      return content
    })
  }

  createThread(input: ConversationAuthority & ConversationAttachmentReferences & {
    readonly title?: string
    readonly text: string
    readonly model: string
    readonly instanceId: string
    readonly commandId: string
    readonly messageId?: string
    readonly options?: ProviderOptionSelections
    readonly assertCurrent: () => void
    readonly assertAuthorityCurrent?: () => void | Promise<void>
    readonly assertSpawnCurrent?: () => void
    readonly taskContext?: string
    readonly role?: { readonly selection: ConversationProjectRoleSelection; readonly readInstructions: () => string }
  }): ConversationCommandState {
    this.ports.assertOwner()
    if (this.closing) throw new DaemonError('E_UNAVAILABLE', 'Conversation admission is closed.')
    input.assertCurrent()
    if (input.binding.kind !== 'personal' && (!input.assertAuthorityCurrent || !input.assertSpawnCurrent)) {
      throw new DaemonError('E_DENIED', '任务会话须通过受控任务入口。')
    }
    if (!input.text.trim() && !input.attachmentIds?.length) throw new DaemonError('E_INVALID_ARG', '请输入文字或添加附件。')
    const existing = this.eventSink.readReceipt(input.commandId)
    const original = existing?.commandType === 'thread.create' &&
      this.commands.hasThread(existing.threadId, input) ? this.database.prepare(`SELECT provider
        FROM conversation_v2_projection_runs WHERE thread_id = ? AND ordinal = 1`).get(existing.threadId) as { provider: string } | undefined : undefined
    if (existing && !original) throw new DaemonError('E_CONFLICT', '此命令编号已用于另一个请求。')
    const registration = original ? undefined : this.requireDriver(input.instanceId, this.isOrdinaryTask(input))
    if (input.binding.kind === 'planning' && registration && !registration.planningAccess) {
      throw new DaemonError('E_UNAVAILABLE', '此引擎没有原工程只读规划能力。')
    }
    if (input.binding.kind === 'task' && input.binding.mode !== 'conversation' &&
      (input.binding.mode !== 'execution' || registration && !registration.executionAccess)) {
      throw new DaemonError('E_UNAVAILABLE', '此引擎没有原工作副本的托管执行能力。')
    }
    if (registration && input.options?.length && !registration.turnModelOptions) {
      throw new DaemonError('E_UNAVAILABLE', '此引擎暂不接受回合模型参数。')
    }
    const driverKind = registration?.driverKind ?? Schema.decodeUnknownSync(ProviderDriverKind)(original?.provider)
    const accepted = this.intake.launchThread({
      projectId: input.projectId, ownerId: input.ownerId, spaceId: input.spaceId, title: input.title ?? '',
      text: input.text, driverKind, modelSelection: decodeModelSelection({ instanceId: input.instanceId, model: input.model, options: input.options }),
      commandId: input.commandId, messageId: input.messageId,
      ...(input.role && { role: input.role.selection }),
      ...(input.attachmentIds !== undefined ? { attachmentIds: input.attachmentIds, draftId: input.draftId } : {}),
    }, input, registration ? this.configurationFingerprint(registration) : undefined, registration?.promptAttachments,
    input.role?.readInstructions)
    if ('conflict' in accepted) throw new DaemonError('E_CONFLICT', accepted.conflict)
    if (!accepted.committed) return this.commandState(accepted.receipt)
    const authority = { ...input, assertCurrent: input.assertAuthorityCurrent ?? input.assertCurrent }
    this.authorizations.set(input.commandId, authority)
    this.scheduleNext(accepted.receipt.threadId, authority)
    return { ...accepted.receipt, dispatch: 'accepted' }
  }

  async command(input: ConversationThreadCommand, authority: CommandAuthority): Promise<ConversationThreadCommandState> {
    const command = conversationThreadCommandSchema.parse(input)
    await this.assertCurrent(command.threadId, authority, command.type === 'thread.delete')
    if (command.type === 'thread.delete') return this.deleteThread(command, authority)
    const prior = this.commands.replay(command, authority)
    if (prior) return this.withUnsettledTerminal(prior)
    const delegated = this.relations.delegatedParent(command.threadId)
    const restrictedRelation = delegated ?? this.relations.restrictedParent(command.threadId)
    if (delegated && !['thread.rename', 'thread.pin', 'thread.archive', 'run.interrupt', 'runtime-request.respond',
      'queue.resume', 'queued-run.start', 'queued-run.cancel'].includes(command.type)) {
      throw new DaemonError('E_DENIED', '委派子会话只接受原运行的控制和答复。')
    }
    if (!command.type.startsWith('thread.') && this.commands.isArchived(command.threadId)) {
      throw new DaemonError('E_CONFLICT', '请先恢复已归档的会话。')
    }
    const active = this.activeTurns.get(command.threadId)
    switch (command.type) {
      case 'thread.rename': {
        const previous = this.relations.read(command.threadId).parent
        const change = previous && this.relations.update({ ...previous, title: command.title, updatedAt: new Date().toISOString() })
        return this.commands.changeThread(command, authority, undefined, change?.hostEvents, change?.apply)
      }
      case 'thread.pin':
      case 'thread.archive':
        return this.commands.changeThread(command, authority)
      case 'thread.fork': {
        if (this.commands.isArchived(command.threadId) || authority.binding.kind === 'planning' ||
          authority.binding.kind === 'task' && !this.isOrdinaryTask(authority)) {
          throw new DaemonError('E_DENIED', '此会话当前不能派生其他会话。')
        }
        if (restrictedRelation && !command.readOnly) throw new DaemonError('E_DENIED', '只读会话只能派生只读分支。')
        const plan = this.relations.planFork(command, authority)
        if (command.readOnly || command.selection) {
          const registration = this.requireDriver(plan.relation.instanceId, this.isOrdinaryTask(authority) || !!command.readOnly)
          if (command.readOnly && registration.ordinaryTaskAccess !== 'native-read-only') {
            throw new DaemonError('E_UNAVAILABLE', '所选引擎没有可核实的原生只读能力。')
          }
          if (command.selection?.options?.length && !registration.turnModelOptions) {
            throw new DaemonError('E_UNAVAILABLE', '所选引擎不支持此模型参数。')
          }
          if (command.selection) decodeModelSelection(command.selection)
        }
        return this.commands.commit(command, authority, plan)
      }
      case 'thread.goal.set':
      case 'thread.goal.pause':
      case 'thread.goal.resume':
      case 'thread.goal.clear':
        if (this.commands.isArchived(command.threadId)) throw new DaemonError('E_CONFLICT', '请先恢复已归档的会话。')
        return this.commands.commit(command, authority, this.continuation.planGoal(command))
      case 'thread.compact':
        return this.acceptCompaction(command, authority, 'manual')
      case 'thread.handoff':
        if (authority.binding.kind !== 'personal' || restrictedRelation || this.commands.isArchived(command.threadId) ||
          this.activeTurns.has(command.threadId) || this.commands.isPaused(command.threadId)) {
          throw new DaemonError('E_BUSY', '仅可在已结算且未暂停的个人会话中交接。')
        }
        this.continuation.latestForCompaction(command.threadId)
        break
      case 'message.dispatch': {
        const registration = this.requireDriver(command.instanceId, this.isOrdinaryTask(authority))
        if (command.options?.length && (!registration.turnModelOptions || command.deliveryIntent === 'steer')) {
          throw new DaemonError('E_UNAVAILABLE', '此操作无法更改回合模型参数。')
        }
        const selection = {
          driverKind: registration.driverKind,
          modelSelection: decodeModelSelection({ instanceId: registration.instanceId, model: command.model, options: command.options }),
          configurationFingerprint: this.configurationFingerprint(registration),
        }
        if (command.deliveryIntent === 'steer') {
          if (command.references?.length) throw new DaemonError('E_UNAVAILABLE', '带历史引用的消息请正常发送或加入队列。')
          if (command.attachmentIds?.length) throw new DaemonError('E_UNAVAILABLE', '当前插话入口只支持文字，请把附件加入队列。')
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
        const portableHistory = command.references?.map(reference => this.contextHandoff.capture(reference, authority))
        const receipt = this.commands.appendMessage(command, authority, selection, undefined, registration.promptAttachments, portableHistory, this.relations)
        this.authorizations.set(command.commandId, authority)
        this.scheduleNext(command.threadId, authority)
        return receipt
      }
      case 'queue.resume':
      case 'queued-run.start':
      case 'queued-run.edit':
      case 'queued-run.reorder':
      case 'queued-run.cancel': {
        const queued = command.type === 'queued-run.start' ? this.commands.effectForRun(command.threadId, command.runId) : undefined
        const originalCompletion = completionIntent(queued)
        if (originalCompletion && command.type === 'queued-run.start') {
          this.assertDelegatedCompletionCurrent(command.threadId, originalCompletion, authority, command.runId, true)
        }
        const cancelled = command.type === 'queued-run.cancel' ? this.commands.effectForRun(command.threadId, command.runId) : undefined
        const edited = command.type === 'queued-run.edit' && command.attachmentIds?.length
          ? this.commands.requireQueued(command.threadId, command.runId) : undefined
        const previous = command.type === 'queued-run.cancel' ? this.relations.read(command.threadId).parent : null
        const at = new Date().toISOString()
        const change = command.type === 'queued-run.cancel' && previous?.childRunId === command.runId
          ? delegated ? this.settleDelegatedWork(delegated, 'cancelled', at, [])
            : this.relations.childUpdate(command.threadId, 'cancelled', command.runId, at)
          : cancelled ? this.disposeDelegatedCompletion(cancelled, at) : undefined
        const receipt = this.commands.queue(command, authority, edited ? this.driverRegistry.require(edited.provider_instance_id).promptAttachments : undefined, change)
        if (cancelled) this.authorizations.delete(cancelled.command_id)
        if (queued && originalCompletion) this.authorizations.set(queued.command_id, authority)
        if (command.type === 'queue.resume' || command.type === 'queued-run.start') this.scheduleNext(command.threadId, authority)
        if (previous?.kind === 'delegated' && change) this.offerDelegatedCompletionDelivery(previous.parentThreadId, previous.parentRunId)
        return receipt
      }
      case 'run.interrupt':
        return this.acceptStop(command, authority, active)
      case 'queued-message.promote-to-steer': {
        const turn = this.requireControlTurn(active, 'steerTurn', command.targetRunId)
        const run = this.commands.requireQueued(command.threadId, command.queuedRunId)
        const source = this.commands.effectForRun(command.threadId, run.run_id)
        if (compactionFromPayload(run.payload_json) || completionIntent(source) || source && (JSON.parse(source.payload_json) as {
          portableHistory?: unknown; handoff?: true
        }).portableHistory) {
          throw new DaemonError('E_UNAVAILABLE', '压缩或带历史引用的队列操作需要独立回合。')
        }
        if (this.commands.readUserMessage(run.run_id).attachments?.length) {
          throw new DaemonError('E_UNAVAILABLE', '带附件的队列消息需要独立回合。')
        }
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
        if ((this.isOrdinaryTask(authority) || restrictedRelation) && request.kind === 'approval' && command.decision !== 'decline' && command.decision !== 'cancel') {
          throw new DaemonError('E_DENIED', '普通任务的对话不能批准工具操作。')
        }
        const response = this.requestResponse(request, command)
        const questionId = command.attachmentIds?.length && response.kind === 'user-input'
          ? this.answerAttachmentQuestion(request, response.answers, command.attachmentQuestionId) : undefined
        const attachmentClaim = prepareConversationAttachmentClaim(this.attachments, authority, command, command.threadId)
        assertPromptAttachments(attachmentClaim?.attachments, TEXT_ATTACHMENTS, ANSWER_ATTACHMENT_MAX_BYTES)
        const responding = {
          ...request, status: 'responding' as const,
          responseAttachments: attachmentClaim?.attachments, responseAttachmentQuestionId: questionId,
        }
        const receipt = this.commands.commit(command, authority, {
          target: { run_id: turn.runId, request_id: request.requestId },
          hostEvents: [lifecycleEvent(command.threadId, { kind: 'request', request: responding }, turn.runId)],
          apply: () => {
            attachmentClaim?.commit()
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
    const registration = this.requireDriver(command.instanceId, this.isOrdinaryTask(authority))
    if (command.options?.length && !registration.turnModelOptions) throw new DaemonError('E_UNAVAILABLE', '所选引擎不支持此模型参数。')
    const modelSelection = decodeModelSelection({ instanceId: registration.instanceId, model: command.model, options: command.options })
    const portableHistory = (command.references ?? [{ threadId: command.threadId }])
      .map(reference => this.contextHandoff.capture(reference, authority))
    const result = this.commands.appendMessage(command, authority, {
      driverKind: registration.driverKind, modelSelection, configurationFingerprint: this.configurationFingerprint(registration),
    }, undefined, undefined, portableHistory, this.relations)
    this.authorizations.set(command.commandId, authority)
    this.scheduleNext(command.threadId, authority)
    return result
  }

  async cleanupTaskConversation(
    input: { readonly receipt: Pick<ConversationCommandState, 'threadId' | 'runId'> | null; readonly commandId: string; readonly instanceId: string },
    authority: CommandAuthority,
  ): Promise<boolean> {
    const ownerScope = nativeTaskOwnerScope(authority)
    if (!ownerScope || !authority.assertSpawnCurrent) {
      throw new DaemonError('E_DENIED', '只能清理原任务会话作用域。')
    }
    const { receipt, commandId, instanceId } = input
    const verify = (): void => {
      this.ports.assertOwner()
      authority.assertSpawnCurrent?.()
      if (receipt && !this.commands.hasThread(receipt.threadId, authority)) throw new DaemonError('E_DENIED', '此会话不在原任务范围。')
    }
    verify()
    const key = driverSlotKey(instanceId, authority.cwd, ownerScope)
    if (receipt) {
      const { threadId, runId } = receipt
      const run = this.commands.run(threadId, runId)
      if (!run || decodeModelSelection(JSON.parse(run.payload_json).modelSelection).instanceId !== instanceId) {
        throw new DaemonError('E_DENIED', '找不到同一任务会话的原回合与实例。')
      }
      const operation = this.commands.effectForRun(threadId, runId)
      if (!this.closing && operation && ['pending', 'running'].includes(operation.status)) {
        await this.command({ type: 'run.interrupt', threadId, runId, commandId }, authority).catch(error => {
          if (!(error instanceof DaemonError) || error.code !== 'E_CONFLICT') throw error
        })
      }
    }
    verify()
    const opening = this.driverOpenings.get(key)
    const ready = this.ready.get(key)
    if ((opening && opening.projectId !== authority.projectId) || (ready && ready.projectId !== authority.projectId)) {
      throw new DaemonError('E_DENIED', '原任务进程属于其他会话范围。')
    }
    const owned = this.processes.get(key)
    if (owned) {
      if (!receipt || pathKey(owned.root) !== pathKey(authority.cwd) ||
        [...this.loadedThreads].some(([id, loaded]) => id !== receipt.threadId && loaded.driver === owned.driver)) {
        throw new DaemonError('E_CONFLICT', '原任务进程缺少匹配的会话，需先核对。')
      }
      await this.closeOwned(key, owned)
    }
    if (opening) await awaitDeadline(opening.opening.catch(() => undefined), this.deadlines.open, '核对原任务引擎启动')
    verify()
    if (this.processes.has(key) || this.driverOpenings.has(key)) return false
    const registration = this.driverRegistry.get(instanceId)
    return registration?.reconcileOwnerClosure?.({
      directory: this.ports.directory, cwd: authority.cwd, instanceId, ownerScope, assertCurrent: verify,
    }) ?? false
  }

  private acceptCompaction(
    command: Extract<ConversationThreadCommand, { type: 'thread.compact' }>, authority: CommandAuthority,
    trigger: 'manual' | 'idle',
  ): ConversationThreadCommandState {
    if (this.commands.isArchived(command.threadId) || this.activeTurns.has(command.threadId) || this.commands.isPaused(command.threadId)) {
      throw new DaemonError('E_BUSY', '请先恢复会话或等待正在运行的工作结束。')
    }
    const last = this.continuation.latestForCompaction(command.threadId)
    const modelSelection = decodeModelSelection(JSON.parse(last.payload_json).modelSelection)
    const registration = this.requireDriver(modelSelection.instanceId, this.isOrdinaryTask(authority))
    const active = this.loadedThreads.get(command.threadId)
    if (active ? !active.driver.compactThread : !['codex', 'pi'].includes(registration.instanceId)) {
      throw new DaemonError('E_UNAVAILABLE', '原引擎未提供可用的原生压缩。')
    }
    const configurationFingerprint = this.configurationFingerprint(registration)
    this.assertNativeBindingConfiguration(command.threadId, configurationFingerprint)
    const result = this.commands.compact(command, authority, { driverKind: registration.driverKind, modelSelection, configurationFingerprint },
      { trigger, ...(command.instructions && { instructions: command.instructions }) })
    this.authorizations.set(command.commandId, authority)
    this.scheduleNext(command.threadId, authority)
    return result
  }

  private async deleteThread(
    command: Extract<ConversationThreadCommand, { type: 'thread.delete' }>, authority: CommandAuthority,
  ): Promise<ConversationThreadCommandState> {
    const { threadId, commandId } = command
    const original = this.commands.replay(command, authority)
    if (original?.dispatch === 'completed') return original
    const hasLiveTurn = this.activeTurns.has(threadId)
    if (original && hasLiveTurn) return original
    const accepted = original ?? this.commands.changeThread(command, authority, {
      hasLiveTurn, hasLoadedThread: this.loadedThreads.has(threadId),
    }, this.relations.deletionEvents(threadId, authority, command.onlyIfUnused === true))
    let cleanup = this.dispatches.get(commandId)
    if (!cleanup) {
      const work = this.cleanDeletedThread(threadId, commandId, authority)
        .catch(() => {})
        .finally(() => this.dispatches.delete(commandId))
      cleanup = { root: authority.cwd, work }
      this.dispatches.set(commandId, cleanup)
    }
    await cleanup.work
    return this.commands.read(commandId, authority) ?? accepted
  }

  private async cleanDeletedThread(threadId: string, commandId: string, authority: CommandAuthority): Promise<void> {
    const loaded = this.loadedThreads.get(threadId)
    if (!loaded) {
      completeThreadDeletion(this.database, this.attachments, threadId, commandId)
      return
    }
    const detach = loaded.driver.detachThread
    const binding = this.database.prepare(`SELECT instance_id, native_thread_id, configuration_fingerprint
      FROM conversation_v2_native_bindings WHERE thread_id = ?`).get(threadId) as {
      instance_id: string; native_thread_id: string; configuration_fingerprint: string | null
    } | undefined
    if (!binding?.configuration_fingerprint || binding.native_thread_id !== loaded.nativeThreadId) return
    const { instance_id: instanceId, configuration_fingerprint: fingerprint } = binding
    const restrictedRelation = this.relations.restrictedParent(threadId)
    const scope = restrictedRelation && `${restrictedRelation.kind === 'delegated' ? 'delegated' : 'read-only'}:${restrictedRelation.id}`
    const worktree = restrictedRelation?.access === 'worktree-write' ? this.delegatedWork.worktree(restrictedRelation.id) : undefined
    if (restrictedRelation?.access === 'worktree-write' && !worktree?.child) return
    const cwd = worktree?.child?.identity.canonicalRoot ?? authority.cwd
    const key = driverSlotKey(instanceId, cwd, scope)
    const owned = this.processes.get(key)
    if (!owned || owned.driver !== loaded.driver || pathKey(owned.root) !== pathKey(cwd)) return
    const verify = (): void => {
      this.assertThreadScope(threadId, authority, true)
      const ready = this.ready.get(key)
      if (this.loadedThreads.get(threadId) !== loaded || this.activeTurns.has(threadId)
        || this.processes.get(key) !== owned || ready?.driver !== loaded.driver
        || ready.projectId !== authority.projectId || ready.fingerprint !== fingerprint
        || ready.ordinaryTask !== (this.isOrdinaryTask(authority) || Boolean(restrictedRelation))
        || [...this.loadedThreads].some(([id, peer]) => id !== threadId
          && peer.driver === loaded.driver && peer.nativeThreadId === loaded.nativeThreadId)) {
        throw new DaemonError('E_CONFLICT', '会话原生订阅的归属无法核实。')
      }
      this.assertDriverFingerprint(instanceId, fingerprint)
      if (authority.assertSpawnCurrent) authority.assertSpawnCurrent()
      else {
        const current = authority.assertCurrent()
        if (current) {
          void current.catch(() => {})
          throw new DaemonError('E_DENIED', '会话原生解绑缺少同步授权校验。')
        }
      }
    }
    if (!detach || worktree) {
      await this.assertCurrent(threadId, authority, true)
      await this.retireDeletedDriver(key, owned, threadId, commandId, loaded.nativeThreadId, verify)
      await this.assertCurrent(threadId, authority, true)
      completeThreadDeletion(this.database, this.attachments, threadId, commandId)
      return
    }
    const unpin = this.pinPreparation(loaded.driver)
    try {
      await this.assertCurrent(threadId, authority, true)
      const confirmation = await runBounded(detach.call(loaded.driver, { nativeThreadId: loaded.nativeThreadId, assertCurrent: verify }),
        this.deadlines.control, '解除原会话订阅', this.shutdownController.signal)
      await this.assertCurrent(threadId, authority, true)
      verify()
      if (recordThreadDeletionDetach(this.database, threadId, commandId, confirmation)) {
        this.loadedThreads.delete(threadId)
        completeThreadDeletion(this.database, this.attachments, threadId, commandId)
      }
    } finally {
      unpin()
    }
  }

  private async retireDeletedDriver(
    key: string, owned: { root: string; driver: ConversationDriverSession },
    threadId: string, commandId: string, nativeThreadId: string, verify: () => void,
  ): Promise<void> {
    const { driver, root } = owned
    if (process.platform !== 'win32' || this.closingDrivers.has(driver)) return
    const confirmed = this.verifiedDeletionCloses.get(driver)
    if (confirmed !== commandId && !this.ready.get(key)?.worktreeWriter && !driver.canConfirmWindowsJobClose?.(nativeThreadId)) return
    await this.closeOwned(key, owned, {
      commandId,
      verify: () => {
        verify()
        if (this.driverOpenings.has(key) || this.preparingDrivers.has(driver)
          || [...this.loadedThreads].some(([id, peer]) => id !== threadId && peer.driver === driver)
          || [...this.activeTurns.values()].some(turn => turn.driver === driver)
          || [...this.dispatches].some(([id, dispatch]) => id !== commandId && pathKey(dispatch.root) === pathKey(root))) {
          throw new DaemonError('E_BUSY', '原引擎仍有其他已加载会话或预占操作。')
        }
      },
      record: () => {
        this.ports.assertOwner()
        if (!recordThreadDeletionDetach(this.database, threadId, commandId, 'windowsJobClosed')) {
          throw new DaemonError('E_UNKNOWN', '原引擎的关闭证据尚未写入删除回执。', 'unknown')
        }
      },
    })
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
    const child = this.relations.delegatedParent(threadId)
    const childChange = child?.childRunId === runId && wasPending
      ? this.settleDelegatedWork(child, 'cancelled', occurredAt, [])
      : child?.question && expiredRequests.some(request => request.requestId === child.question?.requestId)
        ? this.relations.update({ ...child, question: undefined, updatedAt: occurredAt }) : undefined
    const lateResults = this.disallowLateDeliveries(threadId, runId, occurredAt)
    const disposedCompletion = wasPending ? this.disposeDelegatedCompletion(source, occurredAt) : undefined
    const result = this.commands.commit(command, authority, {
      target: { run_id: runId, detail: detail ?? null },
      events: wasPending ? [decodeEvent({ id: randomUUID(), threadId, runId, occurredAt, type: 'run.updated', payload: cancelledRun })] : [],
      hostEvents: [
        lifecycleEvent(threadId, { kind: 'queue', paused: true }, runId, occurredAt),
        lifecycleEvent(threadId, { kind: 'run', phase: detail ? 'stop-unconfirmed' : 'stop-requested' }, runId, occurredAt),
        ...expiredRequests.map(request => lifecycleEvent(threadId, { kind: 'request', request }, runId, occurredAt)),
        ...(childChange?.hostEvents ?? []),
        ...lateResults.flatMap(change => change.hostEvents),
        ...(disposedCompletion?.hostEvents ?? []),
      ],
      apply: () => {
        this.commands.setPaused(threadId, true)
        childChange?.apply()
        for (const change of lateResults) change.apply()
        disposedCompletion?.apply()
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
    const preparation = this.worktreePreparations.get(threadId)
    if (preparation?.runId === runId) preparation.controller.abort()
    if (wasPending) this.authorizations.delete(source.command_id)
    if (canSubmit) this.scheduleControl(command, authority, exactTurn)
    if (wasPending && childChange && child) this.offerDelegatedCompletionDelivery(child.parentThreadId, child.parentRunId)
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

  private answerAttachmentQuestion(request: ConversationRuntimeRequest, answers: Readonly<Record<string, unknown>>, requested?: string): string {
    const supported = request.payload.kind === 'user-input'
      ? request.payload.questions.filter(question => question.acceptsTextAttachments && typeof answers[question.id] === 'string') : []
    const question = requested ? supported.find(candidate => candidate.id === requested) : supported.length === 1 ? supported[0] : undefined
    if (!question) throw new DaemonError('E_UNAVAILABLE', '请为附件选择原生提问中支持附件的文本回答。')
    return question.id
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
        const text = expandAssistantCitationsForProvider(this.commands.readUserMessage(steerRunId).text)
        invoke = () => steerTurn({ ...input, text })
      } else if (command.type === 'runtime-request.respond' && turn.driver.respondToRuntimeRequest) {
        const request = this.commands.request(threadId, command.requestId)
        const bound = this.nativeRequests.get(command.requestId)
        if (!request || request.status !== 'responding' || !bound || bound.turn !== turn || request.generation !== command.generation) {
          throw new DaemonError('E_CONFLICT', '原审批或提问已不再可操作。')
        }
        let response = this.requestResponse(request, command)
        if (request.responseAttachments?.length && response.kind === 'user-input') {
          const questionId = this.answerAttachmentQuestion(request, response.answers, request.responseAttachmentQuestionId)
          const contents = this.readAttachmentContents(threadId, request.responseAttachments, authority)
          for (const content of contents) nativeTextAttachment(content)
          response = { ...response, attachments: { questionId, contents } }
        }
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
    const delegated = updatedRequest ? this.relations.delegatedParent(threadId) : undefined
    const nextQuestion = updatedRequest && delegated?.question?.requestId === updatedRequest.requestId
      ? this.commands.requests(threadId).find(candidate => candidate.requestId !== updatedRequest.requestId &&
        candidate.runId === updatedRequest.runId && candidate.kind === 'user-input' && candidate.status === 'pending')
      : undefined
    const questionChange = updatedRequest && delegated?.question?.requestId === updatedRequest.requestId &&
      ['resolved', 'expired', 'pending-reconciliation'].includes(updatedRequest.status)
      ? this.relations.update({ ...delegated,
        question: nextQuestion ? { requestId: nextQuestion.requestId, generation: nextQuestion.generation, title: nextQuestion.payload.title } : undefined,
        status: updatedRequest.status === 'pending-reconciliation' ? 'pending-reconciliation' : nextQuestion ? 'waiting' : 'running',
        updatedAt: occurredAt })
      : undefined
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
        ...(questionChange?.hostEvents ?? []),
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
      questionChange?.apply()
    })
  }

  private scheduleNext(threadId: string, current: CommandAuthority): void {
    if (this.closing) return
    const commandId = this.commands.nextCommand(threadId, command => this.authorizations.has(command))
    if (!commandId) {
      this.scheduleIdleCompaction(threadId, current)
      return
    }
    const idle = this.idleCompactions.get(threadId)
    if (idle) {
      clearTimeout(idle)
      this.idleCompactions.delete(threadId)
    }
    if (this.dispatches.has(commandId)) return
    const authority = this.authorizations.get(commandId) ?? current
    this.scheduleWork(commandId, authority, () => this.drainOne(commandId, authority), () => {
      this.authorizations.delete(commandId)
      this.scheduleNext(threadId, current)
    })
  }

  private scheduleIdleCompaction(threadId: string, authority: CommandAuthority): void {
    if (authority.binding.kind !== 'personal' || this.idleCompactions.has(threadId) || this.commands.isPaused(threadId) ||
      !this.loadedThreads.get(threadId)?.driver.compactThread) return
    const run = this.continuation.idleCandidate(threadId)
    if (!run) return
    const timer = setTimeout(() => {
      this.idleCompactions.delete(threadId)
      void this.assertCurrent(threadId, authority).then(() => {
        if (this.continuation.idleCandidate(threadId)?.run_id !== run.run_id ||
          this.relations.read(threadId).children.some(relation => ['queued', 'running', 'waiting', 'pending-reconciliation'].includes(relation.status))) return
        const command = { type: 'thread.compact', threadId, commandId: `idle-compact:${run.run_id}` } as const
        if (!this.commands.replay(command, authority)) this.acceptCompaction(command, authority, 'idle')
      }).catch(() => {})
    }, 120_000)
    timer.unref()
    this.idleCompactions.set(threadId, timer)
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

  private async assertCurrent(threadId: string, authority: CommandAuthority, includeDeleted = false): Promise<void> {
    this.assertThreadScope(threadId, authority, includeDeleted)
    await awaitDeadline(Promise.resolve(authority.assertCurrent()), this.deadlines.control, '复核工程授权')
    this.assertThreadScope(threadId, authority, includeDeleted)
  }

  private assertThreadScope(threadId: string, authority: ConversationAuthority, includeDeleted = false): void {
    this.ports.assertOwner()
    if (this.closing) throw new DaemonError('E_UNAVAILABLE', '会话内核正在关闭。')
    if (!this.commands.hasThread(threadId, authority, includeDeleted)) throw new DaemonError('E_DENIED', '此会话不在当前授权范围。')
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

  private async openNativeThread(
    threadId: string, instanceId: string, model: string, cwd: string, driver: ConversationDriverSession, fresh = false,
  ): Promise<string> {
    const loaded = this.loadedThreads.get(threadId)
    if (!fresh && loaded?.driver === driver) return loaded.nativeThreadId
    const existing = fresh ? undefined : this.database.prepare(`SELECT instance_id, native_thread_id FROM conversation_v2_native_bindings WHERE thread_id = ?
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
    if (!row || row.status !== 'pending' || this.closing || this.commands.nextCommand(row.thread_id, command => this.authorizations.has(command)) !== commandId) return
    const runId = this.worker.runId(row)
    if (!runId) throw new Error('The accepted operation has no run.')
    const { cwd: projectRoot, projectId } = authority
    let cwd = projectRoot
    const threadId = row.thread_id
    const completion = completionIntent(row)
    const attemptId = this.worker.claim(row)
    if (!attemptId) return
    let turn: ActiveTurn | undefined
    let unpin: (() => void) | undefined
    let writerSlot: string | undefined
    let preparingWorktree = false
    try {
      await this.assertCurrent(threadId, authority)
      this.worker.assertAttempt(row, attemptId)
      const run = this.commands.run(threadId, runId)
      if (!run) throw new Error('The accepted run is missing.')
      if (completion) this.assertDelegatedCompletionCurrent(threadId, completion, authority, runId)
      else this.delegationContinuationParents.delete(threadId)
      const selection = decodeModelSelection(JSON.parse(run.payload_json).modelSelection)
      const intent = JSON.parse(row.payload_json) as { handoff?: true; portableHistory?: readonly PortableHistory[] }
      const ordinaryTask = this.isOrdinaryTask(authority)
      const planning = authority.binding.kind === 'planning' ? authority.binding : undefined
      const related = this.relations.restrictedParent(threadId)
      const restricted = ordinaryTask || Boolean(planning || related)
      const worktree = related?.access === 'worktree-write' ? this.delegatedWork.worktree(related.id) : undefined
      const managedExecution = worktree || authority.binding.kind === 'task' && authority.binding.mode === 'execution' ? true : undefined
      const registration = this.requireDriver(selection.instanceId, restricted)
      if (planning && !registration.planningAccess) throw new DaemonError('E_UNAVAILABLE', '此引擎没有原工程只读规划能力。')
      if (managedExecution && !registration.executionAccess) throw new DaemonError('E_UNAVAILABLE', '此引擎没有正式任务托管执行能力。')
      if (related?.access === 'worktree-write' && (!worktree || !registration.delegatedWorktreeAccess || !this.ports.workcopies)) {
        throw new DaemonError('E_UNAVAILABLE', '无法核实原委派工作树与引擎的写入能力。')
      }
      const compaction = compactionFromPayload(run.payload_json)
      const message = compaction ? { text: '', attachments: undefined } : this.commands.readUserMessage(runId)
      assertPromptAttachments(message.attachments, registration.promptAttachments)
      const attachments = this.readAttachmentContents(threadId, message.attachments, authority)
      const knowledge = attachments.flatMap(({ attachment }) => {
        const source = this.attachments.claimedKnowledge({ ownerId: authority.ownerId, spaceId: authority.spaceId, root: projectRoot },
          { threadId, attachmentId: attachment.id })
        return source ? [prepareConversationKnowledge(projectRoot, authority.knowledgePageId, source)] : []
      })
      const assertKnowledgeCurrent = (): void => {
        try { for (const source of knowledge) source.assertCurrent() }
        catch (cause) {
          throw new ConversationTurnRejectedError(cause instanceof Error ? cause.message : '所选资料已失效，请重新选择。', { cause })
        }
      }
      for (const content of attachments) if (content.attachment.type === 'file') nativeTextAttachment(content)
      if (selection.options?.length && !registration.turnModelOptions) {
        throw new ConversationTurnRejectedError('原引擎已无法应用排队回合的模型参数。')
      }
      const expectedFingerprint = this.configurationFingerprint(registration)
      const admittedFingerprint = this.worker.configurationFingerprint(row)
      if (admittedFingerprint && admittedFingerprint !== expectedFingerprint) {
        throw new DaemonError('E_CONFLICT', '排队时选定的引擎配置已失效。')
      }
      const fork = compaction ? undefined : this.relations.forkContext(threadId, run.ordinal)
      const histories = [...(intent.portableHistory ?? []), ...(fork ? [fork] : [])]
      for (const history of histories) this.contextHandoff.assertSource(history.sourceThreadId, authority)
      if (!intent.handoff) this.assertNativeBindingConfiguration(threadId, expectedFingerprint)
      const prepareFence = (): void => {
        this.assertSpawnAuthority(threadId, authority)
        this.assertDriverFingerprint(selection.instanceId, expectedFingerprint)
        this.worker.assertAttempt(row, attemptId)
        if (completion && !turn?.completionAccepted) this.assertDelegatedCompletionCurrent(threadId, completion, authority, runId)
      }
      const ownerScope = nativeTaskOwnerScope(authority) ?? (related
        ? `${related.kind === 'delegated' ? 'delegated' : 'read-only'}:${related.id}` : undefined)
      let worktreeWriter: DriverIdentity['worktreeWriter']
      const registry = this.ports.workcopies
      if (worktree && related && registry) {
        if (!worktree.child) {
          await this.dispatches.get(`worktree-recovery:${related.id}`)?.work
          prepareFence()
          preparingWorktree = true
          const controller = new AbortController()
          this.worktreePreparations.set(threadId, { runId, controller })
          const prepared = await prepareDelegatedWorktree({
            directory: this.ports.directory, registry, operationId: related.id, pinnedParent: worktree.parent, parentRoot: projectRoot,
            signal: AbortSignal.any([controller.signal, this.shutdownController.signal]), assertCurrent: prepareFence,
          }).finally(() => this.worktreePreparations.delete(threadId))
          await this.assertCurrent(threadId, authority)
          prepareFence()
          const current = this.relations.delegatedParent(threadId)
          if (!current || current.id !== related.id) throw new DaemonError('E_CONFLICT', '子会话的原委派绑定已变化。')
          try {
            this.delegatedWork.bindWorktree(current, prepared)
          } catch (cause) {
            throw Object.assign(new DaemonError('E_UNKNOWN', '工作树已准备，但原会话的绑定写入待核对。', 'unknown'), { cause })
          }
          worktree.child = prepared
          preparingWorktree = false
        }
        const observed = verifyDelegatedWorktree(worktree.child)
        cwd = observed.canonicalRoot
        worktreeWriter = { registry, projectRoot, expected: { id: observed.id, revision: observed.revision } }
        writerSlot = driverSlotKey(registration.instanceId, cwd, ownerScope)
      }
      const fence = (): void => {
        prepareFence()
        if (worktree?.child) verifyDelegatedWorktree(worktree.child)
      }
      const reservation = await this.ensureDriver(cwd, projectId, registration, fence, restricted, ownerScope, managedExecution, worktreeWriter)
      const { driver } = reservation
      unpin = reservation.unpin
      await this.assertCurrent(threadId, authority)
      fence()
      if (compaction && !driver.compactThread) throw new ConversationTurnRejectedError('原引擎未提供可用的原生压缩。')
      if (message.attachments?.length) driver.validatePromptAttachments?.(message.attachments)
      for (const history of histories) this.contextHandoff.assertSource(history.sourceThreadId, authority)
      const handoffSource = intent.handoff ? await this.prepareHandoffSource(threadId, authority, fence) : undefined
      const nativeThreadId = await this.driverFence.run(fence, () =>
        this.openNativeThread(threadId, selection.instanceId, selection.model, cwd, driver, Boolean(handoffSource)))
      if (!nativeThreadId) throw new ConversationTurnRejectedError('引擎未返回接力会话身份。')
      if (completion && nativeThreadId !== completion.nativeThreadId) throw new ConversationTurnRejectedError('引擎没有接回原委派的父会话。')
      for (const source of knowledge) await source.assertRemoteCurrent(AbortSignal.any([
        this.shutdownController.signal, AbortSignal.timeout(this.deadlines.thread),
      ]))
      await this.assertCurrent(threadId, authority)
      fence()
      assertKnowledgeCurrent()
      for (const history of histories) this.contextHandoff.assertSource(history.sourceThreadId, authority)
      const goal = compaction || completion ? null : this.continuation.readGoal(threadId)
      const { text: contextText, ...coverage } = renderPortableHistory(histories)
      const handoff: ConversationHandoff | undefined = handoffSource ? {
        sourceRunId: handoffSource.previous_run_id, sourceInstanceId: handoffSource.instance_id,
        targetInstanceId: selection.instanceId, ...coverage, state: 'prepared',
      } : undefined
      const roleInstructions = compaction || completion ? undefined : this.intake.readRoleInstructions(threadId)
      const prompt = [
        ...(run.ordinal === 1 && ordinaryTask && authority.taskContext ? [`以下是原团队任务的固定材料摘要。\n\n${authority.taskContext}`] : []),
        ...(roleInstructions?.trim() ? [`当前工程中用户选定的角色指令（Crux）\n${roleInstructions}`] : []),
        ...(goal?.status === 'active' ? [`当前会话的用户目标（Crux）\n${goal.objective}`] : []),
        `${contextText}${expandAssistantCitationsForProvider(message.text)}`,
      ].filter(Boolean).join('\n\n')
      const startedAt = new Date().toISOString()
      const payload = { ...JSON.parse(run.payload_json), status: 'running', providerThreadId: nativeThreadId, startedAt,
        ...(handoff && { handoff }) }
      const relation = compaction ? undefined : this.relations.childUpdate(threadId, 'running', runId, startedAt)
      const metadata = handoffSource ? this.database.prepare(`SELECT payload_json FROM conversation_v2_projection_threads WHERE thread_id = ?`)
        .get(threadId) as { payload_json: string } | undefined : undefined
      const newThread = metadata && { ...JSON.parse(metadata.payload_json), providerInstanceId: selection.instanceId, modelSelection: selection, updatedAt: startedAt }
      this.worker.markDispatched(row, attemptId, nativeThreadId, () => {
        this.database.prepare("UPDATE conversation_v2_projection_runs SET provider_thread_id = ?, status = 'running', payload_json = ? WHERE run_id = ?")
          .run(nativeThreadId, JSON.stringify(payload), runId)
        if (handoffSource) {
          this.database.prepare(`INSERT INTO conversation_v2_handoff_bindings
            (command_id, thread_id, previous_instance_id, previous_native_thread_id, previous_fingerprint, next_instance_id, next_native_thread_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(commandId, threadId, handoffSource.instance_id, handoffSource.native_thread_id,
            handoffSource.configuration_fingerprint, selection.instanceId, nativeThreadId, startedAt)
          this.database.prepare(`UPDATE conversation_v2_projection_threads SET default_provider = ?, updated_at = ?,
            payload_json = ? WHERE thread_id = ?`).run(selection.instanceId, startedAt, JSON.stringify(newThread), threadId)
        }
        this.database.prepare(`INSERT INTO conversation_v2_native_bindings (thread_id, instance_id, native_thread_id, configuration_fingerprint)
          VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET instance_id = excluded.instance_id, native_thread_id = excluded.native_thread_id,
          configuration_fingerprint = excluded.configuration_fingerprint`)
          .run(threadId, selection.instanceId, nativeThreadId, expectedFingerprint)
        if (relation) relation.apply()
      }, undefined, [
        decodeEvent({ type: 'run.updated', id: randomUUID(), threadId, runId, occurredAt: startedAt, payload }),
        ...(newThread ? [decodeEvent({ type: 'thread.metadata-updated', id: randomUUID(), threadId, occurredAt: startedAt, payload: newThread })] : []),
      ],
      [...(relation?.hostEvents ?? []), ...(handoff ? [lifecycleEvent(threadId, { kind: 'handoff', handoff }, runId, startedAt)] : [])])
      this.loadedThreads.set(threadId, { driver, nativeThreadId })
      const active: ActiveTurn = { row, runId, ordinal: run.ordinal, attemptId, driver, nativeThreadId, executionRoot: cwd, authority,
        configurationFingerprint: expectedFingerprint, completion, writerSlot }
      active.waitForControlTurn = new Promise(resolve => { active.signalControlTurn = resolve })
      turn = active
      this.activeTurns.set(threadId, active)
      unpin()
      unpin = undefined
      const onEvent = (event: ConversationDriverTurnEvent): void => this.observeTurn(active, event)
      const sendFence = knowledge.length ? (): void => {
        fence()
        if (!active.controlTurnId) assertKnowledgeCurrent()
      } : fence
      const context = {
          requestId: row.command_id, modelOptions: selection.options, assertCurrent: sendFence,
          ...((restricted || managedExecution) && { assertAuthorized: () => this.assertCurrent(threadId, authority) }),
          ...(attachments.length ? { attachments } : {}),
          ...(registration.ordinaryTaskAccess === 'native-read-only' && authority.binding.kind === 'personal' && !compaction && !completion && !related && {
              delegation: (call: ConversationDelegationCall) => this.acceptDelegationCall(active, call),
            }),
      }
      const acceptedTurnId = await this.driverFence.run(sendFence, () => runBounded(
        compaction && driver.compactThread
          ? driver.compactThread({ nativeThreadId, cwd, model: selection.model, instructions: compaction.instructions, onEvent, context })
          : driver.startTurn(nativeThreadId, cwd, prompt, selection.model, onEvent, context),
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
      } else if ((preparingWorktree || writerSlot) && attempt?.phase === 'preparing' && error instanceof DaemonError && error.outcome === 'unknown') {
        this.settleUnknown(row, runId, '', new Date().toISOString(), error.message)
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
      if (!turn?.background?.size && !turn?.backgroundOverflow) await this.retireWorktreeWriter(writerSlot, turn)
    }
  }

  private async acceptDelegationCall(turn: ActiveTurn, call: ConversationDelegationCall): Promise<ConversationDelegationReply> {
    try {
      const { authority, row, attemptId, nativeThreadId, runId } = turn
      const { thread_id: threadId } = row
      if (authority.binding.kind !== 'personal' || !call.callId || call.callId.length > 512 ||
        call.nativeThreadId !== nativeThreadId || call.nativeTurnId !== turn.controlTurnId || !turn.hasNativeTurnId) {
        throw new DaemonError('E_DENIED', '委派调用缺少原生父回合身份。')
      }
      const verify = () => this.assertDelegationParentCurrent(turn, call.nativeTurnId)
      await this.assertCurrent(threadId, authority)
      verify()
      const run = this.commands.run(threadId, runId)
      if (!run) throw new DaemonError('E_DENIED', '原委派运行已不可用。')
      const selection = decodeModelSelection(JSON.parse(run.payload_json).modelSelection)
      const operationId = delegationOperationId([threadId, runId, attemptId, call.callId])
      const input = call.tool === 'delegate_task' ? delegateTaskArguments.parse(call.arguments)
        : call.tool === 'task_respond' ? taskRespondArguments.parse(call.arguments)
          : taskStatusArguments.parse(call.arguments)
      const intent = { tool: call.tool, input }
      const original = this.delegatedWork.readReply(operationId, intent)
      const waitInput = 'mode' in input && input.mode === 'wait' ? input : undefined
      const waitReplyId = waitInput ? delegationOperationId([operationId, 'wait-reply']) : undefined
      if (original && !waitReplyId) return original
      const originalWait = waitReplyId && this.delegatedWork.readReply(waitReplyId, intent)
      if (originalWait) return originalWait
      const previous = this.delegationCalls.get(operationId)
      if (previous) {
        if (previous.input !== JSON.stringify(intent)) throw new DaemonError('E_CONFLICT', '原委派工具调用的内容已变化。')
        return await previous.result
      }
      if (call.tool === 'delegate_task' && 'task' in input && !original) {
        const registration = this.requireDriver(selection.instanceId, true)
        if (registration.ordinaryTaskAccess !== 'native-read-only') throw new DaemonError('E_UNAVAILABLE', '原引擎没有可验证的只读子任务配置。')
        let worktreeParent
        if (input.isolation === 'worktree') {
          if (process.platform !== 'win32' || !this.ports.workcopies || !registration.delegatedWorktreeAccess) {
            throw new DaemonError('E_UNAVAILABLE', '当前引擎没有受管的独立工作树写入能力。')
          }
          worktreeParent = resolveWorkcopy(authority.cwd)
          if (!worktreeParent.repoRoot || !worktreeParent.head || pathKey(worktreeParent.repoRoot) !== pathKey(authority.cwd)) {
            throw new DaemonError('E_UNAVAILABLE', '独立工作树需要原工程的 Git 根目录和已提交的 HEAD。')
          }
          verify()
        }
        const delegated = this.delegatedWork.request(operationId, {
          threadId, runId, attemptId, nativeThreadId, nativeTurnId: call.nativeTurnId, selection,
          driverKind: registration.driverKind, fingerprint: turn.configurationFingerprint,
        }, authority, input, intent, worktreeParent)
        if (delegated.relation.childThreadId) {
          this.authorizations.set(operationId, authority)
          this.scheduleNext(delegated.relation.childThreadId, authority)
        }
        if (!waitInput) return delegated.reply
      }
      const taskId = waitInput ? operationId : 'taskId' in input ? input.taskId : undefined
      if (!taskId) throw new DaemonError('E_INVALID_ARG', '需要原委派身份。')
      const readTask = () => {
        const relation = this.relations.childOf(threadId, taskId)
        if (!relation || relation.kind !== 'delegated' || relation.parentRunId !== runId ||
          !relation.parentNodeId || !relation.childThreadId || !relation.childRunId ||
          !this.commands.hasThread(relation.childThreadId, authority) || !this.delegatedWork.matchesOriginalAttempt(relation, attemptId)) {
          throw new DaemonError('E_DENIED', '子任务不属于原父运行和节点。')
        }
        return { relation, childThreadId: relation.childThreadId, childRunId: relation.childRunId }
      }
      const execute = async (): Promise<ConversationDelegationReply> => {
        const { relation, childThreadId, childRunId } = readTask()
        let reply: ConversationDelegationReply
        let delivery: ReturnType<ThreadRelations['update']> | undefined
        if (call.tool === 'task_status' || waitInput) {
          const pendingApproval = () => this.commands.requests(childThreadId).find(request =>
            request.kind === 'approval' && request.status === 'pending' && request.runId === childRunId)
          let waitTimedOut = false
          if (waitInput) {
            const timeoutMs = Math.min(MAX_DELEGATION_WAIT_MS, Math.max(1, waitInput.timeoutMs ?? DEFAULT_DELEGATION_WAIT_MS))
            waitTimedOut = await this.waitForDelegatedUpdate([threadId, childThreadId], timeoutMs, () => {
              verify()
              const { relation: current } = readTask()
              return Boolean(current.question || current.result || pendingApproval() ||
                !['queued', 'running', 'waiting'].includes(current.status))
            })
            await this.assertCurrent(threadId, authority)
            verify()
          }
          const { relation: current } = readTask()
          const approval = pendingApproval()
          const detail = current.result?.state === 'available' ? current.result.text : undefined
          reply = { success: true, text: JSON.stringify({
            taskId, childThreadId, childRunId, status: current.status, question: current.question, result: detail,
            hasPendingQuestion: Boolean(current.question),
            pendingApproval: approval ? { requestId: approval.requestId, kind: approval.kind, runId: approval.runId } : null,
            waitTimedOut,
          }) }
          if (current.result?.state === 'available') {
            delivery = this.relations.update({ ...current, result: { ...current.result, state: 'delivered' },
              completionDelivery: { state: 'acknowledged', observedByRunId: RunId.make(runId) }, updatedAt: new Date().toISOString() })
          }
        } else {
          const childAuthority = { ...authority, assertCurrent: async () => { await authority.assertCurrent(); verify() }, assertSpawnCurrent: verify }
          const commandId = delegationOperationId([operationId, 'control'])
          const response = call.tool === 'task_respond' ? taskRespondArguments.parse(call.arguments) : undefined
          const command = call.tool === 'task_cancel'
            ? { type: 'run.interrupt' as const, threadId: childThreadId, commandId, runId: childRunId }
            : response ? { type: 'runtime-request.respond' as const, threadId: childThreadId, commandId,
              requestId: response.requestId, generation: response.generation, answers: response.answers } : undefined
          if (!command) throw new DaemonError('E_INVALID_ARG', '需要原请求的结构化答复。')
          if (command.type === 'runtime-request.respond' && (relation.question?.requestId !== command.requestId ||
            relation.question?.generation !== command.generation)) throw new DaemonError('E_DENIED', '只可答复原子任务的当前问题。')
          const result = await this.command(command, childAuthority)
          reply = { success: true, text: JSON.stringify({ taskId: relation.id, commandId, dispatch: result.dispatch }) }
        }
        this.eventSink.commit({ hostEvents: delivery?.hostEvents }, () => {
          if (delivery) delivery.apply()
          this.delegatedWork.writeReply(waitReplyId ?? operationId, intent, reply)
        })
        return reply
      }
      const result = execute()
      this.delegationCalls.set(operationId, { input: JSON.stringify(intent), result })
      try { return await result } finally { this.delegationCalls.delete(operationId) }
    } catch (error) {
      return { success: false, text: error instanceof DaemonError ? error.message : '委派工具参数或原运行状态不可用。' }
    }
  }

  private assertDelegationParentCurrent(turn: ActiveTurn, nativeTurnId?: string, allowCompletedForeground = false): void {
    const { row, authority, attemptId, driver, nativeThreadId, configurationFingerprint } = turn
    const threadId = row.thread_id
    try { this.assertSpawnAuthority(threadId, authority) } catch (error) {
      if (error instanceof DaemonError) throw error
      throw new DaemonError('E_DENIED', '无法复核原委派的工程授权。')
    }
    const attempt = this.worker.attempt(row.effect_id)
    const loaded = this.loadedThreads.get(threadId)
    const closedForeground = Boolean(turn.terminal || attempt?.foreground_ended)
    if (!nativeTurnId || !turn.hasNativeTurnId || turn.controlTurnId !== nativeTurnId ||
      this.activeTurns.get(threadId) !== turn || attempt?.attempt_id !== attemptId ||
      attempt.phase !== 'dispatching' || attempt.native_turn_id !== nativeTurnId || attempt.stop_requested ||
      closedForeground && !(allowCompletedForeground && turn.terminal?.status === 'completed') ||
      this.commands.isPaused(threadId) || this.commands.isArchived(threadId) ||
      loaded?.driver !== driver || loaded.nativeThreadId !== nativeThreadId) {
      throw new DaemonError('E_DENIED', '原委派回合已停止、结束或换代。')
    }
    const binding = this.database.prepare(`SELECT instance_id FROM conversation_v2_native_bindings
      WHERE thread_id = ? AND native_thread_id = ? AND configuration_fingerprint = ?`)
      .get(threadId, nativeThreadId, configurationFingerprint) as { instance_id: string } | undefined
    if (!binding) throw new DaemonError('E_DENIED', '原委派的原生会话归属已变化。')
    this.assertDriverFingerprint(binding.instance_id, configurationFingerprint)
  }

  private delegatedCompletionSource(turn: ActiveTurn) {
    return turn.hasNativeTurnId && turn.controlTurnId ? {
      parentRunId: turn.runId, parentAttemptId: turn.attemptId, nativeThreadId: turn.nativeThreadId, nativeTurnId: turn.controlTurnId,
    } : undefined
  }

  private assertDelegatedCompletionSource(threadId: string, source: NonNullable<ReturnType<ConversationRuntime['delegatedCompletionSource']>>,
    authority: CommandAuthority, continuationRunId?: string, allowPaused = false) {
    this.assertSpawnAuthority(threadId, authority)
    if (authority.binding.kind !== 'personal' || this.commands.isArchived(threadId) || !allowPaused && this.commands.isPaused(threadId)) {
      throw new DaemonError('E_DENIED', '原委派的父会话已暂停或失去授权。')
    }
    const run = this.commands.run(threadId, source.parentRunId)
    const effect = this.commands.effectForRun(threadId, source.parentRunId)
    const attempt = effect && this.worker.attempt(effect.effect_id)
    const terminal = effect && this.database.prepare(`SELECT 1 FROM conversation_v2_native_terminal_evidence
      WHERE effect_id = ? AND status = 'completed' AND native_turn_id = ?`).get(effect.effect_id, source.nativeTurnId)
    if (run?.status !== 'completed' || effect?.status !== 'succeeded' || !terminal || attempt?.phase !== 'settled' ||
      !attempt.foreground_ended || attempt.stop_requested || attempt.attempt_id !== source.parentAttemptId ||
      attempt.provider_thread_id !== source.nativeThreadId || attempt.native_turn_id !== source.nativeTurnId ||
      this.database.prepare(`SELECT 1 FROM conversation_v2_projection_runs
        WHERE thread_id = ? AND ordinal > ? AND run_id <> ? LIMIT 1`).get(threadId, run.ordinal, continuationRunId ?? '')) {
      throw new DaemonError('E_CONFLICT', '原父回合没有正常结束凭据，或会话已进入新运行。')
    }
    const fingerprint = this.worker.configurationFingerprint(effect)
    const binding = fingerprint && this.database.prepare(`SELECT 1 FROM conversation_v2_native_bindings
      WHERE thread_id = ? AND instance_id = ? AND native_thread_id = ? AND configuration_fingerprint = ?`)
      .get(threadId, run.provider_instance_id, source.nativeThreadId, fingerprint)
    if (!fingerprint || !binding) throw new DaemonError('E_CONFLICT', '原委派的父会话绑定已变化。')
    this.assertDriverFingerprint(run.provider_instance_id, fingerprint)
    return { run, fingerprint, payload: JSON.parse(run.payload_json) as OrchestrationV2Run }
  }

  private assertDelegatedCompletionCurrent(threadId: string, intent: DelegatedCompletionIntent, authority: CommandAuthority,
    runId: string, allowPaused = false): void {
    const { payload } = this.assertDelegatedCompletionSource(threadId, intent, authority, runId, allowPaused)
    requireUnchangedCompletion(payload.delegatedCompletion, intent)
    this.completionRelations(threadId, intent, runId, authority)
  }

  private completionRelations(threadId: string, intent: DelegatedCompletionIntent, runId: string, authority: CommandAuthority) {
    return intent.taskIds.map((taskId, index) => {
      const relation = this.relations.childOf(threadId, taskId)
      if (!relation?.childThreadId || relation.parentRunId !== intent.parentRunId ||
        !this.commands.hasThread(relation.childThreadId, authority) || !this.delegatedWork.matchesOriginalAttempt(relation, intent.parentAttemptId) ||
        relation.parentNodeId !== intent.nodeIds[index] || relation.result?.deliveryId !== intent.resultIds[index] || relation.continuation?.runId !== runId ||
        relation.completionDelivery?.state !== 'claimed') {
        throw new DaemonError('E_CONFLICT', '待回送的原子任务结果已变化。')
      }
      return relation
    })
  }

  private disposeDelegatedCompletion(effect: ThreadEffectRow, at: string) {
    const intent = completionIntent(effect)
    if (!intent) return
    const changes = intent.taskIds.flatMap((taskId, index) => {
      const relation = this.relations.childOf(effect.thread_id, taskId)
      return relation?.completionDelivery?.state === 'claimed' && relation.result?.deliveryId === intent.resultIds[index] &&
        relation.continuation?.commandId === effect.command_id
        ? [this.relations.update({ ...relation, completionDelivery: { state: 'disposed', observedByRunId: null }, updatedAt: at })]
        : []
    })
    return {
      hostEvents: changes.flatMap(change => change.hostEvents),
      apply: () => { for (const change of changes) change.apply() },
    }
  }

  private offerDelegatedCompletionDelivery(threadId: string, parentRunId?: string): void {
    queueMicrotask(() => {
      const parent = this.delegationContinuationParents.get(threadId)
      if (!parent || parent.runId !== parentRunId || this.closing) return
      const source = this.delegatedCompletionSource(parent)
      if (!source) return
      try {
        const { authority } = parent
        const { run, fingerprint, payload } = this.assertDelegatedCompletionSource(threadId, source, authority)
        if (payload.delegatedCompletion) return
        const children = this.relations.read(threadId).children.filter(relation => relation.kind === 'delegated' &&
          relation.parentRunId === parentRunId && this.delegatedWork.matchesOriginalAttempt(relation, parent.attemptId))
        const plan = planDelegatedCompletionDelivery(source, children)
        if (!plan) {
          if (children.every(child => child.result)) this.delegationContinuationParents.delete(threadId)
          return
        }
        const selection = decodeModelSelection(payload.modelSelection)
        const registration = this.requireDriver(selection.instanceId, false)
        const at = new Date().toISOString()
        const changes = plan.tasks.map(relation => this.relations.update({ ...relation,
          completionDelivery: { state: 'claimed', observedByRunId: null }, updatedAt: at,
          continuation: { commandId: plan.commandId, runId: plan.runId },
        }))
        const updated = { ...payload, delegatedCompletion: plan.cohort }
        this.commands.appendMessage({
          type: 'message.dispatch', commandId: plan.commandId, threadId, messageId: plan.messageId, text: plan.text,
          instanceId: selection.instanceId, model: selection.model,
        }, authority, { modelSelection: selection, driverKind: registration.driverKind, configurationFingerprint: fingerprint },
        undefined, undefined, undefined, undefined, {
          intent: plan.intent, runId: plan.runId, plan: {
            events: [decodeEvent({ type: 'run.updated', id: randomUUID(), threadId, runId: run.run_id, occurredAt: at, payload: updated })],
            hostEvents: changes.flatMap(change => change.hostEvents),
            apply: () => {
              this.database.prepare('UPDATE conversation_v2_projection_runs SET payload_json = ? WHERE run_id = ?')
                .run(JSON.stringify(updated), run.run_id)
              for (const change of changes) change.apply()
            },
          },
        })
        this.delegationContinuationParents.delete(threadId)
        this.authorizations.set(plan.commandId, authority)
        this.scheduleNext(threadId, authority)
      } catch (error) {
        this.delegationContinuationParents.delete(threadId)
        if (!(error instanceof DaemonError)) {
          process.emitWarning('Unable to reserve the original delegated completion.', { code: 'CRUX_DELEGATED_COMPLETION' })
        }
      }
    })
  }

  private async waitForDelegatedUpdate(threadIds: readonly string[], timeoutMs: number, ready: () => boolean): Promise<boolean> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([timeout, this.shutdownController.signal])
    while (!signal.aborted) {
      if (ready()) return false
      try {
        await this.eventSink.waitForLifecycle(threadIds, signal)
      } catch (error) {
        if (!timeout.aborted || this.shutdownController.signal.aborted) throw error
      }
    }
    this.shutdownController.signal.throwIfAborted()
    return true
  }

  private async prepareHandoffSource(threadId: string, authority: CommandAuthority, fence: () => void) {
    const binding = this.database.prepare(`SELECT binding.instance_id, binding.native_thread_id, binding.configuration_fingerprint,
      (SELECT run_id FROM conversation_v2_projection_runs run WHERE run.thread_id = binding.thread_id
        AND run.provider_thread_id = binding.native_thread_id AND run.provider_instance_id = binding.instance_id
        AND run.status = 'completed' ORDER BY run.ordinal DESC LIMIT 1) AS previous_run_id
      FROM conversation_v2_native_bindings binding WHERE thread_id = ?`).get(threadId) as {
      instance_id: string; native_thread_id: string; configuration_fingerprint: string | null; previous_run_id: string | null
    } | undefined
    if (!binding?.previous_run_id) throw new ConversationTurnRejectedError('找不到接力来源的已结算原生回合。')
    const source = { ...binding, previous_run_id: binding.previous_run_id }
    const loaded = this.loadedThreads.get(threadId)
    if (!loaded) return source
    const key = JSON.stringify([binding.instance_id, pathKey(authority.cwd)])
    const owned = this.processes.get(key)
    const verify = (): void => {
      fence()
      if (this.loadedThreads.get(threadId) !== loaded || owned?.driver !== loaded.driver ||
        this.processes.get(key) !== owned || loaded.nativeThreadId !== binding.native_thread_id ||
        this.ready.get(key)?.fingerprint !== binding.configuration_fingerprint
        || [...this.loadedThreads].some(([id, peer]) => id !== threadId && peer.driver === loaded.driver && peer.nativeThreadId === loaded.nativeThreadId)) {
        throw new DaemonError('E_CONFLICT', '接力来源的原生会话归属已变化。')
      }
    }
    verify()
    if (loaded.driver.detachThread) {
      const unpin = this.pinPreparation(loaded.driver)
      try {
        await runBounded(loaded.driver.detachThread({ nativeThreadId: loaded.nativeThreadId, assertCurrent: verify }),
          this.deadlines.control, '解除接力来源订阅', this.shutdownController.signal)
        verify()
        this.loadedThreads.delete(threadId)
      } finally { unpin() }
    } else {
      if (!owned || !loaded.driver.canConfirmWindowsJobClose?.(loaded.nativeThreadId) || this.driverOpenings.has(key) ||
        this.preparingDrivers.has(loaded.driver) || this.closingDrivers.has(loaded.driver) ||
        [...this.activeTurns.values()].some(turn => turn.driver === loaded.driver) ||
        [...this.loadedThreads].some(([id, peer]) => id !== threadId && peer.driver === loaded.driver)) {
        throw new DaemonError('E_BUSY', '原引擎仍有共享会话或无法确认解绑，接力尚未发送。')
      }
      await this.closeOwned(key, owned)
    }
    return source
  }

  private observeTurn(turn: ActiveTurn, event: ConversationDriverTurnEvent | ConversationNativeSubagentEvent): void {
    const { row, runId } = turn
    if (this.closing || !event.turnId || event.turnId.length > 512 || this.activeTurns.get(row.thread_id) !== turn || !this.worker.canObserve(row, turn.attemptId)) return
    this.ports.assertOwner()
    if (turn.controlTurnId && turn.controlTurnId !== event.turnId) return
    const state = this.worker.attempt(row.effect_id)
    if (!state) return
    if (event.type === 'native-subagent') {
      if (event.turnIdSource === 'host' || state.native_turn_id !== event.turnId || state.provider_thread_id !== turn.nativeThreadId) return
      const run = this.commands.run(row.thread_id, runId)
      if (!run) return
      const selection = decodeModelSelection(JSON.parse(run.payload_json).modelSelection)
      this.relations.recordNativeActivity(this.eventSink, {
        threadId: row.thread_id, runId, attemptId: turn.attemptId, instanceId: selection.instanceId, model: selection.model,
      }, event)
      return
    }
    if (event.type === 'usage') {
      if (state.provider_thread_id !== turn.nativeThreadId || turn.controlTurnId !== event.turnId ||
        turn.hasNativeTurnId !== (event.turnIdSource !== 'host') || state.foreground_ended ||
        turn.hasNativeTurnId && state.native_turn_id !== event.turnId) return
      this.recordUsage(row.thread_id, runId, event.usage)
      return
    }
    if (event.type === 'work-item') {
      if (event.turnIdSource !== 'host' && !state.foreground_ended &&
        state.provider_thread_id === turn.nativeThreadId && state.native_turn_id === event.turnId) {
        this.applyWorkItem(turn, event.turnId, event.item)
      }
      return
    }
    turn.controlTurnId = event.turnId
    turn.signalControlTurn?.(event.turnId)
    turn.hasNativeTurnId ??= event.turnIdSource !== 'host'
    const nativeTurnId = turn.hasNativeTurnId ? event.turnId : undefined
    if (event.type === 'turn-receipt' || event.type === 'turn-accepted') {
      const accepted = event.type === 'turn-accepted'
      const handoff = accepted ? this.currentHandoff(row.thread_id, runId) : undefined
      const acceptedHandoff = handoff?.state === 'prepared' ? { ...handoff, state: 'accepted' as const } : undefined
      const delivery = accepted && nativeTurnId && turn.completion && !turn.completionAccepted
        ? this.completionRelations(row.thread_id, turn.completion, runId, turn.authority).map(relation => this.relations.update({
          ...relation, ...(relation.result && { result: { ...relation.result, state: 'delivered' as const } }),
          completionDelivery: { state: 'delivered', observedByRunId: RunId.make(runId) }, updatedAt: new Date().toISOString(),
        })) : []
      this.recordTurnEvidence(row.thread_id, runId, {
        ...(nativeTurnId ? { nativeTurnId } : {}),
        ...(accepted ? { engineAcceptedAt: new Date().toISOString() } : {}),
        ...(accepted && event.nativeStartedAt ? { nativeStartedAt: event.nativeStartedAt } : {}),
      }, () => {
        if (nativeTurnId) this.worker.recordNativeTurn(row, nativeTurnId)
        if (acceptedHandoff) this.database.prepare(`UPDATE conversation_v2_projection_runs
          SET payload_json = json_patch(payload_json, ?) WHERE run_id = ?`).run(JSON.stringify({ handoff: acceptedHandoff }), runId)
        for (const change of delivery) change.apply()
      }, [...(acceptedHandoff ? [lifecycleEvent(row.thread_id, { kind: 'handoff', handoff: acceptedHandoff }, runId)] : []),
        ...delivery.flatMap(change => change.hostEvents)])
      if (delivery.length) turn.completionAccepted = true
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
      const delegated = request.kind === 'user-input' ? this.relations.delegatedParent(row.thread_id) : undefined
      const relation = delegated?.childRunId === runId && !delegated.question ? this.relations.update({
        ...delegated, status: 'waiting', updatedAt: request.createdAt,
        question: { requestId, generation: request.generation, title: request.payload.title },
      }) : undefined
      this.eventSink.commit({ hostEvents: [
        lifecycleEvent(row.thread_id, { kind: 'request', request }, runId),
        ...(relation?.hostEvents ?? []),
      ] }, () => {
        this.commands.writeRequest(row.thread_id, request, nativeTurnId ?? null)
        this.commands.bindNativeRequest(requestId, turn.attemptId, event.nativeRequestId)
        relation?.apply()
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

  private currentHandoff(threadId: string, runId: string): ConversationHandoff | undefined {
    const run = this.commands.run(threadId, runId)
    return run ? (JSON.parse(run.payload_json) as { handoff?: ConversationHandoff }).handoff : undefined
  }

  private recordUsage(threadId: string, runId: string, usage: ConversationTurnUsage): void {
    if (Object.values(usage).some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) return
    this.eventSink.commit({ hostEvents: [lifecycleEvent(threadId, { kind: 'usage', usage }, runId)] }, () => {
      this.continuation.writeUsage(runId, usage)
    })
  }

  private applyWorkItem(turn: ActiveTurn, nativeTurnId: string, item: ConversationDriverWorkItem): void {
    const { row: { thread_id: threadId }, runId, attemptId } = turn
    const nativeItemId = item.kind === 'plan-steps' ? null : item.nativeItemId
    if (nativeItemId !== null && (!nativeItemId || nativeItemId.length > 512 ||
      nativeItemId !== nativeItemId.trim() || /[\u0000-\u001f\u007f]/.test(nativeItemId))) return
    const binding = createHash('sha256').update(JSON.stringify([attemptId, nativeTurnId])).digest('hex')
    const identity = createHash('sha256').update(JSON.stringify([threadId, runId, binding, item.kind, nativeItemId])).digest('hex')
    const id = `work_${identity}`
    const existing = this.database.prepare(`SELECT payload_json FROM conversation_v2_projection_turn_items
      WHERE turn_item_id = ? AND thread_id = ? AND run_id = ?`)
      .get(id, threadId, runId) as { payload_json: string } | undefined
    const previous: ConversationProjectedWorkItem | undefined = existing && JSON.parse(existing.payload_json)
    const occurredAt = new Date().toISOString()
    const clip = (text: string, limit: number): string =>
      text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit).trimEnd()
    const preceding = previous?.ordinal ?? (this.database.prepare(`SELECT COALESCE(MAX(ordinal) + 1, 0) AS ordinal
      FROM conversation_v2_projection_turn_items WHERE thread_id = ?`).get(threadId) as { ordinal: number }).ordinal
    const status = item.kind === 'tool' ? item.status : 'completed'
    if ((previous?.type === 'dynamic_tool' || previous?.type === 'file_change') &&
      previous.status !== 'running' && previous.status !== status) return
    const base = {
      id, runId, threadId, nodeId: null, providerThreadId: null, providerTurnId: null, parentItemId: null,
      nativeItemRef: {
        driver: 'codex', nativeId: nativeItemId,
        strength: nativeItemId === null ? 'weak' as const : 'strong' as const,
        fingerprint: binding,
      },
      ordinal: preceding, status, startedAt: previous?.startedAt ?? occurredAt,
      completedAt: status === 'running' ? null : previous?.completedAt ?? occurredAt,
      updatedAt: occurredAt,
    }
    let payload: ConversationProjectedWorkItem
    if (item.kind === 'tool') {
      const label = clip(item.label, 80)
      if (!label) return
      const files = status === 'completed' && item.fileChanges ? codexFileChangeEvidence(turn.executionRoot, item.fileChanges) : undefined
      if (!files && previous?.type === 'file_change') return
      payload = files ? { ...base, type: 'file_change', title: label, ...files }
        : { ...base, type: 'dynamic_tool', title: label, toolName: label, input: null }
    } else if (item.kind === 'proposed-plan') {
      const markdown = clip(item.markdown, 8_000)
      if (!markdown) return
      payload = { ...base, type: 'proposed_plan', title: '计划建议', planId: id, markdown, streaming: false }
    } else {
      const explanation = item.explanation && clip(item.explanation, 1_000)
      payload = { ...base, type: 'todo_list', title: '计划', planId: id, ...(explanation && { explanation }),
        steps: item.steps.slice(0, 24).map((step, index) => ({
          id: `step-${index + 1}`, text: clip(step.text, 240) || `步骤 ${index + 1}`, status: step.status,
        })) }
    }
    const budget = this.database.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
      FROM conversation_v2_projection_turn_items WHERE run_id = ? AND turn_item_id <> ?`)
      .get(runId, id) as { count: number; bytes: number }
    let stored = JSON.stringify(payload)
    if (payload.type === 'file_change' && previous?.type === 'dynamic_tool' &&
      budget.bytes + Buffer.byteLength(stored) > MAX_WORK_ITEM_BYTES_PER_RUN) {
      payload = { ...previous, status, updatedAt: occurredAt, completedAt: previous.completedAt ?? occurredAt }
      stored = JSON.stringify(payload)
    }
    if (previous && JSON.stringify({ ...payload, updatedAt: previous.updatedAt }) === existing?.payload_json) return
    if (budget.count >= MAX_WORK_ITEMS_PER_RUN || budget.bytes + Buffer.byteLength(stored) > MAX_WORK_ITEM_BYTES_PER_RUN) return
    const event = decodeEvent({ id: randomUUID(), threadId, runId, occurredAt, type: 'turn-item.updated', payload })
    this.eventSink.commit({ events: [event] }, () => {
      this.database.prepare(`INSERT INTO conversation_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, provider_turn_id, ordinal, type, status, updated_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(turn_item_id) DO UPDATE SET
          provider_turn_id = excluded.provider_turn_id, type = excluded.type, status = excluded.status,
          updated_at = excluded.updated_at, payload_json = excluded.payload_json`)
        .run(id, threadId, runId, payload.providerTurnId, payload.ordinal, payload.type, status, occurredAt, stored)
    })
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
        const lateResults = this.disallowLateDeliveries(threadId, runId, evidence.observedAt)
        this.eventSink.commit({ hostEvents: [
          lifecycleEvent(threadId, { kind: 'run', phase: 'foreground-ended' }, runId, evidence.observedAt),
          lifecycleEvent(threadId, { kind: 'terminal-evidence', evidence }, runId, evidence.observedAt),
          ...expiredRequests.map(request => lifecycleEvent(threadId, { kind: 'request', request }, runId, evidence.observedAt)),
          ...lateResults.flatMap(change => change.hostEvents),
        ] }, () => {
          this.worker.recordNativeTerminal(row, evidence)
          this.database.prepare('UPDATE conversation_v2_dispatch_attempts SET foreground_ended = 1 WHERE effect_id = ?').run(row.effect_id)
          for (const request of expiredRequests) this.commands.writeRequest(threadId, request, null)
          for (const change of lateResults) change.apply()
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
    void this.retireWorktreeWriter(turn.writerSlot, turn)
    if (!this.dispatches.has(row.command_id)) this.scheduleNext(row.thread_id, turn.authority)
  }

  private async retireWorktreeWriter(slot?: string, turn?: ActiveTurn): Promise<void> {
    if (!slot) return
    const owned = this.processes.get(slot)
    if (!owned || (turn && owned.driver !== turn.driver)) return
    try {
      await this.closeOwned(slot, owned)
      if (turn && this.activeTurns.get(turn.row.thread_id) === turn) this.activeTurns.delete(turn.row.thread_id)
    } catch {
      process.emitWarning('独立工作树的原进程尚未确认清理，保留写入登记。', { code: 'CRUX_DELEGATED_WORKTREE_CLEANUP' })
    }
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

  private recordTurnEvidence(threadId: string, runId: string, evidence: ConversationRunEvidence, apply?: () => void,
    extraEvents: readonly ConversationLifecycleEvent[] = []): void {
    this.ports.assertOwner()
    const event = this.runEvidenceEvent(threadId, runId, evidence, new Date().toISOString())
    this.eventSink.commit({ hostEvents: [event, ...extraEvents] }, () => {
      this.applyTurnEvidence(runId, evidence)
      apply?.()
    })
  }

  private applyTurnEvidence(runId: string, evidence: ConversationRunEvidence): void {
    this.database.prepare('UPDATE conversation_v2_projection_runs SET payload_json = json_patch(payload_json, ?) WHERE run_id = ?').run(JSON.stringify(evidence), runId)
  }

  private disallowLateDeliveries(threadId: string, runId: string, at: string) {
    return this.relations.read(threadId).children.flatMap(relation =>
      relation.parentRunId === runId && relation.result?.state === 'available'
        ? [this.relations.update({ ...relation, updatedAt: at, result: { ...relation.result, state: 'read-only' } })] : [])
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
    const childStatus = outboxStatus === 'succeeded' ? 'completed' : outboxStatus
    const delegated = this.relations.delegatedParent(threadId)
    const relation = delegated?.childRunId === runId
      ? this.settleDelegatedWork(delegated, childStatus, settled, outputs, detail)
      : run && !compactionFromPayload(run.payload_json) ? this.relations.childUpdate(threadId, childStatus, runId, settled) : undefined
    const lateResults = this.disallowLateDeliveries(threadId, runId, settled)
    const disposedCompletion = outboxStatus === 'succeeded' ? undefined : this.disposeDelegatedCompletion(row, settled)
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
      ...(relation ? relation.hostEvents : []),
      ...lateResults.flatMap(change => change.hostEvents),
      ...(disposedCompletion?.hostEvents ?? []),
    ] }, () => {
      this.settleRun(threadId, runId, status, detail, settled)
      this.worker.releaseClaim(row, settled, outboxStatus, detail)
      if (relation) relation.apply()
      for (const change of lateResults) change.apply()
      disposedCompletion?.apply()
      if (turn) this.settleStopFromTerminal(turn, settled)
    })
    if (turn && !turn.completion && status === 'completed' && this.delegatedCompletionSource(turn) &&
      this.relations.read(threadId).children.some(child => child.parentRunId === runId && child.completionWake)) {
      this.delegationContinuationParents.set(threadId, turn)
      this.offerDelegatedCompletionDelivery(threadId, runId)
    }
    if (delegated?.childRunId === runId) this.offerDelegatedCompletionDelivery(delegated.parentThreadId, delegated.parentRunId)
  }

  private settleDelegatedWork(relation: NonNullable<ReturnType<ThreadRelations['delegatedParent']>>,
    status: 'completed' | 'failed' | 'cancelled', at: string, outputs: readonly { payload_json: string }[], failure?: string) {
    const parent = this.activeTurns.get(relation.parentThreadId)
    const endedParent = this.delegationContinuationParents.get(relation.parentThreadId)
    let available = false
    let eligible = false
    if (parent && parent.runId === relation.parentRunId && this.delegatedWork.matchesOriginalAttempt(relation, parent.attemptId)) {
      try {
        this.assertDelegationParentCurrent(parent, parent.controlTurnId, true)
        available = !parent.terminal
        eligible = true
      } catch (error) {
        if (!(error instanceof DaemonError)) throw error
      }
    } else if (endedParent && endedParent.runId === relation.parentRunId &&
      this.delegatedWork.matchesOriginalAttempt(relation, endedParent.attemptId)) {
      const source = this.delegatedCompletionSource(endedParent)
      try {
        if (source) {
          this.assertDelegatedCompletionSource(relation.parentThreadId, source, endedParent.authority)
          eligible = true
        }
      } catch {
        eligible = false
      }
    }
    const text = outputs.map(row => (JSON.parse(row.payload_json) as { text?: string }).text ?? '').filter(Boolean).join('\n\n').slice(0, 8_000)
      || failure?.slice(0, 2_000)
    return this.relations.update({
      ...relation, status, question: undefined, updatedAt: at,
      ...(relation.completionWake && { completionDelivery: { state: eligible ? 'pending' : 'disposed', observedByRunId: null } }),
      result: { deliveryId: delegationOperationId([relation.id, 'result']), state: available ? 'available' : 'read-only', ...(text && { text }) },
    })
  }

  private settleUnknown(row: ThreadEffectRow, runId: string, nativeTurnId: string, settled: string, detail: string, terminal?: ConversationNativeTerminalEvidence): void {
    this.ports.assertOwner()
    const evidence: ConversationRunEvidence = { outcomeUnknown: true, outcomeUnknownAt: settled, failure: detail, ...(nativeTurnId ? { nativeTurnId } : {}) }
    const threadId = row.thread_id
    const run = this.commands.run(threadId, runId)
    const relation = run && !compactionFromPayload(run.payload_json)
      ? this.relations.childUpdate(threadId, 'pending-reconciliation', runId, settled) : undefined
    const lateResults = this.disallowLateDeliveries(threadId, runId, settled)
    this.eventSink.commit({ commandId: row.command_id, hostEvents: [
      this.runEvidenceEvent(threadId, runId, evidence, settled),
      lifecycleEvent(threadId, { kind: 'dispatch', status: 'unknown' }, runId, settled),
      lifecycleEvent(threadId, { kind: 'queue', paused: true }, runId, settled),
      ...(terminal ? [lifecycleEvent(threadId, { kind: 'terminal-evidence', evidence: terminal }, runId, settled)] : []),
      ...(relation ? relation.hostEvents : []),
      ...lateResults.flatMap(change => change.hostEvents),
    ] }, () => {
      this.applyTurnEvidence(runId, evidence)
      if (terminal) this.worker.recordNativeTerminal(row, terminal)
      this.worker.markUnknown(row, settled, detail)
      this.commands.setPaused(threadId, true)
      if (relation) relation.apply()
      for (const change of lateResults) change.apply()
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



  listThreads(ownerId: string, spaceId: string, projectId: string, filter?: { archived?: boolean; query?: string }) {
    this.ports.assertOwner()
    return this.intake.listThreads(ownerId, spaceId, projectId, filter)
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
      relations: this.relations.read(threadId),
      goal: this.continuation.readGoal(threadId),
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
    const runIds = result.runs.map(run => run.id)
    const rows = runIds.length ? this.database.prepare(`SELECT payload_json FROM conversation_v2_projection_turn_items
      WHERE thread_id = ? AND run_id IN (${runIds.map(() => '?').join(',')}) AND type IN ('dynamic_tool', 'proposed_plan', 'todo_list')
      ORDER BY ordinal, turn_item_id`).all(threadId, ...runIds) : []
    return {
      runs: result.runs, messages: result.messages,
      turnItems: rows.map(row => JSON.parse(String(row.payload_json)) as ConversationProjectedWorkItem),
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
    let foregroundOpenings = 0
    for (const opening of this.driverOpenings.values()) {
      if (!opening.background) foregroundOpenings += 1
    }
    return this.dispatches.size + foregroundOpenings
  }

  ownsWorkspace(within: (path: string) => boolean): boolean {
    return [...this.dispatches.values()].some(dispatch => within(dispatch.root))
      || [...this.driverOpenings.values()].some(entry => within(entry.root) ||
        (entry.worktreeWriter !== undefined && within(entry.worktreeWriter.projectRoot)))
      || [...this.processes.values()].some(owned => within(owned.root) ||
        (owned.projectRoot !== undefined && within(owned.projectRoot)))
  }

  /**
   * Closes every owned app-server. An unconfirmed exit is reported upward and the driver stays
   * recorded, so the owner never claims a clean shutdown while a process may still be alive.
   */
  async shutdown(): Promise<void> {
    this.closing = true
    for (const timer of this.idleCompactions.values()) clearTimeout(timer)
    this.idleCompactions.clear()
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
