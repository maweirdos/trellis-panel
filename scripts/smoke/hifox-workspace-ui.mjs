/** Native mounted HiFox UI -> production preload -> IPC -> services -> isolated disk. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import config from '../../tailwind.config.js'

const fixture = mkdtempSync(join(tmpdir(), 'tpanel-hifox-workspace-'))
const flag = process.argv.indexOf('--report-dir')
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--report-dir requires a directory')
const reportDir = resolve(flag >= 0 ? process.argv[flag + 1] : 'out/hifox-review')
mkdirSync(reportDir, { recursive: true })
for (const name of ['summary.json', 'restart-summary.json', 'failure.json', 'failure-screen.txt', 'workspace-failed.png']) rmSync(join(reportDir, name), { force: true })
await Promise.all([
  build({ entryPoints: ['src/main/ipc/hifox.ts'], outfile: join(fixture, 'hifox-ipc.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' }),
  build({ entryPoints: ['src/preload/index.ts'], outfile: join(fixture, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' }),
  build({ entryPoints: ['scripts/smoke/fixtures/hifox-workspace-ui.tsx'], outfile: join(fixture, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'chrome124', tsconfig: 'tsconfig.web.json', logLevel: 'silent', loader: { '.svg': 'dataurl' } }),
  build({ stdin: { contents: `@import ${JSON.stringify(resolve('src/renderer/src/my/my.css').replaceAll('\\', '/'))};`, loader: 'css', resolveDir: process.cwd() }, outfile: join(fixture, 'shell.css'), bundle: true, logLevel: 'silent' })
])
const css = await postcss([tailwind({ ...config, content: [...config.content, './scripts/smoke/fixtures/hifox-workspace-ui.tsx'] })]).process('@tailwind base;@tailwind components;@tailwind utilities;', { from: undefined })
writeFileSync(join(fixture, 'tailwind.css'), css.css)
writeFileSync(join(fixture, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="tailwind.css"><link rel="stylesheet" href="shell.css"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.hifox-fixture-root{height:100%;font-family:var(--my-font-sans);font-size:var(--my-text-sm);color:var(--my-txt-primary);background:var(--my-bg-canvas)}</style><div id="root"></div><script src="fixture.js"></script></html>')
const env = { ...process.env, HIFOX_WORKSPACE_FIXTURE: fixture, HIFOX_WORKSPACE_REPORT: reportDir, HIFOX_WORKSPACE_ROOT: process.cwd(), HIFOX_STORE_DIR: join(fixture, 'store') }
delete env.ELECTRON_RUN_AS_NODE
writeFileSync(join(reportDir, 'retained-fixture.json'), JSON.stringify({ fixture, storeDir: env.HIFOX_STORE_DIR, scope: 'Actual HiFoxApp, preload, registered IPC, services, Chromium and isolated JSON storage; fixture owns navigation/appearance controls only; no remote sync, account authorization or runtime execution.' }, null, 2))
for (const reopen of [false, true]) {
  await new Promise((done, reject) => {
    const child = execFile(createRequire(import.meta.url)('electron'), [resolve('scripts/smoke/fixtures/hifox-workspace-host.cjs')], { env: { ...env, HIFOX_WORKSPACE_REOPEN: reopen ? '1' : '0' }, windowsHide: true, timeout: 240000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return }
      try { assert.ok(stdout.includes('HIFOX_WORKSPACE_UI_PASSED')); done() } catch (failure) { reject(failure) }
    })
    child.stdout.on('data', (bytes) => process.stdout.write(bytes))
    child.stderr.on('data', (bytes) => process.stderr.write(bytes))
  })
}
