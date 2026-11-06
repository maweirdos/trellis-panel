/** ESM-only, LF JSONL child entry. The host owns admission, leases and presentation. */
import { createHash, randomUUID } from 'node:crypto'
import { format } from 'node:util'
import { homedir } from 'node:os'
import {
  createAgentSession, createMcpExtension, SettingsManager, defineTool,
  type AgentSession, type AgentSessionEvent, type ExtensionFactory, type ModelRuntime
} from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import { runtimeContextText } from '../execution-context-budget'
import { PI_FRAME_BYTES, piInitializeSchema, piStateSchema, type PiActivity, type PiChildMessage, type PiInitialize, type PiPermission, type PiState } from './protocol'
import { createModels, disposeModels, initialModelSelection, selectedModel } from './engine/models'
import { createResources, mcpLogPath, mcpRegistration } from './engine/resources'
import { webPreviewExtension } from './engine/web-preview'
import { designGenerationExtension } from './engine/design-generation'
import { openSession, prepareDirectories } from './engine/storage'
import { AssistantTextStream } from './engine/assistant-text'
import { configurePiFindRuntime } from './engine/find-runtime'
import { savePiImage } from './images'
import { ACP_IMAGE_MAX_COUNT, ACP_IMAGES_MAX_BYTES, acpImageBytes } from '../../../shared/acp-images'
import { readPiWebPreviewArtifact } from '../../../shared/pi-web-preview'
import { readDesignGenerationOutput } from '../../../shared/design-generation'
import { Type } from '@earendil-works/pi-ai'
import { taskProgressSummarySchema } from '../../../shared/hifox-task-progress-native'

const commandSchema = z.object({ id: z.string().min(1), method: z.string().min(1), params: z.unknown().optional() }).strict()
const permissionResponseSchema = z.object({ type: z.literal('permission_response'), id: z.string().min(1), allow: z.boolean(), reason: z.string().optional() }).strict()
const promptSchema = z.object({
  text: z.string(), context: z.array(z.object({ uri: z.string(), mimeType: z.string().optional(), text: z.string() }).strict()).max(128).optional(),
  images: z.array(z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), data: z.string().min(1) }).strict()).max(8).optional()
}).strict().refine(value => Boolean(value.text.trim()) || Boolean(value.images?.length), 'Prompt is empty')
const configureSchema = z.object({ modelId: z.string().min(1).optional(), thinkingLevel: z.enum(['off', 'low', 'medium', 'high']).optional() }).strict()
const compactSchema = z.object({ instructions: z.string().optional() }).strict()
const emptySchema = z.object({}).strict()

type Command = z.infer<typeof commandSchema>
type Prompt = z.infer<typeof promptSchema>
type Turn = { cancelled: boolean; started: boolean; failure?: string; imageFailure?: string; aborted: boolean; imageCount: number; imageBytes: number; responseNumber: number; imageKeys: Set<string>; imageProgress: Set<string>; completedImages: Set<string> }
type PermissionDecision = { allow: boolean; reason?: string }

let configuration: PiInitialize | undefined
let session: AgentSession | undefined
let models: ModelRuntime | undefined
let settings: SettingsManager | undefined
let initializing: Promise<void> | undefined
let configuring = false
let closing = false
let exiting = false
let shutdownPromise: Promise<void> | undefined
let turn: Turn | undefined
let running: Promise<void> | undefined
const permissions = new Map<string, (decision: PermissionDecision) => void>()
const progressReports = new Map<string, (ok: boolean) => void>()
const inFlightCommands = new Set<string>()
const secrets = new Set<string>()
const toolOutput = new Map<string, string>()
let assistantStream: AssistantTextStream | undefined
const completedAssistantMessages = new WeakSet<object>()

function redact(text: string): string {
  let safe = text
  for (const secret of secrets) safe = safe.replaceAll(secret, '[redacted]')
  return safe
}

