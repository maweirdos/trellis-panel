/** Fixed, bounded queries for the read-only Git viewer; task mutations live in git.ts. */
import { createHash } from 'crypto'
import { realpath } from 'fs/promises'
import { isAbsolute, resolve, win32 } from 'path'
import { z } from 'zod'
import { errorText } from '../../shared/errors'
import { IpcErrorCode, ipcFail, type IpcFail } from '../../shared/ipc-errors'
import { GIT_HISTORY_LIMIT, GIT_HISTORY_PAGE_SIZE } from '../../shared/git-readonly'
import type {
  GitCommitDiffResult, GitCommitFile, GitCommitResult, GitHistoryCommit, GitHistoryRef, GitHistoryResult
} from '../../shared/git-readonly'
import type { GitReadonlyFileDiff, GitReadonlyStatus, GitStatusEntry } from '../../shared/types'
import { checkedGit, GIT_DIFF_CAP, GitReadError, readGit } from './git-readonly-reader'

// Keep the old service type exports for existing callers.
export type { GitReadonlyStatus, GitStatusEntry } from '../../shared/types'
export type GitFileDiffResult = GitReadonlyFileDiff

const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)
const expectedRoot = z.string().min(1).max(32768).refine((value) => isAbsolute(value) && !value.includes('\0'))
const historyRequest = z.object({
  expectedRoot,
  offset: z.number().int().min(0).max(GIT_HISTORY_LIMIT - GIT_HISTORY_PAGE_SIZE).multipleOf(GIT_HISTORY_PAGE_SIZE).default(0),
  revision: z.string().regex(/^[0-9a-f]{64}$/).optional()
}).refine((value) => value.offset === 0 || value.revision !== undefined)
const commitRequest = z.object({ expectedRoot, hash: oid })
const commitDiffRequest = commitRequest.extend({ path: z.string().min(1).max(32768) })
const LOG_FORMAT = '%H%x00%P%x00%an%x00%at%x00%s'
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', '-M', '-l200']

function failure(error: unknown): IpcFail {
  return ipcFail(error instanceof GitReadError ? error.code : IpcErrorCode.Io, errorText(error, 'Git 读取失败'))
}

function sameRoot(left: string, right: string): boolean {
  const normalize = (value: string): string => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  return normalize(left) === normalize(right)
}

function requireRoot(root: string, requested: string): void {
  if (!sameRoot(root, requested)) throw new GitReadError(IpcErrorCode.Conflict, '当前项目已切换，请刷新 Git 视图')
}

function requirePath(path: string): void {
  if (!path || path.length > 32768 || path.includes('\0') || path.includes('\\') || isAbsolute(path) || win32.isAbsolute(path) ||
    /^[a-z]:/i.test(path) || path.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new GitReadError(IpcErrorCode.InvalidArg, '差异路径必须是项目内的相对文件路径')
  }
}

async function requireRepo(root: string): Promise<void> {
  const result = await readGit(root, ['rev-parse', '--show-toplevel'])
  if (result.code !== 0) {
    throw new GitReadError(IpcErrorCode.NotFound, '当前项目目录不是 Git 工作区根目录')
  }
  // Git expands Windows short names and symlink roots; compare canonical directories.
  const [projectRoot, repositoryRoot] = await Promise.all([realpath(root), realpath(result.out.trim())])
  if (!sameRoot(projectRoot, repositoryRoot)) throw new GitReadError(IpcErrorCode.NotFound, '当前项目目录不是 Git 工作区根目录')
}

