import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { join } from 'node:path'
import { GIT_WORKSPACE_LIMITS } from '../../../../shared/git-workspace'
import { IpcErrorCode } from '../../../../shared/ipc-errors'
import { GitWorkspaceError } from '../types'

export interface GitCommandOptions {
  input?: string | Buffer
  indexFile?: string
  timeoutMs?: number
  maxBytes?: number
  network?: boolean
  allowFailure?: boolean
  config?: string[]
}
export interface GitCommandResult { stdout: string; stderr: string; code: number }

export function redactGitText(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:access_token|private_token|token|password|key)=)[^\s&]+/gi, '$1[REDACTED]')
    .replace(/(authorization:\s*(?:bearer|basic)\s+)[^\s]+/gi, '$1[REDACTED]')
}

export function runGit(root: string, args: string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/i.test(key)) delete env[key]
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' })
  if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile
  const configs = ['core.fsmonitor=false', 'core.untrackedCache=false', 'color.ui=false', 'diff.external=', 'diff.suppressBlankEmpty=false', 'log.showSignature=false', 'protocol.ext.allow=never', ...(options.network ? [] : ['protocol.allow=never']), ...(options.config ?? [])]
  return new Promise((accept, reject) => {
    const child = spawn('git', ['--no-optional-locks', '--literal-pathspecs', ...configs.flatMap((item) => ['-c', item]), ...args], { cwd: root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = [], err: Buffer[] = []
    let stdoutBytes = 0, stderrBytes = 0, failure: GitWorkspaceError | null = null
    const cap = options.maxBytes ?? GIT_WORKSPACE_LIMITS.outputBytes
    let settled = false, terminating = false
    const finish = (code: number | null): void => {
      if (settled || terminating) return
      settled = true
      clearTimeout(timer)
      if (failure) { reject(failure); return }
      const decode = (buffers: Buffer[]): string => new StringDecoder('utf8').write(Buffer.concat(buffers))
      const result = { stdout: decode(out), stderr: redactGitText(decode(err)), code: code ?? 1 }
      if (result.code !== 0 && !options.allowFailure) reject(new GitWorkspaceError(IpcErrorCode.Io, result.stderr.trim() || 'Git 操作失败'))
      else accept(result)
    }
    const fail = (error: GitWorkspaceError): void => {
      if (failure || settled) return
      failure = error
      terminating = true
      child.stdin.destroy()
      let done = false
      const stopped = (verified: boolean): void => {
        if (done) return
        done = true
        clearTimeout(deadline)
        if (!verified) {
          error.retainIndexLock = true
          error.extra.uncertain = true
          error.message += '；无法确认子进程已结束，暂存区锁和临时快照已保留，请先核验进程后再手动清理'
          if (child.exitCode === null && child.signalCode === null) child.kill()
        }
        child.stdout.destroy(); child.stderr.destroy()
        terminating = false
        finish(null)
      }
      // Kill only this invocation's process tree. Never scan or adopt unrelated Git processes.
      const deadline = setTimeout(() => { stopper?.kill(); stopped(false) }, 2000)
      let stopper: ReturnType<typeof spawn> | undefined
      if (!child.pid) { stopped(true); return }
      if (child.exitCode !== null || child.signalCode !== null) { stopped(false); return }
      if (process.platform === 'win32') {
        try {
          stopper = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          stopper.once('error', () => stopped(false))
          stopper.once('close', (code) => stopped(code === 0))
        } catch { stopped(false) }
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); child.once('close', () => stopped(true)) }
        catch { stopped(false) }
      }
    }
    const timer = setTimeout(() => fail(new GitWorkspaceError(IpcErrorCode.Timeout, options.network ? '推送超时，远端结果尚未确认，请先核验远端后重试' : 'Git 操作超时，请刷新状态后核验', { uncertain: true })), options.timeoutMs ?? (options.network ? GIT_WORKSPACE_LIMITS.pushTimeoutMs : GIT_WORKSPACE_LIMITS.localTimeoutMs))
    child.once('error', (error: NodeJS.ErrnoException) => { failure ??= new GitWorkspaceError(error.code === 'ENOENT' ? IpcErrorCode.NotFound : IpcErrorCode.Io, error.code === 'ENOENT' ? '未找到 Git，请安装并配置 PATH' : '无法启动 Git'); finish(null) })
    child.stdout.on('data', (chunk: Buffer) => { const available = cap - stdoutBytes; if (available > 0) out.push(chunk.subarray(0, available)); stdoutBytes += chunk.length; if (stdoutBytes > cap) fail(new GitWorkspaceError(IpcErrorCode.Io, 'Git 输出超过读取上限，请缩小操作范围', { uncertain: true })) })
    child.stderr.on('data', (chunk: Buffer) => { const available = 32768 - stderrBytes; if (available > 0) err.push(chunk.subarray(0, available)); stderrBytes += chunk.length; if (stderrBytes > 32768) fail(new GitWorkspaceError(IpcErrorCode.Io, 'Git 错误输出超过读取上限', { uncertain: true })) })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (!['EPIPE', 'EOF'].includes(error.code ?? '')) fail(new GitWorkspaceError(IpcErrorCode.Io, '无法传递 Git 输入')) })
    child.once('close', finish)
    child.stdin.end(options.input)
  })
}
