import type { DatabaseSync } from 'node:sqlite'
import * as Schema from 'effect/Schema'
import { DaemonError } from '../../../daemon/errors'
import { ModelSelection } from '../../../../shared/conversation/contracts'
import {
  conversationThreadCommandSchema,
  type ConversationRuntimeRequest,
  type ConversationThreadCommand,
  type ConversationThreadCommandState,
} from '../../../../shared/conversation/command-runtime'
import type { ConversationAuthority } from '../../../../shared/conversation/desktop'
import type { OpenArtifactMcpGrant } from '../../../../shared/open-artifact'
import type { ConversationThreadRelation } from '../../../../shared/conversation/thread-relations'
import type { ConversationAttachmentStore } from '../attachments'
import { prepareConversationAttachmentClaim } from '../attachments/claims'
import { ANSWER_ATTACHMENT_MAX_BYTES, assertPromptAttachments, TEXT_ATTACHMENTS } from '../providers/core/attachment-input'
import type { ConversationDriverRegistration, ConversationDriverRegistry, ConversationRuntimeResponse } from '../providers/registry'
import type { ConversationProjectionStore } from '../persistence/ProjectionStore'
import type { ConversationSearchIndex } from '../persistence/SearchIndex'
import type { CheckpointService } from './CheckpointService'
import type { ContextHandoff } from './ContextHandoff'
import { completionIntent } from './DelegatedCompletion'
import { runBounded } from './EffectWorker'
import type { ConversationEventSink } from './EventSink'
import type { IdleCompactionService } from './IdleCompactionService'
import type { ProviderSessionManager } from './ProviderSessionManager'
import type { ProviderTurnControlService } from './ProviderTurnControlService'
import type { RuntimeRequestService } from './RuntimeRequestService'
import { lifecycleEvent, type ThreadCommands, type ThreadEffectRow } from './ThreadCommands'
import { compactionFromPayload, type ThreadContinuation } from './ThreadContinuation'
import type { ThreadRelations } from './ThreadRelations'
import type { ThreadTitleService } from './ThreadTitleService'
import type { UsageLimitRecoveryWorker } from './UsageLimitRecoveryWorker'

const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection)

export interface RouterActiveTurnRef {
  readonly runId: string
  readonly attemptId: string
  readonly configurationFingerprint: string
  readonly controlTurnId?: string
  readonly hasNativeTurnId?: boolean
}

export interface CommandRouterPorts<TTurn extends RouterActiveTurnRef, TAuthority extends ConversationAuthority> {
  readonly database: DatabaseSync
  readonly projections: ConversationProjectionStore
  readonly eventSink: ConversationEventSink
  readonly commands: ThreadCommands
  readonly relations: ThreadRelations
  readonly continuation: ThreadContinuation
  readonly contextHandoff: ContextHandoff
  readonly attachments: ConversationAttachmentStore
  readonly sessions: ProviderSessionManager
  readonly driverRegistry: ConversationDriverRegistry
  readonly runtimeRequests: RuntimeRequestService<any>
  readonly turnControl: ProviderTurnControlService<any, TAuthority>
  readonly usageLimitRecovery: UsageLimitRecoveryWorker<TAuthority>
  readonly idleCompaction: IdleCompactionService<TAuthority>
  readonly checkpoints: CheckpointService
  readonly searchIndex: ConversationSearchIndex
  readonly titleService: ThreadTitleService
  readonly deadlines: { readonly control: number }
  readonly shutdownSignal: AbortSignal
  readonly activeTurns: Map<string, TTurn>
  readonly authorizations: Map<string, TAuthority>
  readonly threadArtifactMcps: Map<string, OpenArtifactMcpGrant>
  assertCurrent(threadId: string, authority: TAuthority, includeDeleted?: boolean): Promise<void>
  isOrdinaryTask(authority: Pick<ConversationAuthority, 'binding'>): boolean
  requireDriver(instanceId: string, ordinaryTask: boolean): ConversationDriverRegistration
  bindingFingerprint(registration: ConversationDriverRegistration): string
  bindingFingerprintMatches(stored: string | null | undefined, expected: string): boolean
  withUnsettledTerminal(state: ConversationThreadCommandState): ConversationThreadCommandState
  deleteThread(command: Extract<ConversationThreadCommand, { type: 'thread.delete' }>, authority: TAuthority): Promise<ConversationThreadCommandState>
  acceptCompaction(command: Extract<ConversationThreadCommand, { type: 'thread.compact' }>, authority: TAuthority, trigger: 'manual' | 'idle'): ConversationThreadCommandState
  acceptStop(command: Extract<ConversationThreadCommand, { type: 'run.interrupt' }>, authority: TAuthority, active?: TTurn): ConversationThreadCommandState
  requireControlTurn(active: TTurn | undefined, method: 'steerTurn' | 'respondToRuntimeRequest', expectedRunId?: string): TTurn
  prepareManualContinuation(command: Extract<ConversationThreadCommand, { type: 'message.dispatch' }>): Parameters<ThreadCommands['appendMessage']>[8]
  resolvePendingAsyncUserInputs(threadId: string): void
  respondToAsyncUserInput(command: Extract<ConversationThreadCommand, { type: 'runtime-request.respond' }>, authority: TAuthority, request: ConversationRuntimeRequest): ConversationThreadCommandState
  requestResponse(request: ConversationRuntimeRequest, response: Extract<ConversationThreadCommand, { type: 'runtime-request.respond' }>): ConversationRuntimeResponse
  answerAttachmentQuestion(request: ConversationRuntimeRequest, answers: Readonly<Record<string, unknown>>, requested?: string): string
  assertDelegatedCompletionCurrent(threadId: string, intent: NonNullable<ReturnType<typeof completionIntent>>, authority: TAuthority, runId: string, allowQueuedStart?: boolean): void
  settleDelegatedWork(relation: ConversationThreadRelation, status: 'completed' | 'failed' | 'cancelled', occurredAt: string, hostEvents: readonly any[]): any
  disposeDelegatedCompletion(effect: ThreadEffectRow, occurredAt: string): any
  offerDelegatedCompletionDelivery(parentThreadId: string, parentRunId?: string): void
  scheduleControl(command: ConversationThreadCommand, authority: TAuthority, turn: TTurn, steerRunId?: string): void
  scheduleNext(threadId: string, authority: TAuthority): void
}

