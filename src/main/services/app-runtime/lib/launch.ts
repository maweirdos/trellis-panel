import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { ApplicationConfig } from '../../../../shared/app-runtime'
import { AppRuntimeError, type StoredApplication } from '../types'
import { IpcErrorCode } from '../../../../shared/ipc-errors'
import { loadEnvironment } from './env'
import { canonicalDirectory, reveal } from './persistence'
import { resolveWorkcopy } from '../../workcopy-use'

export interface LaunchPlan { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; secrets: string[]; fingerprint: string; inputFingerprint: string; command: string; envFiles: string[] }
// Approval comparisons are private to this native session. Persisted outputs are
// unusable for guessing command arguments, script contents or environment values.
const approvalKey = randomBytes(32)
function hash(value: string): string { return createHmac('sha256', approvalKey).update(value).digest('hex') }
function urlCredentials(value: string): string[] {
  try {
    const url = new URL(value)
    const secrets: string[] = []
    if (url.password) { secrets.push(url.password); try { secrets.push(decodeURIComponent(url.password)) } catch { /* Keep the original encoded credential. */ } }
    for (const [key, secret] of url.searchParams) {
      if (secret && /(?:token|secret|password|credential|api[_-]?key|private[_-]?key|signature|^sig$|^key$)/i.test(key)) secrets.push(secret)
      if (secrets.length >= 18) break
    }
    return secrets
  } catch { return [] }
}
function fileIdentity(file: string): string {
  try {
    const stat = statSync(file)
    const script = /\.(?:cmd|bat|ps1|sh|js|mjs|cjs|py)$/i.test(file)
    if (script && stat.size > 2 * 1024 * 1024) throw new Error('script limit')
    return `${realpathSync(file)}:${script ? hash(readFileSync(file, 'utf8')) : `${stat.size}:${stat.mtimeMs}`}`
  }
  catch { throw new AppRuntimeError('启动文件不存在或无法读取', IpcErrorCode.NotFound) }
}
export function resolveExecutable(value: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const windows = process.platform === 'win32'
  const paths = isAbsolute(value) || /[\\/]/.test(value) ? [''] : String(Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '').split(windows ? ';' : ':')
  const extensions = windows && !extname(value) ? ['', '.exe', '.cmd', '.bat', '.com'] : ['']
  for (const directory of paths) for (const extension of extensions) {
    const candidate = directory ? resolve(directory, value + extension) : resolve(cwd, value + extension)
    try { if (statSync(candidate).isFile()) return realpathSync(candidate) } catch { /* Try the next PATH candidate. */ }
  }
  throw new AppRuntimeError('找不到启动程序，请检查可执行文件路径或 PATH', IpcErrorCode.NotFound)
}
function batchAdapter(executable: string, args: string[]): { executable: string; args: string[] } {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) return { executable, args }
  // cmd has a second expansion layer. Unsupported metacharacters require explicit shell mode.
  if ([executable, ...args].some((arg) => /["%\!\^&|<>\r\n]/.test(arg))) throw new AppRuntimeError('批处理参数含 shell 字符，请使用明确的脚本命令模式', IpcErrorCode.InvalidArg)
  return { executable: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[executable, ...args].map((arg) => `"${arg}"`).join(' ')}"`] }
}
export function planLaunch(root: string, stored: StoredApplication): LaunchPlan {
  const config: ApplicationConfig = stored.config
  const cwd = canonicalDirectory(resolve(root, config.cwd))
  try { if (!statSync(cwd).isDirectory()) throw new Error('directory') } catch { throw new AppRuntimeError('工作目录不存在或无法访问', IpcErrorCode.NotFound) }
  const directory = statSync(cwd, { bigint: true })
  const workcopy = resolveWorkcopy(cwd)
  const overrides = Object.fromEntries(Object.entries(stored.protectedOverrides).map(([key, value]) => [key, reveal(value)]))
  const environment = loadEnvironment(cwd, config.envFiles, overrides)
  let executable: string
  let args: string[]
  const files: string[] = []
  let command: string
  if (config.launch.kind === 'script') {
    executable = resolveExecutable(process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', cwd, environment.env)
    args = process.platform === 'win32' ? ['/d', '/s', '/c', config.launch.command] : ['-c', config.launch.command]
    command = config.launch.command
    const first = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(command)
    const entryFile = first?.[1] ?? first?.[2] ?? first?.[3]
    if (entryFile && /\.(?:cmd|bat|ps1|sh|js|mjs|cjs|py)$/i.test(entryFile)) {
      const file = resolve(cwd, entryFile)
      if (existsSync(file)) files.push(fileIdentity(file))
    }
  } else if (config.launch.kind === 'npm-script') {
    const packageFile = join(cwd, 'package.json')
    let scripts: Record<string, unknown>
    try {
      if (statSync(packageFile).size > 1024 * 1024) throw new Error('size')
      const pkg: unknown = JSON.parse(readFileSync(packageFile, 'utf8'))
      if (typeof pkg !== 'object' || pkg === null || !('scripts' in pkg) || typeof pkg.scripts !== 'object' || pkg.scripts === null) throw new Error('scripts')
      scripts = pkg.scripts as Record<string, unknown>
    } catch { throw new AppRuntimeError('package.json 无法读取或没有脚本', IpcErrorCode.InvalidArg) }
    const script = config.launch.script
    if (typeof scripts[script] !== 'string') throw new AppRuntimeError('所选 npm 脚本已不存在', IpcErrorCode.NotFound)
    files.push(hash(JSON.stringify([scripts[`pre${script}`], scripts[script], scripts[`post${script}`]])))
    const npm = resolveExecutable('npm', cwd, environment.env)
    const cli = join(dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (process.platform === 'win32' && existsSync(cli)) {
      executable = resolveExecutable(existsSync(join(dirname(npm), 'node.exe')) ? join(dirname(npm), 'node.exe') : 'node', cwd, environment.env)
      args = [cli, 'run', script]
      files.push(fileIdentity(cli))
    } else { const adapted = batchAdapter(npm, ['run', script]); executable = adapted.executable; args = adapted.args }
    command = `npm run ${JSON.stringify(script)}`
  } else {
    const resolved = resolveExecutable(config.launch.executable, cwd, environment.env)
    const adapted = batchAdapter(resolved, config.launch.args)
    executable = adapted.executable
    args = adapted.args
    files.push(fileIdentity(resolved))
    for (const arg of config.launch.args.slice(0, 2)) {
      const file = resolve(cwd, arg)
      if (!arg.startsWith('-') && /\.(?:js|mjs|cjs|py|ps1|sh|cmd|bat)$/i.test(arg) && existsSync(file)) {
        if (statSync(file).size > 2 * 1024 * 1024) throw new AppRuntimeError('启动脚本超过审批读取限额', IpcErrorCode.InvalidArg)
        files.push(hash(readFileSync(file, 'utf8')))
      }
    }
    command = [basename(resolved), ...config.launch.args.map((arg) => JSON.stringify(arg))].join(' ')
  }
  const fingerprint = hash(JSON.stringify({ cwd, physicalCwd: [String(directory.dev), String(directory.ino), String(directory.birthtimeNs)], workcopy: [workcopy.id, workcopy.revision], executable: fileIdentity(executable), args, files, envFiles: environment.files, overrides: stored.overrideRevision, environment: config.environment, workcopyAccess: config.workcopyAccess, ports: config.ports, readiness: config.readiness, stopTimeoutMs: config.stopTimeoutMs }))
  const supplied = [...environment.secrets, ...Object.entries(environment.env).flatMap(([key, value]) => /(?:secret|token|password|passwd|credential|api[_-]?key|private[_-]?key)/i.test(key) && value ? [value] : [])]
  const secrets = [...new Set(supplied.flatMap(value => [value, ...urlCredentials(value)]))]
  for (const secret of secrets.sort((a, b) => b.length - a.length)) if (secret) command = command.split(secret).join('[REDACTED]')
  // Private, short-lived comparison only: never persist or expose hashes of env values.
  const inputFingerprint = hash(JSON.stringify([fingerprint, environment.env]))
  return { executable, args, cwd, env: environment.env, secrets, fingerprint, inputFingerprint, command, envFiles: environment.files }
}
