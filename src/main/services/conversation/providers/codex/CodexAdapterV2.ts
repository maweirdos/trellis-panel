import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import type { OrchestrationV2ProviderTurn } from '../../../../../shared/conversation/contracts'
import type { ConversationAttachmentContent } from '../../../../../shared/conversation/attachments'
import type { ConversationRuntimeQuestion } from '../../../../../shared/conversation/command-runtime'
import type { ProviderInteractionMode, RuntimeMode } from '../../../../../shared/conversation/providerPolicy'
import type { ConversationNativeSubagentEvent } from '../../../../../shared/conversation/thread-relations'
import { nativeImageAttachment, nativeTextAttachment } from '../core/attachment-input'
import type { ConversationDriverTurnEvent, ConversationDriverWorkItem } from '../registry'
import type { CodexAppServerClient } from './app-server/client'
import type {
  V2ItemCompletedNotification__ThreadItem, V2ItemStartedNotification__ThreadItem,
  V2TurnCompletedNotification__ThreadItem, V2TurnCompletedNotification__TurnStatus,
  V2TurnPlanUpdatedNotification, V2TurnStartParams,
} from './app-server/schema'

export function codexTimestamp(seconds: number): DateTime.Utc {
  return DateTime.makeUnsafe(seconds * 1000)
}

export function mapCodexTurnStatus(
  status: V2TurnCompletedNotification__TurnStatus,
): OrchestrationV2ProviderTurn['status'] {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'interrupted':
      return 'interrupted'
    case 'failed':
      return 'failed'
    case 'inProgress':
      return 'running'
  }
}

export const buildCodexTurnStartParams = (
  input: {
    nativeThreadId: string; cwd: string; model: string; text: string; effort?: string;
    attachments?: readonly ConversationAttachmentContent[]; managedExecution?: boolean;
    ordinaryTask?: boolean; runtimeMode?: RuntimeMode; interactionMode?: ProviderInteractionMode;
  },
): V2TurnStartParams => {
  const interactiveAllowed = !input.ordinaryTask && !input.managedExecution
  const isPlanMode = interactiveAllowed && input.interactionMode === 'plan'
  const approvalPolicy: V2TurnStartParams['approvalPolicy'] = !interactiveAllowed
    ? 'never'
    : isPlanMode
      ? 'on-request'
      : input.runtimeMode === 'full-access'
        ? 'never'
        : input.runtimeMode === 'auto' || input.runtimeMode === 'auto-accept-edits'
          ? 'on-request'
          : 'untrusted'
  const sandboxPolicy: V2TurnStartParams['sandboxPolicy'] = input.ordinaryTask || isPlanMode
    ? { type: 'readOnly', networkAccess: false }
    : input.managedExecution
      ? codexWorkspaceWritePolicy(input.cwd)
      : input.runtimeMode === 'full-access'
        ? { type: 'dangerFullAccess' }
        : codexWorkspaceWritePolicy(input.cwd)
  const turnText = isPlanMode
    ? `[规划模式] 请只读勘察并输出分步实施方案与关键文件，不要修改任何代码或执行写入型命令。\n\n${input.text}`
    : input.text
  return {
    threadId: input.nativeThreadId,
    input: [{ type: 'text', text: turnText, text_elements: [] }, ...(input.attachments ?? []).map(content => {
      if (content.attachment.type !== 'image') return { type: 'text' as const, text: nativeTextAttachment(content), text_elements: [] }
      const image = nativeImageAttachment(content)
      return { type: 'image' as const, url: `data:${image.mimeType};base64,${image.data}` }
    })],
    cwd: input.cwd,
    model: input.model,
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    approvalPolicy,
    sandboxPolicy,
  }
}

export const codexWorkspaceWritePolicy = (cwd: string) => ({
  type: 'workspaceWrite' as const,
  writableRoots: [cwd],
  excludeSlashTmp: true,
  excludeTmpdirEnvVar: true,
  networkAccess: false,
})

type CodexThreadItem = V2ItemStartedNotification__ThreadItem | V2ItemCompletedNotification__ThreadItem
  | V2TurnCompletedNotification__ThreadItem

function clipText(text: string, maximum: number): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maximum).trimEnd()
}

function toolLabel(name: string, fallback: string): string {
  const trimmed = name.trim()
  return /^[a-z][\w.-]{0,79}$/i.test(trimmed) ? trimmed : fallback
}