/**
 * 统一会话命令路由器（M3 CommandRouter）：
 * 承接 Schema 解析、权限复核、幂等回执、委派/归档边界守卫，并将全周期命令路由到对应的编排子服务。
 */
export class CommandRouter<TTurn extends RouterActiveTurnRef, TAuthority extends ConversationAuthority> {
  constructor(private readonly p: CommandRouterPorts<TTurn, TAuthority>) {}

  async dispatch(
    input: ConversationThreadCommand,
    authority: TAuthority,
    artifactMcp?: OpenArtifactMcpGrant,
  ): Promise<ConversationThreadCommandState> {
    const command = conversationThreadCommandSchema.parse(input)
    if (artifactMcp) this.p.threadArtifactMcps.set(command.threadId, artifactMcp)
    await this.p.assertCurrent(command.threadId, authority, command.type === 'thread.delete')
    if (command.type === 'thread.delete') return this.p.deleteThread(command, authority)
    const prior = this.p.commands.replay(command, authority)
    if (prior) return this.p.withUnsettledTerminal(prior)

    const delegated = this.p.relations.delegatedParent(command.threadId)
    const restrictedRelation = delegated ?? this.p.relations.restrictedParent(command.threadId)
    if (delegated && !['thread.rename', 'thread.pin', 'thread.archive', 'run.interrupt', 'thread.stop', 'runtime-request.respond',
      'queue.resume', 'queued-run.start', 'queued-run.cancel'].includes(command.type)) {
      throw new DaemonError('E_DENIED', '委派子会话只接受原运行的控制和答复。')
    }
    if (!command.type.startsWith('thread.') && this.p.commands.isArchived(command.threadId)) {
      throw new DaemonError('E_CONFLICT', '请先恢复已归档的会话。')
    }
    const active = this.p.activeTurns.get(command.threadId)

    switch (command.type) {
      case 'thread.rename': {
        const previous = this.p.relations.read(command.threadId).parent
        const change = previous && this.p.relations.update({ ...previous, title: command.title, updatedAt: new Date().toISOString() })
        const receipt = this.p.commands.changeThread(command, authority, undefined, change?.hostEvents, change?.apply)
        this.p.searchIndex.updateThreadTitle(command.threadId, command.title)
        return receipt
      }
      case 'thread.pin':
      case 'thread.archive':
        if (command.type === 'thread.archive' && command.archived) {
          this.p.usageLimitRecovery.cancel(command.threadId, '会话已归档，取消自动重试。')
          this.p.idleCompaction.cancel(command.threadId)
        }
        return this.p.commands.changeThread(command, authority)
      case 'thread.title.regenerate': {
        if (authority.binding.kind !== 'personal' || restrictedRelation || this.p.commands.isArchived(command.threadId)) {
          throw new DaemonError('E_DENIED', '仅可在未归档的个人会话中重新生成标题。')
        }
        return this.p.titleService.regenerateTitle(command, authority)
      }
      case 'thread.visit':
        return this.p.commands.visitThread(command, authority, this.p.eventSink.latestSequence(command.threadId))
      case 'thread.mark-unread':
        return this.p.commands.markThreadUnread(command, authority)
      case 'thread.tag.set': {
        if (restrictedRelation || this.p.commands.isArchived(command.threadId)) {
          throw new DaemonError('E_DENIED', '当前会话不支持更新标签。')
        }
        return this.p.commands.setThreadTags(command, authority)
      }
      case 'thread.snooze': {
        if (authority.binding.kind !== 'personal' || restrictedRelation || this.p.commands.isArchived(command.threadId)) {
          throw new DaemonError('E_DENIED', '仅可在未归档的个人会话中设置置后提醒。')
        }
        return this.p.commands.snoozeThread(command, authority)
      }
      case 'thread.fork': {
        if (this.p.commands.isArchived(command.threadId) || authority.binding.kind === 'planning' ||
          authority.binding.kind === 'task' && !this.p.isOrdinaryTask(authority)) {
          throw new DaemonError('E_DENIED', '此会话当前不能派生其他会话。')
        }
        if (restrictedRelation && !command.readOnly) throw new DaemonError('E_DENIED', '只读会话只能派生只读分支。')
        const plan = this.p.relations.planFork(command, authority)
        if (command.readOnly || command.selection) {
          const registration = this.p.requireDriver(plan.relation.instanceId, this.p.isOrdinaryTask(authority) || !!command.readOnly)
          if (command.readOnly && registration.ordinaryTaskAccess !== 'native-read-only') {
            throw new DaemonError('E_UNAVAILABLE', '所选引擎没有可核实的原生只读能力。')
          }
          if (command.selection?.options?.length && !registration.turnModelOptions) {
            throw new DaemonError('E_UNAVAILABLE', '所选引擎不支持此模型参数。')
          }
          if (command.selection) decodeModelSelection(command.selection)
        }
        return this.p.commands.commit(command, authority, plan)
      }
      case 'thread.goal.set':
      case 'thread.goal.pause':
      case 'thread.goal.resume':
      case 'thread.goal.clear':
        if (this.p.commands.isArchived(command.threadId)) throw new DaemonError('E_CONFLICT', '请先恢复已归档的会话。')
        return this.p.commands.commit(command, authority, this.p.continuation.planGoal(command))
      case 'thread.compact':
        return this.p.acceptCompaction(command, authority, 'manual')
      case 'thread.handoff': {
        this.p.usageLimitRecovery.cancel(command.threadId, '用户已改由上下文接力继续。')
        this.p.idleCompaction.cancel(command.threadId)
        const hasHeldQueue = this.p.commands.isPaused(command.threadId) && this.p.projections.hasQueuedRuns(command.threadId)
        if (authority.binding.kind !== 'personal' || restrictedRelation || this.p.commands.isArchived(command.threadId) ||
          this.p.activeTurns.has(command.threadId) || hasHeldQueue) {
          throw new DaemonError('E_BUSY', '仅可在已结算且无暂停队列的个人会话中交接。')
        }
        this.p.continuation.latestForHandoff(command.threadId)
        const registration = this.p.requireDriver(command.instanceId, this.p.isOrdinaryTask(authority))
        if (command.options?.length && !registration.turnModelOptions) throw new DaemonError('E_UNAVAILABLE', '所选引擎不支持此模型参数。')
        const modelSelection = decodeModelSelection({ instanceId: registration.instanceId, model: command.model, options: command.options })
        const portableHistory = (command.references ?? [{ threadId: command.threadId }])
          .map(reference => this.p.contextHandoff.capture(reference, authority, undefined, false, true))
        const result = this.p.commands.appendMessage(command, authority, {
          driverKind: registration.driverKind, modelSelection, configurationFingerprint: this.p.bindingFingerprint(registration),
        }, undefined, undefined, portableHistory, this.p.relations)
        this.p.authorizations.set(command.commandId, authority)
        this.p.scheduleNext(command.threadId, authority)
        return result
      }
      case 'provider.switch':
        return this.handleProviderSwitch(command, authority, active, Boolean(restrictedRelation))
      case 'thread.merge_back':
        return this.handleMergeBack(command, authority, active, Boolean(restrictedRelation))
      case 'message.dispatch':
        return this.handleMessageDispatch(command, authority, active)
      case 'queue.resume':
      case 'queued-run.start':
      case 'queued-run.edit':
      case 'queued-run.reorder':
      case 'queued-run.cancel':
        return this.handleQueueCommand(command, authority, delegated)
      case 'run.interrupt':
        this.p.usageLimitRecovery.cancel(command.threadId, '用户已请求停止当前回合。')
        this.p.idleCompaction.cancel(command.threadId)
        return this.p.acceptStop(command, authority, active)
      case 'thread.stop':
        this.p.idleCompaction.cancel(command.threadId)
        return this.p.turnControl.forceStopThread(command, authority)
      case 'subagent.stop':
        return this.p.turnControl.stopSubagent(command, authority)
      case 'usage-limit-recovery.cancel': {
        this.p.usageLimitRecovery.cancel(command.threadId, '用户已取消限流自动重试。')
        return this.p.commands.commit(command, authority, {
          target: { detail: '已取消限流自动重试。' },
          hostEvents: [lifecycleEvent(command.threadId, { kind: 'usage-limit-recovery', recovery: null })],
          apply: () => {},
        })
      }
      case 'usage-limit-recovery.retry-now': {
        const { runId, commandId: retryCommandId } = this.p.usageLimitRecovery.retryNow(command.threadId, authority)
        return this.p.commands.commit(command, authority, {
          target: { run_id: runId, detail: `已触发限流重试（${retryCommandId}）。` },
          hostEvents: [lifecycleEvent(command.threadId, { kind: 'usage-limit-recovery', recovery: null }, runId)],
          apply: () => {},
        })
      }
      case 'thread.runtime-mode.set':
      case 'thread.interaction-mode.set': {
        if (restrictedRelation || authority.binding.kind !== 'personal') {
          throw new DaemonError('E_DENIED', '任务或受限子会话不支持切换运行与交互模式。')
        }
        if (command.type === 'thread.runtime-mode.set' && command.runtimeMode === 'approval-required') {
          this.p.runtimeRequests.clearSessionApprovals(command.threadId)
        }
        return this.p.commands.setThreadMode(command, authority)
      }
      case 'checkpoint.rollback':
      case 'message.edit-and-rerun':
        return this.handleRollbackOrEditRerun(command, authority, active, Boolean(restrictedRelation))
      case 'queued-message.promote-to-steer':
        return this.handlePromoteToSteer(command, authority, active)
      case 'runtime-request.respond':
        return this.handleRuntimeRequestRespond(command, authority, active, Boolean(restrictedRelation))
    }
  }

