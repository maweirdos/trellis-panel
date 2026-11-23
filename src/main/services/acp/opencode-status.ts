import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import type { AcpProcessLaunch, AcpProcessStarted } from './v2'
import { z } from 'zod'
import type { AcpRuntimeRetry } from '../../../shared/types'
import { acpSpawnEnv } from '../../../shared/acp-launch-options'
import { batchShell } from './setup'
import { parseReleaseVersion } from './native-releases'
import { OwnedProbeCleanupError } from '../workcopy-use/owned-probe'

const versionReads = new Map<string, Promise<boolean>>()

/** Selected CLI only, with the same child environment. Unknown versions disable v1-only flags. */
export interface OpenCodeVersionProbe { scopeKey: string; run(target: string, args: string[], env: NodeJS.ProcessEnv, verbatim: boolean): Promise<{ code: number; stdout: string }> }
export async function isOpenCodeV1(executable: string | undefined, overlay: Record<string, string>, ownedProbe?: OpenCodeVersionProbe): Promise<boolean> {
  if (!executable) return false
  const env = acpSpawnEnv(process.env, overlay, process.platform)
  let key: string
  try {
    const stat = statSync(executable, { bigint: true })
    key = createHash('sha256').update(JSON.stringify([realpathSync.native(executable), String(stat.dev), String(stat.ino),
      String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), ownedProbe?.scopeKey ?? '', Object.entries(env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)])).digest('hex')
  } catch { return false }
  const pending = versionReads.get(key)
  if (pending) return pending
  const { target, argv, batch } = batchShell(executable, ['--version'])
  if (process.platform === 'win32' && !ownedProbe) throw new OwnedProbeCleanupError()
  const reading = ownedProbe ? ownedProbe.run(target, argv, env, batch).then(result => result.code === 0 && parseReleaseVersion(result.stdout.trim().match(/^(?:opencode\s+)?v?(.+)$/i)?.[1])?.major === 1) : new Promise<boolean>(resolve => execFile(target, argv,
    { env, windowsHide: true, windowsVerbatimArguments: batch, timeout: 5000, maxBuffer: 4096, encoding: 'utf8' },
    (error, stdout) => resolve(!error && parseReleaseVersion(stdout.trim().match(/^(?:opencode\s+)?v?(.+)$/i)?.[1])?.major === 1)))
  versionReads.set(key, reading)
  try { return await reading } catch (error) { if (ownedProbe) throw error; return false } finally { if (versionReads.get(key) === reading) versionReads.delete(key) }
}

const retrySchema = z.object({
  type: z.literal('retry'), attempt: z.number().int().min(1).max(1_000_000),
  message: z.string().max(4000), next: z.number().int().nonnegative().max(8_640_000_000_000_000),
  action: z.object({ reason: z.string().max(80), provider: z.string().max(80).optional() }).optional()
})
interface Endpoint { launchId: string; port: number; password: string; process?: AcpProcessStarted }
interface Turn {
  turnId: string
  generation: string
  backendSessionId: string
  deadlineAt: number
  current: () => boolean
  update: (retry: AcpRuntimeRetry | undefined) => void
  cancel: (retry: AcpRuntimeRetry) => void
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(error => error ? reject(error) : typeof address === 'object' && address ? resolve(address.port) : reject(new Error('Loopback unavailable')))
    })
  })
}

/** Confirm the listener belongs to this live launch or its native child, including npm .cmd shims. */
async function ownsWindowsEndpoint(endpoint: Endpoint): Promise<boolean> {
  const started = endpoint.process
  if (!started || process.platform !== 'win32') return false
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  // Only internally generated integers enter this read-only command; credentials never do.
  const script = `$ErrorActionPreference='Stop'; $rootProcess=Get-CimInstance Win32_Process -Filter 'ProcessId=${started.pid}'; if(!$rootProcess){exit}; `
    + `$birth=([DateTimeOffset]$rootProcess.CreationDate).ToUnixTimeMilliseconds(); if([Math]::Abs($birth-${Date.parse(started.startedAt)}) -gt 5000){exit}; `
    + `$listenerIds=@(& "$env:SystemRoot\\System32\\netstat.exe" -ano -p tcp | ForEach-Object {if($_ -match '^\\s*TCP\\s+127\\.0\\.0\\.1:${endpoint.port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$'){[int]$matches[1]}}); `
    + `foreach($listenerId in $listenerIds){$ownedId=$listenerId; for($depth=0;$depth -lt 12;$depth++){if($ownedId -eq ${started.pid}){Write-Output 'owned'; exit}; `
    + `$childProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$ownedId"; if(!$childProcess -or ([DateTimeOffset]$childProcess.CreationDate).ToUnixTimeMilliseconds() -lt $birth){break}; $ownedId=$childProcess.ParentProcessId}}`
  return new Promise(resolve => execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 2500, maxBuffer: 1024, encoding: 'utf8' }, (error, stdout) => resolve(!error && stdout.trim() === 'owned')))
}

