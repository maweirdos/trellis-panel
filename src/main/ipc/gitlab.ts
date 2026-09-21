import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import type { GitLabConfig } from '../../shared/types'
import { gitlabTest, gitlabTaskStatus, gitlabCreateMr } from '../services/gitlab'
import { getSettings } from '../services/store'
import { findTask } from '../state'
import { handle } from './registry'

export function registerGitlabIpc(): void {
  handle(ipcInvoke.gitlab.test, (_e, cfg: GitLabConfig) => gitlabTest(cfg))

  handle(ipcInvoke.gitlab.taskStatus, (_e, dirName: string) => {
    const cfg = getSettings().gitlab
    const t = findTask(dirName)
    if (!t) return { ...ipcFail(IpcErrorCode.NotFound, `任务不存在: ${dirName}`), mr: null, pipeline: null }
    return gitlabTaskStatus(cfg, dirName, t.record?.branch ?? null, t.record?.base_branch ?? null)
  })

  handle(ipcInvoke.gitlab.createMr, (_e, dirName: string) => {
    const cfg = getSettings().gitlab
    const t = findTask(dirName)
    if (!t?.record?.branch) return ipcFail(IpcErrorCode.Denied, '任务没有关联分支——先在任务详情里创建分支')
    return gitlabCreateMr(cfg, {
      branch: t.record.branch,
      baseBranch: t.record.base_branch,
      title: `${dirName} ${t.record.title}`,
      description: t.record.description ? `> ${t.record.description.slice(0, 500)}` : ''
    })
  })
}
