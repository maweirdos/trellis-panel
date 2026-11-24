import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { ProjectWorkbenchFileStat, ProjectWorkbenchStats } from '../../../shared/conversation/project-workbench'
import type { GitWorkspaceSnapshot } from '../../../shared/git-workspace'
import { DaemonError } from '../../daemon/errors'
import { assertGitReadSafety, gitReadonlyFileDiff } from '../devtools-git'
import { checkedGit, GIT_DIFF_CAP, readGit } from '../git-readonly-reader'
import { gitWorkspace } from '../git-workspace'
import { checkedDirectory, pathKey, readRegular } from '../private-conversations/files'
import { workbenchPath } from './files'
import { WorkbenchError } from './errors'

const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', '-M', '-l200']
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const untrackedBudget = 16 * 1024 * 1024

const gitRootDenied = () => new DaemonError('E_DENIED', '无法核实当前目录对 Git 元数据和工作树的归属。')

async function gitDirectories(root: string): Promise<{ top: string; gitDir: string; commonDir: string }> {
  const git = await readGit(root, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'])
  if (git.code !== 0 || !git.out.trim()) throw new WorkbenchError('E_NOT_FOUND', '当前目录没有可读取的 Git 工作树。')
  const paths = git.out.replace(/\r?\n$/, '').split(/\r?\n/)
  if (paths.length !== 3 || !paths.every(isAbsolute)) throw gitRootDenied()
  const [top, gitDir, commonDir] = paths.map(normalize)
  return { top, gitDir, commonDir }
}

function pointsTo(directory: string, file: string, expected: string, prefix = ''): boolean {
  const value = readRegular(directory, file, 4096).bytes.toString('utf8').replace(/\r?\n$/, '')
  return value.startsWith(prefix) && !/[\r\n\0]/u.test(value) && pathKey(resolve(directory, value.slice(prefix.length))) === pathKey(expected)
}

export async function assertWorkbenchGitRoot(root: string, current: () => void): Promise<void> {
  current()
  const { top, gitDir, commonDir } = await gitDirectories(root)
  current()
  if (pathKey(await realpath(top)) !== pathKey(root)) {
    throw new DaemonError('E_DENIED', '上级 Git 仓库不属于当前已授权目录。')
  }
  const localGit = join(root, '.git')
  try {
    checkedDirectory(gitDir)
    checkedDirectory(commonDir)
    if (pathKey(gitDir) === pathKey(commonDir)) {
      if (pathKey(commonDir) !== pathKey(localGit)) throw gitRootDenied()
    } else {
      const owner = dirname(commonDir)
      if (pathKey(commonDir) !== pathKey(join(owner, '.git')) ||
          pathKey(gitDir) !== pathKey(join(commonDir, 'worktrees', basename(gitDir))) ||
          !pointsTo(root, '.git', gitDir, 'gitdir: ') ||
          !pointsTo(gitDir, 'gitdir', localGit) ||
          !pointsTo(gitDir, 'commondir', commonDir)) throw gitRootDenied()
      const ownerGit = await gitDirectories(owner)
      const trees = await registeredGitWorktrees(owner)
      if (pathKey(ownerGit.top) !== pathKey(owner) || pathKey(ownerGit.gitDir) !== pathKey(commonDir) ||
          pathKey(ownerGit.commonDir) !== pathKey(commonDir) ||
          !trees.some(tree => pathKey(tree) === pathKey(root)) || !trees.some(tree => pathKey(tree) === pathKey(owner))) {
        throw gitRootDenied()
      }
    }
  } catch { throw gitRootDenied() }
  current()
}

export async function workbenchGitStatus(root: string, current: () => void) {
  await assertWorkbenchGitRoot(root, current)
  const result = await gitWorkspace.status(root)
  current()
  if (!result.ok) throw new WorkbenchError(result.code, result.error)
  if (pathKey(result.snapshot.repoRoot) !== pathKey(root)) throw new DaemonError('E_CONFLICT', '原 Git 工作树已变化。')
  return result.snapshot
}

export function parseNumstat(stdout: string): ProjectWorkbenchFileStat[] {
  const fields = stdout.split('\0')
  const files: ProjectWorkbenchFileStat[] = []
  for (let index = 0; index < fields.length - 1; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index])
    if (!match) throw new DaemonError('E_IO', 'Git 差异统计格式无效。')
    const previousPath = match[3] === '' ? fields[++index] : null
    const path = previousPath !== null ? fields[++index] : match[3]
    if (!path || previousPath === '') throw new DaemonError('E_IO', 'Git 差异路径格式无效。')
    files.push({
      path,
      previousPath,
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
      binary: match[1] === '-' || match[2] === '-',
    })
  }
  return files
}

