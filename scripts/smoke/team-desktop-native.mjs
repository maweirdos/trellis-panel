/** Real Windows safeStorage + Electron SQLite worker; explicit owned HTTP fixture. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
assert.equal(process.platform, 'win32', 'This gate verifies actual Windows safeStorage')
const fixture = mkdtempSync(join(tmpdir(), 'trellis-team-native-'))
const index = process.argv.indexOf('--report-dir')
const report = index >= 0 ? resolve(process.argv[index + 1]) : resolve('.trellis/tasks/10-20-wf-team-web-foundation/research/native-credential')
mkdirSync(report, { recursive: true })
await build({ entryPoints: ['src/main/services/team-platform/index.ts'], outfile: join(fixture, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
await build({ entryPoints: ['src/main/services/team-platform/store-worker.ts'], outfile: join(fixture, 'team-desktop-worker.js'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
const env = { ...process.env, TPANEL_TEAM_NATIVE_FIXTURE: fixture, TPANEL_TEAM_NATIVE_REPORT: report }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
try {
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [resolve('scripts/smoke/fixtures/team-desktop-native-host.cjs')], { env, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 })
  process.stdout.write(result.stdout)
  assert.ok(result.stdout.includes('TEAM_DESKTOP_NATIVE_PASSED'))
} catch (error) { if (error.stdout) process.stdout.write(error.stdout); if (error.stderr) process.stderr.write(error.stderr); throw error }
finally { writeFileSync(join(report, 'retained-native-fixture.json'), JSON.stringify({ fixture, qualification: 'Owned actual OS credential/SQLite evidence retained; no recursive deletion' }, null, 2)) }
