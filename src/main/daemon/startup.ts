import { app } from 'electron'
import type { DaemonContext } from './context'
import { DaemonError } from './errors'
import type { StartupRegistration } from './repository'

/** An independent named Windows login entry; never overwrites the GUI's autoStart value. */
export class WindowsDaemonStartup {
  constructor(private readonly context: DaemonContext) {}
  assertAvailable(): void {
    if (process.platform !== 'win32' || !app.isPackaged) throw new DaemonError('E_UNAVAILABLE', 'Daemon login startup is available only in the installed Windows application. Use client or manual mode in development.')
  }
  private name(): string { return `TrellisPanel.Daemon.${this.context.identity.profileId}` }
  private args(): string[] { return ['--trellis-role=daemon', `--trellis-user-data-base64=${Buffer.from(this.context.userData).toString('base64')}`] }
  descriptor(): StartupRegistration { return { executable: process.execPath, args: this.args(), name: this.name(), installationId: this.context.identity.installationId } }
  verify(enabled: boolean): boolean {
    return this.verifyOriginal(this.descriptor(), enabled)
  }
  verifyOriginal(registration: StartupRegistration, enabled: boolean): boolean {
    this.assertAvailable()
    if (registration.name !== this.name()) throw new DaemonError('E_DENIED', 'The original startup entry belongs to a different profile.')
    const items = app.getLoginItemSettings({ path: registration.executable, args: registration.args }).launchItems.filter((item) => item.name === registration.name && item.scope === 'user')
    return enabled ? items.length === 1 && items[0].enabled && items[0].path.toLowerCase() === registration.executable.toLowerCase() && JSON.stringify(items[0].args) === JSON.stringify(registration.args) : items.length === 0
  }
  apply(enabled: boolean): void {
    this.assertAvailable()
    app.setLoginItemSettings({ openAtLogin: enabled, enabled, path: process.execPath, args: this.args(), name: this.name() })
    if (!this.verify(enabled)) throw new DaemonError('E_UNKNOWN', 'Windows did not confirm the daemon login entry. Inspect startup settings and reconcile the original command.', 'unknown')
  }
}
