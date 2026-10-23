import type { ProviderWorkspaceExtensions } from './provider-workspace'
import { JiraProviderContent } from './providers/jira'
import { GitlabSetupSection, GitlabWorkspaceContent } from './providers/gitlab'
import { DingTalkBeforeConnection, DingTalkContent } from './providers/dingtalk'

/** UI owner wires explicit imports here after provider handoff; no runtime plugin discovery. */
export const PROVIDER_WORKSPACE_EXTENSIONS: ProviderWorkspaceExtensions = {
  jira: { Content: JiraProviderContent },
  'gitlab-issues-hosted': { BeforeConnection: GitlabSetupSection, Content: GitlabWorkspaceContent },
  'gitlab-issues-self-managed': { BeforeConnection: GitlabSetupSection, Content: GitlabWorkspaceContent },
  dingtalk: { BeforeConnection: DingTalkBeforeConnection, Content: DingTalkContent }
}
