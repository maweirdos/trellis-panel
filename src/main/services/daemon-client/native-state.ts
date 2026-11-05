import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Settings } from '../../../shared/types'
import type { BootstrapMigration } from '../../../shared/bootstrap'
import { daemonPreferencesSchema, DAEMON_LIMITS } from '../../../shared/daemon'
import { readBounded } from '../../daemon/files'
import { getSettings } from '../store'
import { readIntegrationState } from '../integrations/repository'
import { installSettingsPersistence } from '../store-port'
import { installIntegrationStatePort } from '../integrations/state-port'
import { drainLegacyRuntime, type LegacyRuntimeRelease } from '../runtime-host'
import { daemonClientContext, daemonManager, daemonIsAbsent, pooledDaemonClient } from './manager'
import { installGuiNativeState, prepareGuiNativeProjection } from '../../daemon/native-state'
import { publishNativeRelease, readNativeRelease } from '../../daemon/cutover'
import { DaemonError } from '../../daemon/errors'
import { requireCurrentDaemonBuild } from '../../daemon/build-identity'

let preparation: Promise<void> | undefined
let installed = false
let originalRelease: { commandId: string; release: LegacyRuntimeRelease } | undefined
let releasePublished = false
let preparationContext: Awaited<ReturnType<typeof daemonClientContext>> | undefined
export function guiNativePreparationIdentity(): BootstrapMigration | undefined {
  let original = originalRelease
  if (!original && preparationContext && existsSync(join(preparationContext.directory, 'native-cutover.protected'))) {
    // Error presentation may happen before transport attachment. Read only the
    // protected original when available; presentation never publishes/adopts it.
    try { original = readNativeRelease(preparationContext) } catch { /* Locked proof identity remains unknown. */ }
  }
  return original ? { commandId: original.commandId, releaseId: original.release.releaseId } : undefined
}
/** Run before full GUI settings readers, feature IPC, observers or admission.
 * The restricted bootstrap window has a separate, non-secret preference reader. */
