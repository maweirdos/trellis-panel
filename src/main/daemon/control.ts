import { app } from 'electron'
import { daemonManager } from '../services/daemon-client/manager'
import { DaemonError, daemonFailure } from './errors'
import { daemonPreferencesSchema } from '../../shared/daemon'

export async function runDaemonControl(): Promise<void> {
  await app.whenReady()
  let result: unknown
  try {
    const commands = process.argv.filter((arg) => arg.startsWith('--trellis-command='))
    if (commands.length !== 1) throw new DaemonError('E_INVALID_ARG', 'Choose daemon start, status, stop, restart, logs or preferences.')
    const command = commands[0].slice('--trellis-command='.length)
    switch (command) {
      case 'start': result = await daemonManager.start(); break
      case 'status': result = await daemonManager.status(); break
      case 'stop': result = await daemonManager.stop(); break
      case 'restart': result = await daemonManager.restart(); break
      case 'logs': result = await daemonManager.logs({ limit: 100 }); break
      case 'preferences': result = await daemonManager.preferences(); break
      case 'set-preferences': {
        const value = process.argv.find((arg) => arg.startsWith('--trellis-preferences='))?.slice('--trellis-preferences='.length)
        if (!value || value.length > 1024) throw new DaemonError('E_INVALID_ARG', 'Pass bounded JSON preferences with their current revision.')
        result = await daemonManager.setPreferences(daemonPreferencesSchema.parse(JSON.parse(value))); break
      }
      case 'reconcile-startup': {
        const original = process.argv.find((arg) => arg.startsWith('--trellis-original-command='))?.slice('--trellis-original-command='.length)
        if (!original || !/^[a-f0-9-]{36}$/i.test(original) || !daemonManager.reconcileStartup) throw new DaemonError('E_INVALID_ARG', 'Pass the original startup command UUID from daemon status.')
        result = await daemonManager.reconcileStartup(original); break
      }
      default: throw new DaemonError('E_INVALID_ARG', 'Unknown daemon management command.')
    }
  } catch (error) { result = daemonFailure(error) }
  process.stdout.write(JSON.stringify(result) + '\n', () => app.exit(typeof result === 'object' && result !== null && 'ok' in result && result.ok === true ? 0 : 1))
}
