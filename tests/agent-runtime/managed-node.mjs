import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { NODE_RELEASE, prepareNodeRuntime, projectRoot } from '../../scripts/prepare-node-runtime.mjs'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const directory = mkdtempSync(join(tmpdir(), 'trellis-managed-node-'))
const bytes = Buffer.from('managed Node fixture')
const license = Buffer.from('license fixture')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const fixtureRelease = { ...NODE_RELEASE, sha256: sha256(bytes), licenseSha256: sha256(license) }
const modulePath = join(directory, 'managed-node.cjs')
await build({
  entryPoints: [join(projectRoot, 'src/main/services/acp/managed-node.ts')], outfile: modulePath,
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  plugins: [{ name: 'fixture-release', setup(builder) {
    builder.onLoad({ filter: /node-runtime-release\.json$/ }, () => ({ contents: JSON.stringify(fixtureRelease), loader: 'json' }))
  } }]
})
const { managedNodePath, resolveNodeRuntime, validateNodeExecutable } = require(modulePath)
const resources = join(directory, 'resources')
const managed = join(resources, 'node-runtime/win-x64/node.exe')
mkdirSync(dirname(managed), { recursive: true })
writeFileSync(managed, bytes)
writeFileSync(join(dirname(managed), 'LICENSE'), license)
assert.equal(await managedNodePath(resources, 'win32', 'x64'), realpathSync(managed))
assert.equal(await managedNodePath(resources, 'win32', 'arm64'), undefined)
assert.equal(await managedNodePath(resources, 'linux', 'x64'), undefined)
assert.equal(await managedNodePath('relative', 'win32', 'x64'), undefined)
console.log('PASS exact resources path, platform/architecture and both pinned digests')

let seen = []
const validate = async (path, options) => { seen.push([path, options]); return { path, version: 'v24.12.0' } }
const common = { resourcesPath: resources, explicitPath: 'explicit', pathNode: 'PATH', validate }
assert.equal((await resolveNodeRuntime(common)).source, 'explicit')
assert.deepEqual(seen.map(([path]) => path), ['explicit'])
seen = []
const fallback = await resolveNodeRuntime({ ...common, sqlite: true, validate: async (path, options) => {
  seen.push([path, options])
  if (path === 'explicit') throw new Error('no SQLite')
  return { path, version: 'v24.12.0' }
} })
if (process.platform === 'win32' && process.arch === 'x64') {
  assert.equal(fallback.source, 'managed')
  assert.equal(fallback.path, realpathSync(managed))
  assert.equal(seen.length, 2)
  assert(seen.every(([, options]) => options.sqlite === true))
} else assert.equal(fallback.source, 'path')
assert.equal((await resolveNodeRuntime({ ...common, resourcesPath: undefined, explicitPath: undefined })).source, 'path')
assert.equal((await resolveNodeRuntime({ ...common, explicitPath: undefined, accepts: path => path === 'PATH' })).source, 'path')
await assert.rejects(resolveNodeRuntime({ validate }), /未找到可用/)
console.log('PASS valid explicit > bundle > PATH; SQLite failures and npm installation fall back')

writeFileSync(managed, 'corrupt')
assert.equal(await managedNodePath(resources, 'win32', 'x64'), undefined)
assert.equal((await resolveNodeRuntime({ ...common, explicitPath: undefined })).source, 'path')
writeFileSync(managed, bytes)
writeFileSync(join(dirname(managed), 'LICENSE'), 'corrupt license')
assert.equal(await managedNodePath(resources, 'win32', 'x64'), undefined)
writeFileSync(join(dirname(managed), 'LICENSE'), license)
const escaped = join(directory, 'escaped')
mkdirSync(join(escaped, 'node-runtime'), { recursive: true })
symlinkSync(dirname(managed), join(escaped, 'node-runtime/win-x64'), process.platform === 'win32' ? 'junction' : 'dir')
assert.equal(await managedNodePath(escaped, 'win32', 'x64'), undefined)
console.log('PASS tampering invalidates verification cache and escaping resources are rejected')

function raceFixture(name) {
  const resources = join(directory, name)
  const executable = join(resources, 'node-runtime/win-x64/node.exe')
  mkdirSync(dirname(executable), { recursive: true })
  writeFileSync(executable, bytes)
  writeFileSync(join(dirname(executable), 'LICENSE'), license)
  return { resources, executable }
}

async function changeDuringHash(fixture, change) {
  const crypto = require('node:crypto')
  const originalCreateHash = crypto.createHash
  let changed = false
  let binaryHash
  let hashedBytes = 0
  crypto.createHash = (...args) => {
    const hash = originalCreateHash(...args)
    const update = hash.update
    hash.update = function (chunk, ...rest) {
      const result = update.call(this, chunk, ...rest)
      if (Buffer.isBuffer(chunk) && chunk.equals(bytes)) binaryHash = hash
      if (hash === binaryHash) hashedBytes += chunk.length
      if (!changed && hash === binaryHash) {
        changed = true
        // Mutate actual disk bytes after the original payload entered SHA256.
        // No filesystem reads, descriptors, identities or digest results are faked.
        change()
      }
      return result
    }
    return hash
  }
  try {
    assert.equal(await managedNodePath(fixture.resources, 'win32', 'x64'), undefined, 'the in-flight old digest cannot authorize the changed source')
    assert.equal(changed, true, 'the change must occur during a real source hash')
    assert.equal(hashedBytes, bytes.length, 'growth cannot extend hashing beyond the captured file size')
  } finally { crypto.createHash = originalCreateHash }
}

