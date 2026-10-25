import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { z } from 'zod'
import { RUNTIME_BULK, runtimeWireSchema, type RuntimeBody, type RuntimeBodyMethod, type RuntimeBlob, type RuntimeWire, runtimeCursorSchema, type RuntimeCursor } from '../../../shared/daemon-runtime'
import type { DaemonStatus, WorkspaceGrant } from '../../../shared/daemon'
import { daemonClientContext } from './manager'
import { DaemonError } from '../../daemon/errors'
import { requireCurrentDaemonBuild } from '../../daemon/build-identity'
import { readLease } from '../../daemon/lease'
import { DaemonClient } from './client'
import { DAEMON_OBSERVATION, daemonConnectionPool, disposeDaemonPools, observePooledWorkspace } from './pool'
import { broadcastToWindows } from '../bridge'
import { ipcEvent } from '../../../shared/ipc-channels'
import { canonicalDirectory } from '../acp/metadata'
import { MUTATING_DAEMON_METHODS, type DaemonMethod, type DaemonPayload } from '../../../shared/daemon'
import { LEGACY_INTEGRATION_MUTATIONS, legacyIntegrationRequestSchema } from '../../../shared/integration-native'
import { PROVIDER_READ_LIMITS, providerReadControlSchema, providerReadTimeout, type ProviderReadControl, type ProviderReadMethod } from '../../../shared/provider-cancellation'
import { JIRA_DAEMON } from '../../../shared/jira-integration'
import { GITLAB_DAEMON } from '../../../shared/gitlab-integration'
import { DINGTALK_DAEMON } from '../../../shared/dingtalk-integration'

/** Cleanup actions only. Status/workspace lookup are reserved server preflight
 * methods, not feature operations that can bypass GUI admission closure. Literal
 * provider names come from their schema-paired native contracts. */
const cleanupMethods: readonly DaemonMethod[] = [
  'runtime.cancel', 'runtime.end', 'runtime.permission', 'runtime.workflow.stop', 'runtime.workflow.cancelRevision',
  JIRA_DAEMON.cancelRead, JIRA_DAEMON.cancel, GITLAB_DAEMON.cancelJob, DINGTALK_DAEMON.cancelExecution
]

