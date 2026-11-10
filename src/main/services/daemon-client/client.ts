import { createConnection, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { authenticatedSchema, challengeSchema, daemonNotificationSchema, daemonResponseSchema, daemonResults, DAEMON_LIMITS, MUTATING_DAEMON_METHODS, type DaemonData, type DaemonMethod, type DaemonNotification, type DaemonPayload, type DaemonResult, type WorkspaceGrant, type ProcessOwner } from '../../../shared/daemon'
import type { DaemonContext } from '../../daemon/context'
import { readLease, verifiedLease, type DaemonLease } from '../../daemon/lease'
import { sameOwner } from '../../daemon/native'
import { authenticationProof, equalProof, serverProof } from '../../daemon/auth'
import { FrameDecoder, encodeFrame } from '../../daemon/framing'
import { DaemonError, daemonFailure } from '../../daemon/errors'
import { loadNativeGuiGrant } from '../../daemon/native-gui-grant'

export interface DaemonRequestOptions { workspace?: WorkspaceGrant; commandId?: string; timeoutMs?: number }
type Pending = { method: DaemonMethod; bytes: number; commandId?: string; timer: ReturnType<typeof setTimeout>; complete: (value: DaemonResult<unknown>) => void }

/** Native-only. Disconnect never cancels admitted work and writes are never automatically retried. */
export class DaemonClient {
  private readonly pending = new Map<string, Pending>()
  private pendingBytes = 0
  private closed = false
  private readonly disconnectListeners = new Set<() => void>()
  private readonly invalidationListeners = new Set<(hint: DaemonNotification) => void>()
  private constructor(private readonly socket: Socket, readonly lease: DaemonLease) {}
  get epoch(): string { return this.lease.epoch }
  get connected(): boolean { return !this.closed && !this.socket.destroyed }
  onDisconnect(listener: () => void): () => void {
    if (!this.connected) { this.notify(listener); return () => {} }
    this.disconnectListeners.add(listener)
    return () => { this.disconnectListeners.delete(listener) }
  }
  /** Native hints only; subscribers must replay data under their exact workspace grant. */
  onInvalidation(listener: (hint: DaemonNotification) => void): () => void {
    if (this.connected) this.invalidationListeners.add(listener)
    return () => { this.invalidationListeners.delete(listener) }
  }
  private notify(listener: () => void): void {
    try { listener() }
    catch { process.emitWarning('Native daemon observer failed.', { code: 'TRELLIS_DAEMON_OBSERVER' }) }
  }
  static connect(context: DaemonContext): Promise<DaemonClient> { return this.connectWithAuthority(context) }
  /** Fixed native GUI composition only; the read-only loader refuses ordinary Node/CLI callers. */
  static async connectNativeGui(context: DaemonContext): Promise<DaemonClient> {
    await context.protection.refresh()
    return this.connectWithAuthority(context, await loadNativeGuiGrant(context))
  }
  private static async connectWithAuthority(context: DaemonContext, nativeGui?: (challenge: unknown, client: ProcessOwner) => string): Promise<DaemonClient> {
    const lease = await verifiedLease(context)
    if (!lease) throw new DaemonError('E_UNAVAILABLE', 'No verified daemon is running for this user/profile. Start it explicitly.')
    await context.protection.refresh()
    const secret = context.credential()
    return new Promise((resolve, reject) => {
      const socket = createConnection(`\\\\.\\pipe\\${context.pipeName}`)
      const decoder = new FrameDecoder()
      let client: DaemonClient | undefined
      let proof: string | undefined
      const timer = setTimeout(() => { socket.destroy(); reject(new DaemonError('E_UNAVAILABLE', 'Daemon authentication timed out. The existing owner was not stopped or replaced.')) }, DAEMON_LIMITS.handshakeMs)
      socket.on('error', () => { clearTimeout(timer); client?.disconnect(); reject(new DaemonError('E_UNAVAILABLE', 'The verified daemon is unavailable. Its lease remains authoritative until process identity is reconciled.')) })
      socket.on('close', () => { clearTimeout(timer); client?.disconnect(); reject(new DaemonError('E_UNAVAILABLE', 'The daemon connection closed before authentication.')) })
      socket.on('data', (chunk: Buffer) => {
        try {
          decoder.push(chunk, (raw) => {
            if (client) { client.receive(raw); return }
            if (!proof) {
              const challenge = challengeSchema.parse(raw)
              if (challenge.epoch !== lease.epoch || !sameOwner(challenge.owner, lease.owner) || JSON.stringify(challenge.identity) !== JSON.stringify(context.identity)) throw new DaemonError('E_CONFLICT', 'Daemon identity or epoch changed during authentication.')
              proof = authenticationProof(secret, challenge, context.owner)
              socket.write(encodeFrame({ type: 'authenticate', identity: context.identity, client: context.owner, proof, ...(nativeGui ? { nativeGuiProof: nativeGui(challenge, context.owner) } : {}) }))
            } else {
              const auth = authenticatedSchema.parse(raw)
              if (auth.epoch !== lease.epoch || !equalProof(auth.proof, serverProof(secret, proof))) throw new DaemonError('E_DENIED', 'The daemon could not prove its native profile credential.')
              if (JSON.stringify(readLease(context)) !== JSON.stringify(lease)) throw new DaemonError('E_CONFLICT', 'Daemon ownership changed during authentication.')
              clearTimeout(timer); client = new DaemonClient(socket, lease); resolve(client)
            }
          })
        } catch (error) { clearTimeout(timer); socket.destroy(); client?.disconnect(); reject(error) }
      })
    })
  }
  private receive(raw: unknown): void {
    if (this.closed) return
    const notification = daemonNotificationSchema.safeParse(raw)
    if (notification.success) {
      if (notification.data.epoch !== this.epoch) { this.close(); return }
      for (const listener of [...this.invalidationListeners]) this.notify(() => listener(notification.data))
      return
    }
    const response = daemonResponseSchema.parse(raw)
    if (response.epoch !== this.epoch) { this.close(); return }
    const pending = this.pending.get(response.requestId)
    if (!pending) return // A late timed-out acknowledgement cannot start a new command.
    // Always settle the matched request, including a schema exception. Removing it
    // first previously left an invalid result pending forever after disconnect.
    let result: DaemonResult<unknown>
    try {
      if (!response.result.ok) {
        if (response.result.commandId && response.result.commandId !== pending.commandId) result = daemonFailure(new DaemonError('E_UNKNOWN', 'Daemon acknowledgement refers to a different command. Inspect the original command receipt.', 'unknown'), pending.commandId)
        else result = { ...response.result, ...(pending.commandId ? { commandId: pending.commandId } : {}) }
      } else {
        const data = daemonResults[pending.method].safeParse(response.result.data)
        result = data.success ? { ok: true, data: data.data } : daemonFailure(new DaemonError('E_UNKNOWN', 'Daemon returned an invalid result. Inspect the original command receipt.', 'unknown'), pending.commandId)
      }
    } catch { result = daemonFailure(new DaemonError('E_UNKNOWN', 'Daemon returned an invalid result. Inspect the original command receipt.', 'unknown'), pending.commandId) }
    this.pending.delete(response.requestId); this.pendingBytes -= pending.bytes; clearTimeout(pending.timer)
    pending.complete(result)
  }
  private disconnect(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.complete(daemonFailure(new DaemonError('E_UNKNOWN', 'Daemon connection was lost. Query the original command receipt before repeating a mutation.', 'unknown'), pending.commandId))
    }
    this.pending.clear(); this.pendingBytes = 0
    this.invalidationListeners.clear()
    const listeners = [...this.disconnectListeners]
    this.disconnectListeners.clear()
    for (const listener of listeners) this.notify(listener)
  }
  async request<M extends DaemonMethod>(method: M, payload: DaemonPayload<M>, options: DaemonRequestOptions = {}): Promise<DaemonResult<DaemonData<M>>> {
    if (this.closed || this.socket.destroyed) return daemonFailure(new DaemonError('E_UNAVAILABLE', 'The daemon client is disconnected.'), options.commandId)
    const commandId = MUTATING_DAEMON_METHODS.includes(method) || options.commandId ? options.commandId ?? randomUUID() : undefined
    const requestId = randomUUID()
    let frame: Buffer
    try { frame = encodeFrame({ type: 'request', version: 1, requestId, expectedEpoch: this.epoch, method, payload, ...(commandId ? { commandId } : {}), ...(options.workspace ? { workspace: options.workspace } : {}) }) }
    catch (error) { return daemonFailure(error, commandId) }
    if (this.pending.size >= DAEMON_LIMITS.pendingCalls || this.pendingBytes + this.socket.writableLength + frame.length > DAEMON_LIMITS.pendingBytes) return daemonFailure(new DaemonError('E_BUSY', 'The daemon request queue is full.'), commandId)
    const result = await new Promise<DaemonResult<unknown>>((complete) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId); this.pendingBytes -= frame.length
        complete(daemonFailure(new DaemonError('E_UNKNOWN', 'Daemon acknowledgement timed out. Inspect the original command ID; it may already be committed.', 'unknown'), commandId))
      }, Math.max(1, Math.min(options.timeoutMs ?? DAEMON_LIMITS.requestMs, 650_000)))
      this.pending.set(requestId, { method, bytes: frame.length, commandId, timer, complete }); this.pendingBytes += frame.length
      try { this.socket.write(frame) }
      catch { this.disconnect(); this.socket.destroy() }
    })
    // Runtime result was validated against the schema indexed by this same method.
    return result as DaemonResult<DaemonData<M>>
  }
  close(): void { this.disconnect(); this.socket.destroy() }
}