const SHELL_WRAPPER_PREFIX = /^(?:["']?(?:(?:[a-z]:[\\/]+|\/)?(?:[^\r\n"']*[\\/])?)?(?:pwsh|powershell)(?:\.exe)?["']?(?:\s+-(?:nologo|noprofile|noninteractive|sta|mta|executionpolicy\s+\S+))*\s+-(?:c|command)\s+|["']?(?:(?:[a-z]:[\\/]+|\/)?(?:[^\r\n"']*[\\/])?)?cmd(?:\.exe)?["']?(?:\s+\/[a-z])*\s+\/c\s+|["']?(?:\/usr\/bin\/env\s+)?(?:\/[^\s"']*\/)?(?:bash|sh|zsh)["']?\s+-[a-z]*c\s+)/i

function unwrapQuotedShellArg(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' || first === "'") && last === first) {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').trim()
    }
  }
  if ((trimmed.startsWith('"') || trimmed.startsWith("'")) && !trimmed.slice(1).includes(trimmed[0])) {
    return trimmed.slice(1).trim()
  }
  return trimmed
}

function summarizeCommand(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  if (!oneLine) return undefined
  const matched = SHELL_WRAPPER_PREFIX.test(oneLine)
  const stripped = matched ? unwrapQuotedShellArg(oneLine.replace(SHELL_WRAPPER_PREFIX, '')) : oneLine
  const summary = clipText(stripped || oneLine, 120)
  return summary || undefined
}

const ARTIFACT_ACTION_LABELS: Record<string, string> = {
  quickstart: '匹配产物类型',
  list: '查看已有产物',
  publish: '发布产物',
  read: '读取产物',
  open: '打开产物',
  call: '执行产物操作',
  adopt: '接入产物',
  delete: '删除产物',
  share: '分享产物',
}

function summarizeToolCall(tool: string, rawArgs: unknown, fallback: string): { label: string; detail?: string; mono?: boolean } {
  const name = toolLabel(tool, fallback)
  const rec = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs as Record<string, unknown>
    : null
  if (!rec) return { label: name }
  const str = (key: string): string | undefined => {
    const value = rec[key]
    return typeof value === 'string' && value.trim() ? clipText(value.replace(/\s+/g, ' '), 100) : undefined
  }
  if (name === 'Artifact') {
    const action = str('action')
    const label = (action && ARTIFACT_ACTION_LABELS[action]) || '操作产物'
    const target = str('title') ?? str('type') ?? str('type_url')?.replace(/^open-artifact:\/\/type\//, '') ?? str('intent') ?? str('name') ?? str('path')
    return { label, ...(target ? { detail: target } : {}) }
  }
  if (name === 'ArtifactData') {
    const action = str('action')
    const target = str('collection') ?? str('path') ?? str('doc_id')
    return { label: action ? `产物数据 · ${action}` : '产物数据', ...(target ? { detail: target, mono: true } : {}) }
  }
  if (name === 'ArtifactComments') {
    const action = str('action')
    const target = str('text')
    return { label: action ? `产物批注 · ${action}` : '产物批注', ...(target ? { detail: target } : {}) }
  }
  const detail = str('command') ?? str('path') ?? str('file_path') ?? str('query') ?? str('url') ?? str('title') ?? str('name') ?? str('action')
  const mono = Boolean(str('command') || str('path') || str('file_path') || str('url'))
  return { label: name, ...(detail ? { detail, mono } : {}) }
}

function basenameOf(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean)
  const leaf = parts.at(-1)
  return leaf ? clipText(leaf, 100) : undefined
}

function workStatus(status: 'inProgress' | 'completed' | 'failed' | 'declined'): 'running' | 'completed' | 'failed' | 'cancelled' {
  if (status === 'inProgress') return 'running'
  if (status === 'declined') return 'cancelled'
  return status
}