export function prepareGuiNativeState(onPreparing?: () => void, onAuthenticated?: () => void): Promise<void> {
  if (installed) return Promise.resolve()
  return preparation ??= prepare(onPreparing, onAuthenticated).catch((error: unknown) => {
    // Retry the preparation, never undo released legacy writers or discard the
    // original migration identity after a lost acknowledgement.
    preparation = undefined
    throw error
  })
}
async function install(context: Awaited<ReturnType<typeof daemonClientContext>>): Promise<void> {
  // Read-only legacy-key preparation must finish while the original legacy
  // ports are still frozen. Failure cannot expose an unprepared GUI reader.
  await prepareGuiNativeProjection(context)
  frozenPorts?.(); frozenPorts = undefined
  const dispose = installGuiNativeState(context)
  try {
    // Installing lazy readers alone is not authority readiness. Validate the
    // protected projection (also for manual startup) before full GUI admission.
    getSettings()
    readIntegrationState()
    installed = true
  } catch (error) { dispose(); throw error }
}
async function prepare(onPreparing?: () => void, onAuthenticated?: () => void): Promise<void> {
  const context = await daemonClientContext()
  preparationContext = context
  const ledger = join(context.directory, 'integration-ledger.json')
  if (existsSync(ledger)) {
    const preferences = z.object({ preferences: daemonPreferencesSchema }).passthrough().parse(JSON.parse(readBounded(ledger, DAEMON_LIMITS.storeBytes))).preferences
    if (preferences.startup === 'manual' && await daemonIsAbsent()) { onPreparing?.(); await install(context); return }
  }
  const started = await daemonManager.start()
  if (!started.ok) {
    const failure = new DaemonError(started.code, started.code === 'E_BUSY'
      ? `${started.error} 可在后台服务状态中核对具体工作，或使用 npm run daemon:status 查看。`
      : started.error, started.outcome)
    if ('data' in started) throw Object.assign(failure, { takeoverStatus: started.data })
    throw failure
  }
  if (!started.data.capabilities.includes('native-protection')) throw new DaemonError('E_VERSION', 'The running daemon uses the previous role-specific credential format. Stop it with a compatible native controller before upgrading; no settings migration was attempted.')
  // Actual authenticated status/capability evidence, distinct from protected
  // projection readiness. Manual-start absence must not fabricate this marker.
  onAuthenticated?.()
  onPreparing?.()
  // Pool owns this ordinary lane, including disconnect/reconnect. Migration
  // failure must not close unrelated subscriptions or other admitted requests.
  const client = await pooledDaemonClient()
  const metadata = await client.request('native.state', {})
  if (!metadata.ok) throw new DaemonError(metadata.code, metadata.error, metadata.outcome)
  if (metadata.data.phase !== 'daemon') {
    if (metadata.data.phase === 'prepared' || (!originalRelease && existsSync(join(context.directory, 'native-cutover.protected')))) {
      const original = readNativeRelease(context)
      if (originalRelease && (originalRelease.commandId !== original.commandId || originalRelease.release.releaseId !== original.release.releaseId)) {
        throw new DaemonError('E_CONFLICT', 'The original migration identity changed; preserve both release records and reconcile before retrying.')
      }
      originalRelease = { commandId: original.commandId, release: original.release }
      releasePublished = true
    } else {
      freezeLegacyPorts()
      originalRelease ??= { commandId: randomUUID(), release: await drainLegacyRuntime() }
      if (!releasePublished) {
        publishNativeRelease(context, originalRelease.commandId, originalRelease.release)
        releasePublished = true
      }
    }
    // A recovered durable release also fences current-process legacy writers;
    // no second authority is installed when the same attempt is retried.
    freezeLegacyPorts(false)
    const migrated = await client.request('native.prepare', { releaseId: originalRelease.release.releaseId }, { commandId: originalRelease.commandId, timeoutMs: 60_000 })
    if (!migrated.ok) throw new DaemonError(migrated.code, migrated.error, migrated.outcome)
  }
  // Durable settings ownership can precede live application/domain readiness.
  // This read barrier reuses the original connection and never repeats prepare.
  const ready = await client.request('native.ready', {}, { timeoutMs: 60_000 })
  if (!ready.ok) throw new DaemonError(ready.code, ready.error, ready.outcome)
  if (!ready.data.ready) throw new DaemonError('E_UNAVAILABLE', 'The native application has not confirmed protected domain readiness.')
  requireCurrentDaemonBuild(context, client.lease)
  await install(context)
}
let frozenPorts: (() => void) | undefined
function freezeLegacyPorts(snapshot = true): void {
  if (frozenPorts) return
  const reject = (): never => { throw new DaemonError('E_UNAVAILABLE', 'Legacy writers were released for native migration; reconcile that migration before any write.') }
  // A recovered proof already pins the legacy source bytes. getSettings() and
  // v1 integration reads can persist defaults/upgrades, so never call them there.
  const settings = snapshot ? structuredClone(getSettings()) : undefined
  const integrations = snapshot ? structuredClone(readIntegrationState()) : undefined
  const disposeSettings = installSettingsPersistence({ read: () => settings ? structuredClone(settings) : reject(), write: reject })
  let disposeIntegrations: () => void
  try { disposeIntegrations = installIntegrationStatePort({ read: () => integrations ? structuredClone(integrations) : reject(), update: reject }) }
  catch (error) { disposeSettings(); throw error }
  frozenPorts = () => { disposeIntegrations(); disposeSettings() }
}

/** GUI mutations cross the native broker. A lost result never silently retries. */
export async function writeNativeSettings(patch: Partial<Settings>): Promise<Settings> {
  const client = await pooledDaemonClient()
  const metadata = await client.request('native.state', {})
  if (!metadata.ok) throw new DaemonError(metadata.code, metadata.error, metadata.outcome)
  if (!metadata.data.revision || metadata.data.phase !== 'daemon') throw new DaemonError('E_UNAVAILABLE', 'Complete native settings ownership before changing runtime settings.')
  const commandId = randomUUID()
  const result = await client.request('native.settings.write', { expectedRevision: metadata.data.revision, patch: Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) }, { commandId })
  if (!result.ok) throw Object.assign(new DaemonError(result.code, `${result.error.slice(0, 320)} 原命令：${commandId}`, result.outcome), { commandId })
  try { return getSettings() }
  catch {
    throw Object.assign(new DaemonError('E_UNKNOWN', `The original settings write was acknowledged, but its projection could not be read. Inspect original command ${commandId} before repeating it.`, 'unknown'), { commandId })
  }
}
