import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'trellis-connection-reader-'))
const owner = join(directory, 'owned-generation')
const outside = mkdtempSync(join(tmpdir(), 'trellis-connection-foreign-'))
mkdirSync(owner)
try {
  await build({ entryPoints: ['src/main/services/acp/connection-timings.ts'], outfile: join(directory, 'reader.mjs'), bundle: true, platform: 'node', format: 'esm' })
  const { readConnectionTimings } = await import(pathToFileURL(join(directory, 'reader.mjs')).href)
  const file = join(owner, 'zcode-adapter-connection-timings.json')
  const data = { version: 1, operation: 'new', status: 'completed', backendReused: false, totalDurationMs: 250,
    stages: ['backend-process', 'storage-ready', 'account-sync', 'session-create-or-resume', 'subscribe'].map(stage => ({ stage, status: 'completed', durationMs: 30,
      arbitraryPayload: 'MUST-NOT-CROSS-BOUNDARY', reason: 'MUST-NOT-CROSS-BOUNDARY' })), credential: 'MUST-NOT-CROSS-BOUNDARY' }
  writeFileSync(file, JSON.stringify(data))
  const parsed = readConnectionTimings(owner, 0)
  assert.ok(parsed)
  assert.ok(!JSON.stringify(parsed).includes('MUST-NOT-CROSS-BOUNDARY'))
  utimesSync(file, new Date(1000), new Date(1000))
  assert.equal(readConnectionTimings(owner, Date.now()), undefined, 'A previous attempt cannot supply current timing facts')
  for (const value of [{ ...data, version: 2 }, { ...data, stages: data.stages.slice(1) }, { ...data, totalDurationMs: -1 },
    { ...data, stages: data.stages.map(stage => ({ ...stage, durationMs: 9999 })) },
    { ...data, stages: data.stages.map(stage => ({ ...stage, status: 'skipped' })) },
    { ...data, arbitraryPayload: 'x'.repeat(9000) }]) {
    writeFileSync(file, JSON.stringify(value))
    assert.equal(readConnectionTimings(owner, 0), undefined)
  }
  writeFileSync(join(outside, 'zcode-adapter-connection-timings.json'), JSON.stringify(data))
  symlinkSync(outside, join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(readConnectionTimings(join(directory, 'escape'), 0), undefined)
  symlinkSync(owner, join(directory, 'other-generation'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(file, JSON.stringify(data))
  assert.equal(readConnectionTimings(join(directory, 'other-generation'), 0), undefined, 'A sibling generation cannot supply owned timing facts')
  console.log('PASS exact stage schema, secret/unknown stripping, attempt freshness, duration/count bounds, oversized and foreign-root rejection')
} finally {
  for (const path of [directory, outside]) {
    assert.ok(path.startsWith(join(tmpdir(), 'trellis-connection-')))
    rmSync(path, { recursive: true, force: true })
  }
}
