import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareDevHost } from './prepare-dev-host.mjs'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
// Windows process inspection sees the original OS argv, not Node's normalized
// process.argv. Establish one absolute script entry for native authorization.
if (process.platform === 'win32' && process.env.CRUX_DEV_ABSOLUTE_ENTRY !== '1') {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    stdio: 'inherit', windowsHide: true, env: { ...process.env, CRUX_DEV_ABSOLUTE_ENTRY: '1' }
  })
  if (child.error) throw child.error
  process.exit(child.status ?? 1)
}
delete process.env.CRUX_DEV_ABSOLUTE_ENTRY
const forwardedIndex = args.indexOf('--')
const forwarded = forwardedIndex < 0 ? JSON.parse(process.env.ELECTRON_CLI_ARGS || '[]') : args.slice(forwardedIndex + 1)
if (!Array.isArray(forwarded) || forwarded.some(value => typeof value !== 'string')) throw new Error('Electron arguments must be a string array')
if (forwarded.some(value => value.startsWith('--trellis-role=') && value !== '--trellis-role=gui')) throw new Error('Development starts the GUI launcher only')
const guiArgs = [...forwarded.filter(value => !value.startsWith('--trellis-role=')), '--trellis-role=gui-launcher']
if (forwardedIndex < 0) args.push('--', ...guiArgs)
else args.splice(forwardedIndex + 1, args.length, ...guiArgs)
// electron-vite main rebuilds inherit this launch, renderer HMR does not create
// a new one. The GUI binds it to this live launcher generation before stopping.
process.env.CRUX_DEV_LAUNCH_ID = randomUUID()
process.env.CRUX_DEV_LAUNCH_PID = String(process.pid)
process.env.CRUX_DEV_LAUNCH_ROOT = root
// Keep the actual Electron OS argv attributable to this installation. The CLI's
// explicit --entry option remains authoritative when electron-vite parses it.
process.env.ELECTRON_ENTRY ??= root
// Respect an explicit toolchain override. The normal Windows dev command uses our host.
if (process.platform === 'win32' && !process.env.ELECTRON_EXEC_PATH) {
  process.env.ELECTRON_EXEC_PATH = await prepareDevHost()
  process.env.TPANEL_BRANDED_DEV_HOST = '1'
}
const cli = join(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')
process.chdir(root)
process.argv = [process.execPath, cli, 'dev', ...args]
// Keep electron-vite's own process/signal handling and CLI options intact.
await import(pathToFileURL(cli).href)
