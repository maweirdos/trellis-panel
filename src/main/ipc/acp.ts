/**
 * ACP 域 IPC：注册表/会话生命周期/权限审批的薄壳（决策 TPD-004：一域一文件）。
 * projectRoot 统一取自 state（本层允许 import state；acp 服务保持无环叶子）。
 */
import { ipcInvoke } from '../../shared/ipc-channels'
import { noProject, ipcFail, IpcErrorCode, type IpcFail } from '../../shared/ipc-errors'
import { getProjectRoot, getProjectGeneration } from '../state'
import type { AcpBindTaskInput, AcpPromptOptions } from '../../shared/types'
import { acpHandoffPreviewInputSchema, acpHandoffCreateInputSchema, acpHandoffCancelInputSchema, acpHandoffSessionIdSchema, acpHandoffOperationIdSchema } from '../../shared/acp-handoff'
import {
  cancelAcpSession,
  killAcpSession,
  listAcpAgents,
  listAcpSessions,
  newAcpSession,
  promptAcpSession,
  respondAcpPermission,
  listAcpProfiles, saveAcpProfile, deleteAcpProfile, setupAcpRuntime, pickAcpNode, pickAcpRuntimePath, resumeAcpSession, configureAcpSession, bindAcpSessionTask,
  listAcpHistorySessions, getAcpHistorySession, getAcpHistoryEvents, updateAcpHistorySession, retryAcpHistorySession, recoverAcpSessionModel,
  previewAcpSessionHandoff, createAcpSessionHandoff, getAcpSessionHandoff, cancelAcpSessionHandoff
} from '../services/daemon-client/acp'
import { testAcpRuntimeConnection } from '../services/daemon-client/acp'
import { handle } from './registry'
import { isManagedWorkflowOrigin } from '../services/daemon-client/workflow'

