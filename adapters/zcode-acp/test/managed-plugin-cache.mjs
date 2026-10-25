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
const { createManagedPluginCache } = require('../src/managed-plugin-cache.cjs')
const { sha256, inspectCompatibility, transformVerifiedSource, transformAnchoredSource } = require('../src/managed-cache-compat.cjs')
const native = require('./fixtures/managed-plugin-cache-native.cjs')
const fixture = fs.readFileSync(fileURLToPath(new URL('./fixtures/managed-plugin-cache-native.cjs', import.meta.url)), 'utf8')
const launcher = fileURLToPath(new URL('../src/managed-zcode-launch.cjs', import.meta.url))
const storageModule = fileURLToPath(new URL('../src/managed-plugin-cache.cjs', import.meta.url))

function setup(t, limits) {
  const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-managed-assets-')))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const originalCli = path.join(temporary, 'ZCode', 'resources', 'glm', 'native.cjs')
  const root = path.join(path.dirname(originalCli), 'packages', 'fixture-plugin')
  const cacheDir = path.join(temporary, 'host-cache')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(originalCli, fixture)
  const write = (relative, content) => {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  write('.zcode-plugin/plugin.json', '{"name":"fixture"}')
  write('skills/a/SKILL.md', 'asset\r\n\u4e00\u4e8c')
  write('hooks/a.sh', '#!/bin/sh\necho ok\n')
  write('dist/mcp/server.js', 'console.log(42)')
  write('docs/binary', Buffer.from([0, 255, 1, 128]))
  write('unselected/ignored', 'ignored')
  write('skills/cache.pyc', 'ignored')
  write('node_modules/excluded/index.js', 'ignored')
  write('skills/coverage/ignored.md', 'ignored')
  const definition = { name: 'fixture', version: '1.0', rootCandidates: ['packages/fixture-plugin'] }
  const cliHash = sha256(fixture)
  const trustedAssets = { version: 1, cliSha256: cliHash, plugins: [{ name: definition.name, version: definition.version,
    rootRelative: 'glm/packages/fixture-plugin', files: native.Moc(root, definition).map(file => ({ path: file.path, mode: file.mode,
      sha256: file.sha256, size: fs.statSync(file.sourcePath).size })) }] }
  const options = { originalCli, cliHash, cacheDir, limits, trustedAssets }
  let scans = 0
  const inventory = () => {
    const top = new Set([...native.Ioc, ...definition.runtimeTopLevelPaths ?? []])
    return [...native.aoi(root, top)].map(sourcePath => ({ sourcePath, path: native.uoi(sourcePath.slice(root.length + 1)),
      mode: native.yFn(native.uoi(sourcePath.slice(root.length + 1)), fs.statSync(sourcePath).mode) }))
      .filter(file => native.Woc(file.path, top)).sort((a, b) => a.path.localeCompare(b.path))
  }
  const scan = () => { scans++; return native.Moc(root, definition) }
  const cache = createManagedPluginCache(options)
  const catalogue = (selected = cache) => selected.catalogue(root, definition, scan, inventory)
  return { temporary, originalCli, root, cacheDir, definition, options, write, cache, catalogue, inventory, scan, get scans() { return scans } }
}

test('native bytes, order, sha, mode and aggregate remain exact; disk hits do not read source bytes', t => {
  const f = setup(t)
  const expected = native.Moc(f.root, f.definition)
  const files = f.catalogue()
  assert.deepEqual(files, expected)
  assert.equal(f.scans, 1)
  assert.deepEqual(f.catalogue(), expected)
  const reopened = createManagedPluginCache(f.options)
  const diskFiles = f.catalogue(reopened)
  assert.equal(f.scans, 1)
  assert.equal(reopened.stats.hits, 1)
  const originalOpen = fs.openSync
  fs.openSync = function (filename, ...args) {
    assert.ok(!String(filename).startsWith(f.root), 'cache hit must not read source content')
    return originalOpen.call(this, filename, ...args)
  }
  try {
    assert.deepEqual(f.catalogue(reopened), expected)
    const plugin = { definition: f.definition, rootPath: f.root, files: diskFiles }
    for (const file of diskFiles) {
      const bytes = reopened.readAsset({ kind: 'filesystem' }, plugin, file)
      assert.ok(Buffer.isBuffer(bytes))
      assert.equal(sha256(bytes), file.sha256)
      bytes.fill(0)
      assert.equal(sha256(reopened.readAsset({ kind: 'filesystem' }, plugin, file)), file.sha256, 'caller gets independent buffer')
    }
    assert.equal(reopened.readAsset({ kind: 'sea' }, plugin, diskFiles[0]), undefined)
    assert.equal(reopened.readAsset({ kind: 'filesystem' }, plugin, { ...diskFiles[0] }), undefined)
  } finally { fs.openSync = originalOpen }
})

for (const mutation of ['content', 'add', 'delete', 'rename', 'directory', 'mode']) {
  test(`${mutation} invalidates the cached catalogue`, t => {
    if (mutation === 'mode' && process.platform === 'win32') return t.skip('Windows chmod has no executable bit; mode is checked on POSIX')
    const f = setup(t)
    f.catalogue()
    const target = path.join(f.root, 'docs/binary')
    if (mutation === 'content') fs.writeFileSync(target, Buffer.from([0, 254, 1, 128]))
    if (mutation === 'add') f.write('docs/new', 'new')
    if (mutation === 'delete') fs.unlinkSync(target)
    if (mutation === 'rename') fs.renameSync(target, target + '-renamed')
    if (mutation === 'directory') fs.mkdirSync(path.join(f.root, 'docs/empty'))
    if (mutation === 'mode') fs.chmodSync(target, 0o755)
    assert.deepEqual(f.catalogue(), native.Moc(f.root, f.definition))
    assert.equal(f.scans, 2)
  })
}

test('junctions, redirected ancestors and roots outside packaged candidates always scan natively', t => {
  const f = setup(t)
  const outside = path.join(f.temporary, 'workspace')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret'), 'user-only')
  fs.symlinkSync(outside, path.join(f.root, 'docs/junction'), process.platform === 'win32' ? 'junction' : 'dir')
  f.catalogue()
  assert.equal(f.cache.stats.prepared, 0)
  assert.equal(fs.existsSync(f.cacheDir), false)
  fs.unlinkSync(path.join(f.root, 'docs/junction'))
  f.definition.rootCandidates = ['../other-plugin']
  f.catalogue()
  assert.equal(f.cache.stats.prepared, 0)
  const value = f.cache.catalogue(outside, f.definition, () => 'native-dynamic', () => { throw new Error('must not enumerate dynamic roots') })
  assert.equal(value, 'native-dynamic')
})

for (const damage of ['pack', 'manifest', 'version', 'cli-hash', 'definition']) {
  test(`${damage} cannot make a cache entry current`, t => {
    const f = setup(t)
    f.catalogue()
    const directory = path.join(f.cacheDir, 'managed-plugin-cache-v1')
    const entry = path.join(directory, fs.readdirSync(directory)[0])
    if (damage === 'pack') fs.writeFileSync(path.join(entry, 'assets.bin'), 'corrupt')
    if (damage === 'manifest') fs.writeFileSync(path.join(entry, 'manifest.json'), '{')
    if (damage === 'version') {
      const manifestPath = path.join(entry, 'manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      manifest.identity.version = 0
      fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    }
    if (damage === 'cli-hash') f.options.cliHash = '0'.repeat(64)
    if (damage === 'definition') f.definition.runtimeTopLevelPaths = ['node_modules']
    const fresh = createManagedPluginCache(f.options)
    assert.deepEqual(f.catalogue(fresh), native.Moc(f.root, f.definition))
    assert.equal(f.scans, 2)
  })
}

test('coordinated pack and manifest forgery cannot replace the independent asset digest', t => {
  const f = setup(t)
  f.catalogue()
  const directory = path.join(f.cacheDir, 'managed-plugin-cache-v1')
  const entry = path.join(directory, fs.readdirSync(directory)[0])
  const manifestPath = path.join(entry, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const pack = fs.readFileSync(path.join(entry, 'assets.bin'))
  const victim = manifest.files.find(file => file.path === 'docs/binary')
  const injected = Buffer.alloc(victim.size, 0x42)
  injected.copy(pack, victim.offset)
  victim.sha256 = sha256(injected)
  manifest.packHash = sha256(pack)
  fs.writeFileSync(path.join(entry, 'assets.bin'), pack)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  const fresh = createManagedPluginCache(f.options)
  const files = f.catalogue(fresh)
  assert.equal(fresh.stats.hits, 0)
  assert.equal(f.scans, 2)
  assert.deepEqual(files, native.Moc(f.root, f.definition))
  const file = files.find(item => item.path === victim.path)
  const bytes = fresh.readAsset({ kind: 'filesystem' }, { rootPath: f.root, definition: f.definition }, file)
  assert.deepEqual(bytes, Buffer.from([0, 255, 1, 128]))
  assert.notEqual(sha256(bytes), victim.sha256)
})

test('a legitimate same-length source edit remains native in every new process cache', t => {
  const f = setup(t)
  f.catalogue()
  const directory = path.join(f.cacheDir, 'managed-plugin-cache-v1')
  const entry = path.join(directory, fs.readdirSync(directory)[0])
  const previous = fs.readFileSync(path.join(entry, 'assets.bin'))
  f.write('docs/binary', Buffer.from([0, 254, 1, 128]))
  for (let index = 0; index < 2; index++) {
    const fresh = createManagedPluginCache(f.options)
    const files = f.catalogue(fresh)
    assert.deepEqual(files, native.Moc(f.root, f.definition))
    assert.equal(fresh.stats.hits, 0)
    assert.equal(fresh.stats.prepared, 0)
    assert.equal(fresh.stats.memoryBytes, 0)
    for (const file of files) assert.equal(fresh.readAsset({ kind: 'filesystem' }, { rootPath: f.root, definition: f.definition }, file), undefined)
    assert.deepEqual(fs.readFileSync(path.join(entry, 'assets.bin')), previous)
  }
})

for (const field of ['name', 'version', 'rootRelative', 'path', 'mode', 'sha256', 'size']) {
  test(`the trusted table independently binds plugin/file ${field}`, t => {
    const f = setup(t)
    const baseline = structuredClone(f.options.trustedAssets)
    const plugin = baseline.plugins[0]
    if (field === 'name') plugin.name = 'other-plugin'
    if (field === 'version') plugin.version = 'other-version'
    if (field === 'rootRelative') plugin.rootRelative = 'glm/packages/other-plugin'
    if (field === 'path') plugin.files[0].path = 'docs/other-path'
    if (field === 'mode') plugin.files[0].mode = 0o755
    if (field === 'sha256') plugin.files[0].sha256 = '0'.repeat(64)
    if (field === 'size') plugin.files[0].size++
    const selected = createManagedPluginCache({ ...f.options, trustedAssets: baseline })
    assert.deepEqual(f.catalogue(selected), native.Moc(f.root, f.definition))
    assert.equal(selected.stats.prepared, 0)
    assert.equal(selected.stats.memoryBytes, 0)
    const directory = path.join(f.cacheDir, 'managed-plugin-cache-v1')
    if (fs.existsSync(directory)) assert.deepEqual(fs.readdirSync(directory), [])
  })
}

test('invalid tables disable caching, and construction captures an independent test baseline', t => {
  const f = setup(t)
  const duplicate = structuredClone(f.options.trustedAssets)
  duplicate.plugins[0].files.push(duplicate.plugins[0].files[0])
  const traversal = structuredClone(f.options.trustedAssets)
  traversal.plugins[0].rootRelative = '../outside'
  for (const trustedAssets of [null, {}, duplicate, traversal, { ...f.options.trustedAssets, cliSha256: '0'.repeat(64) }]) {
    const cache = createManagedPluginCache({ ...f.options, trustedAssets })
    assert.equal(cache.trustedAssetsAvailable, false)
    assert.deepEqual(f.catalogue(cache), native.Moc(f.root, f.definition))
    assert.equal(cache.stats.prepared, 0)
    assert.equal(fs.existsSync(f.cacheDir), false)
  }
  f.options.trustedAssets.plugins[0].files[0].sha256 = '0'.repeat(64)
  f.catalogue()
  assert.equal(f.cache.stats.prepared, 1, 'later mutation of the injection cannot rewrite the captured baseline')
})

test('stale registered files and native scan errors preserve native behavior', t => {
  const f = setup(t)
  const files = f.catalogue()
  const file = files.find(item => item.path === 'docs/binary')
  const plugin = { definition: f.definition, rootPath: f.root }
  fs.writeFileSync(file.sourcePath, 'changed')
  assert.equal(f.cache.readAsset({ kind: 'filesystem' }, plugin, file), undefined)
  assert.deepEqual(native.dFn({ kind: 'filesystem' }, plugin, file), Buffer.from('changed'))
  const failure = new Error('native-read-failed')
  assert.throws(() => f.cache.catalogue(f.root, f.definition, () => { throw failure }, f.inventory), error => error === failure)
})

for (const limits of [{ maxPackBytes: 1 }, { maxAssetBytes: 1 }, { maxEntries: 1 }, { maxDiskBytes: 1 },
  { maxManifestBytes: 1 }, { maxMemoryBytes: 1 }, { maxDepth: 0 }, { maxFiles: 1 }, { maxDiskEntries: 0 }]) {
  test(`bounded resources fall back: ${JSON.stringify(limits)}`, t => {
    const f = setup(t, limits)
    assert.deepEqual(f.catalogue(), native.Moc(f.root, f.definition))
    assert.equal(f.cache.stats.prepared, 0)
    assert.equal(f.cache.stats.memoryBytes, 0)
  })
}

test('source changes between native scan and pack capture never publish', t => {
  const f = setup(t)
  const files = f.cache.catalogue(f.root, f.definition, () => {
    const result = f.scan()
    f.write('docs/binary', 'raced')
    return result
  }, f.inventory)
  assert.equal(f.cache.stats.prepared, 0)
  assert.equal(f.cache.readAsset({ kind: 'filesystem' }, { rootPath: f.root, definition: f.definition }, files[0]), undefined)
  assert.equal(fs.readdirSync(path.join(f.cacheDir, 'managed-plugin-cache-v1')).length, 0)
})

test('mode metadata is checked on Windows too, including non-executable mode changes', t => {
  const f = setup(t)
  f.catalogue()
  const originalStat = fs.lstatSync
  const target = path.join(f.root, 'docs/binary')
  fs.lstatSync = function (filename, ...args) {
    const stat = originalStat.call(this, filename, ...args)
    if (filename === target && typeof stat.mode === 'bigint') Object.defineProperty(stat, 'mode', { value: stat.mode ^ 1n })
    return stat
  }
  try {
    assert.deepEqual(f.catalogue(), native.Moc(f.root, f.definition))
    assert.equal(f.scans, 2)
  } finally { fs.lstatSync = originalStat }
})

test('cache path failures never write into the installation', t => {
  const f = setup(t)
  fs.writeFileSync(f.cacheDir, 'not-a-directory')
  const invalid = createManagedPluginCache(f.options)
  assert.deepEqual(f.catalogue(invalid), native.Moc(f.root, f.definition))
  assert.equal(invalid.stats.prepared, 0)
  const installCache = path.join(path.dirname(path.dirname(path.dirname(f.originalCli))), 'forbidden-cache')
  const forbidden = createManagedPluginCache({ ...f.options, cacheDir: installCache })
  assert.deepEqual(f.catalogue(forbidden), native.Moc(f.root, f.definition))
  assert.equal(fs.existsSync(installCache), false)
})

test('successful preparation writes an atomic bounded readiness marker', t => {
  const f = setup(t)
  const files = f.catalogue()
  const report = f.cache.prepareReport({ kind: 'filesystem', plugins: [{ rootPath: f.root, definition: f.definition, files }] })
  assert.equal(report.status, 'prepared')
  assert.equal(report.counts.roots, 1)
  assert.equal(report.counts.files, files.length)
  const marker = path.join(f.cacheDir, 'managed-zcode-ready.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), report)
  assert.equal(fs.readdirSync(f.cacheDir).filter(name => name.endsWith('.tmp')).length, 0)
  assert.equal(f.cache.prepareReport({ kind: 'filesystem', plugins: [{ rootPath: f.root, definition: f.definition, missingSeedPaths: ['missing'] }] }).status, 'degraded')
})

test('disk and memory quotas include other plugin generations', t => {
  const f = setup(t, { maxDiskEntries: 1, maxMemoryEntries: 1 })
  const first = f.catalogue()
  f.definition.listing = { description: 'updated definition' }
  const second = f.catalogue()
  assert.equal(fs.readdirSync(path.join(f.cacheDir, 'managed-plugin-cache-v1')).length, 1)
  const plugin = { rootPath: f.root, definition: f.definition }
  assert.equal(f.cache.readAsset({ kind: 'filesystem' }, plugin, first[0]), undefined)
  assert.ok(Buffer.isBuffer(f.cache.readAsset({ kind: 'filesystem' }, plugin, second[0])))
  assert.ok(f.cache.stats.memoryBytes <= f.cache.limits.maxMemoryBytes)
  const directory = path.join(f.cacheDir, 'managed-plugin-cache-v1')
  const entry = path.join(directory, fs.readdirSync(directory)[0])
  const bytes = fs.readdirSync(entry).reduce((sum, name) => sum + fs.statSync(path.join(entry, name)).size, 0)
  assert.ok(bytes <= f.cache.limits.maxDiskBytes)
})

test('a cache directory redirected after creation cannot receive a publication', t => {
  const f = setup(t)
  f.catalogue()
  const directory = path.join(f.cacheDir, 'managed-plugin-cache-v1')
  fs.rmSync(directory, { recursive: true })
  const forbidden = path.join(path.dirname(f.originalCli), 'redirect-target')
  fs.mkdirSync(forbidden)
  fs.symlinkSync(forbidden, directory, process.platform === 'win32' ? 'junction' : 'dir')
  f.definition.listing = { description: 'updated definition' }
  assert.deepEqual(f.catalogue(), native.Moc(f.root, f.definition))
  assert.deepEqual(fs.readdirSync(forbidden), [])
})

test('cache errors and publication contention fall back without marking prepared', t => {
  const f = setup(t)
  fs.mkdirSync(path.join(f.cacheDir, 'managed-plugin-cache-v1', '.publish-lock'), { recursive: true })
  assert.deepEqual(f.catalogue(), native.Moc(f.root, f.definition))
  assert.equal(f.cache.stats.prepared, 0)
  assert.equal(f.cache.prepareReport({ kind: 'filesystem', plugins: [{ rootPath: f.root, definition: f.definition }] }).status, 'degraded')
  assert.equal(fs.existsSync(path.join(f.cacheDir, 'managed-zcode-ready.json')), false)
})

test('parallel writers publish whole packs with a single complete generation', async t => {
  const f = setup(t)
  const code = `const fs=require('node:fs'),native=require(${JSON.stringify(fileURLToPath(new URL('./fixtures/managed-plugin-cache-native.cjs', import.meta.url)))}),{createManagedPluginCache}=require(${JSON.stringify(storageModule)});const o=JSON.parse(process.argv[1]);const cache=createManagedPluginCache(o.options);const files=cache.catalogue(o.root,o.definition,()=>native.Moc(o.root,o.definition),()=>native.Moc(o.root,o.definition).map(({sha256,...f})=>f));process.stdout.write(JSON.stringify({count:files.length,prepared:cache.stats.prepared}));`
  const results = await Promise.all(Array.from({ length: 6 }, () => promisify(execFile)(process.execPath, ['-e', code, JSON.stringify(f)], { windowsHide: true, maxBuffer: 4096 })))
  for (const result of results) assert.equal(JSON.parse(result.stdout).count, f.inventory().length)
  assert.ok(results.some(result => JSON.parse(result.stdout).prepared === 1))
  const directory = path.join(f.cacheDir, 'managed-plugin-cache-v1')
  assert.equal(fs.readdirSync(directory).length, 1)
  f.catalogue(createManagedPluginCache(f.options))
  assert.equal(f.scans, 0)
})

test('exact anchors and fixed hash are both necessary; unknown prepare executes nothing', async t => {
  const f = setup(t)
  assert.equal(inspectCompatibility(Buffer.from(fixture)).supported, false)
  assert.equal(transformVerifiedSource(fixture), undefined)
  assert.equal(transformAnchoredSource(fixture.replace('function Moc(', 'function Changed(')), undefined)
  assert.equal(transformAnchoredSource(fixture + 'bQe();mSc();async function mSc'), undefined)
  const unknown = path.join(f.temporary, 'unknown.cjs')
  fs.writeFileSync(unknown, 'throw new Error("must not run")')
  let error
  try { await promisify(execFile)(process.execPath, [launcher, '--prepare', unknown], { windowsHide: true }) } catch (failure) { error = failure }
  assert.equal(error.code, 2)
  assert.equal(JSON.parse(error.stdout).status, 'unsupported')
  assert.equal(error.stderr, '')
  assert.equal(fs.existsSync(f.cacheDir), false)
})

test('official fallback preserves argv, cwd, filename, main and module resolution', async t => {
  const f = setup(t)
  fs.writeFileSync(f.originalCli, `process.stdout.write(JSON.stringify({filename:__filename,dirname:__dirname,argv:process.argv,cwd:process.cwd(),main:require.main===module,id:module.id,paths:module.paths}));`)
  const args = ['app-server', 'space arg', '--mode=normal']
  const result = await promisify(execFile)(process.execPath, [launcher, f.originalCli, ...args], { cwd: f.temporary, windowsHide: true })
  const value = JSON.parse(result.stdout)
  assert.equal(value.filename, f.originalCli)
  assert.equal(value.dirname, path.dirname(f.originalCli))
  assert.deepEqual(value.argv.slice(1), [f.originalCli, ...args])
  assert.equal(value.cwd, f.temporary)
  assert.equal(value.main, true)
  assert.equal(value.id, '.')
  assert.equal(value.paths[0], path.join(path.dirname(f.originalCli), 'node_modules'))
})

test('transformed fixture keeps native scanner and reads, with native main identity', async t => {
  const f = setup(t)
  const code = `const fs=require('node:fs'),compat=require(${JSON.stringify(fileURLToPath(new URL('../src/managed-cache-compat.cjs', import.meta.url)))}),{loadMain}=require(${JSON.stringify(launcher)}),{createManagedPluginCache}=require(${JSON.stringify(storageModule)});const o=JSON.parse(process.argv[1]);process.argv=[process.argv[0],o.originalCli,'app-server','--mode=fixture'];const cache=createManagedPluginCache(o.options);const api=loadMain(o.originalCli,compat.transformAnchoredSource(fs.readFileSync(o.originalCli,'utf8')),cache);const files=api.Moc(o.root,o.definition),hit=api.Moc(o.root,o.definition);for(const file of hit){const bytes=api.dFn({kind:'filesystem'},{rootPath:o.root,definition:o.definition},file);if(compat.sha256(bytes)!==file.sha256)throw new Error('bytes mismatch')}process.stdout.write(JSON.stringify({context:api.context,stats:cache.stats,files}));`
  const result = await promisify(execFile)(process.execPath, ['-e', code, JSON.stringify(f)], { cwd: f.temporary, windowsHide: true })
  const value = JSON.parse(result.stdout)
  assert.deepEqual(value.files, native.Moc(f.root, f.definition))
  assert.equal(value.stats.hits, 1)
  assert.equal(value.context.main, true)
  assert.equal(value.context.id, '.')
  assert.equal(value.context.filename, f.originalCli)
  assert.equal(value.context.cwd, f.temporary)
})
