import { DAEMON_LIMITS, type DaemonNotification, type DaemonStatus, type WorkspaceGrant } from '../../../shared/daemon'
import type { DaemonContext } from '../../daemon/context'
import { DaemonError } from '../../daemon/errors'
import { readLease } from '../../daemon/lease'
import { DaemonClient } from './client'

type Subscription = {
  client: DaemonClient
  workspace: WorkspaceGrant
  listeners: Set<(hint: DaemonNotification) => void>
  active: boolean
  syncing?: Promise<void>
  retry?: ReturnType<typeof setTimeout>
}
function admissionBusy(error: unknown): boolean { return error instanceof DaemonError && error.code === 'E_BUSY' && error.outcome === 'not-admitted' }
const pools = new Map<string, DaemonConnectionPool>()
/** Low-rate replay also repairs a lost hint. Older hosts explicitly use bounded polling. */
export const DAEMON_OBSERVATION = { hintMs: 25, healthMs: 15_000, fallbackMs: 1000, retryMs: 1000, pagesPerDrain: 4 } as const

/** One authenticated ordinary lane per native profile. No command retry lives here. */
export class DaemonConnectionPool {
  private client?: DaemonClient
  private connecting?: Promise<DaemonClient>
  private controlLane?: DaemonConnectionPool
  private generation = 0
  private disposed = false
  private readonly statuses = new WeakMap<DaemonClient, Promise<DaemonStatus>>()
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly disposeListeners = new Set<() => void>()
  constructor(readonly context: DaemonContext) {}

  /** One additional, lazily authenticated management lane. Status traffic never
   * competes with the ordinary socket's local 16-call / 1 MiB admission budget.
   * The manager coalesces fresh status reads; this lane never retries a command. */
  getControl(): Promise<DaemonClient> {
    if (this.disposed) return Promise.reject(new DaemonError('E_UNAVAILABLE', 'The desktop daemon connection has been detached.'))
    this.controlLane ??= new DaemonConnectionPool(this.context)
    return this.controlLane.get()
  }

  async get(): Promise<DaemonClient> {
    if (this.disposed) throw new DaemonError('E_UNAVAILABLE', 'The desktop daemon connection has been detached.')
    if (this.client) {
      try {
        // Local protected lease facts, not an expiring process/PID cache. Native
        // transport lifetime tracking closes the authenticated peer on actual exit.
        if (JSON.stringify(readLease(this.context)) !== JSON.stringify(this.client.lease)) this.client.close()
      } catch (error) { this.client?.close(); throw error }
      if (this.client?.connected) return this.client
    }
    if (this.connecting) return this.connecting
    const generation = this.generation
    const pending = DaemonClient.connect(this.context).then(client => {
      try {
        if (this.disposed || generation !== this.generation) throw new DaemonError('E_UNAVAILABLE', 'The original desktop connection attempt was detached.')
        if (!client.connected || JSON.stringify(readLease(this.context)) !== JSON.stringify(client.lease)) throw new DaemonError('E_CONFLICT', 'Daemon ownership changed while attaching.')
        this.client = client
        client.onDisconnect(() => {
          if (this.client !== client) return
          this.client = undefined
          for (const subscription of this.subscriptions.values()) if (subscription.retry) clearTimeout(subscription.retry)
          this.subscriptions.clear()
          this.statuses.delete(client)
        })
        client.onInvalidation(hint => {
          const subscription = this.subscriptions.get(hint.workspaceId)
          if (subscription?.client !== client) return
          for (const listener of [...subscription.listeners]) {
            try { listener(hint) }
            catch { process.emitWarning('Native workspace observer failed.', { code: 'TRELLIS_DAEMON_OBSERVER' }) }
          }
        })
        return client
      } catch (error) { client.close(); throw error }
    })
    this.connecting = pending
    try { return await pending }
    finally { if (this.connecting === pending) this.connecting = undefined }
  }

  /** Connection capabilities/one-way authority cutover only. Management status
   * uses a fresh RPC so mutable counts/preferences are never served from here. */
  status(client: DaemonClient): Promise<DaemonStatus> {
    const existing = this.statuses.get(client)
    if (existing) return existing
    const pending = client.request('daemon.status', {}).then(result => {
      if (!result.ok) throw new DaemonError(result.code, result.error, result.outcome)
      if (result.data.epoch !== client.epoch || JSON.stringify(result.data.owner) !== JSON.stringify(client.lease.owner) || JSON.stringify(result.data.identity) !== JSON.stringify(this.context.identity)) {
        client.close()
        throw new DaemonError('E_CONFLICT', 'Daemon status does not match its authenticated owner.')
      }
      if (result.data.runtimeAuthority !== 'daemon') this.statuses.delete(client)
      return result.data
    }).catch((error: unknown) => { this.statuses.delete(client); throw error })
    this.statuses.set(client, pending)
    return pending
  }

