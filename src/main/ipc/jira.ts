import { ipcInvoke } from '../../shared/ipc-channels'
import type { JiraConfig } from '../../shared/types'
import { jiraTest, jiraSearch, jiraSearchPaged, jiraTransitions, jiraTransition, jiraComment } from '../services/jira'
import { emitTrellisTimeline } from '../services/acp'
import { getProjectRoot } from '../state'
import { handle } from './registry'

export function registerJiraIpc(): void {
  handle(ipcInvoke.jira.test, (_e, cfg: JiraConfig) => jiraTest(cfg))
  handle(ipcInvoke.jira.search, (_e, cfg: JiraConfig, jql: string) => jiraSearch(cfg, jql))
  /**
   * G4 第二片：Jira 页查询走分页服务（design §7.1）——逐页收集、issueId 去重、
   * 完整字段（description/updatedAtMs 供本地任务创建消费）。样本/不完整不是失败：
   * meta.sample 如实带回，由 UI 标注，不伪装完整（未取全 ≠ 查询失败）。
   */
  handle(ipcInvoke.jira.searchPaged, async (_e, cfg: JiraConfig, jql: string, opts?: { maxPages?: number }) => {
    const rawMax = opts?.maxPages
    const maxPages = typeof rawMax === 'number' && Number.isSafeInteger(rawMax) && rawMax > 0 ? rawMax : undefined
    const res = await jiraSearchPaged(cfg, { jql, maxPages })
    if (!res.ok) return { ok: false, error: res.error }
    return {
      ok: true as const,
      issues: res.issues,
      total: res.meta.serverTotal ?? res.issues.length,
      meta: res.meta
    }
  })
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
