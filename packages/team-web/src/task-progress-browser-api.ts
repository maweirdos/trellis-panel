import type { CruxProgressApi, CruxProgressQuery, CruxProgressResult, CruxProgressValue } from '../../../src/shared/crux-task-progress'
import { cruxProgressQuerySchema, cruxProgressReportSchema } from '../../../src/shared/crux-task-progress'
import { IpcErrorCode } from '../../../src/shared/ipc-errors'
import { teamTaskProgressCommandSchema, teamTaskProgressDtoSchema, teamTaskProgressReceiptSchema, type TeamTaskProgressCommand, type TeamTaskProgressDto } from '../../../src/shared/team-task-progress'
import type { CruxWorkspaceContext } from '../../../src/shared/crux-remote'
import type { TeamSession } from './contracts'
import { ApiError, isClientSession, pendingCommands, prepareCommand, request, sendCommand, settleCommandReference, type PendingCommand, type PreparedCommand } from './client'

const retained = new Map<string, PreparedCommand<TeamTaskProgressDto>>()
type Options = { projectId: string; session: TeamSession; context(): CruxWorkspaceContext; isCurrent(): boolean }
/** Browser-only reporting over the shared wire. Native execution capabilities remain absent. */
export class BrowserTaskProgress {
  private readonly cache = new Map<string, TeamTaskProgressDto>()
  private readonly mutations = new Set<string>()
  private readonly lifetime = new AbortController()
  private live = true
  readonly api: CruxProgressApi
  constructor(private readonly options: Options) {
    this.api = {
      status: (input) => this.status(input),
      start: async () => ({ ok: false, code: IpcErrorCode.Unavailable, error: '网页版不能启动本机 Agent，请使用桌面端。' }),
      report: async (input) => this.mutate(input, async (server) => {
        const parsed = cruxProgressReportSchema.parse(input)
        if (parsed.takeover) {
          if (parsed.takeover.expectedGeneration !== server.generation || parsed.takeover.expectedBindingId !== server.binding?.bindingId) throw new ApiError('TASK_PROGRESS_BINDING_CONFLICT', '确认期间主要会话已变化，请重新核对后接管。', 409)
          server = await this.command(input.taskId, server, { kind: 'bind', ...parsed.takeover, source: { kind: 'web' } })
        }
        if (!server.binding) server = await this.command(input.taskId, server, { kind: 'bind', expectedGeneration: server.generation, expectedBindingId: null, source: { kind: 'web' } })
        if (!this.ownBinding(server)) throw new ApiError('TASK_PROGRESS_BINDING_CONFLICT', '任务已绑定其他会话，请保留摘要并核对当前绑定。', 409)
        return this.command(input.taskId, server, { kind: 'report', bindingId: server.binding.bindingId, seq: (server.progress?.seq ?? 0) + 1, state: parsed.activity, step: parsed.step, blockingReason: parsed.blocker })
      }),
      detach: async (input) => this.mutate(input, async (server) => {
        if (!this.ownBinding(server)) throw new ApiError('TASK_PROGRESS_BINDING_CONFLICT', '仅能解除当前浏览器拥有的人工进度绑定。', 409)
        return this.command(input.taskId, server, { kind: 'release', bindingId: server.binding.bindingId, seq: (server.progress?.seq ?? 0) + 1 })
      }),
      retry: async (input) => this.mutate(input, async () => {
        const entry = this.references(input.taskId)[0]
        if (!entry) return this.read(input.taskId)
        const current = await this.read(input.taskId)
        const receipt = await request(`${this.path(input.taskId)}/commands/${entry.commandId}`, teamTaskProgressReceiptSchema.nullable(), this.readOptions())
        if (receipt) {
          if (receipt.commandId !== entry.commandId || receipt.epoch !== current.epoch) throw new ApiError('WORKSPACE_EPOCH_CHANGED', '原操作属于先前服务代次，不能继续重放。', 409)
          settleCommandReference(entry); retained.delete(entry.commandId)
          if (receipt.kind !== 'release' && receipt.bindingId !== current.binding?.bindingId) throw new ApiError('TASK_PROGRESS_BINDING_CONFLICT', '原操作已确认，但主要会话绑定已更新，请核对当前任务。', 409)
          return current
        }
        const original = retained.get(entry.commandId)
        if (!original || entry.workspace?.epoch !== current.epoch || entry.workspace?.instanceId !== current.instanceId) throw new ApiError('PAYLOAD_UNAVAILABLE', '尚未找到原回执；原操作仍未确认。页面重载或服务代次改变后不能重构原内容。')
        return this.send(input.taskId, original)
      }, true)
    }
  }
  dispose(): void { this.live = false; this.lifetime.abort(); this.cache.clear() }
  private current = (): boolean => this.live && this.options.isCurrent() && isClientSession(this.options.session)
  private readOptions() { return { signal: this.lifetime.signal, isCurrent: this.current, notifyDenied: false } }
  private path(taskId: string): string { return `/api/projects/${this.options.projectId}/crux/tasks/${encodeURIComponent(taskId)}/progress` }
  private references(taskId: string): PendingCommand[] { return pendingCommands(this.options.session.person.userId).filter((entry) => entry.path === `${this.path(taskId)}/commands`) }
  private validateQuery(input: CruxProgressQuery): void {
    cruxProgressQuerySchema.parse({ workspaceKey: input.workspaceKey, taskId: input.taskId })
    if (!this.current() || input.workspaceKey !== this.options.context().key) throw new ApiError('OWNER_CHANGED', '原任务工作区已关闭。')
  }
  private ownBinding(server: TeamTaskProgressDto): server is TeamTaskProgressDto & { binding: NonNullable<TeamTaskProgressDto['binding']> } {
    return Boolean(server.binding?.source.kind === 'web' && server.binding.reporterId === this.options.context().actorId && server.binding.deviceId === null)
  }
  private validate(server: TeamTaskProgressDto, taskId: string): void {
    const context = this.options.context()
    if (!this.current() || server.projectId !== this.options.projectId || server.taskId !== taskId || context.epoch !== server.epoch || context.instanceId !== server.instanceId || server.authorizationRevision < (context.authorizationRevision ?? 0)) throw new ApiError('WORKSPACE_EPOCH_CHANGED', '原任务来源或权限已变化，请重新核对。', 409)
  }
  private async read(taskId: string): Promise<TeamTaskProgressDto> {
    const server = await request(this.path(taskId), teamTaskProgressDtoSchema, this.readOptions())
    this.validate(server, taskId)
    this.cache.delete(taskId); this.cache.set(taskId, server)
    while (this.cache.size > 32) { const key = this.cache.keys().next(); if (key.done) break; this.cache.delete(key.value) }
    return server
  }
  private value(input: CruxProgressQuery, server: TeamTaskProgressDto | null, offline = false): CruxProgressValue {
    return { workspaceKey: input.workspaceKey, taskId: input.taskId, server, freshness: offline ? 'cached-offline' : this.references(input.taskId).length ? 'pending' : 'remote', local: null }
  }
  private failure(input: CruxProgressQuery, cause: unknown): CruxProgressResult {
    const error = cause instanceof ApiError ? cause : new ApiError('UNAVAILABLE', cause instanceof Error ? cause.message : '进度暂不可用')
    const offline = ['NETWORK_UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.code)
    const conflict = error.status === 409 || error.code.includes('CONFLICT')
    if (!offline) this.cache.delete(input.taskId)
    let value: CruxProgressValue | undefined
    if (this.current() && (offline || error.uncertain)) value = this.value(input, this.cache.get(input.taskId) ?? null, offline)
    return { ok: false, code: conflict ? IpcErrorCode.Conflict : IpcErrorCode.Unavailable, error: error.message, ...(value ? { value } : {}), ...(error.uncertain ? { outcomeUnknown: true } : {}) }
  }
  private async status(input: CruxProgressQuery): Promise<CruxProgressResult> {
    try { this.validateQuery(input); return { ok: true, value: this.value(input, await this.read(input.taskId)) } }
    catch (error) { return this.failure(input, error) }
  }
  private async mutate(input: CruxProgressQuery, operation: (current: TeamTaskProgressDto) => Promise<TeamTaskProgressDto>, retry = false): Promise<CruxProgressResult> {
    try {
      this.validateQuery(input)
      if (this.mutations.has(input.taskId)) throw new ApiError('IN_FLIGHT', '当前任务进度正在保存。')
      if (!retry && this.references(input.taskId).length) throw new ApiError('OUTCOME_UNKNOWN', '原操作仍待核对，请先重试未同步内容。', 0, true)
      this.mutations.add(input.taskId)
      try {
        const baseline = this.cache.get(input.taskId)
        const current = await this.read(input.taskId)
        if (!retry && baseline && (baseline.generation !== current.generation || baseline.binding?.bindingId !== current.binding?.bindingId || baseline.progress?.seq !== current.progress?.seq)) throw new ApiError('TASK_PROGRESS_BINDING_CONFLICT', '摘要或主要会话已更新，草稿已保留；请重新核对后提交。', 409)
        return { ok: true, value: this.value(input, await operation(current)) }
      }
      finally { this.mutations.delete(input.taskId) }
    } catch (error) { return this.failure(input, error) }
  }
  private async command(taskId: string, server: TeamTaskProgressDto, input: Record<string, unknown>): Promise<TeamTaskProgressDto> {
    this.validate(server, taskId)
    const prepared = await prepareCommand(`${this.path(taskId)}/commands`, { ...input, expectedEpoch: server.epoch }, teamTaskProgressDtoSchema, this.options.projectId,
      { origin: location.origin, instanceId: server.instanceId, epoch: server.epoch, operation: `task-progress:${String(input.kind)}`, expectedRevision: server.generation })
    teamTaskProgressCommandSchema.parse(prepared.body)
    retained.set(prepared.entry.commandId, prepared)
    return this.send(taskId, prepared)
  }
  private async send(taskId: string, prepared: PreparedCommand<TeamTaskProgressDto>): Promise<TeamTaskProgressDto> {
    const command: TeamTaskProgressCommand = teamTaskProgressCommandSchema.parse(prepared.body)
    const reply = await sendCommand(prepared, { ...this.readOptions(), validateResult: (raw) => this.validate(teamTaskProgressDtoSchema.parse(raw), taskId) })
    retained.delete(prepared.entry.commandId)
    const server = reply.result
    const matches = command.kind === 'bind' ? this.ownBinding(server) && server.generation === command.expectedGeneration + 1 : command.kind === 'release' ? !server.binding : server.binding?.bindingId === command.bindingId && server.progress?.seq === command.seq
    if (!matches) throw new ApiError('TASK_PROGRESS_BINDING_CONFLICT', '原操作已有回执，但绑定或摘要已更新，请核对当前进度。', 409)
    this.cache.set(taskId, server)
    return server
  }
}
