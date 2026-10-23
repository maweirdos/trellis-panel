import { hasJiraIntegrationApi, type JiraIntegrationApi } from '@shared/jira-integration'

/** Feature guard stays isolated from the existing integrations bridge during native version skew. */
export function jiraIntegrationBridge(): JiraIntegrationApi | null {
  const native = (window as unknown as { trellis?: { jiraIntegration?: unknown } }).trellis?.jiraIntegration
  return hasJiraIntegrationApi(native) ? native : null
}
