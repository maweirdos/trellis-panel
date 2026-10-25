import { z } from 'zod'
import { ipcInvoke } from '../../shared/ipc-channels'
import { hifoxMutationNames } from '../../shared/hifox-domain/commands'
import { HifoxError as CoreError } from '../../shared/hifox-domain/core'
import { HifoxError as PlanningError } from '../../shared/hifox-domain/planning'
import { HifoxError as AgentError } from '../../shared/hifox-domain/agents'
import type { HifoxFailure } from '../../shared/hifox'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
import { triageQueue } from '../services/hifox/planning'
import { HifoxRemoteClientError } from '../services/hifox/remote'
import { hifoxWorkspaceSnapshot, hifoxWorkspaceStatus, selectHifoxWorkspace, executeHifoxWorkspace, resetHifoxWorkspace, pendingHifoxWorkspace, retryHifoxWorkspace, discardHifoxWorkspace } from '../services/hifox/connection-service'
import { handle } from './registry'

function fail(error: unknown): HifoxFailure {
  return ipcFail(error instanceof z.ZodError || error instanceof CoreError || error instanceof PlanningError || error instanceof AgentError ? IpcErrorCode.InvalidArg : IpcErrorCode.Unknown,
    error instanceof z.ZodError ? error.issues[0]?.message ?? '参数无效' : error instanceof Error ? error.message : '协作操作未完成',
    error instanceof HifoxRemoteClientError ? { code: error.code, context: error.context, outcomeUnknown: error.outcomeUnknown, pending: error.pending } : undefined)
}
async function owned<T>(action: () => Promise<T>): Promise<T | HifoxFailure> { try { return await action() } catch (error) { return fail(error) } }
const scope = (raw: unknown): string => z.string().min(1).max(256).parse(raw ?? 'local')

export function registerHifoxIpc(): void {
  handle(ipcInvoke.hifox.snapshot, () => owned(async () => { const value = await hifoxWorkspaceSnapshot(); return { ok: true as const, data: value.snapshot, context: value.context } }))
  handle(ipcInvoke.hifox.workspaceStatus, () => owned(async () => ({ ok: true as const, context: await hifoxWorkspaceStatus() })))
  handle(ipcInvoke.hifox.selectWorkspace, (_event, raw) => owned(async () => {
    const input = z.object({ connectionId: z.string().uuid().nullable() }).strict().parse(raw)
    const value = await selectHifoxWorkspace(input.connectionId)
    return { ok: true as const, data: value.snapshot, context: value.context }
  }))
  handle(ipcInvoke.hifox.workspacePending, (_event, _input, expectedScope) => owned(async () => {
    return { ok: true as const, data: await pendingHifoxWorkspace(scope(expectedScope)) }
  }))
  handle(ipcInvoke.hifox.retryWorkspaceCommand, (_event, raw, expectedScope) => owned(async () => {
    const input = z.object({ commandId: z.string().uuid() }).strict().parse(raw)
    const value = await retryHifoxWorkspace(input.commandId, scope(expectedScope))
    return { ok: true as const, data: value.snapshot, context: value.context }
  }))
  handle(ipcInvoke.hifox.discardWorkspaceCommand, (_event, raw, expectedScope) => owned(async () => {
    const input = z.object({ commandId: z.string().uuid() }).strict().parse(raw)
    return { ok: true as const, context: await discardHifoxWorkspace(input.commandId, scope(expectedScope)) }
  }))
  handle(ipcInvoke.hifox.resetDemo, (_event, _input, expectedScope) => owned(async () => {
    const value = await resetHifoxWorkspace(scope(expectedScope))
    return { ok: true as const, data: value.snapshot, context: value.context }
  }))
  handle(ipcInvoke.hifox.triageQueue, (_event, raw, expectedScope) => owned(async () => {
    const spaceId = z.string().min(1).max(256).parse(raw)
    const value = await hifoxWorkspaceSnapshot()
    if (value.context.key !== scope(expectedScope)) throw new Error('协作空间已切换，请重新打开分拣台。')
    return { ok: true as const, data: triageQueue(value.snapshot, spaceId), context: value.context }
  }))
  for (const operation of hifoxMutationNames) {
    handle(ipcInvoke.hifox[operation], (_event, input, expectedScope) => owned(async () => {
      const result = await executeHifoxWorkspace(operation, input, scope(expectedScope))
      return { ok: true as const, data: result.snapshot, context: result.context, ...(result.taskId ? { taskId: result.taskId } : {}) }
    }))
  }
}
