import { existsSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { gitWorkspacePathsSchema, type GitWorkspaceMutationResult } from '../../../../shared/git-workspace'
import { IpcErrorCode } from '../../../../shared/ipc-errors'
import { GitWorkspaceError, workspaceFailure, type GitWorkspaceOperationOptions, type GitWorkspaceProcedureContext } from '../types'
import { parse, checkScope, guard, indexTransaction } from './helpers'
import { validatePath } from './state'
import { runGit } from './git'

export async function mutatePaths(context: GitWorkspaceProcedureContext, root: string, input: unknown, unstage: boolean, options: GitWorkspaceOperationOptions): Promise<GitWorkspaceMutationResult> {
  try {
    const request = parse(gitWorkspacePathsSchema, input)
    const selectedRoot = checkScope(root, request.expectedRoot)
    return await context.enqueue(selectedRoot, async () => {
      const state = await context.checked(selectedRoot, request.revision, options)
      const changed = unstage ? state.snapshot.staged : [...state.snapshot.staged, ...state.snapshot.unstaged]
      const known = new Set(changed.flatMap((item) => [item.path, ...(item.origPath ? [item.origPath] : [])]).concat(unstage ? [] : state.snapshot.untracked))
      const paths = new Set<string>()
      for (const path of request.paths) {
        validatePath(state.snapshot.repoRoot, path)
        if (!known.has(path)) throw new GitWorkspaceError(IpcErrorCode.Conflict, '选择的文件已不在当前改动中，请刷新')
        paths.add(path)
        for (const item of changed) if ((item.path === path || item.origPath === path) && item.origPath && /R/.test(item.x + item.y)) { paths.add(item.path); paths.add(item.origPath) }
      }
      guard(options)
      const transaction = indexTransaction(state)
      let preserve = false
      try {
        if (!state.indexBytes) await runGit(state.snapshot.repoRoot, ['read-tree', '--empty'], { indexFile: transaction.indexFile })
        if (unstage) {
          if (state.snapshot.head) await runGit(state.snapshot.repoRoot, ['restore', '--staged', '--source', state.snapshot.head, '--', ...paths], { indexFile: transaction.indexFile })
          else await runGit(state.snapshot.repoRoot, ['update-index', '--force-remove', '--', ...paths], { indexFile: transaction.indexFile })
        } else {
          const ordinary: string[] = [], removals: string[] = []
          for (const path of paths) {
            const file = resolve(state.snapshot.repoRoot, path)
            const gitlink = state.indexEntries.split('\0').some((entry) => entry.startsWith('160000 ') && entry.endsWith('\t' + path))
            if (gitlink) throw new GitWorkspaceError(IpcErrorCode.Denied, '面板不代管子模块指针，请在独立 Git 工具中核验并暂存')
            if (existsSync(file) && lstatSync(file).isDirectory()) {
              if (state.snapshot.unstaged.some((item) => item.path === path && item.y === 'D')) removals.push(path)
              else throw new GitWorkspaceError(IpcErrorCode.InvalidArg, '请选择具体文件，不递归暂存整个目录')
            } else ordinary.push(path)
          }
          if (removals.length) await runGit(state.snapshot.repoRoot, ['update-index', '--force-remove', '--', ...removals], { indexFile: transaction.indexFile })
          if (ordinary.length) await runGit(state.snapshot.repoRoot, ['add', '--', ...ordinary], { indexFile: transaction.indexFile })
        }
        await context.checked(selectedRoot, request.revision, options)
        guard(options)
        transaction.publish()
      } catch (error) {
        preserve = error instanceof GitWorkspaceError && error.retainIndexLock
        throw error
      } finally { transaction.close(preserve) }
      return context.success(selectedRoot, unstage ? '已取消所选文件的暂存，工作文件保持不变' : '已暂存所选文件')
    })
  } catch (error) { return workspaceFailure(error, root) }
}
