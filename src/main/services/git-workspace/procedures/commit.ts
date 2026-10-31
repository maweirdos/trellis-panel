import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitWorkspaceCommitSchema, GIT_WORKSPACE_LIMITS, type GitWorkspaceMutationResult, type GitWorkspaceReview } from '../../../../shared/git-workspace'
import { IpcErrorCode } from '../../../../shared/ipc-errors'
import { GitWorkspaceError, workspaceFailure, type GitWorkspaceOperationOptions, type GitWorkspaceProcedureContext } from '../types'
import { parse, checkScope, guardContext, indexTransaction } from '../lib/helpers'
import { runGit } from '../lib/git'
import { readSnapshotFile } from '../lib/state'

export async function commit(context: GitWorkspaceProcedureContext, root: string, input: unknown, options: GitWorkspaceOperationOptions): Promise<GitWorkspaceMutationResult> {
  try {
    const request = parse(gitWorkspaceCommitSchema, input)
    if (Buffer.byteLength(request.message) > GIT_WORKSPACE_LIMITS.messageBytes) throw new GitWorkspaceError(IpcErrorCode.InvalidArg, '提交说明超过大小限制')
    const selectedRoot = checkScope(root, request.expectedRoot)
    return await context.enqueue(selectedRoot, async () => {
      let state = await context.checked(selectedRoot, request.revision, options)
      if (!state.snapshot.staged.length) throw new GitWorkspaceError(IpcErrorCode.InvalidArg, '暂存区没有可提交的更改')
      const preview: GitWorkspaceReview = { kind: 'commit', root: selectedRoot, revision: request.revision, branch: state.snapshot.branch, paths: state.snapshot.staged.map((item) => item.path), message: request.message }
      if (!options.review || !await options.review(preview)) throw new GitWorkspaceError(IpcErrorCode.Denied, '已取消提交')
      state = await context.checked(selectedRoot, request.revision, options)
      const transaction = indexTransaction(state)
      let committed: string | undefined
      let preserve = false
      try {
        const gitOptions = { indexFile: transaction.indexFile }
        const messageFile = join(transaction.directory, 'message')
        writeFileSync(messageFile, request.message + '\n', { mode: 0o600 })
        const tree = (await runGit(state.snapshot.repoRoot, ['write-tree'], gitOptions)).stdout.trim()
        // Run native repository hooks against the reviewed private index, then verify
        // they did not stage unreviewed content before publishing the commit by CAS.
        for (const [hook, args] of [['pre-commit', []], ['prepare-commit-msg', [messageFile, 'message']], ['commit-msg', [messageFile]]] as const) {
          await guardContext(options)
          await runGit(state.snapshot.repoRoot, ['hook', 'run', '--ignore-missing', hook, '--', ...args], gitOptions)
        }
        if ((await runGit(state.snapshot.repoRoot, ['write-tree'], gitOptions)).stdout.trim() !== tree || readSnapshotFile(messageFile, GIT_WORKSPACE_LIMITS.messageBytes + 1).toString('utf8') !== request.message + '\n') throw new GitWorkspaceError(IpcErrorCode.Conflict, '仓库钩子修改了暂存内容或提交说明，请检查文件后重新确认')
        await context.checked(selectedRoot, request.revision, options)
        await guardContext(options)
        const sign = await runGit(state.snapshot.repoRoot, ['config', '--bool', '--get', 'commit.gpgsign'], { allowFailure: true })
        if (sign.code !== 0 && sign.code !== 1) throw new GitWorkspaceError(IpcErrorCode.InvalidArg, '提交签名配置无效，请检查 Git commit.gpgsign 配置')
        const created = await runGit(state.snapshot.repoRoot, ['commit-tree', ...(sign.stdout.trim() === 'true' ? ['-S'] : []), tree, ...(state.snapshot.head ? ['-p', state.snapshot.head] : []), '-F', messageFile], gitOptions)
        const candidate = created.stdout.trim()
        if (!/^[a-f0-9]{40,64}$/.test(candidate)) throw new GitWorkspaceError(IpcErrorCode.Io, '未取得有效的提交标识')
        await context.checked(selectedRoot, request.revision, options)
        await guardContext(options)
        await runGit(state.snapshot.repoRoot, ['update-ref', ...(state.headRef ? [] : ['--no-deref']), '-m', `commit${state.snapshot.unborn ? ' (initial)' : ''}: ${request.message.split('\n')[0]}`, state.headRef ?? 'HEAD', candidate, state.snapshot.head ?? state.objectZero])
        committed = candidate
        const reference = await runGit(state.snapshot.repoRoot, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true })
        if ((reference.code === 0 ? reference.stdout.trim() : null) !== state.headRef) throw new GitWorkspaceError(IpcErrorCode.Conflict, '提交已创建，但当前分支被其他程序切换，请核验工作区', { mutationCompleted: true, committed })
        try { await guardContext(options); await runGit(state.snapshot.repoRoot, ['hook', 'run', '--ignore-missing', 'post-commit'], gitOptions) }
        catch (error) {
          const completed = new GitWorkspaceError(IpcErrorCode.Io, '提交已创建，但提交后钩子失败，请核验后再操作', { mutationCompleted: true, committed, ...(error instanceof GitWorkspaceError ? error.extra : {}) })
          if (error instanceof GitWorkspaceError) completed.retainIndexLock = error.retainIndexLock
          throw completed
        }
      } catch (error) {
        preserve = error instanceof GitWorkspaceError && error.retainIndexLock
        if (committed && error instanceof GitWorkspaceError) error.extra = { ...error.extra, mutationCompleted: true, committed }
        throw error
      } finally { transaction.close(preserve) }
      return context.success(selectedRoot, '已提交经过确认的暂存内容', committed)
    })
  } catch (error) { return workspaceFailure(error, root) }
}
