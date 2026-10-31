import { resolve } from 'node:path'
import { statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { gitWorkspaceCreateBranchSchema } from '../../../../shared/git-workspace'
import type { WorkcopyUseKind } from '../../../../shared/workcopy-use'
import { acquireWorkcopyUse, releaseWorkcopyUse } from '../../workcopy-use/client'
import { resolveWorkcopy, assertWorkcopyObservation } from '../../workcopy-use'
import { DaemonError } from '../../../daemon/errors'
import { withWorkcopyCommandScope } from '../../workcopy-use/command-scope'
import { cleanupNativeWorkcopyCommands } from '../../workcopy-use/native-command'
import type { GitWorkspaceMutationResult, GitWorkspaceStatusResult } from '../../../../shared/git-workspace'
import { IpcErrorCode } from '../../../../shared/ipc-errors'
import { GitWorkspaceError, type GitWorkspaceOperationOptions, type GitWorkspaceProcedureContext, type RepositoryState } from '../types'
import { guard, assertWritable } from './helpers'
import { canonicalDirectory, repositoryState } from './state'
import { runGit } from './git'
import { status } from '../procedures/status'
import { stage } from '../procedures/stage'
import { unstage } from '../procedures/unstage'
import { commit } from '../procedures/commit'
import { createBranch } from '../procedures/create-branch'
import { switchBranch } from '../procedures/switch-branch'
import { push } from '../procedures/push'

export class GitWorkspaceService {
  private queues = new Map<string, Promise<unknown>>()
  private context(kind: WorkcopyUseKind, options: GitWorkspaceOperationOptions): GitWorkspaceProcedureContext { return {
    enqueue: <T>(root: string, operation: () => Promise<T>) => this.enqueue(root, async () => {
      await options.validateContext?.()
      guard(options)
      const identity = resolveWorkcopy(root)
      const generation = randomUUID()
      const lease = await acquireWorkcopyUse(root, { kind, owner: { kind: 'git', id: generation, generation, label: kind === 'tree-change' ? 'Git 切换工作树' : 'Git 写入', taskKey: options.taskKey }, expected: identity })
        .catch((error: unknown) => { throw new GitWorkspaceError(error instanceof DaemonError ? error.code : IpcErrorCode.Io, error instanceof Error ? error.message : '工作副本准入未确认') })
      let uncertain = false
      let completed = false
      let failure: unknown
      try {
        await options.validateContext?.()
        guard(options)
        assertWorkcopyObservation(resolveWorkcopy(root), identity)
        const value = await withWorkcopyCommandScope(root, lease, operation)
        completed = true
        return value
      } catch (error) {
        failure = error
        uncertain = error instanceof GitWorkspaceError && error.retainIndexLock
        if (error instanceof Error && !(error instanceof GitWorkspaceError)) throw new GitWorkspaceError(IpcErrorCode.Conflict, error.message)
        throw error
      } finally {
        try { if (!await cleanupNativeWorkcopyCommands(lease)) uncertain = true }
        catch { uncertain = true }
        if (uncertain && failure instanceof GitWorkspaceError) failure.extra = { ...failure.extra, uncertain: true }
        try { await releaseWorkcopyUse(root, lease, uncertain ? 'unknown' : 'settled', uncertain ? '原 Git 调用或子进程清理尚未确认，请核对原操作。' : undefined) }
        catch {
          if (failure instanceof GitWorkspaceError) { failure.extra = { ...failure.extra, uncertain: true }; failure.message += '；工作副本占用释放未确认' }
          else throw new GitWorkspaceError(IpcErrorCode.Conflict, '工作副本占用释放未确认，请核对原 Git 操作', { uncertain: true, ...(completed ? { mutationCompleted: true } : {}) })
        }
        if (uncertain && completed) throw new GitWorkspaceError(IpcErrorCode.Conflict, 'Git 操作已返回，但原操作的子进程清理尚未确认，请核对原操作', { uncertain: true, mutationCompleted: true })
      }
    }),
    checked: (root, revision, options) => this.checked(root, revision, options),
    success: (root, message, committed) => this.success(root, message, committed)
  } }

  private async enqueue<T>(root: string, fn: () => Promise<T>): Promise<T> {
    // Linked worktrees and project subdirectories must share the ref-operation queue.
    const common = await runGit(root, ['rev-parse', '--git-common-dir'])
    const location = canonicalDirectory(resolve(root, common.stdout.trim()))
    const identity = statSync(location)
    const key = `${identity.dev}:${identity.ino}`
    const previous = this.queues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(fn)
    this.queues.set(key, current)
    void current.finally(() => { if (this.queues.get(key) === current) this.queues.delete(key) }).catch(() => undefined)
    return current
  }
  private async checked(root: string, revision: string, options: GitWorkspaceOperationOptions): Promise<RepositoryState> {
    guard(options)
    await options.validateContext?.()
    const state = await repositoryState(root)
    guard(options)
    if (state.snapshot.revision !== revision) throw new GitWorkspaceError(IpcErrorCode.Conflict, 'Git 状态已经变化，请刷新并重新确认操作')
    assertWritable(state)
    return state
  }
  private async success(root: string, message: string, committed?: string): Promise<GitWorkspaceMutationResult> {
    try { return { ok: true, root, snapshot: (await repositoryState(root)).snapshot, message, ...(committed ? { committed } : {}) } }
    catch { throw new GitWorkspaceError(IpcErrorCode.Io, '操作已完成，但状态刷新失败，请手动刷新核验', { mutationCompleted: true, ...(committed ? { committed } : {}) }) }
  }
  status(root: string, input?: unknown): Promise<GitWorkspaceStatusResult> {
    return status(root, input)
  }
  stage(root: string, input: unknown, options: GitWorkspaceOperationOptions = {}): Promise<GitWorkspaceMutationResult> {
    return stage(this.context('git-mutation', options), root, input, options)
  }
  unstage(root: string, input: unknown, options: GitWorkspaceOperationOptions = {}): Promise<GitWorkspaceMutationResult> {
    return unstage(this.context('git-mutation', options), root, input, options)
  }
  commit(root: string, input: unknown, options: GitWorkspaceOperationOptions = {}): Promise<GitWorkspaceMutationResult> {
    return commit(this.context('git-mutation', options), root, input, options)
  }
  createBranch(root: string, input: unknown, options: GitWorkspaceOperationOptions = {}): Promise<GitWorkspaceMutationResult> {
    const request = gitWorkspaceCreateBranchSchema.safeParse(input)
    return createBranch(this.context(request.success && request.data.switchAfter ? 'tree-change' : 'git-mutation', options), root, input, options)
  }
  switchBranch(root: string, input: unknown, options: GitWorkspaceOperationOptions = {}): Promise<GitWorkspaceMutationResult> {
    return switchBranch(this.context('tree-change', options), root, input, options)
  }
  push(root: string, input: unknown, options: GitWorkspaceOperationOptions = {}): Promise<GitWorkspaceMutationResult> {
    return push(this.context('git-mutation', options), root, input, options)
  }
}
