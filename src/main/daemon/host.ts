import { app } from 'electron'
import * as nodeModule from 'node:module'
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
import { captureDaemonBuild, publishDaemonBuild } from './build-identity'
import { ensureNativeGuiGrant } from './native-gui-grant'

// Capture before the first readiness/native await, never when a GUI attaches.
const loadedBuild = captureDaemonBuild()

export interface DaemonHostPorts {
  /** Trusted composition only; provider children reuse the existing registry and protected owner. */
  integrations?: (settings: ProtectedSettingsOwner) => { registry: IntegrationRegistry; admission: IntegrationAdmissionPort }
}

/** No GUI state, ACP, workflow composition, updater, tray, notification or renderer imports. */
export async function runDaemonHost(ports: DaemonHostPorts = {}): Promise<void> {
  await app.whenReady()
  const context = await createDaemonContext()
  const lease = await acquireLease(context)
  publishDaemonBuild(context, lease, loadedBuild)
  const assertOwner = (): void => assertLease(context, lease)
  await ensureDaemonCredential(context, assertOwner)
  await ensureNativeGuiGrant(context, lease, assertOwner)
  const repository = new DaemonRepository(context.directory, lease.epoch, assertOwner, context.owner)
  const settings = new ProtectedSettingsOwner(context, assertOwner)
  const application = createDaemonApplication({ context, repository, settings, assertOwner })
  const integrations = ports.integrations?.(settings)
  const scheduler = new IntegrationScheduler(repository, integrations?.registry ?? application.registry, integrations?.admission ?? application.admission)
  const appStartPromise = application.start(scheduler)
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
  const dispatcher = new DaemonDispatcher(context, lease, repository, settings, scheduler, log, () => { setTimeout(() => { void stop() }, 5) }, application.domains, loadedBuild.sha256)
  // 并行启动领域初始化（SQLite/设置迁移）与命名管道监听（windows-pipe.ps1），authenticate 在 readyGate 后才放行，
  // 消除两者严格串行导致的 ~350-500ms 冷启动延迟，且保持初始化完成前绝不处理业务帧的安全边界。
  const [startedServer] = await Promise.all([
    startDaemonServer(context, lease, dispatcher, () => {
      log.append('TRANSPORT_FAILED'); scheduler.closeAdmission(); clearInterval(tick)
      // A failed pipe cannot prove executing work stopped. Retain owner/ledger for native recovery.
      void application.domains.shutdown().then(() => scheduler.shutdown()).then(() => app.exit(1)).catch(() => {
        // Runtime ownership is independent of scheduler work. Keep the original
        // owner alive if exact native cleanup cannot be proved after pipe failure.
        process.emitWarning('Daemon transport failed and native release remains unconfirmed.', { code: 'TRELLIS_DAEMON_RELEASE_UNKNOWN' })
      })
    }, appStartPromise),
    appStartPromise
  ])
  server = startedServer
  const tick = setInterval(() => {
    // A damaged optional provider ledger must not starve unrelated queued jobs.
    void dispatcher.backgroundPoll(async () => {
      await application.domains.poll().catch(() => { log.append('PROVIDER_POLL_FAILED') })
      await scheduler.tick().catch(() => { log.append('SCHEDULER_FAILED') })
    }).catch(() => { log.append('SCHEDULER_FAILED') })
  }, 1000)
  log.append('DAEMON_STARTED')
  // 借鉴 t3code forkParked：在 daemon 真正就绪发布后非阻塞刷盘 V8 编译缓存，
  // 并在首屏管道握手高峰过去后静默预热本机 kernel 见证与活跃工作区对话驱动进程，让进入界面后立即可用。
  setImmediate(() => {
    try {
      const mod = nodeModule as typeof nodeModule & { flushCompileCache?: () => void }
      mod.flushCompileCache?.()
    } catch { /* ignore */ }
    if (stopping) return
    void import('../services/workcopy-use/kernel-lifetime').then(m => m.kernelLifetime()).catch(() => {})
    const prewarmTimer = setTimeout(() => {
      if (!stopping) application.prewarm()
    }, 350)
    prewarmTimer.unref()
  })
  app.on('window-all-closed', () => {})
  app.on('before-quit', (event) => { event.preventDefault() })
}
