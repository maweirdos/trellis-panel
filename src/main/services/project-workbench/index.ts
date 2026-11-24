import { hostname } from 'node:os'
import type { ApplicationLaunchPreview } from '../../../shared/app-runtime'
import type { ConversationThreadSnapshot } from '../../../shared/conversation/command-runtime'
import type { ProjectWorkbenchGit, ProjectWorkbenchInput, ProjectWorkbenchProject, ProjectWorkbenchResult } from '../../../shared/conversation/project-workbench'
import type { GitWorkspaceMutationResult, GitWorkspaceReview } from '../../../shared/git-workspace'
import { IpcErrorCode, ipcFail, type IpcFail } from '../../../shared/ipc-errors'
import { DaemonError } from '../../daemon/errors'
import { appRuntime } from '../app-runtime'
import { clearGitCache } from '../git'
import { GitReadError } from '../git-readonly-reader'
import { gitWorkspace, type GitWorkspaceOperationOptions } from '../git-workspace'
import { FileSizeLimitError, directoryIdentity, pathKey } from '../private-conversations/files'
import { assertWorkbenchCheckpointRestore, boundWorkbenchRoot } from './checkpoint'
import { assertScriptDirectory, workbenchEditor, workbenchLaunch, workbenchLaunchTerminal, workbenchTerminal } from './desktop'
import { workbenchFile, workbenchFiles } from './files'
import { assertWorkbenchGitRoot, workbenchBranchStats, workbenchDiff, workbenchGitStatus, workbenchStats } from './git'
import { workbenchGitlab } from './gitlab'
import { WorkbenchError } from './errors'

type ThreadResponse = ({ ok: true } & ConversationThreadSnapshot) | IpcFail
interface WorkbenchPorts {
  root: string
  task: boolean
  isCurrent(): boolean
  canWrite(): boolean
  readThread(): Promise<ThreadResponse>
  confirm(title: string, message: string, detail: string, button: string): Promise<boolean>
  openPath(path: string): Promise<string>
  openExternal(url: string): Promise<void>
}

function codeFailure(code: string, message: string): IpcFail {
  return ipcFail(Object.values(IpcErrorCode).find(value => value === code) ?? IpcErrorCode.Io, message)
}

export function projectWorkbenchFailure(error: unknown): IpcFail & { outcome?: 'unknown' } {
  if (error instanceof DaemonError || error instanceof WorkbenchError) {
    const failure = codeFailure(error.code, error.message)
    return error.outcome === 'unknown' ? { ...failure, outcome: 'unknown' } : failure
  }
  if (error instanceof GitReadError) return codeFailure(error.code, 'Git 读取无法确认，请刷新原工作区。')
  if (error instanceof FileSizeLimitError) return ipcFail(IpcErrorCode.Unavailable, '文件超过预览安全上限。')
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return ipcFail(IpcErrorCode.NotFound, '找不到原工程资源。')
  if (code === 'EACCES' || code === 'EPERM') return ipcFail(IpcErrorCode.Denied, '无法访问原工程资源。')
  return ipcFail(IpcErrorCode.Io, '无法读取或核实原工程资源。')
}

const noCheckpoint = '原会话尚无已核实的原生回退与文件检查点。'
const readOnly = '仅已核实的当前 Code 工程可以执行此操作。'