  private handleProviderSwitch(
    command: Extract<ConversationThreadCommand, { type: 'provider.switch' }>,
    authority: TAuthority,
    active: TTurn | undefined,
    restricted: boolean,
  ): ConversationThreadCommandState {
    if (authority.binding.kind !== 'personal' || restricted || this.p.commands.isArchived(command.threadId)) {
      throw new DaemonError('E_DENIED', '仅可在未归档的个人会话中切换模型或引擎。')
    }
    const hasPendingWork = Boolean(active || this.p.activeTurns.has(command.threadId)
      || this.p.projections.hasQueuedRuns(command.threadId)
      || this.p.database.prepare(`SELECT 1 FROM conversation_v2_effect_outbox
        WHERE thread_id = ? AND status IN ('pending', 'running') AND effect_type <> 'provider-runtime.continue'
        UNION ALL SELECT 1 FROM conversation_v2_projection_runtime_requests
        WHERE thread_id = ? AND status IN ('pending', 'responding', 'pending-reconciliation') LIMIT 1`)
        .get(command.threadId, command.threadId))
    if (hasPendingWork) {
      throw new DaemonError('E_BUSY', '当前会话有运行中、排队中或待处理请求，无法切换模型或引擎。')
    }
    const registration = this.p.requireDriver(command.instanceId, false)
    if (command.options?.length && !registration.turnModelOptions) {
      throw new DaemonError('E_UNAVAILABLE', '所选引擎不支持此模型参数。')
    }
    const modelSelection = decodeModelSelection({ instanceId: registration.instanceId, model: command.model, options: command.options })
    this.p.usageLimitRecovery.cancel(command.threadId, '用户已手动切换引擎或模型。')
    this.p.idleCompaction.cancel(command.threadId)
    this.p.runtimeRequests.clearSessionApprovals(command.threadId)
    const existingBinding = this.p.projections.readNativeBindingOrRunFallback(command.threadId)
    const targetFingerprint = this.p.bindingFingerprint(registration)
    const currentThreadRow = this.p.database.prepare('SELECT default_provider FROM conversation_v2_projection_threads WHERE thread_id = ?')
      .get(command.threadId) as { default_provider: string } | undefined
    const clearNativeBinding = Boolean(
      (existingBinding && (existingBinding.instance_id !== registration.instanceId
        || (existingBinding.configuration_fingerprint && !this.p.bindingFingerprintMatches(existingBinding.configuration_fingerprint, targetFingerprint))))
      || (currentThreadRow && currentThreadRow.default_provider !== registration.instanceId),
    )
    const receipt = this.p.commands.switchProvider(
      command,
      authority,
      { modelSelection, clearNativeBinding },
      occurredAt => {
        if (clearNativeBinding) this.p.projections.clearNativeBindingForSwitch(command.threadId, occurredAt)
      },
    )
    if (clearNativeBinding) this.p.sessions.loadedThreads.delete(command.threadId)
    return receipt
  }

