import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type {
  ConversationCompaction,
  ConversationGoal,
  ConversationHandoff,
  ConversationLifecycleEvent,
  ConversationProjectedWorkItem,
  ConversationRuntimeRequest,
  ConversationThreadCommand,
  ConversationThreadCommandState,
  ConversationThreadEventPage,
  ConversationThreadHistoryCursor,
  ConversationThreadHistoryPage,
  ConversationThreadSnapshot,
  ConversationTurnUsage,
  ConversationUsageLimitRecovery,
} from '../../../shared/conversation/command-runtime'
import type { ConversationRunEvidence } from '../../../shared/conversation/desktop'
import type { ConversationFailureClass } from '../../../shared/conversation/failure-taxonomy'
import { IpcErrorCode, type IpcFail } from '../../../shared/ipc-errors'
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
} from '../../../shared/conversation/orchestrationV2'
import type { ConversationTaskLocator } from '../../../shared/conversation/task-scope'
import type { ConversationThreadRelations } from '../../../shared/conversation/thread-relations'
import { ModelSelection } from '../../../shared/conversation/modelSelection'

export type ConversationThread = Pick<OrchestrationV2AppThread, 'id' | 'title' | 'modelSelection'> &
  Partial<Pick<OrchestrationV2AppThread, 'archivedAt' | 'worktreePath' | 'runtimeMode' | 'interactionMode'>>

export type ConversationMessage = Pick<
  OrchestrationV2ConversationMessage,
  'role' | 'text' | 'runId' | 'streaming'
> & {
  readonly id: string
  readonly notification?: OrchestrationV2ConversationMessage['notification']
  readonly createdAt?: OrchestrationV2ConversationMessage['createdAt'] | string
  readonly updatedAt?: OrchestrationV2ConversationMessage['updatedAt'] | string
}

export type ConversationRun = Pick<
  OrchestrationV2Run,
  'id' | 'ordinal' | 'status' | 'modelSelection' | 'userMessageId' | 'startedAt' | 'requestedAt'
> & {
  readonly completedAt?: OrchestrationV2Run['completedAt'] | string
  readonly failure?: string
  readonly failureClass?: ConversationFailureClass
  readonly retryAfterMs?: number
  readonly outcomeUnknown?: boolean
  readonly engineAcceptedAt?: string | null
  readonly nativeTurnId?: string | null
  readonly queuePosition?: number | null
  readonly manualContinuationOfRunId?: string
  readonly usage?: ConversationTurnUsage
  readonly compaction?: ConversationCompaction
  readonly handoff?: ConversationHandoff
  readonly lifecycle?: {
    readonly foregroundEnded: boolean
    readonly backgroundRunning: boolean
    readonly stopRequested: boolean
    readonly terminalEvidence?: { readonly status: string; readonly observedAt: string; readonly nativeTurnId?: string }
  }
}

export type ConversationTimelineWorkEntry = {
  readonly kind: 'work'
  readonly id: string
  readonly text: string
  readonly detail?: string
  readonly mono?: boolean
  readonly toolName?: string | null
  readonly state: 'running' | 'done' | 'failed' | 'cancelled'
  readonly output?: string
  readonly exitCode?: number
  readonly at?: string
}

export type ConversationTimelineReasoningEntry = {
  readonly kind: 'reasoning'
  readonly id: string
  readonly text: string
  readonly streaming: boolean
  readonly at?: string
}

type ConversationTimelineEntry =
  | { readonly kind: 'message'; readonly id: string; readonly message: ConversationMessage
      readonly forkRunId?: string; readonly showAssistantMeta?: boolean }
  | ConversationTimelineWorkEntry
  | ConversationTimelineReasoningEntry
  | {
      readonly kind: 'notice'
      readonly id: string
      readonly title: string
      readonly variant: 'recovery' | 'continuation'
      readonly at?: string
    }
  | { readonly kind: 'plan'; readonly id: string; readonly item: Extract<ConversationProjectedWorkItem, { readonly type: 'proposed_plan' | 'todo_list' }> }
  | { readonly kind: 'file-change'; readonly id: string; readonly item: Extract<ConversationProjectedWorkItem, { readonly type: 'file_change' }> }
  | { readonly kind: 'relation'; readonly id: string; readonly item: ConversationThreadRelations['children'][number] }

