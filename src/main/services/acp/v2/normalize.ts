import type { ContentBlock, SessionConfigOption, UpdateSessionNotification } from '@agentclientprotocol/sdk/experimental/v2'
import type { AcpV2RuntimeEvent } from './types'

const TEXT_TAG_STREAM: Record<string, 'output' | 'thought'> = {
  user_message: 'output',
  user_message_chunk: 'output',
  agent_message: 'output',
  agent_message_chunk: 'output',
  agent_thought: 'thought',
  agent_thought_chunk: 'thought',
}

const MAX_REVISIONS = 256

export interface SessionEntity<TValue> {
  readonly nativeId: string
  value: TValue
  revision: string
}

export interface NormalizedSessionState {
  readonly entities: Readonly<{
    messages: Map<string, SessionEntity<{ text: string; stream: 'output' | 'thought'; complete: boolean; tag: string }>>
    toolCalls: Map<string, SessionEntity<{ title?: string; status?: string; kind?: string; rawInput?: unknown; content?: unknown[]; complete: boolean; tag: string }>>
    plans: Map<string, SessionEntity<{ summary?: string; entries: unknown[]; complete: boolean; tag: string }>>
    terminal: Map<string, SessionEntity<{ state: string; stopReason?: string; error?: unknown; complete: boolean; tag: string }>>
    sessionInfo: Map<string, SessionEntity<Record<string, unknown>>>
    notices: Map<string, SessionEntity<Record<string, unknown>>>
  }>
  readonly configOptions: Map<string, SessionConfigOption>
  readonly commands: Map<string, { name: string; description?: string; input?: unknown }>
  readonly revisionOrder: string[]
  readonly seenRevisions: Set<string>
  replayCursor?: string
}

export const createSessionState = (): NormalizedSessionState => ({
  entities: {
    messages: new Map(),
    toolCalls: new Map(),
    plans: new Map(),
    terminal: new Map(),
    sessionInfo: new Map(),
    notices: new Map(),
  },
  configOptions: new Map(),
  commands: new Map(),
  revisionOrder: [],
  seenRevisions: new Set(),
})

export const sessionStateKey = (sessionId: string, state: string, stopReason: unknown, previousState?: string): string =>
  JSON.stringify([sessionId, previousState ?? '', state, typeof stopReason === 'string' ? stopReason : null])

export const normalizeSessionConfigOption = (option: SessionConfigOption): {
  id: string
  name: string
  category?: string
  currentValue: string
  options: Array<{ value: string; name: string }>
} | undefined => {
  if (option.type !== 'select') return undefined
  const rawOptions = (option as { options?: unknown }).options as Array<Record<string, unknown>> | undefined
  if (rawOptions === undefined) return undefined
  const values = rawOptions.flatMap(entry => Array.isArray(entry.options)
    ? entry.options.map(child => ({ value: String(child.value), name: String(child.name) }))
    : [{ value: String(entry.value), name: String(entry.name) }])
  return { id: option.configId, name: option.name, category: option.category ?? undefined, currentValue: String((option as { currentValue?: unknown }).currentValue ?? ''), options: values }
}

export const applySessionUpdate = (
  state: NormalizedSessionState,
  notification: UpdateSessionNotification,
): { changed: boolean; events: AcpV2RuntimeEvent[]; stateChanged: boolean; terminal?: { stopReason?: string; error?: { message: string; code?: string } } } => {
  const update = notification.update
  const revision = readRevision(update)
  if (revision !== undefined && state.seenRevisions.has(revision)) return { changed: false, events: [], stateChanged: false }
  if (revision !== undefined) retainRevision(state, revision)
  if (notification._meta?.replayCursor !== undefined && typeof notification._meta.replayCursor === 'string') state.replayCursor = notification._meta.replayCursor
  const applied = applyTaggedUpdate(state, update)
  if (applied.stateChanged && revision !== undefined) {
    const terminal = state.entities.terminal.get('terminal')
    if (terminal !== undefined) terminal.revision = revision
  }
  return applied
}