export function registerAcpIpc(): void {
  handle(ipcInvoke.acp.agents, () => listAcpAgents())

  handle(ipcInvoke.acp.sessions, (_e, limit?: number) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return listAcpSessions(root, limit)
  })
  const scopedHistory = async (operation: (root: string) => Promise<unknown>): Promise<unknown> => {
    const root = getProjectRoot()
    const generation = getProjectGeneration()
    if (!root) return noProject()
    const result = await operation(root)
    if (getProjectRoot() !== root || getProjectGeneration() !== generation) return noProject()
    return result
  }
  handle(ipcInvoke.acp.historyList, (_e, input) => scopedHistory((root) => listAcpHistorySessions(root, input)))
  handle(ipcInvoke.acp.historySession, (_e, id) => scopedHistory((root) => getAcpHistorySession(root, id)))
  handle(ipcInvoke.acp.historyUpdate, (_e, id, input) => {
    const root = getProjectRoot() ?? ''
    const generation = getProjectGeneration()
    return updateAcpHistorySession(root, id, input, () => getProjectRoot() === root && getProjectGeneration() === generation)
  })
  handle(ipcInvoke.acp.historyEvents, (_e, id, input) => scopedHistory((root) => getAcpHistoryEvents(root, id, input)))
  handle(ipcInvoke.acp.historyRetry, (_e, id) => scopedHistory((root) => retryAcpHistorySession(root, id)))
  const connection = async <T extends { ok: boolean }>(root: string, _target: { sessionId?: string; profileId?: string }, action: () => Promise<T>): Promise<T | IpcFail> => {
    if (!root) return noProject()
    try { return await action() } // The daemon acquires the real ordinary connection admission.
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      return ipcFail(code === 'E_CONFLICT' || code === 'SCOPE_CHANGED' ? IpcErrorCode.Conflict : IpcErrorCode.Io, error instanceof Error ? error.message : '工作区暂不能接纳原生连接')
    }
  }
  handle(ipcInvoke.acp.sessionRecoverModel, (_e, id, input) => {
    const root = getProjectRoot() ?? ''
    const generation = getProjectGeneration()
    return connection(root, { sessionId: id }, () => recoverAcpSessionModel(root, id, input, () => getProjectRoot() === root && getProjectGeneration() === generation))
  })

  handle(ipcInvoke.acp.sessionNew, (_e, input: { agentId: string; taskDir?: string; profileId?: string }) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return connection(root, { profileId: typeof input?.profileId === 'string' ? input.profileId : undefined }, () => newAcpSession(root, input))
  })

  handle(ipcInvoke.acp.sessionHandoffPreview, (_e, id: string, input: unknown) => {
    const parsed = acpHandoffPreviewInputSchema.safeParse(input)
    if (!parsed.success || !acpHandoffSessionIdSchema.safeParse(id).success) return ipcFail(IpcErrorCode.InvalidArg, '请选择有效的来源会话与目标 Runtime')
    return scopedHistory((root) => previewAcpSessionHandoff(root, id, parsed.data))
  })
  handle(ipcInvoke.acp.sessionHandoffCreate, (_e, id: string, input: unknown) => {
    const parsed = acpHandoffCreateInputSchema.safeParse(input)
    if (!parsed.success || !acpHandoffSessionIdSchema.safeParse(id).success) return ipcFail(IpcErrorCode.InvalidArg, '接续请求无效，请重新预览交接内容')
    const root = getProjectRoot() ?? ''
    const generation = getProjectGeneration()
    return createAcpSessionHandoff(root, id, parsed.data, () => getProjectRoot() === root && getProjectGeneration() === generation)
  })
  handle(ipcInvoke.acp.sessionHandoffStatus, (_e, id: string, operationId: string) => {
    if (!acpHandoffSessionIdSchema.safeParse(id).success || !acpHandoffOperationIdSchema.safeParse(operationId).success) return ipcFail(IpcErrorCode.InvalidArg, '接续操作标识无效')
    return scopedHistory((root) => getAcpSessionHandoff(root, id, operationId))
  })
  handle(ipcInvoke.acp.sessionHandoffCancel, (_e, id: string, input: unknown) => {
    const parsed = acpHandoffCancelInputSchema.safeParse(input)
    return parsed.success && acpHandoffSessionIdSchema.safeParse(id).success ? cancelAcpSessionHandoff(getProjectRoot() ?? '', id, parsed.data)
      : ipcFail(IpcErrorCode.InvalidArg, '接续操作标识无效')
  })

  handle(ipcInvoke.acp.sessionPrompt, async (_e, sessionId: string, text: string, options?: AcpPromptOptions) => {
    const root = getProjectRoot() ?? ''
    const generation = getProjectGeneration()
    if (!root) return noProject()
    try {
      return await promptAcpSession(root, sessionId, text, options, () => getProjectRoot() === root && getProjectGeneration() === generation, generation)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      return ipcFail(code === 'E_CONFLICT' || code === 'SCOPE_CHANGED' ? IpcErrorCode.Conflict : IpcErrorCode.Io, error instanceof Error ? error.message : '工作区暂不能接纳新的修改指令')
    }
  })
  handle(ipcInvoke.acp.sessionBindTask, async (_e, sessionId: string, input: AcpBindTaskInput) => {
    const root = getProjectRoot() ?? ''
    const generation = getProjectGeneration()
    if (root && await isManagedWorkflowOrigin(root, sessionId, undefined, true)) return ipcFail(IpcErrorCode.Conflict, '请先停止托管工作流，再更改会话绑定的任务')
    return bindAcpSessionTask(root, sessionId, input, () => getProjectRoot() === root && getProjectGeneration() === generation)
  })

  handle(ipcInvoke.acp.sessionCancel, (_e, sessionId: string) => cancelAcpSession(getProjectRoot() ?? '', sessionId))

  handle(ipcInvoke.acp.sessionKill, async (_e, sessionId: string) => {
    const root = getProjectRoot() ?? ''
    if (root && await isManagedWorkflowOrigin(root, sessionId, undefined, true)) return ipcFail(IpcErrorCode.Conflict, '请先停止托管工作流，再结束关联会话')
    return killAcpSession(root, sessionId)
  })

  handle(ipcInvoke.acp.permissionRespond, (_e, requestId: string, optionId: string) => respondAcpPermission(getProjectRoot() ?? '', requestId, optionId))
  handle(ipcInvoke.acp.profiles, () => listAcpProfiles(getProjectRoot() ?? ''))
  handle(ipcInvoke.acp.profileSave, (_e, input) => saveAcpProfile(getProjectRoot() ?? '', input))
  handle(ipcInvoke.acp.profileDelete, (_e, id: string) => deleteAcpProfile(getProjectRoot() ?? '', id))
  handle(ipcInvoke.acp.runtimeRefresh, () => listAcpAgents(true))
  handle(ipcInvoke.acp.runtimeSetup, (_e, id: string) => setupAcpRuntime(id))
  handle(ipcInvoke.acp.runtimeNodePick, () => pickAcpNode())
  handle(ipcInvoke.acp.runtimeTest, (_e, id: string) => testAcpRuntimeConnection(id))
  handle(ipcInvoke.acp.runtimePathPick, (_e, id: string) => pickAcpRuntimePath(id))
  handle(ipcInvoke.acp.sessionResume, (_e, id: string) => { const root = getProjectRoot() ?? ''; return connection(root, { sessionId: id }, () => resumeAcpSession(root, id)) })
  handle(ipcInvoke.acp.sessionConfigure, (_e, id: string, input) => { const root = getProjectRoot() ?? ''; return connection(root, { sessionId: id }, () => configureAcpSession(root, id, input)) })
}
