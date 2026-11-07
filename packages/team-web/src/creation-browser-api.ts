import {
  creationCancelSchema, creationClientCommandSchema, creationClientGetSchema, creationClientListSchema,
  creationGenerateSchema, creationRecoverSchema, type CreationApi, type CreationList, type CreationReply
} from '../../../src/shared/creation-api'
import {
  creationCommandReplySchema, creationCommandResultSchema, creationHeadSchema, creationListSchema, creationViewSchema,
  type CreationCommandReply, type CreationCommandResult, type CreationHead
} from '../../../src/shared/creations'
import type { CruxWorkspaceContext } from '../../../src/shared/crux-remote'
import type { TeamSession } from './contracts'
import {
  ApiError, canRetry, isClientSession, pendingCommands, prepareCommand, reconcileCommand,
  request, sendCommand, verifyDocument, type PendingCommand, type PreparedCommand
} from './client'

type Options = {
  projectId: string
  session: TeamSession
  context(): CruxWorkspaceContext
  isCurrent(): boolean
  subscribe(callback: (context: CruxWorkspaceContext) => void): () => void
}
type Owner = { context: CruxWorkspaceContext & { epoch: string; instanceId: string }; current(): boolean }
const POLL_INTERVAL_MS = 8000
// The common journal persists only references; original bodies stay in page memory.
const retained = new Map<string, PreparedCommand<CreationCommandResult>>()

/** Creation transport owned by one authenticated browser workspace lease. */
export class BrowserCreationApi implements CreationApi {
  private live = true
  private readonly lifetime = new AbortController()
  private readonly busy = new Set<string>()
  private readonly listeners = new Set<Parameters<CreationApi['onChanged']>[0]>()
  private fingerprint: string | null = null
  private headRequest = 0
  private pollAbort: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private unsubscribe: (() => void) | null = null
  private source = ''

  constructor(private readonly options: Options) {
    for (const [id, prepared] of retained) {
      if (prepared.entry.accountId !== options.session.person.userId || prepared.entry.workspace?.origin !== location.origin) retained.delete(id)
    }
  }

