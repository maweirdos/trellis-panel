import type { ProviderWorkspaceExtensions } from './provider-workspace'
import { JiraProviderContent } from './providers/jira'
import { GitlabWorkspaceContent } from './providers/gitlab'
import { DingTalkBeforeConnection, DingTalkContent } from './providers/dingtalk'
import { FeishuWorkspaceContent } from './providers/feishu/FeishuWorkspace'

/** UI owner wires explicit imports here after provider handoff; no runtime plugin discovery. */
export const PROVIDER_WORKSPACE_EXTENSIONS: ProviderWorkspaceExtensions = {
  jira: { Content: JiraProviderContent },
  'gitlab-issues-hosted': { Content: GitlabWorkspaceContent },
  'gitlab-issues-self-managed': { Content: GitlabWorkspaceContent },
  dingtalk: { connectionMode: 'provider', BeforeConnection: DingTalkBeforeConnection, Content: DingTalkContent },
  feishu: { connectionMode: 'provider', Content: FeishuWorkspaceContent }
}
