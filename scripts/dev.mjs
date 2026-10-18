import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareDevHost } from './prepare-dev-host.mjs'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
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