function rememberSecrets(value: unknown, sensitive = false): void {
  if (typeof value === 'string' && sensitive && value) {
    secrets.add(value)
    secrets.add(encodeURIComponent(value))
    const bearer = /^Bearer\s+(.+)$/i.exec(value)
    if (bearer?.[1]) secrets.add(bearer[1])
    if (/^https?:\/\//i.test(value) && URL.canParse(value)) {
      const url = new URL(value)
      secrets.add(url.href)
      if (url.username || url.password) {
        for (const part of [url.username, url.password]) if (part) secrets.add(part)
        try {
          const username = decodeURIComponent(url.username)
          const password = decodeURIComponent(url.password)
          for (const part of [username, password, `${username}:${password}`]) if (part) secrets.add(part)
          secrets.add(Buffer.from(`${username}:${password}`).toString('base64'))
        } catch { /* Raw URL and encoded credentials remain redacted for invalid percent encodings. */ }
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) rememberSecrets(item, sensitive)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) rememberSecrets(item, sensitive || /^(apiKey|headers|env|proxy|baseUrl|endpoint|url)$/i.test(key))
  }
}

function errorText(error: unknown): string {
  if (error instanceof z.ZodError) return `Invalid Pi input: ${error.issues.map(issue => issue.path.join('.') || 'value').join(', ')}`
  return redact(error instanceof Error ? error.message : String(error))
}

function send(message: PiChildMessage): void {
  // Permission arguments and machine identities are exact. Redacting them would approve different
  // arguments from the ones the SDK executes, or corrupt tags when a short key matches a tag.
  const machineFields = new Set(['type', 'id', 'toolCallId', 'name', 'status', 'tag', 'phase', 'stream', 'messageId', 'operationId', 'blockType', 'operation', 'providerMessageId', 'authority'])
  const imageRefs = new WeakSet<object>()
  if (message.type === 'event' && message.event.type === 'text_delta' && Array.isArray(message.event.meta?.piImages)) {
    for (const image of message.event.meta.piImages) if (image && typeof image === 'object') imageRefs.add(image)
  }
  const preview = message.type === 'event' && message.event.type === 'text_delta' && readPiWebPreviewArtifact(message.event.meta?.piWebPreview)
    ? message.event.meta?.piWebPreview : undefined
  const designOutputs = new WeakSet<object>()
  if (message.type === 'event') {
    const event = message.event
    const raw = event.type === 'tool_call' && event.title === 'design_open' && event.status === 'completed'
      ? event.rawOutput as { details?: { designOutput?: unknown } } | undefined : undefined
    for (const value of [raw?.details?.designOutput, event.type === 'text_delta' ? event.meta?.designOutput : undefined]) {
      if (value && typeof value === 'object' && readDesignGenerationOutput(value)) designOutputs.add(value)
    }
  }
  const replacer = function (this: object, key: string, value: unknown): unknown {
    if (message.type === 'event' && message.event.type === 'tool_call' && this === message.event && key === 'title' && value === 'design_open') return value
    if (this === preview && key === 'title' && typeof value === 'string') return redact(value).slice(0, 160)
    if (designOutputs.has(this) && typeof value === 'string') return key === 'title' ? redact(value).slice(0, 200) : value
    return message.type === 'event' && typeof value === 'string' && !machineFields.has(key) && !imageRefs.has(this) &&
      !(this === preview && (key === 'path' || key === 'revision')) ? redact(value) : value
  }
  const line = JSON.stringify(message, replacer)
  if (Buffer.byteLength(line) > PI_FRAME_BYTES) {
    // Preserve the actual lifecycle/identity even when an SDK result includes large images.
    if (message.type === 'event' && message.event.type === 'tool_call') {
      const event = message.event
      const bounded = { ...event, text: event.text.slice(0, 64 * 1024), outputDelta: undefined,
        rawInput: undefined, rawOutput: { omitted: true, reason: 'SDK tool activity exceeds the private frame limit' } }
      process.stdout.write(`${JSON.stringify({ type: 'event', event: bounded }, replacer)}\n`)
      return
    }
    throw new Error('Pi output exceeds the private frame limit')
  }
  process.stdout.write(`${line}\n`)
}

function activity(event: PiActivity): void { send({ type: 'event', event }) }
function status(text: string, tag: string, phase?: string): void { activity({ type: 'status', text, tag, phase }) }
function reply(id: string, result: unknown): void { send({ type: 'response', id, ok: true, result }) }

// SDK diagnostics must never become stdout frames or expose configured secrets.
for (const name of ['log', 'info', 'debug', 'warn', 'error'] as const) {
  console[name] = (...args: unknown[]) => { process.stderr.write(`${redact(format(...args))}\n`) }
}

function requireSession(): AgentSession {
  if (!session || !configuration || !models || initializing) throw new Error('Pi is not initialized')
  return session
}

function requireIdle(): AgentSession {
  const current = requireSession()
  if (turn || configuring || !current.isIdle) throw new Error('Pi session is busy')
  return current
}

