/** Real nativeReader + isolated SQLite metadata; no provider reads or native activation. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { build } from 'esbuild'
import { createFixture, database } from './fixtures/task-conversations-data.mjs'

const directory = mkdtempSync(join(tmpdir(), 'trellis-zcode-root-'))
const environmentKeys = ['USERPROFILE', 'HOME', 'ZCODE_DATA_BASE_DIR', 'ZCODE_HOME', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE']
const previous = new Map(environmentKeys.map(key => [key, process.env[key]]))
let checks = 0
function check(condition, message) { assert.ok(condition, message); checks++ }

try {
  const bundle = join(directory, 'native.cjs')
  await build({ entryPoints: ['src/main/services/task-conversations/lib/native.ts'], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const { nativeReader } = createRequire(import.meta.url)(bundle)
  const f = createFixture(join(directory, 'sources'))
  const home = join(directory, 'home with spaces 中文')
  const active = join(directory, 'relocated desktop')
  const next = join(directory, 'next desktop')
  const bootstrap = join(home, '.zcode', 'v2', 'setting.json')
  const nativeFiles = []
  function seed(dataBaseDir, title) {
    const v2 = join(dataBaseDir, '.zcode', 'v2')
    const id = randomUUID(), providerId = randomUUID(), workspace = 'fixture-workspace'
    const history = join(v2, 'sessions', workspace, `${id}.json`)
    mkdirSync(join(v2, 'sessions', workspace), { recursive: true })
    const file = join(v2, 'tasks-index.sqlite')
    database(file, 'CREATE TABLE tasks(task_id TEXT,workspace_path TEXT,title TEXT,updated_at INTEGER,deleted INTEGER,acp_session_id TEXT,workspace_key TEXT)', db => {
      db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?)').run(id, f.root, title, 1800000000123, 0, providerId, workspace)
    })
    writeFileSync(history, JSON.stringify({ meta: { taskId: id, workspacePath: f.root, acpSessionId: providerId }, messages: [] }))
    nativeFiles.push(file, history)
    return { v2, id, providerId, title, history }
  }
  const stale = seed(home, 'Stale home task')
  const current = seed(active, 'Current desktop task')
  const relocated = seed(next, 'Relocated again')
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
  const original = nativeFiles.map(hash)
  for (const key of environmentKeys) delete process.env[key]
  process.env.USERPROFILE = home
  process.env.HOME = join(directory, 'unused-home')
  // This metadata reader must not depend on a provider registry, even an explicit one.
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = join(directory, 'unavailable-provider.json')
  const options = { nativeRoots: { codex: f.roots.codex, 'claude-code': f.roots['claude-code'] } }
  const read = nativeReader(options, f.launch)
  const status = snapshot => snapshot.sources.find(source => source.source === 'zcode')
  function expectTask(snapshot, expected, message) {
    assert.deepEqual(snapshot.items.filter(item => item.source === 'zcode').map(item => [item.sessionId, item.title]), [[expected.id, expected.title]], message)
    check(status(snapshot).available, `${message}: metadata available`)
    check(snapshot.historyFiles.some(file => file.file === expected.history && file.sourceRoot === expected.v2), `${message}: correct history descriptor`)
    check(snapshot.runtimeAliases.some(alias => alias.source === 'zcode' && alias.sessionId === expected.providerId), `${message}: actual metadata read`)
  }
  async function expectUnavailable(message, reader = read) {
    const snapshot = await reader(f.root)
    check(status(snapshot).available === false && !!status(snapshot).detail, `${message}: visible unavailable source`)
    check(!snapshot.items.some(item => item.source === 'zcode'), `${message}: no stale-home fallback`)
    check(snapshot.sources.filter(source => source.source !== 'zcode').every(source => source.available), `${message}: source failures isolated`)
    check(snapshot.items.some(item => item.source === 'codex') && snapshot.items.some(item => item.source === 'claude-code'), `${message}: other histories retained`)
  }

  expectTask(await read(f.root), stale, 'missing bootstrap uses normal home')
  delete process.env.USERPROFILE
  process.env.HOME = home
  expectTask(await read(f.root), stale, 'HOME is used when USERPROFILE is absent')
  process.env.USERPROFILE = home
  process.env.HOME = join(directory, 'unused-home')
  writeFileSync(bootstrap, JSON.stringify({ desktopZoomLevel: 1.1 }))
  expectTask(await read(f.root), stale, 'valid bootstrap without relocation uses home')
  writeFileSync(bootstrap, '\uFEFF' + JSON.stringify({ dataBaseDir: active }))
  const snapshot = await read(f.root, [{ source: 'zcode', sessionId: current.providerId }])
  expectTask(snapshot, current, 'bootstrap selects real metadata instead of stale home')
  check(!snapshot.items.some(item => item.sessionId === stale.id), 'stale home never joins relocated discovery')
  check(!existsSync(join(current.v2, 'provider_config.json')), 'metadata works without provider configuration')
  writeFileSync(bootstrap, JSON.stringify({ dataBaseDir: next }))
  expectTask(await read(f.root), relocated, 'same reader refresh follows bootstrap relocation')
  writeFileSync(bootstrap, '{ malformed bootstrap')
  await expectUnavailable('malformed bootstrap')

  process.env.ZCODE_HOME = join(active, '.zcode')
  expectTask(await read(f.root), current, 'ZCODE_HOME overrides malformed bootstrap')
  process.env.ZCODE_DATA_BASE_DIR = next
  process.env.ZCODE_HOME = join(directory, 'invalid-zcode-home')
  expectTask(await read(f.root), relocated, 'data-base environment overrides ZCODE_HOME and bootstrap')
  const explicit = nativeReader({ nativeRoots: { ...options.nativeRoots, zcode: current.v2 } }, f.launch)
  expectTask(await explicit(f.root), current, 'explicit root identifies exact v2 and overrides environment')
  process.env.ZCODE_DATA_BASE_DIR = 'relative-base'
  expectTask(await explicit(f.root), current, 'explicit root ignores invalid lower-priority sources')
  await expectUnavailable('relative data-base environment')
  process.env.ZCODE_DATA_BASE_DIR = join(directory, 'missing-base')
  await expectUnavailable('missing data-base environment')
  process.env.ZCODE_DATA_BASE_DIR = bootstrap
  await expectUnavailable('file used as data-base environment')
  const emptyBase = join(directory, 'empty-base')
  mkdirSync(emptyBase)
  process.env.ZCODE_DATA_BASE_DIR = emptyBase
  await expectUnavailable('configured base without native v2 directory')
  mkdirSync(join(emptyBase, '.zcode', 'v2'), { recursive: true })
  await expectUnavailable('configured native directory without metadata DB')
  delete process.env.ZCODE_DATA_BASE_DIR
  for (const value of ['relative/.zcode', active, join(directory, 'missing', '.zcode')]) {
    process.env.ZCODE_HOME = value
    await expectUnavailable('invalid ZCODE_HOME')
  }
  delete process.env.ZCODE_HOME
  for (const dataBaseDir of ['relative-root', '', '  ', null, 42, {}, join(directory, 'missing-bootstrap-root'), bootstrap]) {
    writeFileSync(bootstrap, JSON.stringify({ dataBaseDir }))
    await expectUnavailable('invalid configured bootstrap dataBaseDir')
  }
  for (const document of ['[]', 'null', '42', '{broken', JSON.stringify({ dataBaseDir: active, excess: 'x'.repeat(256 * 1024) })]) {
    writeFileSync(bootstrap, document)
    await expectUnavailable('invalid or oversized bootstrap document')
  }
  unlinkSync(bootstrap)
  mkdirSync(bootstrap)
  await expectUnavailable('bootstrap is a directory')
  rmdirSync(bootstrap)
  expectTask(await read(f.root), stale, 'removed bootstrap returns to normal home')
  writeFileSync(bootstrap, JSON.stringify({ dataBaseDir: active }))
  expectTask(await read(f.root), current, 'unavailable source recovers on later refresh')
  f.setOnCapability(source => { if (source === 'codex') throw new Error('Isolated native capability failure') })
  const otherFailure = await read(f.root)
  expectTask(otherFailure, current, 'another native source failure does not hide ZCode')
  check(otherFailure.sources.find(source => source.source === 'codex').available === false, 'independent capability failure remains visible')
  f.setOnCapability(undefined)
  for (const zcode of ['', 'relative-v2', join(directory, 'missing-explicit'), bootstrap]) {
    await expectUnavailable('invalid explicit root', nativeReader({ nativeRoots: { ...options.nativeRoots, zcode } }, f.launch))
  }
  check(nativeFiles.map(hash).every((value, index) => value === original[index]), 'all native fixture DB/history bytes remain unchanged')
  check(f.calls.length === 0, 'discovery never activates a native application')
  console.log(JSON.stringify({ ok: true, checks, scope: 'nativeReader source-root precedence, relocation, metadata and isolated failures; fixtures only' }))
} finally {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const suffix = relative(tmpdir(), directory)
  if (!suffix || isAbsolute(suffix) || suffix.startsWith('..')) throw new Error('Unexpected fixture cleanup path')
  rmSync(directory, { recursive: true, force: true })
}
