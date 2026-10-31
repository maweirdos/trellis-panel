import { dialog } from 'electron'
import { z } from 'zod'
import {
  gitWorkspaceCommitSchema, gitWorkspaceCreateBranchSchema, gitWorkspaceDiffSchema, gitWorkspacePathsSchema,
  gitWorkspacePushSchema, gitWorkspaceStatusSchema, gitWorkspaceSwitchBranchSchema,
  type GitWorkspaceMutationResult, type GitWorkspaceReview
} from '../../shared/git-workspace'
import { IpcErrorCode, ipcFail, noProject, type IpcFail } from '../../shared/ipc-errors'
import { ipcInvoke } from '../../shared/ipc-channels'
import { getProjectGeneration, getProjectRoot } from '../state'
import { canonicalDirectory } from '../services/acp/metadata'
import { accessEventLog } from '../services/access/event-log'
import { clearGitCache } from '../services/git'
import { gitWorkspace } from '../services/git-workspace'
import { gitReadonlyFileDiff } from '../services/devtools-git'
import type { WindowDeps } from './deps'
import { handle } from './registry'
import type { HifoxDevelopmentTarget } from '../../shared/hifox-work'
import type { HifoxTaskWorkspaceService } from '../services/hifox/task-workspace'
import { hifoxWorkspaceGeneration } from '../services/hifox/connection-service'
import { codeRepositoryIdentity } from '../../shared/code-repository-identity'

interface MutationContext {
  guard(): boolean
  review(input: GitWorkspaceReview): Promise<boolean>
  validateContext?(): Promise<void>
  taskKey?: string
}

function capturedRoot(expectedRoot: string): { root: string; generation: number } | IpcFail {
  const root = getProjectRoot()
  if (!root) return noProject()
  if (canonicalDirectory(expectedRoot) !== canonicalDirectory(root)) return ipcFail(IpcErrorCode.Conflict, '项目已经切换，请刷新 Git 状态后重试')
  return { root, generation: getProjectGeneration() }
}