  private handleMergeBack(
    command: Extract<ConversationThreadCommand, { type: 'thread.merge_back' }>,
    authority: TAuthority,
    active: TTurn | undefined,
    restricted: boolean,
  ): ConversationThreadCommandState {
    if (authority.binding.kind !== 'personal' || restricted || this.p.commands.isArchived(command.threadId)) {
      throw new DaemonError('E_DENIED', '仅可在未归档的个人会话中回并子会话结论。')
    }
    if (active || this.p.activeTurns.has(command.threadId)) {
      throw new DaemonError('E_BUSY', '父会话正在执行回合，请等待完成后再回并子会话结论。')
    }
    this.p.idleCompaction.cancel(command.threadId)
    const mergePlan = this.p.relations.planMergeBack(command, authority)
    const receipt = this.p.commands.commit(command, authority, mergePlan)
    const mergedMsg = mergePlan.events[0]?.payload as { id?: string; role?: string; text?: string } | undefined
    const threadRow = this.p.projections.readThreadPayload(command.threadId)
    const threadTitle = threadRow ? String((JSON.parse(threadRow.payload_json) as { title?: string }).title ?? '') : ''
    if (mergedMsg?.id && mergedMsg.text) {
      this.p.searchIndex.upsertMessage({
        threadId: command.threadId,
        messageId: mergedMsg.id,
        role: mergedMsg.role ?? 'assistant',
        title: threadTitle,
        body: mergedMsg.text,
      })
    }
    return receipt
  }