  /** Exact grant reference counting. Changes are serialized per workspace so a
   * late unsubscribe can never remove a newly acquired observer's subscription. */
  async subscribe(client: DaemonClient, workspace: WorkspaceGrant, listener: (hint: DaemonNotification) => void): Promise<() => void> {
    if (this.disposed || this.client !== client || !client.connected) throw new DaemonError('E_UNAVAILABLE', 'The observation connection was lost.')
    let entry = this.subscriptions.get(workspace.workspaceId)
    if (entry && JSON.stringify(entry.workspace) !== JSON.stringify(workspace)) throw new DaemonError('E_CONFLICT', 'The observed workspace grant changed. Release its original observers first.')
    if (!entry) {
      if (this.subscriptions.size >= DAEMON_LIMITS.connections) throw new DaemonError('E_BUSY', 'The desktop workspace subscription limit was reached.')
      entry = { client, workspace, listeners: new Set(), active: false }
      this.subscriptions.set(workspace.workspaceId, entry)
    }
    const subscription = entry
    const subscriptionListener = (hint: DaemonNotification): void => listener(hint)
    subscription.listeners.add(subscriptionListener)
    const release = (): void => {
      subscription.listeners.delete(subscriptionListener)
      if (this.subscriptions.get(workspace.workspaceId) !== subscription) return
      void this.syncSubscription(subscription).catch(error => {
        // A rejected unsubscribe changed no server state. Its bounded retry
        // stays with this exact subscription, without dropping admitted work.
        // Unknown acknowledgements still close the socket to revoke it.
        if (!admissionBusy(error)) client.close()
      })
    }
    try { await this.syncSubscription(subscription); return release }
    catch (error) { release(); throw error }
  }

  private retrySubscription(entry: Subscription): void {
    if (entry.retry || this.disposed || !entry.client.connected || this.subscriptions.get(entry.workspace.workspaceId) !== entry) return
    entry.retry = setTimeout(() => {
      entry.retry = undefined
      void this.syncSubscription(entry).catch(error => {
        if (!admissionBusy(error)) entry.client.close()
      })
    }, DAEMON_OBSERVATION.retryMs)
  }

  private async syncSubscription(entry: Subscription): Promise<void> {
    if (entry.syncing) { await entry.syncing; return this.syncSubscription(entry) }
    const pending = (async () => {
      while (!this.disposed && this.client === entry.client && this.subscriptions.get(entry.workspace.workspaceId) === entry) {
        const wanted = entry.listeners.size > 0
        if (entry.active === wanted) break
        const result = wanted
          ? await entry.client.request('events.subscribe', {}, { workspace: entry.workspace })
          : await entry.client.request('events.unsubscribe', {}, { workspace: entry.workspace })
        if (!result.ok) {
          if (result.code === 'E_BUSY' && result.outcome === 'not-admitted') this.retrySubscription(entry)
          if (result.outcome === 'unknown') entry.client.close()
          throw new DaemonError(result.code, result.error, result.outcome)
        }
        entry.active = wanted
      }
    })()
    entry.syncing = pending
    try { await pending }
    finally {
      entry.syncing = undefined
      if (!entry.active && entry.listeners.size === 0 && this.subscriptions.get(entry.workspace.workspaceId) === entry) {
        if (entry.retry) clearTimeout(entry.retry)
        this.subscriptions.delete(entry.workspace.workspaceId)
      }
    }
  }

  onDispose(listener: () => void): () => void {
    if (this.disposed) { listener(); return () => {} }
    this.disposeListeners.add(listener)
    return () => { this.disposeListeners.delete(listener) }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.generation++
    for (const listener of [...this.disposeListeners]) {
      try { listener() }
      catch { process.emitWarning('Native daemon observation disposal failed.', { code: 'TRELLIS_DAEMON_OBSERVER' }) }
    }
    this.disposeListeners.clear()
    for (const subscription of this.subscriptions.values()) if (subscription.retry) clearTimeout(subscription.retry)
    this.subscriptions.clear()
    this.controlLane?.dispose(); this.controlLane = undefined
    this.client?.close(); this.client = undefined
    if (pools.get(this.context.identity.profileId) === this) pools.delete(this.context.identity.profileId)
  }
}

