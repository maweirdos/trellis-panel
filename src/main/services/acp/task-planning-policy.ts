import { taskPlanningPolicySchema, type TaskPlanningPolicy } from '../../../shared/private-conversations'
import { taskInputCanonical } from '../../../shared/team-task-inputs'
import type { AcpPermissionDecision } from './v2'
import type { ConversationRuntimePermissionRequest } from '../pi/runtime-port'

type ConfigOption = { id: string; currentValue: string; options: Array<{ value: string }> }
export interface PlanningObservation {
  sessionId: string
  connectionGeneration: string
  agentId: string
  configOptions: ConfigOption[]
}
export interface PlanningPolicyPort {
  read(): Promise<PlanningObservation>
  configure(id: string, value: string): Promise<void>
  assertCurrent(): void
}
export function samePlanningPolicy(left?: TaskPlanningPolicy, right?: TaskPlanningPolicy): boolean {
  return taskInputCanonical(left ?? null) === taskInputCanonical(right ?? null)
}
export function taskPlanningModelSelection(policy: TaskPlanningPolicy): { base: string; effort: string } {
  return acpModelSelection(policy.modelId)
}
export function acpModelSelection(modelId: string): { base: string; effort: string } {
  const parsed = /^(.*)\[([a-z]+)\]$/.exec(modelId)
  if (!parsed?.[1] || !parsed[2]) throw new Error('任务规划需要执行引擎提供的完整模型与推理强度 ID。')
  return { base: parsed[1], effort: parsed[2] }
}
function option(observation: PlanningObservation, id: string): ConfigOption {
  const matches = observation.configOptions.filter(item => item.id === id)
  if (matches.length !== 1) throw new Error(`任务规划缺少唯一的原生配置：${id}`)
  return matches[0]
}
function identity(observation: PlanningObservation, expected: Pick<PlanningObservation, 'sessionId' | 'connectionGeneration'>, policy: TaskPlanningPolicy): void {
  if (observation.sessionId !== expected.sessionId || observation.connectionGeneration !== expected.connectionGeneration
    || !expected.connectionGeneration || observation.agentId !== policy.agentId) throw new Error('任务规划原生会话或连接代次已变化。')
}
export function assertPlanningObservation(policy: TaskPlanningPolicy, observation: PlanningObservation, expected: Pick<PlanningObservation, 'sessionId' | 'connectionGeneration'>): void {
  policy = taskPlanningPolicySchema.parse(policy)
  identity(observation, expected, policy)
  const model = taskPlanningModelSelection(policy)
  for (const [id, value] of [['mode', policy.mode], ['collaboration_mode', policy.collaborationMode], ['model', model.base], ['reasoning_effort', model.effort]]) {
    const actual = option(observation, id)
    if (actual.currentValue !== value || !actual.options.some(item => item.value === value)) throw new Error(`任务规划原生配置未确认：${id}`)
  }
}
/** Called only during original session creation/reconnection, before ready. */
export async function establishPlanningPolicy(raw: TaskPlanningPolicy, port: PlanningPolicyPort): Promise<PlanningObservation> {
  const policy = taskPlanningPolicySchema.parse(raw), model = taskPlanningModelSelection(policy)
  port.assertCurrent()
  let actual = await port.read()
  port.assertCurrent()
  const expected = { sessionId: actual.sessionId, connectionGeneration: actual.connectionGeneration }
  identity(actual, expected, policy)
  for (const [id, value] of [['mode', policy.mode], ['collaboration_mode', policy.collaborationMode], ['model', model.base], ['reasoning_effort', model.effort]]) {
    if (!option(actual, id).options.some(item => item.value === value)) throw new Error(`所选执行引擎不支持任务规划配置：${id}`)
    port.assertCurrent()
    await port.configure(id, value)
    port.assertCurrent()
    actual = await port.read()
    port.assertCurrent(); identity(actual, expected, policy)
    if (option(actual, id).currentValue !== value) throw new Error(`任务规划配置未被执行引擎确认：${id}`)
  }
  assertPlanningObservation(policy, actual, expected)
  return actual
}
/** Read-only final gate; never repairs changed configuration by starting work. */
export async function verifyPlanningPolicy(policy: TaskPlanningPolicy, expected: Pick<PlanningObservation, 'sessionId' | 'connectionGeneration'>, port: PlanningPolicyPort): Promise<void> {
  port.assertCurrent()
  const actual = await port.read()
  port.assertCurrent()
  assertPlanningObservation(policy, actual, expected)
}
export function rejectPlanningPermission(options: ReadonlyArray<{ readonly optionId: string; readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }>): AcpPermissionDecision {
  const safe = options.filter(item => item.optionId !== 'implement_plan' && options.filter(other => other.optionId === item.optionId).length === 1)
  const reject = ['decline', 'reject_permissions', 'revise_plan'].map(id => safe.find(item => item.optionId === id && item.kind === 'reject_once')).find(Boolean)
    ?? safe.find(item => item.optionId === 'cancel' && item.kind === 'reject_once')
  return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } }
}
export type PlanningPermissionReview = { command: string; cwd: string; details: string }
export function planningPermissionReview(toolCall: ConversationRuntimePermissionRequest['raw']['toolCall'], requestMeta: unknown,
  redact: (value: string) => string): PlanningPermissionReview | undefined {
  if (toolCall.kind !== 'execute') return undefined
  const rawInput = toolCall.rawInput
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) return undefined
  if (!('command' in rawInput) || !('cwd' in rawInput)) return undefined
  const input = rawInput
  if (typeof input.command !== 'string' || input.command.length === 0 || input.command.length > 8192
    || typeof input.cwd !== 'string' || input.cwd.length === 0 || input.cwd.length > 4096) return undefined
  try {
    // Preserve all available adapter context, including request-level metadata.
    // This is review material, not evidence of OS sandbox confinement.
    let nodes = 0
    const availableToolCall = Object.fromEntries(Object.entries(toolCall).filter(([, value]) => value != null))
    const details = JSON.stringify({ toolCall: availableToolCall, ...(requestMeta == null ? {} : { requestMeta }) }, (key, value: unknown) => {
      if (++nodes > 1024 || redact(key) !== key) throw new Error('原生审查上下文无法完整呈现')
      if (['additionalPermissions', 'networkApprovalContext', 'permissions', 'sandboxPermissions', 'sandbox_permissions', 'url'].includes(key)
        && value != null) throw new Error('额外原生权限不属于单次命令审查')
      if (typeof value === 'string' && (value.length > 16_384 || redact(value) !== value)) throw new Error('原生审查上下文需要脱敏或超过上限')
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error('原生审查上下文无法序列化')
      if (key === 'type' && value === 'diff' || key === 'name' && value === 'request_permissions') throw new Error('不允许直接编辑或额外授权')
      return value
    })
    if (details.length > 16_384 || redact(details) !== details) return undefined
    return { command: input.command, cwd: input.cwd, details }
  } catch { return undefined }
}

