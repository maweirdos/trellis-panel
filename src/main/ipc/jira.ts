import { ipcInvoke } from '../../shared/ipc-channels'
import type { JiraConfig } from '../../shared/types'
import { jiraTest, jiraSearch, jiraTransitions, jiraTransition, jiraComment } from '../services/jira'
import { handle } from './registry'

export function registerJiraIpc(): void {
  handle(ipcInvoke.jira.test, (_e, cfg: JiraConfig) => jiraTest(cfg))
  handle(ipcInvoke.jira.search, (_e, cfg: JiraConfig, jql: string) => jiraSearch(cfg, jql))
  handle(ipcInvoke.jira.transitions, (_e, cfg: JiraConfig, key: string) => jiraTransitions(cfg, key))
  handle(ipcInvoke.jira.transition, (_e, cfg: JiraConfig, key: string, tid: string) => jiraTransition(cfg, key, tid))
  handle(ipcInvoke.jira.comment, (_e, cfg: JiraConfig, key: string, body: string) => jiraComment(cfg, key, body))
}
