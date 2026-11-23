import type { ContentBlock, RequestPermissionRequest } from '@agentclientprotocol/sdk/experimental/v2'
import type { AcpAgentConfig, AcpSessionRecord } from '../../../../shared/types'
import type { ConversationRuntime, ConversationRuntimePermissionRequest } from '../../pi/runtime-port'
import { AcpV2FileStore, AcpV2RuntimeOwner, normalizeSessionConfigOption, type AcpV2PromptContent, type AcpV2RuntimeHandle, type AcpV2Turn } from '.'
import type { AcpV2RuntimeOptions } from './runtime'

type LegacyPermissionDecision = { outcome: 'selected'; optionId: string } | { outcome: 'cancel' }
type LegacyToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'think' | 'switch_mode' | 'other'
type LegacyPermissionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

export interface AcpV2FacadeOptions {
  readonly meta: AcpSessionRecord
  readonly config: AcpAgentConfig
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly stateDirectory: string
  readonly processOwner?: AcpV2RuntimeOptions['processOwner']
  readonly onBeforeSpawn: () => void
  readonly onSpawned: () => void
  readonly onSpawnFailed: (error: unknown) => void
  readonly onDisconnect: (error: unknown) => void
}

export class AcpV2ConversationRuntime implements ConversationRuntime {
  constructor(private readonly owner: AcpV2RuntimeOwner) {}

  static create(options: AcpV2FacadeOptions): AcpV2ConversationRuntime {
    const owner = new AcpV2RuntimeOwner({
      agentId: options.config.id,
      argv: options.argv,
      cwd: options.meta.cwd ?? options.meta.projectRoot,
      env: options.env,
      store: new AcpV2FileStore(options.stateDirectory),
      processOwner: options.processOwner,
      onBeforeSpawn: () => options.onBeforeSpawn(),
      onSpawned: () => options.onSpawned(),
      onSpawnFailed: failure => options.onSpawnFailed(failure.error),
      onDisconnect: options.onDisconnect,
    })
    return new AcpV2ConversationRuntime(owner)
  }

  async findSession(input: { sessionKey: string }): Promise<AcpV2RuntimeHandle | undefined> {
    return input.sessionKey === this.currentSessionKey ? this.currentHandleValue : undefined
  }

  async ensureSession(input: { sessionKey: string; cwd?: string; resumeSessionId?: string; nativeRecordId?: string }): Promise<AcpV2RuntimeHandle> {
    const handle = await this.owner.ensureSession({
      sessionKey: input.sessionKey,
      cwd: input.cwd ?? process.cwd(),
      resumeSessionId: input.resumeSessionId,
      nativeRecordId: input.nativeRecordId,
    })
    this.currentSessionKey = input.sessionKey
    this.currentHandleValue = handle
    return handle
  }

  async connectSession(input: { handle: AcpV2RuntimeHandle; assertActive?(): void }): Promise<void> {
    await this.owner.connectSession(input)
    this.currentSessionKey = input.handle.sessionKey
    this.currentHandleValue = input.handle
  }

  startTurn(input: Parameters<ConversationRuntime['startTurn']>[0]): AcpV2Turn {
    return this.owner.startTurn({
      handle: input.handle,
      prompt: promptContent(input),
      requestId: input.requestId,
      timeoutMs: input.timeoutMs,
      assertActive: input.assertActive,
      onPermissionRequest: async (request, context) => {
        const raw = input.onPermissionRequest?.(legacyPermissionRequest(request), context)
        if (raw === undefined) return undefined
        const decision = await raw
        return decision
      },
    })
  }

  async getCapabilities(): Promise<{ controls: string[]; configOptionKeys?: string[] }> {
    const capabilities = this.owner.getCapabilities()
    return { controls: capabilities.controls, configOptionKeys: capabilities.controls.includes('session/set_config_option') ? ['v2'] : undefined }
  }

  async getStatus(input?: { handle?: AcpV2RuntimeHandle }): Promise<{ summary?: string; models?: { availableModelIds: string[] }; usage?: Record<string, unknown>; details?: Record<string, unknown>; availableCommands?: Array<{ name: string; description?: string; hasInput?: boolean }> }> {
    const status = this.owner.getStatus(input)
    return {
      details: { configOptions: status.configOptions.map(normalizeSessionConfigOption).filter(option => option !== undefined) },
      availableCommands: status.commands.map(command => ({ name: command.name, description: command.description, hasInput: command.input !== undefined && command.input !== null })),
    }
  }

