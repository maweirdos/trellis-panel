import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { prepareDevHost } from './prepare-dev-host.mjs'

const command = process.argv[2]
if (!command || process.argv.length !== 3 || !['status', 'stop', 'restart'].includes(command)) {
  console.error('Usage: npm run daemon:<status|stop|restart>')
  process.exit(1)
}

const executable = process.platform === 'win32' ? await prepareDevHost() : process.execPath
const child = spawn(executable, [resolve(import.meta.dirname, '../out/main/daemon-cli.js'), 'daemon', command], {
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRELLIS_DAEMON_DEV_APP: process.cwd(), TRELLIS_DAEMON_EXECUTABLE: executable },
  stdio: 'inherit',
  windowsHide: true
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.once('error', error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
child.once('exit', code => process.exit(code ?? 1))
