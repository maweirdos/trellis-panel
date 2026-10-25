/** Actual packaged control/daemon processes and an owned blank Windows profile. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, isAbsolute } from 'node:path'

const index = process.argv.indexOf('--package-dir')
if (index < 0 || !process.argv[index + 1]) {
  console.log('Usage: node tests/agent-runtime/daemon-packaged.mjs --package-dir release/win-unpacked')
  process.exit(0)
}
assert.equal(process.platform, 'win32', 'This check exercises Windows native protection and process identity')
const packaged = realpathSync.native(resolve(process.argv[index + 1]))
const executable = join(packaged, 'Trellis Panel.exe')
assert.ok(existsSync(executable))
const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-daemon-packaged-')))
const profile = join(directory, 'profile')
mkdirSync(profile)
const environment = { ...process.env }
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'TPANEL_DEBUG_PORT', 'TRELLIS_DAEMON_DEV_APP', 'TRELLIS_DAEMON_EXECUTABLE']) delete environment[key]
const evidence = { scope: 'actual-packaged-control-and-daemon-blank-profile', packaged, startedAt: new Date().toISOString(), observations: [], promptsSubmitted: 0, actualUserProfileTouched: false }
const report = join(directory, 'acceptance.json')
const diagnostic = value => String(value ?? '').replace(/Bearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi, '[redacted]').replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;}]+/gi, '$1=[redacted]').slice(-6000)
let owned
let stopped = false
async function control(command) {
  const start = performance.now()
  const result = await new Promise((done, fail) => {
    let exitDrain, settled = false, partial = ''
    const child = execFile(executable, ['--trellis-role=control', `--trellis-command=${command}`, `--trellis-user-data-base64=${Buffer.from(profile).toString('base64')}`],
      { env: environment, windowsHide: true, timeout: 60000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
        clearTimeout(exitDrain)
        if (settled) return
        settled = true
        let response
        try { response = JSON.parse(stdout.trim()) } catch { fail(new Error(`Packaged ${command} returned no valid bounded response (${error?.code ?? 'exit'})`)); return }
        if (!response.ok) { evidence.diagnostic = diagnostic(stderr); fail(new Error(`Packaged ${command} refused: ${response.code ?? 'unknown'}: ${diagnostic(response.error).slice(0, 400)}`)); return }
        if (error) { fail(new Error(`Packaged ${command} exited unsuccessfully`)); return }
        done(response.data)
      })
    child.stdout.on('data', bytes => {
      partial = (partial + bytes.toString()).slice(-512 * 1024)
      // Retain only this owned profile's acknowledged owner for canonical
      // cleanup if the control process exits but inherited pipes remain open.
      try {
        const response = JSON.parse(partial.trim())
        if (command === 'start' && response.ok && response.data?.identity?.mode === 'production'
          && response.data.owner?.executable?.toLowerCase() === executable.toLowerCase()) owned = response.data
      } catch { /* A partial response is not ownership evidence. */ }
    })
    child.once('exit', () => {
      exitDrain = setTimeout(() => {
        if (settled) return
        settled = true
        fail(new Error(`Packaged ${command} exited but its output pipes remained owned by another process`))
      }, 3000)
    })
  })
  evidence.observations.push({ command, durationMs: Math.round(performance.now() - start), status: 'passed' })
  return result
}
try {
  owned = await control('start')
  assert.equal(owned.identity.mode, 'production')
  assert.equal(realpathSync.native(owned.owner.executable).toLowerCase(), realpathSync.native(executable).toLowerCase())
  assert.equal(owned.activeJobs, 0)
  assert.equal(owned.unknownJobs, 0)
  for (let count = 0; count < 3; count++) {
    const status = await control('status')
    assert.equal(status.epoch, owned.epoch)
    assert.deepEqual(status.owner, owned.owner)
  }
  const daemonDirectory = join(profile, 'daemon-v1', 'production')
  const lease = JSON.parse(readFileSync(join(daemonDirectory, 'owner', 'lease.json'), 'utf8'))
  assert.equal(lease.epoch, owned.epoch)
  const stamp = JSON.parse(readFileSync(join(daemonDirectory, `daemon-build-${lease.epoch}-${lease.nonce}.json`), 'utf8'))
  assert.deepEqual(stamp.lease, lease)
  assert.equal(stamp.idleStopVersion, 1)
  const require = createRequire(import.meta.url)
  const bytes = require('@electron/asar').extractFile(join(packaged, 'resources', 'app.asar'), join('out', 'main', 'daemon-host.js'))
  assert.equal(stamp.sha256, createHash('sha256').update(bytes).digest('hex'))
  evidence.observations.push({ check: 'published hash matches actual packaged role bundle and exact native owner', status: 'passed' })
  await control('stop')
  stopped = true
  assert.ok(!existsSync(join(daemonDirectory, 'owner', 'lease.json')), 'Canonical stop must release its original lease')
  evidence.status = 'passed'
  console.log('PASS actual packaged daemon start, repeated authenticated status, exact bundle/owner build stamp, canonical stop and verified exit')
} catch (error) {
  evidence.status = 'failed'
  evidence.failure = error instanceof Error ? error.message : 'Packaged daemon check failed'
  throw error
} finally {
  if (!stopped && owned) {
    try { await control('stop'); stopped = true } catch { evidence.cleanup = 'unknown: preserve original owned profile for native recovery' }
  }
  writeFileSync(report, JSON.stringify(evidence, null, 2) + '\n')
  if (stopped) {
    const contained = relative(directory, realpathSync.native(profile))
    assert.equal(contained, 'profile')
    assert.ok(!isAbsolute(contained))
    rmSync(profile, { recursive: true, force: true })
  }
  console.log(`EVIDENCE ${report}`)
}
