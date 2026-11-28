import { randomUUID } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { openConversationDatabase } from '../../services/conversation/persistence/database'
import { ConversationProjectionStore } from '../../services/conversation/persistence/ProjectionStore'
import { ConversationAttachmentStore } from '../../services/conversation/attachments'
import { conversationAttachmentDraftScope, prepareConversationAttachmentClaim } from '../../services/conversation/attachments/claims'
import { prepareConversationKnowledge } from '../../services/conversation/attachments/knowledge'
import type { ConversationKnowledgeAttachment } from '../../../shared/conversation/knowledge-reference'
import type { ConversationProjectRoleSelection } from '../../../shared/conversation/project-role'
import type { OpenArtifactMcpGrant } from '../../../shared/open-artifact'
import { expandAssistantCitationsForProvider } from '../../../shared/conversation/assistantCitationText'
import { classifyConversationFailure } from '../../../shared/conversation/failure-taxonomy'
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
import {
  ProviderSessionManager, driverSlotKey, type DriverIdentity,
} from '../../services/conversation/orchestration/ProviderSessionManager'
import { decideProviderSessionTransition } from '../../services/conversation/orchestration/ProviderSessionTransitionPolicy'
import { ProviderTurnControlService } from '../../services/conversation/orchestration/ProviderTurnControlService'
import { RuntimeRequestService } from '../../services/conversation/orchestration/RuntimeRequestService'
import {
  ProviderEventIngestor, buildDelegatedCompletionDeliveryUpdates,
} from '../../services/conversation/orchestration/ProviderEventIngestor'
import { UsageLimitRecoveryWorker } from '../../services/conversation/orchestration/UsageLimitRecoveryWorker'
import {
  RESTART_CONTINUATION_EFFECT_TYPE,
  buildManualContinuationText,
  buildRestartContinuationText,
  collectRestartCancelledWorkChain,
  hasBlockingRuntimeRequestForRun,
  hasLaterExecutedRun,
  isContinuationBudgetExhausted,
  manualContinuationNotification,
  parseRestartContinuationPayload,
  restartContinuationCommandId,
  restartContinuationMessageId,
  restartContinuationNotification,
  type RestartCancelledWork,
  type RestartContinuationRunRecord,
} from '../../services/conversation/orchestration/RestartContinuation'
import { decideThreadResume, THREAD_RESUME_MAX_REPLAY_EVENTS } from '../../services/conversation/orchestration/ThreadStream'
import { ANSWER_ATTACHMENT_MAX_BYTES, assertPromptAttachments, nativeTextAttachment, TEXT_ATTACHMENTS } from '../../services/conversation/providers/core/attachment-input'
import {
  conversationDriverRegistry, ConversationTurnOutcomeUnknownError, ConversationTurnRejectedError,
  type ConversationDriverDescriptor, type ConversationDriverModel, type ConversationDriverRegistration, type ConversationDriverRegistry,
  type ConversationDriverSession, type ConversationDriverTurnEvent, type ConversationRuntimeResponse,
} from '../../services/conversation/providers/registry'
import { DaemonError } from '../errors'
import type { WorkcopyUseRegistry } from '../../services/workcopy-use/registry'
import { resolveWorkcopy } from '../../services/workcopy-use/identity'
import { prepareDelegatedWorktree, recoverDelegatedWorktreePreparation, verifyDelegatedWorktree } from '../../services/conversation/orchestration/DelegatedWorktree'
import { pathKey } from '../../services/task-conversations/lib/paths'
import type { ConversationAuthority, ConversationCommandState, ConversationEventPage, ConversationRunEvidence } from '../../../shared/conversation/desktop'
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
  type ConversationNativeTerminalEvidence, type ConversationProjectedWorkItem, type ConversationHandoff,
} from '../../../shared/conversation/command-runtime'

export interface ConversationRuntimePorts {
  directory: string
  driverRegistry?: ConversationDriverRegistry
  workcopies?: WorkcopyUseRegistry
  deadlines?: Partial<{ open: number; thread: number; turn: number; control: number; close: number }>
  assertOwner(): void
  shouldContinueThreadsAfterRestart?: () => boolean
}

type CommandAuthority = ConversationAuthority & {
  readonly taskContext?: string
  assertCurrent(): void | Promise<void>
  assertReadable?(): Promise<void>
  assertSpawnCurrent?(): void
}

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

/**
 * The new conversation kernel. It owns its storage and never reads legacy ACP history.
 * A turn is executed only by draining its outbox item, so a crash between intake and
 * dispatch leaves exactly one retryable intent instead of a second message.
 */
export class ConversationRuntime {
  private readonly database
  private readonly projections: ConversationProjectionStore
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
  private readonly sessions: ProviderSessionManager
  private readonly runtimeRequests: RuntimeRequestService<ActiveTurn>
  private readonly ingestor: ProviderEventIngestor<ActiveTurn>
  private readonly turnControl: ProviderTurnControlService<ActiveTurn, CommandAuthority>
  private readonly usageLimitRecovery: UsageLimitRecoveryWorker<CommandAuthority>
  private readonly storageId: string
  private readonly deadlines
  private readonly dispatches = new Map<string, { root: string; work: Promise<void> }>()
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly authorizations = new Map<string, CommandAuthority>()
  private readonly threadArtifactMcps = new Map<string, OpenArtifactMcpGrant>()
  private readonly worktreePreparations = new Map<string, { runId: string; controller: AbortController }>()
  private readonly idleCompactions = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly delegationCalls = new Map<string, { input: string; result: Promise<ConversationDelegationReply> }>()
  private readonly delegationContinuationParents = new Map<string, ActiveTurn>()
  private readonly unsettledTerminals = new Map<string, { turn: ActiveTurn; detail: string; terminal: ConversationNativeTerminalEvidence }>()
  private readonly shutdownController = new AbortController()
  private closing = false
  constructor(private readonly ports: ConversationRuntimePorts) {
    this.ports.assertOwner()
    this.database = openConversationDatabase(ports.directory)
    this.projections = new ConversationProjectionStore(this.database)
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
    this.storageId = this.projections.readStorageId()
    this.deadlines = { open: 30_000, thread: 30_000, turn: 31 * 60_000, control: 15_000, close: 8_000, ...ports.deadlines }
    this.sessions = new ProviderSessionManager({
      directory: ports.directory,
      driverRegistry: this.driverRegistry,
      deadlines: this.deadlines,
      shutdownSignal: this.shutdownController.signal,
      isClosing: () => this.closing,
      assertOwner: () => this.ports.assertOwner(),
      hasActiveTurnForDriver: driver => [...this.activeTurns.values()].some(turn => turn.driver === driver),
    })
    this.runtimeRequests = new RuntimeRequestService<ActiveTurn>(this.projections, this.eventSink, this.commands, this.relations)
    this.ingestor = new ProviderEventIngestor<ActiveTurn>(
      this.projections, this.eventSink, this.commands, this.relations, this.continuation, this.worker, this.runtimeRequests,
    )
    this.turnControl = new ProviderTurnControlService<ActiveTurn, CommandAuthority>({
      deadlines: this.deadlines,
      shutdownSignal: this.shutdownController.signal,
      sessions: this.sessions,
      projections: this.projections,
      commands: this.commands,
      relations: this.relations,
      worker: this.worker,
      runtimeRequests: this.runtimeRequests,
      eventSink: this.eventSink,
      assertOwner: () => this.ports.assertOwner(),
      isClosing: () => this.closing,
      getActiveTurn: threadId => this.activeTurns.get(threadId),
      listActiveTurns: () => this.activeTurns.values(),
      deleteActiveTurn: threadId => {
        this.activeTurns.delete(threadId)
      },
      clearAuthorization: commandId => {
        this.authorizations.delete(commandId)
      },
      abortWorktreePreparation: threadId => {
        this.worktreePreparations.get(threadId)?.controller.abort()
      },
      cancelUsageLimitRecovery: (threadId, reason) => {
        this.usageLimitRecovery.cancel(threadId, reason)
      },
      acceptInterrupt: (command, authority, turn) => this.acceptStop(command, authority, turn),
      settleOutcome: (row, threadId, runId, status, detail, outboxStatus, settled, turn) =>
        this.settleOutcome(row, threadId, runId, status, detail, outboxStatus, settled, turn),
      cancelPendingRun: ({ threadId, runId, effect, occurredAt, reason }) => {
        const run = this.commands.run(threadId, runId)
        const cancelledRun = run
          ? { ...JSON.parse(run.payload_json), status: 'cancelled', completedAt: occurredAt, failure: reason }
          : undefined
        this.eventSink.commit({
          events: cancelledRun ? [decodeEvent({ id: randomUUID(), threadId, runId, occurredAt, type: 'run.updated', payload: cancelledRun })] : [],
          hostEvents: [lifecycleEvent(threadId, { kind: 'run', phase: 'settled' }, runId, occurredAt)],
        }, () => {
          this.database.prepare("UPDATE conversation_v2_effect_outbox SET status = 'cancelled', last_error = ?, completed_at = ?, updated_at = ? WHERE effect_id = ? AND status = 'pending'")
            .run(reason, occurredAt, occurredAt, effect.effect_id)
          if (cancelledRun) {
            this.database.prepare("UPDATE conversation_v2_projection_runs SET status = 'cancelled', payload_json = ?, completed_at = ? WHERE run_id = ?")
              .run(JSON.stringify(cancelledRun), occurredAt, runId)
          }
        })
      },
      retireWorktreeWriter: (slot, turn) => this.retireWorktreeWriter(slot, turn),
      scheduleNext: (threadId, authority) => this.scheduleNext(threadId, authority),
    })
    this.usageLimitRecovery = new UsageLimitRecoveryWorker<CommandAuthority>(this.projections, this.eventSink, {
      isClosing: () => this.closing,
      assertOwner: () => this.ports.assertOwner(),
      hasActiveTurn: threadId => this.activeTurns.has(threadId),
      isArchived: threadId => this.commands.isArchived(threadId),
      hasBlockingRuntimeRequest: threadId => this.commands.requests(threadId).some(
        request => request.status === 'pending' || request.status === 'responding' || request.status === 'pending-reconciliation',
      ),
      dispatchAutoRetry: ({ threadId, failedRunId, commandId, authority }) => this.dispatchUsageLimitAutoRetry(threadId, failedRunId, commandId, authority),
    })
    this.worker.reconcile('startup', { continueAfterRestart: this.shouldContinueAfterRestart() })
    this.relations.reconcileAfterRecovery(this.eventSink)
    this.usageLimitRecovery.reconcileOnStartup()
    this.recoverWorktreePreparations()
  }

