import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-daemon-build-'))
try {
  const output = join(temporary, 'identity.cjs')
  await build({ entryPoints: ['src/main/daemon/build-identity.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs' })
  const identity = createRequire(import.meta.url)(output)
  const bundle = join(temporary, 'daemon-host.js')
  writeFileSync(bundle, 'original daemon bytes\n')
  const started = Date.now() - 1000
  utimesSync(bundle, new Date(started - 1000), new Date(started - 1000))
  const context = {
    directory: join(temporary, 'profile'),
    identity: { profileId: 'a'.repeat(64), userId: 'fixture-user', mode: 'development', appVersion: '0.1.0', installationId: 'b'.repeat(64) },
    owner: { pid: 12345, startedAt: String(BigInt(started) * 10000n + 621355968000000000n), userId: 'fixture-user', executable: 'C:\\fixture\\electron.exe' }
  }
  mkdirSync(join(context.directory, 'owner'), { recursive: true })
  const loaded = identity.captureDaemonBuild()
  const lease = { version: 1, epoch: randomUUID(), nonce: randomUUID(), identity: context.identity, owner: context.owner, acquiredAt: Date.now() }
  const leaseFile = join(context.directory, 'owner', 'lease.json')
  const stamp = join(context.directory, `daemon-build-${lease.epoch}-${lease.nonce}.json`)
  writeFileSync(leaseFile, JSON.stringify(lease))
  assert.deepEqual(identity.daemonBuildFreshness(context, lease), { state: 'unknown', idleStop: false }, 'legacy owner is not proven current by an older file')
  identity.publishDaemonBuild(context, lease, loaded)
  const original = readFileSync(stamp, 'utf8')
  assert.deepEqual(identity.daemonBuildFreshness(context, lease), { state: 'current', idleStop: true })
  const nativeFs = createRequire(import.meta.url)('node:fs')
  const open = nativeFs.openSync, read = nativeFs.readSync, close = nativeFs.closeSync
  const bundles = new Set(), stamps = new Set()
  let hashReads = 0, replaceDuringStamp = false, replaceDuringHash = false
  nativeFs.openSync = (file, ...args) => {
    const fd = open(file, ...args)
    if (file === bundle) bundles.add(fd)
    if (file === stamp) stamps.add(fd)
    return fd
  }
  nativeFs.closeSync = fd => { bundles.delete(fd); stamps.delete(fd); return close(fd) }
  nativeFs.readSync = (fd, ...args) => {
    const count = read(fd, ...args)
    if (bundles.has(fd)) {
      hashReads++
      if (replaceDuringHash && count) { replaceDuringHash = false; writeFileSync(bundle, 'replaced daemon bytes\n') }
    }
    if (stamps.has(fd) && replaceDuringStamp && count) { replaceDuringStamp = false; writeFileSync(bundle, 'replaced daemon bytes\n') }
    return count
  }
  try {
    for (let check = 0; check < 40; check++) identity.requireCurrentDaemonBuild(context, lease)
    assert.equal(hashReads, 0, 'warm RPC freshness checks never rehash unchanged output bytes')
    const times = nativeFs.statSync(bundle)
    writeFileSync(bundle, 'replaced daemon bytes\n')
    utimesSync(bundle, times.atime, times.mtime)
    assert.deepEqual(identity.daemonBuildFreshness(context, lease), { state: 'changed', idleStop: true }, 'same-size rewrite with restored mtime invalidates by ctime')
    assert.ok(hashReads > 0)
    assert.throws(() => identity.daemonBuildFreshness(context, lease, loaded), error => error.code === 'E_VERSION', 'a previous hash snapshot cannot vouch for a replaced output')
    writeFileSync(bundle, 'original daemon bytes\n')
    identity.requireCurrentDaemonBuild(context, lease)
    replaceDuringStamp = true
    assert.throws(() => identity.daemonBuildFreshness(context, lease), error => error.code === 'E_VERSION', 'replacement during stamp verification cannot return current')
    writeFileSync(bundle, 'original daemon bytes\n')
    replaceDuringHash = true
    assert.throws(() => identity.captureDaemonBuild(), error => error.code === 'E_VERSION', 'rewrite during hashing is detected on the opened descriptor')
  } finally { nativeFs.openSync = open; nativeFs.readSync = read; nativeFs.closeSync = close }
  writeFileSync(bundle, 'original daemon bytes\n')
  assert.throws(() => identity.publishDaemonBuild(context, lease, loaded), 'same owner stamp cannot be overwritten')
  writeFileSync(bundle, 'original daemon bytes\n')
  assert.deepEqual(identity.daemonBuildFreshness(context, lease), { state: 'current', idleStop: true }, 'identical rebuilt bytes do not restart')
  writeFileSync(bundle, 'new daemon bytes\n')
  assert.deepEqual(identity.daemonBuildFreshness(context, lease), { state: 'changed', idleStop: true }, 'old live owner remains bound to loaded bytes')
  const foreign = JSON.parse(original)
  for (const alter of [value => { value.lease.nonce = randomUUID() }, value => { value.lease.epoch = randomUUID() }, value => { value.lease.owner.startedAt = '638000000000000000' }, value => { value.lease.identity.installationId = 'c'.repeat(64) }, value => { value.capturedAt = lease.acquiredAt + 1000 }, value => { value.idleStopVersion = 2 }]) {
    const value = structuredClone(foreign); alter(value); writeFileSync(stamp, JSON.stringify(value))
    assert.deepEqual(identity.daemonBuildFreshness(context, lease), { state: 'unknown', idleStop: false })
  }
  writeFileSync(stamp, 'x'.repeat(16385))
  assert.deepEqual(identity.daemonBuildFreshness(context, lease), { state: 'unknown', idleStop: false }, 'stamp read is bounded')
  rmSync(stamp)
  assert.deepEqual(identity.daemonBuildFreshness(context, lease), { state: 'unknown', idleStop: false }, 'legacy newer file remains unknown')
  mkdirSync(stamp)
  assert.throws(() => identity.daemonBuildFreshness(context, lease), error => error.code === 'E_DENIED', 'stamp cannot redirect to another file type')
  rmdirSync(stamp)
  writeFileSync(stamp, original)
  const replacement = { ...lease, epoch: randomUUID(), nonce: randomUUID() }
  writeFileSync(leaseFile, JSON.stringify(replacement))
  assert.throws(() => identity.daemonBuildFreshness(context, lease), error => error.code === 'E_CONFLICT', 'old captured lease cannot vouch for a replacement owner')
  writeFileSync(leaseFile, JSON.stringify(lease))
  assert.throws(() => identity.publishDaemonBuild(context, lease, identity.captureDaemonBuild()), error => error.code === 'E_VERSION', 'startup cannot stamp bytes replaced after owner creation')
  const resources = join(temporary, 'resources')
  const archived = join(resources, 'app.asar', 'out', 'main'), unpacked = join(resources, 'app.asar.unpacked', 'out', 'main')
  mkdirSync(archived, { recursive: true }); mkdirSync(unpacked, { recursive: true })
  writeFileSync(join(archived, 'daemon-host.js'), 'virtual archive metadata must never be hashed')
  writeFileSync(join(unpacked, 'daemon-host.js'), 'physical loaded role bytes')
  const packagedModule = join(archived, 'identity.cjs')
  await build({ entryPoints: ['src/main/daemon/build-identity.ts'], outfile: packagedModule, bundle: true, platform: 'node', format: 'cjs' })
  const resourceProperty = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  try {
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
    const packaged = createRequire(import.meta.url)(packagedModule)
    assert.equal(packaged.captureDaemonBuild().sha256, createHash('sha256').update('physical loaded role bytes').digest('hex'), 'packaged virtual entry resolves only to its fixed unpacked physical bundle')
    Object.defineProperty(process, 'resourcesPath', { value: join(temporary, 'foreign-resources'), configurable: true })
    assert.throws(() => packaged.captureDaemonBuild(), error => error.code === 'E_DENIED', 'packaged resources cannot redirect to an arbitrary root')
    assert.ok(readFileSync('electron-builder.yml', 'utf8').includes('"out/main/daemon-host.js"'), 'the physical role bundle is explicitly unpacked')
  } finally {
    if (resourceProperty) Object.defineProperty(process, 'resourcesPath', resourceProperty)
    else delete process.resourcesPath
  }
  console.log('PASS daemon build: exact hash, bounded stamps, zero warm rehashes, ctime/TOCTOU fences and fixed unpacked packaged path')
} finally {
  assert.ok(temporary.startsWith(join(tmpdir(), 'trellis-daemon-build-')))
  rmSync(temporary, { recursive: true, force: true })
}
