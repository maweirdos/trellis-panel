import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { isGitRepo } from '../git'
import { DOCUMENT_DIFF_SIDE_LIMIT_BYTES } from '../../../shared/documents'
import { computeRevision } from './controller'

/**
 * Git 最近提交基线（S0 G2，design §6.2）：`git show <commit>:<path>` 取上一版内容。
 *
 * - 参数数组调用（不经 shell）、cwd 固定 repo 根；只接受 rev-parse 校验过的提交对象
 *   （40 hex）与 repo 内相对路径（正斜杠、无 .. 逃逸）。
 * - 无仓库 / 无提交 / 未跟踪 / 路径不在提交中 → 各自明确状态与中文说明
 *   （中性降级，不是错误伪装）；不实现任意两个提交选择器。
 * - 输出收集有 2MiB 硬上限（与 diff 每侧限额一致），超限即终止子进程。
 */

const GIT_TIMEOUT_MS = 10_000
const COMMIT_RE = /^[0-9a-f]{40}$/i

export type GitBaselineFailureStatus =
  | 'no-repo'
  | 'no-commits'
  | 'untracked'
  | 'not-in-commit'
  | 'too-large'
  | 'git-unavailable'

/** 判别联合：status=ok 时 text/revision/commit 齐备；失败时全空 + 中文降级说明。 */
export type GitBaseline =
  | {
      status: 'ok'
      text: string
      revision: string
      commit: string
      message: null
      detail: Record<string, unknown>
    }
  | {
      status: GitBaselineFailureStatus
      text: null
      revision: null
      commit: null
      /** 面向用户的中文降级说明。 */
      message: string
      /** 机器可读补充（shortCommit、git 错误摘要等；不含本机绝对路径）。 */
      detail: Record<string, unknown>
    }

interface GitRunResult {
  code: number | null
  out: Buffer
  err: string
  spawnError: string | null
  timedOut: boolean
  outputTruncated: boolean
}

function runGit(root: string, args: string[], maxOutputBytes: number): Promise<GitRunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', args, { cwd: root, windowsHide: true })
    } catch (e) {
      resolve({ code: null, out: Buffer.alloc(0), err: '', spawnError: String((e as Error)?.message ?? e), timedOut: false, outputTruncated: false })
      return
    }
    const chunks: Buffer[] = []
    let outBytes = 0
    let truncated = false
    let err = ''
    let timedOut = false
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        out: Buffer.concat(chunks),
        err,
        spawnError: null,
        timedOut,
        outputTruncated: truncated
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, GIT_TIMEOUT_MS)
    child.stdout?.on('data', (d: Buffer) => {
      if (truncated) return
      outBytes += d.byteLength
      chunks.push(d)
      if (outBytes > maxOutputBytes) {
        truncated = true
        child.kill()
      }
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (err.length < 4000) err += d.toString('utf-8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve({ code: null, out: Buffer.concat(chunks), err, spawnError: e.message, timedOut, outputTruncated: truncated })
    })
    child.on('close', (code) => finish(code))
  })
}

const errSummary = (r: GitRunResult): string =>
  (r.spawnError ?? r.err ?? '').split(/\r?\n/).find((l) => l.trim().length > 0)?.slice(0, 200) ?? ''

/** repo 内相对路径守卫：正斜杠、非绝对、无空段/.. 逃逸/通配符注入。 */
function validRepoRelative(p: string): boolean {
  if (!p || p.includes('\0') || p.startsWith('/') || p.includes('\\')) return false
  const segs = p.split('/')
  return segs.every((s) => s.length > 0 && s !== '.' && s !== '..' && !/[*?[\]]/.test(s))
}

/**
 * 取 HEAD 提交中该路径的文本内容。
 * @param root 项目根（已打开工作区；cwd 固定于此）
 * @param repoRelativePath 相对 repo 根的正斜杠路径（调用方已做边界校验，这里再守卫一次）
 */
export async function latestCommitBaseline(root: string, repoRelativePath: string): Promise<GitBaseline> {
  const fail = (status: GitBaselineFailureStatus, message: string, detail: Record<string, unknown> = {}): GitBaseline => ({
    status,
    text: null,
    revision: null,
    commit: null,
    message,
    detail
  })

  if (!validRepoRelative(repoRelativePath)) {
    return fail('not-in-commit', '路径不是仓库内有效的相对路径，无法取最近提交版本', { path: repoRelativePath })
  }
  if (!isGitRepo(root)) {
    return fail('no-repo', '当前目录不是 Git 仓库，没有“最近提交”基线可比较')
  }

  // HEAD 提交对象：rev-parse 校验后才允许进入 `git show <commit>:<path>`
  const head = await runGit(root, ['rev-parse', '--verify', 'HEAD'], 1024)
  if (head.spawnError !== null || head.code === null) {
    return fail('git-unavailable', '无法调用 git，取不到最近提交版本', { detail: errSummary(head) })
  }
  if (head.code !== 0) {
    return fail('no-commits', '仓库还没有任何提交，没有最近提交基线可比较', { detail: errSummary(head) })
  }
  const commit = head.out.toString('utf-8').trim()
  if (!COMMIT_RE.test(commit)) {
    return fail('git-unavailable', 'git 返回的提交对象无法校验，已放弃最近提交基线', { detail: `bad commit id: ${commit.slice(0, 12)}` })
  }

  const maxBytes = DOCUMENT_DIFF_SIDE_LIMIT_BYTES
  const show = await runGit(root, ['show', `${commit}:${repoRelativePath}`], maxBytes)
  if (show.spawnError !== null) {
    return fail('git-unavailable', '无法调用 git，取不到最近提交版本', { detail: errSummary(show) })
  }
  if (show.outputTruncated) {
    return fail('too-large', `最近提交版本超过对比上限 ${maxBytes / 1024 / 1024}MiB，未取回全文`, {
      limitBytes: maxBytes,
      commit: commit.slice(0, 8)
    })
  }
  if (show.code !== 0) {
    // 区分：未跟踪（不在索引）vs 路径不在该提交中（已 add 未提交 / 已重命名移动）
    const tracked = await runGit(root, ['ls-files', '--error-unmatch', '--', repoRelativePath], 1024)
    if (tracked.code === 0) {
      return fail('not-in-commit', '路径在最近提交中不存在（可能是新增后尚未提交，或已被重命名/移动）', {
        commit: commit.slice(0, 8),
        detail: errSummary(show)
      })
    }
    return fail('untracked', '文件未纳入 Git 跟踪，没有提交历史可比较', { commit: commit.slice(0, 8) })
  }

  let text = show.out.toString('utf-8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return {
    status: 'ok',
    text,
    revision: computeRevision(show.out),
    commit,
    message: null,
    detail: { commit: commit.slice(0, 8) }
  }
}

/** 供诊断构造：HEAD 短哈希探测（轻量，仅用于 UI 展示“最近提交”标识）。 */
export async function headShortCommit(root: string): Promise<string | null> {
  if (!existsSync(join(root, '.git'))) return null
  const r = await runGit(root, ['rev-parse', '--short', 'HEAD'], 1024)
  if (r.code !== 0 || r.spawnError !== null) return null
  const s = r.out.toString('utf-8').trim()
  return /^[0-9a-f]{7,12}$/i.test(s) ? s : null
}