  private shouldContinueAfterRestart(): boolean {
    try {
      return this.ports.shouldContinueThreadsAfterRestart?.() ?? true
    } catch {
      return true
    }
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

  private ensureDriver(cwd: string, projectId: string, registration: ConversationDriverRegistration, assertCurrent: () => void, ordinaryTask = false,
    ownerScope?: string, managedExecution?: true, worktreeWriter?: DriverIdentity['worktreeWriter'], background = false) {
    return this.sessions.ensureDriver(cwd, projectId, registration, assertCurrent, ordinaryTask, ownerScope, managedExecution, worktreeWriter, background)
  }

  private bindingFingerprint(registration: ConversationDriverRegistration): string {
    return this.sessions.bindingFingerprint(registration)
  }

  private bindingFingerprintMatches(stored: string | null | undefined, expected: string): boolean {
    return this.sessions.bindingFingerprintMatches(stored, expected)
  }

  private closeOwned(key: string, owned: { root: string; driver: ConversationDriverSession }, deletion?: {
    readonly commandId: string
    verify(): void
    record(): void
  }): Promise<void> {
    return this.sessions.closeOwned(key, owned, deletion)
  }

  private isOrdinaryTask(authority: Pick<ConversationAuthority, 'binding'>): boolean {
    return authority.binding.kind === 'task' && authority.binding.mode === 'conversation'
  }

  private requireDriver(instanceId: string, ordinaryTask: boolean): ConversationDriverRegistration {
    return this.sessions.requireDriver(instanceId, ordinaryTask)
  }

  listModels(cwd: string, projectId: string, instanceId: string, assertCurrent: () => void, ordinaryTask = false): Promise<readonly ConversationDriverModel[]> {
    return this.sessions.listModels(cwd, projectId, instanceId, assertCurrent, ordinaryTask)
  }

  describeDriver(cwd: string, projectId: string, instanceId: string, assertCurrent: () => void, ordinaryTask = false, ownerScope?: string): Promise<ConversationDriverDescriptor> {
    return this.sessions.describeDriver(cwd, projectId, instanceId, assertCurrent, ordinaryTask, ownerScope)
  }

  prewarmRecentDrivers(defaults: ReadonlyArray<{ cwd: string; projectId: string; instanceId: string }> = []): void {
    this.sessions.prewarmRecentDrivers(defaults)
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
      const bound = this.runtimeRequests.getNativeRequest(target.requestId)
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
    readonly tags?: readonly string[]
    readonly artifactMcp?: OpenArtifactMcpGrant
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
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.attachmentIds !== undefined ? { attachmentIds: input.attachmentIds, draftId: input.draftId } : {}),
    }, input, registration ? this.bindingFingerprint(registration) : undefined, registration?.promptAttachments,
    input.role?.readInstructions)
    if ('conflict' in accepted) throw new DaemonError('E_CONFLICT', accepted.conflict)
    if (!accepted.committed) return this.commandState(accepted.receipt)
    const authority = { ...input, assertCurrent: input.assertAuthorityCurrent ?? input.assertCurrent }
    if (input.artifactMcp) this.threadArtifactMcps.set(accepted.receipt.threadId, input.artifactMcp)
    this.authorizations.set(input.commandId, authority)
    this.scheduleNext(accepted.receipt.threadId, authority)
    return { ...accepted.receipt, dispatch: 'accepted' }
  }

  async command(input: ConversationThreadCommand, authority: CommandAuthority, artifactMcp?: OpenArtifactMcpGrant): Promise<ConversationThreadCommandState> {
    const command = conversationThreadCommandSchema.parse(input)
    if (artifactMcp) this.threadArtifactMcps.set(command.threadId, artifactMcp)
    await this.assertCurrent(command.threadId, authority, command.type === 'thread.delete')
    if (command.type === 'thread.delete') return this.deleteThread(command, authority)
    const prior = this.commands.replay(command, authority)
    if (prior) return this.withUnsettledTerminal(prior)
    const delegated = this.relations.delegatedParent(command.threadId)
    const restrictedRelation = delegated ?? this.relations.restrictedParent(command.threadId)
    if (delegated && !['thread.rename', 'thread.pin', 'thread.archive', 'run.interrupt', 'thread.stop', 'runtime-request.respond',
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
        if (command.type === 'thread.archive' && command.archived) {
          this.usageLimitRecovery.cancel(command.threadId, '会话已归档，取消自动重试。')
        }
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
      case 'thread.handoff': {
        this.usageLimitRecovery.cancel(command.threadId, '用户已改由上下文接力继续。')
        const hasHeldQueue = this.commands.isPaused(command.threadId) && this.projections.hasQueuedRuns(command.threadId)
        if (authority.binding.kind !== 'personal' || restrictedRelation || this.commands.isArchived(command.threadId) ||
          this.activeTurns.has(command.threadId) || hasHeldQueue) {
          throw new DaemonError('E_BUSY', '仅可在已结算且无暂停队列的个人会话中交接。')
        }
        this.continuation.latestForHandoff(command.threadId)
        break
      }
      case 'message.dispatch': {
        this.usageLimitRecovery.cancel(command.threadId, '用户已手动发送新消息。')
        const registration = this.requireDriver(command.instanceId, this.isOrdinaryTask(authority))
        if (command.options?.length && (!registration.turnModelOptions || command.deliveryIntent === 'steer')) {
          throw new DaemonError('E_UNAVAILABLE', '此操作无法更改回合模型参数。')
        }
        const selection = {
          driverKind: registration.driverKind,
          modelSelection: decodeModelSelection({ instanceId: registration.instanceId, model: command.model, options: command.options }),
          configurationFingerprint: this.bindingFingerprint(registration),
        }
        if (command.deliveryIntent === 'steer') {
          if (command.references?.length) throw new DaemonError('E_UNAVAILABLE', '带历史引用的消息请正常发送或加入队列。')
          if (command.attachmentIds?.length) throw new DaemonError('E_UNAVAILABLE', '当前插话入口只支持文字，请把附件加入队列。')
          const turn = this.requireControlTurn(active, 'steerTurn')
          if (!this.bindingFingerprintMatches(turn.configurationFingerprint, selection.configurationFingerprint)) {
            throw new DaemonError('E_CONFLICT', '原回合使用的引擎配置已变化。')
          }
          const state = this.commands.appendMessage(command, authority, selection, {
            targetRunId: turn.runId, targetAttemptId: turn.attemptId,
          })
          this.resolvePendingAsyncUserInputs(command.threadId)
          this.scheduleControl(command, authority, turn, state.runId)
          return state
        }
        if (command.manualContinuationOfRunId) {
          const manualContinuation = this.prepareManualContinuation(command)
          const receipt = this.commands.appendMessage(
            command, authority, selection, undefined, undefined, undefined, this.relations, undefined, manualContinuation,
          )
          this.resolvePendingAsyncUserInputs(command.threadId)
          this.authorizations.set(command.commandId, authority)
          this.scheduleNext(command.threadId, authority)
          return receipt
        }
        const portableHistory = command.references?.map(reference => this.contextHandoff.capture(reference, authority))
        const receipt = this.commands.appendMessage(command, authority, selection, undefined, registration.promptAttachments, portableHistory, this.relations)
        this.resolvePendingAsyncUserInputs(command.threadId)
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
        this.usageLimitRecovery.cancel(command.threadId, '用户已请求停止当前回合。')
        return this.acceptStop(command, authority, active)
      case 'thread.stop':
        return this.turnControl.forceStopThread(command, authority)
      case 'subagent.stop':
        return this.turnControl.stopSubagent(command, authority)
      case 'usage-limit-recovery.cancel': {
        this.usageLimitRecovery.cancel(command.threadId, '用户已取消限流自动重试。')
        return this.commands.commit(command, authority, {
          target: { detail: '已取消限流自动重试。' },
          hostEvents: [lifecycleEvent(command.threadId, { kind: 'usage-limit-recovery', recovery: null })],
          apply: () => {},
        })
      }
      case 'usage-limit-recovery.retry-now': {
        const { runId, commandId: retryCommandId } = this.usageLimitRecovery.retryNow(command.threadId, authority)
        return this.commands.commit(command, authority, {
          target: { run_id: runId, detail: `已触发限流重试（${retryCommandId}）。` },
          hostEvents: [lifecycleEvent(command.threadId, { kind: 'usage-limit-recovery', recovery: null }, runId)],
          apply: () => {},
        })
      }
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
        if (!request || request.status !== 'pending' || request.generation !== command.generation) {
          throw new DaemonError('E_CONFLICT', '原审批或提问已失效。')
        }
        if (request.payload.kind === 'user-input' && request.payload.responseMode === 'message') {
          return this.respondToAsyncUserInput(command, authority, request)
        }
        const bound = this.runtimeRequests.getNativeRequest(command.requestId)
        if (!bound || bound.turn !== active) {
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
      .map(reference => this.contextHandoff.capture(reference, authority, undefined, false, true))
    const result = this.commands.appendMessage(command, authority, {
      driverKind: registration.driverKind, modelSelection, configurationFingerprint: this.bindingFingerprint(registration),
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
    const opening = this.sessions.driverOpenings.get(key)
    const ready = this.sessions.ready.get(key)
    if ((opening && opening.projectId !== authority.projectId) || (ready && ready.projectId !== authority.projectId)) {
      throw new DaemonError('E_DENIED', '原任务进程属于其他会话范围。')
    }
    const owned = this.sessions.processes.get(key)
    if (owned) {
      if (!receipt || pathKey(owned.root) !== pathKey(authority.cwd) ||
        [...this.sessions.loadedThreads].some(([id, loaded]) => id !== receipt.threadId && loaded.driver === owned.driver)) {
        throw new DaemonError('E_CONFLICT', '原任务进程缺少匹配的会话，需先核对。')
      }
      await this.closeOwned(key, owned)
    }
    if (opening) await awaitDeadline(opening.opening.catch(() => undefined), this.deadlines.open, '核对原任务引擎启动')
    verify()
    if (this.sessions.processes.has(key) || this.sessions.driverOpenings.has(key)) return false
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
    const active = this.sessions.loadedThreads.get(command.threadId)
    if (active ? !active.driver.compactThread : !['codex', 'pi'].includes(registration.instanceId)) {
      throw new DaemonError('E_UNAVAILABLE', '原引擎未提供可用的原生压缩。')
    }
    const configurationFingerprint = this.bindingFingerprint(registration)
    this.assertNativeBindingConfiguration(command.threadId, configurationFingerprint, modelSelection.instanceId)
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
    this.usageLimitRecovery.cancel(threadId, '会话已删除，取消自动重试。')
    const accepted = original ?? this.commands.changeThread(command, authority, {
      hasLiveTurn, hasLoadedThread: this.sessions.loadedThreads.has(threadId),
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
    const loaded = this.sessions.loadedThreads.get(threadId)
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
    const owned = this.sessions.processes.get(key)
    if (!owned || owned.driver !== loaded.driver || pathKey(owned.root) !== pathKey(cwd)) return
    const verify = (): void => {
      this.assertThreadScope(threadId, authority, true)
      const ready = this.sessions.ready.get(key)
      if (this.sessions.loadedThreads.get(threadId) !== loaded || this.activeTurns.has(threadId)
        || this.sessions.processes.get(key) !== owned || ready?.driver !== loaded.driver
        || ready.projectId !== authority.projectId || !this.bindingFingerprintMatches(fingerprint, ready.bindingFingerprint)
        || ready.ordinaryTask !== (this.isOrdinaryTask(authority) || Boolean(restrictedRelation))
        || [...this.sessions.loadedThreads].some(([id, peer]) => id !== threadId
          && peer.driver === loaded.driver && peer.nativeThreadId === loaded.nativeThreadId)) {
        throw new DaemonError('E_CONFLICT', '会话原生订阅的归属无法核实。')
      }
      this.assertBindingFingerprint(instanceId, fingerprint)
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
        this.sessions.loadedThreads.delete(threadId)
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
    if (process.platform !== 'win32' || this.sessions.closingDrivers.has(driver)) return
    const confirmed = this.sessions.verifiedDeletionCloses.get(driver)
    if (confirmed !== commandId && !this.sessions.ready.get(key)?.worktreeWriter && !driver.canConfirmWindowsJobClose?.(nativeThreadId)) return
    await this.closeOwned(key, owned, {
      commandId,
      verify: () => {
        verify()
        if (this.sessions.driverOpenings.has(key) || this.sessions.preparingDrivers.has(driver)
          || [...this.sessions.loadedThreads].some(([id, peer]) => id !== threadId && peer.driver === driver)
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
    const expiredRequests = exactTurn ? this.runtimeRequests.expiringRequests(exactTurn) : []
    const occurredAt = new Date().toISOString()
    const wasPending = source.status === 'pending'
    const hasQueuedRuns = this.database.prepare(
      "SELECT 1 FROM conversation_v2_projection_runs WHERE thread_id = ? AND status = 'queued' AND run_id <> ? LIMIT 1",
    ).get(threadId, runId) !== undefined
    const detail = canSubmit || wasPending || attempt?.phase === 'preparing'
      ? undefined
      : hasQueuedRuns ? '队列已暂停。引擎未确认原回合停止。' : '引擎未确认原回合停止。'
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
        ...(hasQueuedRuns ? [lifecycleEvent(threadId, { kind: 'queue', paused: true }, runId, occurredAt)] : []),
        lifecycleEvent(threadId, { kind: 'run', phase: detail ? 'stop-unconfirmed' : 'stop-requested' }, runId, occurredAt),
        ...expiredRequests.map(request => lifecycleEvent(threadId, { kind: 'request', request }, runId, occurredAt)),
        ...(childChange?.hostEvents ?? []),
        ...lateResults.flatMap(change => change.hostEvents),
        ...(disposedCompletion?.hostEvents ?? []),
      ],
      apply: () => {
        if (hasQueuedRuns) this.commands.setPaused(threadId, true)
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
    if (exactTurn) this.runtimeRequests.clearRequestBindings(exactTurn)
    const preparation = this.worktreePreparations.get(threadId)
    if (preparation?.runId === runId) preparation.controller.abort()
    if (wasPending) this.authorizations.delete(source.command_id)
    if (canSubmit) this.scheduleControl(command, authority, exactTurn)
    if (wasPending && childChange && child) this.offerDelegatedCompletionDelivery(child.parentThreadId, child.parentRunId)
    return result
  }

  private resolvePendingAsyncUserInputs(threadId: string): void {
    this.runtimeRequests.resolvePendingAsyncUserInputs(threadId)
  }

  private respondToAsyncUserInput(
    command: Extract<ConversationThreadCommand, { type: 'runtime-request.respond' }>,
    authority: CommandAuthority,
    request: ConversationRuntimeRequest,
  ): ConversationThreadCommandState {
    return this.runtimeRequests.respondToAsyncUserInput(command, authority, request, {
      requireDriver: (instanceId, auth) => this.requireDriver(instanceId, this.isOrdinaryTask(auth)),
      bindingFingerprint: registration => this.bindingFingerprint(registration),
      authorizeAndSchedule: (commandId, threadId, auth) => {
        this.authorizations.set(commandId, auth)
        this.scheduleNext(threadId, auth)
      },
    })
  }

  private requestResponse(request: ConversationRuntimeRequest, response: Extract<ConversationThreadCommand, { type: 'runtime-request.respond' }> | ConversationRuntimeRequestResponse): ConversationRuntimeResponse {
    return this.runtimeRequests.requestResponse(request, response)
  }

  private answerAttachmentQuestion(request: ConversationRuntimeRequest, answers: Readonly<Record<string, unknown>>, requested?: string): string {
    return this.runtimeRequests.answerAttachmentQuestion(request, answers, requested)
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
        const bound = this.runtimeRequests.getNativeRequest(command.requestId)
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
      await this.sessions.driverFence.run(() => {
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
      if (!this.worker.isOwned(effect) || this.closing) return
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
          : this.runtimeRequests.getNativeRequest(request.requestId) ? 'pending' as const : 'expired' as const,
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
        if (updatedRequest.status === 'resolved') this.runtimeRequests.deleteNativeRequest(updatedRequest.requestId)
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
      !this.sessions.loadedThreads.get(threadId)?.driver.compactThread) return
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

  private assertBindingFingerprint(instanceId: string, expected: string): void {
    this.sessions.assertBindingFingerprint(instanceId, expected)
  }

  private canFallbackFromResumeFailure(error: unknown): boolean {
    if (this.closing || this.shutdownController.signal.aborted) return false
    return classifyConversationFailure({
      error,
      isDeadlineError: error instanceof ConversationDeadlineError,
    }).canAutoRecoverResume
  }

  private async openNativeThread(
    threadId: string, instanceId: string, model: string, cwd: string, driver: ConversationDriverSession,
    fresh = false, artifactMcp?: OpenArtifactMcpGrant, allowResumeFallback = false, expectedBindingFingerprint?: string,
  ): Promise<{
    readonly nativeThreadId: string
    readonly recoveredFrom?: {
      readonly instance_id: string
      readonly native_thread_id: string
      readonly configuration_fingerprint: string | null
      readonly previous_run_id: string | null
    }
  }> {
    const loaded = this.sessions.loadedThreads.get(threadId)
    const existing = fresh ? undefined : this.projections.readNativeBindingOrRunFallback(threadId)
    const registration = this.driverRegistry.get(instanceId)
    const targetFingerprint = expectedBindingFingerprint ?? (registration ? this.bindingFingerprint(registration) : '')
    const decision = decideProviderSessionTransition({
      driverAvailable: driver.isAvailable(),
      isHandoffCommand: fresh,
      targetInstanceId: instanceId,
      targetBindingFingerprint: targetFingerprint,
      driverSupportsResume: Boolean(driver.resumeThread),
      allowResumeFallback,
      ...(existing ? {
        storedBinding: {
          instanceId: existing.instance_id,
          nativeThreadId: existing.native_thread_id,
          configurationFingerprint: existing.configuration_fingerprint,
        },
      } : {}),
      ...(loaded ? {
        loadedHandle: {
          matchesTargetDriver: loaded.driver === driver,
          nativeThreadId: loaded.nativeThreadId,
        },
      } : {}),
      fingerprintMatches: (stored, expected) => this.bindingFingerprintMatches(stored, expected),
    })

    if (decision.type === 'reject') {
      throw new DaemonError(decision.code, decision.reason)
    }
    if (decision.type === 'require_handoff_confirm') {
      throw new DaemonError('E_CONFLICT', decision.reason)
    }
    if (decision.type === 'reuse') {
      return { nativeThreadId: decision.nativeThreadId }
    }

    const startRecoveredThread = async (reason: unknown) => {
      process.emitWarning(
        `Recovering thread ${threadId} in a fresh native session after resume failure: ${failureMessage(reason)}`,
        { code: 'CRUX_CONVERSATION_RECOVERY' },
      )
      this.sessions.loadedThreads.delete(threadId)
      const replacementId = await runBounded(
        driver.startThread(model, cwd, artifactMcp),
        this.deadlines.thread,
        '建立接力原生会话',
        this.shutdownController.signal,
      )
      if (!replacementId || (existing && replacementId === existing.native_thread_id)) {
        this.sessions.uncertainDrivers.add(driver)
        throw new DaemonError('E_CONFLICT', '引擎未能为上下文恢复创建新的原生会话。')
      }
      const previousRunId = existing
        ? this.projections.latestSettledNativeRunId(threadId, existing.native_thread_id, existing.instance_id)
        : null
      return {
        nativeThreadId: replacementId,
        recoveredFrom: existing ? {
          instance_id: existing.instance_id,
          native_thread_id: existing.native_thread_id,
          configuration_fingerprint: existing.configuration_fingerprint,
          previous_run_id: previousRunId,
        } : undefined,
      }
    }

    if (decision.type === 'create_with_handoff' && decision.mode === 'resume_unsupported_fallback') {
      return startRecoveredThread(new Error('Driver does not support native resumeThread.'))
    }

    try {
      const nativeThreadId = decision.type === 'resume_existing' && driver.resumeThread
        ? await runBounded(
          driver.resumeThread({ nativeThreadId: decision.nativeThreadId, cwd, model, ...(artifactMcp ? { artifactMcp } : {}) }),
          this.deadlines.thread,
          '恢复原生会话',
          this.shutdownController.signal,
        )
        : await runBounded(driver.startThread(model, cwd, artifactMcp), this.deadlines.thread, '建立原生会话', this.shutdownController.signal)
      if (!nativeThreadId || (decision.type === 'resume_existing' && nativeThreadId !== decision.nativeThreadId)) {
        this.sessions.uncertainDrivers.add(driver)
        throw new DaemonError('E_CONFLICT', '引擎没有确认原生会话身份。')
      }
      return { nativeThreadId }
    } catch (error) {
      if (decision.type === 'resume_existing' && decision.allowDeterministicFallback && this.canFallbackFromResumeFailure(error)) {
        return startRecoveredThread(error)
      }
      if (error instanceof ConversationDeadlineError) this.sessions.uncertainDrivers.add(driver)
      throw error
    }
  }

  private pinPreparation(driver: ConversationDriverSession): () => void {
    return this.sessions.pinPreparation(driver)
  }

  private assertNativeBindingConfiguration(threadId: string, fingerprint: string, instanceId: string): void {
    const stored = this.projections.readNativeBindingOrRunFallback(threadId)
    if (!stored) return
    const decision = decideProviderSessionTransition({
      driverAvailable: true,
      isHandoffCommand: false,
      targetInstanceId: instanceId,
      targetBindingFingerprint: fingerprint,
      driverSupportsResume: true,
      allowResumeFallback: true,
      storedBinding: {
        instanceId: stored.instance_id,
        nativeThreadId: stored.native_thread_id,
        configurationFingerprint: stored.configuration_fingerprint,
      },
      fingerprintMatches: (prev, expected) => this.bindingFingerprintMatches(prev, expected),
    })
    if (decision.type === 'require_handoff_confirm') {
      throw new DaemonError('E_CONFLICT', decision.reason)
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
      const expectedFingerprint = this.bindingFingerprint(registration)
      const admittedFingerprint = this.worker.configurationFingerprint(row)
      if (admittedFingerprint && !this.bindingFingerprintMatches(admittedFingerprint, expectedFingerprint)) {
        throw new DaemonError('E_CONFLICT', '排队时选定的引擎配置已失效。')
      }
      const fork = compaction ? undefined : this.relations.forkContext(threadId, run.ordinal)
      const histories = [...(intent.portableHistory ?? []), ...(fork ? [fork] : [])]
      for (const history of histories) this.contextHandoff.assertSource(history.sourceThreadId, authority)
      if (!intent.handoff) this.assertNativeBindingConfiguration(threadId, expectedFingerprint, selection.instanceId)
      const prepareFence = (): void => {
        this.assertSpawnAuthority(threadId, authority)
        this.assertBindingFingerprint(selection.instanceId, expectedFingerprint)
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
      const handoffSource = intent.handoff ? await this.prepareHandoffSource(threadId, authority, fence, driver) : undefined
      const artifactMcp = this.threadArtifactMcps.get(threadId)
      const allowResumeFallback = !handoffSource && !compaction && !completion
      const opened = await this.sessions.driverFence.run(fence, () =>
        this.openNativeThread(threadId, selection.instanceId, selection.model, cwd, driver, Boolean(handoffSource), artifactMcp, allowResumeFallback, expectedFingerprint))
      const nativeThreadId = opened.nativeThreadId
      if (!nativeThreadId) throw new ConversationTurnRejectedError('引擎未返回接力会话身份。')
      if (completion && nativeThreadId !== completion.nativeThreadId) throw new ConversationTurnRejectedError('引擎没有接回原委派的父会话。')
      if (opened.recoveredFrom && !histories.some(history => history.sourceThreadId === threadId)) {
        histories.unshift(this.contextHandoff.capture({ threadId }, authority, run.ordinal - 1, false, true))
      }
      const effectiveHandoffSource = handoffSource ?? (opened.recoveredFrom?.previous_run_id ? {
        instance_id: opened.recoveredFrom.instance_id,
        native_thread_id: opened.recoveredFrom.native_thread_id,
        configuration_fingerprint: opened.recoveredFrom.configuration_fingerprint,
        previous_run_id: opened.recoveredFrom.previous_run_id,
      } : undefined)
      for (const source of knowledge) await source.assertRemoteCurrent(AbortSignal.any([
        this.shutdownController.signal, AbortSignal.timeout(this.deadlines.thread),
      ]))
      await this.assertCurrent(threadId, authority)
      fence()
      assertKnowledgeCurrent()
      for (const history of histories) this.contextHandoff.assertSource(history.sourceThreadId, authority)
      const goal = compaction || completion ? null : this.continuation.readGoal(threadId)
      const { text: contextText, ...coverage } = renderPortableHistory(histories)
      const handoff: ConversationHandoff | undefined = effectiveHandoffSource ? {
        sourceRunId: effectiveHandoffSource.previous_run_id, sourceInstanceId: effectiveHandoffSource.instance_id,
        targetInstanceId: selection.instanceId, ...coverage, state: 'prepared',
      } : undefined
      const roleInstructions = compaction || completion ? undefined : this.intake.readRoleInstructions(threadId)
      const prompt = [
        ...(run.ordinal === 1 && ordinaryTask && authority.taskContext ? [`以下是原团队任务的固定材料摘要。\n\n${authority.taskContext}`] : []),
        ...(roleInstructions?.trim() ? [`当前工程中用户选定的角色指令（Crux）\n${roleInstructions}`] : []),
        ...(artifactMcp ? ['当前会话已启用 Crux /artifacts（Open Artifact）交互产物工具。请先调用 Artifact(action="quickstart", intent=...) 匹配最佳产物类型（docs/slides/whiteboard/design 等）并检查可复用旧产物，再通过 Artifact(action="publish", ...) / ArtifactData / ArtifactComments 创建或更新产物，以便在右侧实时渲染。若遇到需要用户决定的关键业务场景、受众或设计方向分歧，且当前工具环境提供交互式提问工具（如 request_user_input），请优先调用该工具向用户发起结构化选择并等待回答，切勿只在正文中列举选项后自行假设并继续执行。'] : []),
        ...(goal?.status === 'active' ? [`当前会话的用户目标（Crux）\n${goal.objective}`] : []),
        `${contextText}${expandAssistantCitationsForProvider(message.text)}`,
      ].filter(Boolean).join('\n\n')
      const startedAt = new Date().toISOString()
      const payload = { ...JSON.parse(run.payload_json), status: 'running', providerThreadId: nativeThreadId, startedAt,
        ...(handoff && { handoff }) }
      const relation = compaction ? undefined : this.relations.childUpdate(threadId, 'running', runId, startedAt)
      const metadata = effectiveHandoffSource ? this.projections.readThreadPayload(threadId) : undefined
      const newThread = metadata && { ...JSON.parse(metadata.payload_json), providerInstanceId: selection.instanceId, modelSelection: selection, updatedAt: startedAt }
      const recoveryNotice = opened.recoveredFrom
        ? this.ingestor.buildRecoveryNotice(threadId, runId, nativeThreadId, startedAt)
        : undefined
      this.worker.markDispatched(row, attemptId, nativeThreadId, () => {
        this.projections.markRunRunning(runId, nativeThreadId, JSON.stringify(payload))
        if (effectiveHandoffSource) {
          this.projections.recordHandoffBinding({
            commandId,
            threadId,
            previousInstanceId: effectiveHandoffSource.instance_id,
            previousNativeThreadId: effectiveHandoffSource.native_thread_id,
            previousFingerprint: effectiveHandoffSource.configuration_fingerprint,
            nextInstanceId: selection.instanceId,
            nextNativeThreadId: nativeThreadId,
            createdAt: startedAt,
          })
          this.projections.updateThreadProvider(threadId, selection.instanceId, startedAt, JSON.stringify(newThread))
        }
        if (recoveryNotice) this.projections.insertTurnItemIfAbsent(recoveryNotice, startedAt)
        this.projections.upsertNativeBinding(threadId, selection.instanceId, nativeThreadId, expectedFingerprint)
        if (relation) relation.apply()
      }, undefined, [
        decodeEvent({ type: 'run.updated', id: randomUUID(), threadId, runId, occurredAt: startedAt, payload }),
        ...(newThread ? [decodeEvent({ type: 'thread.metadata-updated', id: randomUUID(), threadId, occurredAt: startedAt, payload: newThread })] : []),
        ...(recoveryNotice ? [decodeEvent({ type: 'turn-item.updated', id: randomUUID(), threadId, runId, occurredAt: startedAt, payload: recoveryNotice })] : []),
      ],
      [...(relation?.hostEvents ?? []), ...(handoff ? [lifecycleEvent(threadId, { kind: 'handoff', handoff }, runId, startedAt)] : [])])
      this.sessions.loadedThreads.set(threadId, { driver, nativeThreadId })
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
          ...(artifactMcp ? { artifactMcp } : {}),
          ...((restricted || managedExecution) && { assertAuthorized: () => this.assertCurrent(threadId, authority) }),
          ...(attachments.length ? { attachments } : {}),
          ...(registration.ordinaryTaskAccess === 'native-read-only' && authority.binding.kind === 'personal' && !compaction && !completion && !related && {
              delegation: (call: ConversationDelegationCall) => this.acceptDelegationCall(active, call),
            }),
      }
      const acceptedTurnId = await this.sessions.driverFence.run(sendFence, () => runBounded(
        compaction && driver.compactThread
          ? driver.compactThread({ nativeThreadId, cwd, model: selection.model, instructions: compaction.instructions, onEvent, context })
          : driver.startTurn(nativeThreadId, cwd, prompt, selection.model, onEvent, context),
        this.deadlines.turn, '等待原回合结束', this.shutdownController.signal,
      ))
      if (!this.worker.isOwned(row) || (turn && this.activeTurns.get(threadId) !== turn)) return
      if (!active.terminal || active.terminal.turnId !== acceptedTurnId || active.terminal.status === 'running') {
        throw new ConversationTurnOutcomeUnknownError(active.hasNativeTurnId ? active.controlTurnId ?? '' : '')
      }
      this.finishForeground(active)
    } catch (error) {
      if (!this.worker.isOwned(row) || (turn && this.activeTurns.get(threadId) !== turn)) return
      const attempt = this.worker.attempt(row.effect_id)
      if (turn?.terminal && turn.terminal.status !== 'running') {
        this.finishForeground(turn)
      } else if (this.closing) {
        // 对齐 t3code：应用退出时交由 shutdown() 的 reconcile('shutdown') 统一结算为 cancelled，不标 outcomeUnknown。
        return
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
      if (turn && this.activeTurns.get(threadId) === turn && this.worker.attempt(row.effect_id)?.phase === 'settled') {
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
    const loaded = this.sessions.loadedThreads.get(threadId)
    const closedForeground = Boolean(turn.terminal || attempt?.foreground_ended)
    if (!nativeTurnId || !turn.hasNativeTurnId || turn.controlTurnId !== nativeTurnId ||
      this.activeTurns.get(threadId) !== turn || attempt?.attempt_id !== attemptId ||
      attempt.phase !== 'dispatching' || attempt.native_turn_id !== nativeTurnId || attempt.stop_requested ||
      closedForeground && !(allowCompletedForeground && turn.terminal?.status === 'completed') ||
      this.commands.isPaused(threadId) || this.commands.isArchived(threadId) ||
      loaded?.driver !== driver || loaded.nativeThreadId !== nativeThreadId) {
      throw new DaemonError('E_DENIED', '原委派回合已停止、结束或换代。')
    }
    const binding = this.database.prepare(`SELECT instance_id, configuration_fingerprint FROM conversation_v2_native_bindings
      WHERE thread_id = ? AND native_thread_id = ?`)
      .get(threadId, nativeThreadId) as { instance_id: string; configuration_fingerprint: string | null } | undefined
    if (!binding || !this.bindingFingerprintMatches(binding.configuration_fingerprint, configurationFingerprint)) {
      throw new DaemonError('E_DENIED', '原委派的原生会话归属已变化。')
    }
    this.assertBindingFingerprint(binding.instance_id, configurationFingerprint)
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
    const binding = fingerprint ? this.database.prepare(`SELECT configuration_fingerprint FROM conversation_v2_native_bindings
      WHERE thread_id = ? AND instance_id = ? AND native_thread_id = ?`)
      .get(threadId, run.provider_instance_id, source.nativeThreadId) as { configuration_fingerprint: string | null } | undefined : undefined
    if (!fingerprint || !binding || !this.bindingFingerprintMatches(binding.configuration_fingerprint, fingerprint)) {
      throw new DaemonError('E_CONFLICT', '原委派的父会话绑定已变化。')
    }
    this.assertBindingFingerprint(run.provider_instance_id, fingerprint)
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

  private async prepareHandoffSource(
    threadId: string, authority: CommandAuthority, fence: () => void, targetDriver?: ConversationDriverSession,
  ) {
    const binding = this.projections.readHandoffSourceBinding(threadId)
    if (!binding?.previous_run_id) throw new ConversationTurnRejectedError('找不到接力来源的已结算原生回合。')
    const source = { ...binding, previous_run_id: binding.previous_run_id }
    const loaded = this.sessions.loadedThreads.get(threadId)
    if (!loaded) return source
    const key = JSON.stringify([binding.instance_id, pathKey(authority.cwd)])
    const owned = this.sessions.processes.get(key)
    const ready = this.sessions.ready.get(key)
    // 原绑定已属于旧配置/旧账号或进程已被替换时，无需操作旧进程，直接解绑内存句柄以便新线程接力。
    if (loaded.nativeThreadId !== binding.native_thread_id
      || owned?.driver !== loaded.driver
      || !ready
      || !this.bindingFingerprintMatches(binding.configuration_fingerprint, ready.bindingFingerprint)) {
      this.sessions.loadedThreads.delete(threadId)
      return source
    }
    const verify = (): void => {
      fence()
      const currentReady = this.sessions.ready.get(key)
      if (this.sessions.loadedThreads.get(threadId) !== loaded || owned?.driver !== loaded.driver ||
        this.sessions.processes.get(key) !== owned || loaded.nativeThreadId !== binding.native_thread_id ||
        !currentReady || !this.bindingFingerprintMatches(binding.configuration_fingerprint, currentReady.bindingFingerprint)
        || [...this.sessions.loadedThreads].some(([id, peer]) => id !== threadId && peer.driver === loaded.driver && peer.nativeThreadId === loaded.nativeThreadId)) {
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
        this.sessions.loadedThreads.delete(threadId)
      } catch (error) {
        if (!this.canFallbackFromResumeFailure(error)) throw error
        fence()
        this.sessions.loadedThreads.delete(threadId)
      } finally { unpin() }
    } else if (targetDriver && loaded.driver === targetDriver) {
      // 同引擎原地接力到新原生线程时，保留已准备的目标驱动进程，仅释放旧原生线程映射。
      if ([...this.activeTurns.values()].some(turn => turn.row.thread_id === threadId)) {
        throw new DaemonError('E_BUSY', '当前会话仍有运行中的回合，接力尚未发送。')
      }
      this.sessions.loadedThreads.delete(threadId)
    } else {
      if (!owned || !loaded.driver.canConfirmWindowsJobClose?.(loaded.nativeThreadId) || this.sessions.driverOpenings.has(key) ||
        this.sessions.preparingDrivers.has(loaded.driver) || this.sessions.closingDrivers.has(loaded.driver) ||
        [...this.activeTurns.values()].some(turn => turn.driver === loaded.driver) ||
        [...this.sessions.loadedThreads].some(([id, peer]) => id !== threadId && peer.driver === loaded.driver)) {
        throw new DaemonError('E_BUSY', '原引擎仍有共享会话或无法确认解绑，接力尚未发送。')
      }
      await this.closeOwned(key, owned)
    }
    return source
  }

  private observeTurn(turn: ActiveTurn, event: ConversationDriverTurnEvent | ConversationNativeSubagentEvent): void {
    this.ingestor.observeTurn(turn, event, {
      isClosing: () => this.closing,
      assertOwner: () => this.ports.assertOwner(),
      isCurrentActiveTurn: current => this.activeTurns.get(current.row.thread_id) === current,
      resolveCompletionDelivery: (current, _nativeTurnId) => current.completion
        ? buildDelegatedCompletionDeliveryUpdates(
          this.relations,
          this.completionRelations(current.row.thread_id, current.completion, current.runId, current.authority),
          current.runId,
        )
        : [],
      onForegroundReadyToFinish: current => this.finishForeground(current),
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
        const expiredRequests = this.runtimeRequests.expiringRequests(turn)
        const lateResults = this.disallowLateDeliveries(threadId, runId, evidence.observedAt)
        this.eventSink.commit({ hostEvents: [
          lifecycleEvent(threadId, { kind: 'run', phase: 'foreground-ended' }, runId, evidence.observedAt),
          lifecycleEvent(threadId, { kind: 'terminal-evidence', evidence }, runId, evidence.observedAt),
          ...expiredRequests.map(request => lifecycleEvent(threadId, { kind: 'request', request }, runId, evidence.observedAt)),
          ...lateResults.flatMap(change => change.hostEvents),
        ] }, () => {
          this.worker.recordNativeTerminal(row, evidence)
          this.projections.markDispatchAttemptForegroundEnded(row.effect_id)
          for (const request of expiredRequests) this.commands.writeRequest(threadId, request, null)
          for (const change of lateResults) change.apply()
          this.settleStopFromTerminal(turn, evidence.observedAt)
        })
        this.runtimeRequests.clearRequestBindings(turn)
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
    const owned = this.sessions.processes.get(slot)
    if (!owned || (turn && owned.driver !== turn.driver)) return
    try {
      await this.closeOwned(slot, owned)
      if (turn && this.activeTurns.get(turn.row.thread_id) === turn) this.activeTurns.delete(turn.row.thread_id)
    } catch {
      process.emitWarning('独立工作树的原进程尚未确认清理，保留写入登记。', { code: 'CRUX_DELEGATED_WORKTREE_CLEANUP' })
    }
  }

  private settleStopFromTerminal(turn: ActiveTurn, settled: string): void {
    const terminal = turn.terminal
    if (!terminal || terminal.status === 'running') return
    const stops = this.projections.findRunningInterruptEffects(turn.row.thread_id, turn.attemptId)
    for (const stop of stops) {
      if (this.worker.isOwned(stop)) this.worker.releaseClaim(stop, settled, 'succeeded', terminal.status === 'interrupted' || terminal.status === 'cancelled'
        ? '收到原回合停止证据。' : `原回合结束为 ${terminal.status}。`)
    }
  }

  private applyTurnEvidence(runId: string, evidence: ConversationRunEvidence): void {
    this.ingestor.applyTurnEvidence(runId, evidence)
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
    const authorityForRetry = turn?.authority ?? this.authorizations.get(row.command_id)
    const run = this.projections.readRunPayload(runId)
    const outputs = this.projections.readAssistantMessagesForRun(runId)
    const failureMeta = status === 'failed' && detail ? classifyConversationFailure({ message: detail }) : undefined
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
    const failureEvidence: ConversationRunEvidence | undefined = detail
      ? {
        failure: detail,
        ...(failureMeta ? { failureClass: failureMeta.failureClass } : {}),
        ...(failureMeta?.retryAfterMs !== undefined ? { retryAfterMs: failureMeta.retryAfterMs } : {}),
      }
      : undefined
    this.eventSink.commit({ commandId: row.command_id, events, hostEvents: [
      lifecycleEvent(threadId, { kind: 'run', phase: 'settled' }, runId, settled),
      ...(failureEvidence ? [this.ingestor.runEvidenceEvent(threadId, runId, failureEvidence, settled)] : []),
      ...(relation ? relation.hostEvents : []),
      ...lateResults.flatMap(change => change.hostEvents),
      ...(disposedCompletion?.hostEvents ?? []),
    ] }, () => {
      this.settleRun(threadId, runId, status, failureEvidence, settled)
      this.worker.releaseClaim(row, settled, outboxStatus, detail)
      if (relation) relation.apply()
      for (const change of lateResults) change.apply()
      disposedCompletion?.apply()
      if (turn) this.settleStopFromTerminal(turn, settled)
    })
    if (status === 'failed' && failureMeta?.failureClass === 'usage_limit' && failureMeta.retryAfterMs !== undefined) {
      this.usageLimitRecovery.scheduleOnFailure({
        threadId,
        runId,
        failureClass: failureMeta.failureClass,
        retryAfterMs: failureMeta.retryAfterMs,
        reason: detail,
        authority: authorityForRetry,
        isPersonal: authorityForRetry?.binding.kind === 'personal' && !this.relations.restrictedParent(threadId),
      })
    }
    if (turn && !turn.completion && status === 'completed' && this.delegatedCompletionSource(turn) &&
      this.relations.read(threadId).children.some(child => child.parentRunId === runId && child.completionWake)) {
      this.delegationContinuationParents.set(threadId, turn)
      this.offerDelegatedCompletionDelivery(threadId, runId)
    }
    if (delegated?.childRunId === runId) this.offerDelegatedCompletionDelivery(delegated.parentThreadId, delegated.parentRunId)
  }

  private dispatchUsageLimitAutoRetry(
    threadId: string,
    failedRunId: string,
    commandId: string,
    authority: CommandAuthority,
  ): void {
    this.ports.assertOwner()
    const failedRun = this.commands.run(threadId, failedRunId)
    if (!failedRun) throw new DaemonError('E_CONFLICT', '找不到限流失败的原回合。')
    const selection = decodeModelSelection(JSON.parse(failedRun.payload_json).modelSelection)
    const userMessage = this.commands.readUserMessage(failedRunId)
    const text = userMessage.text.trim() || '继续'
    const registration = this.requireDriver(selection.instanceId, this.isOrdinaryTask(authority))
    const retryCommand: Extract<ConversationThreadCommand, { type: 'message.dispatch' }> = {
      type: 'message.dispatch',
      commandId,
      threadId,
      messageId: `ulr-msg:${failedRunId}:${commandId}`,
      text,
      instanceId: selection.instanceId,
      model: selection.model,
      ...(selection.options?.length ? { options: [...selection.options] } : {}),
    }
    this.commands.appendMessage(retryCommand, authority, {
      driverKind: registration.driverKind,
      modelSelection: selection,
      configurationFingerprint: this.bindingFingerprint(registration),
    }, undefined, registration.promptAttachments, undefined, this.relations)
    this.authorizations.set(commandId, authority)
    this.scheduleNext(threadId, authority)
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
    const evidence: ConversationRunEvidence = {
      outcomeUnknown: true,
      outcomeUnknownAt: settled,
      failure: detail,
      failureClass: 'unknown_outcome',
      ...(nativeTurnId ? { nativeTurnId } : {}),
    }
    const threadId = row.thread_id
    const run = this.commands.run(threadId, runId)
    const relation = run && !compactionFromPayload(run.payload_json)
      ? this.relations.childUpdate(threadId, 'pending-reconciliation', runId, settled) : undefined
    const lateResults = this.disallowLateDeliveries(threadId, runId, settled)
    this.eventSink.commit({ commandId: row.command_id, hostEvents: [
      this.ingestor.runEvidenceEvent(threadId, runId, evidence, settled),
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
  private settleRun(threadId: string, runId: string, status: string, failureEvidence: ConversationRunEvidence | undefined, settled: string): void {
    this.ports.assertOwner()
    const row = this.projections.readRunPayload(runId)
    if (row) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>
      this.projections.settleRunProjection(threadId, runId, status, settled, {
        ...payload,
        status,
        completedAt: settled,
        outcomeUnknown: undefined,
        outcomeUnknownAt: undefined,
        failure: failureEvidence?.failure,
        failureClass: failureEvidence?.failureClass,
        retryAfterMs: failureEvidence?.retryAfterMs,
      })
      return
    }
    this.projections.touchThread(threadId, settled)
  }



  /**
   * 对齐 t3code Orchestrator.dispatchMessageDispatch 的 manualContinuationOfRunId 分支：
   * 校验目标中断回合仍可手动续接，并在原回合未送达引擎时复用原消息正文，
   * 已送达引擎时使用系统续接提示词继续，同时不产生重复的用户消息气泡。
   */
  private prepareManualContinuation(
    command: Extract<ConversationThreadCommand, { type: 'message.dispatch' }>,
  ): { readonly sourceRunId: string; readonly promptText: string; readonly notification: ReturnType<typeof manualContinuationNotification> } {
    const sourceRunId = command.manualContinuationOfRunId
    if (!sourceRunId) throw new DaemonError('E_INVALID_ARG', '缺少要继续的原回合编号。')
    if (command.deliveryIntent === 'steer' || command.attachmentIds?.length || command.references?.length) {
      throw new DaemonError('E_INVALID_ARG', '继续会话不支持插话、附件或历史引用。')
    }
    const { threadId } = command
    if (this.activeTurns.has(threadId) || this.database.prepare(`SELECT 1 FROM conversation_v2_effect_outbox
      WHERE thread_id = ? AND effect_type IN ('provider-turn.start', 'provider-turn.steer') AND status = 'running' LIMIT 1`).get(threadId)) {
      throw new DaemonError('E_BUSY', '当前会话仍在运行，暂不需要手动继续。')
    }
    const blockingRequest = this.commands.requests(threadId).some(
      request => request.status === 'pending' || request.status === 'responding' || request.status === 'pending-reconciliation',
    )
    if (blockingRequest) {
      throw new DaemonError('E_CONFLICT', '请先处理当前的待审批或待回答请求。')
    }
    const runRows = this.database.prepare(`SELECT run.run_id, run.ordinal, run.status, run.payload_json,
      attempt.stop_requested, attempt.provider_thread_id AS attempt_provider_thread_id, attempt.native_turn_id AS attempt_native_turn_id,
      EXISTS(
        SELECT 1 FROM conversation_v2_command_targets target
        JOIN conversation_v2_command_receipts receipt ON receipt.command_id = target.command_id
        WHERE target.run_id = run.run_id AND receipt.command_type = 'run.interrupt' AND receipt.status = 'accepted'
      ) AS stop_command_accepted
      FROM conversation_v2_projection_runs run
      LEFT JOIN conversation_v2_effect_outbox effect ON effect.thread_id = run.thread_id AND effect.effect_type = 'provider-turn.start'
        AND json_extract(effect.payload_json, '$.runId') = run.run_id
      LEFT JOIN conversation_v2_dispatch_attempts attempt ON attempt.effect_id = effect.effect_id
      WHERE run.thread_id = ? ORDER BY run.ordinal ASC`).all(threadId) as Array<{
      run_id: string
      ordinal: number
      status: string
      payload_json: string
      stop_requested: number | null
      attempt_provider_thread_id: string | null
      attempt_native_turn_id: string | null
      stop_command_accepted: number
    }>
    const parsed = runRows.map(row => {
      const raw = JSON.parse(row.payload_json) as Record<string, unknown>
      const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : null
      const engineAcceptedAt = typeof raw.engineAcceptedAt === 'string' ? raw.engineAcceptedAt : null
      const stopRequested = row.stop_requested === 1 || row.stop_command_accepted === 1
      const record: RestartContinuationRunRecord = {
        id: row.run_id,
        ordinal: row.ordinal,
        status: row.status,
        providerInstanceId: String(raw.providerInstanceId ?? ''),
        providerThreadId: typeof raw.providerThreadId === 'string' ? raw.providerThreadId : null,
        requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt : new Date().toISOString(),
        startedAt,
        completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
        ...(typeof raw.restartContinuationOfRunId === 'string' ? { restartContinuationOfRunId: raw.restartContinuationOfRunId } : {}),
        ...(Array.isArray(raw.restartCancelledBackgroundWork)
          ? { restartCancelledBackgroundWork: raw.restartCancelledBackgroundWork as readonly RestartCancelledWork[] } : {}),
        ...(raw.compaction ? { compaction: raw.compaction } : {}),
      }
      const withdrawnQueued = row.status === 'cancelled' && startedAt === null && engineAcceptedAt === null && !stopRequested
      return {
        row,
        raw,
        record,
        engineAcceptedAt,
        stopRequested,
        withdrawnQueued,
      }
    })
    const latestExecuted = parsed
      .filter(item => item.row.status !== 'queued' && !item.record.compaction && !item.withdrawnQueued)
      .at(-1)
    if (
      !latestExecuted
      || latestExecuted.record.id !== sourceRunId
      || latestExecuted.raw.outcomeUnknown === true
      || (latestExecuted.record.status !== 'interrupted' && latestExecuted.record.status !== 'cancelled')
    ) {
      throw new DaemonError('E_CONFLICT', '此会话已无法从该回合继续。')
    }
    const wasAcceptedByEngine = Boolean(
      latestExecuted.engineAcceptedAt
      || latestExecuted.record.providerThreadId
      || latestExecuted.row.attempt_provider_thread_id
      || latestExecuted.row.attempt_native_turn_id,
    )
    let promptText: string
    if (!wasAcceptedByEngine) {
      const original = this.commands.readUserMessage(sourceRunId)
      promptText = original.text.trim() ? original.text : buildManualContinuationText()
    } else {
      const cancelledWork = collectRestartCancelledWorkChain(latestExecuted.record, parsed.map(item => item.record))
      promptText = buildManualContinuationText(cancelledWork)
    }
    return {
      sourceRunId,
      promptText,
      notification: manualContinuationNotification(),
    }
  }

  /**
   * 对齐 t3code RestartContinuation.continueRestartedRun：
   * 当客户端带着有效工作区授权重连/打开会话时，消费持久化 outbox 中的 `provider-runtime.continue` 意图，
   * 校验全部安全护栏（开关/归档/用户手动停止/等待审批/连续崩溃上限/强原生绑定）后自动续接原会话。
   */
  activateRestartContinuations(
    authority: CommandAuthority,
    options?: { readonly threadId?: string; readonly artifactMcp?: OpenArtifactMcpGrant; readonly allowWithoutArtifactMcp?: boolean },
  ): void {
    this.ports.assertOwner()
    if (this.closing) return
    if (options?.threadId && options.artifactMcp) {
      this.threadArtifactMcps.set(options.threadId, options.artifactMcp)
    }
    const rows = (options?.threadId
      ? this.database.prepare(`SELECT effect.effect_id, effect.thread_id, effect.payload_json
          FROM conversation_v2_effect_outbox effect
          JOIN conversation_v2_projection_threads thread ON thread.thread_id = effect.thread_id
          WHERE effect.effect_type = ? AND effect.status = 'pending' AND effect.thread_id = ?
            AND thread.owner_id = ? AND thread.space_id = ? AND thread.project_id = ?`)
          .all(RESTART_CONTINUATION_EFFECT_TYPE, options.threadId, authority.ownerId, authority.spaceId, authority.projectId)
      : this.database.prepare(`SELECT effect.effect_id, effect.thread_id, effect.payload_json
          FROM conversation_v2_effect_outbox effect
          JOIN conversation_v2_projection_threads thread ON thread.thread_id = effect.thread_id
          WHERE effect.effect_type = ? AND effect.status = 'pending'
            AND thread.owner_id = ? AND thread.space_id = ? AND thread.project_id = ?`)
          .all(RESTART_CONTINUATION_EFFECT_TYPE, authority.ownerId, authority.spaceId, authority.projectId)
    ) as Array<{ effect_id: string; thread_id: string; payload_json: string }>
    if (rows.length === 0) return

    const finishEffect = (effectId: string, status: 'succeeded' | 'cancelled' | 'failed', detail?: string): void => {
      const at = new Date().toISOString()
      this.database.prepare(`UPDATE conversation_v2_effect_outbox
        SET status = ?, last_error = ?, updated_at = ?, completed_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE effect_id = ?`).run(status, detail ?? null, at, at, effectId)
    }

    for (const row of rows) {
      if (this.closing) return
      const threadId = row.thread_id
      if (!this.commands.hasThread(threadId, authority)) continue
      if (this.activeTurns.has(threadId)) continue
      const payload = parseRestartContinuationPayload(row.payload_json)
      if (!payload) {
        finishEffect(row.effect_id, 'cancelled', '重启续接意图载荷无效。')
        continue
      }
      if (!this.shouldContinueAfterRestart()) {
        finishEffect(row.effect_id, 'cancelled', '已关闭重启后自动继续对话。')
        continue
      }
      if (payload.artifactEnabled && !this.threadArtifactMcps.has(threadId) && !options?.allowWithoutArtifactMcp) {
        // 等待打开该会话并恢复 Open Artifact MCP 绑定后再续接，避免丢失产物工具能力。
        continue
      }
      const claimed = this.database.prepare(`UPDATE conversation_v2_effect_outbox
        SET status = 'running', attempt_count = attempt_count + 1, updated_at = ?
        WHERE effect_id = ? AND status = 'pending'`).run(new Date().toISOString(), row.effect_id)
      if (claimed.changes !== 1) continue
      try {
        const result = this.tryContinueRestartedThread(threadId, payload, authority)
        if (result.status === 'dispatched') {
          finishEffect(row.effect_id, 'succeeded')
          this.authorizations.set(result.commandId, authority)
          this.scheduleNext(threadId, authority)
        } else if (result.status === 'already-dispatched') {
          finishEffect(row.effect_id, 'succeeded')
        } else {
          finishEffect(row.effect_id, 'cancelled', result.reason)
        }
      } catch (error) {
        finishEffect(row.effect_id, 'failed', failureMessage(error))
      }
    }
  }

  private tryContinueRestartedThread(
    threadId: string,
    payload: { readonly sourceRunId: string; readonly processLossCount?: number; readonly cause?: 'server_restart' | 'provider_exit' },
    authority: CommandAuthority,
  ): { readonly status: 'dispatched'; readonly commandId: string } | { readonly status: 'already-dispatched' } | { readonly status: 'skipped'; readonly reason: string } {
    const thread = this.database.prepare(`SELECT default_provider, archived_at, deleted_at
      FROM conversation_v2_projection_threads WHERE thread_id = ?`)
      .get(threadId) as { default_provider: string; archived_at: string | null; deleted_at: string | null } | undefined
    if (!thread || thread.archived_at !== null || thread.deleted_at !== null) {
      return { status: 'skipped', reason: '会话已归档或已删除。' }
    }
    const messageId = restartContinuationMessageId(payload.sourceRunId)
    if (this.database.prepare('SELECT 1 FROM conversation_v2_projection_messages WHERE message_id = ?').get(messageId)) {
      return { status: 'already-dispatched' }
    }
    const commandId = restartContinuationCommandId(payload.sourceRunId)
    if (this.eventSink.readReceipt(commandId)) {
      return { status: 'already-dispatched' }
    }
    const runRows = this.database.prepare(`SELECT run_id, ordinal, status, provider_instance_id, provider_thread_id, requested_at, completed_at, payload_json
      FROM conversation_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal ASC`)
      .all(threadId) as Array<{
      run_id: string
      ordinal: number
      status: string
      provider_instance_id: string
      provider_thread_id: string | null
      requested_at: string
      completed_at: string | null
      payload_json: string
    }>
    const records: RestartContinuationRunRecord[] = runRows.map(entry => {
      const raw = JSON.parse(entry.payload_json) as {
        startedAt?: string | null
        restartContinuationOfRunId?: string
        restartCancelledBackgroundWork?: readonly RestartCancelledWork[]
        compaction?: unknown
      }
      return {
        id: entry.run_id,
        ordinal: entry.ordinal,
        status: entry.status,
        providerInstanceId: entry.provider_instance_id,
        providerThreadId: entry.provider_thread_id,
        requestedAt: entry.requested_at,
        startedAt: raw.startedAt ?? null,
        completedAt: entry.completed_at,
        ...(raw.restartContinuationOfRunId ? { restartContinuationOfRunId: raw.restartContinuationOfRunId } : {}),
        ...(raw.restartCancelledBackgroundWork ? { restartCancelledBackgroundWork: raw.restartCancelledBackgroundWork } : {}),
        ...(raw.compaction ? { compaction: raw.compaction } : {}),
      }
    })
    const sourceRow = runRows.find(entry => entry.run_id === payload.sourceRunId)
    const source = records.find(entry => entry.id === payload.sourceRunId)
    if (!sourceRow || !source || source.status !== 'cancelled' || source.compaction) {
      return { status: 'skipped', reason: '来源回合不再符合自动续接条件。' }
    }
    if (source.providerInstanceId !== thread.default_provider) {
      return { status: 'skipped', reason: '会话已切换默认引擎实例。' }
    }
    if (hasLaterExecutedRun(records, source)) {
      return { status: 'skipped', reason: '该会话已有更新的回合。' }
    }
    if (isContinuationBudgetExhausted(records, source, payload.processLossCount)) {
      process.emitWarning(`Not continuing thread ${threadId} after repeated restart interruptions.`, { code: 'CRUX_CONVERSATION_RECOVERY' })
      return { status: 'skipped', reason: '连续重启续接已达上限（5 分钟内最多 3 次）。' }
    }
    const stopSubmitted = this.database.prepare(`SELECT 1 FROM conversation_v2_effect_outbox
      WHERE thread_id = ? AND effect_type = 'provider-turn.interrupt'
        AND json_extract(payload_json, '$.runId') = ? LIMIT 1`).get(threadId, source.id)
    const sourceAttemptStopped = this.database.prepare(`SELECT 1 FROM conversation_v2_effect_outbox effect
      JOIN conversation_v2_dispatch_attempts attempt ON attempt.effect_id = effect.effect_id
      WHERE effect.thread_id = ? AND effect.effect_type = 'provider-turn.start'
        AND json_extract(effect.payload_json, '$.runId') = ? AND attempt.stop_requested = 1 LIMIT 1`).get(threadId, source.id)
    if (stopSubmitted || sourceAttemptStopped) {
      return { status: 'skipped', reason: '用户已主动停止该回合。' }
    }
    if (hasBlockingRuntimeRequestForRun(this.commands.requests(threadId), source.id)) {
      return { status: 'skipped', reason: '来源回合存在待处理的审批或提问。' }
    }
    const binding = this.database.prepare(`SELECT instance_id, native_thread_id, configuration_fingerprint
      FROM conversation_v2_native_bindings WHERE thread_id = ?`)
      .get(threadId) as { instance_id: string; native_thread_id: string; configuration_fingerprint: string } | undefined
    if (!binding || binding.instance_id !== source.providerInstanceId || !binding.native_thread_id) {
      return { status: 'skipped', reason: '缺少可续接的原生会话绑定。' }
    }
    const restricted = this.isOrdinaryTask(authority) || Boolean(this.relations.restrictedParent(threadId))
    const registration = this.driverRegistry.get(source.providerInstanceId)
    if (!registration || (restricted && !registration.ordinaryTaskAccess)) {
      return { status: 'skipped', reason: '原引擎当前不可用或已禁用。' }
    }
    const configurationFingerprint = this.bindingFingerprint(registration)
    if (binding.configuration_fingerprint && !this.bindingFingerprintMatches(binding.configuration_fingerprint, configurationFingerprint)) {
      return { status: 'skipped', reason: '原引擎配置指纹已变化。' }
    }
    const modelSelection = decodeModelSelection(JSON.parse(sourceRow.payload_json).modelSelection)
    if (modelSelection.options?.length && !registration.turnModelOptions) {
      return { status: 'skipped', reason: '原引擎不支持恢复该模型参数。' }
    }
    const cancelledWork = collectRestartCancelledWorkChain(source, records)
    const text = buildRestartContinuationText(cancelledWork, payload.cause)
    const notification = restartContinuationNotification(text, payload.cause)
    this.commands.appendRestartContinuation({
      commandId,
      threadId,
      messageId,
      sourceRunId: source.id,
      text,
      notification,
      selection: { driverKind: registration.driverKind, modelSelection, configurationFingerprint },
    }, authority)
    return { status: 'dispatched', commandId }
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
    const hasQueuedRuns = page.runs.some(run => run.status === 'queued' && !run.outcomeUnknown)
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
      queuePaused: !!unrecorded || (hasQueuedRuns && this.commands.isPaused(threadId)),
      runtimeRequests: this.commands.requests(threadId),
      relations: this.relations.read(threadId),
      goal: this.continuation.readGoal(threadId),
      usageLimitRecovery: this.usageLimitRecovery.readScheduled(threadId),
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
      WHERE thread_id = ? AND run_id IN (${runIds.map(() => '?').join(',')}) AND type IN ('dynamic_tool', 'proposed_plan', 'todo_list', 'file_change', 'reasoning', 'system_notice')
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
    return this.dispatches.size + this.sessions.foregroundOpeningCount()
  }

  ownsWorkspace(within: (path: string) => boolean): boolean {
    return [...this.dispatches.values()].some(dispatch => within(dispatch.root))
      || this.sessions.ownsWorkspace(within)
  }

  /**
   * Closes every owned app-server. An unconfirmed exit is reported upward and the driver stays
   * recorded, so the owner never claims a clean shutdown while a process may still be alive.
   */
  async shutdown(): Promise<void> {
    this.closing = true
    this.usageLimitRecovery.shutdown()
    for (const timer of this.idleCompactions.values()) clearTimeout(timer)
    this.idleCompactions.clear()
    try {
      this.worker.prepareForShutdown({
        continueAfterRestart: this.shouldContinueAfterRestart(),
        activeArtifactThreads: new Set(this.threadArtifactMcps.keys()),
      })
    } catch {
      process.emitWarning('Unable to prepare restart continuations before shutdown.', { code: 'CRUX_CONVERSATION_RECOVERY' })
    }
    this.shutdownController.abort(new DaemonError('E_UNAVAILABLE', '会话内核正在关闭。'))
    for (const turn of this.activeTurns.values()) {
      turn.signalControlTurn?.()
      if (turn.backgroundTimeout) clearTimeout(turn.backgroundTimeout)
    }
    const closes = await this.sessions.closeAllOwned()
    const unconfirmed = closes.filter(result => result.status === 'rejected')
    await awaitDeadline(Promise.allSettled([
      ...this.sessions.openingPromises(),
      ...[...this.dispatches.values()].map(dispatch => dispatch.work),
    ]), this.deadlines.close, '等待原工作器退出').finally(() => {
      this.worker.reconcile('shutdown', { continueAfterRestart: this.shouldContinueAfterRestart() })
      this.relations.reconcileAfterRecovery(this.eventSink)
    })
    if (unconfirmed.length > 0) throw new Error(`${unconfirmed.length} conversation engine process(es) did not confirm exit; their ownership is retained.`)
  }
}