export type ConversationTimelineRow =
  | ConversationTimelineEntry
  | {
      readonly kind: 'work-group'
      readonly id: string
      readonly entries: readonly ConversationTimelineWorkEntry[]
    }
  | {
      readonly kind: 'work-fold'
      readonly id: string
      readonly durationMs: number
      readonly entries: readonly ConversationTimelineEntry[]
    }

export interface ConversationThreadProjection {
  readonly thread: ConversationThread
  readonly messages: readonly ConversationMessage[]
  readonly runs: readonly ConversationRun[]
  readonly rows: readonly ConversationTimelineRow[]
  readonly queuePaused: boolean
  readonly runtimeRequests: readonly ConversationRuntimeRequest[]
  readonly queuedRuns: readonly ConversationRun[]
  readonly activeRun: ConversationRun | undefined
  readonly cursor?: ConversationThreadSnapshot['cursor']
  readonly turnItems?: readonly ConversationProjectedWorkItem[]
  readonly historyCursor: ConversationThreadSnapshot['historyCursor']
  readonly hasOlderHistory: boolean
  readonly relations: ConversationThreadRelations
  readonly goal: ConversationGoal | null
  readonly usageLimitRecovery: ConversationUsageLimitRecovery | null
}

export interface ThreadReadTarget {
  readonly threadId: string
  readonly runId?: string
}

export type ConversationApplyResult =
  | {
      readonly ok: true
      readonly uncertain: false
      readonly commandId: string
      readonly receipt: ConversationThreadCommandState
      readonly source: 'apply' | 'reconcile'
    }
  | {
      readonly ok: false
      readonly uncertain: true
      readonly commandId: string
      readonly reason: string
      readonly receipt?: ConversationThreadCommandState
      readonly source: 'apply' | 'reconcile'
    }
  | {
      readonly ok: false
      readonly uncertain: false
      readonly commandId?: string
      readonly reason: string
      readonly receipt?: ConversationThreadCommandState
      readonly source: 'apply' | 'reconcile'
    }

const ACTIVE_RUNS = new Set<ConversationRun['status']>(['preparing', 'queued', 'starting', 'running', 'waiting'])
const decodeModelSelection = Schema.decodeUnknownOption(ModelSelection)

export function isActiveRun(run: ConversationRun): boolean {
  return !run.outcomeUnknown && ACTIVE_RUNS.has(run.status)
}

export function isQueuedRun(run: ConversationRun): boolean {
  return run.status === 'queued' && !run.outcomeUnknown
}

function isWithdrawnQueuedRun(run: ConversationRun): boolean {
  return run.status === 'cancelled'
    && run.startedAt == null
    && run.engineAcceptedAt == null
    && !run.lifecycle?.stopRequested
}

function hasActiveNonQueuedRun(runs: readonly ConversationRun[]): boolean {
  return runs.some((run) => run.status !== 'queued' && isActiveRun(run))
}

function hasUnheldQueuedRun(
  projection: Pick<ConversationThreadProjection, 'queuePaused' | 'queuedRuns'>,
): boolean {
  return !projection.queuePaused && projection.queuedRuns.length > 0
}

/**
 * 对齐 t3code deriveResumableRunId：
 * 返回最近一次被停止或中断且可直接从输入框主按钮继续的回合编号；
 * 仅被撤回的未启动排队消息、压缩运行或待核对回合不触发继续。
 */
export function deriveResumableRunId(
  projection: Pick<ConversationThreadProjection, 'runs' | 'thread' | 'queuePaused' | 'queuedRuns'> | undefined,
): string | null {
  if (!projection || projection.thread.archivedAt || hasActiveNonQueuedRun(projection.runs) || hasUnheldQueuedRun(projection)) {
    return null
  }
  const latestExecuted = [...projection.runs]
    .filter((run) => run.status !== 'queued' && !run.compaction && !isWithdrawnQueuedRun(run))
    .sort((left, right) => left.ordinal - right.ordinal)
    .at(-1)
  if (!latestExecuted || latestExecuted.outcomeUnknown) return null
  if (latestExecuted.status === 'interrupted' || latestExecuted.status === 'cancelled') {
    return latestExecuted.id
  }
  return null
}

