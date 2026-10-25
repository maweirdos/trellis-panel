import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'trellis-zcode-fs-probe-')))
const entry = join(directory, 'resources', 'glm', 'native.cjs')
const counts = join(directory, 'counts.json')
const preload = fileURLToPath(new URL('./startup-fs-probe.cjs', import.meta.url))
mkdirSync(dirname(entry), { recursive: true })
writeFileSync(entry, `
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const plugin = path.join(__dirname, '..', 'plugin')
fs.mkdirSync(plugin)
const file = path.join(plugin, 'payload')
fs.writeFileSync(file, 'fixture')
assert.equal(fs.readFileSync(file, 'utf8'), 'fixture')
assert.deepEqual(fs.readFileSync(file), Buffer.from('fixture'))
assert.deepEqual(fs.readdirSync(plugin), ['payload'])
assert.equal(fs.statSync(file).size, 7)
assert.throws(() => fs.readFileSync(path.join(plugin, 'missing')), { code: 'ENOENT' })
const seed = path.join(path.dirname(__dirname), '.zcode-plugin-seed.json')
fs.writeFileSync(seed, '{}')
assert.equal(fs.existsSync(seed), true)
assert.equal(fs.readFileSync(seed, 'utf8'), '{}')
function collectFilesystemPluginFiles() { return crypto.createHash('sha256').update('fixture').digest('hex') }
function hashSeedFiles() { return crypto.createHash('sha256').update(Buffer.from('manifest')).digest() }
function seedBundledOfficialPlugins() { return crypto.createHash('sha256').update('fixture').digest('hex') }
assert.equal(collectFilesystemPluginFiles(), seedBundledOfficialPlugins())
assert.equal(hashSeedFiles().length, 32)
const copy = path.join(__dirname, '..', 'plugins', 'cache', 'fixture.tmp-' + process.pid + '-0', 'payload')
fs.mkdirSync(path.dirname(copy), { recursive: true })
fs.writeFileSync(copy, Buffer.from('fixture'))
process.stdout.write(JSON.stringify({ result: { session: { sessionId: 'SECRET-FIXTURE' } } }) + '\\n')
`)
try {
  const env = { ...process.env, TRELLIS_ZCODE_STARTUP_FS_BIN: entry, TRELLIS_ZCODE_STARTUP_FS_FILE: counts }
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--require', preload, entry, 'app-server'],
    { env, timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 })
  assert.equal(stderr, '')
  assert.equal(JSON.parse(stdout).result.session.sessionId, 'SECRET-FIXTURE', 'Preload must preserve stdout bytes')
  const raw = readFileSync(counts, 'utf8')
  const value = JSON.parse(raw)
  assert.equal(value.version, 1)
  assert.equal(value.seedMetadataChecks, 1)
  assert.equal(value.seedMetadataReads, 1)
  assert.equal(value.seedMetadataWrites, 1)
  assert.equal(value.firstSeedCheck.sourceReadCalls, 3, 'Include failed native reads without swallowing their errors')
  assert.equal(value.firstSeedCheck.sourceReadBytes, 14)
  assert.equal(value.firstSeedCheck.sourceReaddirCalls, 1)
  for (const key of ['sourceReadMs', 'sourceReaddirMs', 'sourceStatMs']) {
    assert.ok(Number.isSafeInteger(value.firstSeedCheck[key]) && value.firstSeedCheck[key] >= 0)
    assert.ok(value.firstSeedCheck[key] <= value[key])
  }
  assert.equal(value.seedCopyWriteCalls, 1)
  assert.equal(value.seedCopyWriteBytes, 7)
  for (const field of ['fileHash', 'manifestHash', 'seedVerificationHash']) {
    assert.equal(value[`${field}Calls`], 1)
    assert.equal(value[`${field}Bytes`], field === 'manifestHash' ? 8 : 7)
  }
  for (const key of ['sourceReadMs', 'sourceReaddirMs', 'sourceStatMs']) assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0)
  assert.ok(!raw.includes('SECRET') && !raw.includes(directory), 'Observation must retain no payloads or paths')
  await promisify(execFile)(process.execPath, ['--require', preload, '--eval', 'process.stdout.write("unrelated-child")'],
    { env, timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 })
  assert.equal(readFileSync(counts, 'utf8'), raw, 'An unrelated child inheriting the preload must not publish observations')
  console.log('PASS native startup I/O observation preserves fs/stdout semantics, counts failed reads, and excludes payloads/paths')
} finally {
  assert.equal(dirname(directory), realpathSync(resolve(tmpdir())))
  assert.ok(basename(directory).startsWith('trellis-zcode-fs-probe-'))
  rmSync(directory, { recursive: true, force: true })
}