const replaced = raceFixture('replaced-during-hash')
const replacedBefore = statSync(replaced.executable, { bigint: true })
await changeDuringHash(replaced, () => {
  renameSync(replaced.executable, `${replaced.executable}.original`)
  writeFileSync(replaced.executable, Buffer.alloc(bytes.length, 0x78))
  utimesSync(replaced.executable, Number(replacedBefore.atimeMs) / 1000, Number(replacedBefore.mtimeMs) / 1000)
})
assert.notEqual(statSync(replaced.executable, { bigint: true }).ino, replacedBefore.ino)
assert.equal(sha256(readFileSync(`${replaced.executable}.original`)), fixtureRelease.sha256)
assert.equal(await managedNodePath(replaced.resources, 'win32', 'x64'), undefined)
writeFileSync(replaced.executable, bytes)
assert.equal(await managedNodePath(replaced.resources, 'win32', 'x64'), realpathSync(replaced.executable))
console.log('PASS real path replacement while hashing rejects the old descriptor digest; a fresh verification recovers')

const rewritten = raceFixture('rewritten-during-hash')
const rewrittenBefore = statSync(rewritten.executable, { bigint: true })
await changeDuringHash(rewritten, () => {
  writeFileSync(rewritten.executable, Buffer.alloc(bytes.length, 0x79))
  utimesSync(rewritten.executable, Number(rewrittenBefore.atimeMs) / 1000, Number(rewrittenBefore.mtimeMs) / 1000)
})
assert.equal(statSync(rewritten.executable, { bigint: true }).ino, rewrittenBefore.ino)
assert.equal(statSync(rewritten.executable).size, bytes.length)
assert.equal(await managedNodePath(rewritten.resources, 'win32', 'x64'), undefined)
writeFileSync(rewritten.executable, bytes)
assert.equal(await managedNodePath(rewritten.resources, 'win32', 'x64'), realpathSync(rewritten.executable))
console.log('PASS actual same-inode, same-size content drift with restored mtime is rejected during hashing')

const growing = raceFixture('growing-during-hash')
await changeDuringHash(growing, () => appendFileSync(growing.executable, Buffer.alloc(256 * 1024, 0x7a)))
assert.equal(statSync(growing.executable).size, bytes.length + 256 * 1024)
const oversized = raceFixture('oversized-assets')
truncateSync(oversized.executable, 150 * 1024 * 1024 + 1)
assert.equal(await managedNodePath(oversized.resources, 'win32', 'x64'), undefined)
writeFileSync(oversized.executable, bytes)
truncateSync(join(dirname(oversized.executable), 'LICENSE'), 1024 * 1024 + 1)
assert.equal(await managedNodePath(oversized.resources, 'win32', 'x64'), undefined)
console.log('PASS in-flight growth and initial executable/license size limits bound asset reads')

for (const version of ['v22.12.0', 'v21.99.0', 'v20.0.0', 'not node']) {
  await assert.rejects(validateNodeExecutable(process.execPath, { run: async () => version }), /不兼容/)
}
for (const version of ['v22.13.0', 'v22.18.0', 'v24.12.0']) {
  const value = await validateNodeExecutable(process.execPath, { sqlite: true, run: async (_path, args) => args[0] === '--version' ? version : '' })
  assert.equal(value.version, version)
}
await assert.rejects(validateNodeExecutable(process.execPath, { sqlite: true, run: async (_path, args) => {
  if (args[0] === '--version') return 'v24.12.0'
  throw new Error('node:sqlite disabled')
} }), /node:sqlite/)
await assert.rejects(validateNodeExecutable('node.exe'), /有效/)
await assert.rejects(validateNodeExecutable(directory), /有效/)
const actual = await validateNodeExecutable(process.execPath, { sqlite: true })
assert.equal(actual.version, process.version)
console.log(`PASS minimum version, independent runtime and actual node:sqlite (${actual.version})`)

if (process.argv.includes('--live')) {
  assert.equal(process.platform, 'win32')
  assert.equal(process.arch, 'x64')
  const dist = join(projectRoot, 'node_modules/.cache/trellis-node/dist', NODE_RELEASE.directory)
  assert(existsSync(join(dist, 'node.exe')), 'Run node scripts/prepare-node-runtime.mjs before --live')
  assert.equal(await prepareNodeRuntime({ fetchImpl: () => { throw new Error('offline: must use verified cached dist') } }), dist)
  const livePath = join(directory, 'live-managed-node.cjs')
  await build({ entryPoints: [join(projectRoot, 'src/main/services/acp/managed-node.ts')], outfile: livePath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const liveResources = join(directory, 'live-resources')
  const root = join(liveResources, 'node-runtime/win-x64')
  mkdirSync(root, { recursive: true })
  for (const file of ['node.exe', 'LICENSE']) copyFileSync(join(dist, file), join(root, file))
  const live = require(livePath)
  const executable = await live.managedNodePath(liveResources)
  assert.equal(executable, realpathSync(join(root, 'node.exe')))
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), 'v24.12.0')
  assert.equal(sha256(readFileSync(executable)), NODE_RELEASE.sha256)
  assert.equal((await live.resolveNodeRuntime({ resourcesPath: liveResources, sqlite: true })).source, 'managed')
  await live.validateNodeExecutable(executable, { sqlite: true })
  console.log('PASS official packaged-layout Node.exe v24.12.0 and real SQLite, with no PATH candidate')
}