export function registerGitWorkspaceIpc(deps: WindowDeps & { resolveTaskContext?: HifoxTaskWorkspaceService['resolveContext'] }): void {
  handle(ipcInvoke.gitWorkspace.status, async (_event, input: unknown) => {
    const parsed = gitWorkspaceStatusSchema.safeParse(input)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '需要有效的项目范围')
    const scope = capturedRoot(parsed.data.expectedRoot)
    if ('ok' in scope) return scope
    try { return await gitWorkspace.status(scope.root) }
    catch { return ipcFail(IpcErrorCode.Io, '无法读取 Git 状态，请刷新后重试') }
  })

  handle(ipcInvoke.gitWorkspace.diff, async (_event, input: unknown) => {
    const parsed = gitWorkspaceDiffSchema.safeParse(input)
    if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '差异请求无效')
    const scope = capturedRoot(parsed.data.expectedRoot)
    if ('ok' in scope) return scope
    try {
      const status = await gitWorkspace.status(scope.root)
      if (status.ok === false) return status
      const result = await gitReadonlyFileDiff(status.snapshot.repoRoot, parsed.data.path, parsed.data.staged)
      if (getProjectGeneration() !== scope.generation) return ipcFail(IpcErrorCode.Conflict, '项目已经切换，请重新选择差异')
      if (result.ok === false) return ipcFail(IpcErrorCode.Io, result.error ?? '无法读取文件差异')
      return { ...result, ok: true as const, root: status.root }
    } catch { return ipcFail(IpcErrorCode.Io, '无法读取文件差异，请刷新后重试') }
  })

  function mutation<T extends { expectedRoot: string; taskContext?: HifoxDevelopmentTarget }>(
    operation: Exclude<keyof typeof ipcInvoke.gitWorkspace, 'status' | 'diff'>,
    schema: z.ZodType<T>,
    execute: (root: string, input: T, context: MutationContext) => Promise<GitWorkspaceMutationResult>
  ): void {
    handle(ipcInvoke.gitWorkspace[operation], async (event, input: unknown) => {
      const parsed = schema.safeParse(input)
      if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, 'Git 操作参数无效，请检查选择和确认状态')
      const scope = capturedRoot(parsed.data.expectedRoot)
      if ('ok' in scope) return scope
      const target = parsed.data.taskContext
      let authorization: Awaited<ReturnType<HifoxTaskWorkspaceService['resolveContext']>> | undefined
      const validateContext = async (): Promise<void> => {
        if (!target) return
        if (!deps.resolveTaskContext) throw new Error('当前宿主不支持固定任务开发上下文')
        const current = await deps.resolveTaskContext({ workspaceKey: target.workspaceKey, taskId: target.taskId }, target.expected)
        if (canonicalDirectory(current.local.projectRoot) !== canonicalDirectory(scope.root) || authorization && (current.authority !== authorization.authority || current.selectionGeneration !== authorization.selectionGeneration)) throw new Error('原任务开发目标或授权代次已变化')
        authorization = current
      }
      try { await validateContext() }
      catch (error) { return ipcFail(IpcErrorCode.Conflict, error instanceof Error ? error.message : '原任务开发环境尚未核实，请返回任务核对') }
      const guard = (): boolean => {
        const root = getProjectRoot()
        return deps.getMain()?.webContents.id === event.sender.id && event.senderFrame === event.sender.mainFrame && root !== null &&
          getProjectGeneration() === scope.generation && canonicalDirectory(root) === canonicalDirectory(scope.root) &&
          (!authorization || authorization.selectionGeneration === undefined || authorization.selectionGeneration === hifoxWorkspaceGeneration())
      }
      if (!guard()) return ipcFail(IpcErrorCode.Denied, '请在当前项目的主窗口手动执行 Git 操作')
      const review = async (request: GitWorkspaceReview): Promise<boolean> => {
        const window = deps.getMain()
        if (!window || !guard() || canonicalDirectory(request.root) !== canonicalDirectory(scope.root)) return false
        const committing = request.kind === 'commit'
        const differentRepository = !committing && authorization?.repositoryUrl && codeRepositoryIdentity(request.remoteUrl ?? '') !== codeRepositoryIdentity(authorization.repositoryUrl)
        const details = [
          target ? `任务：${target.taskId}` : '来源：独立工程操作',
          authorization?.repositoryUrl ? `任务代码资源：${authorization.repositoryUrl}` : '',
          differentRepository ? '本次推送目标与任务代码资源不同或无法核对；请确认 fork/远端用途。此操作不会更改任务的资源绑定。' : '',
          `项目：${scope.root}`,
          `分支：${request.branch ?? '分离 HEAD'}`,
          committing ? `暂存文件：${request.paths.length} 个` : `远端：${request.remote ?? ''}`,
          committing ? request.paths.slice(0, 30).join('\n') : `目标分支：${request.remoteBranch ?? ''}`,
          committing && request.paths.length > 30 ? `另有 ${request.paths.length - 30} 个文件` : '',
          request.message ? `提交说明：\n${request.message.slice(0, 2000)}` : '',
          request.remoteUrl ? `地址：${request.remoteUrl}` : ''
        ].filter(Boolean).join('\n')
        const result = await dialog.showMessageBox(window, {
          type: differentRepository ? 'warning' : 'question', title: committing ? '确认提交' : differentRepository ? '核对不同仓库的推送目标' : '确认推送',
          message: committing ? '提交已检查的暂存区更改？' : differentRepository ? '确认向任务基座之外的目标推送？' : '推送到此远端分支？', detail: details,
          buttons: ['取消', committing ? '提交暂存更改' : differentRepository ? '核对目标并推送' : '推送'], defaultId: 0, cancelId: 0, noLink: true
        })
        if (result.response !== 1 || !guard()) return false
        try { await validateContext(); return guard() } catch { return false }
      }
      try {
        const taskKey = target && authorization ? authorization.taskKey : undefined
        const result = await execute(scope.root, parsed.data, { guard, review, ...(target ? { validateContext, taskKey } : {}) })
        if (result.ok === true) clearGitCache()
        accessEventLog.append('git.workspaceMutation', { root: scope.root, operation, ok: result.ok })
        return result
      } catch {
        return ipcFail(IpcErrorCode.Io, '无法确认 Git 操作结果，请刷新查看仓库状态')
      }
    })
  }

  mutation('stage', gitWorkspacePathsSchema, (root, input, context) => gitWorkspace.stage(root, input, context))
  mutation('unstage', gitWorkspacePathsSchema, (root, input, context) => gitWorkspace.unstage(root, input, context))
  mutation('commit', gitWorkspaceCommitSchema, (root, input, context) => gitWorkspace.commit(root, input, context))
  mutation('createBranch', gitWorkspaceCreateBranchSchema, (root, input, context) => gitWorkspace.createBranch(root, input, context))
  mutation('switchBranch', gitWorkspaceSwitchBranchSchema, (root, input, context) => gitWorkspace.switchBranch(root, input, context))
  mutation('push', gitWorkspacePushSchema, (root, input, context) => gitWorkspace.push(root, input, context))
}