  private handleMessageDispatch(
    command: Extract<ConversationThreadCommand, { type: 'message.dispatch' }>,
    authority: TAuthority,
    active: TTurn | undefined,
  ): ConversationThreadCommandState {
    this.p.usageLimitRecovery.cancel(command.threadId, '用户已手动发送新消息。')
    this.p.idleCompaction.cancel(command.threadId)
    const registration = this.p.requireDriver(command.instanceId, this.p.isOrdinaryTask(authority))
    if (command.options?.length && (!registration.turnModelOptions || command.deliveryIntent === 'steer')) {
      throw new DaemonError('E_UNAVAILABLE', '此操作无法更改回合模型参数。')
    }
    const selection = {
      driverKind: registration.driverKind,
      modelSelection: decodeModelSelection({ instanceId: registration.instanceId, model: command.model, options: command.options }),
      configurationFingerprint: this.p.bindingFingerprint(registration),
    }
    if (command.deliveryIntent === 'steer') {
      if (command.references?.length) throw new DaemonError('E_UNAVAILABLE', '带历史引用的消息请正常发送或加入队列。')
      if (command.attachmentIds?.length) throw new DaemonError('E_UNAVAILABLE', '当前插话入口只支持文字，请把附件加入队列。')
      const turn = this.p.requireControlTurn(active, 'steerTurn')
      if (!this.p.bindingFingerprintMatches(turn.configurationFingerprint, selection.configurationFingerprint)) {
        throw new DaemonError('E_CONFLICT', '原回合使用的引擎配置已变化。')
      }
      const state = this.p.commands.appendMessage(command, authority, selection, {
        targetRunId: turn.runId, targetAttemptId: turn.attemptId,
      })
      this.p.resolvePendingAsyncUserInputs(command.threadId)
      this.p.scheduleControl(command, authority, turn, state.runId)
      return state
    }
    if (command.manualContinuationOfRunId) {
      const manualContinuation = this.p.prepareManualContinuation(command)
      const receipt = this.p.commands.appendMessage(
        command, authority, selection, undefined, undefined, undefined, this.p.relations, undefined, manualContinuation,
      )
      this.p.resolvePendingAsyncUserInputs(command.threadId)
      this.p.authorizations.set(command.commandId, authority)
      this.p.scheduleNext(command.threadId, authority)
      return receipt
    }
    const portableHistory = command.references?.map(reference => this.p.contextHandoff.capture(reference, authority))
    const receipt = this.p.commands.appendMessage(command, authority, selection, undefined, registration.promptAttachments, portableHistory, this.p.relations)
    const threadTitle = this.p.projections.readThreadPayload(command.threadId)
    const decodedTitle = threadTitle ? String((JSON.parse(threadTitle.payload_json) as { title?: string }).title ?? '') : ''
    this.p.searchIndex.upsertMessage({
      threadId: command.threadId,
      messageId: command.messageId,
      role: 'user',
      title: decodedTitle,
      body: command.text,
    })
    this.p.resolvePendingAsyncUserInputs(command.threadId)
    this.p.authorizations.set(command.commandId, authority)
    this.p.scheduleNext(command.threadId, authority)
    return receipt
  }

