import { app } from 'electron'
import { createDaemonContext, createLifecycleControlContext, type DaemonContext } from '../../daemon/context'
import { processIdentity, sameOwner } from '../../daemon/native'
import { readLease, verifiedLease } from '../../daemon/lease'
import { currentDaemonBuild, daemonBuildFreshness, requireCurrentDaemonBuild } from '../../daemon/build-identity'
import { readDaemonStartupFailure } from '../../daemon/startup-failure'
import { launchDaemonProcess } from '../../daemon/launch'
import { DaemonError, daemonFailure } from '../../daemon/errors'
import { DaemonClient } from './client'
import { runDaemonLifecycle, type LifecycleConfirmation, type LifecycleOptions } from './lifecycle'
import { daemonConnectionPool } from './pool'
import { assertLifecycleReleased } from '../../daemon/lifecycle-fence'
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
const failure = (error: unknown): ReturnType<typeof daemonFailure> => daemonFailure(error,
  error instanceof Error && 'commandId' in error && typeof error.commandId === 'string' ? error.commandId : undefined)
let confirmLifecycle: (input: LifecycleConfirmation) => Promise<boolean> = async () => {
  throw new DaemonError('E_BUSY', '此后台可能有执行中的会话，请从桌面确认停止后重试。')
}
let runLifecycle = runDaemonLifecycle
export function configureLifecycleConfirmation(confirm: typeof confirmLifecycle, runner: typeof runDaemonLifecycle = runDaemonLifecycle): void {
  confirmLifecycle = confirm
  runLifecycle = runner
}
export async function stopDaemonForLifecycle(options: Omit<LifecycleOptions, 'confirm' | 'targetBuild'> & Partial<Pick<LifecycleOptions, 'confirm' | 'targetBuild'>>): Promise<void> {
  const native = await createLifecycleControlContext()
  await runLifecycle(native, { ...options, targetBuild: options.targetBuild ?? currentDaemonBuild().sha256, confirm: options.confirm ?? confirmLifecycle })
  contextPromise = undefined
}
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
async function startOwned(): Promise<DaemonResult<DaemonStatus>> {
  return (async () => {
    try {
      const inspection = await createLifecycleControlContext()
      const existing = readLease(inspection)
      if (existing) {
        const live = await processIdentity(existing.owner.pid)
        if (live && sameOwner(live, existing.owner)) {
          const freshness = daemonBuildFreshness(inspection, existing)
          // Ordinary same-build attachment preserves executing work and epoch.
          if (freshness.state === 'current' && existing.identity.appVersion === app.getVersion()) {
            const attached = await status()
            if (!attached.ok) return attached
            if (attached.data.epoch !== existing.epoch || !sameOwner(attached.data.owner, existing.owner)) throw new DaemonError('E_CONFLICT', '后台接回时原 owner 已变化。')
            if (attached.data.state !== 'running') throw new DaemonError('E_UNAVAILABLE', '原后台正在退出，请核对原退出请求。')
            return attached
          }
          await runLifecycle(inspection, { reason: 'build-change', targetBuild: currentDaemonBuild().sha256, confirm: confirmLifecycle })
          contextPromise = undefined
        }
      }
      const native = await context()
      assertLifecycleReleased(native)
      if (await verifiedLease(native)) throw new DaemonError('E_CONFLICT', 'A daemon owner appeared before launch. Retry attachment; no replacement was started.')
      const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--trellis-role=daemon', `--trellis-user-data-base64=${Buffer.from(native.userData).toString('base64')}`]
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.TPANEL_DEBUG_PORT; delete env.CRUX_DEV_LAUNCH_ID; delete env.CRUX_DEV_LAUNCH_PID; delete env.CRUX_DEV_LAUNCH_ROOT
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
    } catch (error) { return failure(error) }
  })()
}
async function stopOwned(): Promise<DaemonResult<null>> {
  try {
    // This explicit Stop is already authorized by its quit/settings/CLI caller.
    await stopDaemonForLifecycle({ reason: 'restart', confirm: async () => true })
    return { ok: true, data: null }
  } catch (error) { return failure(error) }
}
function stop(): Promise<DaemonResult<null>> {
  return lifecycle('stop', stopOwned)
}
function start(): Promise<DaemonResult<DaemonStatus>> { return lifecycle('start', startOwned) }
export const daemonManager: DaemonApi = {
  protocolVersion: 1, status, start, stop,
  restart: () => lifecycle('restart', async () => {
    try { await stopDaemonForLifecycle({ reason: 'restart' }); return startOwned() }
    catch (error) { return failure(error) }
  }),
  preferences: () => call('daemon.preferences.get', {}),
  setPreferences: (input: DaemonPreferences) => call('daemon.preferences.set', input),
  reconcileStartup: (originalCommandId) => call('daemon.startup.reconcile', { originalCommandId }),
  logs: (input) => call('daemon.logs', input)
}
