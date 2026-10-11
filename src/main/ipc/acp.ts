/**
 * ACP 域 IPC：注册表/会话生命周期/权限审批的薄壳（决策 TPD-004：一域一文件）。
 * projectRoot 统一取自 state（本层允许 import state；acp 服务保持无环叶子）。
 */
import { ipcInvoke } from '../../shared/ipc-channels'
import { noProject } from '../../shared/ipc-errors'
import { getProjectRoot } from '../state'
import {
  cancelAcpSession,
  killAcpSession,
  listAcpAgents,
  listAcpSessions,
  newAcpSession,
  promptAcpSession,
  respondAcpPermission
} from '../services/acp'
import { handle } from './registry'

export function registerAcpIpc(): void {
  handle(ipcInvoke.acp.agents, () => listAcpAgents())

  handle(ipcInvoke.acp.sessions, (_e, limit?: number) => listAcpSessions(limit))

  handle(ipcInvoke.acp.sessionNew, (_e, input: { agentId: string; taskDir?: string }) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return newAcpSession(root, input)
  })

  handle(ipcInvoke.acp.sessionPrompt, (_e, sessionId: string, text: string) => promptAcpSession(sessionId, text))

  handle(ipcInvoke.acp.sessionCancel, (_e, sessionId: string) => cancelAcpSession(sessionId))

  handle(ipcInvoke.acp.sessionKill, (_e, sessionId: string) => killAcpSession(sessionId))

  handle(ipcInvoke.acp.permissionRespond, (_e, requestId: string, optionId: string) => respondAcpPermission(requestId, optionId))
}
