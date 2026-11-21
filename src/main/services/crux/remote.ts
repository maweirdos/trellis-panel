import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CruxSnapshot } from '../../../shared/crux'
import { cruxMutationInputSchemas, cruxMutationNameSchema } from '../../../shared/crux-domain/commands'
import { cruxRemoteCommandSchema, cruxRemoteSnapshotSchema, type CruxRemoteCommand, type CruxRemoteSnapshot, type CruxWorkspaceContext } from '../../../shared/crux-remote'
import type { DesktopTeamService } from '../team-platform/service'
import { DesktopTeamError } from '../team-platform/types'
import { isTerminalCruxRevisionConflict, isVerifiedCruxCommandDenial } from '../team-platform/http'
import { CruxRemotePersistence, remoteBindingSchema, remoteScopeKey, type CruxRemoteBinding, type CruxRemotePending, type CruxRemotePersisted } from './remote-persistence'

export type CruxRemoteTransport = Pick<DesktopTeamService, 'connections' | 'connectionContext' | 'cruxSnapshot' | 'cruxCommand' | 'cruxReceipt' | 'cruxRevalidate'>
export type CruxRemoteOptions = {
  dataDir: string
  service?: CruxRemoteTransport
  withService?: <T>(action: (service: CruxRemoteTransport) => Promise<T>) => Promise<T>
  autoPoll?: boolean
  pollWaitMs?: number
  pollIntervalMs?: number
  onChanged?: (context: CruxWorkspaceContext, viewFingerprint?: string) => void
}
export type CruxRemoteView = { snapshot: CruxSnapshot | null; context: CruxWorkspaceContext; freshness?: 'remote' | 'cached-offline'; authorization?: 'current-server' | 'last-observed' }
export type CruxRemoteExecution = { snapshot: CruxSnapshot; context: CruxWorkspaceContext; taskId?: string }
export type CruxRemoteResult =
  | { ok: true; data: CruxSnapshot; snapshot: CruxSnapshot; context: CruxWorkspaceContext; taskId?: string }
  | { ok: false; error: string; code: string; outcomeUnknown: boolean; pending: boolean; context: CruxWorkspaceContext }
type Selection = { binding: CruxRemoteBinding; key: string; persistence: CruxRemotePersistence; saved: CruxRemotePersisted; context: CruxWorkspaceContext; epoch: number; viewGeneration: number; viewFingerprint?: string }
const lockedCodes = new Set(['ACCESS_LOCKED', 'UNAUTHENTICATED', 'UNAUTHORIZED', 'FORBIDDEN', 'DEVICE_REVOKED', 'ACCOUNT_DISABLED', 'AUTHENTICATION_REQUIRED', 'CREDENTIAL_UNAVAILABLE', 'BINDING_CHANGED', 'LOCAL_DISCONNECTED'])
const offlineCodes = new Set(['NETWORK_UNAVAILABLE', 'ACKNOWLEDGEMENT_UNKNOWN'])
const epochCodes = new Set(['EPOCH_CONFLICT', 'WORKSPACE_EPOCH_CHANGED'])
const fencedPending = (pending: CruxRemotePending | null, code = 'EPOCH_CONFLICT', proved = false): CruxRemotePending | null => {
  if (!pending) return null
  const unknown = !proved && (pending.outcomeUnknown || pending.state === 'dispatching' || pending.state === 'acknowledgement-unknown')
  return { ...pending, state: unknown ? 'acknowledgement-unknown' : 'conflict', outcomeUnknown: unknown, errorCode: code }
}
export class CruxRemoteClientError extends Error {
  constructor(readonly code: string, message: string, readonly outcomeUnknown = false, readonly pending = false, readonly context?: CruxWorkspaceContext) { super(message); this.name = 'CruxRemoteClientError' }
}
const RemoteError = CruxRemoteClientError
const localContext = (): CruxWorkspaceContext => ({ key: 'local', connectionId: null, projectId: null, projectName: null, actorId: null, canManage: false, revision: 0, state: 'local', pendingCount: 0 })
const codeOf = (error: unknown): string => error instanceof RemoteError || error instanceof DesktopTeamError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : 'STORE_UNAVAILABLE'
const unknownOf = (error: unknown): boolean => (error instanceof RemoteError || error instanceof DesktopTeamError) && error.outcomeUnknown
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry)).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
const viewFingerprint = (value: CruxRemoteSnapshot | null): string | undefined => value
  ? createHash('sha256').update(canonical([value.projectId, value.instanceId, value.epoch, value.authorizationRevision, value.actor, value.canManage, value.snapshot])).digest('hex')
  : undefined

