/**
 * ZCode Protocol → ACP v1 纯函数翻译层。
 *
 * 方法名 / 事件名 / payload 形态以任务 `research/protocol-mapping.md`（Phase 0 实测定稿）为准，
 * 样例帧取自其 §4。本文件保持零导入、零进程副作用，便于表驱动单测
 * （scripts/smoke/acp-zcode-translate.mjs）。语法仅限可擦除 TS（无 enum/namespace），
 * 以便适配器由 Node 内置类型剥离直接加载（Node >= 22.18 默认开启）。
 *
 * 入站校验说明：为满足「适配器零 npm 运行时依赖」（随应用 resources 复制、无 node_modules），
 * 这里使用手写守卫（guarded field access）替代 zod；宽进严出，未知字段原样忽略。
 */

/* ---------- 守卫工具（不入站不信任，全部容错返回空值） ---------- */

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/* ---------- 模型 ID 编解码 ---------- */

export interface ZcodeModelRef {
  providerId: string
  modelId: string
}

/** ACP modelId 编码为 `providerId/modelId`（protocol-mapping §5 提案）；providerId 取首个 '/' 前缀。 */
export function encodeModelId(model: ZcodeModelRef): string {
  return `${model.providerId}/${model.modelId}`
}

export function decodeModelId(raw: unknown): ZcodeModelRef | undefined {
  if (typeof raw !== 'string') return undefined
  const separator = raw.indexOf('/')
  if (separator <= 0 || separator >= raw.length - 1) return undefined
  return { providerId: raw.slice(0, separator), modelId: raw.slice(separator + 1) }
}

/* ---------- 会话快照 → ACP modes / model config option ---------- */

export interface AcpSessionMode {
  id: string
  name: string
}

export interface AcpModesState {
  currentModeId: string
  availableModes: AcpSessionMode[]
}

export interface AcpSelectOption {
  value: string
  name: string
}

/** category:'model' 的 select config option 是 acpx 的模型选择权威通道。 */
export interface AcpModelConfigOption {
  id: string
  name: string
  type: 'select'
  category: 'model'
  currentValue: string
  options: AcpSelectOption[]
}

/** ZCode 模式是协议固定枚举（protocol-mapping §1 session/create mode enum）。 */
export const ZCODE_MODES: AcpSessionMode[] = [
  { id: 'plan', name: '规划' },
  { id: 'build', name: '构建' },
  { id: 'edit', name: '编辑' },
  { id: 'yolo', name: 'YOLO' },
  { id: 'guarded', name: '受控' },
  { id: 'auto', name: '自动' }
]

export function modesFromSnapshot(snapshot: unknown): AcpModesState {
  const settings = asRecord(asRecord(snapshot).settings)
  const raw = stringField(asRecord(settings.mode), 'current') ?? 'build'
  const current = effectiveMode(raw, asRecord(asRecord(snapshot).session).planEnabled === true)
  const known = ZCODE_MODES.some((mode) => mode.id === current)
  return {
    currentModeId: current,
    availableModes: known ? ZCODE_MODES : [...ZCODE_MODES, { id: current, name: current }]
  }
}

/** ZCode 的 'plan' 是 planEnabled 覆盖层而非独立 mode 值（实测：setMode('plan') 时 mode 保持不变）；
 * ACP 侧以组合后的用户可感模式呈现。 */
function effectiveMode(mode: string, planEnabled: boolean): string {
  return planEnabled && mode !== 'plan' ? 'plan' : mode
}

export const MODEL_CONFIG_ID = 'zcode.model'