function mapCodexWorkItem(item: CodexThreadItem, complete: boolean): ConversationDriverWorkItem | undefined {
  const nativeItemId = item.id
  if (!nativeItemId || nativeItemId.length > 512) return undefined
  switch (item.type) {
    case 'commandExecution': {
      const command = summarizeCommand(item.command) ?? '运行命令'
      const rawOutput = 'aggregatedOutput' in item && typeof item.aggregatedOutput === 'string'
        ? item.aggregatedOutput.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        : undefined
      const output = rawOutput ? (rawOutput.length > 6_000 ? `…${rawOutput.slice(-5999)}` : rawOutput) : undefined
      const exitCode = 'exitCode' in item && typeof item.exitCode === 'number' && Number.isSafeInteger(item.exitCode)
        ? item.exitCode
        : undefined
      return {
        kind: 'command-execution',
        nativeItemId,
        command,
        ...(output ? { output } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        status: workStatus(item.status),
      }
    }
    case 'fileChange': {
      const retain = item.changes.length > 0 && item.changes.length <= 8 &&
        item.changes.every(change => change.path.length <= 1024 && !(change.kind.type === 'update' && change.kind.move_path))
      const firstPath = basenameOf(item.changes[0]?.path)
      return { kind: 'tool', nativeItemId, label: '修改文件', ...(firstPath ? { detail: firstPath, mono: true } : {}), status: workStatus(item.status),
        ...(retain && { fileChanges: item.changes.map(change => ({
          path: change.path, operation: change.kind.type,
          ...(complete && item.status === 'completed' &&
            change.diff.length <= 4_096 && { diff: change.diff }),
        })) }),
      }
    }
    case 'mcpToolCall': {
      const info = summarizeToolCall(item.tool, item.arguments, 'MCP 工具')
      return { kind: 'tool', nativeItemId, ...info, status: workStatus(item.status) }
    }
    case 'dynamicToolCall': {
      const info = summarizeToolCall(item.tool, item.arguments, '调用工具')
      return { kind: 'tool', nativeItemId, ...info, status: workStatus(item.status) }
    }
    case 'webSearch': {
      const detail = item.query ? clipText(item.query, 100) : undefined
      return { kind: 'web-search', nativeItemId, ...(detail ? { query: detail } : {}), status: complete ? 'completed' : 'running' }
    }
    case 'imageView': {
      const detail = basenameOf(item.path)
      return { kind: 'tool', nativeItemId, label: '查看图片', ...(detail ? { detail, mono: true } : {}), status: complete ? 'completed' : 'running' }
    }
    case 'plan': {
      const markdown = complete && clipText(item.text, 8_000)
      return markdown ? { kind: 'proposed-plan', nativeItemId, markdown } : undefined
    }
    case 'reasoning': {
      const parts = [
        ...(item.summary ?? []),
        ...((item.summary?.length ?? 0) === 0 ? (item.content ?? []) : []),
      ]
        .map(part => part.trim())
        .filter(Boolean)
      const text = clipText(parts.join('\n\n'), 8_000)
      return text ? { kind: 'reasoning', nativeItemId, text, streaming: !complete } : undefined
    }
    default:
      return undefined
  }
}

function mapCodexPlan(payload: V2TurnPlanUpdatedNotification): ConversationDriverWorkItem {
  const explanation = payload.explanation ? clipText(payload.explanation, 1_000) : undefined
  return {
    kind: 'plan-steps',
    steps: payload.plan.slice(0, 24).map((step, index) => ({
      text: clipText(step.step, 240) || `步骤 ${index + 1}`,
      status: step.status === 'inProgress' ? 'running' : step.status,
    })),
    ...(explanation && { explanation }),
  }
}

function codexNativeActivities(item: CodexThreadItem, turnId: string): readonly ConversationNativeSubagentEvent[] {
  const title = 'Codex 子代理'
  if (item.type === 'subAgentActivity') return [{
    type: 'native-subagent', turnId, activityId: item.agentThreadId || item.id, title,
    status: item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'cancelled' : 'running',
  }]
  if (item.type !== 'collabAgentToolCall') return []
  const receivers = Array.from(new Set(item.receiverThreadIds)).slice(0, 32)
  if (!receivers.length) return [{
    type: 'native-subagent', turnId, activityId: item.id, title,
    status: item.status === 'inProgress' ? 'running' : item.status === 'interrupted' ? 'cancelled' : item.status,
  }]
  return receivers.map(activityId => {
    const native = Object.hasOwn(item.agentsStates, activityId) ? item.agentsStates[activityId]?.status : undefined
    const status = native === 'completed' ? 'completed'
      : native === 'interrupted' || native === 'shutdown' ? 'cancelled'
        : native === 'notFound' || native === 'errored' || (!native && item.status === 'failed') ? 'failed'
          : native === 'pendingInit' ? 'waiting' : 'running'
    return { type: 'native-subagent', turnId, activityId, title, status }
  })
}

function extractAsyncAgentQuestions(
  rawQuestions: ReadonlyArray<{ readonly title: string; readonly options?: ReadonlyArray<string> | null }> | null | undefined,
): readonly ConversationRuntimeQuestion[] {
  if (!rawQuestions?.length) return []
  const questions: ConversationRuntimeQuestion[] = []
  for (const [index, question] of rawQuestions.slice(0, 32).entries()) {
    const prompt = clipText(question.title, 4_000)
    if (!prompt) continue
    const seen = new Set<string>()
    const choices: Array<{ readonly value: string; readonly label: string }> = []
    for (const rawOption of (question.options ?? []).slice(0, 32)) {
      const label = clipText(rawOption, 512)
      if (!label || seen.has(label)) continue
      seen.add(label)
      choices.push({ value: label, label })
    }
    questions.push({
      id: `q_${index}`,
      prompt,
      ...(choices.length ? { choices } : {}),
      allowCustom: true,
    })
  }
  return questions
}

export const observeCodexTurns = Effect.fn('CodexAdapterV2.observeTurns')(function* (
  client: CodexAppServerClient['Service'],
  emit: (threadId: string, event: ConversationDriverTurnEvent) => void,
  identifyCompaction: (threadId: string, turnId: string) => void,
) {
  const emittedAsyncQuestions = new Set<string>()
  const reasoningBuffers = new Map<string, { parts: string[]; lastEmittedLen: number }>()
  const commandOutputBuffers = new Map<string, { command: string; output: string; lastEmittedLen: number }>()
  const emitReasoningUpdate = (threadId: string, turnId: string, itemId: string, streaming: boolean, fallbackText?: string): void => {
    const buffer = reasoningBuffers.get(itemId)
    const joined = buffer ? buffer.parts.map(part => part.trim()).filter(Boolean).join('\n\n') : ''
    const text = clipText(joined || fallbackText || '', 8_000)
    if (!text) return
    if (streaming && buffer) {
      const delta = text.length - buffer.lastEmittedLen
      if (buffer.lastEmittedLen > 0 && delta < 24 && !text.endsWith('\n')) return
      buffer.lastEmittedLen = text.length
    }
    emit(threadId, { type: 'work-item', turnId, item: { kind: 'reasoning', nativeItemId: itemId, text, streaming } })
  }
  const emitAgentMessage = (
    threadId: string,
    turnId: string,
    item: Extract<CodexThreadItem, { readonly type: 'agentMessage' }>,
  ): void => {
    if (item.text) {
      emit(threadId, { type: 'text-final', text: item.text, itemId: item.id, turnId })
    }
    if (!item.questions?.length || !item.id || emittedAsyncQuestions.has(item.id)) return
    const questions = extractAsyncAgentQuestions(item.questions)
    if (!questions.length) return
    if (emittedAsyncQuestions.size >= 512) emittedAsyncQuestions.clear()
    emittedAsyncQuestions.add(item.id)
    emit(threadId, {
      type: 'runtime-request',
      nativeRequestId: `async:${item.id}`,
      turnId,
      request: {
        kind: 'user-input',
        title: '请选择你的方向',
        responseMode: 'message',
        questions,
      },
    })
  }
  const emitWorkItem = (threadId: string, turnId: string, nativeItem: CodexThreadItem, complete: boolean): void => {
    if (nativeItem.type === 'contextCompaction') identifyCompaction(threadId, turnId)
    for (const event of codexNativeActivities(nativeItem, turnId)) emit(threadId, event)
    if (nativeItem.type === 'reasoning') {
      const mapped = mapCodexWorkItem(nativeItem, complete)
      const fallbackText = mapped?.kind === 'reasoning' ? mapped.text : undefined
      emitReasoningUpdate(threadId, turnId, nativeItem.id, !complete, fallbackText)
      if (complete) reasoningBuffers.delete(nativeItem.id)
      return
    }
    if (nativeItem.type === 'commandExecution') {
      if (!complete) {
        const command = summarizeCommand(nativeItem.command) ?? '运行命令'
        if (commandOutputBuffers.size >= 128) commandOutputBuffers.clear()
        commandOutputBuffers.set(nativeItem.id, { command, output: '', lastEmittedLen: 0 })
      } else {
        commandOutputBuffers.delete(nativeItem.id)
      }
    }
    const item = mapCodexWorkItem(nativeItem, complete)
    if (item) emit(threadId, { type: 'work-item', turnId, item })
  }
  yield* client.handleServerNotification('item/commandExecution/outputDelta', payload => Effect.sync(() => {
    if (!payload.itemId || !payload.delta) return
    const existing = commandOutputBuffers.get(payload.itemId) ?? { command: '运行命令', output: '', lastEmittedLen: 0 }
    const combined = `${existing.output}${payload.delta}`
    const trimmed = combined.length > 6_000 ? `…${combined.slice(-5999)}` : combined
    existing.output = trimmed
    if (commandOutputBuffers.size >= 128 && !commandOutputBuffers.has(payload.itemId)) commandOutputBuffers.clear()
    commandOutputBuffers.set(payload.itemId, existing)
    if (existing.lastEmittedLen > 0 && trimmed.length - existing.lastEmittedLen < 120 && !payload.delta.includes('\n')) return
    existing.lastEmittedLen = trimmed.length
    emit(payload.threadId, {
      type: 'work-item',
      turnId: payload.turnId,
      item: {
        kind: 'command-execution',
        nativeItemId: payload.itemId,
        command: existing.command,
        output: trimmed,
        status: 'running',
      },
    })
  }))
  yield* client.handleServerNotification('turn/started', payload => Effect.sync(() => {
    const startedAt = payload.turn.startedAt
    emit(payload.threadId, {
      type: 'turn-accepted', turnId: payload.turn.id,
      ...(typeof startedAt === 'number' ? { nativeStartedAt: DateTime.formatIso(codexTimestamp(startedAt)) } : {}),
    })
  }))
  yield* client.handleServerNotification('item/agentMessage/delta', payload => Effect.sync(() =>
    emit(payload.threadId, { type: 'text-delta', text: payload.delta, itemId: payload.itemId, turnId: payload.turnId }),
  ))
  yield* client.handleServerNotification('item/reasoning/summaryPartAdded', payload => Effect.sync(() => {
    if (!payload.itemId || payload.summaryIndex < 0 || payload.summaryIndex > 64) return
    const entry = reasoningBuffers.get(payload.itemId) ?? { parts: [], lastEmittedLen: 0 }
    entry.parts[payload.summaryIndex] ??= ''
    reasoningBuffers.set(payload.itemId, entry)
  }))
  yield* client.handleServerNotification('item/reasoning/summaryTextDelta', payload => Effect.sync(() => {
    if (!payload.itemId || !payload.delta || payload.summaryIndex < 0 || payload.summaryIndex > 64) return
    const entry = reasoningBuffers.get(payload.itemId) ?? { parts: [], lastEmittedLen: 0 }
    entry.parts[payload.summaryIndex] = (entry.parts[payload.summaryIndex] ?? '') + payload.delta
    if (reasoningBuffers.size >= 128 && !reasoningBuffers.has(payload.itemId)) reasoningBuffers.clear()
    reasoningBuffers.set(payload.itemId, entry)
    emitReasoningUpdate(payload.threadId, payload.turnId, payload.itemId, true)
  }))
  yield* client.handleServerNotification('item/started', payload => Effect.sync(() =>
    emitWorkItem(payload.threadId, payload.turnId, payload.item, false),
  ))
  yield* client.handleServerNotification('turn/plan/updated', payload => Effect.sync(() =>
    emit(payload.threadId, { type: 'work-item', turnId: payload.turnId, item: mapCodexPlan(payload) }),
  ))
  yield* client.handleServerNotification('thread/tokenUsage/updated', ({ threadId, turnId, tokenUsage }) => Effect.sync(() => {
    const { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens } = tokenUsage.last
    const contextWindow = tokenUsage.modelContextWindow
    if (![inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) return
    emit(threadId, { type: 'usage', turnId, usage: {
      inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens,
      ...(contextWindow != null && Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    } })
  }))
  yield* client.handleServerNotification('item/completed', payload => Effect.sync(() => {
    if (payload.item.type === 'agentMessage') {
      emitAgentMessage(payload.threadId, payload.turnId, payload.item)
    } else emitWorkItem(payload.threadId, payload.turnId, payload.item, true)
  }))
  yield* client.handleServerNotification('turn/completed', payload => Effect.sync(() => {
    for (const item of payload.turn.items) {
      if (item.type === 'agentMessage') {
        emitAgentMessage(payload.threadId, payload.turn.id, item)
      } else emitWorkItem(payload.threadId, payload.turn.id, item, true)
    }
    emit(payload.threadId, {
      type: 'turn-completed', turnId: payload.turn.id,
      status: mapCodexTurnStatus(payload.turn.status), error: payload.turn.error?.message,
    })
  }))
})
