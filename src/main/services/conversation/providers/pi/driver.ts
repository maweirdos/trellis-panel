import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as Effect from 'effect/Effect'
import { z } from 'zod'
import { ProviderDriverKind, ProviderInstanceId } from '../../../../../shared/conversation/providerInstance'
import { cleanModelDisplayName } from '../../../../../shared/model-selection'
import type { AcpSessionRecord } from '../../../../../shared/types'
import type { WorkcopyLease, WorkcopyOwner } from '../../../../../shared/workcopy-use'
import { DaemonError } from '../../../../daemon/errors'
import { readBounded, writeExclusiveAtomic } from '../../../../daemon/files'
import { resolveNodeRuntime, validateNodeExecutable } from '../../../acp/managed-node'
import { findExecutable } from '../../../acp/setup'
import { knowledgeMcpBridge, type KnowledgeMcpConnection } from '../../../knowledge-mcp'
import { piEngineEntry } from '../../../pi/catalog'
import { PiOperationReceipts } from '../../../pi/engine/operation-receipts'
import { projectPiState } from '../../../pi/metadata'
import { piConfiguredModels } from '../../../pi/models'
import { PI_VERSION, piRequestIdSchema, piTextMetaSchema, type PiOperationReceipt } from '../../../pi/protocol'
import { PiConversationRuntime, PiInputRejectedError, type PiSdkTurn } from '../../../pi/runtime'
import type { ConversationRuntimePermissionRequest } from '../../../pi/runtime-port'
import { checkedDirectory, directoryIdentity, ownedDirectory, pathKey } from '../../../private-conversations/files'
import { getSettings } from '../../../store'
import { resolveWorkcopy, workcopyUseDirectory, workcopyUseRegistry } from '../../../workcopy-use'
import { createAcpJobOwner } from '../../../workcopy-use/acp-jobs'
import {
  ConversationTurnOutcomeUnknownError, ConversationTurnRejectedError,
  type ConversationDriverDescriptor, type ConversationDriverEventListener, type ConversationDriverOpenInput, type ConversationStartTurnContext,
  type ConversationDriverRegistration, type ConversationDriverRuntimeRequest, type ConversationDriverSession,
  type ConversationInterruptTurnInput, type ConversationRespondToRuntimeRequestInput, type ConversationResumeThreadInput, type ConversationSteerTurnInput,
} from '../registry'

const nativeThreadIdSchema = z.string().uuid()
const bindingSchema = z.object({
  sessionKey: z.string().uuid(), nativeThreadId: nativeThreadIdSchema, sessionFile: z.string().min(1),
  rootIdentity: z.string().min(1), model: z.string().min(1),
}).strict()
type Binding = z.infer<typeof bindingSchema>
type ActiveTurn = {
  id: string
  work: PiSdkTurn
}
type Slot = {
  owner: WorkcopyOwner
  runtime: PiConversationRuntime
  knowledge?: KnowledgeMcpConnection
  nativeThreadId?: string
  lease?: WorkcopyLease
  active?: ActiveTurn
}
type PiPermissionDecision = 'allow-once' | 'deny'

const asError = (error: unknown): Error => error instanceof Error ? error : new Error('Pi SDK 操作失败')
const effect = <Value>(action: () => Promise<Value>): Effect.Effect<Value, Error> =>
  Effect.tryPromise({ try: action, catch: asError })

function nodeExecutable(): Promise<string> {
  return resolveNodeRuntime({
    explicitPath: getSettings().acp?.nodePath,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    pathNode: findExecutable(process.platform === 'win32' ? 'node.exe' : 'node'),
    validate: async (path, options) => {
      const node = await validateNodeExecutable(path, options)
      const [major = 0, minor = 0] = node.version.slice(1).split('.').map(Number)
      if (major === 22 && minor < 19) throw new Error('Pi SDK 需要外部 Node.js 22.19 或更高版本')
      return node
    },
  }).then(node => node.path)
}

