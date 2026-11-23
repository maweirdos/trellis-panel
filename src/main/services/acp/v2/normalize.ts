import type { SessionConfigOption } from '@agentclientprotocol/sdk/experimental/v2'
import * as Schema from 'effect/Schema'
import type { SessionNotification, SessionUpdate } from '../t3-core/compat'
import { SessionConfigSelectOptions } from '../t3-core/_generated/schema.gen'
import { acpContentBlockDisplayText, mergeToolActivityData, sessionUpdateIsReplay } from '../t3-core/runtime-model'
import { flattenSelectChoices } from '../t3-core/session-config'
import { nativeConfigOptions } from './client'
import type { AcpV2RuntimeEvent } from './types'

const MAX_REVISIONS = 256
const isSelectOptions = Schema.is(SessionConfigSelectOptions)

export interface SessionEntity<TValue> {
  readonly nativeId: string
  value: TValue
  revision: string
}

export interface NormalizedSessionState {
  readonly entities: Readonly<{
    messages: Map<string, SessionEntity<{ text: string; stream: 'output' | 'thought'; complete: boolean; tag: string; projection?: { promptTurnId?: string } }>>
    toolCalls: Map<string, SessionEntity<{ title?: string; status?: string; kind?: string; rawInput?: unknown; rawOutput?: unknown; content?: unknown[]; complete: boolean; tag: string }>>
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

type NormalizedConfigOption = {
  id: string
  name: string
  category?: string
  options: Array<{ value: string; name: string }>
} & ({ type: 'select'; currentValue: string } | { type: 'boolean'; currentValue: boolean })

export const normalizeSessionConfigOption = (input: unknown): NormalizedConfigOption | undefined => {
  const option = readRecord(input)
  const id = option?.configId ?? option?.id
  if (option === undefined || typeof id !== 'string' || typeof option.name !== 'string') return undefined
  const common = { id, name: option.name, category: readOptionalString(option.category) }
  if (option.type === 'boolean' && typeof option.currentValue === 'boolean') {
    return { ...common, type: 'boolean', currentValue: option.currentValue,
      options: [{ value: 'true', name: '开启' }, { value: 'false', name: '关闭' }] }
  }
  if (option.type !== 'select' || typeof option.currentValue !== 'string' || !isSelectOptions(option.options)) return undefined
  const values = flattenSelectChoices(option.options)
  return { ...common, type: 'select', currentValue: option.currentValue,
    options: values.map(({ value, name }) => ({ value, name })) }
}

export const hasAcpCapability = (marker: unknown): boolean => marker != null && marker !== false

export function replaceSessionConfigOptions(state: NormalizedSessionState, options: readonly SessionConfigOption[]): boolean {
  if (options.length === state.configOptions.size
    && options.every(option => JSON.stringify(option) === JSON.stringify(state.configOptions.get(option.configId)))) return false
  state.configOptions.clear()
  for (const option of options) state.configOptions.set(option.configId, option)
  return true
}

type AppliedUpdate = {
  changed: boolean
  events: AcpV2RuntimeEvent[]
  stateChanged: boolean
}

export function acceptsPromptIdle(turn: { terminal: boolean }, state: NormalizedSessionState | undefined, notification: SessionNotification): boolean {
  const { update } = notification
  if (turn.terminal || sessionUpdateIsReplay(notification) || update.sessionUpdate !== 'state_update' || update.state !== 'idle') return false
  const revision = readRevision(update)
  if (revision !== undefined && state?.seenRevisions.has(revision)) return false
  turn.terminal = true
  return true
}

export const applySessionUpdate = (
  state: NormalizedSessionState,
  notification: SessionNotification,
  promptTurnId?: string,
): AppliedUpdate => {
  const update = notification.update
  const revision = readRevision(update)
  if (revision !== undefined && state.seenRevisions.has(revision)) return { changed: false, events: [], stateChanged: false }
  if (revision !== undefined) retainRevision(state, revision)
  const cursor = notification._meta?.replayCursor
  const cursorChanged = typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 4096 && cursor !== state.replayCursor
  if (cursorChanged) state.replayCursor = cursor
  const applied = applyTaggedUpdate(state, update, promptTurnId)
  if (applied.stateChanged && revision !== undefined) {
    const terminal = state.entities.terminal.get('terminal')
    if (terminal !== undefined) terminal.revision = revision
  }
  const changed = cursorChanged || revision !== undefined || applied.changed
  return sessionUpdateIsReplay(notification)
    ? { changed, events: [], stateChanged: applied.stateChanged }
    : { ...applied, changed }
}

const applyTaggedUpdate = (state: NormalizedSessionState, update: SessionUpdate, promptTurnId?: string): AppliedUpdate => {
  const tag = update.sessionUpdate
  const events: AcpV2RuntimeEvent[] = []
  if (tag === 'state_update') {
    const previous = state.entities.terminal.get('terminal')?.value
    const stateRecord = readRecord(update)
    const currentState = readOptionalString(stateRecord?.state) ?? 'unknown'
    const stopReason = readOptionalString(stateRecord?.stopReason)
    const normalized = { state: currentState, stopReason, error: readError(stateRecord?.error), complete: currentState === 'idle', tag }
    const changed = previous === undefined || previous.state !== normalized.state || previous.stopReason !== normalized.stopReason
      || JSON.stringify(previous.error ?? null) !== JSON.stringify(normalized.error ?? null)
    upsert(state.entities.terminal, 'terminal', normalized, tag)
    if (!changed) return { changed: false, events: [], stateChanged: false }
    events.push({ type: 'status', text: normalized.state === 'idle' ? `会话空闲${normalized.stopReason ? `：${normalized.stopReason}` : ''}` : `会话状态：${normalized.state}`, tag })
    return { changed: true, events, stateChanged: true }
  }
  if (tag === 'available_commands_update') {
    state.commands.clear()
    for (const { name, description, input } of update.availableCommands) state.commands.set(name, { name, description, input })
    return { changed: true, events: [{ type: 'status', text: '命令列表已更新', tag, availableCommands: [...state.commands.values()].map(command => ({ name: command.name, description: command.description, hasInput: command.input != null })) }], stateChanged: false }
  }
  if (tag === 'config_option_update') {
    const changed = replaceSessionConfigOptions(state, nativeConfigOptions(update.configOptions))
    return changed
      ? { changed: true, events: [{ type: 'status', text: '配置选项已更新', tag }], stateChanged: false }
      : { changed: false, events: [], stateChanged: false }
  }
  switch (tag) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return applyMessage(state, tag, update.messageId, acpContentBlockDisplayText(update.content), false, promptTurnId)
    case 'user_message':
    case 'agent_message':
    case 'agent_thought':
      return applyMessage(state, tag, update.messageId, update.content === undefined ? undefined
        : (update.content ?? []).map(acpContentBlockDisplayText).filter(Boolean).join('\n'), true, promptTurnId)
  }
  if (tag === 'tool_call' || tag === 'tool_call_update' || tag === 'tool_call_content_chunk') {
    const toolCallId = update.toolCallId
    const prior = state.entities.toolCalls.get(toolCallId)?.value
    const patch = tag === 'tool_call_content_chunk'
      ? { content: [...(prior?.content ?? []), update.content] }
      : Object.fromEntries(Object.entries(update).filter(([key, value]) => key !== '_meta' && value !== undefined))
    const merged = mergeToolActivityData(prior, patch)
    const status = readOptionalString(merged?.status)
    const value = {
      title: readOptionalString(merged?.title), status, kind: readOptionalString(merged?.kind),
      rawInput: merged?.rawInput, rawOutput: merged?.rawOutput,
      content: Array.isArray(merged?.content) ? merged.content : undefined,
      complete: status === 'completed' || status === 'failed', tag,
    }
    if (JSON.stringify(prior) === JSON.stringify(value)) return { changed: false, events: [], stateChanged: false }
    upsert(state.entities.toolCalls, toolCallId, value, tag)
    return { changed: true, events: [{ type: 'tool_call', text: value.title ?? `工具调用：${toolCallId}`, tag, toolCallId,
      status, title: value.title, kind: readKind(value.kind), rawInput: value.rawInput, rawOutput: value.rawOutput, content: value.content }], stateChanged: false }
  }
  if (tag === 'plan_update') {
    const plan = readRecord(readRecord(update)?.plan)
    const planId = readNativeId(plan, ['planId'])
    if (planId === undefined) return { changed: true, events: [{ type: 'error', message: 'ACP v2 plan update lacks its native ID' }], stateChanged: false }
    const value = {
      summary: readOptionalString(plan?.content),
      entries: Array.isArray(plan?.entries) ? plan.entries : [],
      complete: true,
      tag,
    }
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
  if (tag === 'notice' || tag === 'usage_update' || tag === 'compaction_update') {
    const noticeId = readNativeId(update, ['noticeId', 'usageId', 'compactionId', 'subagentId']) ?? `${tag}:${state.entities.notices.size + 1}`
    upsert(state.entities.notices, noticeId, update as unknown as Record<string, unknown>, tag)
    const text = readOptionalString((update as unknown as Record<string, unknown>).message)
      ?? readOptionalString((update as unknown as Record<string, unknown>).summary)
      ?? `Runtime 更新：${tag}`
    return { changed: true, events: [{ type: 'status', text, tag }], stateChanged: false }
  }
  return { changed: true, events: [{ type: 'status', text: `Runtime 更新：${tag}`, tag }], stateChanged: false }
}

function applyMessage(
  state: NormalizedSessionState,
  tag: string,
  messageId: string | null | undefined,
  text: string | undefined,
  complete: boolean,
  promptTurnId?: string,
): AppliedUpdate {
  const stream = tag.startsWith('agent_thought') ? 'thought' : 'output'
  const user = tag.startsWith('user_message')
  const noChange: AppliedUpdate = { changed: false, events: [], stateChanged: false }
  if (!messageId) {
    return user || !text ? noChange : { ...noChange, events: [{ type: 'text_delta', text, stream, tag }] }
  }
  const prior = state.entities.messages.get(messageId)?.value
  if (!complete && (prior?.complete || !text)) return noChange
  const previous = prior?.text ?? ''
  const next = complete ? text ?? previous : previous + (text ?? '')
  if (prior?.complete === complete && previous === next) return noChange
  const projection = user ? prior === undefined ? { promptTurnId } : prior.projection : undefined
  upsert(state.entities.messages, messageId, { text: next, stream, complete, tag, projection }, tag)
  if (user || text === undefined || (prior !== undefined && previous === next)) return { ...noChange, changed: true }
  return { changed: true, stateChanged: false, events: [{
    type: 'text_delta', text, stream, tag, messageId,
    meta: { acpText: {
      version: 1, messageId, blockIndex: 0, blockType: stream === 'thought' ? 'thinking' : 'text',
      operation: complete ? 'replace' : 'append', ...(complete ? { authority: 'message_end' } : {}),
    } },
  }] }
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

const readRevision = (update: SessionUpdate): string | undefined => {
  const revision = '_meta' in update ? update._meta?.revision : undefined
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

const readRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const readError = (value: unknown): { message: string; code?: string } | undefined => {
  const record = readRecord(value)
  return record && typeof record.message === 'string' ? { message: record.message, code: typeof record.code === 'string' || typeof record.code === 'number' ? String(record.code) : undefined } : undefined
}

const readOptionalString = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined

const readKind = (value: unknown): 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'think' | 'switch_mode' | 'other' => {
  const values = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'think', 'switch_mode', 'other'] as const
  return values.includes(value as typeof values[number]) ? value as typeof values[number] : 'other'
}