function state(): PiState {
  const current = session
  const input = configuration
  if (!current || !input || !current.model || !current.sessionFile) throw new Error('Pi session state is unavailable')
  const selection = input.models.find(model => model.providerId === current.model?.provider && model.modelId === current.model?.id)
  if (!selection || current.sessionManager.getHeader()?.version !== 3) throw new Error('Pi SDK state is outside the configured boundary')
  return piStateSchema.parse({ sessionId: current.sessionId, sessionFile: current.sessionFile, sessionVersion: 3,
    modelId: selection.selectionId, thinkingLevel: current.thinkingLevel, contextWindow: current.model.contextWindow, tools: current.getActiveToolNames() })
}

function cancelPermissions(): void {
  for (const resolve of [...permissions.values()]) resolve({ allow: false, reason: 'Pi operation cancelled' })
  for (const finish of [...progressReports.values()]) finish(false)
}

const taskProgressExtension: ExtensionFactory = pi => {
  pi.registerTool(defineTool({
    name: 'report_progress', label: 'Report task progress',
    description: 'Durably queue a short activity/step/blocker for the one original team task bound to this session. No taskId, paths, tool logs, tokens or credentials. Queued is not server acknowledgement. Turn completion means idle, never business completion.',
    parameters: Type.Object({
      activity: Type.Union(['running', 'waiting_confirmation', 'paused', 'interrupted', 'idle'].map(value => Type.Literal(value))),
      step: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
      blocker: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()])
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const owner = turn
      if (!configuration?.taskProgress || !owner || owner.cancelled || closing) throw new Error('The original task reporting handle is unavailable')
      signal?.throwIfAborted()
      const summary = taskProgressSummarySchema.parse(params)
      await new Promise<void>((resolve, reject) => {
        const id = randomUUID()
        const onAbort = () => finish(false)
        const timer = setTimeout(() => finish(false), 30_000)
        const finish = (ok: boolean) => {
          clearTimeout(timer); progressReports.delete(id); signal?.removeEventListener('abort', onAbort)
          if (ok && turn === owner && !owner.cancelled && !closing && !signal?.aborted) resolve()
          else reject(new Error('Task progress persistence was not confirmed'))
        }
        progressReports.set(id, finish)
        signal?.addEventListener('abort', onAbort, { once: true })
        try { send({ type: 'task_progress', id, summary }) } catch { finish(false) }
      })
      return { content: [{ type: 'text', text: 'Progress durably queued for the original task. Server acknowledgement is pending.' }], details: { queued: true, acknowledged: false } }
    }
  }))
}

function requestPermission(request: PiPermission, signal?: AbortSignal): Promise<PermissionDecision> {
  if (closing || !turn || turn.cancelled || signal?.aborted) return Promise.resolve({ allow: false, reason: 'Pi operation cancelled' })
  const owner = turn
  return new Promise(resolve => {
    const id = randomUUID()
    const finish = (decision: PermissionDecision) => {
      permissions.delete(id)
      signal?.removeEventListener('abort', onAbort)
      resolve(closing || owner.cancelled || turn !== owner || signal?.aborted ? { allow: false, reason: 'Pi operation cancelled' } : decision)
    }
    const onAbort = () => finish({ allow: false, reason: 'Pi operation cancelled' })
    permissions.set(id, finish)
    signal?.addEventListener('abort', onAbort, { once: true })
    try { send({ type: 'permission', id, request }) } catch (error) {
      finish({ allow: false, reason: errorText(error) })
    }
  })
}

const permissionExtension: ExtensionFactory = pi => {
  pi.on('tool_call', async (event, ctx) => {
    const decision = await requestPermission({ toolCallId: event.toolCallId, name: event.toolName, args: event.input, cwd: ctx.cwd, homeDir: homedir() }, ctx.signal)
    return decision.allow ? undefined : { block: true, reason: decision.reason || 'Permission denied by host', terminate: Boolean(turn?.cancelled || closing) }
  })
  // No user-shell path is allowed outside the named, permission-gated SDK tool pipeline.
  pi.on('user_bash', async () => ({ result: { output: 'Use the permission-gated shell tool', exitCode: 1, cancelled: false, truncated: false } }))
  pi.on('before_agent_start', async (_event, ctx) => {
    if (closing || turn?.cancelled) ctx.abort()
  })
  pi.on('session_before_compact', async () => closing || turn?.cancelled ? { cancel: true } : undefined)
  pi.on('message_end', async event => {
    const message = event.message
    if (message.role !== 'assistant' || !message.errorMessage) return
    const safe = redact(message.errorMessage)
    // The public finalization hook runs before native persistence, so reflected credentials
    // in a provider error cannot leak into either the private frames or the session JSONL.
    if (safe !== message.errorMessage) return { message: { ...message, errorMessage: safe } }
  })
}

