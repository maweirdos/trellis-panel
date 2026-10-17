/**
 * C1/PF-09：工程代码只读查看。
 * 边界：只发读取类 git 命令（rev-parse / status / diff / log），无任何写副作用；
 * 无 Git 时中性降级；路径必须位于项目根内；输出有界，截断如实标注。
 */
import { resolve, sep } from 'path'
import { errorText } from '../../shared/errors'
import { isGitRepo, runGit } from './git'

export interface GitStatusEntry {
  path: string
  /** porcelain X：index 侧状态码 */
  x: string
  /** porcelain Y：worktree 侧状态码 */
  y: string
  /** 重命名/复制的原路径（-z 格式的附加 token） */
  origPath?: string
}

export interface GitReadonlyStatus {
  ok: boolean
  error?: string
  isRepo: boolean
  branch: string | null
  head: { short: string; subject: string } | null
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
  untracked: string[]
  scannedAt: number
}

const RENAME_CODES = new Set(['R', 'C'])

export async function gitReadonlyStatus(root: string): Promise<GitReadonlyStatus> {
  const base: GitReadonlyStatus = {
    ok: false, isRepo: false, branch: null, head: null, staged: [], unstaged: [], untracked: [], scannedAt: Date.now()
  }
  try {
    if (!isGitRepo(root)) {
      return { ...base, ok: true, error: '当前项目目录不是 git 仓库——只读视图不可用；任务与资料阅读不受影响' }
    }
    const out: GitReadonlyStatus = { ...base, isRepo: true }
    const br = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    out.branch = br.ok && br.out.trim() !== '' ? br.out.trim() : null
    const head = await runGit(root, ['log', '-1', '--pretty=format:%h%x09%s'])
    if (head.ok && head.out.trim() !== '') {
      const [short, ...rest] = head.out.trim().split('\t')
      out.head = { short, subject: rest.join('\t') }
    }
    const st = await runGit(root, ['status', '--porcelain=v1', '-z'])
    if (!st.ok) return { ...out, ok: false, error: st.err.trim() || 'git status 执行失败' }
    // -z：条目以 NUL 分隔；重命名条目在路径后再跟一个原路径 token
    const tokens = st.out.split('\0').filter((t) => t.length > 0)
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      const x = t[0]
      const y = t[1] ?? ' '
      const path = t.slice(3)
      if (x === '?' && y === '?') {
        out.untracked.push(path)
        continue
      }
      if (x !== ' ') {
        const entry: GitStatusEntry = { path, x, y }
        if (RENAME_CODES.has(x) && i + 1 < tokens.length) entry.origPath = tokens[++i]
        out.staged.push(entry)
      }
      if (y !== ' ') {
        const entry: GitStatusEntry = { path, x, y }
        if (RENAME_CODES.has(y) && i + 1 < tokens.length) entry.origPath = tokens[++i]
        out.unstaged.push(entry)
      }
    }
    return { ...out, ok: true }
  } catch (e) {
    return { ...base, ok: false, error: errorText(e, 'git 读取失败') }
  }
}

export interface GitFileDiffResult {
  ok: boolean
  error?: string
  path: string
  staged: boolean
  added: number
  removed: number
  binary: boolean
  diff: string
  truncated: boolean
}

const DIFF_CAP_BYTES = 128 * 1024

/** 相对路径防穿越：解析后必须仍在项目根内。 */
function contained(root: string, relPath: string): boolean {
  const abs = resolve(root, relPath)
  const rootAbs = resolve(root)
  return abs === rootAbs || abs.startsWith(rootAbs + sep)
}

export async function gitReadonlyFileDiff(root: string, relPath: string, staged: boolean): Promise<GitFileDiffResult> {
  const result: GitFileDiffResult = { ok: false, path: relPath, staged, added: 0, removed: 0, binary: false, diff: '', truncated: false }
  if (!contained(root, relPath)) return { ...result, error: '路径越界：只读差异仅限项目根内文件' }
  try {
    const numstat = await runGit(root, ['diff', '--numstat', ...(staged ? ['--cached'] : []), '--', relPath])
    if (numstat.ok && numstat.out.trim() !== '') {
      const [a, b] = numstat.out.trim().split('\t')
      if (a === '-') {
        result.binary = true
      } else {
        result.added = parseInt(a, 10) || 0
        result.removed = parseInt(b, 10) || 0
      }
    }
    const patch = await runGit(root, ['diff', '-U3', ...(staged ? ['--cached'] : []), '--', relPath])
    if (!patch.ok) return { ...result, error: patch.err.trim() || 'git diff 执行失败' }
    result.diff = patch.out
    result.truncated = patch.out.length >= DIFF_CAP_BYTES
    if (result.truncated) result.diff = patch.out.slice(0, DIFF_CAP_BYTES)
    result.ok = true
    return result
  } catch (e) {
    return { ...result, error: errorText(e, 'git diff 失败') }
  }
}
