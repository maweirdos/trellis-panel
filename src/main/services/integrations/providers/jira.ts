import { jiraComment, jiraSearchPaged, jiraTransitions, jiraTransitionVerified } from '../../jira'
import { jiraConfig } from '../legacy'
import { jiraOptions } from './jira-auth'
import { IntegrationError, type TaskSourcePort } from '../types'

/** Reuses the Server 8.1 REST v2/recovery implementation; no replacement Cloud SDK. */
export const jiraSourcePort: TaskSourcePort = {
  async search(connection, query, signal) {
    const result = await jiraSearchPaged(jiraConfig(connection), { jql: query, maxPages: 20, ...jiraOptions(connection, signal) })
    if (!result.ok) throw new IntegrationError('Jira 查询失败，请检查查询条件、连接和权限', 'upstream')
    return { issues: result.issues, meta: result.meta, total: result.meta.serverTotal ?? result.issues.length }
  },
  async transitions(connection, key) {
    const result = await jiraTransitions(jiraConfig(connection), key, jiraOptions(connection))
    if (!result.ok) throw new IntegrationError('无法读取此工单的可用流转', 'upstream')
    return result.transitions ?? []
  },
  async transition(connection, key, id, expectedStatus) {
    const result = await jiraTransitionVerified(jiraConfig(connection), key, id, { expectedToStatus: expectedStatus, ...jiraOptions(connection) })
    if (!result.ok && result.code !== 'uncertain' && result.code !== 'offline') throw new IntegrationError(result.error || 'Jira 未执行流转，请检查认证和权限', 'denied')
    if (!result.ok || result.statusMismatch || result.verified === 'service_only') throw new IntegrationError('Jira 流转结果尚未核实，请刷新工单后确认，勿直接重复提交', 'uncertain')
    return { detail: result.status || '已核实状态流转' }
  },
  async comment(connection, key, body) {
    const result = await jiraComment(jiraConfig(connection), key, body, jiraOptions(connection))
    if (!result.ok) throw new IntegrationError(result.uncertain ? '评论提交结果未知，请到 Jira 核实后再决定是否重试' : result.error || 'Jira 拒绝了评论请求，请检查认证和权限', result.uncertain ? 'uncertain' : 'denied')
    return null
  }
}