function contextUsage(): void {
  const usage = session?.getContextUsage()
  if (usage) activity({ type: 'status', text: usage.tokens === null ? 'Context usage is unknown' : `${usage.tokens} / ${usage.contextWindow} context tokens`,
    tag: 'pi_context', used: usage.tokens ?? undefined, size: usage.contextWindow })
}

function resultText(value: unknown): string {
  if (!value || typeof value !== 'object' || !('content' in value) || !Array.isArray(value.content)) return ''
  return value.content.flatMap((item: unknown) => item && typeof item === 'object' && 'type' in item && item.type === 'text'
    && 'text' in item && typeof item.text === 'string' ? [item.text] : []).join('\n')
}

function captureImage(key: string, data: unknown, mimeType?: unknown): void {
  const owner = turn
  if (!owner || owner.cancelled || !configuration || owner.imageKeys.has(key)) return
  try {
    if (typeof data !== 'string') throw new Error('Pi 图片内容缺失')
    const bytes = acpImageBytes(data)
    if (owner.imageCount >= ACP_IMAGE_MAX_COUNT || owner.imageBytes + bytes > ACP_IMAGES_MAX_BYTES) throw new Error('Pi 图片超出本轮数量或总大小限制')
    const image = savePiImage(configuration.sessionDir, data, typeof mimeType === 'string' ? mimeType : undefined)
    owner.imageCount++; owner.imageBytes += bytes; owner.imageKeys.add(key)
    activity({ type: 'text_delta', text: '', stream: 'output', messageId: assistantStream?.id ?? `pi-image-${key}`, meta: { piImages: [image] } })
  } catch (error) {
    owner.imageKeys.add(key)
    owner.imageFailure = errorText(error)
    activity({ type: 'error', message: `图片保存失败：${owner.imageFailure}` })
  }
}

function providerEvent(value: unknown): void {
  if (!turn || !value || typeof value !== 'object') return
  const event = value as Record<string, unknown>
  const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : undefined
  const operationId = typeof event.item_id === 'string' ? event.item_id : typeof item?.id === 'string' ? item.id : typeof event.output_index === 'number' ? `output-${event.output_index}` : undefined
  const kind = typeof event.type === 'string' ? event.type : ''
  if (kind === 'response.created') { turn.responseNumber++; activity({ type: 'status', text: '供应商已建立响应', tag: 'pi_provider_response' }) }
  if ((item?.type === 'image_generation_call' && kind === 'response.output_item.added') || kind === 'response.image_generation_call.in_progress') {
    const key = `${turn.responseNumber}:${operationId ?? 'unknown'}:running`
    if (!turn.imageProgress.has(key)) { turn.imageProgress.add(key); activity({ type: 'status', text: '正在生成图片', tag: 'pi_image_generation', phase: 'running', operationId }) }
  }
  if (kind === 'response.image_generation_call.completed' || (item?.type === 'image_generation_call' && kind === 'response.output_item.done')) {
    const key = `${turn.responseNumber}:${operationId ?? 'unknown'}:completed`
    turn.completedImages.add(`response:${turn.responseNumber}:${operationId ?? 'unknown'}`)
    if (!turn.imageProgress.has(key)) { turn.imageProgress.add(key); activity({ type: 'status', text: '图片生成完成', tag: 'pi_image_generation', phase: 'completed', operationId }) }
  }
  if (kind === 'response.output_item.done' && item?.type === 'image_generation_call' && item.result !== undefined) captureImage(`response:${turn.responseNumber}:${operationId ?? 'unknown'}`, item.result)
  if (kind === 'response.completed' && event.response && typeof event.response === 'object') {
    const output = (event.response as Record<string, unknown>).output
    if (Array.isArray(output)) output.forEach((entry, index) => {
      if (entry && typeof entry === 'object' && entry.type === 'image_generation_call') {
        const key = `response:${turn?.responseNumber}:${typeof entry.id === 'string' ? entry.id : `output-${index}`}`
        turn?.completedImages.add(key)
        if (entry.result !== undefined) captureImage(key, entry.result)
      }
    })
  }
}

