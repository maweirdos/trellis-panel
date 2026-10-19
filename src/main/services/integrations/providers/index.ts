import { INTEGRATION_CATALOG } from '../../../../shared/integrations'
import { IntegrationRegistry } from '../registry'
import { githubPort, gitlabPort, giteePort } from './repositories'
import { gitlabAuthorization } from './gitlab-authorization'
import { notificationPort, validateWebhook } from './notifications'
import { jiraSourcePort } from './jira'
import { jiraTest } from '../../jira'
import { jiraConfig } from '../legacy'
import { IntegrationError } from '../types'
import { integrationFetch, readRemoteJson, recordOf, textOf } from '../transport'

export const integrationRegistry = new IntegrationRegistry()
for (const manifest of INTEGRATION_CATALOG) {
  const repository = manifest.id === 'github' ? githubPort : manifest.id === 'gitlab' ? gitlabPort : manifest.id === 'gitee' ? giteePort : undefined
  integrationRegistry.register({ manifest, repository, authorization: manifest.id === 'gitlab' ? gitlabAuthorization : undefined, tasks: manifest.id === 'jira' ? jiraSourcePort : undefined, notification: manifest.category === 'messaging' ? notificationPort : undefined,
    validate: manifest.category === 'messaging' ? (c) => { validateWebhook(manifest.id, c.secrets.webhook || '') } : undefined,
    inspect: manifest.id === 'jira' ? async (connection) => {
      const cfg = jiraConfig(connection)
      const result = await jiraTest(cfg, { transport: integrationFetch })
      if (!result.ok) throw new IntegrationError('Jira 认证失败，请检查用户名、密码和实例地址', 'upstream')
      let version = ''
      try {
        const response = await readRemoteJson(`${cfg.baseUrl}/rest/api/2/serverInfo`, { headers: { Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}` } })
        const data = recordOf(response.body)
        version = ` · ${textOf(data.deploymentType)} ${textOf(data.version)}`
      } catch { /* Authentication remains verified; version metadata is optional. */ }
      return `${result.displayName || 'Jira 认证成功'}${version}`
    } : undefined })
}
