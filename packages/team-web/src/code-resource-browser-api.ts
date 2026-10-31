import type { HifoxCodeResourceApi, HifoxResourceReply } from '../../../src/shared/hifox-code-resources'
import { hifoxResourceCommandSchema, hifoxResourceListSchema, hifoxResourcePendingSchema, hifoxResourceRecoverySchema, hifoxResourceTaskSchema } from '../../../src/shared/hifox-code-resources'
import { teamCodeResourceListSchema, teamCodeResourceReceiptSchema, teamTaskCodeResourceDtoSchema, type TeamCodeResourceCommand, type TeamCodeResourceCommandReply, type TeamCodeResourceReceipt } from '../../../src/shared/team-code-resources'
import type { HifoxWorkspaceContext } from '../../../src/shared/hifox-remote'
import type { TeamSession } from './contracts'
import { ApiError, isClientSession, pendingCommands, prepareCommand, reconcileCommand, request, sendCommand, type PendingCommand, type PreparedCommand } from './client'

type Options = { projectId: string; session: TeamSession; context(): HifoxWorkspaceContext; isCurrent(): boolean }
const retained = new Map<string, PreparedCommand<TeamCodeResourceReceipt>>()
// Settled metadata lets a remounted original view query the server again. Never
// treat a historical response as current authority or retain its body here.
const settled = new Map<string, PendingCommand>()
const failures = new Map<string, ApiError>()
const kinds: TeamCodeResourceCommand['kind'][] = ['create', 'update', 'setSpaceResources', 'selectTaskResource']

