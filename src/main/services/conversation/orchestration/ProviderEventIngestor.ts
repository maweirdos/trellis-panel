import { createHash, randomUUID } from 'node:crypto'
import * as Schema from 'effect/Schema'
import { ModelSelection, OrchestrationV2DomainEventJson, RunId } from '../../../../shared/conversation/contracts'
import type {
  ConversationHandoff,
  ConversationLifecycleEvent,
  ConversationProjectedWorkItem,
  ConversationTurnUsage,
} from '../../../../shared/conversation/command-runtime'
import type { ConversationHostEvent, ConversationRunEvidence } from '../../../../shared/conversation/desktop'
import type { ConversationNativeSubagentEvent } from '../../../../shared/conversation/thread-relations'
import { codexFileChangeEvidence } from '../providers/codex/file-change-evidence'
import type { ConversationDriverTurnEvent, ConversationDriverWorkItem } from '../providers/registry'
import type { ConversationProjectionStore } from '../persistence/ProjectionStore'
import type { ConversationEffectWorker } from './EffectWorker'
import type { ConversationEventSink } from './EventSink'
import { lifecycleEvent, type ThreadCommands, type ThreadEffectRow } from './ThreadCommands'
import type { ThreadContinuation } from './ThreadContinuation'
import type { ThreadRelations } from './ThreadRelations'
import type { RuntimeRequestService } from './RuntimeRequestService'

const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson)
const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection)
const MAX_WORK_ITEMS_PER_RUN = 48
const MAX_WORK_ITEM_BYTES_PER_RUN = 48 * 1024
const MAX_COMMAND_OUTPUT_CHARS = 6_000

const clipCommandOutputTail = (output: string | undefined): string | undefined => {
  if (!output) return undefined
  const cleaned = output.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  if (!cleaned) return undefined
  return cleaned.length > MAX_COMMAND_OUTPUT_CHARS
    ? `…${cleaned.slice(-(MAX_COMMAND_OUTPUT_CHARS - 1))}`
    : cleaned
}

export interface IngestibleTurn {
  readonly row: ThreadEffectRow
  readonly runId: string
  readonly ordinal: number
  readonly attemptId: string
  readonly nativeThreadId: string
  readonly executionRoot: string
  completionAccepted?: boolean
  controlTurnId?: string
  signalControlTurn?: (turnId?: string) => void
  hasNativeTurnId?: boolean
  background?: Set<string>
  backgroundOverflow?: boolean
  terminal?: Extract<ConversationDriverTurnEvent, { type: 'turn-completed' }>
  terminalObservedAt?: string
}

export interface TurnObservationCallbacks<TTurn extends IngestibleTurn> {
  isClosing(): boolean
  assertOwner(): void
  isCurrentActiveTurn(turn: TTurn): boolean
  resolveCompletionDelivery(turn: TTurn, nativeTurnId: string): readonly { readonly apply: () => void; readonly hostEvents: readonly ConversationLifecycleEvent[] }[]
  onForegroundReadyToFinish(turn: TTurn): void
  onAutoApproveRequest?(turn: TTurn, nativeRequestId: string): void
}

/**
 * 统一消费驱动层上报的回合事件：
 * 助手正文增量写入、工作项规范化投影（含字节预算控制）、用量统计、原生子活动映射及运行时请求转交。
 */
export class ProviderEventIngestor<TTurn extends IngestibleTurn = IngestibleTurn> {
  constructor(
    private readonly projections: ConversationProjectionStore,
    private readonly eventSink: ConversationEventSink,
    private readonly commands: ThreadCommands,
    private readonly relations: ThreadRelations,
    private readonly continuation: ThreadContinuation,
    private readonly worker: ConversationEffectWorker,
    private readonly runtimeRequests: RuntimeRequestService<TTurn>,
  ) {}

  runEvidenceEvent(threadId: string, runId: string, evidence: ConversationRunEvidence, occurredAt: string): ConversationHostEvent {
    return { id: randomUUID(), threadId, runId, occurredAt, type: 'crux.run-evidence', payload: evidence }
  }

