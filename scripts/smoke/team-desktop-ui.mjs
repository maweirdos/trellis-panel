/** Actual desktop React/Chromium; team IPC fixture, not company/server acceptance. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import config from '../../tailwind.config.js'
const fixture = mkdtempSync(join(tmpdir(), 'tpanel-team-desktop-ui-'))
const option = (flag, fallback) => { const index = process.argv.indexOf(flag); return resolve(index >= 0 ? process.argv[index + 1] : fallback) }
const reportDir = option('--report-dir', '.trellis/tasks/10-20-wf-team-web-foundation/research/desktop-ui-browser')
mkdirSync(reportDir, { recursive: true })
await build({ entryPoints: ['scripts/smoke/fixtures/team-desktop-ui.tsx'], outfile: join(fixture, 'fixture.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', target: 'chrome124', logLevel: 'silent', plugins: [{ name: 'owned-wrapped-team-ipc', setup(builder) { builder.onResolve({ filter: /^\.\.\/api$/ }, (args) => args.importer.replaceAll('\\', '/').includes('/renderer/src/team/') ? { path: 'owned-team-api', namespace: 'team-fixture' } : null); builder.onLoad({ filter: /.*/, namespace: 'team-fixture' }, () => ({ contents: 'export const api=new Proxy({},{get(_target,key){return window.teamFixture.api[key]}});export const hasIpc=true;', loader: 'js' })) } }] })
const css = await postcss([tailwind(config)]).process('@tailwind base;@tailwind components;@tailwind utilities;', { from: undefined })
writeFileSync(join(fixture, 'tailwind.css'), css.css)
writeFileSync(join(fixture, 'index.html'), '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="tailwind.css"><link rel="stylesheet" href="fixture.css"><style>body{margin:0}.team-fixture-root{min-height:100vh;background:var(--my-bg-canvas);color:var(--my-txt-primary);font-family:var(--my-font-sans);font-size:var(--my-text-sm)}.team-fixture-root>main,.team-fixture-root main{padding:24px}.team-fixture-root h1{font-size:20px;margin:0 0 12px}.team-fixture-root main>p{color:var(--my-txt-tertiary);margin:0 0 24px}</style><div id="root"></div><script src="fixture.js"></script></html>')
// Canonical shell CSS is bundled in a separate entry so component imports remain real.
await build({ stdin: { contents: `@import ${JSON.stringify(resolve('src/renderer/src/my/my.css').replaceAll('\\', '/'))};`, loader: 'css', resolveDir: process.cwd() }, outfile: join(fixture, 'shell.css'), bundle: true, logLevel: 'silent' })
const html = readFileSync(join(fixture, 'index.html'), 'utf8').replace('<link rel="stylesheet" href="fixture.css">', '<link rel="stylesheet" href="shell.css"><link rel="stylesheet" href="fixture.css">')
writeFileSync(join(fixture, 'index.html'), html)
const env = { ...process.env, TPANEL_TEAM_UI_FIXTURE: fixture, TPANEL_TEAM_UI_REPORT: reportDir }; delete env.ELECTRON_RUN_AS_NODE
try { const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [resolve('scripts/smoke/fixtures/team-desktop-ui-host.cjs')], { env, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 }); process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); assert.ok(result.stdout.includes('TEAM_DESKTOP_UI_PASSED')) }
catch (error) { if (error.stdout) process.stdout.write(error.stdout); if (error.stderr) process.stderr.write(error.stderr); throw error }
finally { writeFileSync(join(reportDir, 'retained-fixture.json'), JSON.stringify({ fixture, qualification: 'Actual React/Chromium fixture retained; team/HTTP/native calls are explicit boundaries' }, null, 2)) }