const applyTaggedUpdate = (state: NormalizedSessionState, update: UpdateSessionNotification['update']): { changed: boolean; events: AcpV2RuntimeEvent[]; stateChanged: boolean; terminal?: { stopReason?: string; error?: { message: string; code?: string } } } => {
  const tag = update.sessionUpdate
  const events: AcpV2RuntimeEvent[] = []
  if (tag === 'state_update') {
    const previous = state.entities.terminal.get('terminal')?.value
    const stateRecord = readRecord(update)
    const currentState = readOptionalString(stateRecord?.state) ?? 'unknown'
    const stopReason = readOptionalString(stateRecord?.stopReason)
    const normalized = { state: currentState, stopReason, error: readError(stateRecord?.error), complete: currentState === 'idle', tag }
    const changed = previous === undefined || previous.state !== normalized.state || previous.stopReason !== normalized.stopReason || previous.complete !== normalized.complete
    upsert(state.entities.terminal, 'terminal', normalized, tag)
    if (!changed) return { changed: false, events: [], stateChanged: false }
    events.push({ type: 'status', text: normalized.state === 'idle' ? `会话空闲${normalized.stopReason ? `：${normalized.stopReason}` : ''}` : `会话状态：${normalized.state}`, tag })
    if (normalized.state !== 'idle') return { changed: true, events, stateChanged: true }
    const transitionedToIdle = previous === undefined || previous.state !== 'idle' || !previous.complete || previous.stopReason !== normalized.stopReason
    return {
      changed: true,
      events,
      stateChanged: true,
      terminal: transitionedToIdle || previous === undefined ? { stopReason: normalized.stopReason, error: normalized.error } : undefined,
    }
  }
  if (tag === 'available_commands_update') {
    const commands = readRecord(update)?.availableCommands
    if (Array.isArray(commands)) {
      for (const command of commands.map(readRecord).filter((entry): entry is Record<string, unknown> => entry !== undefined)) {
        const name = readOptionalString(command.name)
        const description = readOptionalString(command.description)
        const input = command.input
        if (name !== undefined) state.commands.set(name, { name, description, input })
      }
    }
    return { changed: true, events: [{ type: 'status', text: '命令列表已更新', tag, availableCommands: [...state.commands.values()].map(command => ({ name: command.name, description: command.description, hasInput: command.input !== undefined })) }], stateChanged: false }
  }
  if (tag === 'config_option_update') {
    const record = readRecord(update)
    const configId = readOptionalString(record?.configId)
    const currentValue = readOptionalString(record?.currentValue)
    const existing = configId === undefined ? undefined : state.configOptions.get(configId)
    if (configId !== undefined && existing !== undefined && existing.type === 'select' && currentValue !== undefined && existing.currentValue !== currentValue) {
      state.configOptions.set(configId, { ...existing, currentValue })
      return { changed: true, events: [{ type: 'status', text: `配置已更新：${configId}`, tag }], stateChanged: false }
    }
    return { changed: false, events: [], stateChanged: false }
  }
  if (TEXT_TAG_STREAM[tag] !== undefined) {
    const stream = TEXT_TAG_STREAM[tag]
    const messageId = readNativeId(update, ['messageId'])
    if (messageId === undefined) return { changed: true, events: [{ type: 'error', message: 'ACP v2 message update lacks its native ID' }], stateChanged: false }
    const complete = tag.endsWith('_chunk') === false
    const rawContent = readRecord(update)?.content
    const contentArray = Array.isArray(rawContent) ? rawContent.filter((item): item is ContentBlock => typeof item === 'object' && item !== null && 'type' in item) : undefined
    const contentBlock = typeof rawContent === 'object' && rawContent !== null && 'type' in rawContent && rawContent.type === 'text' ? rawContent as ContentBlock : undefined
    const incoming = contentArray ?? contentBlock
    const incomingText = readContentText(incoming)
    const entity = state.entities.messages.get(messageId)
    const previousText = entity?.value.text ?? ''
    const text = complete
      ? incomingText ?? previousText
      : incomingText === undefined ? previousText : previousText + incomingText
    if (entity !== undefined && (!complete || entity.value.complete)) {
      if (entity.value.text === text) return { changed: false, events: [], stateChanged: false }
      entity.value = { ...entity.value, text, complete: entity.value.complete || complete }
    } else {
      upsert(state.entities.messages, messageId, { text, stream, complete, tag }, tag)
    }
    return { changed: true, events: [{ type: 'text_delta', text, stream, tag, messageId }], stateChanged: false }
  }
  if (tag === 'tool_call_update' || tag === 'tool_call_content_chunk' || tag === 'terminal_update') {
    const record = readRecord(update)
    const toolCall = readRecord(record?.toolCall)
    const terminalUpdate = readRecord(record?.terminalUpdate)
    const toolCallId = readNativeId(toolCall, ['toolCallId']) ?? readNativeId(terminalUpdate, ['terminalId'])
    if (toolCallId === undefined) return { changed: true, events: [{ type: 'error', message: 'ACP v2 tool update lacks its native ID' }], stateChanged: false }
    const prior = state.entities.toolCalls.get(toolCallId)?.value
    const source = toolCall ?? terminalUpdate
    const rawContent = source?.content ?? source?.output
    const content = Array.isArray(rawContent) ? rawContent : prior?.content
    const value = { title: readOptionalString(source?.title ?? source?.command) ?? prior?.title, status: readOptionalString(source?.status) ?? prior?.status, kind: readOptionalString(source?.kind) ?? prior?.kind, rawInput: source?.rawInput ?? prior?.rawInput, content, complete: tag !== 'tool_call_content_chunk', tag }
    upsert(state.entities.toolCalls, toolCallId, value, tag)
    return { changed: true, events: [{ type: 'tool_call', text: value.title ?? `工具调用：${toolCallId}`, tag, toolCallId, status: value.status, title: value.title, kind: readKind(value.kind), rawInput: value.rawInput, content: value.content }], stateChanged: false }
  }
  if (tag === 'plan_update') {
    const planId = readNativeId(update, ['planId'])
    if (planId === undefined) return { changed: true, events: [{ type: 'error', message: 'ACP v2 plan update lacks its native ID' }], stateChanged: false }
    const record = readRecord(update)
    const content = readRecord(record?.content)
    const value = { summary: readOptionalString(content?.summary) ?? readOptionalString(content?.markdown), entries: Array.isArray(content?.entries) ? content.entries : [], complete: true, tag }
    upsert(state.entities.plans, planId, value, tag)
    return { changed: true, events: [{ type: 'status', text: value.summary ?? `计划已更新：${planId}`, tag }], stateChanged: false }
  }
  if (tag === 'plan_removed') {
    const planId = readNativeId(update, ['planId'])
    if (planId !== undefined && state.entities.plans.delete(planId)) return { changed: true, events: [{ type: 'status', text: `计划已移除：${planId}`, tag }], stateChanged: false }
    return { changed: false, events: [], stateChanged: false }
  }
  if (tag === 'session_info_update') {
    const infoId = readNativeId(update, ['sessionId']) ?? 'current'
    upsert(state.entities.sessionInfo, infoId, update as unknown as Record<string, unknown>, tag)
    return { changed: true, events: [{ type: 'status', text: '会话信息已更新', tag }], stateChanged: false }
  }
  if (tag === 'notice' || tag === 'usage_update' || tag === 'compaction_update' || tag === 'subagent_update') {
    const noticeId = readNativeId(update, ['noticeId', 'usageId', 'compactionId', 'subagentId']) ?? `${tag}:${state.entities.notices.size + 1}`
    upsert(state.entities.notices, noticeId, update as unknown as Record<string, unknown>, tag)
    const text = readOptionalString((update as unknown as Record<string, unknown>).message)
      ?? readOptionalString((update as unknown as Record<string, unknown>).summary)
      ?? `Runtime 更新：${tag}`
    return { changed: true, events: [{ type: 'status', text, tag }], stateChanged: false }
  }
  return { changed: true, events: [{ type: 'status', text: `Runtime 更新：${tag}`, tag }], stateChanged: false }
}

