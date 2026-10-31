import { z } from 'zod'
import {
  governanceCommandInputSchema, governanceCommandSchema, governanceReceiptSchema, governanceListInputSchema, governanceReadInputSchema, governanceRecoveryInputSchema,
  governanceRecoveryScopeSchema, governanceScopeSchema, type GovernanceCommand, type GovernanceReply, type GovernanceRecoveryScope,
  type GovernanceReceipt, type TeamGovernanceApi
} from '../../../../shared/team-governance'
import { taskInputAdoptInputSchema, taskInputCommandSchema, taskInputReceiptSchema, taskInputRevisionInputSchema, taskInputScopeSchema, taskInputDocumentViewSchema, type TaskInputCommand, type TaskInputReceipt, type TaskInputScope } from '../../../../shared/team-task-inputs'
import { taskMaterialInputReferenceSchema, type TaskMaterialInputReference } from '../../../../shared/task-material-inputs'
import type { HifoxWorkspaceContext } from '../../../../shared/hifox-remote'
import { IpcErrorCode, ipcFail } from '../../../../shared/ipc-errors'
import type { DesktopTeamService } from '../../team-platform/service'
import { DesktopTeamError } from '../../team-platform/types'
import { governanceTransportPinSchema, validateGovernanceCommand, validateGovernanceReceipt, type GovernanceTransport, type GovernanceTransportPin } from '../../team-platform/governance-transport'
import { GovernanceJournal, governanceOwnerKey, type GovernanceJournalRow } from './journal'

export type GovernanceHost = { workspaceStatus(): Promise<HifoxWorkspaceContext>; workspaceGeneration(): number; withService<T>(work: (service: DesktopTeamService) => Promise<T>): Promise<T> }
type Context = { pin: GovernanceTransportPin; current(): Promise<void>; journal: GovernanceJournal; remote<T>(action: (transport: GovernanceTransport) => Promise<T>): Promise<T> }
const queues = new Map<string, Promise<void>>()
const changed = (): never => { throw new DesktopTeamError('BINDING_CHANGED', '原规则工作区或账号已变化，请回原来源核对。') }
const signature = (ctx: HifoxWorkspaceContext): string => JSON.stringify([ctx.key, ctx.connectionId, ctx.actorId, ctx.projectId, ctx.origin, ctx.instanceId, ctx.epoch, ctx.state])

