import { createHash, randomUUID } from 'node:crypto'
import * as Schema from 'effect/Schema'
import { DaemonError } from '../../../daemon/errors'
import { ModelSelection } from '../../../../shared/conversation/contracts'
import type { ConversationAuthority } from '../../../../shared/conversation/desktop'
import type {
  ConversationRuntimeRequest,
  ConversationRuntimeRequestResponse,
  ConversationThreadCommand,
  ConversationThreadCommandState,
} from '../../../../shared/conversation/command-runtime'
import type { ProviderApprovalDecision } from '../../../../shared/conversation/providerPolicy'
import type {
  ConversationDriverRegistration,
  ConversationDriverRuntimeRequest,
  ConversationRuntimeResponse,
} from '../providers/registry'
import type { ConversationProjectionStore } from '../persistence/ProjectionStore'
import type { ConversationEventSink } from './EventSink'
import { lifecycleEvent, type ThreadCommands, type ThreadEffectRow } from './ThreadCommands'
import type { ThreadRelations } from './ThreadRelations'

const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection)

export interface RuntimeRequestTurnRef {
  readonly row: ThreadEffectRow
  readonly runId: string
  readonly ordinal: number
  readonly attemptId: string
}

export interface AsyncUserInputDispatchHost<TAuthority extends ConversationAuthority> {
  requireDriver(instanceId: string, authority: TAuthority): ConversationDriverRegistration
  bindingFingerprint(registration: ConversationDriverRegistration): string
  authorizeAndSchedule(commandId: string, threadId: string, authority: TAuthority): void
}

/**
 * 负责审批请求与结构化提问请求的完整生命周期：
 * 原生实时请求登记、重启后消息模式回答降级、附件问题校验以及回合终态过期清理。
 */
export class RuntimeRequestService<TTurn extends RuntimeRequestTurnRef = RuntimeRequestTurnRef> {
  private readonly nativeRequests = new Map<string, { readonly turn: TTurn; readonly nativeRequestId: string }>()
  private readonly sessionApprovals = new Map<string, Set<string>>()

  constructor(
    private readonly projections: ConversationProjectionStore,
    private readonly eventSink: ConversationEventSink,
    private readonly commands: ThreadCommands,
    private readonly relations: ThreadRelations,
  ) {}

  rememberSessionApproval(threadId: string, scopeKey?: string): void {
    const clean = scopeKey?.trim()
    if (!clean) return
    const rules = this.sessionApprovals.get(threadId) ?? new Set<string>()
    rules.add(clean)
    this.sessionApprovals.set(threadId, rules)
    try {
      this.projections.addSessionApproval(threadId, clean)
    } catch {
      // 忽略因会话已删除导致的外键冲突
    }
  }

  isSessionApproved(threadId: string, scopeKey?: string): boolean {
    const clean = scopeKey?.trim()
    if (!clean) return false
    if (this.sessionApprovals.get(threadId)?.has(clean)) return true
    if (this.projections.hasSessionApproval(threadId, clean)) {
      const rules = this.sessionApprovals.get(threadId) ?? new Set<string>()
      rules.add(clean)
      this.sessionApprovals.set(threadId, rules)
      return true
    }
    return false
  }

  clearSessionApprovals(threadId: string): void {
    this.sessionApprovals.delete(threadId)
    try {
      this.projections.clearSessionApprovals(threadId)
    } catch {
      // 忽略清理异常
    }
  }

  shouldAutoApprove(threadId: string, payload: ConversationDriverRuntimeRequest): boolean {
    return payload.kind === 'approval' && Boolean(payload.approvalScopeKey) && this.isSessionApproved(threadId, payload.approvalScopeKey)
  }

  rememberDecisionIfSessionScoped(
    threadId: string,
    request: ConversationRuntimeRequest,
    selectedDecision?: ProviderApprovalDecision,
  ): void {
    if (request.payload.kind !== 'approval') return
    if (selectedDecision !== 'acceptForSession' && selectedDecision !== 'acceptAlways') return
    this.rememberSessionApproval(threadId, request.payload.approvalScopeKey)
  }

  getNativeRequest(requestId: string): { readonly turn: TTurn; readonly nativeRequestId: string } | undefined {
    return this.nativeRequests.get(requestId)
  }

