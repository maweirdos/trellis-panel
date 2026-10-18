/**
 * ACP 域 IPC：注册表/会话生命周期/权限审批的薄壳（决策 TPD-004：一域一文件）。
 * projectRoot 统一取自 state（本层允许 import state；acp 服务保持无环叶子）。
 */
import { ipcInvoke } from '../../shared/ipc-channels'
import { noProject } from '../../shared/ipc-errors'
import { getProjectRoot, getProjectGeneration } from '../state'
import type { AcpBindTaskInput, AcpPromptOptions } from '../../shared/types'
import {
  cancelAcpSession,
  killAcpSession,
  listAcpAgents,
  listAcpSessions,
  newAcpSession,
  promptAcpSession,
  respondAcpPermission,
  listAcpProfiles, saveAcpProfile, deleteAcpProfile, setupAcpRuntime, pickAcpNode, resumeAcpSession, configureAcpSession, bindAcpSessionTask
} from '../services/acp'
import { handle } from './registry'

export function registerAcpIpc(): void {
  handle(ipcInvoke.acp.agents, () => listAcpAgents())

  handle(ipcInvoke.acp.sessions, (_e, limit?: number) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return listAcpSessions(root, limit)
  })

  handle(ipcInvoke.acp.sessionNew, (_e, input: { agentId: string; taskDir?: string }) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return newAcpSession(root, input)
  })

  handle(ipcInvoke.acp.sessionPrompt, (_e, sessionId: string, text: string, options?: AcpPromptOptions) => {
    const root = getProjectRoot() ?? ''
    const generation = getProjectGeneration()
    return promptAcpSession(root, sessionId, text, options, () => getProjectRoot() === root && getProjectGeneration() === generation)
  })
  handle(ipcInvoke.acp.sessionBindTask, (_e, sessionId: string, input: AcpBindTaskInput) => {
    const root = getProjectRoot() ?? ''
    const generation = getProjectGeneration()
    return bindAcpSessionTask(root, sessionId, input, () => getProjectRoot() === root && getProjectGeneration() === generation)
  })

  handle(ipcInvoke.acp.sessionCancel, (_e, sessionId: string) => cancelAcpSession(getProjectRoot() ?? '', sessionId))

  handle(ipcInvoke.acp.sessionKill, (_e, sessionId: string) => killAcpSession(getProjectRoot() ?? '', sessionId))

  handle(ipcInvoke.acp.permissionRespond, (_e, requestId: string, optionId: string) => respondAcpPermission(getProjectRoot() ?? '', requestId, optionId))
  handle(ipcInvoke.acp.profiles, () => listAcpProfiles(getProjectRoot() ?? ''))
  handle(ipcInvoke.acp.profileSave, (_e, input) => saveAcpProfile(getProjectRoot() ?? '', input))
  handle(ipcInvoke.acp.profileDelete, (_e, id: string) => deleteAcpProfile(getProjectRoot() ?? '', id))
  handle(ipcInvoke.acp.runtimeRefresh, () => listAcpAgents(true))
  handle(ipcInvoke.acp.runtimeSetup, (_e, id: string) => setupAcpRuntime(id))
  handle(ipcInvoke.acp.runtimeNodePick, () => pickAcpNode())
  handle(ipcInvoke.acp.sessionResume, (_e, id: string) => resumeAcpSession(getProjectRoot() ?? '', id))
  handle(ipcInvoke.acp.sessionConfigure, (_e, id: string, input) => configureAcpSession(getProjectRoot() ?? '', id, input))
}