class PiConversationDriver implements ConversationDriverSession {
  private readonly root: string
  private readonly rootIdentity: string
  private readonly directory: string
  private readonly node: string
  private readonly entry: string
  private readonly slots = new Set<Slot>()
  private readonly sessions = new Map<string, Slot>()
  private readonly opening = new Map<string, Promise<string>>()
  private readonly permissions = new Map<string, { turnId: string; nativeThreadId: string; resolve: (value: PiPermissionDecision) => void }>()
  private closing = false

  constructor(private readonly options: ConversationDriverOpenInput, node: string, entry: string) {
    this.root = checkedDirectory(options.cwd)
    this.rootIdentity = directoryIdentity(this.root)
    this.directory = ownedDirectory(options.directory, 'conversation-pi')
    this.node = node
    this.entry = entry
  }

  isAvailable(): boolean { return !this.closing }

  private assertRoot(cwd: string): void {
    if (this.closing) throw new DaemonError('E_UNAVAILABLE', 'Pi SDK 正在关闭')
    if (pathKey(checkedDirectory(cwd)) !== pathKey(this.root) || directoryIdentity(this.root) !== this.rootIdentity) {
      throw new DaemonError('E_CONFLICT', 'Pi SDK 工作目录已变化')
    }
  }

  private bindingPath(nativeThreadId: string): string {
    return join(ownedDirectory(this.directory, 'native-bindings'), `${nativeThreadIdSchema.parse(nativeThreadId)}.json`)
  }

  private loadBinding(nativeThreadId: string): Binding {
    const file = this.bindingPath(nativeThreadId)
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new DaemonError('E_DENIED', 'Pi SDK 绑定文件不可用')
    const binding = bindingSchema.parse(JSON.parse(readBounded(file, 16 * 1024)))
    if (binding.nativeThreadId !== nativeThreadId || binding.rootIdentity !== this.rootIdentity) throw new DaemonError('E_DENIED', 'Pi SDK 会话不属于原工程')
    return binding
  }

  private releaseLease(slot: Slot, outcome: 'settled' | 'cleanup-confirmed'): void {
    const lease = slot.lease
    if (!lease) return
    const release = workcopyUseRegistry().release({ token: lease.token, owner: slot.owner, outcome })
    if (!release.released) throw new DaemonError('E_UNKNOWN', 'Pi SDK 原工作副本使用尚未确认清理', 'unknown')
    slot.lease = undefined
  }

  private async closeSlot(slot: Slot): Promise<void> {
    slot.knowledge?.revoke()
    try { await slot.runtime.shutdown() }
    catch (error) {
      if (slot.lease) slot.lease = workcopyUseRegistry().retainUnknown(this.root, slot.owner, slot.lease)
      throw error
    }
    this.releaseLease(slot, 'cleanup-confirmed')
    if (slot.nativeThreadId && this.sessions.get(slot.nativeThreadId) === slot) this.sessions.delete(slot.nativeThreadId)
    this.slots.delete(slot)
  }

  close(): Effect.Effect<void, Error> {
    return effect(async () => {
      this.closing = true
      // Let in-flight native spawns settle first: cleaning a Job while its spawn
      // witness is still being published races the durable owner record.
      await Promise.allSettled(this.opening.values())
      const results = await Promise.allSettled([...this.slots].map(slot => this.closeSlot(slot)))
      if (results.some(result => result.status === 'rejected') || this.slots.size) {
        throw new DaemonError('E_UNKNOWN', 'Pi SDK 原进程或工程使用尚未确认清理', 'unknown')
      }
    })
  }

  listModels(): ReturnType<ConversationDriverSession['listModels']> {
    return this.describe().pipe(Effect.map(catalog => catalog.models))
  }