function readStatus(endpoint: Endpoint, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: endpoint.port, path: '/session/status', method: 'GET', signal,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString('base64')}` } }, response => {
      if (response.statusCode !== 200) { response.destroy(); reject(new Error('Native status unavailable')); return }
      let bytes = 0
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 64 * 1024) { response.destroy(new Error('Native status exceeded limit')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('Native status invalid')) } })
    })
    const timer = setTimeout(() => req.destroy(new Error('Native status deadline exceeded')), 1500)
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
    req.end()
  })
}

/** Read-only native retry evidence; ACP remains the only prompt, control and terminal authority. */
export class OpenCodeStatus {
  private launchId?: string
  private endpoint?: Endpoint
  private watch?: AbortController
  private timer?: NodeJS.Timeout
  constructor(private readonly sessionKey: string, private readonly compatibleArgs: boolean, private readonly verifyV1: () => Promise<boolean>) {}

  async prepareSpawn(launch: AcpProcessLaunch): Promise<{ appendArgs?: string[]; env?: Record<string, string> }> {
    if (launch.scope.kind !== 'runtime-session' || launch.scope.sessionKey !== this.sessionKey) return {}
    this.exited()
    this.launchId = launch.launchId
    if (process.platform !== 'win32' || !this.compatibleArgs) return {}
    try {
      if (!await this.verifyV1() || this.launchId !== launch.launchId) return {}
      const port = await freeLoopbackPort()
      if (this.launchId !== launch.launchId) return {}
      const password = randomBytes(32).toString('hex')
      this.endpoint = { launchId: launch.launchId, port, password }
      return { appendArgs: ['--hostname', '127.0.0.1', '--port', String(port)], env: { OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password } }
    } catch (error) { if (error instanceof OwnedProbeCleanupError) throw error; return {} }
  }
  spawned(started: AcpProcessStarted): boolean {
    if (started.launchId !== this.launchId) return false
    if (started.launchId === this.endpoint?.launchId) this.endpoint.process = started
    return true
  }
  exited(launchId?: string): boolean {
    if (launchId && launchId !== this.launchId) return false
    this.stopTurn()
    this.endpoint = undefined
    this.launchId = undefined
    return true
  }
  stopTurn(): void {
    this.watch?.abort()
    this.watch = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
  watchTurn(turn: Turn): void {
    this.stopTurn()
    const endpoint = this.endpoint
    if (!endpoint?.process) return
    const controller = new AbortController()
    this.watch = controller
    let previous = ''
    const active = (): boolean => !controller.signal.aborted && this.watch === controller && this.endpoint === endpoint && turn.current()
    const clean = (value: string): string => {
      const decoded = value.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\+u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\+x([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\\+\//g, '/')
      if (/-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----/i.test(decoded)) return '[REDACTED]'
      return decoded.replaceAll(endpoint.password, '[REDACTED]')
        .replaceAll(Buffer.from(`opencode:${endpoint.password}`).toString('base64'), '[REDACTED]')
        .replace(/\b((?:proxy-)?authorization\s*[:=])[^\r\n]*/gi, '$1 [REDACTED]')
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, '$1 [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]+/gi, '[REDACTED]')
        .replace(/\b((?:api[-_]?key|access[-_]?token|password|passwd|secret|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
        .replaceAll(`127.0.0.1:${endpoint.port}`, '[local runtime]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512)
    }
    const poll = async (): Promise<void> => {
      if (!active()) return
      try {
        if (!await ownsWindowsEndpoint(endpoint) || !active()) return
        const body = await readStatus(endpoint, controller.signal)
        if (!active()) return
        const value = body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, turn.backendSessionId)
          ? (body as Record<string, unknown>)[turn.backendSessionId] : undefined
        const parsed = retrySchema.safeParse(value)
        const retry: AcpRuntimeRetry | undefined = parsed.success ? { turnId: turn.turnId, connectionGeneration: turn.generation,
          attempt: parsed.data.attempt, nextAt: parsed.data.next, message: clean(parsed.data.message),
          reason: parsed.data.action ? clean(parsed.data.action.reason) : undefined, provider: parsed.data.action?.provider ? clean(parsed.data.action.provider) : undefined } : undefined
        const key = JSON.stringify(retry) ?? ''
        if (key !== previous) { previous = key; turn.update(retry) }
        if (retry?.reason === 'free_tier_limit' && retry.nextAt >= turn.deadlineAt) {
          this.stopTurn()
          if (turn.current()) turn.cancel(retry)
          return
        }
      } catch { /* Auxiliary diagnostics cannot fail or complete the ACP turn. */ }
      finally {
        if (active()) { this.timer = setTimeout(() => { void poll() }, 2000); this.timer.unref() }
      }
    }
    this.timer = setTimeout(() => { void poll() }, 500)
    this.timer.unref()
  }
}
