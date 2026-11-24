import { createHash } from 'node:crypto'
import type { ConversationAuthority } from '../../../shared/conversation/desktop'
import type { ProviderOptionSelections } from '../../../shared/conversation/model'
import type { NativeTaskStart } from '../../../shared/native-task-execution'
import { DaemonError } from '../errors'
import { directoryIdentity, pathKey } from '../../services/private-conversations/files'
import type { ConversationDriverRegistry } from '../../services/conversation/providers/registry'
import type { ConversationRuntime } from './conversation'

export interface ManagedTaskConversationAuthority extends ConversationAuthority {
  readonly binding: {
    readonly kind: 'task'
    readonly mode: 'execution'
    readonly taskId: string
    readonly taskCreatedAt: string
    readonly executionId: string
    readonly generation: number
    readonly nodeId: string
    readonly attempt: number
    readonly assigneeGeneration: number
    readonly materialRevision: string
    readonly codeRevision: string | null
  }
  assertCurrent(): Promise<void>
  assertSpawnCurrent(): void
}

export interface ManagedTaskConversationRoute {
  readonly digest: string
  readonly adapterVersion: string
  readonly capabilities: readonly string[]
  assertRouteCurrent(): void
}

export interface ManagedTaskConversationRun {
  readonly threadId: string
  readonly runId: string
  readonly nativeThreadId?: string
  readonly nativeTurnId?: string
  readonly engineAccepted: boolean
  readonly terminal?: 'completed' | 'failed' | 'cancelled'
  readonly outputSettled: boolean
  readonly finalText?: string
}

export interface ManagedTaskConversationPort {
  plan(cwd: string, engine: NativeTaskStart['engine']): Promise<ManagedTaskConversationRoute>
  launch(input: {
    authority: ManagedTaskConversationAuthority
    commandId: string
    instanceId: string
    model: string
    options?: ProviderOptionSelections
    text: string
  }): Promise<Pick<ManagedTaskConversationRun, 'threadId' | 'runId'>>
  read(authority: ConversationAuthority, commandId: string): ManagedTaskConversationRun | null
  close(authority: ConversationAuthority, commandId: string, instanceId: string): Promise<void>
}

export function managedTaskConversationPort(input: {
  readonly kernel: ConversationRuntime
  readonly drivers: ConversationDriverRegistry
  readonly adapterVersion: string
  assertOwner(): void
}): ManagedTaskConversationPort {
  const { kernel, drivers } = input
  const receipt = (authority: ConversationAuthority, commandId: string) =>
    kernel.readCommand(commandId, authority.ownerId, authority.spaceId, authority.projectId)
  return {
    async plan(cwd, engine) {
      input.assertOwner()
      const selection = engine.conversation
      if (!selection || engine.profileId) throw new DaemonError('E_UNAVAILABLE', '正式执行需要原生实例及其真实模型。')
      const registration = drivers.require(selection.instanceId)
      if (registration.driverKind !== engine.agentId || !registration.executionAccess ||
        selection.options?.length && !registration.turnModelOptions) {
        throw new DaemonError('E_UNAVAILABLE', '所选实例没有原工作副本的托管执行能力。')
      }
      const identity = directoryIdentity(cwd)
      const configuration = registration.configurationKey?.()
      const assertRouteCurrent = (): void => {
        input.assertOwner()
        if (directoryIdentity(cwd) !== identity || drivers.get(selection.instanceId)?.configurationKey?.() !== configuration) {
          throw new DaemonError('E_CONFLICT', '原工作副本或引擎配置已变化。')
        }
      }
      return {
        digest: createHash('sha256').update(JSON.stringify([pathKey(cwd), identity, engine, configuration, input.adapterVersion])).digest('hex'),
        adapterVersion: input.adapterVersion, capabilities: ['embeddedContext'], assertRouteCurrent,
      }
    },
    async launch({ authority, commandId, instanceId, model, options, text }) {
      await authority.assertCurrent()
      authority.assertSpawnCurrent()
      const result = kernel.createThread({
        ...authority, commandId, instanceId, model, options, text, title: '任务执行',
        assertCurrent: authority.assertSpawnCurrent, assertAuthorityCurrent: authority.assertCurrent,
      })
      return { threadId: result.threadId, runId: result.runId }
    },
    read(authority, commandId) {
      const original = receipt(authority, commandId)
      if (!original) return null
      const { threadId, runId } = original
      const snapshot = kernel.readThread(threadId, authority.ownerId, authority.spaceId, authority.projectId)
      const run = snapshot?.runs.find(item => item.id === runId)
      if (!run) return null
      const terminal = original.dispatch === 'completed' && run.status === 'completed' ? 'completed'
        : run.status === 'cancelled' || run.status === 'interrupted' ? 'cancelled'
          : original.dispatch === 'failed' ? 'failed' : undefined
      const finalMessages = snapshot?.messages.filter(item => item.runId === runId && item.role === 'assistant') ?? []
      const outputSettled = Boolean(terminal && !run.lifecycle?.backgroundRunning && !finalMessages.some(item => item.streaming))
      return {
        threadId, runId, nativeThreadId: run.providerThreadId ?? undefined, nativeTurnId: run.nativeTurnId,
        engineAccepted: Boolean(run.engineAcceptedAt), terminal, outputSettled,
        ...(terminal === 'completed' && outputSettled && { finalText: finalMessages.map(item => item.text).join('\n\n') }),
      }
    },
    async close(authority, commandId, instanceId) {
      const identity = directoryIdentity(authority.cwd)
      const assertCurrent = (): void => {
        input.assertOwner()
        if (directoryIdentity(authority.cwd) !== identity) throw new DaemonError('E_CONFLICT', '原任务工作副本的物理身份已变化。')
      }
      const original = receipt(authority, commandId)
      const stopId = `execution-stop:${commandId}`
      const confirmed = await kernel.cleanupTaskConversation({ receipt: original, instanceId, commandId: stopId },
        { ...authority, assertCurrent, assertSpawnCurrent: assertCurrent },
      )
      if (!confirmed) throw new DaemonError('E_UNKNOWN', '原任务引擎尚未确认关闭，保留工作副本租约。', 'unknown')
    },
  }
}