  deleteNativeRequest(requestId: string): void {
    this.nativeRequests.delete(requestId)
  }

  recordIncomingRequest(
    turn: TTurn,
    nativeRequestId: string,
    payload: ConversationDriverRuntimeRequest,
    nativeTurnId: string | undefined,
  ): void {
    const threadId = turn.row.thread_id
    const requestId = `request_${createHash('sha256').update(JSON.stringify([turn.attemptId, nativeRequestId])).digest('hex')}`
    if (!nativeRequestId || nativeRequestId.length > 512 || this.commands.request(threadId, requestId)
      || this.nativeRequests.size >= 256 || Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024) {
      return
    }
    const request: ConversationRuntimeRequest = {
      requestId,
      runId: turn.runId,
      generation: turn.ordinal,
      kind: payload.kind,
      payload,
      createdAt: new Date().toISOString(),
      status: 'pending',
    }
    const isMessageMode = request.payload.kind === 'user-input' && request.payload.responseMode === 'message'
    const delegated = !isMessageMode && request.kind === 'user-input' ? this.relations.delegatedParent(threadId) : undefined
    const relation = delegated?.childRunId === turn.runId && !delegated.question ? this.relations.update({
      ...delegated,
      status: 'waiting',
      updatedAt: request.createdAt,
      question: { requestId, generation: request.generation, title: request.payload.title },
    }) : undefined
    this.eventSink.commit({
      hostEvents: [
        lifecycleEvent(threadId, { kind: 'request', request }, turn.runId),
        ...(relation?.hostEvents ?? []),
      ],
    }, () => {
      this.commands.writeRequest(threadId, request, nativeTurnId ?? null)
      if (!isMessageMode) this.commands.bindNativeRequest(requestId, turn.attemptId, nativeRequestId)
      relation?.apply()
    })
    if (!isMessageMode) this.nativeRequests.set(requestId, { turn, nativeRequestId })
  }

  resolvePendingAsyncUserInputs(threadId: string): void {
    const pending = this.commands.requests(threadId).filter(
      request => request.status === 'pending' && request.payload.kind === 'user-input' && request.payload.responseMode === 'message',
    )
    if (!pending.length) return
    const occurredAt = new Date().toISOString()
    const resolved = pending.map(request => ({ ...request, status: 'resolved' as const }))
    this.eventSink.commit({
      hostEvents: resolved.map(request => lifecycleEvent(threadId, { kind: 'request', request }, request.runId, occurredAt)),
    }, () => {
      for (const request of resolved) this.commands.writeRequest(threadId, request, null)
    })
  }

  respondToAsyncUserInput<TAuthority extends ConversationAuthority>(
    command: Extract<ConversationThreadCommand, { type: 'runtime-request.respond' }>,
    authority: TAuthority,
    request: ConversationRuntimeRequest,
    host: AsyncUserInputDispatchHost<TAuthority>,
  ): ConversationThreadCommandState {
    const payload = request.payload
    if (payload.kind !== 'user-input' || payload.responseMode !== 'message') {
      throw new DaemonError('E_INVALID_ARG', '原请求不支持消息模式回复。')
    }
    const resolved: ConversationRuntimeRequest = { ...request, status: 'resolved' }
    if (command.decision === 'cancel') {
      return this.commands.commit(command, authority, {
        target: { run_id: request.runId, request_id: request.requestId },
        hostEvents: [lifecycleEvent(command.threadId, { kind: 'request', request: resolved }, request.runId)],
        apply: () => {
          this.commands.writeRequest(command.threadId, resolved, null)
        },
      })
    }
    if (!command.answers) {
      throw new DaemonError('E_INVALID_ARG', '回答不符合原提问的选项。')
    }
    const formattedLines = this.formatAsyncUserInputAnswers(payload.questions, command.answers)
    const latestRun = this.projections.readLatestRunPayload(command.threadId) ?? this.commands.run(command.threadId, request.runId)
    if (!latestRun) throw new DaemonError('E_CONFLICT', '原会话缺少可用模型配置。')
    const modelSelection = decodeModelSelection(JSON.parse(latestRun.payload_json).modelSelection)
    const registration = host.requireDriver(modelSelection.instanceId, authority)
    const selection = {
      driverKind: registration.driverKind,
      modelSelection,
      configurationFingerprint: host.bindingFingerprint(registration),
    }
    const receipt = this.commands.commit(command, authority, {
      target: { run_id: request.runId, request_id: request.requestId },
      hostEvents: [lifecycleEvent(command.threadId, { kind: 'request', request: resolved }, request.runId)],
      apply: () => {
        this.commands.writeRequest(command.threadId, resolved, null)
      },
    })
    const followUpCommandId = `reply_${createHash('sha256').update(command.commandId).digest('hex').slice(0, 32)}`
    const followUpCommand: Extract<ConversationThreadCommand, { type: 'message.dispatch' }> = {
      type: 'message.dispatch',
      commandId: followUpCommandId,
      threadId: command.threadId,
      messageId: `msg_${randomUUID()}`,
      text: formattedLines.join('\n\n'),
      instanceId: modelSelection.instanceId,
      model: modelSelection.model,
      ...(modelSelection.options?.length ? { options: [...modelSelection.options] } : {}),
      ...(command.draftId && command.attachmentIds?.length ? { draftId: command.draftId, attachmentIds: command.attachmentIds } : {}),
    }
    this.commands.appendMessage(followUpCommand, authority, selection, undefined, registration.promptAttachments, undefined, this.relations)
    host.authorizeAndSchedule(followUpCommandId, command.threadId, authority)
    return receipt
  }

