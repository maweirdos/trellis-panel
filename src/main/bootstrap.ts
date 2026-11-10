import { app, dialog } from 'electron'
import { mkdirSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { daemonStartupFailure, recordDaemonStartupFailure } from './daemon/startup-failure'
import { captureOnboarding } from './onboarding'

// Role artifacts are generated beside the emitted CommonJS bootstrap. Keep
// loading native and branch-local so bundlers cannot eagerly import GUI code.
const loadRole = createRequire(__filename)

/** Role resolution must precede importing GUI composition or requesting its instance lock. */
const roles = process.argv.filter((argument) => argument.startsWith('--trellis-role='))
const role = roles.length ? roles[0].slice('--trellis-role='.length) : 'gui'
if (roles.length > 1 || !['gui', 'gui-launcher', 'daemon', 'control', 'maintenance'].includes(role)) {
  process.stderr.write('Invalid Trellis bootstrap role.\n'); app.exit(1)
} else {
  const overrides = process.argv.filter((argument) => argument.startsWith('--trellis-user-data-base64='))
  if (overrides.length > 1) throw new Error('Duplicate profile argument')
  if (overrides[0]) {
    const value = Buffer.from(overrides[0].slice('--trellis-user-data-base64='.length), 'base64').toString('utf8')
    if (!isAbsolute(value) || value.length > 4096 || value.includes('\0')) throw new Error('Invalid native profile path')
    app.setPath('userData', value)
  }
  // Preserve the existing canonical userData, name and dev/prod behavior. Role paths are additive.
  const userData = app.getPath('userData')
  const containedGui = role === 'gui' && process.argv.some(value => value.startsWith('--trellis-gui-contained='))
  if (containedGui) captureOnboarding(userData)
  const guiRole = role === 'gui' || role === 'gui-launcher'
  const roleDirectory = join(userData, 'daemon-v1', app.isPackaged ? 'production' : 'development', guiRole && !containedGui ? `gui-launcher-${randomUUID()}` : ['control', 'maintenance'].includes(role) ? `${role}-${randomUUID()}` : role)
  mkdirSync(roleDirectory, { recursive: true })
  app.setPath('sessionData', roleDirectory)
  if (guiRole) {
    // Independently bundled; no static GUI imports are reachable from headless roles.
    const originalArguments = process.argv.slice(1)
    if (!containedGui) {
      app.disableHardwareAcceleration()
      // Keep the requested debugger port for the real GUI, not its headless launcher.
      app.commandLine.removeSwitch('remote-debugging-port')
      loadRole('node:inspector').close()
    } else if (process.env.TPANEL_DEBUG_PORT) {
      app.commandLine.appendSwitch('remote-debugging-port', process.env.TPANEL_DEBUG_PORT)
    }
    const entry: { runGuiProcessBootstrap(args: string[]): Promise<boolean> } = loadRole('./gui-scope.js')
    void entry.runGuiProcessBootstrap(originalArguments).then(contained => {
      if (contained) loadRole('./gui.js')
      else app.exit(0)
    }).catch((error: unknown) => {
      dialog.showErrorBox('桌面进程范围未就绪', error instanceof Error ? error.message : '请核验原启动范围后重试。')
      app.exit(1)
    })
  } else {
    let locked = true
    if (role === 'daemon') {
      app.setPath('userData', roleDirectory)
      locked = app.requestSingleInstanceLock()
      app.setPath('userData', userData)
    }
    if (!locked) app.exit(0)
    else {
      const fail = (error: unknown, stage: 'load' | 'run'): void => {
        const diagnostic = role === 'daemon' ? recordDaemonStartupFailure(dirname(roleDirectory), error, stage) : daemonStartupFailure(error, stage)
        process.stderr.write(diagnostic); app.exit(1)
      }
      try {
        const entry: { runDaemonHost?: () => Promise<void>; runDaemonControl?: () => Promise<void>; runDaemonMaintenance?: () => Promise<void> } =
          role === 'daemon' ? loadRole('./daemon-host.js') : role === 'maintenance' ? loadRole('./daemon-maintenance.js') : loadRole('./daemon-control.js')
        const run = role === 'daemon' ? entry.runDaemonHost : role === 'maintenance' ? entry.runDaemonMaintenance : entry.runDaemonControl
        if (!run) throw new Error('Missing daemon entrypoint')
        void run().catch((error: unknown) => { fail(error, 'run') })
      } catch (error) {
        fail(error, 'load')
      }
    }
  }
}
