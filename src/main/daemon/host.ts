import { app } from 'electron'
import { createDaemonContext, ensureDaemonCredential } from './context'
import { acquireLease, assertLease, releaseLease } from './lease'
import { DaemonRepository } from './repository'
import { ProtectedSettingsOwner } from './settings-owner'
import { IntegrationRegistry } from '../services/integrations/registry'
import { IntegrationScheduler } from './scheduler'
import { DaemonLog } from './log'
import { DaemonDispatcher } from './dispatcher'
import { startDaemonServer } from './server'
import type { NativeServer } from './transport'
import type { IntegrationAdmissionPort } from '../services/integrations/work-ports'
import { createDaemonApplication } from './application'

export interface DaemonHostPorts {
  /** Trusted composition only; provider children reuse the existing registry and protected owner. */
  integrations?: (settings: ProtectedSettingsOwner) => { registry: IntegrationRegistry; admission: IntegrationAdmissionPort }
}

/** No GUI state, ACP, workflow composition, updater, tray, notification or renderer imports. */
export async function runDaemonHost(ports: DaemonHostPorts = {}): Promise<void> {
  await app.whenReady()
  const context = await createDaemonContext()
  const lease = await acquireLease(context)
  const assertOwner = (): void => assertLease(context, lease)
  await ensureDaemonCredential(context, assertOwner)
  const repository = new DaemonRepository(context.directory, lease.epoch, assertOwner, context.owner)
  const settings = new ProtectedSettingsOwner(context, assertOwner)
  const application = createDaemonApplication({ context, repository, settings, assertOwner })
  const integrations = ports.integrations?.(settings)
  const scheduler = new IntegrationScheduler(repository, integrations?.registry ?? application.registry, integrations?.admission ?? application.admission)
  await application.start(scheduler)
  const log = new DaemonLog(context.directory)
  let server: NativeServer | undefined
  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true; scheduler.closeAdmission(); clearInterval(tick)
    try {
      await server?.close()
      releaseLease(context, lease)
      app.exit(0)
    } catch { log.append('TRANSPORT_FAILED'); app.exit(1) } // Preserve lease on unconfirmed adapter exit.
  }
  const dispatcher = new DaemonDispatcher(context, lease, repository, settings, scheduler, log, () => { setTimeout(() => { void stop() }, 100) }, application.domains)
  const tick = setInterval(() => {
    // A damaged optional provider ledger must not starve unrelated queued jobs.
    void application.domains.poll().catch(() => { log.append('PROVIDER_POLL_FAILED') })
      .then(() => scheduler.tick()).catch(() => { log.append('SCHEDULER_FAILED') })
  }, 1000)
  server = await startDaemonServer(context, lease, dispatcher, () => {
    log.append('TRANSPORT_FAILED'); scheduler.closeAdmission(); clearInterval(tick)
    // A failed pipe cannot prove executing work stopped. Retain owner/ledger for native recovery.
    void application.domains.shutdown().then(() => scheduler.shutdown()).then(() => app.exit(1)).catch(() => {
      // Runtime ownership is independent of scheduler work. Keep the original
      // owner alive if exact native cleanup cannot be proved after pipe failure.
      process.emitWarning('Daemon transport failed and native release remains unconfirmed.', { code: 'TRELLIS_DAEMON_RELEASE_UNKNOWN' })
    })
  })
  log.append('DAEMON_STARTED')
  app.on('window-all-closed', () => {})
  app.on('before-quit', (event) => { event.preventDefault() })
}