export async function projectWorkbench(input: ProjectWorkbenchInput, ports: WorkbenchPorts): Promise<ProjectWorkbenchResult> {
  const projectIdentity = directoryIdentity(ports.root)
  const projectCurrent = (): void => {
    if (!ports.isCurrent() || directoryIdentity(ports.root) !== projectIdentity) {
      throw new DaemonError('E_CONFLICT', '原项目页面或物理工作区已变化。')
    }
  }
  const read = async () => {
    projectCurrent()
    const snapshot = await ports.readThread()
    projectCurrent()
    if (!snapshot.ok) throw new WorkbenchError(snapshot.code, snapshot.error)
    if (snapshot.thread.id !== input.threadId) throw new DaemonError('E_DENIED', '无法核实原会话与工程的绑定。')
    return snapshot
  }
  const initial = await read()
  const cwd = await boundWorkbenchRoot(ports.root, initial.thread.worktreePath, projectCurrent)
  const cwdIdentity = directoryIdentity(cwd)
  const current = (): void => {
    projectCurrent()
    if (directoryIdentity(cwd) !== cwdIdentity) throw new DaemonError('E_CONFLICT', '原会话工作树目录已变化。')
  }
  const revalidate = async () => {
    current()
    const now = await read()
    if (initial.thread.projectId !== now.thread.projectId || initial.thread.worktreePath !== now.thread.worktreePath ||
        initial.thread.archivedAt?.toString() !== now.thread.archivedAt?.toString() ||
        pathKey(await boundWorkbenchRoot(ports.root, now.thread.worktreePath, current)) !== pathKey(cwd)) {
      throw new DaemonError('E_CONFLICT', '原会话的工程或工作树绑定已变化。')
    }
    current()
    return now
  }
  const confirm: WorkbenchPorts['confirm'] = async (...args) => {
    await revalidate()
    const accepted = await ports.confirm(...args)
    if (accepted) await revalidate()
    return accepted
  }
  const guard = (): boolean => {
    try { current(); return true } catch { return false }
  }
  const write = async (): Promise<void> => {
    const thread = await revalidate()
    if (ports.task || !ports.canWrite()) throw new DaemonError('E_DENIED', readOnly)
    if (thread.thread.archivedAt) throw new DaemonError('E_DENIED', '请先恢复已归档会话。')
  }
  const writeCurrent = (): boolean => !ports.task && ports.canWrite() && guard()
  const status = () => workbenchGitStatus(cwd, current)
  const action = input.action
  const kind = action.kind
  let result: ProjectWorkbenchResult
  switch (kind) {
    case 'inspect': {
      const git = status().then(async snapshot => ({
        available: true, snapshot, stats: await workbenchStats(cwd, snapshot, current).catch(projectWorkbenchFailure),
      }) satisfies ProjectWorkbenchGit).catch((error: unknown): ProjectWorkbenchGit => {
        const failure = projectWorkbenchFailure(error)
        return { available: false, reason: failure.error, code: failure.code }
      })
      const [observed, scripts] = await Promise.all([git, appRuntime.list(cwd)])
      const editor = workbenchEditor()
      const terminal = workbenchTerminal()
      const writable = writeCurrent() && !initial.thread.archivedAt
      const project: ProjectWorkbenchProject = {
        cwd, threadId: input.threadId, machine: hostname(), git: observed,
        gitWrite: !writable ? { available: false, reason: readOnly } :
          observed.available ? { available: true } : { available: false, reason: observed.reason },
        scripts: scripts.ok ? { available: true, items: scripts.apps.map(app => ({
          appId: app.definition.id, name: app.definition.name, revision: app.definition.revision, runId: app.run?.id ?? null,
          processState: app.processState, canStart: writable && app.canStart, canStop: writable && app.canStop,
        })) } : { available: false, reason: scripts.error },
        ides: editor ? [{ id: 'vscode', label: 'Visual Studio Code' }] : [],
        terminal: !writable ? { available: false, reason: readOnly } :
          terminal ? { available: true } : { available: false, reason: '未找到可启动的本机终端。' },
        restore: { available: false, reason: initial.thread.worktreePath ? noCheckpoint : '主工程只能回看对话和差异。' },
      }
      result = { ok: true, kind, project }
      break
    }
    case 'files':
      result = { ok: true, kind, ...workbenchFiles(cwd, action.directory) }
      break
    case 'file':
      result = { ok: true, kind, ...workbenchFile(cwd, action.path) }
      break
    case 'diff': {
      const diff = await workbenchDiff(cwd, action.path, action.mode, action.baseBranch, current)
      result = diff.ok ? { ...diff, ok: true, kind } : ipcFail(IpcErrorCode.Io, '无法读取原文件差异。')
      break
    }
    case 'branch.diff': {
      const { stats } = await workbenchBranchStats(cwd, action.baseBranch, await status(), current)
      result = { ok: true, kind, baseBranch: action.baseBranch, stats }
      break
    }
    case 'open.directory': {
      await revalidate()
      current()
      if (await ports.openPath(cwd)) throw new DaemonError('E_UNAVAILABLE', '系统无法打开原工程目录。')
      return { ok: true, kind }
    }
    case 'open.ide': {
      await revalidate()
      const editor = workbenchEditor()
      if (!editor || action.ideId !== 'vscode') throw new DaemonError('E_UNAVAILABLE', '未找到 Visual Studio Code。')
      await workbenchLaunch(editor, ['--', cwd], cwd, current, true)
      return { ok: true, kind }
    }
    case 'terminal.open': {
      await write()
      if (!await confirm('打开本机终端', '在原会话目录打开交互终端？', cwd, '打开终端')) throw new DaemonError('E_DENIED', '已取消打开终端。')
      const terminal = workbenchTerminal()
      if (!terminal) throw new DaemonError('E_UNAVAILABLE', '未找到可启动的本机终端。')
      await write()
      await workbenchLaunchTerminal(terminal, cwd, () => {
        current()
        if (!writeCurrent()) throw new DaemonError('E_CONFLICT', readOnly)
      })
      return { ok: true, kind }
    }
    case 'script.start': {
      await write()
      const approved = async (preview: ApplicationLaunchPreview) => {
        assertScriptDirectory(cwd, preview.cwd)
        return confirm('确认脚本启动', `启动 ${preview.name}？`, `${preview.cwd}\n${preview.command}`, '启动')
      }
      const app = await appRuntime.start(cwd, action.appId, {
        expectedRevision: action.revision, requireConfirmation: true, confirm: approved, isCurrent: writeCurrent, assertCurrent: write,
      })
      return app.ok ? { ...app, kind } : app
    }
    case 'script.logs': {
      const logs = await appRuntime.logs(cwd, action.appId, action.after, action.runId)
      result = logs.ok ? { ...logs, kind } : logs
      break
    }
    case 'script.stop': {
      await write()
      const app = await appRuntime.stop(cwd, action.appId, action.runId, undefined, false, writeCurrent)
      return app.ok ? { ...app, kind } : app
    }
    case 'git.stage': case 'git.unstage': case 'git.commit': case 'git.branch.create': case 'git.branch.switch': case 'git.push': {
      await write()
      await assertWorkbenchGitRoot(cwd, current)
      const gitArguments = { expectedRoot: cwd, revision: action.revision, confirm: true }
      const guardGit = async () => {
        await write()
        await assertWorkbenchGitRoot(cwd, current)
      }
      const review = (review: GitWorkspaceReview) => {
        const commit = review.kind === 'commit'
        const details = commit ? [review.message?.slice(0, 2000), ...review.paths.slice(0, 30), review.paths.length > 30 ? `共 ${review.paths.length} 项` : null] :
          [review.remote, review.remoteUrl, review.remoteBranch]
        return confirm(commit ? '确认 Git 提交' : '确认 Git 推送', commit ? '提交已核对的暂存内容？' : '推送原 HEAD 到所选远端？',
          [cwd, review.branch, ...details].filter(Boolean).join('\n'), commit ? '提交' : '推送')
      }
      const options: GitWorkspaceOperationOptions = { guard: writeCurrent, review, validateContext: guardGit }
      let git: GitWorkspaceMutationResult
      switch (kind) {
        case 'git.stage': git = await gitWorkspace.stage(cwd, { ...gitArguments, paths: action.paths }, options); break
        case 'git.unstage': git = await gitWorkspace.unstage(cwd, { ...gitArguments, paths: action.paths }, options); break
        case 'git.commit': git = await gitWorkspace.commit(cwd, { ...gitArguments, message: action.message }, options); break
        case 'git.branch.create': git = await gitWorkspace.createBranch(cwd, { ...gitArguments, name: action.name, switchAfter: action.switchAfter }, options); break
        case 'git.branch.switch': git = await gitWorkspace.switchBranch(cwd, { ...gitArguments, name: action.name }, options); break
        case 'git.push': git = await gitWorkspace.push(cwd, { ...gitArguments, remote: action.remote, branch: action.branch,
          remoteBranch: action.remoteBranch, setUpstream: action.setUpstream }, options); break
      }
      if (git.ok || git.mutationCompleted) clearGitCache()
      if (!guard()) return { ...ipcFail(IpcErrorCode.Conflict, '工程页面已变化，请回到原工作区核对 Git 操作。'), outcome: 'unknown' }
      return git.ok ? { ...git, kind } : git
    }
    case 'gitlab.status': case 'gitlab.pr.create': case 'gitlab.issue.open': {
      if (kind === 'gitlab.pr.create') await write()
      return workbenchGitlab(action, { root: cwd, status, revalidate: kind === 'gitlab.pr.create' ? write : async () => { await revalidate() },
        current, confirm, openExternal: ports.openExternal })
    }
    case 'checkpoint.restore': {
      const snapshot = await revalidate()
      await assertWorkbenchCheckpointRestore(ports.root, snapshot, action, undefined, current)
      throw new DaemonError('E_UNAVAILABLE', noCheckpoint)
    }
  }
  await revalidate()
  return result
}
