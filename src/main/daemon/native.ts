import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { processOwnerSchema, type ProcessOwner } from '../../shared/daemon'
import { DaemonError } from './errors'
import { nativeDiagnosticSchema } from './native-diagnostic'

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
  const value = identityResultSchema.parse(await native(['-Operation', 'identity', '-ProcessId', String(pid)]))
  return value.state === 'present' ? value.owner : null
}
export function sameOwner(a: ProcessOwner, b: ProcessOwner): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt && a.userId === b.userId && a.executable.toLowerCase() === b.executable.toLowerCase()
}
export async function protectDirectory(directory: string): Promise<void> {
  const result = await native(['-Operation', 'secure-directory', '-DirectoryBase64', Buffer.from(directory, 'utf8').toString('base64')])
  if (!z.object({ ok: z.literal(true) }).safeParse(result).success) throw new DaemonError('E_DENIED', 'The daemon directory could not be restricted to the current Windows user.')
}
