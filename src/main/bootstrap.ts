import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { daemonStartupFailure } from './daemon/startup-failure'

// Role artifacts are generated beside the emitted CommonJS bootstrap. Keep
// loading native and branch-local so bundlers cannot eagerly import GUI code.
const loadRole = createRequire(__filename)

/** Role resolution must precede importing GUI composition or requesting its instance lock. */
const roles = process.argv.filter((argument) => argument.startsWith('--trellis-role='))
const role = roles.length ? roles[0].slice('--trellis-role='.length) : 'gui'
if (roles.length > 1 || !['gui', 'daemon', 'control'].includes(role)) {
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
  const roleDirectory = join(userData, 'daemon-v1', app.isPackaged ? 'production' : 'development', role === 'control' ? `control-${randomUUID()}` : role)
  mkdirSync(roleDirectory, { recursive: true })
  app.setPath('sessionData', roleDirectory)
  if (role === 'gui') {
    // Independently bundled; no static GUI imports are reachable from headless roles.
    loadRole('./gui.js')
  } else {
    let locked = true
    if (role === 'daemon') {
      app.setPath('userData', roleDirectory)
      locked = app.requestSingleInstanceLock()
      app.setPath('userData', userData)
    }
    if (!locked) app.exit(0)
    else {
      try {
        const entry: { runDaemonHost?: () => Promise<void>; runDaemonControl?: () => Promise<void> } = role === 'daemon' ? loadRole('./daemon-host.js') : loadRole('./daemon-control.js')
        const run = role === 'daemon' ? entry.runDaemonHost : entry.runDaemonControl
        if (!run) throw new Error('Missing daemon entrypoint')
        void run().catch((error: unknown) => { process.stderr.write(daemonStartupFailure(error, 'run')); app.exit(1) })
      } catch (error) {
        process.stderr.write(daemonStartupFailure(error, 'load')); app.exit(1)
      }
    }
  }
}