export function daemonConnectionPool(context: DaemonContext): DaemonConnectionPool {
  const existing = pools.get(context.identity.profileId)
  if (existing) {
    if (JSON.stringify(existing.context.identity) !== JSON.stringify(context.identity)) throw new DaemonError('E_CONFLICT', 'A different installation owns the desktop profile connection.')
    return existing
  }
  const pool = new DaemonConnectionPool(context)
  pools.set(context.identity.profileId, pool)
  return pool
}
export function disposeDaemonPools(): void { for (const pool of [...pools.values()]) pool.dispose() }

/** Shared replay scheduler: one in-flight drain, one coalesced wake bit and one
 * timer. Reconnect only restores reads/subscriptions; drain owns cursor semantics. */
export function observePooledWorkspace(
  pool: DaemonConnectionPool,
  workspace: (client: DaemonClient) => Promise<WorkspaceGrant>,
  source: DaemonNotification['source'],
  drain: (client: DaemonClient, grant: WorkspaceGrant, current: () => boolean) => Promise<boolean>,
  unavailable: (error: unknown) => void
): () => void {
  let stopped = false, running = false, dirty = false, failures = 0, push = false, pressureReported = false
  let retryAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let timerAt = Infinity
  let attached: DaemonClient | undefined, grant: WorkspaceGrant | undefined
  let release: (() => void) | undefined, disconnect: (() => void) | undefined
  const schedule = (delay: number): void => {
    if (stopped) return
    delay = Math.max(delay, retryAt - Date.now())
    const at = Date.now() + delay
    if (timer && timerAt <= at) return
    if (timer) clearTimeout(timer)
    timerAt = at
    timer = setTimeout(() => { timer = undefined; timerAt = Infinity; void run() }, delay)
  }
  const wake = (delay: number = DAEMON_OBSERVATION.hintMs): void => { dirty = true; if (!running) schedule(delay) }
  const run = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    let failed = false
    try {
      const client = await pool.get()
      if (stopped) return
      if (attached !== client) {
        release?.(); release = undefined; disconnect?.()
        attached = client; grant = undefined
        disconnect = client.onDisconnect(() => { retryAt = 0; wake(0) })
        const status = await pool.status(client)
        if (stopped) return
        const captured = await workspace(client)
        if (stopped) return
        push = status.capabilities.includes('push-events')
        if (push) {
          const dispose = await pool.subscribe(client, captured, hint => { if (hint.source === source) wake() })
          if (stopped) { dispose(); return }
          release = dispose
        }
        grant = captured
      }
      if (!grant) throw new DaemonError('E_UNAVAILABLE', 'The workspace observation is not attached.')
      for (let page = 0; page < DAEMON_OBSERVATION.pagesPerDrain; page++) {
        dirty = false
        const more = await drain(client, grant, () => !stopped && attached === client && client.connected)
        if (stopped) return
        if (!client.connected) throw new DaemonError('E_UNAVAILABLE', 'The original workspace observation connection was lost.')
        dirty = dirty || more
        if (!dirty) break
      }
      failures = 0
      retryAt = 0; pressureReported = false
    } catch (error) {
      if (stopped) return
      failed = true; failures = Math.min(failures + 1, 5)
      retryAt = Date.now() + Math.min(DAEMON_OBSERVATION.healthMs, DAEMON_OBSERVATION.retryMs * 2 ** (failures - 1))
      if (attached?.connected && admissionBusy(error)) {
        // A known non-admission is read backpressure, not transport loss.
        // Keep the original grant/cursor/subscription and one wake bit. Only
        // read/subscription work is retried; commands never enter this scheduler.
        dirty = true
        if (!pressureReported) process.emitWarning('Native event replay deferred: ordinary daemon admission is busy.', { code: 'TRELLIS_DAEMON_REPLAY_BUSY' })
        pressureReported = true
        // An attachment rejected before its grant was installed must run that
        // original attachment again, rather than treating it as ready.
        if (!grant) { disconnect?.(); disconnect = undefined; attached = undefined }
      } else {
        release?.(); release = undefined; disconnect?.(); disconnect = undefined
        attached = undefined; grant = undefined
        try { unavailable(error) }
        catch { process.emitWarning('Native daemon outage observer failed.', { code: 'TRELLIS_DAEMON_OBSERVER' }) }
      }
    } finally {
      running = false
      schedule(failed ? Math.min(DAEMON_OBSERVATION.healthMs, DAEMON_OBSERVATION.retryMs * 2 ** (failures - 1)) : dirty ? 0 : push ? DAEMON_OBSERVATION.healthMs : DAEMON_OBSERVATION.fallbackMs)
    }
  }
  let disposeListener: (() => void) | undefined
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    disconnect?.(); release?.(); disposeListener?.()
  }
  disposeListener = pool.onDispose(stop)
  schedule(0)
  return stop
}
