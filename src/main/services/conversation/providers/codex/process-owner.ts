import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { WorkcopyOwner } from '../../../../../shared/workcopy-use'
import { DaemonError } from '../../../../daemon/errors'
import { readBounded, writeAtomic } from '../../../../daemon/files'
import type { AcpProcessLaunch } from '../../../acp/v2'
import { createAcpJobOwner, isAcpJobOwnerCleaned, recoverAcpJobOwner } from '../../../workcopy-use/acp-jobs'

type CodexProcessOptions = {
  readonly ownerKind?: 'acp-v2' | 'claude' | 'opencode'
  readonly instanceId: string
  readonly directory: string
  readonly cwd: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly assertCanSpawn: () => void
}

export type CodexOwnedProcess = {
  readonly child: ChildProcessWithoutNullStreams
  readonly ready: Promise<void>
  close(): Promise<void>
}

const generationSchema = z.string().uuid()
const windowsOpenings = new Set<string>()
const failedStartupCleanups = new Map<string, () => Promise<void>>()
const DIRECT_TERMINATE_GRACE_MS = 2_000
const DIRECT_CLOSE_TIMEOUT_MS = 5_000

function observeSpawn(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      child.off('spawn', started)
      reject(error)
    }
    const started = (): void => {
      child.off('error', fail)
      if (child.pid === undefined) reject(new DaemonError('E_UNAVAILABLE', 'Codex app-server did not report its process ID.'))
      else resolve(child.pid)
    }
    child.once('error', fail)
    child.once('spawn', started)
  })
}

function ownedProcess(
  child: ChildProcessWithoutNullStreams,
  ready: Promise<void>,
  cleanup: () => Promise<void>,
): CodexOwnedProcess {
  void ready.catch(() => undefined)
  let closing: Promise<void> | undefined
  return {
    child,
    ready,
    close() {
      return closing ??= cleanup().catch(error => {
        closing = undefined
        throw error
      })
    },
  }
}

function cleanupUnknown(cause?: unknown): DaemonError {
  return Object.assign(
    new DaemonError('E_UNKNOWN', 'Codex app-server 进程清理尚未确认，原所有者记录已保留。', 'unknown'),
    { cause },
  )
}

async function closeDirectProcess(child: ChildProcessWithoutNullStreams, started: Promise<number>): Promise<void> {
  if (await started.catch(() => undefined) === undefined || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const signal = (name: NodeJS.Signals): void => {
      try { child.kill(name) } catch { }
    }
    const exited = (): void => {
      clearTimeout(escalate)
      clearTimeout(deadline)
      resolve()
    }
    const escalate = setTimeout(() => signal('SIGKILL'), DIRECT_TERMINATE_GRACE_MS)
    const deadline = setTimeout(() => {
      child.off('exit', exited)
      reject(cleanupUnknown())
    }, DIRECT_CLOSE_TIMEOUT_MS)
    child.once('exit', exited)
    signal('SIGTERM')
  })
}

async function recoverPrevious(directory: string, previous: WorkcopyOwner): Promise<void> {
  try {
    if (isAcpJobOwnerCleaned(directory, previous)) return
    if (await recoverAcpJobOwner(directory, previous)) return
  } catch (error) {
    if (error instanceof DaemonError && error.code === 'E_CONFLICT') throw error
    throw cleanupUnknown(error)
  }
  throw cleanupUnknown()
}

function readGeneration(pointer: string): string {
  try { return generationSchema.parse(JSON.parse(readBounded(pointer, 256))) }
  catch (error) { throw cleanupUnknown(error) }
}

async function spawnWindowsProcess(options: CodexProcessOptions): Promise<CodexOwnedProcess> {
  const directory = realpathSync.native(options.directory)
  const cwd = realpathSync.native(options.cwd)
  const kind = options.ownerKind ?? 'codex'
  const id = `${kind}-${createHash('sha256').update(JSON.stringify([options.instanceId, cwd.toLowerCase()])).digest('hex')}`
  const pointer = join(directory, `conversation-${kind}-process-owners`, `${id}.json`)
  const key = pointer.toLowerCase()
  if (windowsOpenings.has(key)) throw new DaemonError('E_CONFLICT', 'Codex app-server 正在为此工作目录启动。')
  windowsOpenings.add(key)
  try {
    await failedStartupCleanups.get(key)?.()
    const owner: WorkcopyOwner = { kind: 'agent', id, generation: randomUUID(), label: kind === 'codex' ? 'Codex app-server' : kind }
    if (existsSync(pointer)) {
      await recoverPrevious(directory, { ...owner, generation: readGeneration(pointer) })
    }
    options.assertCanSpawn()
    const jobs = await createAcpJobOwner(directory, cwd, owner)
    const cleanup = async (): Promise<void> => {
      try { await jobs.cleanupAll() }
      catch (error) { throw cleanupUnknown(error) }
      failedStartupCleanups.delete(key)
    }
    try {
      options.assertCanSpawn()
      if (realpathSync.native(options.cwd).toLowerCase() !== cwd.toLowerCase()) {
        throw new DaemonError('E_CONFLICT', 'Codex app-server 启动前工作目录已变化。')
      }
      writeAtomic(pointer, JSON.stringify(owner.generation), { retryWindowsRename: true })
      const launch: AcpProcessLaunch = {
        launchId: randomUUID(),
        purpose: 'agent',
        scope: { kind: 'runtime-session', sessionKey: owner.id },
        cwd,
        command: options.command,
        args: options.args,
      }
      const child = jobs.spawn(launch, { cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
      const ready = observeSpawn(child).then(pid => jobs.spawned({ ...launch, pid, startedAt: new Date().toISOString() }))
      return ownedProcess(child, ready, cleanup)
    } catch (error) {
      failedStartupCleanups.set(key, cleanup)
      await cleanup()
      throw error
    }
  } finally { windowsOpenings.delete(key) }
}

export async function spawnCodexOwnedProcess(options: CodexProcessOptions): Promise<CodexOwnedProcess> {
  options.assertCanSpawn()
  if (!isAbsolute(options.cwd) || !isAbsolute(options.command)) {
    throw new DaemonError('E_INVALID_ARG', 'Codex app-server 需要绝对可执行文件路径与工作目录。')
  }
  if (process.platform === 'win32') return spawnWindowsProcess(options)
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const started = observeSpawn(child)
  return ownedProcess(child, started.then(() => undefined), () => closeDirectProcess(child, started))
}