type GrantCache = { grants: Map<string, WorkspaceGrant>; granting: Map<string, Promise<WorkspaceGrant | undefined>>; disconnect?: () => void }
const grantCaches = new WeakMap<DaemonClient, GrantCache>()
const observers = new Map<string, () => void>()
function grantCache(client: DaemonClient): GrantCache {
  let cache = grantCaches.get(client)
  if (!cache) {
    cache = { grants: new Map(), granting: new Map() }
    grantCaches.set(client, cache)
    cache.disconnect = client.onDisconnect(() => { grantCaches.delete(client) })
  }
  return cache
}
function invalidateGrants(client: DaemonClient): void {
  grantCaches.get(client)?.disconnect?.()
  grantCaches.delete(client)
}
let admissionClosed = false
export function setRuntimeClientAdmissionClosed(closed: boolean): void { admissionClosed = closed }
/** Workspace identity is derived by native code; caller strings cannot grant a renderer RPC. */
async function resolveScope(client: DaemonClient, root: string, isCurrent?: () => boolean, allowGrant = true): Promise<WorkspaceGrant | undefined> {
  if (!root) return undefined
  const canonical = realpathSync(root), key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  const cache = grantCache(client), existing = cache.grants.get(key)
  if (existing) return existing
  const workspaceId = createHash('sha256').update(key).digest('hex')
  const retained = await client.request('workspace.get', { workspaceId })
  if (!retained.ok) throw new DaemonError(retained.code, retained.error, retained.outcome)
  if (retained.data) {
    if (retained.data.root !== canonical) throw new DaemonError('E_CONFLICT', 'Retained workspace identity points to a different physical root.')
    if (!client.connected) throw new DaemonError('E_UNAVAILABLE', 'The workspace connection was lost.')
    cache.grants.set(key, retained.data); return retained.data
  }
  // Cleanup targets an already admitted owner. Never make its control lane
  // wait for ordinary workspace authorization or recreate a revoked grant.
  if (!allowGrant) throw new DaemonError('E_CONFLICT', 'The original workspace grant is unavailable; cleanup cannot authorize a replacement workspace.')
  if (isCurrent && !isCurrent()) throw new DaemonError('E_CONFLICT', '来源项目或请求已改变；尚未授权新的后台工作区。')
  const grant = await client.request('workspace.grant', { workspaceId, root: canonical, expectedRevision: 0 })
  if (!grant.ok) throw new DaemonError(grant.code, grant.error, grant.outcome)
  if (!client.connected) throw new DaemonError('E_UNAVAILABLE', 'The workspace grant acknowledgement connection was lost.')
  cache.grants.set(key, grant.data)
  return grant.data
}
async function scope(client: DaemonClient, root: string, isCurrent?: () => boolean, allowGrant = true): Promise<WorkspaceGrant | undefined> {
  if (!root) return undefined
  if (!client.connected) throw new DaemonError('E_UNAVAILABLE', 'The original workspace connection was lost.')
  const canonical = realpathSync(root), key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  const pendingKey = `${key}:${allowGrant ? 'grant' : 'retained'}`
  const cache = grantCache(client), existing = cache.granting.get(pendingKey)
  if (existing) {
    const grant = await existing
    if (isCurrent && !isCurrent()) throw new DaemonError('E_CONFLICT', '来源项目或请求已改变；不再接收原工作区授权。')
    return grant
  }
  const pending = resolveScope(client, root, isCurrent, allowGrant)
  cache.granting.set(pendingKey, pending)
  try {
    const grant = await pending
    if (isCurrent && !isCurrent()) throw new DaemonError('E_CONFLICT', '来源项目或请求已改变；不再接收原工作区授权。')
    return grant
  } finally { if (cache.granting.get(pendingKey) === pending) cache.granting.delete(pendingKey) }
}
async function connect(dedicated = false): Promise<DaemonClient> {
  const context = await daemonClientContext(), pool = daemonConnectionPool(context)
  const client = dedicated ? await DaemonClient.connect(context) : await pool.get()
  try {
    // Only the private, literal cleanup allowlist selects a dedicated lane.
    // Its original owner/grant controls must work even when build proof is old
    // or missing. It neither grants a new workspace nor negotiates new work.
    let status: DaemonStatus
    if (dedicated) {
      const result = await client.request('daemon.status', {})
      if (!result.ok) throw new DaemonError(result.code, result.error, result.outcome)
      status = result.data
      if (status.epoch !== client.epoch || JSON.stringify(status.owner) !== JSON.stringify(client.lease.owner) || JSON.stringify(status.identity) !== JSON.stringify(context.identity)
        || JSON.stringify(readLease(context)) !== JSON.stringify(client.lease)) throw new DaemonError('E_CONFLICT', 'Cleanup attachment no longer matches its original authenticated daemon owner.')
    } else {
      requireCurrentDaemonBuild(context, client.lease)
      status = await pool.status(client)
      requireCurrentDaemonBuild(context, client.lease)
    }
    if (status.runtimeAuthority !== 'daemon') throw new DaemonError('E_UNAVAILABLE', '后台 Runtime 尚未完成原有执行器和设置迁移，请在设置中完成迁移后重试。')
    return client
  } catch (error) { if (dedicated) client.close(); throw error }
}
async function upload(client: DaemonClient, workspace: WorkspaceGrant | undefined, value: unknown, inlineOnly = false): Promise<RuntimeWire> {
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length <= RUNTIME_BULK.chunkBytes) return { inline: value }
  if (inlineOnly) throw new DaemonError('E_INVALID_ARG', 'Control requests require a bounded inline payload; no cleanup command was submitted.')
  if (bytes.length > RUNTIME_BULK.valueBytes) throw new DaemonError('E_INVALID_ARG', 'Runtime input exceeds the bounded bulk transport.')
  const opened = await client.request('runtime.blob.open', { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, { workspace })
  if (!opened.ok) throw new DaemonError(opened.code, opened.error, opened.outcome)
  try {
    for (let offset = 0; offset < bytes.length; offset += RUNTIME_BULK.chunkBytes) {
      const part = bytes.subarray(offset, offset + RUNTIME_BULK.chunkBytes)
      const appended = await client.request('runtime.blob.append', { id: opened.data.id, offset, data: part.toString('base64') }, { workspace })
      if (!appended.ok || appended.data.offset !== offset + part.length) throw new DaemonError('E_UNKNOWN', 'Runtime upload was not confirmed; no command was submitted.', 'unknown')
    }
    const sealed = await client.request('runtime.blob.seal', { id: opened.data.id }, { workspace })
    if (!sealed.ok) throw new DaemonError(sealed.code, sealed.error, sealed.outcome)
    return { blob: sealed.data }
  } catch (error) {
    // Failed transfers no longer get an implicit socket teardown. Release their
    // known spool ID without reconnecting or resubmitting the feature command.
    if (client.connected) {
      const released = await client.request('runtime.blob.release', { id: opened.data.id }, { workspace })
      if (!released.ok) process.emitWarning('Native incomplete upload cleanup was not confirmed.', { code: 'TRELLIS_RUNTIME_BLOB_RELEASE' })
    }
    throw error
  }
}
async function download(client: DaemonClient, workspace: WorkspaceGrant | undefined, wire: RuntimeWire): Promise<unknown> {
  if ('inline' in wire) return wire.inline
  const chunks: Buffer[] = [], hash = createHash('sha256')
  let offset = 0
  while (offset < wire.blob.bytes) {
    const page = await client.request('runtime.blob.read', { blob: wire.blob, offset }, { workspace })
    if (!page.ok) throw new DaemonError(page.code, page.error, page.outcome)
    const bytes = Buffer.from(page.data.data, 'base64')
    if (!bytes.length || bytes.length > RUNTIME_BULK.chunkBytes || page.data.next !== offset + bytes.length || page.data.next > wire.blob.bytes || page.data.done !== (page.data.next === wire.blob.bytes)) throw new DaemonError('E_UNKNOWN', 'Runtime result chunk identity is invalid.', 'unknown')
    chunks.push(bytes); hash.update(bytes); offset = page.data.next
  }
  if (hash.digest('hex') !== wire.blob.sha256) throw new DaemonError('E_UNKNOWN', 'Pinned runtime result digest mismatch.', 'unknown')
  return JSON.parse(Buffer.concat(chunks, wire.blob.bytes).toString('utf8'))
}
/** Typed native capability only. Never exported through preload as generic RPC. */
export async function runtimeCall<T, M extends RuntimeBodyMethod = RuntimeBodyMethod>(root: string, method: M, body: RuntimeBody<M>, commandId?: string, isCurrent?: () => boolean): Promise<T> {
  return nativeDomainCall<T>(root, method, body, commandId, isCurrent)
}
type TransientCall = { method: ProviderReadMethod; control: ProviderReadControl; signal: AbortSignal }
/** Independent control lane keeps cancellation available under ordinary RPC load. */
async function cancelProviderRead(epoch: string, workspace: WorkspaceGrant | undefined, transient: TransientCall): Promise<void> {
  const client = await DaemonClient.connect(await daemonClientContext())
  try {
    if (client.epoch !== epoch) throw new DaemonError('E_CONFLICT', '原瞬态请求所属后台代次已改变，取消结果未确认。')
    const result = await client.request('provider.read.cancel', { ...transient.control, method: transient.method }, { workspace, timeoutMs: PROVIDER_READ_LIMITS.controlMs })
    if (!result.ok) throw new DaemonError(result.code, result.error, result.outcome)
  } finally { client.close() }
}
/** Native-only helper. A per-facade namespace and a fresh private request UUID
 * travel inside the existing blob wire; renderer UUIDs never control other reads. */