function sum(files: ProjectWorkbenchFileStat[]): ProjectWorkbenchStats {
  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  }
}

function untrackedContents(root: string, path: string, limit: number) {
  workbenchPath(path)
  return readRegular(root, path, limit).bytes
}

async function untrackedBinaryAttributes(root: string, paths: readonly string[]): Promise<ReadonlyMap<string, boolean | undefined>> {
  if (!paths.length) return new Map()
  paths.forEach(workbenchPath)
  const { out } = await checkedGit(root, ['check-attr', '-z', '--stdin', 'diff'], { stdin: `${paths.join('\0')}\0` })
  const fields = out.split('\0')
  if (fields.pop() !== '' || fields.length !== paths.length * 3) throw new DaemonError('E_IO', 'Git 文件属性格式无效。')
  const hasDriver = paths.some((_, index) => !['set', 'unset', 'unspecified'].includes(fields[index * 3 + 2]))
  const drivers = new Map<string, boolean>()
  if (hasDriver) {
    const config = await readGit(root, ['config', '--type=bool', '--null', '--get-regexp', '^diff\\..*\\.binary$'])
    if (config.code !== 0 && config.code !== 1) throw new DaemonError('E_IO', '无法核对 Git 差异驱动的二进制属性。')
    for (const entry of config.out.split('\0').filter(Boolean)) {
      const match = /^diff\.(.+)\.binary\n(true|false)$/su.exec(entry)
      if (!match) throw new DaemonError('E_IO', 'Git 差异驱动属性格式无效。')
      drivers.set(match[1], match[2] === 'true')
    }
  }
  return new Map(paths.map((path, index) => {
    const [reported, attribute, value] = fields.slice(index * 3, index * 3 + 3)
    if (reported !== path || attribute !== 'diff') throw new DaemonError('E_IO', 'Git 返回了不匹配的文件属性。')
    return [path, value === 'set' ? false : value === 'unset' ? true : drivers.get(value)] as const
  }))
}

function untrackedStat(path: string, bytes: Buffer, attribute: boolean | undefined): ProjectWorkbenchFileStat {
  const binary = attribute ?? bytes.subarray(0, 8000).includes(0)
  let additions = 0
  if (!binary) {
    for (const byte of bytes) if (byte === 10) additions++
    if (bytes.length && bytes.at(-1) !== 10) additions++
  }
  return { path, previousPath: null, additions, deletions: 0, binary }
}

export async function workbenchStats(root: string, git: GitWorkspaceSnapshot, current: () => void): Promise<ProjectWorkbenchStats> {
  await assertGitReadSafety(root)
  current()
  const base = git.head ?? (await checkedGit(root, ['hash-object', '-t', 'tree', '--stdin'], { stdin: '' })).out.trim()
  if (!objectId.test(base)) throw new DaemonError('E_IO', '无法核对 Git 差异基点。')
  const tracked = await checkedGit(root, ['diff', ...diffOptions, '--numstat', '-z', base, '--'])
  const files = parseNumstat(tracked.out)
  const attributes = await untrackedBinaryAttributes(root, git.untracked)
  current()
  let remaining = untrackedBudget
  for (const path of git.untracked) {
    const bytes = untrackedContents(root, path, remaining)
    remaining -= bytes.length
    files.push(untrackedStat(path, bytes, attributes.get(path)))
  }
  return sum(files)
}

async function branchBase(root: string, branch: string, head: string): Promise<string> {
  const valid = await readGit(root, ['check-ref-format', `refs/heads/${branch}`])
  if (valid.code !== 0) throw new DaemonError('E_INVALID_ARG', '比较分支无效。')
  const ref = await readGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  const baseHead = ref.out.trim()
  if (ref.code !== 0 || !objectId.test(baseHead)) throw new WorkbenchError('E_NOT_FOUND', '找不到所选本地分支。')
  const mergeBase = (await checkedGit(root, ['merge-base', baseHead, head])).out.trim()
  if (!objectId.test(mergeBase)) throw new DaemonError('E_IO', '无法核对分支的共同基点。')
  return mergeBase
}

