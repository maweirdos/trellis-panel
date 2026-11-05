import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { authenticateSchema, daemonPayloads, daemonRequestSchema, daemonResults, DAEMON_CONTROL_METHODS, DAEMON_LIMITS, type DaemonResult, type ProcessOwner, type WorkspaceGrant, type DaemonNotification } from '../../shared/daemon'
import type { DaemonContext } from './context'
import type { DaemonLease } from './lease'
import { assertLease } from './lease'
import { sameOwner } from './native'
import { canonicalDirectory } from '../services/acp/metadata'
import { legacyIntegrationRequestSchema } from '../../shared/integration-native'
import { runtimeWireSchema, RUNTIME_BULK, type RuntimeBlob } from '../../shared/daemon-runtime'
import { authenticationProof, equalProof, serverProof } from './auth'
import { DaemonError, daemonFailure } from './errors'
import { listenNativePipe, type NativeServer } from './transport'
import type { DaemonDispatcher } from './dispatcher'
import { authenticateNativeGuiGrant, releaseNativeGuiGrant, type NativeGuiAuthority } from './native-gui-grant'
import { isBoundedNativeTaskControl } from '../../shared/native-task-execution'

export async function startDaemonServer(context: DaemonContext, lease: DaemonLease, dispatcher: DaemonDispatcher, fatal: () => void): Promise<NativeServer> {
  const admission = { ordinary: { calls: 0, bytes: 0 }, control: { calls: 0, bytes: 0 }, authentication: { calls: 0, bytes: 0 } }
  return listenNativePipe(context.pipeName, (peer) => {
    const challenge = { type: 'challenge' as const, version: 1 as const, epoch: lease.epoch, nonce: randomBytes(32).toString('hex'), identity: context.identity, owner: context.owner }
    let client: ProcessOwner | null = null
    let nativeGui: NativeGuiAuthority | undefined
    let closed = false
    let authenticating = false
    const subscriptions = new Map<string, WorkspaceGrant>()
    const controlOutputs = new Map<string, { blob: RuntimeBlob; workspace: string; expires: number }>()
    const hints = new Map<string, { workspaceId: string; source: DaemonNotification['source'] }>()
    let hintTimer: ReturnType<typeof setTimeout> | undefined
    let disposeObservation = (): void => {}
    const cleanup = (): void => { clearTimeout(timer); if (hintTimer) clearTimeout(hintTimer); hints.clear(); subscriptions.clear(); controlOutputs.clear(); releaseNativeGuiGrant(nativeGui); nativeGui = undefined; disposeObservation() }
    const close = (): void => { if (closed) return; closed = true; cleanup(); try { peer.close() } catch { /* The transport failure callback retains ownership. */ } }
    const timer = setTimeout(close, DAEMON_LIMITS.handshakeMs)
    peer.onClose = () => { if (!closed) { closed = true; cleanup() } }
    disposeObservation = dispatcher.observeInvalidations(event => {
      if (!client || closed) return
      for (const grant of subscriptions.values()) {
        if (event.source === 'runtime' ? event.root !== canonicalDirectory(grant.root) : event.workspaceId && event.workspaceId !== grant.workspaceId) continue
        hints.set(`${grant.workspaceId}:${event.source}`, { workspaceId: grant.workspaceId, source: event.source })
      }
      if (!hints.size || hintTimer) return
      hintTimer = setTimeout(() => {
        hintTimer = undefined
        if (closed || !peer.isAlive()) { close(); return }
        try {
          for (const hint of hints.values()) {
            const grant = subscriptions.get(hint.workspaceId)
            if (!grant || !dispatcher.currentWorkspace(grant)) { subscriptions.delete(hint.workspaceId); continue }
            peer.send({ type: 'invalidation', epoch: lease.epoch, ...hint } satisfies DaemonNotification)
          }
          hints.clear()
        } catch { close() }
      }, 25)
      hintTimer.unref()
    })
    try { peer.send(challenge) } catch { close(); return }
    peer.onFrame = (raw) => {
      if (closed) return
      const bytes = Buffer.byteLength(JSON.stringify(raw))
      const deadline = Date.now() + DAEMON_LIMITS.requestMs
      const request = client ? daemonRequestSchema.safeParse(raw) : null
      if (client && !request?.success) { close(); return }
      // Authenticate independently of provider occupancy. Only a narrow, parsed
      // method allowlist can consume reserved control slots, never ordinary work.
      const wire = request?.success && request.data.method === 'integration.execute' ? runtimeWireSchema.safeParse(request.data.payload) : null
      const legacy = wire?.success && 'inline' in wire.data ? legacyIntegrationRequestSchema.safeParse(wire.data.inline) : null
      const blobRead = request?.success && request.data.method === 'runtime.blob.read' ? daemonPayloads['runtime.blob.read'].safeParse(request.data.payload) : null
      const blobRelease = request?.success && request.data.method === 'runtime.blob.release' ? daemonPayloads['runtime.blob.release'].safeParse(request.data.payload) : null
      const transferId = blobRead?.success ? blobRead.data.blob.id : blobRelease?.success ? blobRelease.data.id : undefined
      const transfer = transferId ? controlOutputs.get(transferId) : undefined
      const controlTransfer = request?.success && transfer && transfer.expires > Date.now()
        && transfer.workspace === JSON.stringify(request.data.workspace ?? null)
        && (!blobRead?.success || JSON.stringify(blobRead.data.blob) === JSON.stringify(transfer.blob))
      const control = request?.success && (DAEMON_CONTROL_METHODS.includes(request.data.method)
        || isBoundedNativeTaskControl(request.data.method, request.data.payload)
        || legacy?.success && (legacy.data.operation === 'cancelRead' || legacy.data.operation === 'cancelAuthorization') || Boolean(controlTransfer))
      const budget = !client ? admission.authentication : control ? admission.control : admission.ordinary
      const callLimit = !client ? DAEMON_LIMITS.connections : control ? DAEMON_LIMITS.controlPendingCalls : DAEMON_LIMITS.pendingCalls
      const byteLimit = !client ? DAEMON_LIMITS.authenticationBytes : control ? DAEMON_LIMITS.controlPendingBytes : DAEMON_LIMITS.pendingBytes
      if ((!client && authenticating) || budget.calls >= callLimit || budget.bytes + bytes > byteLimit) {
        if (request?.success) {
          try { peer.send({ type: 'response', requestId: request.data.requestId, epoch: lease.epoch, result: daemonFailure(new DaemonError('E_BUSY', 'The daemon admission queue is full.'), request.data.commandId) }) } catch { close() }
        } else close()
        return
      }
      budget.calls++; budget.bytes += bytes
      const finish = (): void => { budget.calls--; budget.bytes -= bytes }
      const authenticate = async (): Promise<void> => {
        if (closed) return
        if (client || !peer.isAlive()) throw new DaemonError('E_DENIED', 'The original native peer is no longer available for authentication.')
        const auth = authenticateSchema.parse(raw)
        if (auth.client.pid !== peer.clientPid || JSON.stringify(auth.identity) !== JSON.stringify(context.identity) || auth.client.userId !== context.identity.userId || !sameOwner(peer.owner, auth.client)) throw new DaemonError('E_DENIED', 'Native daemon identity does not match the kernel-bound pipe client.')
        if (!equalProof(auth.proof, authenticationProof(context.credential(), challenge, auth.client))) throw new DaemonError('E_DENIED', 'Native daemon authentication failed.')
        assertLease(context, lease)
        if (auth.nativeGuiProof) nativeGui = authenticateNativeGuiGrant(context, lease.epoch, challenge, peer.owner, auth.nativeGuiProof)
        client = auth.client; clearTimeout(timer)
        peer.send({ type: 'authenticated', epoch: lease.epoch, proof: serverProof(context.credential(), auth.proof) })
      }
      const dispatch = async (): Promise<void> => {
        if (closed || !client) return
        const request = daemonRequestSchema.parse(raw)
        let result: DaemonResult<unknown>
        try {
          if (Date.now() >= deadline) throw new DaemonError('E_BUSY', 'The daemon request expired before admission.')
          // The long-lived native helper holds the original process handle,
          // checks it before forwarding frames, and closes on that process exit.
          if (!peer.isAlive() || !sameOwner(peer.owner, client)) throw new DaemonError('E_DENIED', 'The original authenticated process lifetime ended.')
          if (!daemonPayloads[request.method].safeParse(request.payload).success) throw new DaemonError('E_INVALID_ARG', 'The method payload violates its bounded contract.')
          const data = await dispatcher.dispatch(request, client, nativeGui)
          const parsed = daemonResults[request.method].safeParse(data)
          if (!parsed.success) throw new DaemonError('E_UNKNOWN', 'The daemon operation returned an invalid acknowledgement. Inspect its original retained command.', 'unknown')
          // A large control acknowledgement may use the existing bulk wire.
          // Reserve reads only for descriptors returned to THIS connection by
          // an admitted control, with the same exact grant and bounded TTL.
          const output = control ? runtimeWireSchema.safeParse(parsed.data) : null
          if (output?.success && 'blob' in output.data) {
            if (controlOutputs.size >= DAEMON_LIMITS.controlPendingCalls) {
              const oldest = controlOutputs.keys().next().value
              if (oldest !== undefined) controlOutputs.delete(oldest)
            }
            controlOutputs.set(output.data.blob.id, { blob: output.data.blob, workspace: JSON.stringify(request.workspace ?? null), expires: Date.now() + RUNTIME_BULK.ttlMs })
          }
          if (request.method === 'runtime.blob.release' && transferId) controlOutputs.delete(transferId)
          if (request.method === 'events.subscribe') {
            const grant = dispatcher.authorizedWorkspace(request)
            if (subscriptions.size >= 100 && !subscriptions.has(grant.workspaceId)) throw new DaemonError('E_BUSY', 'This authenticated connection has too many workspace subscriptions.')
            subscriptions.set(grant.workspaceId, grant)
          } else if (request.method === 'events.unsubscribe' && request.workspace) subscriptions.delete(request.workspace.workspaceId)
          result = { ok: true as const, data: parsed.data }
        } catch (error) {
          result = daemonFailure(error instanceof z.ZodError ? new DaemonError('E_IO', 'A native repository/adapter contract could not be validated. Preserve state and inspect the original command.', 'unknown') : error, request.commandId)
        }
        if (!closed) peer.send({ type: 'response', requestId: request.requestId, epoch: lease.epoch, result })
      }
      if (!client) {
        authenticating = true
        void authenticate().catch(close).finally(finish)
      }
      else {
        // Requests are independently bounded. A long provider action cannot
        // serialize every replay/status request on the retained connection.
        void dispatch().catch(close).finally(finish)
      }
    }
  }, fatal)
}
