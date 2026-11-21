import type { WindowDeps } from './deps'
import { getProjectGeneration, getProjectRoot } from '../state'
import { createDingTalkWorkspaceClient, createFeishuWorkspaceClient, createGitlabWorkspaceClient, createJiraWorkspaceClient } from '../services/daemon-client/provider-workspaces'
import { registerJiraIntegrationIpc } from './jira-integration'
import { registerGitlabIntegrationIpc } from './gitlab-integration'
import { registerDingTalkIntegrationIpc } from './dingtalk-integration'
import { registerFeishuIntegrationIpc } from './feishu-integration'

/** Native window/frame authority and GUI selection precede every provider facade.
 * All provider stores/workers remain in the single leased daemon. */
export function registerProviderWorkspacesIpc(deps: WindowDeps): void {
  const isMainFrame = (event: Electron.IpcMainInvokeEvent): boolean => {
    const main = deps.getMain()
    return Boolean(main && !main.isDestroyed() && !event.sender.isDestroyed() && main.webContents.id === event.sender.id && event.senderFrame === main.webContents.mainFrame)
  }
  const selection = { root: getProjectRoot, generation: getProjectGeneration }
  registerJiraIntegrationIpc(({ signal }) => createJiraWorkspaceClient(selection, signal), isMainFrame)
  registerGitlabIntegrationIpc(createGitlabWorkspaceClient(selection), isMainFrame)
  registerDingTalkIntegrationIpc(createDingTalkWorkspaceClient(selection), isMainFrame)
  registerFeishuIntegrationIpc(createFeishuWorkspaceClient(selection), isMainFrame)
}