function safeToolOutput(value: unknown, toolCallId: string, capture: boolean): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => safeToolOutput(item, toolCallId, capture))
  const object = value as Record<string, unknown>
  if (object.type === 'image' && typeof object.data === 'string') {
    // The hash identifies repeated partial/final copies within one tool call.
    const key = `tool:${toolCallId}:${createHash('sha256').update(object.data).digest('hex')}`
    if (capture) captureImage(key, object.data, object.mimeType)
    return { type: 'image', omitted: true }
  }
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, safeToolOutput(item, toolCallId, capture)]))
}

function promptStarted(): void {
  if (!turn || turn.started) return
  turn.started = true
  status('Pi prompt started', 'pi_prompt_started')
}

function onEvent(event: AgentSessionEvent): void {
  switch (event.type) {
    case 'message_start':
      if (event.message.role === 'user') promptStarted()
      if (event.message.role === 'assistant') assistantStream = new AssistantTextStream(activity)
      break
    case 'message_update': {
      const update = event.assistantMessageEvent
      if (update.type === 'text_end' || update.type === 'thinking_end') {
        assistantStream?.reconcile(update.contentIndex, update.type === 'text_end' ? 'text' : 'thinking', update.content,
          update.partial.content[update.contentIndex], 'block_end')
      }
      if (update.type === 'thinking_start' || update.type === 'thinking_end') {
        const stream = assistantStream
        if (update.type === 'thinking_start') stream?.thinkingStarted.add(update.contentIndex)
        const empty = update.type === 'thinking_end' && stream?.thinkingStarted.has(update.contentIndex) && !stream.textAt(update.contentIndex).trim() && !update.content.trim()
        activity({ type: 'status', text: empty ? '模型未提供可展示的思考内容' : update.type === 'thinking_start' ? '正在思考' : '思考结束', tag: empty ? 'pi_thinking_empty' : 'pi_thinking', phase: update.type === 'thinking_start' ? 'running' : 'completed', messageId: stream?.id, operationId: String(update.contentIndex) })
      }
      if (update.type === 'text_delta' || update.type === 'thinking_delta') {
        assistantStream?.append(update.contentIndex, update.type === 'thinking_delta' ? 'thinking' : 'text', update.delta, update.partial.content[update.contentIndex])
      }
      break
    }
    case 'message_end':
      if (event.message.role === 'assistant') {
        if (completedAssistantMessages.has(event.message)) break
        // Keep final-only responses independent even if the SDK omitted message_start.
        const stream = assistantStream ?? new AssistantTextStream(activity)
        stream.finish(event.message.content)
        completedAssistantMessages.add(event.message)
        assistantStream = undefined
        if (turn) {
          turn.failure = event.message.stopReason === 'error' ? errorText(event.message.errorMessage || 'Pi provider failed') : undefined
          turn.aborted = event.message.stopReason === 'aborted'
        }
        contextUsage()
        const usage = event.message.usage
        status(`Tokens: input ${usage.input}, output ${usage.output}, cache read ${usage.cacheRead}, cache write ${usage.cacheWrite}`, 'pi_usage')
      }
      break
    case 'tool_execution_start':
      toolOutput.delete(event.toolCallId)
      activity({ type: 'tool_call', text: event.toolName, toolCallId: event.toolCallId, title: event.toolName, status: 'running', tag: 'pi_tool_start', rawInput: event.args })
      break
    case 'tool_execution_update': {
      const text = resultText(event.partialResult)
      const previous = toolOutput.get(event.toolCallId) ?? ''
      toolOutput.set(event.toolCallId, text)
      activity({ type: 'tool_call', text: text.slice(0, 64 * 1024) || event.toolName, toolCallId: event.toolCallId, title: event.toolName,
        status: 'running', tag: 'pi_tool_update', rawOutput: safeToolOutput(event.partialResult, event.toolCallId, false), outputDelta: text.startsWith(previous) ? text.slice(previous.length) : undefined })
      break
    }
    case 'tool_execution_end': {
      toolOutput.delete(event.toolCallId)
      activity({ type: 'tool_call', text: resultText(event.result).slice(0, 64 * 1024) || event.toolName, toolCallId: event.toolCallId,
        title: event.toolName, status: event.isError ? 'failed' : 'completed', tag: 'pi_tool_end', rawOutput: safeToolOutput(event.result, event.toolCallId, false) })
      if (!event.isError) safeToolOutput(event.result, event.toolCallId, true)
      if (!event.isError && event.toolName === 'preview_web') {
        const result = event.result as { details?: { piWebPreview?: unknown } }
        const preview = readPiWebPreviewArtifact(result.details?.piWebPreview)
        if (preview) activity({ type: 'text_delta', text: '', stream: 'output', messageId: `pi-web-preview-${event.toolCallId}`, meta: { piWebPreview: preview } })
      }
      if (!event.isError && event.toolName === 'design_open') {
        const result = event.result as { details?: { designOutput?: unknown } }
        const output = readDesignGenerationOutput(result.details?.designOutput)
        if (output) activity({ type: 'text_delta', text: '', stream: 'output', messageId: `pi-design-${event.toolCallId}`, meta: { designOutput: output } })
      }
      break
    }
    case 'compaction_start':
      status(`Pi compaction (${event.reason})`, 'pi_compaction', 'running')
      if (closing || turn?.cancelled) session?.abortCompaction()
      break
    case 'compaction_end':
      status(event.errorMessage ? errorText(event.errorMessage) : `Pi compaction (${event.reason})`, 'pi_compaction', event.aborted ? 'cancelled' : event.errorMessage ? 'failed' : 'completed')
      contextUsage()
      break
    case 'auto_retry_start':
      status(`Pi retry ${event.attempt}/${event.maxAttempts}: ${errorText(event.errorMessage)}`, 'pi_retry', 'running')
      break
    case 'auto_retry_end':
      status(event.finalError ? errorText(event.finalError) : 'Pi retry finished', 'pi_retry', event.success ? 'completed' : 'failed')
      break
    case 'summarization_retry_scheduled':
      status(`Pi summarization retry ${event.attempt}/${event.maxAttempts}: ${errorText(event.errorMessage)}`, 'pi_retry', 'running')
      break
    case 'agent_settled':
      if (turn && event.aborted) turn.aborted = true
      // Session prompt() still owns completion: public listeners run before its final return.
      break
  }
}