export type AcpConfigOptionAcknowledgement = Array<{ id: string; currentValue: string; options: Array<{ value: string }> }>
export function acpConfigOptionAcknowledgement(response: unknown): AcpConfigOptionAcknowledgement {
  if (typeof response !== 'object' || response === null || !Array.isArray((response as { configOptions?: unknown }).configOptions)) throw new Error('执行引擎未返回配置确认')
  const configOptions: unknown[] = (response as { configOptions: unknown[] }).configOptions
  const options = configOptions.filter((option: unknown): option is { type: 'select'; id: string; currentValue: string; options: Array<{ value: string } | { options: Array<{ value: string }> }> } => {
    if (typeof option !== 'object' || option === null || (option as { type?: unknown }).type !== 'select') return false
    const value = option as { id?: unknown; currentValue?: unknown; options?: unknown }
    if (typeof value.id !== 'string' || typeof value.currentValue !== 'string' || !Array.isArray(value.options)) return false
    const nested = value.options as unknown[]
    return nested.every((item: unknown): item is { value: string } | { options: Array<{ value: string }> } => {
      if (typeof item !== 'object' || item === null) return false
      const choice = item as { value?: unknown; options?: unknown }
      return typeof choice.value === 'string' || Array.isArray(choice.options) && (choice.options as unknown[]).every((child: unknown) => typeof child === 'object' && child !== null && typeof (child as { value?: unknown }).value === 'string')
    })
  })
  return options.map(option => ({
    id: option.id, currentValue: option.currentValue,
    options: option.options.flatMap(item => 'options' in item ? item.options.map(child => ({ value: child.value })) : [{ value: item.value }])
  }))
}