export function modelConfigOptionFromSnapshot(snapshot: unknown): AcpModelConfigOption | undefined {
  const settings = asRecord(asRecord(snapshot).settings)
  const available = settings.model ? asRecord(settings.model).available : undefined
  if (!Array.isArray(available)) return undefined
  const refs = new Map<string, { providerId: string; modelId: string; label: string; providerLabel: string }>()
  for (const entry of available) {
    const record = asRecord(entry)
    const ref = asRecord(record.ref)
    const providerId = stringField(ref, 'providerId')
    const modelId = stringField(ref, 'modelId')
    if (!providerId || !modelId) continue
    const value = encodeModelId({ providerId, modelId })
    if (!refs.has(value)) refs.set(value, { providerId, modelId,
      label: stringField(record, 'label') ?? modelId,
      providerLabel: stringField(record, 'providerLabel') ?? providerId })
  }
  const modelCounts = new Map<string, number>()
  const labelCounts = new Map<string, number>()
  for (const ref of refs.values()) {
    modelCounts.set(ref.modelId, (modelCounts.get(ref.modelId) ?? 0) + 1)
    labelCounts.set(ref.label, (labelCounts.get(ref.label) ?? 0) + 1)
  }
  // Display names explain provider identity; selection always uses the original
  // negotiated wire reference. Neither labels nor legacy files add candidates.
  const qualified = [...refs].map(([value, ref]) => ({ value,
    name: !/^(?:account|builtin):/.test(ref.providerId) || (modelCounts.get(ref.modelId) ?? 0) > 1 || (labelCounts.get(ref.label) ?? 0) > 1
      ? `${ref.providerLabel} › ${ref.label}` : ref.label }))
  const names = new Map<string, number>()
  for (const option of qualified) names.set(option.name, (names.get(option.name) ?? 0) + 1)
  const options: AcpSelectOption[] = qualified.map(option => ({ ...option,
    name: (names.get(option.name) ?? 0) > 1 ? `${option.name} · ${option.value}` : option.name }))
  const session = asRecord(asRecord(snapshot).session)
  // Native settings.current is the acknowledged selection; lastUsed is only a preference.
  const model = asRecord(asRecord(settings.model).current ?? session.model)
  const currentProvider = stringField(model, 'providerId')
  const currentModel = stringField(model, 'modelId')
  const currentValue = currentProvider && currentModel ? encodeModelId({ providerId: currentProvider, modelId: currentModel }) : undefined
  if (options.length === 0 && !currentValue) return undefined
  return {
    id: MODEL_CONFIG_ID,
    name: '模型',
    type: 'select',
    category: 'model',
    currentValue: currentValue ?? '',
    options
  }
}

/** 编码 modelId → 该模型目录项的默认推理档（实测：部分模型 setModel 必须携带 options.reasoningLevel）。 */
export function reasoningDefaultsFromSnapshot(snapshot: unknown): Record<string, string> {
  const settings = asRecord(asRecord(snapshot).settings)
  const available = settings.model ? asRecord(settings.model).available : undefined
  const defaults: Record<string, string> = {}
  if (!Array.isArray(available)) return defaults
  for (const entry of available) {
    const record = asRecord(entry)
    const ref = asRecord(record.ref)
    const providerId = stringField(ref, 'providerId')
    const modelId = stringField(ref, 'modelId')
    const reasoning = asRecord(record.reasoning)
    const defaultLevel = stringField(reasoning, 'defaultLevel')
    if (providerId && modelId && defaultLevel) defaults[encodeModelId({ providerId, modelId })] = defaultLevel
  }
  return defaults
}

/* ---------- ACP 输入 → ZCode session/send ---------- */

/** 仅支持文本（promptCapabilities.image=false 如实声明）；非文本块忽略，全非文本返回空串由适配器拒绝。 */
export function promptToZcodeContent(prompt: unknown): string {
  if (!Array.isArray(prompt)) return ''
  const texts: string[] = []
  for (const block of prompt) {
    const record = asRecord(block)
    if (record.type === 'text' && typeof record.text === 'string' && record.text.length > 0) texts.push(record.text)
  }
  return texts.join('\n')
}

/* ---------- ZCode session/event → ACP session/update ---------- */

export type AcpUpdateObject = { sessionUpdate: string } & Record<string, unknown>

export type ZcodeEventClass = 'turn-end' | 'turn-failed' | 'permission' | 'updates' | 'ignore'

export function classifyZcodeEvent(event: unknown): ZcodeEventClass {
  switch (stringField(asRecord(event), 'type')) {
    case 'turn.completed': return 'turn-end'
    case 'turn.failed': return 'turn-failed'
    case 'permission.requested': return 'permission'
    case 'permission.resolved':
    case 'model.streaming':
    case 'tool.updated':
    case 'session.updated': return 'updates'
    default: return 'ignore'
  }
}

