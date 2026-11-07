import { z } from 'zod'
import { ipcInvoke } from '../../shared/ipc-channels'
import { cruxMutationNames } from '../../shared/crux-domain/commands'
import { CruxError as CoreError } from '../../shared/crux-domain/core'
import { CruxError as PlanningError } from '../../shared/crux-domain/planning'
import { CruxError as AgentError } from '../../shared/crux-domain/agents'
import type { CruxFailure } from '../../shared/crux'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import { triageQueue } from '../services/crux/planning'
import { CruxRemoteClientError } from '../services/crux/remote'
import { cruxWorkspaceSnapshot, cruxWorkspaceStatus, selectCruxWorkspace, executeCruxWorkspace, resetCruxWorkspace, pendingCruxWorkspace, retryCruxWorkspace, discardCruxWorkspace } from '../services/crux/connection-service'
import { handle } from './registry'

function fail(error: unknown): CruxFailure {
  return ipcFail(error instanceof z.ZodError || error instanceof CoreError || error instanceof PlanningError || error instanceof AgentError ? IpcErrorCode.InvalidArg : IpcErrorCode.Unknown,
    error instanceof z.ZodError ? error.issues[0]?.message ?? '参数无效' : error instanceof Error ? error.message : '协作操作未完成',
    error instanceof CruxRemoteClientError ? { code: error.code, context: error.context, outcomeUnknown: error.outcomeUnknown, pending: error.pending } : undefined)
}
async function owned<T>(action: () => Promise<T>): Promise<T | CruxFailure> { try { return await action() } catch (error) { return fail(error) } }
const scope = (raw: unknown): string => z.string().min(1).max(256).parse(raw ?? 'local')

export function registerCruxIpc(): void {
  handle(ipcInvoke.crux.snapshot, () => owned(async () => { const value = await cruxWorkspaceSnapshot(); return { ok: true as const, data: value.snapshot, context: value.context } }))
  handle(ipcInvoke.crux.workspaceStatus, () => owned(async () => ({ ok: true as const, context: await cruxWorkspaceStatus() })))
  handle(ipcInvoke.crux.selectWorkspace, (_event, raw) => owned(async () => {
    const input = z.object({ connectionId: z.string().uuid().nullable() }).strict().parse(raw)
    const value = await selectCruxWorkspace(input.connectionId)
    return { ok: true as const, data: value.snapshot, context: value.context }
  }))
  handle(ipcInvoke.crux.workspacePending, (_event, _input, expectedScope) => owned(async () => {
    return { ok: true as const, data: await pendingCruxWorkspace(scope(expectedScope)) }
  }))
  handle(ipcInvoke.crux.retryWorkspaceCommand, (_event, raw, expectedScope) => owned(async () => {
    const input = z.object({ commandId: z.string().uuid() }).strict().parse(raw)
    const value = await retryCruxWorkspace(input.commandId, scope(expectedScope))
    return { ok: true as const, data: value.snapshot, context: value.context }
  }))
  handle(ipcInvoke.crux.discardWorkspaceCommand, (_event, raw, expectedScope) => owned(async () => {
    const input = z.object({ commandId: z.string().uuid() }).strict().parse(raw)
    return { ok: true as const, context: await discardCruxWorkspace(input.commandId, scope(expectedScope)) }
  }))
  handle(ipcInvoke.crux.resetDemo, (_event, _input, expectedScope) => owned(async () => {
    const value = await resetCruxWorkspace(scope(expectedScope))
    return { ok: true as const, data: value.snapshot, context: value.context }
  }))
  handle(ipcInvoke.crux.triageQueue, (_event, raw, expectedScope) => owned(async () => {
    const spaceId = z.string().min(1).max(256).parse(raw)
    const value = await cruxWorkspaceSnapshot()
    if (value.context.key !== scope(expectedScope)) throw new Error('协作空间已切换，请重新打开分拣台。')
    return { ok: true as const, data: triageQueue(value.snapshot, spaceId), context: value.context }
  }))
  for (const operation of cruxMutationNames) {
    handle(ipcInvoke.crux[operation], (_event, input, expectedScope) => owned(async () => {
      const result = await executeCruxWorkspace(operation, input, scope(expectedScope))
      return { ok: true as const, data: result.snapshot, context: result.context, ...(result.taskId ? { taskId: result.taskId } : {}) }
    }))
  }
}