  describe(): Effect.Effect<ConversationDriverDescriptor, Error> {
    return Effect.try({
      try: () => {
        const catalog = piConfiguredModels()
        const verified = (detail: string) => ({ state: 'verified' as const, source: 'host-policy' as const, detail })
        const unknown = (detail: string) => ({ state: 'unknown' as const, source: 'host-policy' as const, detail })
        const unsupported = (detail: string) => ({ state: 'unsupported' as const, source: 'host-policy' as const, detail })
        return {
          version: PI_VERSION, configurationKey: catalog.revision, observedAt: new Date().toISOString(), source: 'native-catalog',
          models: catalog.models.map(model => ({ id: model.selectionId, displayName: cleanModelDisplayName(model.label) || model.modelId,
            isDefault: model.selectionId === catalog.defaultModelId })),
          options: [],
          actions: { chat: unknown('已配置模型，实际连接和回复在本轮核验'), planning: unsupported('工程规划的受限工具与任务授权尚未接入'),
            execution: unsupported('托管任务授权尚未接入'), cancel: verified('SDK abort 精确作用于原操作'), resume: verified('按原目录和 SDK 会话文件恢复'),
            goal: unsupported('SDK 未提供本驱动可用的目标 API'), goalPause: unsupported('SDK 未提供本驱动可用的目标 API'),
            compact: verified('SDK Session.compact'), nativeSubthreads: unsupported('SDK 未提供本驱动可用的原生子线程'),
            modelSwitch: unsupported('显式切换需要新授权'), readOnly: unsupported('此驱动未开放只读规划'),
            toolApproval: verified('工作区写入、执行与其他未知工具需要原请求的一次性批准') },
        } satisfies ConversationDriverDescriptor
      }, catch: asError,
    })
  }