function textContent(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

function contentUpdate(sessionUpdate: string, text: string): AcpUpdateObject {
  return { sessionUpdate, content: textContent(text) }
}

function tailText(payload: Record<string, unknown>): string | undefined {
  return ['output', 'outputTail', 'stdoutTail', 'stderrTail'].map(key => stringField(payload, key)).filter(Boolean).join('\n') || undefined
}

function toolContent(value: unknown): unknown[] {
  const text = typeof value === 'string' ? value : tailText(asRecord(value)) ?? JSON.stringify(value)
  return text ? [{ type: 'content', content: textContent(text) }] : []
}

function toolUpdatesFromStreaming(payload: Record<string, unknown>): AcpUpdateObject[] {
  const kind = stringField(payload, 'kind')
  const toolCallId = stringField(payload, 'toolCallId')
  const toolName = stringField(payload, 'toolName')
  switch (kind) {
    case 'text_delta':
      return [contentUpdate('agent_message_chunk', typeof payload.delta === 'string' ? payload.delta : '')]
    case 'reasoning_delta':
      return [contentUpdate('agent_thought_chunk', typeof payload.delta === 'string' ? payload.delta : '')]
    case 'tool_input_start':
    case 'tool_call':
      return toolCallId ? [{ sessionUpdate: 'tool_call', toolCallId, title: toolName ?? '工具调用', kind: 'execute', ...('input' in payload ? { rawInput: payload.input } : {}) }] : []
    default:
      // start/finish/text_start/text_end/reasoning_start/reasoning_end/tool_input_delta/tool_input_end/error：
      // ACP 无对应增量语义，如实忽略（不猜内容）。
      return []
  }
}

function toolUpdatesFromToolUpdated(payload: Record<string, unknown>): AcpUpdateObject[] {
  const kind = stringField(payload, 'kind')
  const toolCallId = stringField(payload, 'toolCallId')
  if (!toolCallId) return []
  switch (kind) {
    case 'scheduled': {
      const update: AcpUpdateObject = { sessionUpdate: 'tool_call', toolCallId, kind: 'execute', status: 'pending' }
      if ('input' in payload) update.rawInput = payload.input
      const title = stringField(payload, 'toolName')
      if (title) update.title = title
      return [update]
    }
    case 'started':
      return [{ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' }]
    case 'progress': {
      const update: AcpUpdateObject = { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', rawOutput: payload }
      const tail = tailText(payload)
      if (tail) update.content = toolContent(tail)
      return [update]
    }
    case 'result': {
      const update: AcpUpdateObject = { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' }
      if ('result' in payload) {
        update.rawOutput = payload.result
        update.content = toolContent(payload.result)
      } else if (tailText(payload)) update.content = toolContent(tailText(payload))
      return [update]
    }
    case 'error': {
      const update: AcpUpdateObject = { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' }
      const error = asRecord(payload.error)
      if ('error' in payload) update.rawOutput = payload.error
      const detail = ['message', 'detail', 'underlyingErrorMessage', 'underlyingErrorDetail'].map(key => stringField(error, key)).filter(Boolean).join('\n')
      update.content = toolContent(detail || tailText(payload) || '工具执行失败')
      return [update]
    }
    default:
      return []
  }
}

/** 核心翻译表：session/event → 0..n 条 ACP session/update 载荷。 */
export function zcodeEventToAcpUpdates(event: unknown): AcpUpdateObject[] {
  const record = asRecord(event)
  const payload = asRecord(record.payload)
  switch (stringField(record, 'type')) {
    case 'model.streaming': return toolUpdatesFromStreaming(payload)
    case 'tool.updated': return toolUpdatesFromToolUpdated(payload)
    case 'permission.resolved': {
      // Native PermissionResolved and PermissionDenied both use this event.
      // Only explicit denial ends the tool; allow still precedes execution.
      const toolCallId = stringField(payload, 'toolCallId')
      return payload.decision === 'deny' && toolCallId ? [{ sessionUpdate: 'tool_call_update', toolCallId,
        status: 'failed', rawOutput: payload, content: toolContent(stringField(payload, 'reason') ?? 'Permission denied') }] : []
    }
    case 'session.updated': {
      const mode = stringField(payload, 'mode')
      // 实测帧：{"mode":"build","planEnabled":true,"previousMode":"build","previousPlanEnabled":false,"source":"command"}
      return mode ? [{ sessionUpdate: 'current_mode_update', currentModeId: effectiveMode(mode, payload.planEnabled === true) }] : []
    }
    default: return []
  }
}

/* ---------- turn 边界 ---------- */

export function turnStopReason(event: unknown): 'end_turn' | 'cancelled' | undefined {
  const payload = asRecord(asRecord(event).payload)
  const result = stringField(payload, 'resultType')
  return result === 'success' ? 'end_turn' : result === 'cancelled' ? 'cancelled' : undefined
}

export function turnFailureMessage(event: unknown): string {
  const payload = asRecord(asRecord(event).payload)
  const error = asRecord(payload.error)
  return stringField(error, 'message') ?? stringField(payload, 'message') ?? (stringField(payload, 'resultType') ? `ZCode turn 失败（${payload.resultType}）` : 'ZCode turn 失败（无错误详情）')
}

/* ---------- 权限请求 ---------- */

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface AcpPermissionRequest {
  requestId: string
  toolCall: { toolCallId: string; title: string; kind: 'execute'; rawInput?: unknown; content?: unknown[] }
  options: AcpPermissionOption[]
  responses: Record<string, Record<string, unknown>>
}

/** Preserve supported native options and their original response semantics. */
export function permissionRequestFromZcode(payload: unknown): AcpPermissionRequest | undefined {
  const record = asRecord(payload)
  const requestId = stringField(record, 'requestId')
  if (!requestId) return undefined
  const toolName = stringField(record, 'toolName') ?? '工具'
  const options: AcpPermissionOption[] = []
  const responses: Record<string, Record<string, unknown>> = Object.create(null)
  const nativeOptions = Array.isArray(record.options) ? record.options : []
  for (const raw of nativeOptions) {
    const option = asRecord(raw)
    const optionId = stringField(option, 'optionId')
    const name = stringField(option, 'name')
    const response = asRecord(option.response)
    const nativeKind = stringField(option, 'kind')
    const kind = nativeKind === 'allow_once' || nativeKind === 'allow_always' ? nativeKind
      : nativeKind === 'deny' || nativeKind === 'deny_once' || nativeKind === 'reject_once' ? 'reject_once'
      : nativeKind === 'deny_always' || nativeKind === 'reject_always' ? 'reject_always' : undefined
    if (!optionId || !name || !kind || nativeOptions.filter(value => asRecord(value).optionId === optionId).length !== 1) continue
    if (kind.startsWith('allow') ? response.decision !== 'allow' : response.decision !== 'deny') continue
    options.push({ optionId, name, kind })
    responses[optionId] = response
  }
  // No invented allow option when the native peer supplies unknown actions.
  if (options.length === 0) {
    options.push({ optionId: 'zcode-adapter-deny', name: '拒绝', kind: 'reject_once' })
    responses['zcode-adapter-deny'] = { decision: 'deny' }
  }
  const detail = [stringField(record, 'reason'), stringField(record, 'riskLevel')].filter(Boolean).join('\n')
  return {
    requestId,
    toolCall: { toolCallId: stringField(record, 'toolCallId') ?? requestId, title: toolName, kind: 'execute', rawInput: record.input, ...(detail ? { content: toolContent(detail) } : {}) },
    options,
    responses
  }
}

/* ---------- workspace 键 ---------- */

/** workspaceKey 为客户端自定义逻辑键（protocol-mapping §3.1）：用规范化的 POSIX 形态路径，稳定且有界。 */
export function workspaceKeyFromPath(workspacePath: string): string {
  return workspacePath.replace(/\\/g, '/').replace(/\/+$/, '')
}