/**
 * 对齐 t3code canResumeThread：
 * 若存在待处理的审批或提问请求则不显示继续；否则在有可续接中断回合或存在被暂停的排队消息时允许一键继续。
 */
export function canResumeThread(
  projection: Pick<ConversationThreadProjection, 'runs' | 'thread' | 'runtimeRequests' | 'queuePaused' | 'queuedRuns'> | undefined,
  resumableRunId: string | null,
): boolean {
  if (!projection || projection.thread.archivedAt || hasActiveNonQueuedRun(projection.runs) || hasUnheldQueuedRun(projection)) {
    return false
  }
  const hasBlockingRequest = projection.runtimeRequests.some(
    (request) => request.status === 'pending' || request.status === 'responding' || request.status === 'pending-reconciliation',
  )
  if (hasBlockingRequest) return false
  if (resumableRunId !== null) return true
  return projection.queuePaused && projection.queuedRuns.length > 0
}

export type ReadIdentity = Pick<ConversationThreadHistoryCursor, 'storageId' | 'threadId'>

export function sameReadIdentity(current: ReadIdentity | undefined | null, next: ReadIdentity): boolean {
  return current?.storageId === next.storageId && current.threadId === next.threadId
}

export function losesReadAccess(code: unknown): boolean {
  return code === IpcErrorCode.Denied || code === IpcErrorCode.Unauthorized
    || code === IpcErrorCode.NotFound || code === IpcErrorCode.NoProject
}

export function historyPageCursor(
  page: ConversationThreadHistoryPage,
  previous: ConversationThreadHistoryCursor,
): ConversationThreadHistoryCursor | null {
  const next = page.historyCursor
  if (next && (!sameReadIdentity(next, previous) || next.beforeRunOrdinal >= previous.beforeRunOrdinal)) {
    throw Object.assign(new Error('对话历史游标已失效，请刷新快照。'), { code: IpcErrorCode.ResetRequired })
  }
  return next
}

export function wasNotAdmitted(failure: IpcFail): boolean {
  return 'outcome' in failure && failure.outcome === 'not-admitted'
}

export function projectionCacheKey(
  scopeKey: string,
  root: string,
  threadId: string,
  task?: ConversationTaskLocator,
): string {
  return JSON.stringify([scopeKey, root, threadId, task?.workspaceKey, task?.taskId, task?.taskCreatedAt, task?.scopeKey])
}

export function commandResult(
  commandId: string,
  receipt: ConversationThreadCommandState | null,
  source: 'apply' | 'reconcile',
): ConversationApplyResult {
  if (!receipt || receipt.dispatch === 'pending-reconciliation') {
    return {
      ok: false, uncertain: true, commandId, source, ...(receipt && { receipt }),
      reason: receipt?.detail ?? '操作结果待核对。',
    }
  }
  if (receipt.dispatch === 'failed' || receipt.dispatch === 'cancelled') {
    return {
      ok: false, uncertain: false, commandId, receipt, source,
      reason: receipt.detail ?? (receipt.dispatch === 'cancelled' ? '操作已取消。' : '操作未完成。'),
    }
  }
  return { ok: true, uncertain: false, commandId, receipt, source }
}

function upsertMessage(
  messages: readonly ConversationMessage[],
  next: ConversationMessage,
): readonly ConversationMessage[] {
  const index = messages.findIndex((message) => message.id === next.id)
  if (index === -1) return [...messages, next]
  if (messages[index] === next) return messages
  const copy = messages.slice()
  copy[index] = next
  return copy
}

function applyMessageDelta(
  messages: readonly ConversationMessage[],
  messageId: string,
  text: string,
): readonly ConversationMessage[] {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index === -1) return messages
  const existing = messages[index]
  const copy = messages.slice()
  copy[index] = { ...existing, text: existing.text + text, streaming: true }
  return copy
}

function upsertRequest(
  requests: readonly ConversationRuntimeRequest[],
  next: ConversationRuntimeRequest,
): readonly ConversationRuntimeRequest[] {
  const index = requests.findIndex((request) => request.requestId === next.requestId)
  if (index === -1) return [...requests, next]
  const copy = requests.slice()
  copy[index] = next
  return copy
}