async function initialize(value: unknown): Promise<void> {
  rememberSecrets(value)
  const input = prepareDirectories(piInitializeSchema.parse(value))
  // Native MCP/tool utility defaults must also remain inside the supplied private agent directory.
  process.env.PI_CODING_AGENT_DIR = input.agentDir
  process.env.PI_OFFLINE = '1'
  configurePiFindRuntime(import.meta.url)
  configuration = input
  settings = SettingsManager.inMemory({ packages: [], extensions: [], skills: [], prompts: [], themes: [], cacheWarming: 'off' }, { projectTrusted: false })
  const registration = mcpRegistration(input)
  const runtime = await createModels(input)
  models = runtime
  const loader = createResources(input, settings, [permissionExtension, webPreviewExtension(input.root), designGenerationExtension(input.root), ...(input.taskProgress ? [taskProgressExtension] : []), registration, createMcpExtension({
    loadConfig: () => ({ servers: [], autoEnableCodemode: false, errors: [] }), logPath: mcpLogPath,
    openUrl: () => { throw new Error('MCP sign-in must be configured by the host') },
    updateConfig: () => { throw new Error('MCP configuration is owned by the host') }
  })])
  await loader.reload()
  const extensions = loader.getExtensions()
  if (extensions.errors.length) throw new Error(extensions.errors.map(item => item.error).join('; '))
  const sessionManager = openSession(input)
  const model = selectedModel(input, runtime, initialModelSelection(input, sessionManager.buildSessionContext().model))
  const created = await createAgentSession({ cwd: input.cwd, agentDir: input.agentDir, modelRuntime: models, model,
    thinkingLevel: input.thinkingLevel, scopedModels: input.models.map(item => ({ model: selectedModel(input, runtime, item.selectionId) })),
    settingsManager: settings, resourceLoader: loader, sessionManager,
    // An explicit allowlist retains direct MCP tools; noTools:'all' would suppress them too.
    noTools: 'builtin', tools: ['read', 'write', 'edit', 'grep', 'find', 'ls', process.platform === 'win32' ? 'powershell' : 'bash',
      'preview_web', 'design_open', ...(input.taskProgress ? ['report_progress'] : []), 'mcp__*', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'], excludeTools: ['codemode', 'tool_search'] })
  session = created.session
  session.subscribe(onEvent)
  await session.bindExtensions({ mode: 'json', onError: event => {
    const message = errorText(event.error)
    if (turn) turn.failure = message
    activity({ type: 'error', message })
  }, abortHandler: () => { void abort().catch(error => activity({ type: 'error', message: errorText(error) })) },
  shutdownHandler: () => { void shutdown().then(() => exitAfterFlush(0)).catch(fatal) } })
  const originalProviderStreamEvent = session.agent.onProviderStreamEvent
  session.agent.onProviderStreamEvent = async (event, model) => {
    await originalProviderStreamEvent?.(event, model)
    providerEvent(event)
  }
}

async function abort(): Promise<void> {
  if (turn) turn.cancelled = true
  cancelPermissions()
  await session?.abort()
  await running
}

async function disposeSession(): Promise<void> {
  const current = session
  if (!current) return
  try { await current.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }) } finally {
    current.dispose()
    session = undefined
  }
}

function nativeCompact(text: string): string | undefined {
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(text)
  return match ? match[1]?.trim() ?? '' : undefined
}

function beginTurn(current: AgentSession, prompt: Prompt | { instructions?: string }): void {
  const owner: Turn = { cancelled: false, started: false, aborted: false, imageCount: 0, imageBytes: 0, responseNumber: 0, imageKeys: new Set(), imageProgress: new Set(), completedImages: new Set() }
  turn = owner
  running = Promise.resolve().then(async () => {
    if (owner.cancelled || closing) return
    if ('instructions' in prompt || !('text' in prompt)) {
      promptStarted()
      await current.compact(prompt.instructions)
    } else {
      const compact = nativeCompact(prompt.text)
      if (compact !== undefined) {
        if (prompt.context?.length || prompt.images?.length) throw new Error('/compact does not accept context or images')
        promptStarted()
        await current.compact(compact || undefined)
      } else {
        // Context is carried as literal, source-labelled user input; it cannot select resources or extensions.
        const context = runtimeContextText(prompt.context)
        await current.prompt(prompt.text + context, { source: 'rpc', expandPromptTemplates: false,
          images: prompt.images?.map(item => ({ type: 'image' as const, ...item })) })
      }
    }
  }).catch(error => { owner.failure = errorText(error) }).finally(() => {
    cancelPermissions()
    if (!owner.cancelled && !owner.aborted && !owner.imageFailure && [...owner.completedImages].some(key => !owner.imageKeys.has(key))) {
      owner.imageFailure = '供应商报告图片生成完成，但未返回图片内容'
      activity({ type: 'error', message: owner.imageFailure })
    }
    if (owner.failure && !owner.cancelled && !owner.aborted) activity({ type: 'error', message: owner.failure })
    const phase = owner.cancelled || owner.aborted ? 'cancelled' : owner.failure || owner.imageFailure ? 'failed' : 'completed'
    toolOutput.clear()
    assistantStream = undefined
    turn = undefined
    running = undefined
    status(phase === 'failed' ? owner.failure || owner.imageFailure || 'Pi failed' : `Pi ${phase}`, 'pi_settled', phase)
  })
}

async function handleCommand(command: Command): Promise<void> {
  if (closing) throw new Error('Pi is shutting down')
  switch (command.method) {
    case 'initialize':
      if (initializing || session || configuration) throw new Error('Pi has already been initialized')
      initializing = initialize(command.params)
      try { await initializing } catch (error) {
        await disposeSession()
        await disposeModels(models)
        throw error
      } finally { initializing = undefined }
      reply(command.id, state())
      return
    case 'prompt': {
      const current = requireIdle()
      const prompt = promptSchema.parse(command.params)
      const compact = nativeCompact(prompt.text)
      if (compact !== undefined && (prompt.context?.length || prompt.images?.length)) throw new Error('/compact does not accept context or images')
      reply(command.id, { accepted: true })
      beginTurn(current, prompt)
      return
    }
    case 'compact': {
      const current = requireIdle()
      const params = compactSchema.parse(command.params ?? {})
      reply(command.id, { accepted: true })
      beginTurn(current, params)
      return
    }
    case 'abort':
      emptySchema.parse(command.params ?? {})
      await abort()
      reply(command.id, { aborted: true })
      return
    case 'configure': {
      const current = requireIdle()
      const params = configureSchema.parse(command.params)
      const input = configuration
      const runtime = models
      if (!input || !runtime) throw new Error('Pi is not initialized')
      const model = params.modelId ? selectedModel(input, runtime, params.modelId) : undefined
      configuring = true
      try {
        if (model) await current.setModel(model)
        if (params.thinkingLevel !== undefined) current.setThinkingLevel(params.thinkingLevel)
        await settings?.flush()
        reply(command.id, state())
      } finally { configuring = false }
      return
    }
    case 'shutdown':
      emptySchema.parse(command.params ?? {})
      await shutdown()
      reply(command.id, { shutdown: true })
      exitAfterFlush(0)
      return
    default:
      throw new Error(`Unknown Pi method: ${command.method}`)
  }
}

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  closing = true
  shutdownPromise = (async () => {
    if (initializing) { try { await initializing } catch (error) { activity({ type: 'error', message: errorText(error) }) } }
    await abort()
    await disposeSession()
    await disposeModels(models)
    await settings?.flush()
  })()
  return shutdownPromise
}

