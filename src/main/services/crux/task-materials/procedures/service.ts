import { z } from 'zod'
import {
  cruxMaterialScopeSchema, cruxMaterialListSchema, cruxMaterialReadSchema, cruxMaterialHistorySchema,
  cruxMaterialCommandSchema, cruxMaterialRecoverySchema,
  type CruxMaterialScope, type CruxTaskMaterialsApi, type CruxMaterialReply, type CruxMaterialPending
} from '../../../../../shared/crux-task-materials'
import type { TeamTaskMaterialCommandReply, TeamTaskMaterialReceipt } from '../../../../../shared/team-task-materials'
import { IpcErrorCode, ipcFail } from '../../../../../shared/ipc-errors'
import { DesktopTeamError } from '../../../team-platform/types'
import { validateTaskMaterialCommand, type TaskMaterialsTransport } from '../../../team-platform/task-materials-transport'
import { captureMaterialOwner, assertMaterialOwner, requireMaterialWorkspace } from '../lib/owner'
import { MaterialJournalStore, materialOwnerKey } from '../lib/journal'
import type { MaterialHost, MaterialOwner, MaterialTeamSession, MaterialJournalRow } from '../types'

const queues = new Map<string, Promise<void>>()
const errorCode = (error: unknown): string => error instanceof DesktopTeamError ? error.code
  : error instanceof Error && 'code' in error && error.code === 'SERVICE_CLOSED' ? 'SERVICE_CLOSED' : 'MATERIAL_OPERATION_FAILED'
type ProcedureContext = { owner: MaterialOwner; journal: MaterialJournalStore; current: () => Promise<void>; remote: <T>(action: (transport: TaskMaterialsTransport) => Promise<T>) => Promise<T> }