export async function workbenchBranchStats(root: string, branch: string, snapshot: GitWorkspaceSnapshot, current: () => void) {
  const { head } = snapshot
  if (!head) throw new DaemonError('E_UNAVAILABLE', '需要当前分支的首个提交才能比较。')
  const base = await branchBase(root, branch, head)
  current()
  const result = await checkedGit(root, ['diff', ...diffOptions, '--numstat', '-z', base, head, '--'])
  return { base, head, stats: sum(parseNumstat(result.out)) }
}

export async function workbenchDiff(
  root: string, path: string, mode: 'staged' | 'unstaged' | 'untracked' | 'branch', baseBranch: string | undefined, current: () => void,
) {
  workbenchPath(path)
  const git = await workbenchGitStatus(root, current)
  if (mode === 'untracked') {
    if (!git.untracked.includes(path)) throw new WorkbenchError('E_NOT_FOUND', '原文件不再属于未跟踪改动。')
    const attributes = await untrackedBinaryAttributes(root, [path])
    current()
    const bytes = untrackedContents(root, path, untrackedBudget)
    const { additions, binary } = untrackedStat(path, bytes, attributes.get(path))
    const header = `--- /dev/null\n+++ ${JSON.stringify(`b/${path}`)}\n`
    const text = bytes.subarray(0, GIT_DIFF_CAP).toString('utf8')
    const lines = text.replace(/\n$/, '').split('\n')
    const diff = binary || !bytes.length ? '' : `${header}@@ -0,0 +1,${additions} @@\n${lines.map(line => `+${line}`).join('\n')}\n${bytes.at(-1) !== 10 ? '\\ No newline at end of file\n' : ''}`
    return { ok: true as const, path, staged: false, added: additions, removed: 0, binary,
      diff: Buffer.from(diff).subarray(0, GIT_DIFF_CAP).toString('utf8'), truncated: Buffer.byteLength(diff) > GIT_DIFF_CAP || bytes.length > GIT_DIFF_CAP }
  }
  if (mode === 'branch') {
    if (!baseBranch) throw new DaemonError('E_INVALID_ARG', '请选择用于比较的本地分支。')
    const { base, head, stats } = await workbenchBranchStats(root, baseBranch, git, current)
    const file = stats.files.find(change => change.path === path)
    if (!file) throw new WorkbenchError('E_NOT_FOUND', '原文件不在所选分支差异中。')
    const paths = [...(file.previousPath ? [workbenchPath(file.previousPath)] : []), path]
    const result = await checkedGit(root, ['diff', ...diffOptions, base, head, '--', ...paths], { maxBytes: GIT_DIFF_CAP, allowTruncated: true })
    return { ok: true as const, path, staged: false, added: file.additions, removed: file.deletions,
      binary: file.binary, diff: result.out, truncated: result.truncated }
  }
  const staged = mode === 'staged'
  const entry = (staged ? git.staged : git.unstaged).find(change => change.path === path)
  if (!entry) throw new WorkbenchError('E_NOT_FOUND', '原文件不再属于所选改动。')
  current()
  if (!entry.origPath) return gitReadonlyFileDiff(root, path, staged)
  const paths = [workbenchPath(entry.origPath), entry.path]
  const args = ['diff', ...diffOptions, ...(staged ? ['--cached'] : [])]
  const stats = parseNumstat((await checkedGit(root, [...args, '--numstat', '-z', '--', ...paths])).out)
  const file = stats.find(change => change.path === path)
  const patch = await checkedGit(root, [...args, '--', ...paths], { maxBytes: GIT_DIFF_CAP, allowTruncated: true })
  return { ok: true as const, path, staged, added: file?.additions ?? 0, removed: file?.deletions ?? 0, binary: file?.binary ?? false,
    diff: patch.out, truncated: patch.truncated }
}

export async function registeredGitWorktrees(root: string): Promise<string[]> {
  const result = await checkedGit(root, ['worktree', 'list', '--porcelain', '-z'])
  return result.out.split('\0').flatMap(field => field.startsWith('worktree ') ? [normalize(field.slice(9))] : [])
}

export async function workbenchHasUntrackedFiles(root: string): Promise<boolean> {
  return Boolean((await checkedGit(root, ['ls-files', '--others', '--directory', '--no-empty-directory', '-z'])).out)
}
