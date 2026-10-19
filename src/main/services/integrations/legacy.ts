import { createHash } from 'node:crypto'
import type { IntegrationConnection } from '../../../shared/integrations'
import type { JiraConfig } from '../../../shared/types'
import { getSettings } from '../store'
import { jiraInstanceIdFor } from '../jira-instance'
import { legacySecret } from './credentials'
import type { ResolvedConnection } from './types'

export function legacyRevision(value: unknown): number { return Number.parseInt(createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12), 16) || 1 }
export function legacyConnections(): IntegrationConnection[] {
  const settings = getSettings()
  const jira = settings.jira
  const gitlab = settings.gitlab
  const connections: IntegrationConnection[] = [
    { id: 'legacy-jira', providerId: 'jira' as const, name: 'Jira · 原有配置', enabled: jira.enabled, revision: legacyRevision(jira), config: { baseUrl: jira.baseUrl, user: jira.user, jql: jira.jql, statusMap: JSON.stringify(jira.statusMap) }, hasSecrets: jira.password ? ['password'] : [], legacy: true, checkedAt: null, check: 'unverified' as const, detail: '兼容现有 Jira 来源和任务导入' },
    { id: 'legacy-gitlab', providerId: 'gitlab' as const, name: 'GitLab · 原有配置', enabled: gitlab.enabled, revision: legacyRevision(gitlab), config: { baseUrl: gitlab.baseUrl, user: gitlab.user, project: gitlab.project }, hasSecrets: gitlab.password ? ['password'] : [], legacy: true, checkedAt: null, check: 'unverified' as const, detail: '沿用原有 OAuth 密码认证' }
  ]
  return connections.filter((item) => Boolean(item.config.baseUrl))
}
export function resolveLegacy(connection: IntegrationConnection): ResolvedConnection {
  const settings = getSettings()
  const cfg = connection.providerId === 'jira' ? settings.jira : settings.gitlab
  return { public: connection, secrets: { password: legacySecret(cfg.password, cfg.passwordEncrypted) }, instanceId: connection.providerId === 'jira' ? jiraInstanceIdFor(cfg.baseUrl, cfg.user) : `gitlab:${cfg.baseUrl.replace(/\/+$/, '')}` }
}
export function jiraConfig(connection: ResolvedConnection): JiraConfig {
  let statusMap: Record<string, string> = {}
  try {
    const parsed: unknown = JSON.parse(connection.public.config.statusMap || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) statusMap = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch { /* validated on save; invalid old map keeps category mapping */ }
  return { enabled: connection.public.enabled, baseUrl: connection.public.config.baseUrl || '', user: connection.public.config.user || '', password: connection.secrets.password || '', jql: connection.public.config.jql || '', statusMap }
}
