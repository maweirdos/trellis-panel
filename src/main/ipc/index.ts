/**
 * IPC 注册总装：主进程唯一的 ipcMain 入口（决策 TPD-004）。
 * index.ts 在 app.whenReady 后调用 registerIpc(deps)，其余任何模块不得直接触碰 ipcMain。
 */
import { registerProjectIpc } from './project'
import { registerDaemonIpc } from './daemon'
import { registerDaemonQuitIpc } from './daemon-quit'
import { registerTasksIpc } from './tasks'
import { registerTaskConversationsIpc } from './task-conversations'
import { registerTodoIpc } from './todo'
import { registerHifoxIpc } from './hifox'
import { registerHifoxWorkIpc } from './hifox-work'
import { registerCreationsIpc } from './creations'
import { taskCreationReferences, taskCreationFiles } from '../services/creations'
import { getProjectGeneration, getProjectRoot } from '../state'
import { registerFilesIpc } from './files'
import { registerDocumentsIpc } from './documents'
import { registerObservationIpc } from './observability'
import { registerGitIpc } from './git'
import { registerDevtoolsIpc } from './devtools'
import { registerAppRuntimeIpc } from './app-runtime'
import { registerGitWorkspaceIpc } from './git-workspace'
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
import { registerIntegrationsIpc } from './integrations'
import { registerProviderWorkspacesIpc } from './provider-workspaces'
import { registerHttpApiIpc } from './httpapi'
import { registerChatIpc } from './chat'
import { registerFlowIpc } from './flow'
import { registerWorkflowIpc } from './workflow'
import { registerTeamDesktopIpc } from './team-desktop'
import { registerAcpIpc } from './acp'
import { registerPiWebPreviewIpc } from './pi-web-preview'
import { registerWindowIpc } from './window'
import { registerDocsIpc } from './docs'
import { registerKnowledgeAccessIpc } from './knowledge-access'
import type { WindowDeps } from './deps'

export function registerIpc(deps: WindowDeps): void {
  registerDaemonIpc(deps)
  registerDaemonQuitIpc()
  registerWindowIpc(deps)
  registerDocsIpc(deps)
  registerProjectIpc(deps)
  registerTasksIpc()
  registerTaskConversationsIpc(deps)
  registerTodoIpc()
  registerHifoxIpc()
  registerHifoxWorkIpc({ getProjectRoot, getProjectGeneration, creationReferences: taskCreationReferences, creationFiles: taskCreationFiles })
  registerCreationsIpc()
  registerFilesIpc()
  registerDocumentsIpc()
  registerObservationIpc()
  registerGitIpc()
  registerDevtoolsIpc(deps)
  registerAppRuntimeIpc(deps)
  registerGitWorkspaceIpc(deps)
  registerReportIpc()
  registerChannelsIpc()
  registerStudioIpc()
  registerKnowledgeIpc()
  registerWeknoraIpc()
  registerKnowledgeAccessIpc()
  registerGatewayIpc()
  registerAiIpc()
  registerPlanningIpc()
  registerSettingsIpc()
  registerCliIpc(deps)
  registerBridgeIpc()
  registerJiraIpc()
  registerGitlabIpc()
  registerIntegrationsIpc()
  registerProviderWorkspacesIpc(deps)
  registerHttpApiIpc()
  registerChatIpc(deps)
  registerFlowIpc()
  registerWorkflowIpc()
  registerTeamDesktopIpc()
  registerAcpIpc()
  registerPiWebPreviewIpc()
}
