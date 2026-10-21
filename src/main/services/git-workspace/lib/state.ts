import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { GitWorkspaceBranch, GitWorkspaceChange, GitWorkspaceRemote } from '../../../../shared/git-workspace'
import { GIT_WORKSPACE_LIMITS } from '../../../../shared/git-workspace'
import { IpcErrorCode } from '../../../../shared/ipc-errors'
import { canonicalDirectory } from '../../acp/metadata'
import { GitWorkspaceError, type RepositoryState } from '../types'
import { redactGitText, runGit } from './git'

export { canonicalDirectory }
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
function readBounded(path: string, limit: number, consume: (chunk: Buffer) => void, expected?: Stats): number {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))) throw new GitWorkspaceError(IpcErrorCode.Conflict, '文件在读取时发生变化，请刷新')
    if (stat.size > limit) throw new GitWorkspaceError(IpcErrorCode.Io, '文件超过安全快照读取上限，请缩小操作范围')
    let total = 0, count: number
    const buffer = Buffer.alloc(65536)
    while ((count = readSync(descriptor, buffer, 0, Math.min(buffer.length, limit - total + 1), null)) > 0) {
      total += count
      if (total > limit) throw new GitWorkspaceError(IpcErrorCode.Io, '文件超过安全快照读取上限，请缩小操作范围')
      consume(buffer.subarray(0, count))
    }
    return total
  } finally { closeSync(descriptor) }
}
export function readIndex(path: string): Buffer | null {
  if (!existsSync(path)) return null
  return readSnapshotFile(path, 32 * 1024 * 1024)
}
export function readSnapshotFile(path: string, limit: number): Buffer {
  const chunks: Buffer[] = []
  readBounded(path, limit, chunk => chunks.push(Buffer.from(chunk)))
  return Buffer.concat(chunks)
}
export function parseStatus(raw: string): { staged: GitWorkspaceChange[]; unstaged: GitWorkspaceChange[]; untracked: string[]; conflicts: boolean } {
  const records = raw.split('\0')
  const staged: GitWorkspaceChange[] = [], unstaged: GitWorkspaceChange[] = [], untracked: string[] = []
  let conflicts = false
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (!record) continue
    const x = record.charAt(0), y = record.charAt(1), path = record.slice(3)
    if (x === '?' && y === '?') { untracked.push(path); continue }
    const origPath = /[RC]/.test(x + y) ? records[++i] : undefined
    const change = { path, x, y, ...(origPath ? { origPath } : {}) }
    if (x === 'U' || y === 'U' || ['AA', 'DD'].includes(x + y)) conflicts = true
    if (x !== ' ' && x !== '?') staged.push(change)
    if (y !== ' ' && y !== '?') unstaged.push(change)
  }
  if (staged.length + unstaged.length + untracked.length > GIT_WORKSPACE_LIMITS.paths) throw new GitWorkspaceError(IpcErrorCode.Io, 'Git 改动数量超过上限，请缩小工作区后重试')
  return { staged, unstaged, untracked, conflicts }
}
export function validatePath(repoRoot: string, path: string): void {
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\0') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.' || part.toLowerCase() === '.git')) throw new GitWorkspaceError(IpcErrorCode.InvalidArg, '文件路径无效')
  const target = resolve(repoRoot, path)
  const rel = relative(repoRoot, target)
  if (rel.startsWith('..' + sep) || isAbsolute(rel)) throw new GitWorkspaceError(IpcErrorCode.InvalidArg, '文件不在当前仓库内')
  let parent = resolve(target, '..')
  while (parent !== repoRoot && parent.startsWith(repoRoot + sep)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new GitWorkspaceError(IpcErrorCode.Denied, '不通过符号链接目录操作仓库文件')
    parent = resolve(parent, '..')
  }
}
function worktreeIdentity(repoRoot: string, paths: string[]): string {
  let total = 0
  return digest(paths.sort().map((path) => {
    validatePath(repoRoot, path)
    const file = resolve(repoRoot, path)
    let stat: Stats
    try { stat = lstatSync(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${path}:missing`; throw error }
    if (stat.isSymbolicLink()) return `${path}:link:${readlinkSync(file)}`
    if (!stat.isFile()) return `${path}:directory:${stat.mtimeMs}`
    const hash = createHash('sha256')
    total += readBounded(file, Math.min(16 * 1024 * 1024, 64 * 1024 * 1024 - total), chunk => { hash.update(chunk) }, stat)
    return `${path}:${hash.digest('hex')}:${stat.mode}`
  }).join('\0'))
}
async function rejectActiveFilters(repoRoot: string): Promise<void> {
  const config = await runGit(repoRoot, ['config', '--get-regexp', '^filter\\..*\\.(clean|process)$'], { allowFailure: true })
  const drivers = new Set(config.stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^filter\.(.+)\.(?:clean|process)\s+(.+)$/i.exec(line)
    return match && match[2].trim() ? [match[1]] : []
  }))
  if (!drivers.size) return
  const paths = (await runGit(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).stdout
  if (!paths) return
  const attributes = (await runGit(repoRoot, ['check-attr', '-z', '--stdin', 'filter'], { input: paths })).stdout.split('\0')
  for (let i = 0; i + 2 < attributes.length; i += 3) if (drivers.has(attributes[i + 2])) throw new GitWorkspaceError(IpcErrorCode.Denied, '当前改动使用外部内容过滤器，请通过独立 Git 工具核验；面板不会在读取状态时执行过滤器')
}
export async function repositoryState(inputRoot: string): Promise<RepositoryState> {
  const root = canonicalDirectory(inputRoot)
  const top = await runGit(root, ['rev-parse', '--show-toplevel'], { allowFailure: true })
  if (top.code !== 0) throw new GitWorkspaceError(IpcErrorCode.NotFound, '当前项目不是 Git 工作区')
  const repoRoot = realpathSync(top.stdout.trim())
  const gitDirectory = resolve(root, (await runGit(root, ['rev-parse', '--absolute-git-dir'])).stdout.trim())
  const indexPath = resolve(root, (await runGit(root, ['rev-parse', '--git-path', 'index'])).stdout.trim())
  await rejectActiveFilters(repoRoot)
  const [status, entries, headResult, symbolic, branchResult, remoteNames, format] = await Promise.all([
    runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty']),
    runGit(repoRoot, ['ls-files', '--stage', '-z']),
    runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }),
    runGit(repoRoot, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }),
    runGit(repoRoot, ['for-each-ref', '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(worktreepath)%00%(objectname)', 'refs/heads/']),
    runGit(repoRoot, ['remote']), runGit(repoRoot, ['rev-parse', '--show-object-format'])
  ])
  const head = headResult.code === 0 ? headResult.stdout.trim() : null
  const headRef = symbolic.code === 0 ? symbolic.stdout.trim() : null
  const branch = headRef?.startsWith('refs/heads/') ? headRef.slice(11) : null
  const parsed = parseStatus(status.stdout)
  const branches: GitWorkspaceBranch[] = branchResult.stdout.trimEnd().split('\n').filter(Boolean).map((line) => { const [name, marker, upstream, worktree] = line.replace(/\r$/, '').split('\0'); return { name, current: marker === '*', upstream: upstream || null, worktree: worktree || null } })
  if (branch && !branches.some((item) => item.name === branch)) branches.unshift({ name: branch, current: true, upstream: null, worktree: null })
  const remotes: GitWorkspaceRemote[] = []
  const remoteConfig: string[] = []
  for (const name of remoteNames.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    const fetched = await runGit(repoRoot, ['remote', 'get-url', '--all', name])
    const pushed = await runGit(repoRoot, ['remote', 'get-url', '--push', '--all', name])
    remoteConfig.push(name, fetched.stdout.trim(), pushed.stdout.trim())
    remotes.push({ name, fetchUrl: redactGitText(fetched.stdout.trim().split(/\r?\n/)[0]), pushUrl: redactGitText(pushed.stdout.trim().split(/\r?\n/)[0]) })
  }
  const operation = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'].find((name) => existsSync(join(gitDirectory, name))) ?? null
  const indexBytes = readIndex(indexPath)
  const paths = [...new Set([...parsed.staged, ...parsed.unstaged].flatMap((item) => [item.path, ...(item.origPath ? [item.origPath] : [])]).concat(parsed.untracked))]
  const revision = digest(JSON.stringify({ root, repoRoot, head, headRef, entries: entries.stdout, index: indexBytes ? digest(indexBytes) : null, status: status.stdout, refs: branchResult.stdout, branches, remotes: remoteConfig, operation, worktree: worktreeIdentity(repoRoot, paths) }))
  const [headAgain, refAgain] = await Promise.all([
    runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }),
    runGit(repoRoot, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true })
  ])
  if ((headAgain.code === 0 ? headAgain.stdout.trim() : null) !== head || (refAgain.code === 0 ? refAgain.stdout.trim() : null) !== headRef || digest(readIndex(indexPath) ?? Buffer.alloc(0)) !== digest(indexBytes ?? Buffer.alloc(0))) throw new GitWorkspaceError(IpcErrorCode.Conflict, 'Git 状态在读取时发生变化，请刷新重试')
  return { snapshot: { root, repoRoot, revision, head, branch, unborn: head === null, detached: head !== null && branch === null, clean: paths.length === 0, ...parsed, branches, remotes, operation, observedAt: Date.now() }, gitDirectory, indexPath, indexBytes, indexEntries: entries.stdout, statusRaw: status.stdout, headRef, objectZero: '0'.repeat(format.stdout.trim() === 'sha256' ? 64 : 40) }
}
