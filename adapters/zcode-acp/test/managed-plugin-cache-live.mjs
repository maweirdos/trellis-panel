import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const { CLI_SHA256, sha256 } = require('../src/managed-cache-compat.cjs')
const originalCli = process.argv[2]
if (!originalCli) throw new Error('Pass the installed original CLI as the only argument')
assert.equal(sha256(fs.readFileSync(originalCli)), CLI_SHA256)
const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-managed-live-')))
const profile = path.join(temporary, 'profile')
const project = path.join(temporary, 'project')
const cacheDir = path.join(temporary, 'cache')
fs.mkdirSync(profile)
fs.mkdirSync(project)
const launcher = fileURLToPath(new URL('../src/managed-zcode-launch.cjs', import.meta.url))
const preload = fileURLToPath(new URL('./fixtures/managed-plugin-cache-reads.cjs', import.meta.url))
const seedWorker = fileURLToPath(new URL('./fixtures/managed-plugin-cache-seed.cjs', import.meta.url))
const env = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
  ZCODE_HOME: profile, ZCODE_DATA_BASE_DIR: profile, TRELLIS_ZCODE_STARTUP_CACHE_DIR: cacheDir,
  MANAGED_CACHE_TEST_CLI: fs.realpathSync.native(originalCli), NODE_OPTIONS: '' }
try {
  const results = []
  for (let index = 0; index < 2; index++) {
    const counts = path.join(temporary, 'counts-' + index + '.json')
    const started = performance.now()
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--require', preload, launcher, '--prepare', originalCli],
      { cwd: project, env: { ...env, MANAGED_CACHE_TEST_COUNTS: counts }, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 })
    assert.ok(stderr === '' || /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n$/.test(stderr), 'only the native Node SQLite warning is expected')
    const report = JSON.parse(stdout)
    assert.equal(stdout.trim().split('\n').length, 1)
    assert.equal(report.version, 1)
    assert.equal(report.status, 'prepared')
    assert.equal(report.nativeSha256, CLI_SHA256)
    assert.ok(report.counts.roots > 0)
    assert.ok(report.counts.files > 0)
    const reads = JSON.parse(fs.readFileSync(counts, 'utf8'))
    results.push({ milliseconds: Math.round(performance.now() - started), ...report.counts, ...reads })
    assert.deepEqual(fs.readdirSync(profile), [], 'prepare must not write account/session/profile files')
    assert.deepEqual(fs.readdirSync(project), [], 'prepare must not write project files')
  }
  assert.equal(results[1].sourceReadCalls, 0, 'new process hit reads no original plugin content')
  assert.ok(results[1].packReadBytes > 0)
  const seedCounts = path.join(temporary, 'seed-counts.json')
  const seedDir = path.join(temporary, 'native-seed')
  const seeded = await promisify(execFile)(process.execPath, ['--require', preload, seedWorker], {
    cwd: project, env: { ...env, MANAGED_CACHE_TEST_COUNTS: seedCounts, MANAGED_CACHE_TEST_SEED_DIR: seedDir },
    windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 })
  const seedResult = JSON.parse(seeded.stdout)
  assert.equal(seedResult.missing, 0, 'native Coc must accept every bundled asset SHA and finish seeding')
  assert.equal(seedResult.stats.hits, results[1].roots)
  const seedReads = JSON.parse(fs.readFileSync(seedCounts, 'utf8'))
  assert.equal(seedReads.sourceReadCalls, 0, 'native Coc dFn must read original assets from pack')
  assert.deepEqual(fs.readdirSync(profile), [])
  assert.deepEqual(fs.readdirSync(project), [])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cacheDir, 'managed-zcode-ready.json'), 'utf8')).counts,
    { roots: results[1].roots, files: results[1].files, bytes: results[1].bytes })
  assert.equal(sha256(fs.readFileSync(originalCli)), CLI_SHA256, 'installation CLI remains unchanged')
  process.stdout.write(JSON.stringify({ modelPromptsSent: 0, ownedProfileFiles: 0, ownedProjectFiles: 0, prepares: results,
    nativeFreshSeed: { ...seedResult, ...seedReads } }) + '\n')
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
