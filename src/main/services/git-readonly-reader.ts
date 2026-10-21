/** Bounded process reader used only by the read-only Git viewer. */
import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { IpcErrorCode } from '../../shared/ipc-errors'

export const GIT_METADATA_CAP = 2 * 1024 * 1024
export const GIT_DIFF_CAP = 128 * 1024
const STDERR_CAP = 32 * 1024
const READ_TIMEOUT_MS = 10_000

export class GitReadError extends Error {
  constructor(public readonly code: IpcErrorCode, message: string) {
    super(message)
    this.name = 'GitReadError'
  }
}

type ReadOptions = { maxBytes?: number; allowTruncated?: boolean; stdin?: string }
type ReadResult = { out: string; err: string; code: number; truncated: boolean }

/** No shell, optional index writes, fsmonitor hooks, external diff, or lazy fetch. */
export function readGit(root: string, args: string[], options: ReadOptions = {}): Promise<ReadResult> {
  const maxBytes = options.maxBytes ?? GIT_METADATA_CAP
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete env[key]
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' })
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', '--literal-pathspecs',
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'protocol.allow=never',
      '-c', 'diff.external=', '-c', 'diff.suppressBlankEmpty=false', '-c', 'color.ui=false', '-c', 'log.showSignature=false', ...args],
    { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let outBytes = 0, errBytes = 0, settled = false
    const decode = (chunks: Buffer[]): string => new StringDecoder('utf8').write(Buffer.concat(chunks))
    const finish = (error?: GitReadError, code = 0, truncated = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error || truncated) {
        child.kill()
        child.stdout.destroy()
        child.stderr.destroy()
        child.stdin.destroy()
      }
      if (error) reject(error)
      else resolve({ out: decode(stdout), err: decode(stderr), code, truncated })
    }
    const timer = setTimeout(() => finish(new GitReadError(IpcErrorCode.Timeout, 'Git 读取超时，请缩小仓库或稍后重试')), READ_TIMEOUT_MS)
    child.on('error', (error: NodeJS.ErrnoException) => finish(new GitReadError(
      error.code === 'ENOENT' ? IpcErrorCode.NotFound : IpcErrorCode.Io,
      error.code === 'ENOENT' ? '未找到 Git，请安装 Git 并确保其位于 PATH 中' : '无法启动 Git 读取进程')))
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      const remaining = maxBytes - outBytes
      if (remaining > 0) stdout.push(chunk.subarray(0, remaining))
      outBytes += chunk.length
      if (outBytes > maxBytes) finish(options.allowTruncated ? undefined : new GitReadError(
        IpcErrorCode.Io, 'Git 元数据超过读取上限，请缩小仓库后重试'), 0, true)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return
      const remaining = STDERR_CAP - errBytes
      if (remaining > 0) stderr.push(chunk.subarray(0, remaining))
      errBytes += chunk.length
      if (errBytes > STDERR_CAP) finish(new GitReadError(IpcErrorCode.Io, 'Git 错误输出超过读取上限'))
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // Git may close stdin before a bounded write completes; close reports its error.
      if (error.code !== 'EPIPE' && error.code !== 'EOF') finish(new GitReadError(IpcErrorCode.Io, '无法传递 Git 读取参数'))
    })
    child.on('close', (code) => finish(undefined, code ?? 1))
    child.stdin.end(options.stdin)
  })
}

export async function checkedGit(root: string, args: string[], options?: ReadOptions): Promise<ReadResult> {
  const result = await readGit(root, args, options)
  if (result.code !== 0) throw new GitReadError(IpcErrorCode.Io, result.err.trim() || 'Git 读取失败')
  return result
}
