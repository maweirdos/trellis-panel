import { z } from 'zod'
import { closeSync, existsSync, mkdtempSync, openSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { IpcErrorCode } from '../../../../shared/ipc-errors'
import { GitWorkspaceError, type GitWorkspaceOperationOptions, type RepositoryState } from '../types'
import { canonicalDirectory, digest, readIndex, readSnapshotFile } from './state'
import { runGit } from './git'

export interface IndexTransaction { directory: string; indexFile: string; close(preserve?: boolean): void; publish(): void }

export function guard(options: GitWorkspaceOperationOptions): void {
  if (options.guard?.() === false || options.stillCurrent?.() === false) throw new GitWorkspaceError(IpcErrorCode.Conflict, '项目已切换，旧操作未执行，请在当前项目重试')
}
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new GitWorkspaceError(IpcErrorCode.InvalidArg, 'Git 参数无效，请检查选择、名称、说明与确认状态')
  return result.data
}
export function checkScope(root: string, expectedRoot: string): string {
  if (typeof root !== 'string' || !root.trim()) throw new GitWorkspaceError(IpcErrorCode.NoProject, '未打开项目')
  const canonical = canonicalDirectory(root)
  if (canonicalDirectory(expectedRoot) !== canonical) throw new GitWorkspaceError(IpcErrorCode.Conflict, '项目范围已变化，请刷新后重试')
  return canonical
}
export function assertWritable(state: RepositoryState): void {
  if (state.snapshot.operation || state.snapshot.conflicts) throw new GitWorkspaceError(IpcErrorCode.Conflict, '仓库有未完成的合并、变基或冲突，请先在 Git 工具中处理')
}
export function assertSwitchable(state: RepositoryState): void {
  if (state.indexEntries.split('\0').some((entry) => entry.startsWith('160000 '))) throw new GitWorkspaceError(IpcErrorCode.Denied, '仓库包含子模块，面板不代管其工作区状态，请使用独立 Git 工具切换分支')
}
export function indexTransaction(state: RepositoryState): IndexTransaction {
  const lock = state.indexPath + '.lock'
  let descriptor: number
  try { descriptor = openSync(lock, 'wx', 0o600) }
  catch { throw new GitWorkspaceError(IpcErrorCode.Conflict, 'Git 暂存区正被其他操作占用，请稍后刷新重试') }
  let directory: string | undefined
  let closed = false
  let ownsLock = true
  try {
    if (digest(readIndex(state.indexPath) ?? Buffer.alloc(0)) !== digest(state.indexBytes ?? Buffer.alloc(0))) throw new GitWorkspaceError(IpcErrorCode.Conflict, '暂存区已变化，请刷新后重试')
    directory = mkdtempSync(join(state.gitDirectory, 'tpanel-workspace-'))
    const indexFile = join(directory, 'index')
    if (state.indexBytes) writeFileSync(indexFile, state.indexBytes, { mode: 0o600 })
    const selectedDirectory = directory
    const close = (preserve = false): void => {
      if (!closed) { closeSync(descriptor); closed = true }
      if (preserve) return
      if (ownsLock && existsSync(lock)) { unlinkSync(lock); ownsLock = false }
      const exact = resolve(selectedDirectory)
      if (dirname(exact) !== resolve(state.gitDirectory) || !basename(exact).startsWith('tpanel-workspace-')) throw new GitWorkspaceError(IpcErrorCode.Io, '临时 Git 目录边界无效')
      rmSync(exact, { recursive: true, force: true })
    }
    return {
      directory: selectedDirectory, indexFile, close,
      publish(): void {
        if (digest(readIndex(state.indexPath) ?? Buffer.alloc(0)) !== digest(state.indexBytes ?? Buffer.alloc(0))) throw new GitWorkspaceError(IpcErrorCode.Conflict, '暂存区被其他程序修改，未覆盖其更改')
        writeFileSync(descriptor, readSnapshotFile(indexFile, 32 * 1024 * 1024))
        closeSync(descriptor); closed = true
        renameSync(lock, state.indexPath)
        ownsLock = false
      }
    }
  } catch (error) {
    closeSync(descriptor)
    if (existsSync(lock)) unlinkSync(lock)
    if (directory && dirname(resolve(directory)) === resolve(state.gitDirectory) && basename(directory).startsWith('tpanel-workspace-')) rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export async function validBranch(root: string, name: string): Promise<void> {
  if (/[\r\n\0]/.test(name) || name.startsWith('-')) throw new GitWorkspaceError(IpcErrorCode.InvalidArg, '分支名称无效')
  const result = await runGit(root, ['check-ref-format', '--branch', name], { allowFailure: true })
  if (result.code !== 0 || result.stdout.trim() !== name) throw new GitWorkspaceError(IpcErrorCode.InvalidArg, '分支名称无效')
}