function timelineTime(value: string | { readonly epochMilliseconds: number } | null | undefined): number | undefined {
  const time = typeof value === 'string' ? Date.parse(value) : value?.epochMilliseconds
  return time !== undefined && Number.isFinite(time) ? time : undefined
}

export function runStartIso(run: ConversationRun | undefined): string | null {
  const time = timelineTime(run?.startedAt ?? run?.requestedAt)
  if (time === undefined) return null
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function groupWorkEntries(
  entries: readonly ConversationTimelineEntry[],
  runId: string,
): readonly ConversationTimelineRow[] {
  const grouped: ConversationTimelineRow[] = []
  let bucket: ConversationTimelineWorkEntry[] = []
  let groupIndex = 0
  const flush = (): void => {
    if (!bucket.length) return
    const first = bucket[0]
    grouped.push({
      kind: 'work-group',
      id: `work-group:${runId}:${groupIndex++}:${first.id}`,
      entries: bucket,
    })
    bucket = []
  }
  for (const entry of entries) {
    if (entry.kind === 'work') {
      bucket.push(entry)
    } else {
      flush()
      grouped.push(entry)
    }
  }
  flush()
  return grouped
}

function isSubstantiveAssistantMessage(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  const hasQuestionAndList = /[？?]/.test(trimmed) && /(?:^|\n)\s*(?:[-*•]|\d+[.)、])\s+/m.test(trimmed)
  if (hasQuestionAndList) return true
  const hasStructuredBlock = /(?:^|\n)\s*(?:#{1,6}\s|```|\|.*\|)/m.test(trimmed)
  if (hasStructuredBlock) return true
  const paragraphs = trimmed.split(/\n{2,}/).filter((chunk) => chunk.trim().length > 0)
  return paragraphs.length >= 2 || trimmed.length > 180
}

function completedWorkLog(
  run: ConversationRun,
  entries: readonly ConversationTimelineEntry[],
  finalIndex: number,
): readonly ConversationTimelineRow[] {
  if (run.status !== 'completed' || run.outcomeUnknown || run.lifecycle?.backgroundRunning) {
    return groupWorkEntries(entries, run.id)
  }
  const start = timelineTime(run.startedAt ?? run.requestedAt)
  const end = timelineTime(run.completedAt)
  if (start === undefined || end === undefined || end < start) {
    return groupWorkEntries(entries, run.id)
  }
  const finalReply = entries[finalIndex]
  if (finalReply?.kind !== 'message' || finalReply.message.streaming) {
    return groupWorkEntries(entries, run.id)
  }
  const history = entries.slice(0, finalIndex)
  const hasWork = history.some(entry => entry.kind === 'work' || entry.kind === 'reasoning')
  const allSettled = history.every(entry =>
    (entry.kind === 'message' && !entry.message.streaming) ||
    (entry.kind === 'work' && entry.state !== 'running') ||
    (entry.kind === 'reasoning' && !entry.streaming) ||
    entry.kind === 'notice' ||
    entry.kind === 'plan' ||
    entry.kind === 'file-change' ||
    entry.kind === 'relation')
  if (!hasWork || !allSettled) return groupWorkEntries(entries, run.id)

  const retainedIndices = history.reduce<number[]>((indices, entry, index) => {
    if (entry.kind === 'message' && isSubstantiveAssistantMessage(entry.message.text)) {
      indices.push(index)
    }
    return indices
  }, [])

  if (retainedIndices.length === 0) {
    return [
      { kind: 'work-fold', id: `work-fold:${run.id}`, durationMs: end - start, entries: history },
      ...groupWorkEntries(entries.slice(finalIndex), run.id),
    ]
  }

  const rows: ConversationTimelineRow[] = []
  let cursor = 0
  let foldIndex = 0
  const flushProcessSegment = (segment: readonly ConversationTimelineEntry[], includeDuration: boolean): void => {
    if (!segment.length) return
    if (segment.some((entry) => entry.kind === 'work' || entry.kind === 'reasoning')) {
      rows.push({
        kind: 'work-fold',
        id: foldIndex === 0 ? `work-fold:${run.id}` : `work-fold:${run.id}:${foldIndex}`,
        durationMs: includeDuration ? end - start : 0,
        entries: segment,
      })
      foldIndex += 1
    } else {
      rows.push(...groupWorkEntries(segment, run.id))
    }
  }

  for (const retainedIndex of retainedIndices) {
    flushProcessSegment(history.slice(cursor, retainedIndex), foldIndex === 0)
    rows.push(history[retainedIndex])
    cursor = retainedIndex + 1
  }
  flushProcessSegment(history.slice(cursor), foldIndex === 0)
  rows.push(...groupWorkEntries(entries.slice(finalIndex), run.id))
  return rows
}

/** Projects snapshot + delta into rows; a repeated id replaces its own row instead of duplicating it. */
export function deriveTimelineRows(
  messages: readonly ConversationMessage[],
  runs: readonly ConversationRun[],
  turnItems: readonly ConversationProjectedWorkItem[],
  relations: ConversationThreadRelations['children'] = [],
): readonly ConversationTimelineRow[] {
  const rows: ConversationTimelineRow[] = []
  const place = (row: ConversationTimelineRow): void => {
    const index = rows.findIndex((candidate) => candidate.id === row.id)
    if (index === -1) rows.push(row)
    else rows[index] = row
  }
  const assistantPlaced = new Set<string>()
  const omittedPromptIds = new Set<string>()
  const byParentRun = new Map<string, ConversationThreadRelations['children'][number][]>()
  for (const item of relations) {
    if (!item.parentRunId || (item.kind !== 'delegated' && item.kind !== 'native-activity')) continue
    const current = byParentRun.get(item.parentRunId)
    if (current) current.push(item)
    else byParentRun.set(item.parentRunId, [item])
  }
  for (const run of runs) {
    const prompt = messages.find((item) => item.id === run.userMessageId)
    if (prompt) {
      if (prompt.role === 'system' && prompt.notification?.summary) {
        omittedPromptIds.add(prompt.id)
      } else {
        place({ kind: 'message', id: prompt.id, message: prompt })
      }
    }
    const turn: Array<{ row: ConversationTimelineEntry; time?: number }> = []
    const append = (row: ConversationTimelineEntry, startedAt: string | { readonly epochMilliseconds: number } | null | undefined): void => {
      turn.push({ row, time: timelineTime(startedAt) })
    }
    for (const item of turnItems) {
      if (item.runId !== run.id) continue
      if (item.type === 'dynamic_tool' && item.title) {
        const status = item.status
        const rawInput = item.input && typeof item.input === 'object' && !Array.isArray(item.input)
          ? item.input as Record<string, unknown>
          : null
        const detail = typeof rawInput?.summary === 'string' && rawInput.summary.trim()
          ? rawInput.summary.trim()
          : undefined
        const mono = rawInput?.mono === true
        append({
          kind: 'work',
          id: item.id,
          text: item.title,
          ...(detail ? { detail } : {}),
          ...(mono ? { mono: true } : {}),
          toolName: item.toolName,
          state: status === 'failed' ? 'failed' : status === 'completed' ? 'done'
            : status === 'cancelled' || status === 'interrupted' ? 'cancelled' : 'running',
          ...(typeof item.completedAt === 'string' ? { at: item.completedAt } : {}),
        }, item.startedAt)
      } else if (item.type === 'command_execution') {
        const status = item.status
        append({
          kind: 'work',
          id: item.id,
          text: '运行命令',
          detail: item.input,
          mono: true,
          toolName: 'command_execution',
          state: status === 'failed' ? 'failed' : status === 'completed' ? 'done'
            : status === 'cancelled' || status === 'interrupted' ? 'cancelled' : 'running',
          ...(item.output ? { output: item.output } : {}),
          ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
          ...(typeof item.completedAt === 'string' ? { at: item.completedAt } : {}),
        }, item.startedAt)
      } else if (item.type === 'file_search') {
        const status = item.status
        append({
          kind: 'work',
          id: item.id,
          text: '搜索文件',
          ...(item.pattern ? { detail: item.pattern } : {}),
          mono: true,
          toolName: 'file_search',
          state: status === 'failed' ? 'failed' : status === 'completed' ? 'done'
            : status === 'cancelled' || status === 'interrupted' ? 'cancelled' : 'running',
          ...(typeof item.completedAt === 'string' ? { at: item.completedAt } : {}),
        }, item.startedAt)
      } else if (item.type === 'web_search') {
        const status = item.status
        append({
          kind: 'work',
          id: item.id,
          text: '搜索网页',
          ...(item.patterns?.[0] ? { detail: item.patterns[0] } : {}),
          toolName: 'web_search',
          state: status === 'failed' ? 'failed' : status === 'completed' ? 'done'
            : status === 'cancelled' || status === 'interrupted' ? 'cancelled' : 'running',
          ...(typeof item.completedAt === 'string' ? { at: item.completedAt } : {}),
        }, item.startedAt)
      } else if (item.type === 'reasoning' && item.text.trim()) {
        append({
          kind: 'reasoning',
          id: item.id,
          text: item.text.trim(),
          streaming: item.streaming || item.status === 'running',
          ...(typeof item.completedAt === 'string' ? { at: item.completedAt } : {}),
        }, item.startedAt)
      } else if (item.type === 'proposed_plan' || item.type === 'todo_list') {
        append({ kind: 'plan', id: item.id, item }, item.startedAt)
      } else if (item.type === 'file_change') {
        append({ kind: 'file-change', id: item.id, item }, item.startedAt)
      } else if (item.type === 'system_notice' && item.message.trim()) {
        append({
          kind: 'notice',
          id: item.id,
          title: item.message.trim(),
          variant: 'recovery',
          ...(typeof item.updatedAt === 'string' ? { at: item.updatedAt } : {}),
        }, item.startedAt)
      }
    }
    for (const item of byParentRun.get(run.id) ?? []) append({ kind: 'relation', id: `relation:${item.id}`, item }, item.createdAt)
    for (const message of messages) {
      if (message.role !== 'assistant' || message.runId !== run.id || assistantPlaced.has(message.id)) continue
      assistantPlaced.add(message.id)
      const stable = !run.outcomeUnknown && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
      append({ kind: 'message', id: message.id, message, ...(stable && { forkRunId: run.id }) }, message.createdAt)
    }
    const dated = turn.flatMap(entry => entry.time === undefined ? [] : [{ row: entry.row, time: entry.time }])
      .sort((left, right) => left.time - right.time)
    let datedIndex = 0
    const ordered = turn.map(entry => entry.time === undefined ? entry.row : dated[datedIndex++].row)
    const finalIndex = ordered.reduce((last, entry, index) =>
      entry.kind === 'message' && entry.message.text.trim() ? index : last, -1)
    const entries = ordered.map((entry, index) => entry.kind === 'message'
      ? { ...entry, showAssistantMeta: index === finalIndex && Boolean(entry.forkRunId) && !entry.message.streaming }
      : entry)
    for (const entry of completedWorkLog(run, entries, finalIndex)) place(entry)
  }
  const placed = new Set(rows.map((row) => row.id))
  for (const message of messages) {
    if (placed.has(message.id) || assistantPlaced.has(message.id) || omittedPromptIds.has(message.id)) continue
    rows.push({ kind: 'message', id: message.id, message })
  }
  return rows
}

export function queuedRunsWithText(
  runs: readonly ConversationRun[],
  messages: readonly ConversationMessage[],
): ReadonlyArray<{ readonly run: ConversationRun; readonly text: string }> {
  return runs
    .filter((run) => isQueuedRun(run))
    .map((run) => ({
      run,
      text: messages.find((message) => message.id === run.userMessageId)?.text ?? '',
    }))
    .sort(
      (left, right) =>
        (left.run.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.run.queuePosition ?? Number.MAX_SAFE_INTEGER),
    )
}

export function snapshotProjection(snapshot: ConversationThreadSnapshot): ConversationThreadProjection {
  const { thread, runs, messages, turnItems = [] } = snapshot
  const relations = snapshot.relations ?? { parent: null, children: [] }
  const activeRun = [...runs].reverse().find((run) => isActiveRun(run))
  return {
    thread,
    messages,
    runs,
    turnItems,
    rows: deriveTimelineRows(messages, runs, turnItems, relations.children),
    relations,
    goal: snapshot.goal ?? null,
    usageLimitRecovery: snapshot.usageLimitRecovery ?? null,
    queuePaused: snapshot.queuePaused,
    runtimeRequests: snapshot.runtimeRequests,
    queuedRuns: runs.filter((run) => isQueuedRun(run)),
    activeRun,
    cursor: snapshot.cursor,
    historyCursor: snapshot.historyCursor,
    hasOlderHistory: snapshot.historyCursor !== null,
  }
}

export function prependHistory(
  projection: ConversationThreadProjection,
  pages: readonly ConversationThreadHistoryPage[],
): ConversationThreadProjection {
  if (!pages.length) return projection
  const mergeById = <Item extends { readonly id: string }>(older: readonly Item[], newer: readonly Item[]): Item[] =>
    [...new Map([...older, ...newer].map(item => [item.id, item])).values()]
  const messages = mergeById(pages.flatMap(page => page.messages), projection.messages)
  const runs = mergeById(pages.flatMap(page => page.runs), projection.runs)
  const turnItems = mergeById(pages.flatMap(page => page.turnItems ?? []), projection.turnItems ?? [])
  const historyCursor = pages[0].historyCursor
  return {
    ...projection,
    messages,
    runs,
    turnItems,
    rows: deriveTimelineRows(messages, runs, turnItems, projection.relations.children),
    historyCursor,
    hasOlderHistory: historyCursor !== null,
  }
}

export function applyEventPage(
  projection: ConversationThreadProjection,
  page: Extract<ConversationThreadEventPage, { readonly kind: 'events' }>,
): { readonly projection: ConversationThreadProjection; readonly cursor: ConversationThreadSnapshot['cursor'] } {
  const previous = projection.cursor
  if (previous && sameReadIdentity(previous, page.cursor) && previous.sequence > page.cursor.sequence) {
    return { projection, cursor: previous }
  }
  const events = page.events.filter(({ sequence }) => sequence > (projection.cursor?.sequence ?? -1))
  if (!events.length && projection.cursor?.sequence === page.cursor.sequence) {
    return { projection, cursor: page.cursor }
  }
  let messages = projection.messages
  let thread = projection.thread
  const runs = [...projection.runs]
  let queuePaused = projection.queuePaused
  let runtimeRequests = projection.runtimeRequests
  let parent = projection.relations?.parent ?? null
  let goal = projection.goal ?? null
  let usageLimitRecovery = projection.usageLimitRecovery ?? null
  const children = new Map((projection.relations?.children ?? []).map(item => [item.id, item]))
  const items = new Map((projection.turnItems ?? []).map(item => [item.id, item]))
  const updateRun = (id: unknown, update: (run: ConversationRun) => ConversationRun): void => {
    const index = runs.findIndex(run => run.id === id)
    if (index >= 0) runs[index] = update(runs[index])
  }
  for (const entry of events) {
    const event = entry.event as Record<string, unknown> & { readonly type?: string }
    const payload = event.payload as Record<string, unknown> | undefined
    if (event.type === 'crux.lifecycle') {
      if (entry.event.type !== 'crux.lifecycle') continue
      const body = entry.event.payload
      if (body.kind === 'relation') {
        const { relation, removed } = body
        if (event.threadId === projection.thread.id) {
          if (relation.parentThreadId === projection.thread.id) {
            if (removed) children.delete(relation.id)
            else children.set(relation.id, relation)
          } else if (relation.childThreadId === projection.thread.id) {
            if (!removed) parent = relation
            else if (parent?.id === relation.id) parent = null
          }
        }
        continue
      }
      if (body.kind === 'goal') goal = body.goal
      if (body.kind === 'usage-limit-recovery') usageLimitRecovery = body.recovery
      if (body.kind === 'usage') updateRun(event.runId, run => ({ ...run, usage: body.usage }))
      if (body.kind === 'compaction') updateRun(event.runId, run => ({ ...run, compaction: body.compaction }))
      if (body.kind === 'handoff') updateRun(event.runId, run => ({ ...run, handoff: body.handoff }))
      const lifecycle = payload as ConversationLifecycleEvent['payload']
      if (lifecycle.kind === 'queue') queuePaused = lifecycle.paused
      if (lifecycle.kind === 'request') {
        runtimeRequests =
          lifecycle.request.status === 'resolved' || lifecycle.request.status === 'expired'
            ? runtimeRequests.filter((request) => request.requestId !== lifecycle.request.requestId)
            : upsertRequest(runtimeRequests, lifecycle.request)
      }
      if (lifecycle.kind === 'dispatch' && lifecycle.status === 'unknown') {
        updateRun(event.runId, run => ({ ...run, outcomeUnknown: true }))
      }
      if (lifecycle.kind === 'run' || lifecycle.kind === 'terminal-evidence') {
        updateRun(event.runId, run => {
          const previousLifecycle = run.lifecycle
          const phase = lifecycle.kind === 'run' ? lifecycle.phase : undefined
          const terminalEvidence = lifecycle.kind === 'terminal-evidence' ? lifecycle.evidence : previousLifecycle?.terminalEvidence
          return {
            ...run,
            lifecycle: {
              foregroundEnded: phase === 'foreground-ended' || phase === 'settled' || Boolean(previousLifecycle?.foregroundEnded),
              backgroundRunning: phase === 'background-running' || (phase !== 'settled' && Boolean(previousLifecycle?.backgroundRunning)),
              stopRequested: phase === 'stop-requested' || phase === 'stop-unconfirmed' || Boolean(previousLifecycle?.stopRequested),
              ...(terminalEvidence && { terminalEvidence }),
            },
          }
        })
      }
      continue
    }
    if (event.type === 'crux.message-delta') {
      if (payload && typeof payload.messageId === 'string' && typeof payload.text === 'string') {
        messages = applyMessageDelta(messages, payload.messageId, payload.text)
      }
      continue
    }
    if (event.type === 'crux.run-evidence') {
      updateRun(event.runId, run => ({ ...run, ...payload as ConversationRunEvidence }))
      continue
    }
    if (event.type === 'message.updated' && payload) {
      const message = payload as unknown as ConversationMessage
      if (typeof message.id === 'string') messages = upsertMessage(messages, message)
      continue
    }
    const wireEvent = entry.event
    if (wireEvent.type === 'thread.metadata-updated' && wireEvent.threadId === thread.id) {
      const { title, modelSelection, runtimeMode, interactionMode } = wireEvent.payload
      thread = {
        ...thread,
        title,
        modelSelection: Option.getOrElse(decodeModelSelection(modelSelection), () => thread.modelSelection),
        ...(runtimeMode !== undefined ? { runtimeMode } : {}),
        ...(interactionMode !== undefined ? { interactionMode } : {}),
      }
      continue
    }
    if (wireEvent.type === 'turn-item.updated') {
      const item = wireEvent.payload
      if (
        item.type === 'dynamic_tool' ||
        item.type === 'command_execution' ||
        item.type === 'file_search' ||
        item.type === 'web_search' ||
        item.type === 'proposed_plan' ||
        item.type === 'todo_list' ||
        item.type === 'file_change' ||
        item.type === 'reasoning' ||
        item.type === 'system_notice'
      ) {
        items.set(item.id, item)
      }
      continue
    }
    if ((event.type === 'run.created' || event.type === 'run.updated') && payload && typeof payload === 'object') {
      const next = payload as unknown as ConversationRun
      if (typeof next.id === 'string') {
        const index = runs.findIndex((run) => run.id === next.id)
        if (index === -1) runs.push(next)
        else runs[index] = { ...runs[index], ...next }
      }
    }
  }
  const turnItems = [...items.values()]
  const relations = { parent, children: [...children.values()] }
  const activeRun = [...runs].reverse().find((run) => isActiveRun(run))
  const next: ConversationThreadProjection = {
    ...projection,
    thread,
    cursor: page.cursor,
    messages,
    runs,
    queuePaused,
    runtimeRequests,
    turnItems,
    relations,
    goal,
    usageLimitRecovery,
    rows: deriveTimelineRows(messages, runs, turnItems, relations.children),
    queuedRuns: runs.filter((run) => isQueuedRun(run)),
    activeRun,
  }
  return { projection: next, cursor: page.cursor }
}
