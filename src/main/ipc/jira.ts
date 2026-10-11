import { ipcInvoke } from '../../shared/ipc-channels'
import type { JiraConfig } from '../../shared/types'
import { jiraTest, jiraSearch, jiraTransitions, jiraTransition, jiraComment } from '../services/jira'
import { emitTrellisTimeline } from '../services/acp'
import { getProjectRoot } from '../state'
import { handle } from './registry'

export function registerJiraIpc(): void {
  handle(ipcInvoke.jira.test, (_e, cfg: JiraConfig) => jiraTest(cfg))
  handle(ipcInvoke.jira.search, (_e, cfg: JiraConfig, jql: string) => jiraSearch(cfg, jql))
  handle(ipcInvoke.jira.transitions, (_e, cfg: JiraConfig, key: string) => jiraTransitions(cfg, key))
  handle(ipcInvoke.jira.transition, (_e, cfg: JiraConfig, key: string, tid: string) =>
    jiraTransition(cfg, key, tid).then((res) => {
      // ACP trellis 轨道：面板第一方 Jira 动作进会话时间线（失败不进）
      if (res.ok) {
        const root = getProjectRoot()
        if (root) emitTrellisTimeline(root, 'jira-sync', `Jira 流转：${key}`, { key, transitionId: tid })
      }
      return res
    })
  )
  handle(ipcInvoke.jira.comment, (_e, cfg: JiraConfig, key: string, body: string) =>
    jiraComment(cfg, key, body).then((res) => {
      if (res.ok) {
        const root = getProjectRoot()
        if (root) emitTrellisTimeline(root, 'jira-sync', `Jira 评论已回写：${key}`, { key, comment: body.slice(0, 120) })
      }
      return res
    })
  )
}