const upsert = <TValue>(map: Map<string, SessionEntity<TValue>>, nativeId: string, value: TValue, revision: string): SessionEntity<TValue> => {
  const existing = map.get(nativeId)
  if (existing !== undefined) {
    existing.value = value
    if (revision.length > 0) existing.revision = revision
    return existing
  }
  const created: SessionEntity<TValue> = { nativeId, value, revision }
  map.set(nativeId, created)
  return created
}

const retainRevision = (state: NormalizedSessionState, revision: string): void => {
  if (state.seenRevisions.has(revision)) return
  state.seenRevisions.add(revision)
  state.revisionOrder.push(revision)
  if (state.revisionOrder.length > MAX_REVISIONS) {
    const removed = state.revisionOrder.shift()
    if (removed !== undefined) state.seenRevisions.delete(removed)
  }
}

const readRevision = (update: UpdateSessionNotification['update']): string | undefined => {
  const meta = (update as unknown as { readonly _meta?: Record<string, unknown> })._meta
  const revision = meta?.revision
  return typeof revision === 'string' && revision.length > 0 ? revision : undefined
}

const readNativeId = (value: unknown, fields: readonly string[]): string | undefined => {
  const record = readRecord(value)
  for (const field of fields) {
    const candidate = record?.[field]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

const readContentText = (value: ContentBlock | readonly ContentBlock[] | undefined | null): string | undefined => {
  if (value === undefined) return undefined
  const blocks = Array.isArray(value) ? value : [value]
  const text = blocks.filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return text.length > 0 ? text : undefined
}

const readRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const readError = (value: unknown): { message: string; code?: string } | undefined => {
  const record = readRecord(value)
  return record && typeof record.message === 'string' ? { message: record.message, code: typeof record.code === 'string' ? record.code : undefined } : undefined
}

const readOptionalString = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined

const readKind = (value: unknown): 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'think' | 'switch_mode' | 'other' => {
  const values = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'think', 'switch_mode', 'other'] as const
  return values.includes(value as typeof values[number]) ? value as typeof values[number] : 'other'
}
