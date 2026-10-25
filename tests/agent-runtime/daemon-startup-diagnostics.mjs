import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'trellis-startup-diagnostics-')))
try {
  const file = join(directory, 'diagnostics.cjs')
  await build({ entryPoints: ['src/main/daemon/startup-failure.ts'], outfile: file, bundle: true, platform: 'node', format: 'cjs' })
  const api = createRequire(import.meta.url)(file)
  const since = Date.now()
  const error = Object.assign(new Error("Cannot find module 'owned-fixture' SECRET-FIXTURE"), { code: 'MODULE_NOT_FOUND' })
  const diagnostic = api.recordDaemonStartupFailure(directory, error, 'load')
  assert.match(diagnostic, /missing module: owned-fixture/)
  assert.ok(!readFileSync(join(directory, 'startup-failure.json'), 'utf8').includes('SECRET-FIXTURE'))
  assert.equal(api.readDaemonStartupFailure(directory, process.pid, since), diagnostic.trim())
  assert.equal(api.readDaemonStartupFailure(directory, process.pid + 1, since), undefined)
  assert.equal(api.readDaemonStartupFailure(directory, process.pid, Date.now() + 1), undefined)
  const stored = JSON.parse(readFileSync(join(directory, 'startup-failure.json'), 'utf8'))
  writeFileSync(join(directory, 'startup-failure.json'), JSON.stringify({ ...stored, at: Date.now() + 60000 }))
  assert.equal(api.readDaemonStartupFailure(directory, process.pid, since), undefined)
  writeFileSync(join(directory, 'startup-failure.json'), 'x'.repeat(4096))
  assert.equal(api.readDaemonStartupFailure(directory, process.pid, since), undefined)
  assert.equal(api.readDaemonStartupFailure(join(directory, 'missing'), process.pid, since), undefined)
  writeFileSync(join(directory, 'not-a-directory'), '')
  assert.match(api.recordDaemonStartupFailure(join(directory, 'not-a-directory'), error, 'run'), /startup run failed/)
  console.log('PASS bounded startup failure publication, original PID/time fences, malformed/missing records and secret exclusion')
} finally {
  assert.ok(directory.startsWith(join(realpathSync(tmpdir()), 'trellis-startup-diagnostics-')))
  rmSync(directory, { recursive: true, force: true })
}
