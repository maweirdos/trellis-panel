/** Console adapter runs in the shipped Electron's Node mode. Secrets stay in the real control host. */
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
if (args[0] === 'daemon') args.shift()
const command = args.shift()
const supported = ['start', 'status', 'stop', 'restart', 'logs', 'preferences', 'set-preferences', 'reconcile-startup']
if (!command || !supported.includes(command) || (['set-preferences', 'reconcile-startup'].includes(command) ? args.length !== 1 : args.length !== 0)) {
  process.stdout.write(JSON.stringify({ ok: false, code: 'E_INVALID_ARG', error: 'Usage: trellis-daemon daemon start|status|stop|restart|logs|preferences, set-preferences <json>, or reconcile-startup <original-command-uuid>', outcome: 'not-admitted' }) + '\n')
  process.exitCode = 1
} else {
  const development = process.env.TRELLIS_DAEMON_DEV_APP
  const launchArgs = [...(development ? [resolve(development)] : []), '--trellis-role=control', `--trellis-command=${command}`, ...(args[0] ? [`${command === 'reconcile-startup' ? '--trellis-original-command=' : '--trellis-preferences='}${args[0]}`] : [])]
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.TPANEL_DEBUG_PORT
  delete env.CRUX_DEV_LAUNCH_ID; delete env.CRUX_DEV_LAUNCH_PID; delete env.CRUX_DEV_LAUNCH_ROOT
  const executable = process.env.TRELLIS_DAEMON_EXECUTABLE || process.execPath
  const child = spawn(executable, launchArgs, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: development || join(__dirname, '../..') })
  let size = 0
  let output = ''
  let finished = false
  const fail = (message: string): void => {
    if (finished) return
    finished = true; process.exitCode = 1
    process.stdout.write(JSON.stringify({ ok: false, code: 'E_UNKNOWN', error: message, outcome: 'unknown' }) + '\n')
  }
  const timer = setTimeout(() => { fail('The native control host did not reply. Inspect daemon status before repeating an operation.'); child.stdout.destroy(); child.stderr.destroy(); child.unref() }, 60_000)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (data: string) => { size += Buffer.byteLength(data); if (size > 256 * 1024) fail('Native control response exceeded its limit.'); else output += data })
  child.stderr.on('data', () => {})
  child.once('error', () => { clearTimeout(timer); fail('The shipped Electron control runtime could not be launched. Reinstall the application.') })
  child.once('close', (code) => {
    clearTimeout(timer)
    if (finished) return
    try {
      const result: unknown = JSON.parse(output.trim())
      if (!result || typeof result !== 'object' || !('ok' in result) || typeof result.ok !== 'boolean') throw new Error('invalid')
      finished = true; process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.ok && code === 0 ? 0 : 1
    } catch { fail('The native control runtime returned no valid response. Inspect the original daemon owner and logs.') }
  })
}