/** Shared resources use the browser session. This adapter grants no local execution capability. */
export class BrowserCodeResources {
  private live = true
  private readonly lifetime = new AbortController()
  private readonly sending = new Set<string>()
  readonly api: HifoxCodeResourceApi
  constructor(private readonly options: Options) {
    this.api = {
      list: (input) => this.run(async () => {
        const { workspaceKey, ...query } = hifoxResourceListSchema.parse(input)
        this.assertOwner(workspaceKey)
        const params = new URLSearchParams()
        for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value))
        const value = await request(`${this.path()}?${params}`, teamCodeResourceListSchema, this.readOptions())
        this.validate(value)
        return value
      }),
      task: (input) => this.run(async () => {
        const { workspaceKey, taskId } = hifoxResourceTaskSchema.parse(input)
        this.assertOwner(workspaceKey)
        const value = await request(`/api/projects/${encodeURIComponent(options.projectId)}/hifox/tasks/${encodeURIComponent(taskId)}/code-resource`, teamTaskCodeResourceDtoSchema, this.readOptions())
        this.validate(value)
        if (value.taskId !== taskId) throw new ApiError('INVALID_RESPONSE', '任务资源的来源不匹配')
        return value
      }),
      pending: (input) => this.run(async () => {
        this.assertOwner(hifoxResourcePendingSchema.parse(input).workspaceKey)
        return this.references().map((entry) => {
          const kind = entry.workspace?.operation.replace('code-resource:', '')
          if (!kinds.includes(kind as TeamCodeResourceCommand['kind'])) throw new ApiError('INVALID_RESPONSE', '原资源操作类型无法核对')
          const error = failures.get(entry.commandId)
          return { commandId: entry.commandId, kind: kind as TeamCodeResourceCommand['kind'], state: entry.state === 'unknown' || error?.uncertain ? 'unknown' as const : error ? 'rejected' as const : 'pending' as const, createdAt: entry.createdAt, error: error?.message ?? null }
        })
      }),
      command: (input) => this.run(async () => {
        const { workspaceKey, command } = hifoxResourceCommandSchema.parse(input)
        this.assertOwner(workspaceKey)
        if (this.sending.size) throw new ApiError('IN_FLIGHT', '代码资源操作正在核对')
        this.sending.add(command.commandId)
        try {
          if (this.references().some((entry) => entry.commandId === command.commandId)) throw new ApiError('PENDING_COMMAND', '原操作已保留，请核对或重试原操作')
          const context = this.options.context()
          if (!context.instanceId || context.epoch !== command.expectedEpoch) throw new ApiError('WORKSPACE_EPOCH_CHANGED', '工作区来源已变化，请重新核对')
          const prepared = await prepareCommand(this.path() + '/commands', command, teamCodeResourceReceiptSchema, options.projectId,
            { origin: location.origin, instanceId: context.instanceId, epoch: command.expectedEpoch, operation: `code-resource:${command.kind}`, expectedRevision: command.expectedRevision }, command.commandId)
          retained.set(command.commandId, prepared)
          this.assertOwner(workspaceKey)
          return await this.send(prepared)
        } finally { this.sending.delete(command.commandId) }
      }),
      reconcile: (input) => this.run(async () => {
        const parsed = hifoxResourceRecoverySchema.parse(input)
        this.assertOwner(parsed.workspaceKey)
        return this.reconcile(this.reference(parsed.commandId))
      }),
      retry: (input) => this.run(async () => {
        const parsed = hifoxResourceRecoverySchema.parse(input)
        this.assertOwner(parsed.workspaceKey)
        if (this.sending.size) throw new ApiError('IN_FLIGHT', '代码资源操作正在核对')
        this.sending.add(parsed.commandId)
        try {
          const entry = this.reference(parsed.commandId)
          const receipt = await this.reconcile(entry)
          if (receipt) return receipt
          const original = retained.get(entry.commandId)
          if (!original || original.entry.digest !== entry.digest || original.entry.accountId !== options.session.person.userId) throw new ApiError('PAYLOAD_UNAVAILABLE', '重载后仅保留原操作引用；没有原始内容，不能重建重试。请继续核对回执。')
          this.validateReference(entry)
          return await this.send(original)
        } finally { this.sending.delete(parsed.commandId) }
      })
    }
  }
  dispose(): void { this.live = false; this.lifetime.abort() }
  private current = (): boolean => this.live && this.options.isCurrent() && isClientSession(this.options.session)
  private path(): string { return `/api/projects/${encodeURIComponent(this.options.projectId)}/code-resources` }
  private readOptions() { return { signal: this.lifetime.signal, isCurrent: this.current, notifyDenied: false } }
  private assertOwner(workspaceKey: string): void {
    if (!this.current() || workspaceKey !== this.options.context().key) throw new ApiError('OWNER_CHANGED', '原工作区已关闭，请在原账号下核对操作')
  }
  private validate(value: { projectId: string; instanceId: string; epoch: string; authorizationRevision: number }): void {
    const context = this.options.context()
    if (!this.current() || value.projectId !== this.options.projectId || value.instanceId !== context.instanceId || value.epoch !== context.epoch || value.authorizationRevision < (context.authorizationRevision ?? 0)) throw new ApiError('WORKSPACE_EPOCH_CHANGED', '资源来源或权限已改变，请重新核对', 409)
  }
  private references(): PendingCommand[] {
    return pendingCommands(this.options.session.person.userId).filter((entry) => entry.projectId === this.options.projectId && entry.path === this.path() + '/commands' && entry.workspace?.origin === location.origin)
  }
  private reference(commandId: string): PendingCommand {
    const entry = this.references().find((candidate) => candidate.commandId === commandId) ?? settled.get(this.receiptKey(commandId))
    if (!entry) throw new ApiError('NOT_FOUND', '没有此原操作引用，请刷新资源与待核对操作')
    return entry
  }
  private receiptKey(commandId: string): string {
    const context = this.options.context()
    return JSON.stringify([location.origin, this.options.session.person.userId, this.options.projectId, context.instanceId, context.epoch, commandId])
  }
  private validateReference(entry: PendingCommand): void {
    const context = this.options.context()
    if (!this.current() || entry.workspace?.instanceId !== context.instanceId || entry.workspace?.epoch !== context.epoch) throw new ApiError('WORKSPACE_EPOCH_CHANGED', '原操作属于先前服务实例或代次，不能迁移重试', 409)
  }
  private receipt(raw: unknown, entry: PendingCommand): TeamCodeResourceReceipt {
    this.validateReference(entry)
    const value = teamCodeResourceReceiptSchema.parse(raw), original = retained.get(entry.commandId)?.body
    const expectedRevision = entry.workspace?.expectedRevision
    const revisionMatches = expectedRevision !== undefined && (value.revision === expectedRevision + 1 || value.kind === 'selectTaskResource' && value.revision === expectedRevision)
    if (value.projectId !== entry.projectId || value.epoch !== entry.workspace?.epoch || `code-resource:${value.kind}` !== entry.workspace.operation || !revisionMatches || value.deviceId !== null || original && (value.targetId !== (original.resourceId && original.kind !== 'selectTaskResource' ? original.resourceId : original.taskId ?? original.spaceId) || original.kind === 'selectTaskResource' && (value.taskCreatedAt !== original.expectedTaskCreatedAt || value.spaceId !== original.expectedSpaceId))) throw new ApiError('INVALID_RESPONSE', '原资源操作回执不匹配', 0, true)
    return value
  }
  private async reconcile(entry: PendingCommand): Promise<TeamCodeResourceCommandReply | null> {
    this.validateReference(entry)
    let result: TeamCodeResourceReceipt | null = null
    const state = await reconcileCommand(entry, { ...this.readOptions(), validateResult: (raw) => { result = this.receipt(raw, entry) } })
    if (state !== 'committed' || !result) return null
    settled.set(this.receiptKey(entry.commandId), entry)
    retained.delete(entry.commandId); failures.delete(entry.commandId)
    return { status: 'duplicate', commandId: entry.commandId, result }
  }
  private async send(prepared: PreparedCommand<TeamCodeResourceReceipt>): Promise<TeamCodeResourceCommandReply> {
    this.validateReference(prepared.entry)
    try {
      const reply = await sendCommand(prepared, { ...this.readOptions(), retainRejected: () => true, validateResult: (raw) => { this.receipt(raw, prepared.entry) } })
      settled.set(this.receiptKey(prepared.entry.commandId), prepared.entry)
      retained.delete(prepared.entry.commandId); failures.delete(prepared.entry.commandId)
      return reply
    } catch (error) {
      failures.set(prepared.entry.commandId, error instanceof ApiError ? error : new ApiError('RESOURCE_ERROR', '原操作结果未确认', 0, true))
      throw error
    }
  }
  private async run<T>(call: () => Promise<T>): Promise<HifoxResourceReply<T>> {
    try { return { ok: true, value: await call() } }
    catch (cause) { const error = cause instanceof ApiError ? cause : new ApiError('RESOURCE_ERROR', cause instanceof Error ? cause.message : '代码资源暂不可用'); return { ok: false, code: error.code, error: error.message, ...(error.uncertain ? { outcomeUnknown: true } : {}) } }
  }
}
