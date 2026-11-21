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
import { registerCruxIpc } from './crux'
import { registerTeamContentIpc } from './team-content'
import { registerCruxWorkIpc } from './crux-work'
import { registerCruxGovernanceIpc } from './crux-governance'
import { registerCruxTaskOutputsIpc } from './crux-task-outputs'
import { taskProgressNativeCall } from '../services/crux/task-progress'
import type { TaskOutputReply, TaskOutputNativeInput } from '../../shared/crux-task-outputs'
import { ipcInvoke } from '../../shared/ipc-channels'
import { registerCruxCodeResourcesIpc } from './crux-code-resources'
import { registerCruxTaskMaterialsIpc } from './crux-task-materials'
import { registerCruxProgressIpc } from './crux-progress'
import { registerProductTaskEntryIpc } from './product-task-entry'
import { registerCreationsIpc } from './creations'
import { registerWhiteboardV2Ipc } from './whiteboard-v2'
import { taskCreationReferences, taskCreationFiles } from '../services/creations'
import { getProjectGeneration, getProjectRoot } from '../state'
import { registerFilesIpc } from './files'
import { registerDocumentsIpc } from './documents'
import { registerObservationIpc } from './observability'
import { registerGitIpc } from './git'
import { registerDevtoolsIpc } from './devtools'
import { registerAppRuntimeIpc } from './app-runtime'
import { appRuntime, createTaskApplicationService } from '../services/app-runtime'
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
import { registerChatArchiveIpc } from './chat'
import { registerFlowIpc } from './flow'
import { registerWorkflowIpc } from './workflow'
import { registerTeamDesktopIpc } from './team-desktop'
import { registerAcpIpc } from './acp'
import { registerPrivateConversationsIpc } from './private-conversations'
import { ConversationError } from '../services/private-conversations/service'
import { getAcpHistorySession } from '../services/daemon-client/acp'
import { ipcFail, IpcErrorCode } from '../../shared/ipc-errors'
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
  registerCruxIpc()
  registerTeamContentIpc()
  const codeResources = registerCruxCodeResourcesIpc()
  registerCruxTaskMaterialsIpc()
  registerCruxGovernanceIpc(ipcInvoke.cruxGovernance)
  const taskWorkspace = registerCruxWorkIpc({ getProjectRoot, getProjectGeneration, getMain: deps.getMain, creationReferences: taskCreationReferences, creationFiles: taskCreationFiles,
    taskCodeResource: (query) => codeResources.taskForPreparation(query.workspaceKey, query.taskId) })
  const taskProgress = registerCruxProgressIpc(taskWorkspace, deps.getMain)
  registerProductTaskEntryIpc(taskWorkspace, deps.getMain)
  registerCruxTaskOutputsIpc({
    getMain: deps.getMain, channels: ipcInvoke.taskOutputs,
    resolveContext: (query, expected) => taskWorkspace.resolveOutputContext(query, expected),
    captureOriginalPin: query => taskProgress.captureOriginalPin(query),
    call: <T>(input: TaskOutputNativeInput) => taskProgressNativeCall<TaskOutputReply<T>>(input)
  })
  registerCreationsIpc()
  registerWhiteboardV2Ipc()
  registerFilesIpc()
  registerDocumentsIpc()
  registerObservationIpc()
  registerGitIpc()
  registerDevtoolsIpc(deps)
  registerAppRuntimeIpc(deps, createTaskApplicationService({ runtime: appRuntime, resolveTaskContext: (query, expected) => taskWorkspace.resolveContext(query, expected) }))
  registerGitWorkspaceIpc({ ...deps, resolveTaskContext: (query, expected) => taskWorkspace.resolveContext(query, expected) })
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
  registerChatArchiveIpc()
  registerFlowIpc()
  registerWorkflowIpc()
  registerTeamDesktopIpc(deps.getMain)
  registerAcpIpc()
  const privateConversations = registerPrivateConversationsIpc(deps)
  registerPiWebPreviewIpc({
    getProject: sessionId => sessionId?.startsWith('acp-private-')
      ? privateConversations.previewProject(sessionId)
      : { root: getProjectRoot(), generation: getProjectGeneration() },
    readSession: async (root, sessionId) => {
      try {
        return sessionId.startsWith('acp-private-') ? await privateConversations.previewSession(root, sessionId) : await getAcpHistorySession(root, sessionId)
      } catch (error) {
        return ipcFail(error instanceof ConversationError ? error.code : IpcErrorCode.Io, error instanceof Error ? error.message : '无法核对预览来源')
      }
    }
  })
}
