/** Run actual built Electron application against owned files/profile; no model/Jira calls. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { promisify } from 'node:util'

assert.equal(process.platform, 'win32', 'This native acceptance entrypoint targets Windows')
const root = resolve('.')
assert.ok(existsSync(join(root, 'out/main/index.js')), 'Run npm run build before the native fixture')
const index = process.argv.indexOf('--report-dir')
const report = index >= 0 ? resolve(process.argv[index + 1]) : resolve('.trellis/tasks/10-20-wf-reading-windows/review/native-app')
mkdirSync(report, { recursive: true })
const fixture = mkdtempSync(join(tmpdir(), 'trellis-reader-native-app-'))
const env = { ...process.env, TPANEL_NATIVE_REPO_ROOT: root, TPANEL_NATIVE_FIXTURE_ROOT: fixture, TPANEL_NATIVE_REPORT_DIR: report }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.TPANEL_DEBUG_PORT
try {
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [resolve('scripts/smoke/fixtures/reading-window-native-host.cjs')], { env, windowsHide: true, timeout: 110000, maxBuffer: 2 * 1024 * 1024 })
  process.stdout.write(result.stdout)
  assert.ok(result.stdout.includes('READING_WINDOW_NATIVE_APP_PASSED'))
  console.log(`Native subset report: ${join(report, 'native-report.json')}`)
} catch (error) { if (error.stdout) process.stdout.write(error.stdout); if (error.stderr) process.stderr.write(error.stderr); throw error }
finally {
  assert.equal(dirname(resolve(fixture)), resolve(tmpdir()))
  assert.ok(basename(fixture).startsWith('trellis-reader-native-app-'))
  rmSync(fixture, { recursive: true, force: true })
}
