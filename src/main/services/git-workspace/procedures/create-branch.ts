import { gitWorkspaceCreateBranchSchema, type GitWorkspaceMutationResult } from '../../../../shared/git-workspace'
import { IpcErrorCode } from '../../../../shared/ipc-errors'
import { GitWorkspaceError, workspaceFailure, type GitWorkspaceOperationOptions, type GitWorkspaceProcedureContext } from '../types'
import { parse, checkScope, guardContext, validBranch, assertSwitchable } from '../lib/helpers'
import { runGit } from '../lib/git'
import { repositoryState } from '../lib/state'

export async function createBranch(context: GitWorkspaceProcedureContext, root: string, input: unknown, options: GitWorkspaceOperationOptions): Promise<GitWorkspaceMutationResult> {
  try {
    const request = parse(gitWorkspaceCreateBranchSchema, input)
    const selectedRoot = checkScope(root, request.expectedRoot)
    return await context.enqueue(selectedRoot, async () => {
      const state = await context.checked(selectedRoot, request.revision, options)
      if (!state.snapshot.head) throw new GitWorkspaceError(IpcErrorCode.Denied, '请先创建首次提交，再创建其他分支')
      await validBranch(state.snapshot.repoRoot, request.name)
      if (state.snapshot.branches.some((branch) => branch.name === request.name)) throw new GitWorkspaceError(IpcErrorCode.Conflict, '同名分支已存在')
      if (request.switchAfter) assertSwitchable(state)
      if (request.switchAfter && !state.snapshot.clean) throw new GitWorkspaceError(IpcErrorCode.Conflict, '请先提交或处理工作区更改，再创建并切换分支')
      await context.checked(selectedRoot, request.revision, options)
      await guardContext(options)
      await runGit(state.snapshot.repoRoot, ['branch', '--', request.name, state.snapshot.head])
      if (request.switchAfter) {
        try {
          await guardContext(options)
          const current = await repositoryState(selectedRoot)
          if (!current.snapshot.clean || current.snapshot.head !== state.snapshot.head || current.headRef !== state.headRef) throw new GitWorkspaceError(IpcErrorCode.Conflict, '工作区已变化')
          await guardContext(options)
          await runGit(state.snapshot.repoRoot, ['switch', '--no-guess', '--', request.name], { config: ['submodule.recurse=false'] })
        }
        catch (error) { throw new GitWorkspaceError(IpcErrorCode.Conflict, '分支已创建，但切换未确认完成，请刷新后核验', { ...(error instanceof GitWorkspaceError ? error.extra : {}), mutationCompleted: true }) }
      }
      return context.success(selectedRoot, request.switchAfter ? '已创建并切换分支' : '已创建分支')
    })
  } catch (error) { return workspaceFailure(error, root) }
}
