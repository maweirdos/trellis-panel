import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { boundedRead, cacheDirectory } = require('../src/managed-plugin-cache-storage.cjs')
const launcher = fileURLToPath(new URL('../src/managed-zcode-launch.cjs', import.meta.url))
const compatModule = fileURLToPath(new URL('../src/managed-cache-compat.cjs', import.meta.url))
const trustModule = fileURLToPath(new URL('../src/managed-plugin-cache-trust.cjs', import.meta.url))

function setup(t) {
  const requested = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-cache-read-review-'))
  const temporary = fs.realpathSync.native(requested)
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const filename = path.join(temporary, 'asset.bin')
  fs.writeFileSync(filename, 'before')
  return { temporary, filename, requested }
}

test('bounded reads reject a same-length write after descriptor content was read', t => {
  const { filename } = setup(t)
  const originalRead = fs.readSync
  fs.readSync = function (...args) {
    const count = originalRead.apply(this, args)
    fs.writeFileSync(filename, 'after!')
    return count
  }
  try {
    assert.throws(() => boundedRead(filename, 100), /changed-read/)
  } finally { fs.readSync = originalRead }
})

test('bounded reads reject timestamp-only changes during a read', t => {
  const { filename } = setup(t)
  const originalRead = fs.readSync
  fs.readSync = function (...args) {
    const count = originalRead.apply(this, args)
    fs.utimesSync(filename, 1_700_000_000, 1_700_000_000)
    return count
  }
  try {
    assert.throws(() => boundedRead(filename, 100), /changed-read/)
  } finally { fs.readSync = originalRead }
})

test('bounded reads reject replacement between path validation and descriptor open', t => {
  const { filename, temporary } = setup(t)
  const replacement = path.join(temporary, 'replacement.bin')
  fs.writeFileSync(replacement, 'after!')
  const originalOpen = fs.openSync
  let replaced = false
  fs.openSync = function (target, ...args) {
    if (target === filename && !replaced) {
      replaced = true
      fs.renameSync(filename, path.join(temporary, 'previous.bin'))
      fs.renameSync(replacement, filename)
    }
    return originalOpen.call(this, target, ...args)
  }
  try {
    assert.throws(() => boundedRead(filename, 100), /changed-read/)
  } finally { fs.openSync = originalOpen }
})

test('bounded reads reject replacement after reading the open descriptor', t => {
  const { filename, temporary } = setup(t)
  const replacement = path.join(temporary, 'replacement.bin')
  fs.writeFileSync(replacement, 'after!')
  const originalRead = fs.readSync
  fs.readSync = function (...args) {
    const count = originalRead.apply(this, args)
    fs.renameSync(filename, path.join(temporary, 'previous.bin'))
    fs.renameSync(replacement, filename)
    return count
  }
  try {
    assert.throws(() => boundedRead(filename, 100), /changed-read/)
  } finally { fs.readSync = originalRead }
})

test('bounded reads retain exact bytes and enforce their limit', t => {
  const { filename } = setup(t)
  assert.deepEqual(boundedRead(filename, 6), Buffer.from('before'))
  assert.throws(() => boundedRead(filename, 5), /read-limit/)
  fs.writeFileSync(filename, '')
  assert.deepEqual(boundedRead(filename, 0), Buffer.alloc(0))
})

for (const kind of ['case', 'short-name']) {
  test(`cache parents require native realpaths rather than Windows ${kind} aliases`, t => {
    if (process.platform !== 'win32') return t.skip('Windows path aliases')
    const { temporary, requested } = setup(t)
    const alias = kind === 'case' ? temporary.toUpperCase() : requested
    if (alias === temporary) return t.skip('temporary parent has no short-name alias')
    assert.equal(fs.realpathSync.native(alias), temporary)
    const resources = path.join(temporary, 'ZCode', 'resources')
    fs.mkdirSync(resources, { recursive: true })
    assert.throws(() => cacheDirectory(path.join(alias, 'host-cache'), resources), /redirected-path/)
    assert.equal(fs.existsSync(path.join(temporary, 'host-cache')), false)
    assert.throws(() => cacheDirectory(path.join(alias, 'ZCode', 'forbidden-cache'), resources), /cache-in-installation|redirected-path/)
    assert.equal(fs.existsSync(path.join(temporary, 'ZCode', 'forbidden-cache')), false)
    const canonical = path.join(fs.realpathSync.native(alias), 'host-cache')
    assert.equal(cacheDirectory(canonical, resources), path.join(canonical, 'managed-plugin-cache-v1'))
  })
}

