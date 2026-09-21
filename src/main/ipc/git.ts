import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { isGitRepo, taskGitInfo } from '../services/git'
import { createBranch } from '../services/git'
import { getProjectRoot, findTask } from '../state'
import { handle } from './registry'

export function registerGitIpc(): void {
  handle(ipcInvoke.git.taskInfo, (_e, dirName: string) => {
    const root = getProjectRoot()
    if (!root || !isGitRepo(root)) {
      return { dirName, branchExists: false, currentBranch: null, ahead: 0, behind: 0, merged: false, commits: [], worktreeDirty: false, error: '项目不是 git 仓库' }
    }
    const t = findTask(dirName)
    if (!t) {
      return { dirName, branchExists: false, currentBranch: null, ahead: 0, behind: 0, merged: false, commits: [], worktreeDirty: false, error: '任务不存在' }
    }
    return taskGitInfo(root, dirName, t.record?.branch ?? null, t.record?.base_branch ?? null)
  })

  handle(ipcInvoke.git.createBranch, async (_e, name: string, fromBase: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const res = await createBranch(root, name, fromBase)
    if (!res.ok) return ipcFail(IpcErrorCode.Io, res.error ?? '创建分支失败')
    return res
  })
}