/** Admission is joined by the existing desktop-team shutdown drain; there is no automatic queue sender. */
export class CruxTaskMaterialsService implements CruxTaskMaterialsApi {
  constructor(private readonly dataDir: string, private readonly host: MaterialHost) {}
  private async guarded<S extends z.ZodType<CruxMaterialScope>, T>(schema: S, raw: unknown, action: (input: z.output<S>, context: ProcedureContext) => Promise<T>, locked = false): Promise<CruxMaterialReply<T>> {
    try {
      const input = schema.parse(raw), generation = this.host.workspaceGeneration(), context = await this.host.workspaceStatus()
      requireMaterialWorkspace(context, input.workspaceKey)
      return await this.host.withService(async session => {
        const owner = await captureMaterialOwner(this.host, session, input, context, generation)
        const ctx = this.context(owner, session)
        const work = async (): Promise<CruxMaterialReply<T>> => {
          await ctx.current()
          const value = await action(input, ctx)
          try { await ctx.current() }
          catch (error) {
            if ('command' in input || 'commandId' in input) throw new DesktopTeamError(errorCode(error), '原材料身份在操作返回前变化，请回原来源核对命令。', true)
            throw error
          }
          return { ok: true, value }
        }
        return locked ? this.locked(owner, work) : work()
      })
    } catch (error) {
      const code = error instanceof z.ZodError ? 'INVALID_INPUT' : errorCode(error)
      const message = error instanceof z.ZodError ? '材料参数无效，请重新核对所选任务和完整命令。'
        : error instanceof DesktopTeamError ? error.message : code === 'SERVICE_CLOSED' ? '团队服务正在退出，原材料操作已保留。' : '材料操作未能确认，请核对原命令记录。'
      return ipcFail(IpcErrorCode.Unknown, message, { code, outcomeUnknown: error instanceof DesktopTeamError && error.outcomeUnknown })
    }
  }
  private context(owner: MaterialOwner, session: MaterialTeamSession): ProcedureContext {
    const current = (): Promise<void> => assertMaterialOwner(this.host, session, owner)
    return { owner, current, journal: new MaterialJournalStore(this.dataDir, owner), remote: action => session.withTaskMaterialsTransport(owner.pin, current, action) }
  }
  private async locked<T>(owner: MaterialOwner, work: () => Promise<T>): Promise<T> {
    const key = `${this.dataDir}:${materialOwnerKey(owner)}`, previous = queues.get(key)
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    queues.set(key, gate)
    try { if (previous) await previous; return await work() }
    finally { release?.(); if (queues.get(key) === gate) queues.delete(key) }
  }
  list: CruxTaskMaterialsApi['list'] = raw => this.guarded(cruxMaterialListSchema, raw, (input, ctx) => ctx.remote(transport => transport.list({
    spaceId: input.spaceId, taskCreatedAt: input.taskCreatedAt, cursor: input.cursor, limit: input.limit
  })))
  read: CruxTaskMaterialsApi['read'] = raw => this.guarded(cruxMaterialReadSchema, raw, (input, ctx) => ctx.remote(transport => transport.read(input.documentId, {
    spaceId: input.spaceId, taskCreatedAt: input.taskCreatedAt, versionId: input.versionId
  })))
  versions: CruxTaskMaterialsApi['versions'] = raw => this.guarded(cruxMaterialHistorySchema, raw, (input, ctx) => ctx.remote(transport => transport.versions(input.documentId, {
    spaceId: input.spaceId, taskCreatedAt: input.taskCreatedAt, cursor: input.cursor, limit: input.limit
  })))
  submissions: CruxTaskMaterialsApi['submissions'] = raw => this.guarded(cruxMaterialHistorySchema, raw, (input, ctx) => ctx.remote(transport => transport.submissions(input.documentId, {
    spaceId: input.spaceId, taskCreatedAt: input.taskCreatedAt, cursor: input.cursor, limit: input.limit
  })))
  command: CruxTaskMaterialsApi['command'] = raw => this.guarded(cruxMaterialCommandSchema, raw, async (input, ctx) => {
    const command = validateTaskMaterialCommand(ctx.owner.pin, input.command)
    const admitted = ctx.journal.admit(command)
    if (!admitted.existing) return this.dispatch(ctx, admitted.row)
    return this.withOriginalOutcome(admitted.row, async () => {
      const receipt = await this.receipt(ctx, admitted.row)
      if (receipt) return { status: 'duplicate', commandId: command.commandId, result: receipt }
      throw new DesktopTeamError('RECONCILE_REQUIRED', '原命令已保留，请核对或明确以原编号和原正文重试。', admitted.row.outcomeUnknown)
    })
  }, true)
  pending: CruxTaskMaterialsApi['pending'] = raw => this.guarded(cruxMaterialScopeSchema, raw, async (_input, ctx) => {
    return ctx.journal.read().rows.filter(row => row.state !== 'committed').map((row): CruxMaterialPending => {
      ctx.journal.command(row)
      return { commandId: row.commandId, action: row.action, documentId: row.documentId, state: row.state === 'committed' ? 'unknown' : row.state,
        createdAt: row.createdAt, errorCode: row.errorCode, error: row.error, outcomeUnknown: row.outcomeUnknown }
    })
  }, true)
  reconcile: CruxTaskMaterialsApi['reconcile'] = raw => this.guarded(cruxMaterialRecoverySchema, raw, async (input, ctx) => {
    const row = ctx.journal.find(input.commandId)
    return this.withOriginalOutcome(row, () => this.receipt(ctx, row))
  }, true)
  retry: CruxTaskMaterialsApi['retry'] = raw => this.guarded(cruxMaterialRecoverySchema, raw, async (input, ctx) => {
    const row = ctx.journal.find(input.commandId)
    return this.withOriginalOutcome(row, async () => {
      const receipt = await this.receipt(ctx, row)
      if (receipt) return { status: 'duplicate', commandId: row.commandId, result: receipt }
      // Even explicit retry cannot replay a locally confirmed conflict candidate after a missing remote receipt.
      if (row.state === 'committed') throw new DesktopTeamError('RECEIPT_MISMATCH', '原命令已确认提交，当前未查到回执；请核对原服务，不可重新发送。', true)
      return this.dispatch(ctx, ctx.journal.find(row.commandId))
    })
  }, true)
  private async withOriginalOutcome<T>(row: MaterialJournalRow, work: () => Promise<T>): Promise<T> {
    try { return await work() }
    catch (error) {
      if ((row.outcomeUnknown || row.state === 'committed') && !(error instanceof DesktopTeamError && error.outcomeUnknown)) {
        throw new DesktopTeamError(errorCode(error), error instanceof DesktopTeamError ? error.message : '原操作的结果仍未确认，请保留原身份与命令。', true)
      }
      throw error
    }
  }
  private async receipt(ctx: ProcedureContext, row: MaterialJournalRow): Promise<TeamTaskMaterialReceipt | null> {
    await ctx.current()
    const receipt = await ctx.remote(transport => transport.receipt(ctx.journal.command(row)))
    if (receipt) {
      try { ctx.journal.settle(row.commandId, receipt) }
      catch { throw new DesktopTeamError('ACKNOWLEDGEMENT_UNKNOWN', '服务器已有原命令回执，但本机尚未完整记录，请再次核对。', true) }
    }
    await ctx.current()
    return receipt
  }
  private async dispatch(ctx: ProcedureContext, row: MaterialJournalRow): Promise<TeamTaskMaterialCommandReply> {
    await ctx.current()
    const command = ctx.journal.command(row)
    // Durable dispatch intent comes before HTTP. A crash can only resume reconciliation or explicit identical retry.
    ctx.journal.update(row.commandId, { state: 'unknown', outcomeUnknown: true, errorCode: null, error: null })
    try {
      const result = await ctx.remote(transport => transport.command(command))
      ctx.journal.settle(row.commandId, result.result)
      await ctx.current()
      return result
    } catch (error) {
      let latest: MaterialJournalRow
      try { latest = ctx.journal.find(row.commandId) }
      catch { throw new DesktopTeamError('ACKNOWLEDGEMENT_UNKNOWN', '发送后原命令状态无法读取，请保留原文件核对。', true) }
      const unknown = row.outcomeUnknown || !(error instanceof DesktopTeamError) || error.outcomeUnknown
      if (latest.state !== 'committed') {
        try { ctx.journal.update(row.commandId, { state: unknown ? 'unknown' : 'rejected', outcomeUnknown: unknown,
          errorCode: errorCode(error), error: error instanceof DesktopTeamError ? error.message.slice(0, 2000) : '发送流程未能确认，请核对原命令。' }) }
        catch { throw new DesktopTeamError('ACKNOWLEDGEMENT_UNKNOWN', '发送后的本机状态未能保存，原命令仍保留，请核对。', true) }
      }
      throw new DesktopTeamError(errorCode(error), error instanceof DesktopTeamError ? error.message : '材料命令已进入发送流程，结果尚未完整确认。', unknown || latest.state === 'committed')
    }
  }
}
