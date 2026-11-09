import { INTEGRATION_CATALOG } from '../../../../shared/integrations'
import { IntegrationRegistry } from '../registry'
import { githubPort, gitlabPort, giteePort } from './repositories'
import { gitlabAuthorization } from './gitlab-authorization'
import { notificationPort, validateWebhook } from './notifications'
import { jiraSourcePort } from './jira'
import { jiraAuthorization, validateJiraConnection, inspectJiraConnection } from './jira-authorization'
import { weknoraKnowledgePort } from './weknora'

export const integrationRegistry = new IntegrationRegistry()
for (const manifest of INTEGRATION_CATALOG) {
  const repository = manifest.id === 'github' ? githubPort : manifest.id === 'gitlab' ? gitlabPort : manifest.id === 'gitee' ? giteePort : undefined
  integrationRegistry.register({ manifest, repository, knowledge: manifest.id === 'weknora' ? weknoraKnowledgePort : undefined, authorization: manifest.id === 'gitlab' ? gitlabAuthorization : manifest.id === 'jira' ? jiraAuthorization : undefined, tasks: manifest.id === 'jira' ? jiraSourcePort : undefined, notification: manifest.category === 'messaging' ? notificationPort : undefined,
    validate: manifest.category === 'messaging' ? (c) => { validateWebhook(manifest.id, c.secrets.webhook || '') } : manifest.id === 'jira' ? validateJiraConnection : undefined,
    inspect: manifest.id === 'jira' ? inspectJiraConnection : manifest.id === 'weknora' ? async (connection) => { const result = await weknoraKnowledgePort.collections(connection); return `知识库读取通过（本页 ${result.items.length} 个${result.hasMore ? '，还有更多' : ''}）；发布权限与索引状态尚未验证` } : undefined })
}