test('canonicalizing an input must not silently admit a junction ancestor', t => {
  const { temporary } = setup(t)
  const resources = path.join(temporary, 'ZCode', 'resources')
  const target = path.join(temporary, 'redirect-target')
  const alias = path.join(temporary, 'redirect')
  fs.mkdirSync(resources, { recursive: true })
  fs.mkdirSync(target)
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => cacheDirectory(path.join(alias, 'host-cache'), resources), /redirected-path|unsupported-entry/)
  assert.deepEqual(fs.readdirSync(target), [])
})

for (const kind of ['unsupported', 'missing']) {
  test(`prepare ${kind} reports the matching CLI path with a numeric exit and fixed reason`, async t => {
    const { temporary } = setup(t)
    const filename = path.join(temporary, 'native.cjs')
    const sideEffect = path.join(temporary, 'must-not-run')
    if (kind === 'unsupported') fs.writeFileSync(filename, `require('node:fs').writeFileSync(${JSON.stringify(sideEffect)}, 'executed')`)
    const cacheDir = path.join(temporary, 'cache')
    const input = kind === 'unsupported' && process.platform === 'win32' ? filename.toUpperCase() : filename
    let failure
    try {
      await promisify(execFile)(process.execPath, [launcher, '--prepare', input], {
        cwd: temporary, windowsHide: true, timeout: 10_000,
        env: { ...process.env, TRELLIS_ZCODE_STARTUP_CACHE_DIR: cacheDir }
      })
    } catch (error) { failure = error }
    assert.ok(failure)
    assert.equal(failure.code, kind === 'unsupported' ? 2 : 1)
    assert.equal(failure.stderr, '')
    const report = JSON.parse(failure.stdout)
    assert.equal(failure.stdout.trim().split('\n').length, 1)
    assert.equal(report.originalCli, filename)
    assert.equal(report.status, kind === 'unsupported' ? 'unsupported' : 'degraded')
    assert.equal(report.reason, kind === 'unsupported' ? 'unsupported-artifact' : 'cli-unavailable')
    assert.equal(fs.existsSync(sideEffect), false)
    assert.equal(fs.existsSync(cacheDir), false)
  })
}

for (const damage of ['missing', 'corrupt', 'hash-mismatch']) {
  test(`loader keeps official launch and non-executing prepare when the bundled table is ${damage}`, async t => {
    const { temporary } = setup(t)
    const filename = path.join(temporary, 'native.cjs')
    fs.writeFileSync(filename, `process.stdout.write(JSON.stringify({official:true,filename:__filename,argv:process.argv,main:require.main===module}));`)
    // Mock only compatibility discovery to exercise the verified-artifact branch
    // without depending on a local vendor installation or running its main.
    const code = `const o=JSON.parse(process.argv[1]),compat=require(${JSON.stringify(compatModule)}),trust=require(${JSON.stringify(trustModule)});compat.inspectCompatibility=()=>({hash:compat.CLI_SHA256,supported:true});trust.loadBundledTrustedAssets=()=>{if(o.damage==='missing')throw Object.assign(new Error('private-path-must-not-leak'),{code:'ENOENT'});if(o.damage==='corrupt')throw new SyntaxError('private-body-must-not-leak');return {version:1,cliSha256:'0'.repeat(64),plugins:[]}};require(${JSON.stringify(launcher)}).launch(o.prepare?['--prepare',o.filename]:[o.filename,'app-server','--mode=normal']);`
    const env = { ...process.env, TRELLIS_ZCODE_STARTUP_CACHE_DIR: path.join(temporary, 'cache') }
    const run = prepare => promisify(execFile)(process.execPath, ['-e', code, JSON.stringify({ damage, prepare, filename })],
      { cwd: temporary, env, windowsHide: true, timeout: 10_000 })
    const native = await run(false)
    assert.equal(native.stderr, '')
    assert.deepEqual(JSON.parse(native.stdout), { official: true, filename, argv: [process.execPath, filename, 'app-server', '--mode=normal'], main: true })
    let failure
    try { await run(true) } catch (error) { failure = error }
    assert.equal(failure?.code, 1)
    assert.equal(failure.stderr, '')
    assert.deepEqual(JSON.parse(failure.stdout), { version: 1, status: 'degraded', originalCli: filename,
      nativeSha256: require(compatModule).CLI_SHA256, reason: 'trusted-assets-unavailable' })
    assert.equal(fs.existsSync(env.TRELLIS_ZCODE_STARTUP_CACHE_DIR), false)
  })
}
