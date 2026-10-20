import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { AppRuntimeError, type ProcessIdentity } from '../types'
import { IpcErrorCode } from '../../../../shared/ipc-errors'

const SYSTEM_QUERY_TIMEOUT = 7000
function runFile(file: string, args: string[], timeout = SYSTEM_QUERY_TIMEOUT): Promise<string> {
  return new Promise((accept, reject) => execFile(file, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : accept(stdout)))
}
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean { return a.pid === b.pid && a.createdAt === b.createdAt && a.commandHash === b.commandHash }

export async function processSnapshot(timeoutMs = SYSTEM_QUERY_TIMEOUT): Promise<ProcessIdentity[]> {
  if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;@(Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;createdAt=([string]$_.CreationDate.ToUniversalTime().Ticks);executable=$_.ExecutablePath;command=$_.CommandLine} }) | ConvertTo-Json -Compress"
    const raw: unknown = JSON.parse((await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], timeoutMs)).replace(/^\uFEFF/, ''))
    if (!Array.isArray(raw)) throw new AppRuntimeError('无法核验进程身份', IpcErrorCode.Io)
    return raw.flatMap((item: unknown) => {
      if (typeof item !== 'object' || item === null) return []
      const row = item as Record<string, unknown>
      if (typeof row.pid !== 'number' || row.pid < 1 || typeof row.parentPid !== 'number' || typeof row.createdAt !== 'string') return []
      return [{ pid: row.pid, parentPid: row.parentPid, createdAt: row.createdAt, executable: typeof row.executable === 'string' ? row.executable : null, commandHash: createHash('sha256').update(typeof row.command === 'string' ? row.command : '').digest('hex') }]
    })
  }
  if (process.platform === 'linux') {
    return readdirSync('/proc').flatMap((name) => {
      if (!/^\d+$/.test(name)) return []
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        return [{ pid: Number(name), parentPid: Number(fields[1]), createdAt: fields[19], executable: null, commandHash: createHash('sha256').update(readFileSync(`/proc/${name}/cmdline`)).digest('hex') }]
      } catch { return [] }
    })
  }
  throw new AppRuntimeError('当前系统无法核验应用进程树', IpcErrorCode.Denied)
}

/** Only descendants of a process whose exact identity we own enter the registry. */
export function ownedTree(snapshot: ProcessIdentity[], rootPid: number, known: ProcessIdentity[]): ProcessIdentity[] {
  const owned = new Map<number, ProcessIdentity>()
  for (const identity of known) {
    const current = snapshot.find((row) => sameProcess(row, identity))
    if (current) owned.set(current.pid, current)
  }
  const root = snapshot.find((row) => row.pid === rootPid)
  if (root && (known.length === 0 || known.some((row) => sameProcess(root, row)))) owned.set(root.pid, root)
  let added = true
  while (added) {
    added = false
    for (const row of snapshot) if (!owned.has(row.pid) && owned.has(row.parentPid)) { owned.set(row.pid, row); added = true }
  }
  return [...owned.values()]
}

export function spawnOwned(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(executable, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
}

export async function terminateOwned(identities: ProcessIdentity[], rootPid: number | null, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const remainingBudget = (): number => { const left = deadline - Date.now(); if (left <= 0) throw new AppRuntimeError('停止超时，仍需核验应用进程', IpcErrorCode.Timeout, 'CLEANUP_REQUIRED'); return Math.min(left, SYSTEM_QUERY_TIMEOUT) }
  const before = await processSnapshot(remainingBudget())
  const live = identities.filter((identity) => before.some((row) => sameProcess(row, identity)))
  if (live.length === 0) return
  const root = live.find((identity) => identity.pid === rootPid)
  if (process.platform === 'win32') {
    // Verify every target just before signalling; never authorize a persisted PID alone.
    const targets = root ? [root, ...live.filter((identity) => identity !== root)] : live
    let current = before
    for (const identity of targets) {
      if (!current.some((row) => sameProcess(row, identity))) continue
      try { await runFile('taskkill.exe', ['/PID', String(identity.pid), ...(identity === root ? ['/T'] : []), '/F'], remainingBudget()) }
      catch {
        const after = await processSnapshot(remainingBudget())
        if (after.some((row) => sameProcess(row, identity))) throw new AppRuntimeError('进程树停止失败，请重试停止', IpcErrorCode.Io, 'CLEANUP_REQUIRED')
      }
      current = await processSnapshot(remainingBudget())
      if (!live.some((known) => current.some((row) => sameProcess(row, known)))) return
    }
  } else {
    if (root) { try { process.kill(-root.pid, 'SIGTERM') } catch { /* Checked below. */ } }
    for (const identity of live) { try { process.kill(identity.pid, 'SIGTERM') } catch { /* Checked below. */ } }
  }
  let forced = process.platform === 'win32'
  while (Date.now() < deadline) {
    const current = await processSnapshot(remainingBudget())
    const remaining = live.filter((identity) => current.some((row) => sameProcess(row, identity)))
    if (remaining.length === 0) return
    if (!forced && Date.now() > deadline - Math.floor(timeoutMs / 2)) {
      forced = true
      for (const identity of remaining) { try { process.kill(identity.pid, 'SIGKILL') } catch { /* Verified on the next pass. */ } }
    }
    await new Promise((accept) => setTimeout(accept, 100))
  }
  throw new AppRuntimeError('停止超时，仍有应用进程需要清理', IpcErrorCode.Timeout, 'CLEANUP_REQUIRED')
}
