import type { ProcessOwner, WorkspaceGrant } from '../../shared/daemon'
import {
  PROVIDER_READ_LIMITS, isProviderReadMethod, providerReadCancelSchema, providerReadControlSchema,
  providerReadTimeout, type ProviderReadCancelResult, type ProviderReadControl, type ProviderReadMethod
} from '../../shared/provider-cancellation'
import { DaemonError } from './errors'

type Entry = {
  owner: string; namespaceId: string; method: ProviderReadMethod
  state: 'active' | 'cancelled' | 'finished'; abort: AbortController
  expiresAt: number; timer?: ReturnType<typeof setTimeout>
}

/** One instance per leased daemon. The dispatcher authenticates actor and grant;
 * this registry binds cancellation to that exact process generation and scope.
 * No worker/job/session cancellation port is available to this class. */
export class ProviderCancellation {
  private readonly entries = new Map<string, Entry>()
  private closed = false
  private identity(actor: ProcessOwner, workspace: WorkspaceGrant | undefined, control: ProviderReadControl): { key: string; owner: string } {
    const owner = JSON.stringify([actor.pid, actor.startedAt, actor.userId, actor.executable, workspace ? [workspace.workspaceId, workspace.grantId, workspace.revision, workspace.root] : null])
    return { owner, key: JSON.stringify([owner, control.namespaceId, control.requestId]) }
  }
  private prune(): void {
    const now = Date.now()
    for (const [key, entry] of this.entries) if (entry.state !== 'active' && entry.expiresAt <= now) this.entries.delete(key)
  }
  private capacity(owner: string, namespaceId: string): void {
    this.prune()
    // Finished reads may be frequent (polling/page refresh). Preserve early-cancel
    // tombstones and active signals, while rotating completed diagnostics only.
    if (this.entries.size >= PROVIDER_READ_LIMITS.entries) {
      for (const [key, entry] of this.entries) if (entry.state === 'finished') { this.entries.delete(key); break }
    }
    if (this.entries.size >= PROVIDER_READ_LIMITS.entries || [...this.entries.values()].filter(entry => entry.owner === owner && entry.namespaceId === namespaceId && entry.state === 'active').length >= PROVIDER_READ_LIMITS.perNamespace) {
      throw new DaemonError('E_BUSY', 'Native transient provider controls are full; wait for the original requests to settle.')
    }
  }
  async run<T>(actor: ProcessOwner, workspace: WorkspaceGrant | undefined, method: ProviderReadMethod, raw: ProviderReadControl, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new DaemonError('E_UNAVAILABLE', 'Transient provider admission is closed.')
    if (!isProviderReadMethod(method)) throw new DaemonError('E_DENIED', 'This provider method cannot be transiently cancelled.')
    const control = providerReadControlSchema.parse(raw), { key, owner } = this.identity(actor, workspace, control)
    this.prune()
    const prior = this.entries.get(key)
    if (prior) {
      if (prior.method !== method) throw new DaemonError('E_CONFLICT', 'Transient control identity refers to another provider method.')
      throw new DaemonError('E_CONFLICT', prior.state === 'cancelled' ? 'The original transient provider request was cancelled before admission.' : 'This transient provider identity is already admitted or finished.')
    }
    this.capacity(owner, control.namespaceId)
    const entry: Entry = { owner, namespaceId: control.namespaceId, method, state: 'active', abort: new AbortController(), expiresAt: Date.now() + PROVIDER_READ_LIMITS.tombstoneMs }
    this.entries.set(key, entry)
    entry.timer = setTimeout(() => entry.abort.abort(), providerReadTimeout(method))
    entry.timer.unref()
    try { return await action(entry.abort.signal) }
    finally {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = undefined; entry.state = 'finished'; entry.expiresAt = Date.now() + PROVIDER_READ_LIMITS.tombstoneMs
    }
  }
  cancel(actor: ProcessOwner, workspace: WorkspaceGrant | undefined, raw: unknown): ProviderReadCancelResult {
    const input = providerReadCancelSchema.parse(raw), { key, owner } = this.identity(actor, workspace, input)
    this.prune()
    const entry = this.entries.get(key)
    if (entry) {
      if (entry.method !== input.method) throw new DaemonError('E_CONFLICT', 'Transient cancellation refers to another provider method.')
      if (entry.state === 'finished') return { state: 'finished', active: false }
      entry.abort.abort()
      return { state: 'cancel-requested', active: entry.state === 'active' }
    }
    // A separate authenticated connection can overtake original admission. Keep
    // its cancellation until that original UUID arrives; do not fabricate a stop.
    this.capacity(owner, input.namespaceId)
    const abort = new AbortController(); abort.abort()
    this.entries.set(key, { owner, namespaceId: input.namespaceId, method: input.method, state: 'cancelled', abort, expiresAt: Date.now() + PROVIDER_READ_LIMITS.tombstoneMs })
    return { state: 'cancel-requested', active: false }
  }
  close(): void {
    this.closed = true
    for (const entry of this.entries.values()) { if (entry.timer) clearTimeout(entry.timer); entry.abort.abort() }
  }
}