  applyTurnEvidence(runId: string, evidence: ConversationRunEvidence): void {
    this.projections.patchRunPayload(runId, evidence as Record<string, unknown>)
  }

  recordTurnEvidence(
    assertOwner: () => void,
    threadId: string,
    runId: string,
    evidence: ConversationRunEvidence,
    apply?: () => void,
    extraEvents: readonly ConversationLifecycleEvent[] = [],
  ): void {
    assertOwner()
    const event = this.runEvidenceEvent(threadId, runId, evidence, new Date().toISOString())
    this.eventSink.commit({ hostEvents: [event, ...extraEvents] }, () => {
      this.applyTurnEvidence(runId, evidence)
      apply?.()
    })
  }

  currentHandoff(threadId: string, runId: string): ConversationHandoff | undefined {
    const run = this.commands.run(threadId, runId)
    return run ? (JSON.parse(run.payload_json) as { handoff?: ConversationHandoff }).handoff : undefined
  }

  recordUsage(threadId: string, runId: string, usage: ConversationTurnUsage): void {
    if (Object.values(usage).some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) return
    this.eventSink.commit({ hostEvents: [lifecycleEvent(threadId, { kind: 'usage', usage }, runId)] }, () => {
      this.continuation.writeUsage(runId, usage)
    })
  }

  buildRecoveryNotice(
    threadId: string,
    runId: string,
    nativeThreadId: string,
    startedAt: string,
  ): Extract<ConversationProjectedWorkItem, { readonly type: 'system_notice' }> {
    return {
      id: `resume-recovery-notice:${runId}`,
      threadId,
      runId,
      nodeId: null,
      providerThreadId: nativeThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: this.projections.nextTurnItemOrdinal(threadId),
      status: 'completed',
      title: '已在新线程恢复上下文',
      startedAt,
      completedAt: startedAt,
      updatedAt: startedAt,
      type: 'system_notice',
      message: '原原生会话无法恢复，已自动带入历史上下文继续对话。',
      level: 'info',
    }
  }

  observeTurn(
    turn: TTurn,
    event: ConversationDriverTurnEvent | ConversationNativeSubagentEvent,
    callbacks: TurnObservationCallbacks<TTurn>,
  ): void {
    const { row, runId } = turn
    if (callbacks.isClosing() || !event.turnId || event.turnId.length > 512
      || !callbacks.isCurrentActiveTurn(turn) || !this.worker.canObserve(row, turn.attemptId)) return
    callbacks.assertOwner()
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
      if (state.provider_thread_id !== turn.nativeThreadId || turn.controlTurnId !== event.turnId
        || turn.hasNativeTurnId !== (event.turnIdSource !== 'host') || state.foreground_ended
        || (turn.hasNativeTurnId && state.native_turn_id !== event.turnId)) return
      this.recordUsage(row.thread_id, runId, event.usage)
      return
    }

    if (event.type === 'work-item') {
      const nativeMatch = event.turnIdSource !== 'host' && state.native_turn_id === event.turnId
      const hostToolMatch = event.turnIdSource === 'host'
        && (event.item.kind === 'tool' || event.item.kind === 'command-execution' || event.item.kind === 'file-search' || event.item.kind === 'web-search')
        && turn.controlTurnId === event.turnId
      if ((nativeMatch || hostToolMatch) && !state.foreground_ended && state.provider_thread_id === turn.nativeThreadId) {
        this.applyWorkItem(turn, event.turnId, event.item)
      }
      return
    }

    turn.controlTurnId = event.turnId
    turn.signalControlTurn?.(event.turnId)
    turn.hasNativeTurnId ??= event.turnIdSource !== 'host'
    const nativeTurnId = turn.hasNativeTurnId ? event.turnId : undefined