function exitAfterFlush(code: number): void {
  process.exitCode = code || process.exitCode || 0
  if (exiting) return
  exiting = true
  // Let native SDK work and libuv close callbacks drain. process.exit() can race the
  // native tokenizer's async handles on Windows after a large compaction.
  process.stdin.destroy()
  process.stdout.end()
}

function fatal(error: unknown): void {
  activity({ type: 'error', message: errorText(error) })
  void shutdown().catch(error => { process.stderr.write(`${errorText(error)}\n`) }).finally(() => exitAfterFlush(1))
}

function frame(bytes: Buffer): void {
  let input: unknown
  try {
    if (!bytes.length || bytes.includes(13)) throw new Error('Expected a strict LF JSONL frame')
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch { fatal(new Error('Invalid UTF-8 or LF JSONL frame')); return }
  if (input && typeof input === 'object' && 'type' in input && input.type === 'permission_response') {
    const parsed = permissionResponseSchema.safeParse(input)
    if (!parsed.success) { fatal(new Error('Invalid permission response')); return }
    permissions.get(parsed.data.id)?.({ allow: parsed.data.allow, reason: parsed.data.reason })
    return
  }
  if (input && typeof input === 'object' && 'type' in input && input.type === 'task_progress_response') {
    const parsed = z.object({ type: z.literal('task_progress_response'), id: z.string(), ok: z.boolean() }).strict().safeParse(input)
    if (!parsed.success) { fatal(new Error('Invalid task progress response')); return }
    progressReports.get(parsed.data.id)?.(parsed.data.ok)
    return
  }
  const parsed = commandSchema.safeParse(input)
  if (!parsed.success) { fatal(new Error('Invalid Pi command envelope')); return }
  const command = parsed.data
  if (inFlightCommands.has(command.id)) { fatal(new Error('Duplicate in-flight Pi command ID')); return }
  inFlightCommands.add(command.id)
  void handleCommand(command).catch(error => send({ type: 'response', id: command.id, ok: false, error: errorText(error) }))
    .finally(() => inFlightCommands.delete(command.id))
}

let chunks: Buffer[] = []
let pendingBytes = 0
process.stdin.on('data', (chunk: Buffer) => {
  if (closing) return
  let start = 0
  for (let index = 0; index < chunk.length; index++) {
    if (chunk[index] !== 10) continue
    const part = chunk.subarray(start, index)
    if (pendingBytes + part.length > PI_FRAME_BYTES) { fatal(new Error('Pi input frame exceeds 8 MiB')); return }
    chunks.push(part)
    const bytes = Buffer.concat(chunks, pendingBytes + part.length)
    chunks = []
    pendingBytes = 0
    frame(bytes)
    start = index + 1
    if (closing) return
  }
  if (start < chunk.length) {
    const part = chunk.subarray(start)
    pendingBytes += part.length
    if (pendingBytes > PI_FRAME_BYTES) { fatal(new Error('Pi input frame exceeds 8 MiB')); return }
    chunks.push(part)
  }
})
process.stdin.on('end', () => {
  if (pendingBytes) { fatal(new Error('Pi input ended without an LF terminator')); return }
  void shutdown().then(() => exitAfterFlush(0)).catch(fatal)
})
process.stdin.on('error', fatal)
process.stdout.on('error', () => { void shutdown().catch(error => { process.stderr.write(`${errorText(error)}\n`) }).finally(() => exitAfterFlush(1)) })
process.on('SIGTERM', () => { void shutdown().then(() => exitAfterFlush(0)).catch(fatal) })
process.on('SIGINT', () => { void shutdown().then(() => exitAfterFlush(0)).catch(fatal) })
