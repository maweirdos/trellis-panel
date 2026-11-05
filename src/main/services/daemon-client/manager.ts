import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { createDaemonContext, type DaemonContext } from '../../daemon/context'
import { processIdentity, sameOwner } from '../../daemon/native'
import { readLease, verifiedLease, type DaemonLease } from '../../daemon/lease'
import { daemonBuildFreshness, requireCurrentDaemonBuild } from '../../daemon/build-identity'
import { readDaemonStartupFailure } from '../../daemon/startup-failure'
import { launchDaemonProcess } from '../../daemon/launch'
import { DaemonError, daemonFailure } from '../../daemon/errors'
import { DaemonClient } from './client'
import { daemonConnectionPool } from './pool'
import type { DaemonApi, DaemonData, DaemonMethod, DaemonPayload, DaemonPreferences, DaemonResult, DaemonStatus } from '../../../shared/daemon'

let contextPromise: Promise<DaemonContext> | undefined
const context = (): Promise<DaemonContext> => contextPromise ??= createDaemonContext().catch((error: unknown) => { contextPromise = undefined; throw error })
export const daemonClientContext = context
/** Native ordinary RPC callers share this lane. Do not close the returned client. */
export async function pooledDaemonClient(): Promise<DaemonClient> {
  const native = await context(), client = await daemonConnectionPool(native).get()
  requireCurrentDaemonBuild(native, client.lease)
  return client
}
export async function daemonIsAbsent(): Promise<boolean> { return !await verifiedLease(await context()) }
export async function daemonBuildFreshnessForCurrentOwner(status?: DaemonStatus): Promise<ReturnType<typeof daemonBuildFreshness> | undefined> {
  const native = await context(), lease = await verifiedLease(native)
  if (!lease) return undefined
  if (status && (status.epoch !== lease.epoch || !sameOwner(status.owner, lease.owner))) return undefined
  return daemonBuildFreshness(native, lease)
}
async function call<M extends DaemonMethod>(method: M, payload: DaemonPayload<M>): Promise<DaemonResult<DaemonData<M>>> {
  try {
    const pool = daemonConnectionPool(await context())
    // Management remains available to inspect/recover an outdated native owner.
    const client = await pool.getControl()
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
type BuildStop = { lease: DaemonLease; commandId: string }
let buildStop: BuildStop | undefined
let explicitStop: { lease: DaemonLease; commandId: string; acknowledged: boolean } | undefined
type TakeoverDecision =
  | { outcome: 'launch' }
  | { outcome: 'attach'; status: DaemonStatus }
  | { outcome: 'replace-if-idle' }
  | { outcome: 'busy'; reason: string }
  | { outcome: 'reconcile-stop'; commandId?: string; reason: string }
type LifecycleResults = { start: DaemonResult<DaemonStatus>; stop: DaemonResult<null>; restart: DaemonResult<DaemonStatus> }
let lifecycleTail: Promise<void> = Promise.resolve()
let lastLifecycle: { kind: keyof LifecycleResults; promise: Promise<unknown> } | undefined
/** Linearize tray, Settings, startup and quit. Coalesce only adjacent requests:
 * Start after a queued Stop must not join an earlier in-flight Start. */
function lifecycle<K extends keyof LifecycleResults>(kind: K, run: () => Promise<LifecycleResults[K]>): Promise<LifecycleResults[K]> {
  if (lastLifecycle?.kind === kind) return lastLifecycle.promise as Promise<LifecycleResults[K]>
  const work = lifecycleTail.then(run)
  lifecycleTail = work.then(() => {}, () => {})
  const entry = { kind, promise: work }
  lastLifecycle = entry
  const clear = (): void => { if (lastLifecycle === entry) lastLifecycle = undefined }
  void work.then(clear, clear)
  return work
}
async function waitForRelease(native: DaemonContext, lease: DaemonLease): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const actual = await processIdentity(lease.owner.pid)
    const current = readLease(native)
    if (current && JSON.stringify(current) !== JSON.stringify(lease)) throw new DaemonError('E_CONFLICT', 'A different daemon owner appeared during stop. No replacement was started.')
    if (!actual || !sameOwner(actual, lease.owner)) {
      if (!current) return
      throw new DaemonError('E_UNKNOWN', 'The original daemon exited without releasing its lease. Inspect the original stop command before restarting.', 'unknown')
    }
    await pause()
  }
  throw new DaemonError('E_UNKNOWN', 'The original daemon has not confirmed exit. Restart is blocked; inspect its original stop command.', 'unknown')
}
async function replaceOutdated(native: DaemonContext, lease: DaemonLease): Promise<void> {
  if (buildStop) throw new DaemonError('E_UNKNOWN', `Build replacement still retains stop command ${buildStop.commandId}. Inspect its original owner and receipt before restarting.`, 'unknown')
  const client = await DaemonClient.connect(native)
  try {
    if (JSON.stringify(client.lease) !== JSON.stringify(lease)) throw new DaemonError('E_CONFLICT', 'The daemon owner changed before idle-only stop. No stop command was submitted.')
    const fresh = daemonBuildFreshness(native, lease)
    if (fresh.state !== 'changed' || !fresh.idleStop) throw new DaemonError('E_CONFLICT', 'Daemon build evidence changed before idle-only stop. Retry attachment; no stop command was submitted.')
    const attempt: BuildStop = { lease, commandId: randomUUID() }
    buildStop = attempt
    const stopped = await client.request('daemon.stop', { expectedOwner: lease.owner, idleOnly: true }, { commandId: attempt.commandId })
    if (!stopped.ok) {
      if (stopped.outcome === 'not-admitted') buildStop = undefined
      if (stopped.code === 'E_BUSY') {
        const diagnostic = await status()
        const blockers = diagnostic.ok ? diagnostic.data.blockers ?? [] : []
        const detail = blockers.map((blocker: { label: string; state: string }) => `${blocker.label} (${blocker.state})`).join('; ')
        throw Object.assign(new DaemonError(stopped.code, `A daemon update is needed, but the original owner still has background work.${detail ? ` Blockers: ${detail}.` : ''} Active work was preserved.`, stopped.outcome), { commandId: attempt.commandId })
      }
      throw Object.assign(new DaemonError(stopped.code, stopped.error, stopped.outcome), { commandId: attempt.commandId })
    }
    client.close()
    await waitForRelease(native, lease)
    buildStop = undefined
  } finally { client.close() }
}
async function attachOrReplace(native: DaemonContext): Promise<DaemonResult<DaemonStatus> | TakeoverDecision> {
  const lease = await verifiedLease(native)
  if (!lease) return { outcome: 'launch' }
  const attached = await status()
  if (!attached.ok) return attached
  if (attached.data.epoch !== lease.epoch || !sameOwner(attached.data.owner, lease.owner) || JSON.stringify(attached.data.identity) !== JSON.stringify(native.identity)) throw new DaemonError('E_CONFLICT', 'Daemon status changed owner while checking its build.')
  if (attached.data.state !== 'running') {
    const retained = explicitStop?.lease.epoch === lease.epoch && explicitStop.lease.nonce === lease.nonce ? explicitStop.commandId
      : buildStop?.lease.epoch === lease.epoch && buildStop.lease.nonce === lease.nonce ? buildStop.commandId
      : attached.data.stopCommandId
    return { outcome: 'reconcile-stop', ...(retained ? { commandId: retained } : {}), reason: 'The original daemon is still stopping. Inspect its retained stop command and background cleanup before starting a successor.' }
  }
  if (attached.data.blockers?.length) {
    return { outcome: 'busy', reason: `The original daemon still owns active or uncertain work: ${attached.data.blockers.map(blocker => `${blocker.label} (${blocker.state})`).join('; ')}.` }
  }
  const freshness = daemonBuildFreshness(native, lease)
  if (freshness.state === 'current') {
    return { outcome: 'attach', status: attached.data }
  }
  if (!freshness.idleStop) requireCurrentDaemonBuild(native, lease)
  return { outcome: 'replace-if-idle' }
}
async function startOwned(): Promise<DaemonResult<DaemonStatus>> {
  return (async () => {
    try {
      const native = await context()
      if (explicitStop) {
        await waitForRelease(native, explicitStop.lease)
        explicitStop = undefined
      }
      // An uncertain automatic stop is never replayed under a fresh command ID.
      if (buildStop) {
        await waitForRelease(native, buildStop.lease)
        buildStop = undefined
      }
      if (readLease(native)) {
        const attached = await attachOrReplace(native)
        if ('ok' in attached) return attached
        if (attached.outcome === 'attach') return { ok: true, data: attached.status }
        if (attached.outcome === 'busy') throw new DaemonError('E_BUSY', attached.reason)
        if (attached.outcome === 'reconcile-stop') throw Object.assign(new DaemonError('E_UNAVAILABLE', attached.reason), attached.commandId ? { commandId: attached.commandId } : {})
        if (attached.outcome === 'replace-if-idle') await replaceOutdated(native, await verifiedLease(native) ?? (() => { throw new DaemonError('E_CONFLICT', 'The daemon owner changed before build replacement.') })())
      }
      if (await verifiedLease(native)) throw new DaemonError('E_CONFLICT', 'A daemon owner appeared before launch. Retry attachment; no replacement was started.')
      const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--trellis-role=daemon', `--trellis-user-data-base64=${Buffer.from(native.userData).toString('base64')}`]
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.TPANEL_DEBUG_PORT
      // Inherited stderr can itself be a control caller's pipe and prevent its
      // close event indefinitely. The bootstrap persists bounded failure facts.
      const launchedAt = Date.now()
      const child = await launchDaemonProcess(args, env)
      const deadline = Date.now() + 12_000
      let lastFailure: import('../../../shared/daemon').DaemonFailure | undefined
      while (Date.now() < deadline) {
        await pause()
        const lease = readLease(native)
        if (lease) {
          const result = await status()
          if (result.ok) {
            requireCurrentDaemonBuild(native, lease)
            if (result.data.epoch !== lease.epoch || !sameOwner(result.data.owner, lease.owner) || result.data.state !== 'running') throw new DaemonError('E_CONFLICT', 'Daemon readiness belongs to a different or stopping owner.')
            return result
          }
          lastFailure = result
          // Retrying cannot repair identity, version or protected-key failures.
          if (['E_DENIED', 'E_VERSION', 'E_CONFLICT'].includes(result.code)) return result
        }
        const diagnostic = readDaemonStartupFailure(native.directory, child.pid, launchedAt)
        if (diagnostic) throw new DaemonError('E_UNAVAILABLE', diagnostic.slice(0, 400))
      }
      const actual = await processIdentity(child.pid)
      if (!actual) throw new DaemonError('E_UNAVAILABLE', 'The original daemon exited before authenticated readiness. Preserve its startup diagnostic and owner/state.')
      if (lastFailure) return lastFailure
      throw new DaemonError('E_UNKNOWN', 'Daemon startup was not confirmed. Check status before another start; do not delete or steal its lease.', 'unknown')
    } catch (error) { return daemonFailure(error, explicitStop?.commandId ?? buildStop?.commandId ?? (error instanceof Error && 'commandId' in error && typeof error.commandId === 'string' ? error.commandId : undefined)) }
  })()
}
async function stopOwned(): Promise<DaemonResult<null>> {
  let client: DaemonClient | undefined
  let commandId: string | undefined
  let acknowledged = false
  try {
    const native = await context()
    if (!explicitStop && buildStop) {
      commandId = buildStop.commandId
      await waitForRelease(native, buildStop.lease)
      buildStop = undefined
      return { ok: true, data: null }
    }
    if (explicitStop) {
      commandId = explicitStop.commandId
      acknowledged = explicitStop.acknowledged
      // Other entrypoints only observe the original attempt. Neither a late
      // reply nor a repeated click authorizes a new stop UUID or replacement.
      await waitForRelease(native, explicitStop.lease)
      explicitStop = undefined
      return { ok: true, data: null }
    }
    const lease = await verifiedLease(native)
    if (!lease) return { ok: true, data: null }
    client = await DaemonClient.connect(native)
    if (JSON.stringify(client.lease) !== JSON.stringify(lease)) throw new DaemonError('E_CONFLICT', 'The original daemon owner changed before stop; no stop command was submitted.')
    commandId = randomUUID()
    explicitStop = { lease, commandId, acknowledged: false }
    const result = await client.request('daemon.stop', { expectedOwner: lease.owner }, { commandId })
    if (!result.ok) {
      if (result.outcome === 'not-admitted') explicitStop = undefined
      return result
    }
    acknowledged = true
    explicitStop.acknowledged = true
    client.close(); client = undefined
    await waitForRelease(native, lease)
    explicitStop = undefined
    return { ok: true, data: null }
  } catch (error) {
    return daemonFailure(acknowledged ? new DaemonError('E_UNKNOWN', 'The original stop command was acknowledged, but its owner exit could not be verified. Inspect that command before restarting.', 'unknown') : error, commandId)
  }
  finally { client?.close() }
}
function stop(): Promise<DaemonResult<null>> {
  return lifecycle('stop', stopOwned)
}
function start(): Promise<DaemonResult<DaemonStatus>> { return lifecycle('start', startOwned) }
export const daemonManager: DaemonApi = {
  protocolVersion: 1, status, start, stop,
  restart: () => lifecycle('restart', async () => { const result = await stopOwned(); return result.ok ? startOwned() : result }),
  preferences: () => call('daemon.preferences.get', {}),
  setPreferences: (input: DaemonPreferences) => call('daemon.preferences.set', input),
  reconcileStartup: (originalCommandId) => call('daemon.startup.reconcile', { originalCommandId }),
  logs: (input) => call('daemon.logs', input)
}
