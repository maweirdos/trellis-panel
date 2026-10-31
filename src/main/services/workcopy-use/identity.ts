import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { WorkcopyIdentity, WorkcopyObservation } from '../../../shared/workcopy-use'
import { DaemonError } from '../../daemon/errors'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function physical(path: string): { path: string; id: string } {
  const actual = realpathSync.native(path), stat = statSync(actual, { bigint: true })
  if (!stat.isDirectory()) throw new DaemonError('E_CONFLICT', '工作副本目录不可用，请重新核对。')
  return { path: actual, id: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` }
}
function hasGitAncestor(root: string): boolean {
  for (let path = root; ; path = dirname(path)) {
    if (existsSync(join(path, '.git'))) return true
    if (dirname(path) === path) return false
  }
}
/** rev-parse/symbolic-ref never execute hooks, filters, a shell or network access. */
function git(root: string, args: string[]): string {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG.*)$/i.test(key)) delete env[key]
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' })
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, env, windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'
  }).trimEnd()
}
/** Synchronous resolution keeps normalization, conflict check and publication atomic on the daemon. */
export function resolveWorkcopy(root: string): WorkcopyIdentity {
  if (!isAbsolute(root)) throw new DaemonError('E_INVALID_ARG', '需要原生上下文中的绝对工作目录。')
  const input = physical(root)
  let lines: string[]
  try { lines = git(input.path, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']).split(/\r?\n/) }
  catch {
    if (hasGitAncestor(input.path)) throw new DaemonError('E_CONFLICT', '无法核验实际 Git 工作副本，请检查目录或 Git 后重试。')
    const id = hash(['directory', input.id])
    return { id, canonicalRoot: input.path, repoRoot: null, worktreeGitDir: null, gitCommonDir: null, commonId: null, physicalId: input.id, branch: null, head: null, revision: hash([id]) }
  }
  if (lines.length !== 3 || lines.some(line => !line)) throw new DaemonError('E_CONFLICT', 'Git 工作副本身份不完整。')
  const repo = physical(resolve(input.path, lines[0])), directory = physical(resolve(input.path, lines[1])), common = physical(resolve(input.path, lines[2]))
  let branch: string | null, head: string | null
  try {
    const value = git(repo.path, ['symbolic-ref', '-q', 'HEAD'])
    branch = value || null
  } catch (error) {
    if ((error as { status?: unknown }).status !== 1) throw new DaemonError('E_CONFLICT', '无法核验当前 Git 分支，请重新检查环境。')
    branch = null
  }
  try { head = git(repo.path, ['rev-parse', '--verify', '--quiet', 'HEAD']) || null }
  catch (error) {
    if ((error as { status?: unknown }).status !== 1) throw new DaemonError('E_CONFLICT', '无法核验当前 Git HEAD，请重新检查环境。')
    head = null
  }
  const id = hash(['worktree', repo.id, directory.id])
  return { id, canonicalRoot: repo.path, repoRoot: repo.path, worktreeGitDir: directory.path, gitCommonDir: common.path,
    commonId: hash(['git-common', common.id]), physicalId: repo.id, branch, head,
    revision: hash([id, common.id, branch, head]) }
}
export function assertWorkcopyObservation(actual: WorkcopyIdentity, expected?: WorkcopyObservation): void {
  if (expected && (expected.id !== actual.id || expected.revision !== actual.revision)) throw new DaemonError('E_CONFLICT', '环境已变化：工作副本、分支或 HEAD 与原操作不一致，请重新核对。')
}
