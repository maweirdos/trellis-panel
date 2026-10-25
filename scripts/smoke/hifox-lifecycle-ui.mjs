/** Mounted production UI/preload/IPC/services; all data and task.py writes stay under tmpdir. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import config from '../../tailwind.config.js'

const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'tpanel-hifox-lifecycle-ui-')))
const flag = process.argv.indexOf('--report-dir')
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--report-dir requires a directory')
const reportDir = resolve(flag >= 0 ? process.argv[flag + 1] : 'out/hifox-lifecycle-review')
mkdirSync(reportDir, { recursive: true })
for (const name of ['summary.json', 'failure.json', 'failure.png']) rmSync(join(reportDir, name), { force: true })
await Promise.all([
  build({ stdin: { contents: "export { registerHifoxIpc } from './src/main/ipc/hifox';export { registerHifoxWorkIpc } from './src/main/ipc/hifox-work';export { scanProject } from './src/main/services/scan';export { expectedDefaultPrd } from './src/main/services/local-task/operations';export { ipcInvoke, ipcEvent } from './src/shared/ipc-channels'", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(fixture, 'hifox-ipc.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' }),
  build({ entryPoints: ['src/preload/index.ts'], outfile: join(fixture, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' }),
  build({ entryPoints: ['scripts/smoke/fixtures/hifox-lifecycle-ui.tsx'], outfile: join(fixture, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'chrome124', tsconfig: 'tsconfig.web.json', loader: { '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'silent' }),
  build({ stdin: { contents: `@import ${JSON.stringify(resolve('src/renderer/src/my/my.css').replaceAll('\\', '/'))};`, loader: 'css', resolveDir: process.cwd() }, outfile: join(fixture, 'shell.css'), bundle: true, logLevel: 'silent' })
])
const css = await postcss([tailwind({ ...config, content: [...config.content, './scripts/smoke/fixtures/hifox-lifecycle-ui.tsx'] })]).process('@tailwind base;@tailwind components;@tailwind utilities;', { from: undefined })
writeFileSync(join(fixture, 'tailwind.css'), css.css)
writeFileSync(join(fixture, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="tailwind.css"><link rel="stylesheet" href="shell.css"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.hifox-fixture-root{height:100%;font-family:var(--my-font-sans);color:var(--my-txt-primary);background:var(--my-bg-canvas)}</style><div id="root"></div><script src="fixture.js"></script></html>')
const env = { ...process.env, HIFOX_WORKSPACE_FIXTURE: fixture, HIFOX_WORKSPACE_REPORT: reportDir, HIFOX_STORE_DIR: join(fixture, 'store') }
delete env.ELECTRON_RUN_AS_NODE
writeFileSync(join(reportDir, 'retained-fixture.json'), JSON.stringify({ fixture, scope: 'Production HiFoxApp, original IssuePeek, real preload/IPC/local services, isolated JSON store and Python CLI fixture. No real project writes or external services. Native reader routing checked through production store; full reader/return is separate acceptance.' }, null, 2))
try {
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [resolve('scripts/smoke/fixtures/hifox-lifecycle-host.cjs')], { env, windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
  process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert.ok(result.stdout.includes('HIFOX_LIFECYCLE_UI_PASSED'))
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
}
