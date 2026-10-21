import { resolve } from 'node:path'
import { statSync } from 'node:fs'
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
  private context: GitWorkspaceProcedureContext = {
    enqueue: <T>(root: string, operation: () => Promise<T>) => this.enqueue(root, operation),
    checked: (root, revision, options) => this.checked(root, revision, options),
    success: (root, message, committed) => this.success(root, message, committed)
  }

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
    return stage(this.context, root, input, options)
  }
  unstage(root: string, input: unknown, options: GitWorkspaceOperationOptions = {}): Promise<GitWorkspaceMutationResult> {
    return unstage(this.context, root, input, options)
  }
  commit(root: string, input: unknown, options: GitWorkspaceOperationOptions = {}): Promise<GitWorkspaceMutationResult> {
    return commit(this.context, root, input, options)
  }
  createBranch(root: string, input: unknown, options: GitWorkspaceOperationOptions = {}): Promise<GitWorkspaceMutationResult> {
    return createBranch(this.context, root, input, options)
  }
  switchBranch(root: string, input: unknown, options: GitWorkspaceOperationOptions = {}): Promise<GitWorkspaceMutationResult> {
    return switchBranch(this.context, root, input, options)
  }
  push(root: string, input: unknown, options: GitWorkspaceOperationOptions = {}): Promise<GitWorkspaceMutationResult> {
    return push(this.context, root, input, options)
  }
}
