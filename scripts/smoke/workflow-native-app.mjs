/** Opt-in real managed Codex + snapshotted production Electron/controller/graph. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
assert.equal(process.platform, 'win32')
assert.ok(process.argv.includes('--run'), 'Actual vendor invocation requires --run')
const root = realpathSync.native(resolve('.'))
const installed = JSON.parse(readFileSync('.trellis/tasks/10-20-wf-capability-baselines/research/current/installed.json', 'utf8'))
const index = process.argv.indexOf('--report-dir')
const report = index >= 0 ? resolve(process.argv[index + 1]) : resolve('.trellis/tasks/10-20-wf-core-vertical-acceptance/review/native-app')
assert.ok(existsSync(join(root, 'out/main/index.js')), 'Build current application first')
mkdirSync(report, { recursive: true })
const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-workflow-native-app-')))
const snapshot = join(fixture, 'application')
mkdirSync(snapshot)
cpSync(join(root, 'out'), join(snapshot, 'out'), { recursive: true })
cpSync(join(root, 'resources/brand'), join(snapshot, 'resources/brand'), { recursive: true })
const dependencyLink = join(snapshot, 'node_modules')
symlinkSync(join(root, 'node_modules'), dependencyLink, 'junction')
const runtimeLink = join(fixture, 'profile/acp/runtimes/codex/2.2.2')
mkdirSync(dirname(runtimeLink), { recursive: true })
const runtime = resolve(installed.agents.codex.adapter.entry, '../../../../../')
assert.ok(existsSync(join(runtime, 'node_modules/@agentclientprotocol/codex-acp/package.json')), 'Pinned actual managed adapter location must resolve')
if (!process.argv.includes('--recovery-only')) symlinkSync(runtime, runtimeLink, 'junction')
const env = { ...process.env, TPANEL_WORKFLOW_FIXTURE: fixture, TPANEL_WORKFLOW_SNAPSHOT: snapshot, TPANEL_WORKFLOW_REPORT: report, TPANEL_WORKFLOW_NODE: installed.nodeExecutable }
if (process.argv.includes('--select-origin')) env.TPANEL_WORKFLOW_SELECT_ORIGIN = '1'
if (process.argv.includes('--navigation-only')) {
  assert.ok(!process.argv.includes('--select-origin'), 'Exact-return verification cannot use sidebar selection')
  env.TPANEL_WORKFLOW_NAVIGATION_ONLY = '1'
}
if (process.argv.includes('--recovery-only')) {
  assert.ok(!process.argv.includes('--navigation-only') && !process.argv.includes('--select-origin'))
  env.TPANEL_WORKFLOW_RECOVERY_ONLY = '1'
}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.TPANEL_DEBUG_PORT
let passed = false
try {
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), [resolve('scripts/smoke/fixtures/workflow-native-host.cjs')], { env, windowsHide: true, timeout: 360000, maxBuffer: 2 * 1024 * 1024 })
  process.stdout.write(result.stdout)
  passed = result.stdout.includes('WORKFLOW_NATIVE_APP_PASSED')
  assert.ok(passed)
  const evidencePath = join(report, process.argv.includes('--recovery-only') ? 'native-recovery-launcher-report.json' : process.argv.includes('--navigation-only') ? 'native-navigation-report.json' : 'native-workflow-report.json')
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  evidence.ownedShutdown = 'confirmed by actual will-quit marker and child exit0'
  evidence.retainedFixture = fixture
  evidence.cleanup = 'Owned snapshot and immutable evidence retained; no recursive deletion'
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
  console.log(`Actual native workflow report: ${evidencePath}`)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  writeFileSync(join(report, 'retained-fixture.json'), JSON.stringify({ fixture, reason: 'Failure/timeout does not prove native drain; retain exact evidence and files' }, null, 2))
  throw error
}