  private signature(context: CruxWorkspaceContext): string { return JSON.stringify([context.key, context.actorId, context.instanceId, context.epoch, context.authorizationRevision]) }
  private owner(workspaceKey: string): Owner {
    const context = this.options.context(), signature = this.signature(context)
    const current = (): boolean => this.live && this.options.isCurrent() && isClientSession(this.options.session)
      && this.signature(this.options.context()) === signature && this.options.context().state !== 'access-revoked'
    if (!current() || context.key !== workspaceKey || context.projectId !== this.options.projectId || context.actorId !== this.options.session.person.userId) throw new ApiError('OWNER_CHANGED', '创作工作区的账号、工作区或来源已改变')
    if (!context.epoch || !context.instanceId) throw new ApiError('WORKSPACE_UNAVAILABLE', '请先连接当前工作区工作区')
    return { context: { ...context, epoch: context.epoch, instanceId: context.instanceId }, current }
  }
  private assertCurrent(owner: Owner): void { if (!owner.current()) throw new ApiError('OWNER_CHANGED', '创作来源已改变，未采用旧来源的结果') }
  private failure(error: unknown, outcomeUnknown = false): CreationReply<never> {
    const value = error instanceof ApiError ? error : new ApiError('CREATION_BROWSER_ERROR', error instanceof Error ? error.message : '创作请求失败')
    return { ok: false, code: value.code, error: value.message, ...(value.uncertain || outcomeUnknown ? { outcomeUnknown: true } : {}) }
  }
  private path(suffix = ''): string { return `/api/projects/${encodeURIComponent(this.options.projectId)}/creations${suffix}` }
  private emit(creationId: string | null): void {
    if (!this.live || !this.options.isCurrent() || !isClientSession(this.options.session)) return
    const event = { workspaceKey: this.options.context().key, creationId }
    for (const listener of this.listeners) { try { listener(event) } catch { /* A consumer cannot change a committed command outcome. */ } }
  }
  private async readList(owner: Owner, query: Omit<Parameters<CreationApi['list']>[0], 'workspaceKey'>): Promise<CreationList> {
    this.assertCurrent(owner)
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value))
    const value = await request(this.path() + `?${search}`, creationListSchema, { signal: this.lifetime.signal, notifyDenied: false, isCurrent: owner.current })
    if (value.items.some((item) => item.projectId !== this.options.projectId || query.scope === 'personal' && (item.ownerId !== this.options.session.person.userId || item.home !== 'personal'))) throw new ApiError('INVALID_RESPONSE', '创作列表的工作区或个人范围不匹配')
    return value
  }

  async list(input: Parameters<CreationApi['list']>[0]): ReturnType<CreationApi['list']> {
    try {
      const { workspaceKey, ...query } = creationClientListSchema.parse(input), owner = this.owner(workspaceKey)
      const value = await this.readList(owner, query)
      await this.scopedHead(owner, this.lifetime.signal)
      this.assertCurrent(owner)
      return { ok: true, value }
    } catch (error) { return this.failure(error) }
  }

  async get(input: Parameters<CreationApi['get']>[0]): ReturnType<CreationApi['get']> {
    try {
      const { workspaceKey, creationId, ...query } = creationClientGetSchema.parse(input), owner = this.owner(workspaceKey)
      const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))
      const value = await request(this.path(`/${encodeURIComponent(creationId)}`) + `?${search}`, creationViewSchema, { signal: this.lifetime.signal, notifyDenied: false, isCurrent: owner.current })
      if (value.summary.projectId !== this.options.projectId || value.summary.creationId !== creationId || query.revisionId && value.selected.revisionId !== query.revisionId) throw new ApiError('INVALID_RESPONSE', '创作正文的工作区或版本身份不匹配')
      await verifyDocument(value.selected.body, value.selected.bodyDigest, new TextEncoder().encode(value.selected.body).byteLength)
      await this.scopedHead(owner, this.lifetime.signal)
      this.assertCurrent(owner)
      return { ok: true, value }
    } catch (error) { return this.failure(error) }
  }

  private entries(creationId: string): PendingCommand[] {
    return pendingCommands(this.options.session.person.userId).filter((entry) => entry.projectId === this.options.projectId && entry.path === this.path('/commands')
      && entry.workspace?.origin === location.origin && entry.workspace.operation.startsWith(`creation:${creationId}:`))
  }
  private validateReceipt(raw: unknown, entry: PendingCommand, owner: Owner): CreationCommandResult {
    if (!owner.current()) throw new ApiError('OWNER_CHANGED', '原操作的创作来源已改变，回执仍需由原账号核对', 0, true)
    const parsed = creationCommandResultSchema.safeParse(raw), scope = entry.workspace
    if (!parsed.success || !scope) throw new ApiError('INVALID_RESPONSE', '创作回执结构或原来源引用不完整', 0, true)
    const value = parsed.data
    if (value.projectId !== this.options.projectId || scope.operation !== `creation:${value.creationId}:${value.action}` || value.epoch !== scope.epoch
      || value.revision !== scope.expectedRevision + 1 || scope.epoch !== owner.context.epoch || scope.instanceId !== owner.context.instanceId) throw new ApiError('INVALID_RESPONSE', '创作回执的工作区、原操作、来源代次或修订不匹配', 0, true)
    return value
  }
  private validateEntry(entry: PendingCommand, owner: Owner): void {
    if (entry.workspace?.epoch !== owner.context.epoch || entry.workspace.instanceId !== owner.context.instanceId) throw new ApiError('EPOCH_CONFLICT', '原创作操作属于先前服务实例或代次，不能迁移重放', 409, true)
  }
  private written(reply: CreationCommandReply): void {
    retained.delete(reply.commandId)
    // Keep the project head baseline independent: another computer may have
    // updated a different creation concurrently with this acknowledged write.
    this.emit(reply.result.creationId)
  }
  private async send(prepared: PreparedCommand<CreationCommandResult>, owner: Owner): Promise<CreationCommandReply> {
    this.validateEntry(prepared.entry, owner)
    try {
      const reply = await sendCommand(prepared, { signal: this.lifetime.signal, notifyDenied: false, isCurrent: owner.current,
        validateResult: (raw) => { this.validateReceipt(raw, prepared.entry, owner) } })
      this.assertCurrent(owner)
      const value = creationCommandReplySchema.parse(reply)
      this.written(value)
      return value
    } finally {
      try {
        const remaining = new Set(pendingCommands(this.options.session.person.userId).map((entry) => entry.commandId))
        for (const [id, value] of retained) if (value.entry.accountId === this.options.session.person.userId && !remaining.has(id)) retained.delete(id)
      } catch { /* Preserve original bodies if the journal cannot currently be read. */ }
    }
  }

  async command(input: Parameters<CreationApi['command']>[0]): ReturnType<CreationApi['command']> {
    let locked: string | undefined
    let preparedId: string | undefined
    try {
      const parsed = creationClientCommandSchema.parse(input), owner = this.owner(parsed.workspaceKey), command = parsed.command
      if (this.busy.has(command.creationId)) throw new ApiError('IN_FLIGHT', '此创作的原操作正在准备或核对')
      this.busy.add(command.creationId); locked = command.creationId
      if (this.entries(command.creationId).length) throw new ApiError('PENDING_OPERATION', '此创作有原操作待核对，请先恢复原回执', 0, true)
      if (command.expectedEpoch && command.expectedEpoch !== owner.context.epoch) throw new ApiError('EPOCH_CONFLICT', '创作来源代次已改变，请重新读取后再提交', 409)
      // Retain the command owner's UUID in the journal, wire payload and receipt.
      preparedId = command.commandId
      const prepared = await prepareCommand(this.path('/commands'), { ...command, expectedEpoch: owner.context.epoch }, creationCommandResultSchema, this.options.projectId,
        { origin: location.origin, instanceId: owner.context.instanceId, epoch: owner.context.epoch, operation: `creation:${command.creationId}:${command.action}`, expectedRevision: command.expectedRevision ?? 0 }, command.commandId)
      retained.set(prepared.entry.commandId, prepared)
      this.assertCurrent(owner)
      return { ok: true, value: await this.send(prepared, owner) }
    } catch (error) {
      let journalPending = false
      if (preparedId) {
        try { journalPending = pendingCommands(this.options.session.person.userId).some((entry) => entry.commandId === preparedId) }
        catch { journalPending = true }
      }
      return this.failure(error, journalPending)
    }
    finally { if (locked) this.busy.delete(locked) }
  }

  async recover(input: Parameters<CreationApi['recover']>[0]): ReturnType<CreationApi['recover']> {
    let locked: string | undefined
    let reconciling = false
    try {
      const { workspaceKey, creationId, commandId, expectedEpoch } = creationRecoverSchema.parse(input), owner = this.owner(workspaceKey)
      if (commandId && expectedEpoch !== owner.context.epoch) throw new ApiError('EPOCH_CONFLICT', '原操作的来源代次已改变', 409, true)
      if (this.busy.has(creationId)) throw new ApiError('IN_FLIGHT', '此创作的原操作正在核对')
      this.busy.add(creationId); locked = creationId
      const entry = this.entries(creationId)[0]
      if (!entry) return { ok: true, value: null }
      if (commandId && (entry.commandId !== commandId || entry.workspace?.operation !== `creation:${creationId}:create`)) throw new ApiError('PENDING_OPERATION', '待核对记录与原创建操作不一致', 0, true)
      reconciling = true
      this.validateEntry(entry, owner)
      let result: CreationCommandResult | undefined
      const outcome = await reconcileCommand(entry, { signal: this.lifetime.signal, notifyDenied: false, isCurrent: owner.current,
        validateResult: (raw) => { result = this.validateReceipt(raw, entry, owner) } })
      this.assertCurrent(owner)
      if (outcome === 'committed' && result) {
        const value: CreationCommandReply = { status: 'duplicate', commandId: entry.commandId, result }
        this.written(value)
        return { ok: true, value }
      }
      const prepared = retained.get(entry.commandId)
      if (!prepared || !canRetry(entry)) throw new ApiError('PAYLOAD_UNAVAILABLE', '原回执尚未确认；页面重载后没有原载荷，不能重建请求或分配新操作标识', 0, true)
      return { ok: true, value: await this.send({ ...prepared, entry }, owner) }
    } catch (error) { return this.failure(error, reconciling) }
    finally { if (locked) this.busy.delete(locked) }
  }

  private unavailableModel(input: Parameters<CreationApi['planCandidate']>[0]): CreationReply<never> {
    try { this.owner(creationGenerateSchema.parse(input).workspaceKey); throw new ApiError('MODEL_UNAVAILABLE', '网页版没有已配置的模型服务；请在桌面端使用已配置的模型生成候选版本') }
    catch (error) { return this.failure(error) }
  }
  async planCandidate(input: Parameters<CreationApi['planCandidate']>[0]): ReturnType<CreationApi['planCandidate']> { return this.unavailableModel(input) }
  async generateCandidate(input: Parameters<CreationApi['generateCandidate']>[0]): ReturnType<CreationApi['generateCandidate']> { return this.unavailableModel(input) }
  async cancelCandidate(input: Parameters<CreationApi['cancelCandidate']>[0]): ReturnType<CreationApi['cancelCandidate']> {
    try { this.owner(creationCancelSchema.parse(input).workspaceKey); return { ok: true, value: { cancelled: false } } }
    catch (error) { return this.failure(error) }
  }

  onChanged(callback: Parameters<CreationApi['onChanged']>[0]): () => void {
    if (!this.live) return () => {}
    this.listeners.add(callback)
    if (!this.unsubscribe) {
      this.source = this.signature(this.options.context())
      this.unsubscribe = this.options.subscribe((context) => {
        const source = this.signature(context)
        if (source !== this.source) {
          this.source = source; this.fingerprint = null; this.headRequest++; this.pausePolling()
          if (this.activePolling() && !this.polling) void this.poll()
        }
      })
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibilityChanged)
    }
    if (this.activePolling() && !this.polling && !this.timer) void this.poll()
    return () => {
      this.listeners.delete(callback)
      if (!this.listeners.size) {
        this.pausePolling(); this.fingerprint = null; this.headRequest++; this.unsubscribe?.(); this.unsubscribe = null
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibilityChanged)
      }
    }
  }
  private activePolling(): boolean {
    return this.live && this.listeners.size > 0 && this.options.isCurrent() && isClientSession(this.options.session)
      && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
  }
  private visibilityChanged = (): void => {
    if (!this.activePolling()) this.pausePolling()
    else if (!this.polling && !this.timer) void this.poll()
  }
  private pausePolling(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; this.pollAbort?.abort() }
  private schedule(): void {
    if (this.timer || this.polling || !this.activePolling()) return
    this.timer = setTimeout(() => { this.timer = null; void this.poll() }, POLL_INTERVAL_MS)
  }
  private async scopedHead(owner: Owner, signal: AbortSignal): Promise<CreationHead> {
    this.assertCurrent(owner)
    const value = await request(this.path('/head'), creationHeadSchema, { signal, notifyDenied: false, isCurrent: owner.current })
    this.assertCurrent(owner)
    if (value.projectId !== this.options.projectId || value.epoch !== owner.context.epoch) throw new ApiError('EPOCH_CONFLICT', '创作元数据不属于当前工作区或来源代次', 409)
    return value
  }
  private async readHead(owner: Owner, signal: AbortSignal): Promise<void> {
    const requestId = ++this.headRequest
    const value = await this.scopedHead(owner, signal)
    if (signal.aborted || requestId !== this.headRequest) return
    const previous = this.fingerprint
    this.fingerprint = value.fingerprint
    if (previous !== null && previous !== value.fingerprint) this.emit(null)
  }
  private async poll(): Promise<void> {
    if (!this.activePolling() || this.polling) return
    this.polling = true
    const controller = new AbortController()
    this.pollAbort = controller
    try {
      await this.readHead(this.owner(this.options.context().key), controller.signal)
    } catch { /* Retain the last verified fingerprint and retry on the bounded interval. */ }
    finally { this.pollAbort = null; this.polling = false; this.schedule() }
  }
  dispose(): void {
    this.live = false; this.lifetime.abort(); this.pausePolling(); this.headRequest++
    this.unsubscribe?.(); this.unsubscribe = null; this.listeners.clear(); this.fingerprint = null
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibilityChanged)
  }
}