  private handleQueueCommand(
    command: Extract<ConversationThreadCommand, { type: 'queue.resume' | 'queued-run.start' | 'queued-run.edit' | 'queued-run.reorder' | 'queued-run.cancel' }>,
    authority: TAuthority,
    delegated: ConversationThreadRelation | undefined,
  ): ConversationThreadCommandState {
    const queued = command.type === 'queued-run.start' ? this.p.commands.effectForRun(command.threadId, command.runId) : undefined
    const originalCompletion = completionIntent(queued)
    if (originalCompletion && command.type === 'queued-run.start') {
      this.p.assertDelegatedCompletionCurrent(command.threadId, originalCompletion, authority, command.runId, true)
    }
    const cancelled = command.type === 'queued-run.cancel' ? this.p.commands.effectForRun(command.threadId, command.runId) : undefined
    const edited = command.type === 'queued-run.edit' && command.attachmentIds?.length
      ? this.p.commands.requireQueued(command.threadId, command.runId) : undefined
    const previous = command.type === 'queued-run.cancel' ? this.p.relations.read(command.threadId).parent : null
    const at = new Date().toISOString()
    const change = command.type === 'queued-run.cancel' && previous?.childRunId === command.runId
      ? delegated ? this.p.settleDelegatedWork(delegated, 'cancelled', at, [])
        : this.p.relations.childUpdate(command.threadId, 'cancelled', command.runId, at)
      : cancelled ? this.p.disposeDelegatedCompletion(cancelled, at) : undefined
    const receipt = this.p.commands.queue(command, authority, edited ? this.p.driverRegistry.require(edited.provider_instance_id).promptAttachments : undefined, change)
    if (cancelled) this.p.authorizations.delete(cancelled.command_id)
    if (queued && originalCompletion) this.p.authorizations.set(queued.command_id, authority)
    if (command.type === 'queue.resume' || command.type === 'queued-run.start') this.p.scheduleNext(command.threadId, authority)
    if (previous?.kind === 'delegated' && change) this.p.offerDelegatedCompletionDelivery(previous.parentThreadId, previous.parentRunId)
    return receipt
  }