  private formatAsyncUserInputAnswers(
    questions: Extract<ConversationRuntimeRequest['payload'], { kind: 'user-input' }>['questions'],
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): string[] {
    const questionIds = new Set(questions.map(question => question.id))
    const keys = Object.keys(answers)
    if (!keys.length || keys.some(id => !questionIds.has(id))) {
      throw new DaemonError('E_INVALID_ARG', '回答不符合原提问的选项。')
    }
    const formattedLines: string[] = []
    for (const [index, question] of questions.entries()) {
      const raw = answers[question.id]
      const entries = (typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [])
        .map(entry => entry.trim())
        .filter(Boolean)
      const invalidEntry = !entries.length || entries.length > 32 || entries.some(entry =>
        entry.length > 4_000 || (question.choices?.length && !question.allowCustom && !question.choices.some(choice => choice.value === entry)),
      )
      if (invalidEntry) throw new DaemonError('E_INVALID_ARG', '请为每个问题提供有效回答。')
      const answerText = entries.join('、')
      formattedLines.push(questions.length === 1
        ? `关于「${question.prompt}」：${answerText}`
        : `${index + 1}. ${question.prompt}\n${answerText}`)
    }
    return formattedLines
  }

  requestResponse(
    request: ConversationRuntimeRequest,
    response: Extract<ConversationThreadCommand, { type: 'runtime-request.respond' }> | ConversationRuntimeRequestResponse,
  ): ConversationRuntimeResponse {
    if (request.payload.kind === 'approval' && 'decision' in response && response.decision
      && request.payload.options.some(option => option.decision === response.decision)) {
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

  answerAttachmentQuestion(
    request: ConversationRuntimeRequest,
    answers: Readonly<Record<string, unknown>>,
    requested?: string,
  ): string {
    const supported = request.payload.kind === 'user-input'
      ? request.payload.questions.filter(question => question.acceptsTextAttachments && typeof answers[question.id] === 'string')
      : []
    const question = requested ? supported.find(candidate => candidate.id === requested) : supported.length === 1 ? supported[0] : undefined
    if (!question) throw new DaemonError('E_UNAVAILABLE', '请为附件选择原生提问中支持附件的文本回答。')
    return question.id
  }

  expiringRequests(turn: TTurn): ConversationRuntimeRequest[] {
    const expired: ConversationRuntimeRequest[] = []
    for (const [requestId, { turn: owner }] of this.nativeRequests) {
      if (turn !== owner) continue
      const request = this.commands.request(turn.row.thread_id, requestId)
      if (request?.status === 'pending' && !(request.payload.kind === 'user-input' && request.payload.responseMode === 'message')) {
        expired.push({ ...request, status: 'expired' })
      }
    }
    return expired
  }

  clearRequestBindings(turn: TTurn): void {
    for (const [requestId, { turn: owner }] of this.nativeRequests) {
      if (turn === owner) this.nativeRequests.delete(requestId)
    }
  }
}