export class HifoxGovernanceService implements TeamGovernanceApi {
  constructor(private readonly root: string, private readonly host: GovernanceHost) {}
  /** Main-only projection read. It exposes no new renderer channel or mutable draft metadata. */
  readDocument(raw: TaskInputScope & { reference: TaskMaterialInputReference }): Promise<GovernanceReply<z.infer<typeof taskInputDocumentViewSchema>>> {
    return this.run(taskInputScopeSchema.extend({ reference: taskMaterialInputReferenceSchema }).strict(), raw, (input, ctx) => ctx.remote(t => t.readDocument({ workspaceKey: input.workspaceKey, spaceId: input.spaceId, taskId: input.taskId, taskCreatedAt: input.taskCreatedAt }, input.reference)))
  }
  private async run<S extends z.ZodType<{ workspaceKey: string; spaceId: string }>, T>(schema: S, raw: unknown, work: (input: z.output<S>, ctx: Context) => Promise<T>, locked = false): Promise<GovernanceReply<T>> {
    try {
      const input = schema.parse(raw), generation = this.host.workspaceGeneration(), source = await this.host.workspaceStatus()
      if (source.state === 'local') throw new DesktopTeamError('GOVERNANCE_UNSUPPORTED', '团队规则与输入采纳需要已连接的共享工作区。')
      if (source.state !== 'connected' || source.key !== input.workspaceKey) return changed()
      return await this.host.withService(async service => {
        const connection = (await service.connections()).find(item => item.connectionId === source.connectionId)
        if (!connection || connection.state !== 'active' || connection.accessLocked || connection.ownerId !== source.actorId || connection.projectId !== source.projectId || connection.origin !== source.origin) return changed()
        const pin = governanceTransportPinSchema.parse({ ...governanceScopeSchema.parse({ workspaceKey: input.workspaceKey, spaceId: input.spaceId }), connectionId: connection.connectionId, actorId: connection.ownerId, projectId: connection.projectId, deviceId: connection.deviceId, pairingId: connection.pairingId, origin: connection.origin, instanceId: source.instanceId, epoch: source.epoch })
        const current = async (): Promise<void> => {
          const now = await this.host.workspaceStatus(), c = (await service.connections()).find(item => item.connectionId === pin.connectionId)
          if (this.host.workspaceGeneration() !== generation || signature(now) !== signature(source) || !c || c.state !== 'active' || c.accessLocked || c.ownerId !== pin.actorId || c.projectId !== pin.projectId || c.origin !== pin.origin || c.deviceId !== pin.deviceId || c.pairingId !== pin.pairingId) changed()
        }
        const ctx: Context = { pin, current, journal: new GovernanceJournal(this.root, pin), remote: action => service.withGovernanceTransport(pin, current, action) }
        const execute = async (): Promise<GovernanceReply<T>> => {
          await current()
          const value = await work(input, ctx)
          try { await current() } catch { throw new DesktopTeamError('BINDING_CHANGED', '请求期间原身份变化，请核对原操作。', locked) }
          return { ok: true, value }
        }
        if (!locked) return execute()
        const key = `${this.root}:${governanceOwnerKey(pin)}`, previous = queues.get(key)
        let release: (() => void) | undefined
        const gate = new Promise<void>(resolve => { release = resolve }); queues.set(key, gate)
        try { await previous; return await execute() } finally { release?.(); if (queues.get(key) === gate) queues.delete(key) }
      })
    } catch (error) {
      const code = error instanceof z.ZodError ? 'INVALID_INPUT' : error instanceof DesktopTeamError ? error.code : 'GOVERNANCE_UNAVAILABLE'
      return ipcFail(IpcErrorCode.Unknown, error instanceof DesktopTeamError ? error.message : '规则或任务输入暂不可用，请核对原操作。', { code, outcomeUnknown: error instanceof DesktopTeamError && error.outcomeUnknown })
    }
  }
  list: TeamGovernanceApi['list'] = raw => this.run(governanceListInputSchema, raw, (input, ctx) => ctx.remote(t => t.list(input)))
  read: TeamGovernanceApi['read'] = raw => this.run(governanceReadInputSchema, raw, (input, ctx) => ctx.remote(t => t.read(input.packageId, input.versionId)))
  inputs: TeamGovernanceApi['inputs'] = raw => this.run(taskInputScopeSchema, raw, (input, ctx) => ctx.remote(t => t.inputs(input)))
  candidates: TeamGovernanceApi['candidates'] = raw => this.run(taskInputScopeSchema, raw, (input, ctx) => ctx.remote(t => t.candidates(input)))
  inputRevision: TeamGovernanceApi['inputRevision'] = raw => this.run(taskInputRevisionInputSchema, raw, (input, ctx) => ctx.remote(t => t.inputRevision(taskInputScopeSchema.parse({ workspaceKey: input.workspaceKey, spaceId: input.spaceId, taskId: input.taskId, taskCreatedAt: input.taskCreatedAt }), input.revision)))
  command: TeamGovernanceApi['command'] = raw => this.run(governanceCommandInputSchema, raw, async (input, ctx) => {
    const command = validateGovernanceCommand(ctx.pin, input.command)
    const scope: GovernanceRecoveryScope = { workspaceKey: input.workspaceKey, spaceId: input.spaceId, lane: 'governance' }
    const admitted = ctx.journal.admit(scope, command)
    if (admitted.existing) { const reply = await this.duplicate(ctx, admitted.row); return { ...reply, result: governanceReceiptSchema.parse(reply.result) } }
    return this.dispatchGovernance(ctx, admitted.row)
  }, true)
  adopt: TeamGovernanceApi['adopt'] = raw => this.run(taskInputAdoptInputSchema, raw, async (input, ctx) => {
    const scope = taskInputScopeSchema.parse({ workspaceKey: input.workspaceKey, spaceId: input.spaceId, taskId: input.taskId, taskCreatedAt: input.taskCreatedAt })
    const command = validateGovernanceCommand(ctx.pin, input.command, scope)
    const admitted = ctx.journal.admit({ ...scope, lane: 'inputs' }, command)
    if (admitted.existing) {
      const reply = await this.duplicate(ctx, admitted.row)
      return { ...reply, result: taskInputReceiptSchema.parse(reply.result) }
    }
    return this.dispatchInputs(ctx, admitted.row)
  }, true)
  pending: TeamGovernanceApi['pending'] = raw => this.run(governanceRecoveryScopeSchema, raw, async (input, ctx) => ctx.journal.read().rows.filter(row => row.state !== 'committed' && JSON.stringify(row.scope) === JSON.stringify(input)).map(row => ({ commandId: row.commandId, action: ctx.journal.command(row).action, state: row.state === 'committed' ? 'unknown' : row.state, createdAt: row.createdAt, error: row.error, canRetry: true, outcomeUnknown: row.state === 'unknown' })), true)
  reconcile: TeamGovernanceApi['reconcile'] = raw => this.run(governanceRecoveryInputSchema, raw, (input, ctx) => this.receipt(ctx, ctx.journal.find(governanceRecoveryScopeSchema.parse(input.lane === 'inputs' ? { workspaceKey: input.workspaceKey, spaceId: input.spaceId, taskId: input.taskId, taskCreatedAt: input.taskCreatedAt, lane: input.lane } : { workspaceKey: input.workspaceKey, spaceId: input.spaceId, lane: input.lane }), input.commandId)), true)
  retry: TeamGovernanceApi['retry'] = raw => this.run(governanceRecoveryInputSchema, raw, async (input, ctx) => {
    const scope: GovernanceRecoveryScope = input.lane === 'inputs' ? { workspaceKey: input.workspaceKey, spaceId: input.spaceId, taskId: input.taskId, taskCreatedAt: input.taskCreatedAt, lane: input.lane } : { workspaceKey: input.workspaceKey, spaceId: input.spaceId, lane: input.lane }
    const row = ctx.journal.find(scope, input.commandId), receipt = await this.receipt(ctx, row)
    if (receipt) return { status: 'duplicate', commandId: row.commandId, result: receipt }
    return row.scope.lane === 'inputs' ? this.dispatchInputs(ctx, row) : this.dispatchGovernance(ctx, row)
  }, true)
  private async receipt(ctx: Context, row: GovernanceJournalRow): Promise<GovernanceReceipt | TaskInputReceipt | null> {
    try {
    const command = ctx.journal.command(row), scope = row.scope
    const value = await ctx.remote<GovernanceReceipt | TaskInputReceipt | null>(async t => scope.lane === 'inputs' ? t.inputReceipt(taskInputScopeSchema.parse({ workspaceKey: scope.workspaceKey, spaceId: scope.spaceId, taskId: scope.taskId, taskCreatedAt: scope.taskCreatedAt }), row.commandId) : t.receipt(row.commandId))
    if (value) { validateGovernanceReceipt(ctx.pin, command, value, scope.lane === 'inputs' ? taskInputScopeSchema.parse({ workspaceKey: scope.workspaceKey, spaceId: scope.spaceId, taskId: scope.taskId, taskCreatedAt: scope.taskCreatedAt }) : undefined); ctx.journal.settle(row, value) }
    return value
    } catch (error) {
      if (row.state !== 'rejected' && !(error instanceof DesktopTeamError && error.outcomeUnknown)) throw new DesktopTeamError(error instanceof DesktopTeamError ? error.code : 'GOVERNANCE_UNAVAILABLE', '原操作结果尚未核对，请保留原编号。', true)
      throw error
    }
  }
  private async duplicate(ctx: Context, row: GovernanceJournalRow): Promise<{ status: 'duplicate'; commandId: string; result: GovernanceReceipt | TaskInputReceipt }> {
    const receipt = await this.receipt(ctx, row)
    if (!receipt) throw new DesktopTeamError('RECONCILE_REQUIRED', '原操作已保留；核对后可明确重试原操作。', row.state !== 'rejected')
    return { status: 'duplicate', commandId: row.commandId, result: receipt }
  }
  private async dispatch<T extends { result: GovernanceReceipt | TaskInputReceipt }>(ctx: Context, row: GovernanceJournalRow, action: () => Promise<T>): Promise<T> {
    try {
      ctx.journal.update(row, { state: 'unknown', error: null })
      const reply = await action()
      ctx.journal.settle(row, reply.result)
      return reply
    } catch (error) {
      const uncertain = row.state === 'unknown' || !(error instanceof DesktopTeamError) || error.outcomeUnknown
      try { ctx.journal.update(row, { state: uncertain ? 'unknown' : 'rejected', error: error instanceof Error ? error.message.slice(0, 2000) : '原操作结果尚未确认。' }) }
      catch { throw new DesktopTeamError('GOVERNANCE_JOURNAL_UNAVAILABLE', '原操作已发送，本机核对记录保存失败，请继续核对原编号。', true) }
      if (uncertain && !(error instanceof DesktopTeamError && error.outcomeUnknown)) throw new DesktopTeamError(error instanceof DesktopTeamError ? error.code : 'ACKNOWLEDGEMENT_UNKNOWN', '原操作结果尚未确认，请核对原编号。', true)
      throw error
    }
  }
  private dispatchGovernance(ctx: Context, row: GovernanceJournalRow): Promise<{ status: 'committed' | 'duplicate'; commandId: string; result: GovernanceReceipt }> {
    const command = governanceCommandSchema.parse(ctx.journal.command(row))
    return this.dispatch(ctx, row, () => ctx.remote(t => t.command(command)))
  }
  private dispatchInputs(ctx: Context, row: GovernanceJournalRow): Promise<{ status: 'committed' | 'duplicate'; commandId: string; result: TaskInputReceipt }> {
    const scope = row.scope
    if (scope.lane !== 'inputs') throw new DesktopTeamError('INVALID_INPUT', '原操作不属于任务输入。')
    const task = taskInputScopeSchema.parse({ workspaceKey: scope.workspaceKey, spaceId: scope.spaceId, taskId: scope.taskId, taskCreatedAt: scope.taskCreatedAt })
    return this.dispatch(ctx, row, () => ctx.remote(t => t.adopt(task, taskInputCommandSchema.parse(ctx.journal.command(row)))))
  }
}