  private async handleRollbackOrEditRerun(
    command: Extract<ConversationThreadCommand, { type: 'checkpoint.rollback' | 'message.edit-and-rerun' }>,
    authority: TAuthority,
    active: TTurn | undefined,
    restricted: boolean,
  ): Promise<ConversationThreadCommandState> {
    if (restricted || authority.binding.kind !== 'personal' || this.p.commands.isArchived(command.threadId)) {
      throw new DaemonError('E_DENIED', '仅可在未归档的个人会话中执行回滚或编辑重跑。')
    }
    if (active || this.p.activeTurns.has(command.threadId)) {
      throw new DaemonError('E_BUSY', '当前会话正在运行中，请先停止后再回滚。')
    }
    this.p.usageLimitRecovery.cancel(command.threadId, '用户执行了会话回滚或编辑重跑。')
    this.p.idleCompaction.cancel(command.threadId)
    this.p.runtimeRequests.clearSessionApprovals(command.threadId)
    const targetRun = this.p.commands.run(command.threadId, command.targetRunId)
    if (!targetRun) {
      throw new DaemonError('E_CONFLICT', '找不到要回滚的目标回合。')
    }
    const boundary = command.type === 'message.edit-and-rerun' ? 'before' : command.boundary
    const minOrdinalToRemove = boundary === 'before' ? targetRun.ordinal : targetRun.ordinal + 1
    const removedExecutedTurns = (this.p.database.prepare(
      "SELECT COUNT(*) AS count FROM conversation_v2_projection_runs WHERE thread_id = ? AND ordinal >= ? AND status IN ('completed', 'failed', 'cancelled', 'interrupted')",
    ).get(command.threadId, minOrdinalToRemove) as { count: number }).count
    const nativeBinding = this.p.projections.readNativeBindingOrRunFallback(command.threadId)
    const loadedHandle = this.p.sessions.loadedThreads.get(command.threadId)
    let nativeRollbackApplied = false
    if (
      loadedHandle?.driver.rollbackThread
      && removedExecutedTurns > 0
      && (command.type === 'checkpoint.rollback' || nativeBinding?.instance_id === command.instanceId)
    ) {
      try {
        await runBounded(
          loadedHandle.driver.rollbackThread({ nativeThreadId: loadedHandle.nativeThreadId, numTurns: removedExecutedTurns }),
          this.p.deadlines.control,
          '回退引擎原生会话历史',
          this.p.shutdownSignal,
        )
        nativeRollbackApplied = true
      } catch {
        nativeRollbackApplied = false
      }
    }
    if (command.type === 'message.edit-and-rerun') {
      const runPayload = JSON.parse(targetRun.payload_json) as { userMessageId?: string }
      if (runPayload.userMessageId !== command.messageId) {
        throw new DaemonError('E_CONFLICT', '要编辑的历史消息与目标回合不匹配。')
      }
      const registration = this.p.requireDriver(command.instanceId, false)
      if (command.options?.length && !registration.turnModelOptions) {
        throw new DaemonError('E_UNAVAILABLE', '所选引擎不支持此模型参数。')
      }
      const modelSelection = decodeModelSelection({ instanceId: registration.instanceId, model: command.model, options: command.options })
      if (command.restoreFiles) {
        await this.p.checkpoints.restoreFiles({ threadId: command.threadId, runId: command.targetRunId, phase: 'before', cwd: authority.cwd })
      }
      const keptHistory = !nativeRollbackApplied && minOrdinalToRemove > 1
        ? this.p.contextHandoff.capture({ threadId: command.threadId }, authority, minOrdinalToRemove - 1, false, true)
        : undefined
      const selection = {
        driverKind: registration.driverKind,
        modelSelection,
        configurationFingerprint: this.p.bindingFingerprint(registration),
      }
      const receipt = this.p.commands.appendEditAndRerun(
        command,
        authority,
        selection,
        targetRun.ordinal,
        occurredAt => {
          this.p.projections.truncateThreadFromOrdinal(command.threadId, minOrdinalToRemove, occurredAt, {
            preserveNativeBinding: nativeRollbackApplied,
          })
        },
        keptHistory && keptHistory.messages.length > 0 ? [keptHistory] : undefined,
      )
      const editThreadRow = this.p.projections.readThreadPayload(command.threadId)
      const editTitle = editThreadRow ? String((JSON.parse(editThreadRow.payload_json) as { title?: string }).title ?? '') : ''
      this.p.searchIndex.upsertMessage({
        threadId: command.threadId,
        messageId: command.messageId,
        role: 'user',
        title: editTitle,
        body: command.text,
      })
      if (!nativeRollbackApplied) this.p.sessions.loadedThreads.delete(command.threadId)
      this.p.resolvePendingAsyncUserInputs(command.threadId)
      this.p.authorizations.set(command.commandId, authority)
      this.p.scheduleNext(command.threadId, authority)
      return receipt
    }
    if (command.restoreFiles) {
      await this.p.checkpoints.restoreFiles({ threadId: command.threadId, runId: command.targetRunId, phase: boundary, cwd: authority.cwd })
    }
    const receipt = this.p.commands.commit(command, authority, {
      target: { run_id: command.targetRunId },
      hostEvents: [lifecycleEvent(command.threadId, { kind: 'thread-reset', reason: 'rollback' })],
      apply: () => {
        this.p.projections.truncateThreadFromOrdinal(command.threadId, minOrdinalToRemove, new Date().toISOString(), {
          preserveNativeBinding: nativeRollbackApplied,
        })
      },
    })
    if (!nativeRollbackApplied) this.p.sessions.loadedThreads.delete(command.threadId)
    return receipt
  }

