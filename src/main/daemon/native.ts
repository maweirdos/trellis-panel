import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { processOwnerSchema, type ProcessOwner } from '../../shared/daemon'
import { DaemonError } from './errors'
import { nativeDiagnosticSchema } from './native-diagnostic'
import { fastIsDirectoryProtected, fastProcessIdentity, fastProtectDirectory } from './win32-fast'

export function nativeResource(name: string): string {
  const installed = join(process.resourcesPath, 'daemon', name)
  const development = join(__dirname, '../../resources/daemon', name)
  const file = existsSync(installed) ? installed : development
  if (!existsSync(file)) throw new DaemonError('E_UNAVAILABLE', 'Daemon native resources are missing. Rebuild or reinstall this application.')
  return file
}
export function powershellPath(): string {
  const systemRoot = process.env.SystemRoot
  if (process.platform !== 'win32' || !systemRoot) throw new DaemonError('E_UNAVAILABLE', 'This daemon adapter requires Windows and Windows PowerShell.')
  return join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
}
async function native(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativeResource('windows-native.ps1'), ...args], { windowsHide: true, timeout: 7000, maxBuffer: 16 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        let diagnostic = ''
        let metadata: ReturnType<typeof nativeDiagnosticSchema.parse> | undefined
        try {
          const failure = nativeDiagnosticSchema.parse(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()))
          metadata = failure
          diagnostic = ` (${failure.operation}/${failure.exception}/${failure.hresult}${failure.command ? `/${failure.command}` : ''}${failure.line ? `/line ${failure.line}` : ''})`
        } catch { /* Never include arbitrary native stderr or exception payloads. */ }
        const operation = args[1] === 'identity' ? 'process identity' : 'directory protection'
        reject(Object.assign(new DaemonError('E_UNAVAILABLE', `Windows daemon ${operation} failed${diagnostic}. Inspect the existing owner and directory protection before retrying.`), metadata ? { nativeDiagnostic: metadata } : {})); return
      }
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())) } catch { reject(new DaemonError('E_UNAVAILABLE', 'Native identity adapter returned invalid data.')) }
    })
  })
}
const identityResultSchema = z.discriminatedUnion('state', [z.object({ state: z.literal('present'), owner: processOwnerSchema }), z.object({ state: z.literal('absent') })])
export async function processIdentity(pid: number): Promise<ProcessOwner | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new DaemonError('E_INVALID_ARG', 'Invalid process identity.')
  const fast = fastProcessIdentity(pid)
  if (fast !== undefined) return fast ? processOwnerSchema.parse(fast) : null
  const value = identityResultSchema.parse(await native(['-Operation', 'identity', '-ProcessId', String(pid)]))
  return value.state === 'present' ? value.owner : null
}
export function sameOwner(a: ProcessOwner, b: ProcessOwner): boolean {
  if (a.pid !== b.pid || a.userId !== b.userId) return false
  if (a.startedAt !== b.startedAt) {
    try { if (BigInt(a.startedAt) / 10n !== BigInt(b.startedAt) / 10n) return false }
    catch { return false }
  }
  if (a.executable.toLowerCase() === b.executable.toLowerCase()) return true
  try { return realpathSync.native(a.executable).toLowerCase() === realpathSync.native(b.executable).toLowerCase() }
  catch { return false }
}
const inFlightProtections = new Map<string, Promise<void>>()
export async function protectDirectory(directory: string): Promise<void> {
  if (fastIsDirectoryProtected(directory) || fastProtectDirectory(directory)) return
  const key = process.platform === 'win32' ? directory.toLowerCase() : directory
  const existing = inFlightProtections.get(key)
  if (existing) return existing
  const work = (async () => {
    if (fastIsDirectoryProtected(directory) || fastProtectDirectory(directory)) return
    const result = await native(['-Operation', 'secure-directory', '-DirectoryBase64', Buffer.from(directory, 'utf8').toString('base64')])
    if (!z.object({ ok: z.literal(true) }).safeParse(result).success) throw new DaemonError('E_DENIED', 'The daemon directory could not be restricted to the current Windows user.')
  })()
  inFlightProtections.set(key, work)
  try { await work } finally { if (inFlightProtections.get(key) === work) inFlightProtections.delete(key) }
}

let cachedGuardianHash: string | null | undefined
function guardianBinaryHash(): string | null {
  if (cachedGuardianHash !== undefined) return cachedGuardianHash
  try {
    const core = readFileSync(nativeResource('windows-lifecycle-native.cs'))
    const entry = readFileSync(nativeResource('windows-guardian-main.cs'))
    const archTag = process.arch === 'ia32' ? 'x86' : 'x64'
    cachedGuardianHash = createHash('sha256').update(core).update(entry).update(`|guardian-v1|${archTag}`).digest('hex')
    return cachedGuardianHash
  } catch {
    cachedGuardianHash = null
    return null
  }
}

/**
 * 返回受保护 native-cache 目录内预编译的轻量原生 guardian 可执行文件（~14KB），
 * 仅在目录通过独占 DACL 核验且目标为非符号链接普通文件时启用，否则无缝回退 PowerShell 脚本。
 */
export function cachedGuardianExecutable(cacheDir: string): string | undefined {
  if (process.platform !== 'win32') return undefined
  const hash = guardianBinaryHash()
  if (!hash) return undefined
  try {
    if (!existsSync(cacheDir) || lstatSync(cacheDir).isSymbolicLink()) return undefined
    if (!fastIsDirectoryProtected(cacheDir) && !fastProtectDirectory(cacheDir)) return undefined
    const candidate = join(cacheDir, `crux-guardian-${hash}.exe`)
    if (!existsSync(candidate)) return undefined
    const stat = lstatSync(candidate)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) return undefined
    return candidate
  } catch {
    return undefined
  }
}