    if (event.type === 'turn-receipt' || event.type === 'turn-accepted') {
      this.handleTurnReceiptOrAccepted(turn, event, nativeTurnId, callbacks)
    }
    if ((event.type === 'text-delta' || event.type === 'text-final') && event.text && event.itemId && !state.foreground_ended) {
      this.writeAssistantText(callbacks.assertOwner, row.thread_id, runId, event.itemId, event.text, event.type === 'text-final')
    }
    if (event.type === 'runtime-request' && !state.foreground_ended && !state.stop_requested) {
      if (this.runtimeRequests.shouldAutoApprove(row.thread_id, event.request) && callbacks.onAutoApproveRequest) {
        callbacks.onAutoApproveRequest(turn, event.nativeRequestId)
      } else {
        this.runtimeRequests.recordIncomingRequest(turn, event.nativeRequestId, event.request, nativeTurnId)
      }
    }
    if (event.type === 'background-work') {
      this.handleBackgroundWorkEvent(turn, event, state.foreground_ended, callbacks)
    }
    if (event.type === 'turn-completed' && event.status !== 'running') {
      turn.terminal ??= event
      turn.terminalObservedAt ??= new Date().toISOString()
      if (state.phase === 'unknown' || state.foreground_ended) callbacks.onForegroundReadyToFinish(turn)
    }
  }

  private handleTurnReceiptOrAccepted(
    turn: TTurn,
    event: Extract<ConversationDriverTurnEvent, { type: 'turn-receipt' | 'turn-accepted' }>,
    nativeTurnId: string | undefined,
    callbacks: TurnObservationCallbacks<TTurn>,
  ): void {
    const { row, runId } = turn
    const accepted = event.type === 'turn-accepted'
    const handoff = accepted ? this.currentHandoff(row.thread_id, runId) : undefined
    const acceptedHandoff = handoff?.state === 'prepared' ? { ...handoff, state: 'accepted' as const } : undefined
    const delivery = accepted && nativeTurnId && !turn.completionAccepted
      ? callbacks.resolveCompletionDelivery(turn, nativeTurnId)
      : []
    this.recordTurnEvidence(callbacks.assertOwner, row.thread_id, runId, {
      ...(nativeTurnId ? { nativeTurnId } : {}),
      ...(accepted ? { engineAcceptedAt: new Date().toISOString() } : {}),
      ...(accepted && event.nativeStartedAt ? { nativeStartedAt: event.nativeStartedAt } : {}),
    }, () => {
      if (nativeTurnId) this.worker.recordNativeTurn(row, nativeTurnId)
      if (acceptedHandoff) this.projections.patchRunPayload(runId, { handoff: acceptedHandoff })
      for (const change of delivery) change.apply()
    }, [
      ...(acceptedHandoff ? [lifecycleEvent(row.thread_id, { kind: 'handoff', handoff: acceptedHandoff }, runId)] : []),
      ...delivery.flatMap(change => change.hostEvents),
    ])
    if (delivery.length) turn.completionAccepted = true
  }

  private handleBackgroundWorkEvent(
    turn: TTurn,
    event: Extract<ConversationDriverTurnEvent, { type: 'background-work' }>,
    foregroundEnded: number,
    callbacks: TurnObservationCallbacks<TTurn>,
  ): void {
    const { row, runId } = turn
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
        this.projections.markDispatchAttemptBackgroundRunning(row.effect_id)
      })
    }
    if (foregroundEnded && !turn.backgroundOverflow && turn.background.size === 0 && turn.terminal) {
      callbacks.onForegroundReadyToFinish(turn)
    }
  }

  writeAssistantText(assertOwner: () => void, threadId: string, runId: string, itemId: string, text: string, final: boolean): void {
    assertOwner()
    const messageId = `msg_${createHash('sha256').update(JSON.stringify([runId, itemId])).digest('hex')}`
    const existing = this.projections.readAssistantMessage(messageId)
    const now = new Date().toISOString()
    if (!existing) {
      const projection = {
        createdBy: 'agent', creationSource: 'server', id: messageId, threadId, runId, nodeId: null, role: 'assistant',
        text, attachments: [], streaming: !final, createdAt: now, updatedAt: now,
      }
      const event = decodeEvent({ id: randomUUID(), threadId, runId, occurredAt: now, type: 'message.updated', payload: projection })
      const first = !this.projections.hasAssistantMessageForRun(runId)
      const evidence = { firstOutputAt: now }
      this.eventSink.commit({ events: [event], hostEvents: first ? [this.runEvidenceEvent(threadId, runId, evidence, now)] : [] }, () => {
        this.projections.insertAssistantMessage(messageId, threadId, runId, final, now, JSON.stringify(projection))
        if (first) this.applyTurnEvidence(runId, evidence)
      })
      return
    }
    if (existing.streaming === 0) return
    const payload = JSON.parse(existing.payload_json) as { text: string }
    const projection = { ...payload, text: final ? text : payload.text + text, streaming: !final, updatedAt: now }
    const base = { id: randomUUID(), threadId, runId, occurredAt: now }
    this.eventSink.commit(
      final
        ? { events: [decodeEvent({ ...base, type: 'message.updated', payload: projection })] }
        : { hostEvents: [{ ...base, type: 'crux.message-delta', payload: { messageId, text } }] },
      () => {
        this.projections.updateAssistantMessage(existing.message_id, final, now, JSON.stringify(projection))
      },
    )
  }

  applyWorkItem(turn: TTurn, nativeTurnId: string, item: ConversationDriverWorkItem): void {
    const { row: { thread_id: threadId }, runId, attemptId } = turn
    const nativeItemId = item.kind === 'plan-steps' ? null : item.nativeItemId
    if (nativeItemId !== null && (!nativeItemId || nativeItemId.length > 512
      || nativeItemId !== nativeItemId.trim() || /[\u0000-\u001f\u007f]/.test(nativeItemId))) return
    const binding = createHash('sha256').update(JSON.stringify([attemptId, nativeTurnId])).digest('hex')
    const identity = createHash('sha256').update(JSON.stringify([threadId, runId, binding, item.kind, nativeItemId])).digest('hex')
    const id = `work_${identity}`
    const existing = this.projections.readTurnItem(id, threadId, runId)
    const previous: ConversationProjectedWorkItem | undefined = existing && JSON.parse(existing.payload_json)
    const occurredAt = new Date().toISOString()
    const status = item.kind === 'tool' || item.kind === 'command-execution' || item.kind === 'file-search' || item.kind === 'web-search'
      ? item.status
      : item.kind === 'reasoning'
        ? (item.streaming ? 'running' : 'completed')
        : 'completed'
    if ((previous?.type === 'dynamic_tool' || previous?.type === 'file_change' || previous?.type === 'command_execution' || previous?.type === 'file_search' || previous?.type === 'web_search')
      && previous.status !== 'running' && previous.status !== status) return
    const payload = this.buildWorkItemPayload({
      id, threadId, runId, binding, nativeItemId, status, occurredAt, previous, executionRoot: turn.executionRoot, item,
    })
    if (!payload) return
    const budget = this.projections.readTurnItemBudget(runId, id)
    let finalPayload = payload
    let stored = JSON.stringify(finalPayload)
    if (finalPayload.type === 'file_change' && previous?.type === 'dynamic_tool'
      && budget.bytes + Buffer.byteLength(stored) > MAX_WORK_ITEM_BYTES_PER_RUN) {
      finalPayload = { ...previous, status, updatedAt: occurredAt, completedAt: previous.completedAt ?? occurredAt }
      stored = JSON.stringify(finalPayload)
    }
    if (previous && JSON.stringify({ ...finalPayload, updatedAt: previous.updatedAt }) === existing?.payload_json) return
    if (budget.count >= MAX_WORK_ITEMS_PER_RUN || budget.bytes + Buffer.byteLength(stored) > MAX_WORK_ITEM_BYTES_PER_RUN) return
    const event = decodeEvent({ id: randomUUID(), threadId, runId, occurredAt, type: 'turn-item.updated', payload: finalPayload })
    this.eventSink.commit({ events: [event] }, () => {
      this.projections.upsertTurnItem(finalPayload, status, occurredAt, stored)
    })
  }

  private buildWorkItemPayload(input: {
    readonly id: string
    readonly threadId: string
    readonly runId: string
    readonly binding: string
    readonly nativeItemId: string | null
    readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
    readonly occurredAt: string
    readonly previous: ConversationProjectedWorkItem | undefined
    readonly executionRoot: string
    readonly item: ConversationDriverWorkItem
  }): ConversationProjectedWorkItem | undefined {
    const clip = (text: string, limit: number): string =>
      text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit).trimEnd()
    const preceding = input.previous?.ordinal ?? this.projections.nextTurnItemOrdinal(input.threadId)
    const base = {
      id: input.id, runId: input.runId, threadId: input.threadId, nodeId: null, providerThreadId: null, providerTurnId: null, parentItemId: null,
      nativeItemRef: {
        driver: 'codex', nativeId: input.nativeItemId,
        strength: input.nativeItemId === null ? 'weak' as const : 'strong' as const,
        fingerprint: input.binding,
      },
      ordinal: preceding, status: input.status, startedAt: input.previous?.startedAt ?? input.occurredAt,
      completedAt: input.status === 'running' ? null : input.previous?.completedAt ?? input.occurredAt,
      updatedAt: input.occurredAt,
    }
    if (input.item.kind === 'command-execution') {
      const commandInput = clip(input.item.command, 240) || '运行命令'
      const previousOutput = input.previous?.type === 'command_execution' ? input.previous.output : undefined
      const output = clipCommandOutputTail(input.item.output ?? previousOutput)
      return {
        ...base,
        type: 'command_execution',
        title: '运行命令',
        input: commandInput,
        ...(output ? { output } : {}),
        ...(input.item.exitCode !== undefined && Number.isSafeInteger(input.item.exitCode)
          ? { exitCode: input.item.exitCode }
          : {}),
      }
    }
    if (input.item.kind === 'file-search') {
      const pattern = input.item.pattern ? clip(input.item.pattern, 200) : undefined
      return {
        ...base,
        type: 'file_search',
        title: '搜索文件',
        ...(pattern ? { pattern } : {}),
      }
    }
    if (input.item.kind === 'web-search') {
      const query = input.item.query ? clip(input.item.query, 200) : undefined
      return {
        ...base,
        type: 'web_search',
        title: '搜索网页',
        ...(query ? { patterns: [query] } : {}),
      }
    }
    if (input.item.kind === 'tool') {
      const label = clip(input.item.label, 80)
      if (!label) return undefined
      const detail = input.item.detail ? clip(input.item.detail, 140) : ''
      const toolInput = detail ? { summary: detail, ...(input.item.mono ? { mono: true } : {}) } : null
      const files = input.status === 'completed' && input.item.fileChanges
        ? codexFileChangeEvidence(input.executionRoot, input.item.fileChanges) : undefined
      if (!files && input.previous?.type === 'file_change') return undefined
      return files ? { ...base, type: 'file_change', title: label, ...files }
        : { ...base, type: 'dynamic_tool', title: label, toolName: label, input: toolInput }
    }
    if (input.item.kind === 'reasoning') {
      const text = clip(input.item.text, 8_000)
      return text ? { ...base, type: 'reasoning', title: '思考过程', text, streaming: input.item.streaming } : undefined
    }
    if (input.item.kind === 'proposed-plan') {
      const markdown = clip(input.item.markdown, 8_000)
      return markdown ? { ...base, type: 'proposed_plan', title: '计划建议', planId: input.id, markdown, streaming: false } : undefined
    }
    const explanation = input.item.explanation && clip(input.item.explanation, 1_000)
    return {
      ...base, type: 'todo_list', title: '计划', planId: input.id, ...(explanation && { explanation }),
      steps: input.item.steps.slice(0, 24).map((step, index) => ({
        id: `step-${index + 1}`, text: clip(step.text, 240) || `步骤 ${index + 1}`, status: step.status,
      })),
    }
  }
}

export const buildDelegatedCompletionDeliveryUpdates = (
  relations: ThreadRelations,
  targets: ReturnType<ThreadRelations['read']>['children'],
  runId: string,
) => targets.map(relation => relations.update({
  ...relation,
  ...(relation.result && { result: { ...relation.result, state: 'delivered' as const } }),
  completionDelivery: { state: 'delivered', observedByRunId: RunId.make(runId) },
  updatedAt: new Date().toISOString(),
}))