  private handlePromoteToSteer(
    command: Extract<ConversationThreadCommand, { type: 'queued-message.promote-to-steer' }>,
    authority: TAuthority,
    active: TTurn | undefined,
  ): ConversationThreadCommandState {
    const turn = this.p.requireControlTurn(active, 'steerTurn', command.targetRunId)
    const run = this.p.commands.requireQueued(command.threadId, command.queuedRunId)
    const source = this.p.commands.effectForRun(command.threadId, run.run_id)
    if (compactionFromPayload(run.payload_json) || completionIntent(source) || source && (JSON.parse(source.payload_json) as {
      portableHistory?: unknown; handoff?: true
    }).portableHistory) {
      throw new DaemonError('E_UNAVAILABLE', '压缩或带历史引用的队列操作需要独立回合。')
    }
    if (this.p.commands.readUserMessage(run.run_id).attachments?.length) {
      throw new DaemonError('E_UNAVAILABLE', '带附件的队列消息需要独立回合。')
    }
    if (!source) throw new DaemonError('E_CONFLICT', '队列项身份已失效。')
    const receipt = this.p.commands.commit(command, authority, {
      target: { run_id: run.run_id },
      hostEvents: [lifecycleEvent(command.threadId, { kind: 'dispatch', status: 'preparing' }, run.run_id)],
      apply: () => {
        this.p.commands.insertEffect(command, 'provider-turn.steer', {
          runId: run.run_id, targetRunId: turn.runId, targetAttemptId: turn.attemptId, sourceEffectId: source.effect_id,
        })
        this.p.database.prepare("UPDATE conversation_v2_effect_outbox SET status = 'cancelled', last_error = ? WHERE effect_id = ? AND status = 'pending'")
          .run('队列项已转交原回合的插话命令。', source.effect_id)
        this.p.database.prepare("UPDATE conversation_v2_projection_runs SET status = 'starting', payload_json = json_set(payload_json, '$.status', 'starting') WHERE run_id = ?").run(run.run_id)
      },
    })
    this.p.authorizations.delete(source.command_id)
    this.p.scheduleControl(command, authority, turn, run.run_id)
    return receipt
  }

  private handleRuntimeRequestRespond(
    command: Extract<ConversationThreadCommand, { type: 'runtime-request.respond' }>,
    authority: TAuthority,
    active: TTurn | undefined,
    restricted: boolean,
  ): ConversationThreadCommandState {
    const request = this.p.commands.request(command.threadId, command.requestId)
    if (!request || request.status !== 'pending' || request.generation !== command.generation) {
      throw new DaemonError('E_CONFLICT', '原审批或提问已失效。')
    }
    if (request.payload.kind === 'user-input' && request.payload.responseMode === 'message') {
      return this.p.respondToAsyncUserInput(command, authority, request)
    }
    const bound = this.p.runtimeRequests.getNativeRequest(command.requestId)
    if (!bound || bound.turn !== active) {
      throw new DaemonError('E_CONFLICT', '原审批或提问已失效。')
    }
    const turn = this.p.requireControlTurn(active, 'respondToRuntimeRequest', request.runId)
    if ((this.p.isOrdinaryTask(authority) || restricted) && request.kind === 'approval' && command.decision !== 'decline' && command.decision !== 'cancel') {
      throw new DaemonError('E_DENIED', '普通任务的对话不能批准工具操作。')
    }
    const response = this.p.requestResponse(request, command)
    const questionId = command.attachmentIds?.length && response.kind === 'user-input'
      ? this.p.answerAttachmentQuestion(request, response.answers, command.attachmentQuestionId) : undefined
    const attachmentClaim = prepareConversationAttachmentClaim(this.p.attachments, authority, command, command.threadId)
    assertPromptAttachments(attachmentClaim?.attachments, TEXT_ATTACHMENTS, ANSWER_ATTACHMENT_MAX_BYTES)
    const responding = {
      ...request, status: 'responding' as const,
      responseAttachments: attachmentClaim?.attachments, responseAttachmentQuestionId: questionId,
    }
    const receipt = this.p.commands.commit(command, authority, {
      target: { run_id: turn.runId, request_id: request.requestId },
      hostEvents: [lifecycleEvent(command.threadId, { kind: 'request', request: responding }, turn.runId)],
      apply: () => {
        attachmentClaim?.commit()
        this.p.commands.writeRequest(command.threadId, responding, turn.hasNativeTurnId ? (turn.controlTurnId ?? null) : null)
        this.p.commands.insertEffect(command, 'runtime-request.respond', {
          runId: turn.runId, requestId: request.requestId, targetAttemptId: turn.attemptId,
        })
      },
    })
    this.p.runtimeRequests.rememberDecisionIfSessionScoped(command.threadId, request, command.decision)
    this.p.scheduleControl(command, authority, turn)
    return receipt
  }
}
