import { execFile } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { conversationGitStatusSchema, type ConversationGitStatus } from '../../../shared/conversation-git'
import { IpcErrorCode } from '../../../shared/ipc-errors'
import { parseStatus } from '../git-workspace/lib/state'
import { redactGitText } from '../git-workspace/lib/git'
import { GitWorkspaceError } from '../git-workspace/types'
import { checkedDirectory, directoryIdentity, pathKey } from './files'

const TIMEOUT_MS = 8000
const OUTPUT_BYTES = 256 * 1024
const ERROR_BYTES = 32 * 1024
type Directory = { path: string; identity: string }
type GitResult = { stdout: string; stderr: string; code: number }

function captureDirectory(path: string): Directory {
  const physical = checkedDirectory(path)
  return { path: physical, identity: directoryIdentity(physical) }
}

function assertDirectories(directories: Directory[]): void {
  for (const directory of directories) {
    try {
      if (directoryIdentity(directory.path) === directory.identity) continue
    } catch { /* Missing and redirected directories invalidate the original read. */ }
    throw new GitWorkspaceError(IpcErrorCode.Conflict, '原会话或 Git 目录已变化，请重新读取')
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key]
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C', LANG: 'C' }
}

function execute(root: string, args: string[], deadline: number, input?: string): Promise<GitResult> {
  const timeout = Math.ceil(deadline - performance.now())
  if (timeout <= 0) return Promise.reject(new GitWorkspaceError(IpcErrorCode.Timeout, 'Git 状态读取超时'))
  return new Promise((accept, reject) => {
    let errorBytes = 0, errorOverflow = false
    const child = execFile('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs',
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'submodule.recurse=false',
      '-c', 'protocol.allow=never', '-c', 'diff.external=', '-c', 'color.ui=false', ...args],
    { cwd: root, env: gitEnvironment(), windowsHide: true, encoding: 'buffer', timeout, maxBuffer: OUTPUT_BYTES, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (errorOverflow || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        reject(new GitWorkspaceError(IpcErrorCode.Io, 'Git 元数据超过读取上限')); return
      }
      if (error?.killed || error?.signal) { reject(new GitWorkspaceError(IpcErrorCode.Timeout, 'Git 状态读取超时')); return }
      if (error && typeof error.code !== 'number') {
        reject(new GitWorkspaceError(error.code === 'ENOENT' ? IpcErrorCode.NotFound : IpcErrorCode.Io,
          error.code === 'ENOENT' ? '未找到 Git，请安装并配置 PATH' : '无法启动 Git 状态读取')); return
      }
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        accept({ stdout: decoder.decode(stdout), stderr: redactGitText(decoder.decode(stderr)), code: typeof error?.code === 'number' ? error.code : 0 })
      } catch { reject(new GitWorkspaceError(IpcErrorCode.Io, 'Git 元数据编码无效')) }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length
      if (errorBytes > ERROR_BYTES) { errorOverflow = true; child.kill('SIGKILL') }
    })
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (!['EPIPE', 'EOF'].includes(error.code ?? '')) {
        child.kill('SIGKILL'); reject(new GitWorkspaceError(IpcErrorCode.Io, '无法传递 Git 元数据参数'))
      }
    })
    child.stdin?.end(input)
  })
}

function checked(result: GitResult): string {
  if (result.code !== 0) throw new GitWorkspaceError(IpcErrorCode.Io, result.stderr.trim().slice(0, 800) || 'Git 状态不可读取')
  return result.stdout
}

function line(value: string): string { return value.replace(/\r?\n$/, '') }