  private async makeThread(model: string, cwd: string, binding?: Binding): Promise<string> {
    this.assertRoot(cwd)
    this.options.assertCanSpawn()
    if (!piConfiguredModels().models.some(option => option.selectionId === model)) throw new DaemonError('E_UNAVAILABLE', '所选 Pi 模型未启用')
    if (binding && binding.model !== model) throw new DaemonError('E_CONFLICT', '请使用原模型恢复 Pi SDK 会话')
    const sessionKey = binding?.sessionKey ?? randomUUID()
    const generation = randomUUID()
    const owner: WorkcopyOwner = { kind: 'agent', id: sessionKey, generation, label: 'Crux Agent (Pi SDK)' }
    const meta: AcpSessionRecord = {
      engine: 'pi', sessionId: sessionKey, agentId: 'pi', agentName: owner.label,
      projectRoot: this.root, cwd: this.root, status: 'starting', startedAt: Date.now(), events: [],
      currentModeId: 'workspace', connectionGeneration: generation,
      launchOptionsSnapshot: { modelId: model },
      ...(binding ? { backendSessionId: binding.nativeThreadId, pi: { sessionFile: binding.sessionFile, version: PI_VERSION, sessionVersion: 3 } } : {}),
    }
    const jobs = process.platform === 'win32' ? await createAcpJobOwner(workcopyUseDirectory(), this.root, owner) : undefined
    const knowledge = await knowledgeMcpBridge.connect({ root: this.root, sessionId: sessionKey, connectionGeneration: generation }, () => {}).catch(() => undefined)
    let runtime: PiConversationRuntime
    try {
      runtime = new PiConversationRuntime({
        meta, argv: [this.node, this.entry], dataDirectory: checkedDirectory(this.directory), nativeJobs: jobs,
        mcpServers: () => knowledge?.servers().map(server => ({ name: 'trellis_knowledge', config: {
          type: 'http', url: server.url, headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])), exposure: 'direct',
        } })) ?? [],
        onBeforeSpawn: () => { this.assertRoot(cwd); if (this.closing) throw new DaemonError('E_UNAVAILABLE', 'Pi SDK 正在关闭'); this.options.assertCanSpawn() },
        onSpawned: () => {},
        onState: state => projectPiState(meta, state),
        onExit: () => knowledge?.disconnect(),
      })
    } catch (error) {
      knowledge?.revoke()
      await jobs?.cleanupAll()
      throw error
    }
    const slot: Slot = { owner, runtime, knowledge }
    this.slots.add(slot)
    try {
      const handle = await runtime.ensureSession({ sessionKey, agent: 'pi', cwd: this.root, mode: 'persistent' })
      this.assertRoot(cwd)
      const nativeThreadId = nativeThreadIdSchema.parse(handle.backendSessionId)
      if (!meta.pi || meta.currentModelId !== model || binding && nativeThreadId !== binding.nativeThreadId) throw new Error('Pi SDK 未确认所选模型或原会话身份')
      if (!binding) writeExclusiveAtomic(this.bindingPath(nativeThreadId), JSON.stringify(bindingSchema.parse({
        sessionKey, nativeThreadId, sessionFile: meta.pi.sessionFile, model, rootIdentity: this.rootIdentity,
      })))
      slot.nativeThreadId = nativeThreadId
      this.sessions.set(nativeThreadId, slot)
      return nativeThreadId
    } catch (error) {
      try { await this.closeSlot(slot) }
      catch (cleanup) {
        throw Object.assign(new DaemonError('E_UNKNOWN', 'Pi SDK 启动失败，原进程的清理尚待核对', 'unknown'), {
          cause: new AggregateError([error, cleanup]),
        })
      }
      throw error
    }
  }

  startThread(model: string, cwd: string): Effect.Effect<string, Error> {
    return effect(async () => {
      const key = randomUUID()
      const operation = this.makeThread(model, cwd)
      this.opening.set(key, operation)
      try { return await operation } finally { this.opening.delete(key) }
    })
  }

  resumeThread({ nativeThreadId, cwd, model }: ConversationResumeThreadInput): Effect.Effect<string, Error> {
    return effect(async () => {
      this.assertRoot(cwd)
      const binding = this.loadBinding(nativeThreadId)
      if (binding.model !== model) throw new DaemonError('E_CONFLICT', '请使用原模型恢复 Pi SDK 会话')
      const pending = this.opening.get(nativeThreadId)
      if (pending) return pending
      const existing = this.sessions.get(nativeThreadId)
      if (existing?.runtime.available) return nativeThreadId
      const operation = (async () => {
        if (existing) await this.closeSlot(existing)
        return this.makeThread(model, cwd, binding)
      })()
      this.opening.set(nativeThreadId, operation)
      try { return await operation } finally { this.opening.delete(nativeThreadId) }
    })
  }

  private currentTurn(nativeThreadId: string, turnId: string): ActiveTurn {
    const active = this.sessions.get(nativeThreadId)?.active
    if (!active || active.id !== turnId) throw new DaemonError('E_CONFLICT', 'Pi SDK 原回合已结束或已变化')
    return active
  }

  private controlFailure(error: unknown): Error {
    if (error instanceof PiInputRejectedError) return new ConversationTurnRejectedError(asError(error).message, { cause: error })
    return error instanceof ConversationTurnOutcomeUnknownError || error instanceof ConversationTurnRejectedError ? error
      : new ConversationTurnOutcomeUnknownError('', { cause: error })
  }

  interruptTurn({ nativeThreadId, turnId }: ConversationInterruptTurnInput): Effect.Effect<void, Error> {
    return effect(async () => {
      try { await this.currentTurn(nativeThreadId, turnId).work.requestCancel() }
      catch (error) { throw this.controlFailure(error) }
    })
  }

  steerTurn({ nativeThreadId, turnId, text, requestId = randomUUID() }: ConversationSteerTurnInput & { requestId?: string }): Effect.Effect<void, Error> {
    return effect(async () => {
      this.currentTurn(nativeThreadId, turnId)
      const slot = this.sessions.get(nativeThreadId)
      if (!slot) throw new DaemonError('E_CONFLICT', 'Pi SDK 原会话不存在')
      try { await slot.runtime.steer(turnId, requestId, text) }
      catch (error) { throw this.controlFailure(error) }
    })
  }

  respondToRuntimeRequest({ nativeThreadId, turnId, nativeRequestId, response }: ConversationRespondToRuntimeRequestInput): Effect.Effect<void, Error> {
    return Effect.try({
      try: () => {
        this.currentTurn(nativeThreadId, turnId)
        const pending = this.permissions.get(nativeRequestId)
        if (!pending || pending.turnId !== turnId || pending.nativeThreadId !== nativeThreadId) throw new DaemonError('E_CONFLICT', 'Pi SDK 原请求已过期')
        if (response.kind !== 'approval' || !['accept', 'decline', 'cancel'].includes(response.decision)) {
          throw new DaemonError('E_INVALID_ARG', 'Pi SDK 此请求只接受本次批准、拒绝或取消')
        }
        pending.resolve(response.decision === 'accept' ? 'allow-once' : 'deny')
      }, catch: asError,
    })
  }

  private requestPermission(nativeThreadId: string, turnId: string, input: ConversationRuntimePermissionRequest,
    signal: AbortSignal, onEvent: ConversationDriverEventListener): Promise<PiPermissionDecision> {
    this.currentTurn(nativeThreadId, turnId)
    if (signal.aborted) return Promise.resolve('deny')
    const nativeRequestId = randomUUID()
    const request: ConversationDriverRuntimeRequest = { kind: 'approval', title: input.raw.toolCall.title ?? 'Pi SDK 工具授权',
      options: [{ decision: 'accept', label: '允许本次' }, { decision: 'decline', label: '拒绝' }] }
    return new Promise<PiPermissionDecision>((resolve, reject) => {
      const settle = (decision: PiPermissionDecision): void => {
        signal.removeEventListener('abort', abort)
        this.permissions.delete(nativeRequestId)
        resolve(decision)
      }
      const abort = (): void => settle('deny')
      this.permissions.set(nativeRequestId, { turnId, nativeThreadId, resolve: settle })
      signal.addEventListener('abort', abort, { once: true })
      try { onEvent({ type: 'runtime-request', turnId, turnIdSource: 'host', nativeRequestId, request }) }
      catch (error) {
        signal.removeEventListener('abort', abort)
        this.permissions.delete(nativeRequestId)
        reject(error)
      }
    })
  }

  readOperation({ nativeThreadId, requestId }: { nativeThreadId: string; requestId: string }): Effect.Effect<PiOperationReceipt | null, Error> {
    return effect(async () => {
      this.assertRoot(this.root)
      const binding = this.loadBinding(nativeThreadId)
      const sessionDir = join(this.directory, 'pi', 'sessions', createHash('sha256').update(this.root).digest('hex'), binding.sessionKey)
      return new PiOperationReceipts(checkedDirectory(sessionDir), false).read(requestId)
    })
  }

  startTurn(nativeThreadId: string, cwd: string, text: string, model: string, onEvent: ConversationDriverEventListener, context?: ConversationStartTurnContext): Effect.Effect<string, Error> {
    return Effect.tryPromise({
      try: signal => this.run(nativeThreadId, cwd, text, model, onEvent, 'prompt', {
        ...context, signal,
      }),
      catch: asError,
    })
  }

  compactThread({ nativeThreadId, cwd, model, instructions, onEvent, requestId }: {
    nativeThreadId: string; cwd: string; model: string; instructions?: string; onEvent: ConversationDriverEventListener; requestId?: string
  }): Effect.Effect<string, Error> {
    return Effect.tryPromise({
      try: signal => this.run(nativeThreadId, cwd, instructions ?? '', model, onEvent, 'compact', { requestId, signal }),
      catch: asError,
    })
  }

  private async run(nativeThreadId: string, cwd: string, text: string, model: string, onEvent: ConversationDriverEventListener,
    kind: 'prompt' | 'compact', options?: { requestId?: string; signal?: AbortSignal; assertCurrent?: () => void }): Promise<string> {
    const turnId = piRequestIdSchema.parse(options?.requestId ?? randomUUID())
    this.assertRoot(cwd)
    const slot = this.sessions.get(nativeThreadId)
    if (!slot?.runtime.available || this.loadBinding(nativeThreadId).model !== model || slot.active) {
      throw new ConversationTurnRejectedError('Pi SDK 原会话未就绪、模型已变化或已有执行中的回合')
    }
    const registry = workcopyUseRegistry()
    const assertCurrent = (): void => {
      this.assertRoot(cwd)
      options?.assertCurrent?.()
      if (slot.lease) registry.assertHeld(this.root, slot.lease.token, slot.owner)
    }
    options?.signal?.throwIfAborted()
    assertCurrent()
    const identity = resolveWorkcopy(this.root)
    slot.lease = registry.acquire(this.root, { kind: 'writer', owner: slot.owner, expected: { id: identity.id, revision: identity.revision } })
    let work: PiSdkTurn | undefined
    let rejected = false
    const cancel = (): void => { void work?.cancel().catch(() => undefined) }
    try {
      const handle = slot.runtime.liveHandle()
      if (!handle) throw new ConversationTurnRejectedError('Pi SDK 原会话不可用')
      options?.signal?.throwIfAborted()
      assertCurrent()
      const generation = slot.owner.generation
      const input: Parameters<PiConversationRuntime['startTurn']>[0] = {
        handle, requestId: turnId, text, assertActive: assertCurrent,
        onPermissionRequest: async (request, context) => ({ outcome: { outcome: 'selected',
          optionId: await this.requestPermission(nativeThreadId, turnId, request, context.signal, onEvent) } }),
      }
      work = kind === 'compact' ? slot.runtime.compact(input, text) : slot.runtime.startTurn(input)
      slot.active = { id: turnId, work }
      try { slot.knowledge?.admit({ root: this.root, projectGeneration: 0, sessionId: slot.owner.id, connectionGeneration: generation,
        turnId, originalUserText: text, isCurrent: () => {
          try { assertCurrent(); return slot.active?.id === turnId } catch { return false }
        } }) } catch { /* Optional project knowledge can be unavailable. */ }
      options?.signal?.addEventListener('abort', cancel, { once: true })
      const receipt = await work.commandAccepted
      onEvent({ type: 'turn-receipt', turnId, turnIdSource: 'host' })
      const inserted = await work.promptStarted.then(() => true, () => false)
      if (inserted && receipt.kind === 'prompt') onEvent({ type: 'turn-accepted', turnId, turnIdSource: 'host' })
      for await (const event of work.events) {
        if (event.type !== 'text_delta' || event.stream === 'thought' || !event.messageId) continue
        const block = piTextMetaSchema.safeParse(event.meta && 'piText' in event.meta ? event.meta.piText : undefined)
        const itemId = block.success ? `${block.data.messageId}:${block.data.blockIndex}` : event.messageId
        onEvent({ type: block.success && block.data.operation === 'replace' ? 'text-final' : 'text-delta', turnId, turnIdSource: 'host', itemId, text: event.text })
      }
      const result = await work.result
      if (!work.hasNativeSettlement()) throw new ConversationTurnOutcomeUnknownError('')
      if (result.status === 'failed') onEvent({ type: 'turn-completed', turnId, turnIdSource: 'host', status: 'failed', error: result.error.message })
      else onEvent({ type: 'turn-completed', turnId, turnIdSource: 'host', status: result.status })
      return turnId
    } catch (error) {
      rejected = !work || error instanceof PiInputRejectedError
      if (rejected) throw new ConversationTurnRejectedError(asError(error).message, { cause: error })
      throw error instanceof ConversationTurnOutcomeUnknownError ? error : new ConversationTurnOutcomeUnknownError('', { cause: error })
    } finally {
      options?.signal?.removeEventListener('abort', cancel)
      slot.knowledge?.endTurn()
      slot.active = undefined
      try {
        if (rejected || !work || work.hasNativeSettlement()) this.releaseLease(slot, 'settled')
        else await this.closeSlot(slot)
      } catch (error) {
        if (!work) throw error
        throw new ConversationTurnOutcomeUnknownError('', { cause: error })
      }
    }
  }
}

export function createPiDriverRegistration(): ConversationDriverRegistration {
  return {
    instanceId: ProviderInstanceId.make('pi'),
    driverKind: ProviderDriverKind.make('pi'),
    configurationKey: () => { try { return piConfiguredModels().revision } catch { return 'pi-unconfigured' } },
    open: input => effect(async () => {
      input.assertCanSpawn()
      const entry = piEngineEntry()
      if (!existsSync(entry) || !lstatSync(entry).isFile() || relative(entry, realpathSync.native(entry)) !== '') {
        throw new DaemonError('E_UNAVAILABLE', 'Pi SDK worker 资源缺失，请重新安装 Crux')
      }
      const driver = new PiConversationDriver(input, await nodeExecutable(), entry)
      input.assertCanSpawn()
      input.onSpawn(driver)
      return driver
    }),
  }
}
