import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type { GitCommitInfo, TaskGitInfo } from '../../shared/types'

const CACHE_TTL = 30_000
const cache = new Map<string, { at: number; data: TaskGitInfo }>()

function git(root: string, args: string[], timeoutMs = 10_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: root, windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout?.on('data', (d) => (out += d.toString('utf-8')))
    child.stderr?.on('data', (d) => (err += d.toString('utf-8')))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, out, err: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, out, err })
    })
  })
}

export function isGitRepo(root: string): boolean {
  return existsSync(join(root, '.git'))
}

export async function taskGitInfo(root: string, dirName: string, branch: string | null, baseBranch: string | null): Promise<TaskGitInfo> {
  const key = `${root}::${dirName}::${branch}::${baseBranch}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data

  const info: TaskGitInfo = {
    dirName,
    branchExists: false,
    currentBranch: null,
    ahead: 0,
    behind: 0,
    merged: false,
    commits: [],
    worktreeDirty: false
  }

  try {
    if (!isGitRepo(root)) {
      info.error = '项目不是 git 仓库'
      return info
    }
    if (!branch) {
      info.error = '任务未关联分支'
      return info
    }

    const cur = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    info.currentBranch = cur.ok ? cur.out.trim() : null

    const show = await git(root, ['rev-parse', '--verify', branch])
    info.branchExists = show.ok
    if (!show.ok) {
      info.error = `分支 ${branch} 不存在`
      cache.set(key, { at: Date.now(), data: info })
      return info
    }

    const base = baseBranch || 'main'
    const baseExists = (await git(root, ['rev-parse', '--verify', base])).ok
    if (baseExists) {
      const ab = await git(root, ['rev-list', '--left-right', '--count', `${base}...${branch}`])
      if (ab.ok) {
        const [behind, ahead] = ab.out.trim().split(/\s+/).map((x) => parseInt(x, 10) || 0)
        info.behind = behind
        info.ahead = ahead
      }
      const merged = await git(root, ['merge-base', '--is-ancestor', branch, base])
      info.merged = merged.ok
    }

    const log = await git(root, [
      'log', branch, '-8',
      '--pretty=format:%h%x09%an%x09%ci%x09%s'
    ])
    if (log.ok) {
      info.commits = log.out
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [short, author, date, ...rest] = line.split('\t')
          return { short, hash: '', author, date, subject: rest.join('\t') } as GitCommitInfo
        })
    }

    const dirty = await git(root, ['status', '--porcelain'])
    info.worktreeDirty = dirty.ok && dirty.out.trim().length > 0

    cache.set(key, { at: Date.now(), data: info })
    return info
  } catch (e: any) {
    info.error = e?.message ?? 'git 执行失败'
    return info
  }
}

export async function createBranch(root: string, name: string, fromBase: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^[\w./-]+$/.test(name)) return { ok: false, error: '分支名包含非法字符' }
  const res = await git(root, ['checkout', '-b', name, fromBase])
  if (!res.ok) {
    const res2 = await git(root, ['checkout', name])
    if (!res2.ok) return { ok: false, error: res.err || res2.err || '创建分支失败' }
  }
  return { ok: true }
}

export function clearGitCache(): void {
  cache.clear()
}