function firstGitMarker(root: string): string | null {
  let directory = root
  for (let depth = 0; depth < 128; depth += 1) {
    try { lstatSync(join(directory, '.git')); return directory }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
  throw new GitWorkspaceError(IpcErrorCode.Io, 'Git 来源目录层级超过读取上限')
}

/** Native owner supplies root and retains its source fence before/after this read. */
export async function readConversationGit(root: string): Promise<ConversationGitStatus> {
  let selectedRoot = typeof root === 'string' ? root.slice(0, 8192) : ''
  const directories: Directory[] = []
  try {
    if (typeof root !== 'string' || root.length > 8192 || !isAbsolute(root) || root.includes('\0')) throw new GitWorkspaceError(IpcErrorCode.InvalidArg, '需要原会话的绝对目录')
    const selected = captureDirectory(root)
    selectedRoot = selected.path; directories.push(selected)
    const marker = firstGitMarker(selected.path)
    const deadline = performance.now() + TIMEOUT_MS
    const run = async (args: string[], input?: string): Promise<GitResult> => {
      assertDirectories(directories)
      try { return await execute(selected.path, args, deadline, input) }
      finally { assertDirectories(directories) }
    }
    const discovery = await run(['rev-parse', '--show-toplevel'])
    if (discovery.code !== 0 && /^fatal: not a git repository(?:[ (:]|$)/m.test(discovery.stderr)) {
      if (marker) throw new GitWorkspaceError(IpcErrorCode.Io, '目录内 Git 元数据不可读取')
      return { state: 'not-git', root: selectedRoot, observedAt: Date.now() }
    }
    const repository = captureDirectory(line(checked(discovery)))
    if (!marker || pathKey(marker) !== pathKey(repository.path)) throw new GitWorkspaceError(IpcErrorCode.Io, '目录内 Git 来源不一致，未使用其他仓库')
    const part = relative(repository.path, selected.path)
    if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new GitWorkspaceError(IpcErrorCode.Denied, 'Git 工作树不包含原会话目录')
    if (pathKey(repository.path) === pathKey(parse(repository.path).root)) throw new GitWorkspaceError(IpcErrorCode.Denied, '不读取盘符根目录的 Git 改动，请选择具体工程')
    directories.push(repository)
    const gitDirectory = captureDirectory(line(checked(await run(['rev-parse', '--absolute-git-dir']))))
    directories.push(gitDirectory)
    const pinned = (args: string[], input?: string): Promise<GitResult> => run(['--git-dir', gitDirectory.path, '--work-tree', repository.path, ...args], input)

    // Status may invoke clean/process filters. Inspect their actual path attributes
    // before status, without hashing working files or enumerating outside this repo.
    const filters = await pinned(['config', '--null', '--get-regexp', '^filter\\..*\\.(clean|process)$'])
    if (filters.code !== 0 && filters.code !== 1) checked(filters)
    const drivers = new Set(filters.stdout.split('\0').flatMap(value => {
      const separator = value.indexOf('\n'), key = value.slice(0, separator)
      const match = separator < 0 ? null : /^filter\.(.+)\.(?:clean|process)$/i.exec(key)
      return match && value.slice(separator + 1).trim() ? [match[1]] : []
    }))
    if (drivers.size) {
      const paths = checked(await pinned(['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
      if (paths) {
        const attributes = checked(await pinned(['check-attr', '-z', '--stdin', 'filter'], paths)).split('\0')
        for (let index = 0; index + 2 < attributes.length; index += 3) if (drivers.has(attributes[index + 2])) throw new GitWorkspaceError(IpcErrorCode.Denied, '此仓库使用外部内容过滤器，请在 Git 工具中查看状态')
      }
    }
    const identity = async (): Promise<{ head: string | null; ref: string | null }> => {
      const [head, symbolic] = await Promise.all([pinned(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']), pinned(['symbolic-ref', '--quiet', 'HEAD'])])
      if (head.code !== 0 && head.code !== 1) checked(head)
      if (symbolic.code !== 0 && symbolic.code !== 1) checked(symbolic)
      const oid = head.code === 0 ? line(head.stdout) : null, ref = symbolic.code === 0 ? line(symbolic.stdout) : null
      if (oid !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) || ref !== null && (!ref.startsWith('refs/heads/') || ref.length > 1035)) throw new GitWorkspaceError(IpcErrorCode.Io, 'Git HEAD 或分支身份无效')
      if (oid === null) {
        if (!ref) throw new GitWorkspaceError(IpcErrorCode.Io, 'Git HEAD 不可读取')
        const existing = await pinned(['show-ref', '--verify', '--quiet', ref])
        if (existing.code !== 1) throw new GitWorkspaceError(IpcErrorCode.Io, 'Git 当前引用不是可读取的提交')
      }
      return { head: oid, ref }
    }
    const before = await identity()
    const status = parseStatus(checked(await pinned(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty'])))
    const after = await identity()
    if (before.head !== after.head || before.ref !== after.ref
      || pathKey(resolve(line(checked(await run(['rev-parse', '--show-toplevel']))))) !== pathKey(repository.path)
      || pathKey(resolve(line(checked(await run(['rev-parse', '--absolute-git-dir']))))) !== pathKey(gitDirectory.path)) throw new GitWorkspaceError(IpcErrorCode.Conflict, 'Git 来源或 HEAD 在读取时变化，请刷新')
    return conversationGitStatusSchema.parse({
      state: before.head === null ? 'unborn' : before.ref === null ? 'detached' : 'branch',
      root: selectedRoot, repositoryRoot: repository.path, branch: before.ref?.slice('refs/heads/'.length) ?? null, head: before.head,
      staged: status.staged.length, unstaged: status.unstaged.length, untracked: status.untracked.length, conflicts: status.conflicts, observedAt: Date.now()
    })
  } catch (error) {
    return { state: 'error', root: selectedRoot, code: error instanceof GitWorkspaceError ? error.code : IpcErrorCode.Io,
      error: error instanceof GitWorkspaceError ? error.message.slice(0, 1000) : '原会话目录或 Git 状态不可读取', observedAt: Date.now() }
  }
}