  async setConfigOption(input: { handle: AcpV2RuntimeHandle; key: string; value: string; assertActive?(): void }): Promise<void> {
    input.assertActive?.()
    await this.owner.setConfigOption({ handle: input.handle, configId: input.key, value: input.value })
    input.assertActive?.()
  }

  async setModel(input: { handle: AcpV2RuntimeHandle; model: string; assertActive?(): void }): Promise<void> {
    await this.setConfiguredOption(input.handle, input.model, 'model', input.assertActive)
  }

  async setMode(input: { handle: AcpV2RuntimeHandle; mode: string; assertActive?(): void }): Promise<void> {
    await this.setConfiguredOption(input.handle, input.mode, 'mode', input.assertActive)
  }

  async shutdown(): Promise<void> { await this.owner.shutdown('closed') }

  async confirmClosed(): Promise<void> { await this.owner.confirmClosed() }

  private async setConfiguredOption(handle: AcpV2RuntimeHandle, requestedValue: string, category: 'model' | 'mode', assertActive?: () => void): Promise<void> {
    assertActive?.()
    const options = this.owner.getStatus({ handle }).configOptions.map(normalizeSessionConfigOption)
      .filter((option): option is NonNullable<ReturnType<typeof normalizeSessionConfigOption>> => option !== undefined && option.category === category)
    const option = options.find(item => item.id === requestedValue || item.options.some(choice => choice.value === requestedValue))
    if (option === undefined) throw new Error(`此 ACP v2 引擎没有确认请求的${category === 'model' ? '模型' : '模式'}选项`)
    const value = option.options.find(choice => choice.value === requestedValue)?.value ?? option.currentValue
    await this.owner.setConfigOption({ handle, configId: option.id, value })
    assertActive?.()
  }

  private currentSessionKey = ''
  private currentHandleValue?: AcpV2RuntimeHandle
}

const promptContent = (input: Parameters<ConversationRuntime['startTurn']>[0]): AcpV2PromptContent[] => [
  { type: 'text', text: input.text },
  ...(input.context ?? []).map(resource => ({ type: 'resource', resource: { uri: resource.uri, mimeType: resource.mimeType ?? 'text/plain', text: resource.text } }) as ContentBlock),
  ...(input.attachments ?? []).map(attachment => ({ type: 'image', data: attachment.data, mimeType: attachment.mediaType }) as ContentBlock),
]

const readInferredKind = (request: RequestPermissionRequest): LegacyToolKind | undefined => {
  const subject = request.subject
  if (subject?.type !== 'tool_call') return undefined
  const toolCall = readRecord(subject.toolCall)
  const kind = toolCall?.kind
  if (typeof kind !== 'string') return undefined
  return readKind(kind)
}

const readKind = (value: string): LegacyToolKind =>
  (['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'think', 'switch_mode', 'other'] as const).includes(value as LegacyToolKind)
    ? value as LegacyToolKind
    : 'other'

const readPermissionKind = (value: string): LegacyPermissionKind => value === 'allow_once' || value === 'allow_always' || value === 'reject_once' || value === 'reject_always' ? value : 'reject_once'

const readRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const legacyPermissionRequest = (request: RequestPermissionRequest): ConversationRuntimePermissionRequest => {
  const subject = request.subject?.type === 'tool_call' ? request.subject : undefined
  const toolCall = subject === undefined ? undefined : readRecord(subject.toolCall)
  const toolCallId = typeof toolCall?.toolCallId === 'string' ? toolCall.toolCallId : ''
  return {
    sessionId: request.sessionId,
    raw: {
      sessionId: request.sessionId,
      toolCall: {
        toolCallId,
        title: request.title,
        kind: readInferredKind(request),
      rawInput: toolCall?.rawInput,
      },
      options: request.options.map(option => ({ optionId: option.optionId, name: option.name, kind: readPermissionKind(option.kind) })),
      _meta: request._meta ?? undefined,
    },
    inferredKind: readInferredKind(request),
  }
}
