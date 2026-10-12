import { createHash } from 'node:crypto'

/**
 * Jira 实例稳定 ID（electron-free：LocalTaskService 及其冒烟可直接引用，
 * 不把 jira.ts 的 safeStorage 依赖拖进 local-task 打包边界）。
 */
export function jiraInstanceIdFor(baseUrl: string, user: string): string {
  const normalized = String(baseUrl ?? '').trim().replace(/\/+$/, '').toLowerCase()
  return 'jira-' + createHash('sha256').update(`${normalized}\n${String(user ?? '').trim()}`).digest('hex').slice(0, 16)
}
