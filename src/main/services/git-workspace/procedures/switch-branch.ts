import { gitWorkspaceSwitchBranchSchema, type GitWorkspaceMutationResult } from '../../../../shared/git-workspace'
import { IpcErrorCode } from '../../../../shared/ipc-errors'
import { GitWorkspaceError, workspaceFailure, type GitWorkspaceOperationOptions, type GitWorkspaceProcedureContext } from '../types'
import { parse, checkScope, guardContext, validBranch, assertSwitchable } from '../lib/helpers'
import { runGit } from '../lib/git'
import { repositoryState } from '../lib/state'

export async function switchBranch(context: GitWorkspaceProcedureContext, root: string, input: unknown, options: GitWorkspaceOperationOptions): Promise<GitWorkspaceMutationResult> {
  try {
    const request = parse(gitWorkspaceSwitchBranchSchema, input)
    const selectedRoot = checkScope(root, request.expectedRoot)
    return await context.enqueue(selectedRoot, async () => {
      const state = await context.checked(selectedRoot, request.revision, options)
      await validBranch(state.snapshot.repoRoot, request.name)
      if (!state.snapshot.branches.some((branch) => branch.name === request.name)) throw new GitWorkspaceError(IpcErrorCode.NotFound, '目标本地分支不存在，请刷新分支列表')
      assertSwitchable(state)
      if (!state.snapshot.clean) throw new GitWorkspaceError(IpcErrorCode.Conflict, '工作区存在更改，未切换分支；请先提交或处理这些更改')
      await guardContext(options)
      try {
        await runGit(state.snapshot.repoRoot, ['switch', '--no-guess', '--', request.name], { config: ['submodule.recurse=false'] })
      } catch (error) {
        if (error instanceof GitWorkspaceError) {
          // post-checkout may fail after Git has already changed HEAD and working files.
          try {
            const current = await repositoryState(selectedRoot)
            if (current.snapshot.branch === request.name && current.headRef !== state.headRef) {
              error.extra = { ...error.extra, mutationCompleted: true }
              error.message = `分支已切换，但后续处理失败：${error.message}`
            }
          } catch { error.extra = { ...error.extra, uncertain: true } }
        }
        throw error
      }
      return context.success(selectedRoot, '已切换分支')
    })
  } catch (error) { return workspaceFailure(error, root) }
}