export function nativeProviderReadCall<T>(root: string, method: ProviderReadMethod, body: unknown, namespaceId: string, signal: AbortSignal, commandId?: string, isCurrent?: () => boolean): Promise<T> {
  const control = providerReadControlSchema.parse({ namespaceId, requestId: randomUUID() })
  return nativeDomainCall(root, method, { providerRead: control, input: body }, commandId, () => !signal.aborted && (!isCurrent || isCurrent()), { method, control, signal })
}
/** Native feature facades only; preload never exposes this transport function. */
export async function nativeDomainCall<T>(root: string, method: DaemonMethod, body: unknown, commandId?: string, isCurrent?: () => boolean, transient?: TransientCall): Promise<T> {
  // Read failures have no mutation receipt. Explicit caller IDs and every
  // mutation retain their original UUID through admission, transport and errors.
  commandId ??= MUTATING_DAEMON_METHODS.includes(method) ? randomUUID() : undefined
  const legacy = method === 'integration.execute' ? legacyIntegrationRequestSchema.safeParse(body) : null
  const legacyCleanup = legacy?.success && ['cancelRead', 'cancelAuthorization'].includes(legacy.data.operation)
  const cleanup = Boolean(legacyCleanup) || cleanupMethods.includes(method)
  const dedicated = cleanup
  let client: DaemonClient | undefined
  let workspace: WorkspaceGrant | undefined, inputBlob: RuntimeBlob | undefined, outputBlob: RuntimeBlob | undefined
  let cancelPending: Promise<void> | undefined
  let abort: (() => void) | undefined
  try {
    if (admissionClosed && !cleanup) throw new DaemonError('E_UNAVAILABLE', '桌面正在退出，尚未接纳新操作。')
    client = await connect(dedicated)
    if (isCurrent && !isCurrent()) throw new DaemonError('E_CONFLICT', '来源项目或请求已改变；尚未授权后台工作区。')
    workspace = await scope(client, root, isCurrent, !dedicated)
    const input = await upload(client, workspace, body, dedicated)
    if ('blob' in input) inputBlob = input.blob
    if (isCurrent && !isCurrent()) throw new DaemonError('E_CONFLICT', '来源项目或请求已改变；尚未提交后台执行。')
    if (admissionClosed && !cleanup) throw new DaemonError('E_UNAVAILABLE', '桌面已关闭新操作接入；尚未提交后台执行。')
    const epoch = client.epoch
    if (transient) {
      transient.signal.throwIfAborted()
      abort = () => {
        cancelPending ??= cancelProviderRead(epoch, workspace, transient).catch(() => {
          process.emitWarning(`Transient provider cancellation was not confirmed; ${commandId ? `original command ${commandId}` : `original read ${transient.control.requestId}`}.`, { code: 'TRELLIS_PROVIDER_CANCEL' })
        })
      }
      transient.signal.addEventListener('abort', abort, { once: true })
    }
    const authorization = method === 'gitlab.workspace.authorizeWrites' || method === 'dingtalk.workspace.authorizeAccount' || legacy?.success && (legacy.data.operation === 'authorize' || legacy.data.operation === 'teamGitlabConnect')
    const timeoutMs = transient ? providerReadTimeout(transient.method) : authorization ? PROVIDER_READ_LIMITS.authorizationMs : method === 'runtime.setup' ? 650_000 : method === 'runtime.probe' ? 30_000 : method === 'runtime.new' || method === 'runtime.resume' || method === 'runtime.recover' ? 50_000 : 60_000
    // Scope/authorization and bulk upload can yield while a rebuild publishes.
    // Revalidate immediately before the actual feature request, without replay.
    const context = await daemonClientContext()
    if (!cleanup) requireCurrentDaemonBuild(context, client.lease)
    else if (JSON.stringify(readLease(context)) !== JSON.stringify(client.lease)) throw new DaemonError('E_CONFLICT', 'The original cleanup owner changed before submission; no control was sent.')
    const result = await client.request(method, input as DaemonPayload<typeof method>, { workspace, commandId, timeoutMs })
    if (!result.ok) throw Object.assign(new DaemonError(result.code, result.error, result.outcome), { commandId: result.commandId ?? commandId })
    const wire = runtimeWireSchema.parse(result.data)
    const retainsOutput = legacy?.success ? LEGACY_INTEGRATION_MUTATIONS.includes(legacy.data.operation) : MUTATING_DAEMON_METHODS.includes(method)
    if ('blob' in wire && !retainsOutput) outputBlob = wire.blob
    try { return await download(client, workspace, wire) as T }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { ...(commandId ? { commandId } : {}), outcome: 'unknown' }) }
  } catch (error) {
    const original = error instanceof DaemonError ? error : new DaemonError('E_UNKNOWN', commandId ? '后台操作未确认，请按原命令读取回执核实结果。' : '后台读取失败，请重新加载。', 'unknown')
    if (client && ['E_DENIED', 'E_CONFLICT'].includes(original.code)) invalidateGrants(client)
    const suffix = commandId ? ` 原命令：${commandId}` : ''
    throw Object.assign(new DaemonError(original.code, original.message.slice(0, 400 - suffix.length) + suffix, original.outcome), commandId ? { commandId } : {})
  } finally {
    if (transient && abort) transient.signal.removeEventListener('abort', abort)
    if (cancelPending) await cancelPending
    try {
      if (client && outputBlob) await client.request('runtime.blob.release', { id: outputBlob.id }, { workspace })
      if (client && inputBlob) await client.request('runtime.blob.release', { id: inputBlob.id }, { workspace })
    } catch { process.emitWarning('Native transient blob cleanup was not confirmed.', { code: 'TRELLIS_RUNTIME_BLOB_RELEASE' }) }
    finally { if (dedicated) client?.close() }
  }
}
const observationSchema = z.object({ cursor: runtimeCursorSchema, events: z.array(z.object({ sequence: z.number(), root: z.string(), channel: z.string(), payload: z.unknown(), reset: z.boolean() })).max(100), resetRequired: z.boolean(), hasMore: z.boolean(), sessions: z.unknown() })
// Validate the successful reset projection before publishing it or consuming its
// cursor. Preserve extension fields, especially negotiated metadata and the
// original pending-permission payloads; validation never reconstructs deadlines.
const resetPermissionSchema = z.object({
  requestId: z.string().min(1), sessionId: z.string().min(1), agentName: z.string(),
  options: z.array(z.object({ optionId: z.string(), name: z.string(), kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']) }).passthrough()),
  projectRoot: z.string().optional(), connectionGeneration: z.string().optional(), turnId: z.string().optional(), expiresAt: z.number().finite().optional()
}).passthrough()
const resetSessionSchema = z.object({
  sessionId: z.string().min(1), projectRoot: z.string().min(1),
  status: z.enum(['starting', 'ready', 'busy', 'awaiting_permission', 'cancelling', 'disconnected', 'legacy', 'error', 'closed']),
  connectionOwned: z.boolean().optional(), connectionGeneration: z.string().optional(),
  stateRevision: z.number().int().nonnegative().optional(), pendingPermissions: z.array(resetPermissionSchema).optional(),
  events: z.array(z.unknown()).max(0)
}).passthrough()
const resetSnapshotSchema = z.object({ ok: z.literal(true), sessions: z.array(resetSessionSchema).max(104) }).passthrough() // Four live owners plus 100 history records.
const eventChannels = new Set<string>([ipcEvent.acpOutput, ipcEvent.acpState, ipcEvent.acpDone, ipcEvent.acpPermission])
export function observeRuntime(root: string): () => void {
  const old = observers.get(root)
  if (old) return old
  let stopped = false, unavailable = false, cursor: RuntimeCursor | null = null
  let startTimer: ReturnType<typeof setTimeout> | undefined, startFailures = 0
  let dispose: (() => void) | undefined, originalGrant: WorkspaceGrant | undefined
  const stop = (): void => {
    stopped = true; dispose?.()
    if (startTimer) clearTimeout(startTimer)
    if (observers.get(root) === stop) observers.delete(root)
  }
  observers.set(root, stop)
  const start = async (): Promise<void> => {
    try {
      const context = await daemonClientContext()
      if (stopped) return
      const pool = daemonConnectionPool(context)
      dispose = observePooledWorkspace(pool, async client => {
        const status = await pool.status(client)
        if (status.runtimeAuthority !== 'daemon') throw new DaemonError('E_UNAVAILABLE', '后台 Runtime 尚未完成迁移。')
        if (stopped) throw new DaemonError('E_CONFLICT', 'The observed project was released.')
        let captured: WorkspaceGrant | undefined
        if (originalGrant) {
          // Reconnect restores the original grant only. Revocation never causes
          // an observer to issue a replacement workspace authorization.
          const retained = await client.request('workspace.get', { workspaceId: originalGrant.workspaceId })
          if (!retained.ok) throw new DaemonError(retained.code, retained.error, retained.outcome)
          if (JSON.stringify(retained.data) !== JSON.stringify(originalGrant)) throw new DaemonError('E_CONFLICT', 'The original observed workspace grant was changed or revoked.')
          captured = retained.data ?? undefined
        } else captured = await scope(client, root, () => !stopped)
        if (!captured || stopped) throw new DaemonError('E_CONFLICT', 'The observed project is no longer current.')
        originalGrant = captured
        return captured
      }, 'runtime', async (client, workspace, current) => {
        let blob: RuntimeBlob | undefined
        try {
          const result = await client.request('runtime.events', { inline: { after: cursor, limit: 100 } }, { workspace })
          if (!result.ok) throw new DaemonError(result.code, result.error, result.outcome)
          const wire = runtimeWireSchema.parse(result.data)
          if ('blob' in wire) blob = wire.blob
          const page = observationSchema.parse(await download(client, workspace, wire))
          if (!current() || stopped) return false
          if (page.cursor.epoch !== client.epoch) throw new DaemonError('E_CONFLICT', 'The runtime replay cursor belongs to another daemon epoch.')
          if (page.resetRequired) {
            // A failed listAcpSessions result is not an empty snapshot. Keep an
            // explicit reset requirement through errors/callback failures so a
            // repaired backend is asked for the snapshot again on the next read.
            cursor = null
            const reset = resetSnapshotSchema.safeParse(page.sessions)
            if (!reset.success) throw new DaemonError('E_UNAVAILABLE', 'Runtime session reset is unavailable or invalid; replay will request the original snapshot again.')
            const identities = new Set<string>()
            for (const session of reset.data.sessions) {
              if (canonicalDirectory(session.projectRoot) !== canonicalDirectory(root) || identities.has(session.sessionId)) throw new DaemonError('E_CONFLICT', 'Runtime reset contains a foreign or duplicate session identity.')
              identities.add(session.sessionId)
              // Historical rows may lack modern Agent metadata; only an owned
              // row becomes a live state projection, so validate those fields
              // there without inventing values for old transcript records.
              if (session.connectionOwned && (typeof session.agentId !== 'string' || typeof session.agentName !== 'string'
                || typeof session.startedAt !== 'number' || !Number.isFinite(session.startedAt) || !session.connectionGeneration)) throw new DaemonError('E_UNAVAILABLE', 'Runtime reset contains an incomplete live session projection.')
              for (const permission of session.pendingPermissions ?? []) {
                if (permission.sessionId !== session.sessionId || permission.projectRoot !== undefined && canonicalDirectory(permission.projectRoot) !== canonicalDirectory(root)
                  || permission.connectionGeneration !== undefined && permission.connectionGeneration !== session.connectionGeneration) throw new DaemonError('E_CONFLICT', 'Runtime reset permission does not belong to its original session/generation.')
              }
            }
            // Forward original pending permission IDs/generations/deadlines. No
            // replay or reconnect reconstructs an approval resolver or deadline.
            for (const session of reset.data.sessions) {
              if (!current() || stopped) return false
              if (session.connectionOwned) broadcastToWindows(ipcEvent.acpState, { ...session, session: { ...session, events: [] } })
            }
            broadcastToWindows(ipcEvent.daemonRuntimeReset, { projectRoot: root })
          } else for (const event of page.events) if (canonicalDirectory(event.root) === canonicalDirectory(root) && eventChannels.has(event.channel) && !event.reset) broadcastToWindows(event.channel, event.payload)
          if (!current() || stopped) return false
          cursor = page.cursor
          unavailable = false
          return page.hasMore
        } finally {
          if (blob && client.connected) await client.request('runtime.blob.release', { id: blob.id }, { workspace })
        }
      }, error => {
        if (stopped) return
        if (!unavailable) broadcastToWindows(ipcEvent.daemonRuntimeUnavailable, { projectRoot: root, error: error instanceof Error ? error.message : '后台连接不可用' })
        unavailable = true
      })
    } catch (error) {
      if (stopped) return
      if (!unavailable) broadcastToWindows(ipcEvent.daemonRuntimeUnavailable, { projectRoot: root, error: error instanceof Error ? error.message : '后台连接不可用' })
      unavailable = true
      startFailures = Math.min(startFailures + 1, 5)
      startTimer = setTimeout(() => { void start() }, Math.min(DAEMON_OBSERVATION.healthMs, DAEMON_OBSERVATION.retryMs * 2 ** (startFailures - 1)))
    }
  }
  void start()
  return stop
}
export function detachRuntimeObservers(): void { for (const stop of [...observers.values()]) stop(); disposeDaemonPools() }
export function selectRuntimeObservationRoot(root: string | null): void {
  for (const [observed, stop] of observers) if (!root || canonicalDirectory(observed) !== canonicalDirectory(root)) stop()
  if (root && ![...observers.keys()].some(observed => canonicalDirectory(observed) === canonicalDirectory(root))) observeRuntime(root)
}