/** Main-owned coordinator. Construction and tests never load Electron. */
export class CruxRemoteClient {
  private selection: Selection | null = null
  private epoch = 0
  private closed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<(context: CruxWorkspaceContext, viewFingerprint?: string) => void>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private mutation: Promise<unknown> = Promise.resolve()
  private refreshing: { selection: Selection; work: Promise<CruxWorkspaceContext> } | null = null
  constructor(private readonly options: CruxRemoteOptions) {
    if ((!options.service && !options.withService) || (options.service && options.withService)) throw new RemoteError('INVALID_INPUT', '必须提供唯一的主进程团队服务适配器')
    z.object({ dataDir: z.string().min(1), pollWaitMs: z.number().int().min(0).max(8000).optional(), pollIntervalMs: z.number().int().min(100).max(60000).optional() }).parse(options)
    if (options.onChanged) this.listeners.add(options.onChanged)
  }
  static async open(options: CruxRemoteOptions): Promise<CruxRemoteClient> { return new CruxRemoteClient(options) }
  private service<T>(action: (service: CruxRemoteTransport) => Promise<T>): Promise<T> {
    if (this.options.withService) return this.options.withService(action)
    if (!this.options.service) throw new RemoteError('SERVICE_CLOSED', '远程协作服务不可用')
    return action(this.options.service)
  }
  private async track<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) throw new RemoteError('SERVICE_CLOSED', '远程协作服务正在退出')
    const work = Promise.resolve().then(action)
    this.inFlight.add(work)
    try { return await work } finally { this.inFlight.delete(work) }
  }
  private current(selected: Selection): boolean { return !this.closed && this.selection === selected && selected.epoch === this.epoch }
  private assertCurrent(selected: Selection): void { if (!this.current(selected)) throw new RemoteError('SCOPE_CHANGED', '所选协作空间已改变，请保留草稿并核对原空间', false, false, this.status()) }
  private requireScope(expectedScopeKey: string): Selection {
    if (this.closed) throw new RemoteError('SERVICE_CLOSED', '远程协作服务正在退出')
    const selected = this.selection
    if (!selected || expectedScopeKey !== selected.key) throw new RemoteError('SCOPE_CHANGED', '操作不属于当前所选协作空间，请保留原草稿', false, false, this.status())
    this.assertCurrent(selected)
    return selected
  }
  private publish(selected: Selection): void {
    if (!this.current(selected)) return
    selected.context.pendingCount = selected.saved.pending ? 1 : 0
    for (const listener of this.listeners) { try { listener(this.status(), selected.viewFingerprint) } catch { /* Observers cannot roll back committed persistence. */ } }
  }
  private save(selected: Selection, fields: Partial<Pick<CruxRemotePersisted, 'pending' | 'cache' | 'observedAt' | 'authority' | 'retiredEpochs' | 'accessLocked'>>): void {
    selected.saved = selected.persistence.write({ ...selected.saved, ...fields })
    selected.context.pendingCount = selected.saved.pending ? 1 : 0
  }
  status(): CruxWorkspaceContext { return structuredClone(this.selection?.context ?? localContext()) }
  snapshot(): CruxRemoteView {
    const selected = this.selection
    if (!selected?.saved.cache || selected.context.state === 'access-revoked') return { snapshot: null, context: this.status() }
    return { snapshot: structuredClone(selected.saved.cache.snapshot), context: this.status(), freshness: selected.context.state === 'connected' ? 'remote' : 'cached-offline', authorization: selected.context.state === 'connected' ? 'current-server' : 'last-observed' }
  }
  subscribe(listener: (context: CruxWorkspaceContext) => void): () => void {
    if (this.closed) throw new RemoteError('SERVICE_CLOSED', '远程协作服务正在退出')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  async select(connectionId: string | null): Promise<CruxRemoteView> {
    if (this.closed) throw new RemoteError('SERVICE_CLOSED', '远程协作服务正在退出')
    const previous = this.selection
    const epoch = ++this.epoch
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (connectionId === null) { this.selection = null; for (const listener of this.listeners) { try { listener(this.status()) } catch {} } return this.snapshot() }
    return this.track(async () => {
      const connection = (await this.service((service) => service.connections())).find((item) => item.connectionId === connectionId)
      if (epoch !== this.epoch || this.closed) throw new RemoteError('SCOPE_CHANGED', '协作空间选择已改变')
      if (!connection?.ownerId || !connection.projectId) throw new RemoteError('ACCESS_LOCKED', '请选择已经批准的明确项目设备连接')
      const binding = remoteBindingSchema.parse({ connectionId, origin: connection.origin, pairingId: connection.pairingId, ownerId: connection.ownerId, deviceId: connection.deviceId, projectId: connection.projectId })
      const persistence = new CruxRemotePersistence(this.options.dataDir, binding)
      const selected: Selection = { binding, key: remoteScopeKey(binding), persistence, saved: persistence.read(), epoch, viewGeneration: 0, context: { key: remoteScopeKey(binding), connectionId, origin: binding.origin, projectId: binding.projectId, projectName: null, actorId: binding.ownerId, canManage: false, revision: 0, state: 'offline', pendingCount: 0 } }
      selected.context.revision = selected.saved.cache?.revision ?? 0
      if (selected.saved.authority) Object.assign(selected.context, selected.saved.authority)
      selected.viewFingerprint = viewFingerprint(selected.saved.cache)
      this.selection = selected
      if (connection.state !== 'active' || connection.accessLocked || selected.saved.accessLocked) {
        this.noteFailure(selected, new RemoteError('ACCESS_LOCKED', '原设备访问权限已锁定'))
        return this.snapshot()
      }
      try {
        const context = await this.service((service) => service.connectionContext(connectionId))
        this.assertCurrent(selected)
        if (context.person.userId !== binding.ownerId || context.project.projectId !== binding.projectId) throw new RemoteError('BINDING_CHANGED', '当前账号或项目不属于原设备连接')
        selected.context.projectName = context.project.name
        await this.refreshSelected(selected, false)
      } catch (error) { if (this.current(selected)) this.noteFailure(selected, error); else throw error }
      this.publish(selected); this.schedule(selected)
      return this.snapshot()
    }).catch((error: unknown) => {
      // Failed admission must not silently turn an already selected remote editor into local writes.
      if (!this.closed && epoch === this.epoch && this.selection === previous && previous) {
        const restored = { ...previous, epoch, context: { ...previous.context } }
        this.selection = restored
        this.publish(restored); this.schedule(restored)
      }
      throw error
    })
  }
  private noteFailure(selected: Selection, error: unknown): void {
    const reported = codeOf(error)
    const code = reported === 'ACCESS_LOCKED' ? selected.saved.pending?.errorCode ?? selected.context.error ?? reported : reported
    selected.context.error = code
    selected.context.canManage = false
    if (lockedCodes.has(reported)) {
      selected.context.state = 'access-revoked'
      const pending = selected.saved.pending
      // Clear in memory first even if the disk becomes unwritable during revocation.
      selected.saved = { ...selected.saved, accessLocked: true, cache: null, observedAt: null, pending: pending ? { ...pending, state: 'access-revoked', errorCode: code } : null }
      selected.viewFingerprint = undefined
      try { this.save(selected, {}) } catch { selected.context.error = code + ':CACHE_CLEAR_FAILED' }
    } else {
      selected.context.state = 'offline'
      if (['REVISION_REGRESSED', 'AUTHORIZATION_REGRESSED', 'STALE_SNAPSHOT'].includes(code)) {
        selected.saved = { ...selected.saved, cache: null, observedAt: null }
        selected.viewFingerprint = undefined
        try { this.save(selected, {}) } catch { selected.context.error = code + ':CACHE_CLEAR_FAILED' }
      }
    }
    this.publish(selected)
  }
  private validate(selected: Selection, raw: CruxRemoteSnapshot): z.infer<typeof cruxRemoteSnapshotSchema> {
    const value = cruxRemoteSnapshotSchema.parse(raw)
    if (value.projectId !== selected.binding.projectId || value.actor.id !== selected.binding.ownerId) throw new RemoteError('BINDING_CHANGED', '协作快照与原项目账号不一致')
    if (selected.saved.authority && value.instanceId !== selected.saved.authority.instanceId) throw new RemoteError('BINDING_CHANGED', '原设备绑定的团队服务实例已改变，不能转用其他实例')
    return value
  }
  private accept(selected: Selection, raw: CruxRemoteSnapshot, recoveredPending?: CruxRemotePending): void {
    const value = this.validate(selected, raw), authority = selected.saved.authority
    if (selected.saved.retiredEpochs.includes(value.epoch)) throw new RemoteError('STALE_SNAPSHOT', '旧世代快照已失效，不能重新成为当前共享内容')
    const changedEpoch = !!authority && authority.epoch !== value.epoch
    if (!changedEpoch && authority && value.authorizationRevision < authority.authorizationRevision) throw new RemoteError('AUTHORIZATION_REGRESSED', '服务端授权版本倒退，旧缓存不能作为当前授权')
    if (!changedEpoch && authority && value.revision < authority.revision) throw new RemoteError('REVISION_REGRESSED', '服务端协作版本倒退，旧缓存不能作为当前授权')
    const head = { instanceId: value.instanceId, epoch: value.epoch, authorizationRevision: value.authorizationRevision, revision: value.revision }
    if (changedEpoch) {
      // Clear before persistence so a failed replacement cannot leave old private bodies readable.
      selected.saved = { ...selected.saved, cache: null, observedAt: null, authority: head, retiredEpochs: [...new Set([...selected.saved.retiredEpochs, authority.epoch])], pending: fencedPending(selected.saved.pending) }
      selected.viewFingerprint = undefined
      selected.context.canManage = false; selected.context.state = 'offline'; selected.context.revision = 0
    }
    if (!authority || changedEpoch || authority.authorizationRevision !== value.authorizationRevision) selected.viewGeneration++
    Object.assign(selected.context, head)
    this.save(selected, { authority: head, cache: value, observedAt: Date.now(), ...(recoveredPending ? { accessLocked: false, pending: recoveredPending } : {}) })
    selected.viewFingerprint = viewFingerprint(value)
    selected.context.revision = value.revision
    selected.context.state = 'connected'; selected.context.canManage = value.canManage
    delete selected.context.error
    this.publish(selected)
  }
  private async refreshSelected(selected: Selection, wait: boolean): Promise<CruxWorkspaceContext> {
    this.assertCurrent(selected)
    if (selected.saved.accessLocked) { this.noteFailure(selected, new RemoteError('ACCESS_LOCKED', '原连接的共享内容已锁定')); return this.status() }
    const generation = selected.viewGeneration
    let received = false
    try {
      const value = await this.service((service) => service.cruxSnapshot(selected.binding.connectionId, { ...(selected.saved.cache ? { afterRevision: selected.saved.cache.revision } : {}), ...(selected.saved.authority ? { expectedInstanceId: selected.saved.authority.instanceId } : {}), waitMs: wait ? this.options.pollWaitMs ?? 8000 : 0 }))
      this.assertCurrent(selected)
      if (generation !== selected.viewGeneration) return this.status()
      received = true
      this.accept(selected, value)
    } catch (error) {
      if (!this.current(selected)) throw error
      if (!received && generation !== selected.viewGeneration) return this.status()
      this.noteFailure(selected, error)
    }
    return this.status()
  }
  async refresh(): Promise<CruxRemoteView> {
    const selected = this.selection
    if (!selected) return this.snapshot()
    if (this.refreshing?.selection === selected) { await this.refreshing.work; return this.snapshot() }
    const work = this.track(() => this.refreshSelected(selected, false))
    this.refreshing = { selection: selected, work }
    try { await work; return this.snapshot() } finally { if (this.refreshing?.work === work) this.refreshing = null }
  }
  private schedule(selected: Selection): void {
    if (!this.current(selected) || this.options.autoPoll === false || selected.context.state === 'access-revoked') return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.track(() => this.refreshSelected(selected, true)).catch(() => {}).finally(() => this.schedule(selected))
    }, this.options.pollIntervalMs ?? (selected.context.state === 'offline' ? 5000 : 500))
    this.timer.unref()
  }
  private failure(error: unknown, selected?: Selection): CruxRemoteResult {
    const transportUnknown = !isVerifiedCruxCommandDenial(error) && !isTerminalCruxRevisionConflict(error) && unknownOf(error)
    return { ok: false, code: codeOf(error), error: error instanceof RemoteError || error instanceof DesktopTeamError ? error.message : '远程协作操作未完成，请保留草稿和原命令', outcomeUnknown: transportUnknown || !!selected?.saved.pending?.outcomeUnknown, pending: !!selected?.saved.pending, context: this.status() }
  }
  private invalidateRejectedEpoch(selected: Selection): void {
    const pending = selected.saved.pending, authority = selected.saved.authority
    if (!pending || !authority || pending.command.expectedEpoch !== authority.epoch) return
    selected.saved = { ...selected.saved, cache: null, observedAt: null, retiredEpochs: [...new Set([...selected.saved.retiredEpochs, pending.command.expectedEpoch])] }
    selected.viewFingerprint = undefined; selected.viewGeneration++
    selected.context.state = 'offline'; selected.context.canManage = false
  }
  private async commandFailure(error: unknown, selected?: Selection): Promise<CruxRemoteResult> {
    if (selected && this.current(selected)) {
      if (epochCodes.has(codeOf(error))) {
        selected.saved = { ...selected.saved, pending: fencedPending(selected.saved.pending, codeOf(error)) }
        this.invalidateRejectedEpoch(selected)
        try { this.save(selected, {}); this.publish(selected); await this.refreshSelected(selected, false) }
        catch (failure) { return this.failure(failure, selected) }
      } else if (lockedCodes.has(codeOf(error)) || offlineCodes.has(codeOf(error))) this.noteFailure(selected, error)
    }
    return this.failure(error, selected)
  }
  private async serialized(action: () => Promise<CruxRemoteResult>): Promise<CruxRemoteResult> {
    return this.track(async () => {
      const previous = this.mutation
      const work = previous.catch(() => {}).then(action)
      this.mutation = work
      return work
    })
  }
  pending(): Array<CruxRemotePending & { commandId: string; scopeKey: string }> {
    const selected = this.selection, pending = selected?.saved.pending
    return selected && pending ? [structuredClone({ ...pending, commandId: pending.command.commandId, scopeKey: selected.key })] : []
  }
  private unwrap(result: CruxRemoteResult): CruxRemoteExecution {
    if (!result.ok) throw new RemoteError(result.code, result.error, result.outcomeUnknown, result.pending, result.context)
    return { snapshot: result.snapshot, context: result.context, ...(result.taskId ? { taskId: result.taskId } : {}) }
  }
  async execute(operation: CruxRemoteCommand['operation'], input: unknown, expectedScopeKey: string): Promise<CruxRemoteExecution> {
    return this.unwrap(await this.executeResult(operation, input, expectedScopeKey))
  }
  private async executeResult(operation: CruxRemoteCommand['operation'], input: unknown, expectedScopeKey: string): Promise<CruxRemoteResult> {
    const admitted = this.requireScope(expectedScopeKey)
    const admittedEpoch = admitted.saved.authority?.epoch
    return this.serialized(async () => {
      let selected: Selection | undefined
      try {
        selected = admitted
        this.assertCurrent(selected)
        if (selected.saved.authority?.epoch !== admittedEpoch) throw new RemoteError('EPOCH_CONFLICT', '协作空间已恢复为新世代，请核对原操作，不能改用新世代提交')
        const name = cruxMutationNameSchema.parse(operation)
        // Persist the exact validated JSON bytes that will be sent, without renderer-only fields.
        const payload = JSON.parse(JSON.stringify(cruxMutationInputSchemas[name].parse(input))) as unknown
        if (selected.saved.pending) {
          const pending = selected.saved.pending
          if (pending.command.operation !== name || canonical(pending.command.input) !== canonical(payload)) throw new RemoteError('PENDING_COMMAND', '原操作尚未确认，请先核对或明确处理原命令')
          return await this.dispatch(selected, true)
        }
        if (selected.context.state === 'access-revoked') throw new RemoteError('ACCESS_LOCKED', '当前设备访问权限已撤销')
        if (!selected.saved.cache) throw new RemoteError('SNAPSHOT_REQUIRED', '请先取得所选项目的服务端快照')
        const command = cruxRemoteCommandSchema.parse({ commandId: randomUUID(), expectedEpoch: selected.saved.cache.epoch, expectedRevision: selected.saved.cache.revision, operation: name, input: payload })
        this.save(selected, { pending: { command, state: 'queued', createdAt: Date.now(), attempts: 0, outcomeUnknown: false, errorCode: null } })
        this.publish(selected)
        return await this.dispatch(selected, false)
      } catch (error) { return this.commandFailure(error, selected) }
    })
  }
  async retry(commandId: string, expectedScopeKey?: string): Promise<CruxRemoteExecution> {
    const selected = this.requireScope(expectedScopeKey ?? this.status().key)
    return this.unwrap(await this.retryResult(selected, commandId))
  }
  private async retryResult(admitted: Selection, commandId: string): Promise<CruxRemoteResult> {
    return this.serialized(async () => {
      let selected: Selection | undefined
      try {
        selected = admitted
        this.assertCurrent(selected)
        if (selected.saved.pending?.command.commandId !== commandId) throw new RemoteError('COMMAND_SCOPE_MISMATCH', '原命令不属于当前所选连接，不能转用其他身份重试')
        return await this.dispatch(selected, true)
      }
      catch (error) { return this.commandFailure(error, selected) }
    })
  }
  async discardPending(expectedScopeKey: string): Promise<CruxWorkspaceContext> {
    const admitted = this.requireScope(expectedScopeKey), original = admitted.saved.pending?.command.commandId
    return this.track(async () => {
      await this.mutation.catch(() => {})
      this.assertCurrent(admitted)
      const selected = admitted, pending = selected.saved.pending
      if (pending?.command.commandId !== original) throw new RemoteError('COMMAND_SCOPE_MISMATCH', '待处理操作已改变，请重新核对原命令')
      if (pending && (pending.outcomeUnknown || !['queued', 'conflict'].includes(pending.state))) throw new RemoteError('RECONCILE_REQUIRED', '已发送结果尚未确认，必须保留原命令核对')
      this.save(selected, { pending: null }); this.publish(selected)
      return this.status()
    })
  }
  private async settleReceipt(selected: Selection, pending: CruxRemotePending, raw: CruxRemoteSnapshot): Promise<void> {
    const receipt = this.validate(selected, raw)
    if (receipt.epoch !== pending.command.expectedEpoch || receipt.revision !== pending.command.expectedRevision + 1) throw new RemoteError('RECEIPT_MISMATCH', '原命令回执世代或版本不一致', true)
    // A historical receipt proves only the original command. Current bodies and
    // permission always come from a separate authorized snapshot read.
    if (this.current(selected)) await this.refreshSelected(selected, false)
    if (selected.saved.authority?.epoch !== pending.command.expectedEpoch || selected.saved.retiredEpochs.includes(receipt.epoch)) {
      this.save(selected, { pending: fencedPending(pending, 'EPOCH_CONFLICT', true) }); this.publish(selected)
      throw new RemoteError('EPOCH_CONFLICT', '原命令已在旧世代记录，当前恢复空间不能重放；请核对后明确处理原命令')
    }
    this.save(selected, { pending: null }); this.publish(selected)
  }
  private async dispatch(selected: Selection, explicitRetry: boolean): Promise<CruxRemoteResult> {
    this.assertCurrent(selected)
    let pending = selected.saved.pending
    if (!pending) throw new RemoteError('NO_PENDING_COMMAND', '没有可核对的远程协作命令')
    if (selected.saved.accessLocked || selected.context.state === 'access-revoked' || pending.state === 'access-revoked') {
      if (!explicitRetry) throw new RemoteError('ACCESS_LOCKED', '原命令的设备权限已锁定')
      const authority = selected.saved.authority, saved = selected.saved, generation = selected.viewGeneration, command = pending.command
      if (!authority) throw new RemoteError('ACCESS_LOCKED', '缺少原服务授权记录，无法恢复原命令')
      const check = (raw: CruxRemoteSnapshot): void => {
        this.assertCurrent(selected)
        if (selected.saved !== saved || selected.viewGeneration !== generation) throw new RemoteError('SCOPE_CHANGED', '核对期间原空间授权已变化')
        const value = this.validate(selected, raw)
        if (value.epoch !== authority.epoch || selected.saved.retiredEpochs.includes(value.epoch) || value.authorizationRevision < authority.authorizationRevision || value.revision < authority.revision) throw new RemoteError('BINDING_CHANGED', '原服务世代或授权版本无法恢复')
      }
      const value = await this.service(service => service.cruxRevalidate(selected.binding.connectionId, { ...selected.binding, ...authority }, command, check))
      check(value)
      pending = { ...pending, state: pending.outcomeUnknown ? 'acknowledgement-unknown' : 'queued' }
      this.accept(selected, value, pending)
      const receipt = await this.service(service => service.cruxReceipt(selected.binding.connectionId, command.commandId, authority.instanceId))
      this.assertCurrent(selected)
      if (receipt) { await this.settleReceipt(selected, pending, receipt); return this.success(selected, receipt.taskId) }
      this.schedule(selected)
      // Missing at this read point never proves absence of an earlier effect.
      throw new RemoteError('RECONCILE_REQUIRED', '原连接已核实，尚未查到原回执；请核对后明确重试原命令', pending.outcomeUnknown, true)
    }
    if (pending.state === 'conflict') throw new RemoteError(epochCodes.has(pending.errorCode ?? '') ? pending.errorCode ?? 'EPOCH_CONFLICT' : 'REVISION_CONFLICT', '原操作与服务端世代或版本冲突，请保留草稿并明确处理后重新提交')
    if (pending.outcomeUnknown || pending.state === 'dispatching' || pending.state === 'acknowledgement-unknown') {
      const originalCommandId = pending.command.commandId
      const receipt = await this.service((service) => service.cruxReceipt(selected.binding.connectionId, originalCommandId, selected.saved.authority?.instanceId))
      this.assertCurrent(selected)
      if (receipt) {
        await this.settleReceipt(selected, pending, receipt)
        return this.success(selected, receipt.taskId)
      }
      if (!explicitRetry) throw new RemoteError('RECONCILE_REQUIRED', '尚未查到原回执，需要明确重试相同命令', true)
    }
    if (selected.saved.authority?.epoch !== pending.command.expectedEpoch) throw new RemoteError('EPOCH_CONFLICT', '原命令属于旧世代，不能改写或转用当前世代重试', pending.outcomeUnknown)
    // Preflight read does not dispatch. Offline saves stay queued, with the editor open.
    try {
      const context = await this.service((service) => service.connectionContext(selected.binding.connectionId))
      this.assertCurrent(selected)
      if (context.person.userId !== selected.binding.ownerId || context.project.projectId !== selected.binding.projectId) throw new RemoteError('BINDING_CHANGED', '原命令不能转用其他项目或账号')
    }
    catch (error) {
      if (this.current(selected)) this.noteFailure(selected, error)
      return this.failure(error, selected)
    }
    if (selected.saved.authority?.epoch !== pending.command.expectedEpoch) throw new RemoteError('EPOCH_CONFLICT', '原命令属于旧世代，不能改写或转用当前世代重试', pending.outcomeUnknown)
    pending = { ...pending, state: 'dispatching', attempts: pending.attempts + 1 }
    this.save(selected, { pending }) // This durable marker MUST precede HTTP POST.
    this.assertCurrent(selected)
    let taskId: string | undefined
    try {
      const reply = await this.service((service) => service.cruxCommand(selected.binding.connectionId, pending.command, selected.saved.authority?.instanceId, selected.saved.authority ?? undefined))
      if (reply.commandId !== pending.command.commandId || reply.result.revision !== pending.command.expectedRevision + 1) throw new RemoteError('RECEIPT_MISMATCH', '原命令回执不一致', true)
      await this.settleReceipt(selected, pending, reply.result)
      taskId = reply.result.taskId
    } catch (error) {
      const code = codeOf(error), businessDenied = isVerifiedCruxCommandDenial(error)
      // A freshly verified business denial rejects this dispatch, despite the
      // transport's conservative POST flag. It cannot retire uncertainty from
      // an earlier dispatch; that still requires the original terminal proof.
      const priorUnknown = epochCodes.has(code) ? selected.saved.pending?.outcomeUnknown ?? pending.outcomeUnknown : pending.outcomeUnknown
      const unknown = !isTerminalCruxRevisionConflict(error) && (priorUnknown || (!businessDenied
        && (unknownOf(error) || !['REVISION_CONFLICT', 'CONFLICT', 'INVALID_INPUT', 'FORBIDDEN', 'UNAUTHORIZED', 'ACCESS_LOCKED', ...epochCodes].includes(code))))
      const state: CruxRemotePending['state'] = lockedCodes.has(code) ? 'access-revoked' : unknown ? 'acknowledgement-unknown' : businessDenied ? 'queued' : 'conflict'
      // Memory keeps the same command even if recording the response now fails.
      selected.saved = { ...selected.saved, pending: { ...pending, state, outcomeUnknown: unknown, errorCode: code } }
      if (epochCodes.has(code)) this.invalidateRejectedEpoch(selected)
      try { this.save(selected, {}) } catch { return this.failure(new RemoteError('ACKNOWLEDGEMENT_UNKNOWN', '服务端操作与本地确认未完整核对，请保留原命令', true), selected) }
      if (this.current(selected)) {
        if (lockedCodes.has(code) || offlineCodes.has(code)) this.noteFailure(selected, error)
        else { selected.context.error = code; this.publish(selected) }
        if (state === 'conflict' || epochCodes.has(code)) await this.refreshSelected(selected, false)
      }
      return this.failure(error, selected)
    }
    if (!this.current(selected)) return this.failure(new RemoteError('SCOPE_CHANGED', '原空间操作已由服务端确认，请在原空间核对'), selected)
    return this.success(selected, taskId)
  }
  private success(selected: Selection, taskId?: string): CruxRemoteResult {
    this.assertCurrent(selected)
    if (!selected.saved.cache || selected.context.state === 'access-revoked') throw new RemoteError('ACCESS_LOCKED', '当前服务访问权限无法确认')
    const snapshot = structuredClone(selected.saved.cache.snapshot)
    return { ok: true, data: snapshot, snapshot, context: this.status(), ...(taskId ? { taskId } : {}) }
  }
  async close(): Promise<void> {
    this.closed = true; ++this.epoch
    if (this.timer) clearTimeout(this.timer)
    this.timer = null; this.listeners.clear()
    // Join admitted HTTP calls (the service owns their timeout); late replies cannot publish.
    await Promise.allSettled([...this.inFlight])
    this.selection = null
  }
}
