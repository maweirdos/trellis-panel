import { app } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createDaemonContext, type DaemonContext } from '../../daemon/context'
import { processIdentity, sameOwner } from '../../daemon/native'
import { readLease, verifiedLease } from '../../daemon/lease'
import { DaemonError, daemonFailure } from '../../daemon/errors'
import { DaemonClient } from './client'
import { daemonConnectionPool } from './pool'
import type { DaemonApi, DaemonData, DaemonMethod, DaemonPayload, DaemonPreferences, DaemonResult, DaemonStatus } from '../../../shared/daemon'

let contextPromise: Promise<DaemonContext> | undefined
const context = (): Promise<DaemonContext> => contextPromise ??= createDaemonContext().catch((error: unknown) => { contextPromise = undefined; throw error })
export const daemonClientContext = context
/** Native ordinary RPC callers share this lane. Do not close the returned client. */
export async function pooledDaemonClient(): Promise<DaemonClient> { return daemonConnectionPool(await context()).get() }
export async function daemonIsAbsent(): Promise<boolean> { return !await verifiedLease(await context()) }
async function call<M extends DaemonMethod>(method: M, payload: DaemonPayload<M>): Promise<DaemonResult<DaemonData<M>>> {
  try {
    const pool = daemonConnectionPool(await context())
    const client = method === 'daemon.status' ? await pool.getControl() : await pool.get()
    return await client.request(method, payload)
  }
  catch (error) { return daemonFailure(error) }
}
let statusPromise: Promise<DaemonResult<DaemonStatus>> | undefined
function status(): Promise<DaemonResult<DaemonStatus>> {
  if (statusPromise) return statusPromise
  const pending = call('daemon.status', {})
  statusPromise = pending
  void pending.finally(() => { if (statusPromise === pending) statusPromise = undefined })
  return pending
}
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200))
let startPromise: Promise<DaemonResult<DaemonStatus>> | undefined
async function start(): Promise<DaemonResult<DaemonStatus>> {
  if (startPromise) return startPromise
  startPromise = (async () => {
    try {
      const native = await context()
      if (readLease(native)) {
        const attached = await status()
        if (attached.ok || await verifiedLease(native)) return attached
      }
      const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--trellis-role=daemon', `--trellis-user-data-base64=${Buffer.from(native.userData).toString('base64')}`]
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.TPANEL_DEBUG_PORT
      // Inherit stderr without a parent-owned pipe: early loader failures remain
      // visible, and a retained daemon does not keep the GUI alive through stdio.
      const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'], env })
      let launchFailed = false, exited = false, exitCode: number | null = null
      child.once('error', () => { launchFailed = true })
      child.once('exit', code => { exited = true; exitCode = code })
      child.unref()
      const deadline = Date.now() + 12_000
      let lastFailure: import('../../../shared/daemon').DaemonFailure | undefined
      while (Date.now() < deadline && !launchFailed) {
        await pause()
        const lease = readLease(native)
        if (lease) {
          const result = await status()
          if (result.ok) return result
          lastFailure = result
          // Retrying cannot repair identity, version or protected-key failures.
          if (['E_DENIED', 'E_VERSION', 'E_CONFLICT'].includes(result.code)) return result
        }
        if (exited || launchFailed) break
      }
      if (launchFailed) throw new DaemonError('E_UNAVAILABLE', 'The native daemon process could not be launched. Its original ownership state was preserved.')
      if (exited) throw new DaemonError('E_UNAVAILABLE', `The daemon process exited before authenticated readiness (exit ${exitCode ?? 'unknown'}). Inspect its startup diagnostic in stderr and existing owner/state before another start.`)
      if (lastFailure) return lastFailure
      throw new DaemonError('E_UNKNOWN', 'Daemon startup was not confirmed. Check status before another start; do not delete or steal its lease.', 'unknown')
    } catch (error) { return daemonFailure(error) }
  })()
  try { return await startPromise } finally { startPromise = undefined }
}
async function stop(): Promise<DaemonResult<null>> {
  let client: DaemonClient | undefined
  let commandId: string | undefined
  let acknowledged = false
  try {
    const native = await context()
    const lease = await verifiedLease(native)
    if (!lease) return { ok: true, data: null }
    client = await DaemonClient.connect(native)
    if (client.epoch !== lease.epoch || !sameOwner(client.lease.owner, lease.owner)) throw new DaemonError('E_CONFLICT', 'The original daemon owner changed before stop; no stop command was submitted.')
    commandId = randomUUID()
    const result = await client.request('daemon.stop', { expectedOwner: lease.owner }, { commandId })
    if (!result.ok) return result
    acknowledged = true
    client.close(); client = undefined
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const actual = await processIdentity(lease.owner.pid)
      if (!actual || !sameOwner(actual, lease.owner)) return { ok: true, data: null }
      await pause()
    }
    throw new DaemonError('E_UNKNOWN', 'The original daemon has not confirmed exit. Restart is blocked; inspect its original owner.', 'unknown')
  } catch (error) {
    return daemonFailure(acknowledged ? new DaemonError('E_UNKNOWN', 'The original stop command was acknowledged, but its owner exit could not be verified. Inspect that command before restarting.', 'unknown') : error, commandId)
  }
  finally { client?.close() }
}
export const daemonManager: DaemonApi = {
  protocolVersion: 1, status, start, stop,
  async restart() { const result = await stop(); return result.ok ? start() : result },
  preferences: () => call('daemon.preferences.get', {}),
  setPreferences: (input: DaemonPreferences) => call('daemon.preferences.set', input),
  reconcileStartup: (originalCommandId) => call('daemon.startup.reconcile', { originalCommandId }),
  logs: (input) => call('daemon.logs', input)
}
