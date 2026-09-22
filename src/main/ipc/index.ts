/**
 * IPC 注册总装：主进程唯一的 ipcMain 入口（决策 TPD-004）。
 * index.ts 在 app.whenReady 后调用 registerIpc(deps)，其余任何模块不得直接触碰 ipcMain。
 */
import { registerProjectIpc } from './project'
import { registerTasksIpc } from './tasks'
import { registerTodoIpc } from './todo'
import { registerFilesIpc } from './files'
import { registerGitIpc } from './git'
import { registerReportIpc } from './report'
import { registerChannelsIpc } from './channels'
import { registerStudioIpc } from './studio'
import { registerKnowledgeIpc } from './knowledge'
import { registerWeknoraIpc } from './weknora'
import { registerGatewayIpc } from './gateway'
import { registerAiIpc } from './ai'
import { registerPlanningIpc } from './planning'
import { registerSettingsIpc } from './settings'
import { registerCliIpc } from './cli'
import { registerBridgeIpc } from './bridge'
import { registerJiraIpc } from './jira'
import { registerGitlabIpc } from './gitlab'
import { registerHttpApiIpc } from './httpapi'
import { registerChatIpc } from './chat'
import { registerFlowIpc } from './flow'
import { registerWindowIpc } from './window'
import type { WindowDeps } from './deps'

export function registerIpc(deps: WindowDeps): void {
  registerWindowIpc(deps)
  registerProjectIpc(deps)
  registerTasksIpc()
  registerTodoIpc()
  registerFilesIpc()
  registerGitIpc()
  registerReportIpc()
  registerChannelsIpc()
  registerStudioIpc()
  registerKnowledgeIpc()
  registerWeknoraIpc()
  registerGatewayIpc()
  registerAiIpc()
  registerPlanningIpc()
  registerSettingsIpc()
  registerCliIpc(deps)
  registerBridgeIpc()
  registerJiraIpc()
  registerGitlabIpc()
  registerHttpApiIpc()
  registerChatIpc(deps)
  registerFlowIpc()
}