/** Status/unstaged diff would otherwise execute clean/process filters while hashing files. */
async function requireNoWorktreeFilters(root: string, paths?: string[]): Promise<void> {
  const config = await readGit(root, ['config', '--null', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'])
  if (config.code === 1) return // No filter commands configured.
  if (config.code !== 0) throw new GitReadError(IpcErrorCode.Io, config.err.trim() || '无法读取 Git filter 配置')
  const drivers = new Set(config.out.split('\0').flatMap((entry) => {
    const match = /^filter\.(.*)\.(?:clean|smudge|process)\n([\s\S]+)$/.exec(entry)
    return match ? [match[1]] : []
  }))
  if (drivers.size === 0) return
  const input = paths ? paths.join('\0') + '\0' : (await checkedGit(root, ['ls-files', '--cached', '-z'])).out
  if (!input) return
  const attributes = await checkedGit(root, ['check-attr', '-z', '--stdin', 'filter'], { stdin: input })
  const tokens = attributes.out.split('\0')
  for (let i = 2; i < tokens.length; i += 3) {
    if (drivers.has(tokens[i])) throw new GitReadError(IpcErrorCode.Denied,
      '工作区启用了外部 Git 内容过滤器，此只读视图不执行过滤器；可查看已提交或已暂存的差异')
  }
}

type Fingerprint = { revision: string; head: string | null; branch: string | null; refs: GitHistoryRef[] }

async function fingerprint(root: string): Promise<Fingerprint> {
  const [refs, head, symbolic] = await Promise.all([
    checkedGit(root, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)',
      'refs/heads/', 'refs/remotes/', 'refs/tags/']),
    readGit(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']),
    readGit(root, ['symbolic-ref', '-q', 'HEAD'])
  ])
  if (symbolic.code !== 0 && symbolic.code !== 1) throw new GitReadError(IpcErrorCode.Io, symbolic.err.trim() || '无法读取 HEAD')
  if (head.code !== 0 && (head.code !== 1 || symbolic.code !== 0)) {
    throw new GitReadError(IpcErrorCode.Io, head.err.trim() || '无法读取 HEAD 提交')
  }
  const headHash = head.out.trim() || null
  const branch = symbolic.code === 0 ? symbolic.out.trim().replace(/^refs\/heads\//, '') : null
  const revision = createHash('sha256').update(refs.out).update('\0').update(headHash ?? '').update('\0').update(symbolic.out).digest('hex')
  const labels: GitHistoryRef[] = []
  for (const line of refs.out.split('\n')) {
    if (!line) continue
    const [fullName, object, peeled, objectType, peeledType] = line.split('\0')
    const hash = objectType === 'commit' ? object : peeledType === 'commit' ? peeled : null
    const kind = fullName.startsWith('refs/heads/') ? 'branch' : fullName.startsWith('refs/remotes/') ? 'remote' : 'tag'
    if (hash) labels.push({ name: fullName.replace(/^refs\/(?:heads|remotes|tags)\//, ''), fullName, hash, kind })
  }
  return { revision, head: headHash, branch, refs: labels }
}

function commitsFromLog(output: string): GitHistoryCommit[] {
  const tokens = output.split('\0')
  const commits: GitHistoryCommit[] = []
  for (let i = 0; i + 4 < tokens.length; i += 5) {
    const [hash, parents, author, timestamp, subject] = tokens.slice(i, i + 5)
    if (!oid.safeParse(hash).success || !Number.isFinite(Number(timestamp))) {
      throw new GitReadError(IpcErrorCode.Io, 'Git 提交元数据格式不可读')
    }
    commits.push({ hash, parents: parents ? parents.split(' ') : [], author, timestamp: Number(timestamp) * 1000, subject })
  }
  return commits
}

export async function gitReadonlyHistory(root: string, input: unknown): Promise<GitHistoryResult> {
  const parsed = historyRequest.safeParse(input)
  if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, 'Git 历史请求无效（路径、分页或版本）')
  const request = parsed.data
  try {
    requireRoot(root, request.expectedRoot)
    await requireRepo(root)
    const before = await fingerprint(root)
    if (request.revision && request.revision !== before.revision) {
      return ipcFail(IpcErrorCode.Conflict, 'Git 历史已变化，请刷新后重新加载')
    }
    let page: GitHistoryCommit[] = []
    if (before.head || before.refs.length > 0) {
      const log = await checkedGit(root, ['log', '--topo-order', '--branches', '--remotes', '--tags',
        ...(before.head ? [before.head] : []), '--skip=' + request.offset, '--max-count=' + (GIT_HISTORY_PAGE_SIZE + 1),
        '--format=' + LOG_FORMAT, '-z', '--'])
      page = commitsFromLog(log.out)
    }
    const after = await fingerprint(root)
    if (before.revision !== after.revision) return ipcFail(IpcErrorCode.Conflict, '读取期间 Git 历史已变化，请刷新后重试')
    const commits = page.slice(0, GIT_HISTORY_PAGE_SIZE)
    const nextOffset = request.offset + commits.length
    const limited = page.length > commits.length && nextOffset >= GIT_HISTORY_LIMIT
    return { ok: true, root, revision: before.revision, head: before.head, commits, refs: before.refs,
      nextOffset, hasMore: page.length > commits.length && !limited, limited }
  } catch (error) { return failure(error) }
}

function treeArgs(commit: GitHistoryCommit, parent: string | null): string[] {
  return ['diff-tree', '--no-commit-id', '-r', ...DIFF_OPTIONS, ...(parent ? [parent, commit.hash] : ['--root', commit.hash])]
}

function filesFromNames(output: string): GitCommitFile[] {
  // Keep only complete NUL-delimited records if the byte cap cut a path in half.
  const tokens = output.slice(0, output.lastIndexOf('\0') + 1).split('\0')
  const files: GitCommitFile[] = []
  for (let i = 0; i < tokens.length - 1;) {
    const status = tokens[i++]
    const first = tokens[i++]
    if (!first) break
    if (/^[RC]/.test(status)) {
      const path = tokens[i++]
      if (!path) break
      files.push({ path, oldPath: first, status })
    } else files.push({ path: first, oldPath: null, status })
  }
  return files
}

async function commitDetail(root: string, hash: string): Promise<Extract<GitCommitResult, { ok: true }>> {
  const log = await readGit(root, ['log', '-1', '--format=' + LOG_FORMAT, '-z', hash, '--'])
  if (log.code !== 0) throw new GitReadError(IpcErrorCode.NotFound, '提交不存在或已被清理，请刷新历史')
  const commit = commitsFromLog(log.out)[0]
  if (!commit || commit.hash.toLowerCase() !== hash.toLowerCase()) throw new GitReadError(IpcErrorCode.InvalidArg, '目标对象不是提交')
  const parent = commit.parents[0] ?? null
  const names = await checkedGit(root, [...treeArgs(commit, parent), '--name-status', '-z'], { allowTruncated: true })
  const comparison = parent ? (commit.parents.length > 1 ? '与第一父提交比较' : '与父提交比较') : '初始提交，与空树比较'
  return { ok: true, root, commit, files: filesFromNames(names.out), parent, comparison, filesTruncated: names.truncated }
}

export async function gitReadonlyCommit(root: string, input: unknown): Promise<GitCommitResult> {
  const parsed = commitRequest.safeParse(input)
  if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '需要项目路径和完整提交对象 ID')
  try {
    requireRoot(root, parsed.data.expectedRoot)
    await requireRepo(root)
    return await commitDetail(root, parsed.data.hash)
  } catch (error) { return failure(error) }
}

async function diffResult(root: string, args: string[], paths: string[]): Promise<Pick<GitReadonlyFileDiff, 'diff' | 'added' | 'removed' | 'binary' | 'truncated'>> {
  const stats = await checkedGit(root, [...args, '--numstat', '-z', '--', ...paths])
  let added = 0, removed = 0, binary = false
  const tokens = stats.out.split('\0')
  for (let i = 0; i < tokens.length - 1; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i])
    if (!match) continue
    // Renames encode an empty name followed by two raw path tokens. Neither path
    // is another stats record, even when its filename starts with digits/tabs.
    if (match[3] === '') i += 2
    if (match[1] === '-' || match[2] === '-') binary = true
    else { added += Number(match[1]); removed += Number(match[2]) }
  }
  const patch = await checkedGit(root, [...args, '-p', '-U3', '--src-prefix=a/', '--dst-prefix=b/', '--', ...paths],
    { maxBytes: GIT_DIFF_CAP, allowTruncated: true })
  return { diff: patch.out, added, removed, binary, truncated: patch.truncated }
}

export async function gitReadonlyCommitDiff(root: string, input: unknown): Promise<GitCommitDiffResult> {
  const parsed = commitDiffRequest.safeParse(input)
  if (!parsed.success) return ipcFail(IpcErrorCode.InvalidArg, '提交差异请求无效')
  const request = parsed.data
  try {
    requireRoot(root, request.expectedRoot)
    requirePath(request.path)
    await requireRepo(root)
    const detail = await commitDetail(root, request.hash)
    const file = detail.files.find((entry) => entry.path === request.path)
    if (!file) return ipcFail(IpcErrorCode.NotFound, '该文件不在提交改动列表内')
    // An old filename may now be a directory. Passing it as a pathspec would
    // include unrelated descendants; follow the selected rename from its new name.
    // Filtering also isolates file/directory replacements on their added/deleted side.
    const args = [...treeArgs(detail.commit, detail.parent), '--diff-filter=' + file.status.charAt(0),
      ...(file.oldPath ? ['--follow'] : [])]
    const result = await diffResult(root, args, [file.path])
    return { ok: true, root, path: request.path, comparison: detail.comparison, ...result }
  } catch (error) { return failure(error) }
}

export async function gitReadonlyStatus(root: string): Promise<GitReadonlyStatus> {
  const base: GitReadonlyStatus = { ok: false, isRepo: false, branch: null, head: null,
    staged: [], unstaged: [], untracked: [], scannedAt: Date.now() }
  try {
    await requireRepo(root)
    base.isRepo = true
    await requireNoWorktreeFilters(root)
    const info = await fingerprint(root)
    base.branch = info.branch
    if (info.head) {
      const commit = commitsFromLog((await checkedGit(root, ['log', '-1', '--format=' + LOG_FORMAT, '-z', info.head, '--'])).out)[0]
      if (commit) base.head = { short: commit.hash.slice(0, 7), subject: commit.subject }
    }
    const status = await checkedGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'])
    const tokens = status.out.split('\0')
    for (let i = 0; i < tokens.length - 1; i++) {
      const token = tokens[i], x = token[0], y = token[1] ?? ' ', path = token.slice(3)
      if (x === '?' && y === '?') { base.untracked.push(path); continue }
      const entry: GitStatusEntry = { path, x, y }
      if (/[RC]/.test(x + y)) entry.origPath = tokens[++i]
      if (x !== ' ') base.staged.push(entry)
      if (y !== ' ') base.unstaged.push(entry)
    }
    return { ...base, ok: true }
  } catch (error) { return { ...base, ...failure(error) } }
}

export async function gitReadonlyFileDiff(root: string, path: string, staged: boolean): Promise<GitFileDiffResult> {
  const result: GitFileDiffResult = { ok: false, path, staged, added: 0, removed: 0, binary: false, diff: '', truncated: false }
  try {
    requirePath(path)
    await requireRepo(root)
    if (!staged) await requireNoWorktreeFilters(root, [path])
    return { ...result, ...await diffResult(root, ['diff', ...DIFF_OPTIONS, ...(staged ? ['--cached'] : [])], [path]), ok: true }
  } catch (error) { return { ...result, ...failure(error) } }
}
