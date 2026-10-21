import { gitWorkspacePushSchema, type GitWorkspaceMutationResult } from '../../../../shared/git-workspace'
import { IpcErrorCode } from '../../../../shared/ipc-errors'
import { GitWorkspaceError, workspaceFailure, type GitWorkspaceOperationOptions, type GitWorkspaceProcedureContext } from '../types'
import { parse, checkScope, guard, validBranch } from '../lib/helpers'
import { runGit, redactGitText } from '../lib/git'

export async function push(context: GitWorkspaceProcedureContext, root: string, input: unknown, options: GitWorkspaceOperationOptions): Promise<GitWorkspaceMutationResult> {
  try {
    const request = parse(gitWorkspacePushSchema, input)
    const selectedRoot = checkScope(root, request.expectedRoot)
    return await context.enqueue(selectedRoot, async () => {
      let state = await context.checked(selectedRoot, request.revision, options)
      if (!state.snapshot.head || !state.snapshot.branch || state.snapshot.branch !== request.branch) throw new GitWorkspaceError(IpcErrorCode.Conflict, '仅推送当前有提交的本地分支，请刷新后重试')
      await validBranch(state.snapshot.repoRoot, request.remoteBranch)
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,249}$/.test(request.remote)) throw new GitWorkspaceError(IpcErrorCode.InvalidArg, '远端名称无效')
      const remote = state.snapshot.remotes.find((item) => item.name === request.remote)
      if (!remote) throw new GitWorkspaceError(IpcErrorCode.NotFound, '请选择已经配置的远端')
      const urls = (await runGit(state.snapshot.repoRoot, ['remote', 'get-url', '--push', '--all', request.remote])).stdout.trim().split(/\r?\n/)
      if (urls.length !== 1 || /^ext::/i.test(urls[0])) throw new GitWorkspaceError(IpcErrorCode.Denied, '不通过面板推送到多个地址或可执行传输，请使用独立 Git 工具核验')
      if (!options.review || !await options.review({ kind: 'push', root: selectedRoot, revision: request.revision, branch: request.branch, paths: [], remote: request.remote, remoteBranch: request.remoteBranch, remoteUrl: redactGitText(urls[0]) })) throw new GitWorkspaceError(IpcErrorCode.Denied, '已取消推送')
      state = await context.checked(selectedRoot, request.revision, options)
      guard(options)
      const result = await runGit(state.snapshot.repoRoot, ['push', '--porcelain', '--', request.remote, `${state.snapshot.head}:refs/heads/${request.remoteBranch}`], { network: true, allowFailure: true, config: ['push.followTags=false', 'push.recurseSubmodules=no', `remote.${request.remote}.mirror=false`] })
      if (/\[(?:rejected|remote rejected)\]/.test(result.stdout)) throw new GitWorkspaceError(IpcErrorCode.Conflict, '远端拒绝推送，请核对远端分支；不会自动强推')
      if (result.code !== 0) throw new GitWorkspaceError(IpcErrorCode.Io, result.stderr.trim() || '推送失败，请核验远端后重试', { uncertain: true })
      if (request.setUpstream) {
        try {
          guard(options)
          await runGit(state.snapshot.repoRoot, ['config', '--local', `branch.${request.branch}.remote`, request.remote])
          await runGit(state.snapshot.repoRoot, ['config', '--local', `branch.${request.branch}.merge`, `refs/heads/${request.remoteBranch}`])
        } catch { throw new GitWorkspaceError(IpcErrorCode.Io, '推送已完成，但上游设置未完成，请核验后重试设置', { mutationCompleted: true }) }
      }
      return context.success(selectedRoot, '普通推送已完成')
    })
  } catch (error) { return workspaceFailure(error, root) }
}
