/** Real facade/core + owned ACP peer. Metadata edits must never dispatch native work. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-session-management-'))
const root = join(temporary, 'project-a'), other = join(temporary, 'project-b')
mkdirSync(root); mkdirSync(other)
process.env.TPAP_SMOKE_DIR = temporary
const workerFile = await prepareAcpHistoryWorker(temporary)
const directory = join(temporary, 'acp')
const canonical = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const key = canonical(root), otherKey = canonical(other)
const record = (id, startedAt = 100, projectRoot = root) => ({ schemaVersion: 2, sessionId: id, projectRoot,
  agentId: 'fixture', agentName: 'Fixture', title: `automatic ${id}`, startedAt, status: 'disconnected', events: [] })
const success = (result) => { assert.equal(result.ok, true, result.error); return result }
const fail = (result, code) => { assert.equal(result.ok, false); assert.equal(result.code, code) }
const wait = async (predicate) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((done) => setTimeout(done, 15)) }
  throw new Error('Owned peer did not reach expected state')
}
let acp, core
try {
  // Capture actual preload invocations and main handlers; only project state is injected.
  const mock = join(temporary, 'electron.mjs')
  writeFileSync(mock, `export * from ${JSON.stringify(resolve('scripts/smoke/mock-electron.mjs').replaceAll('\\', '/'))};
    export const ipcMain={handle:(channel,fn)=>globalThis.__managementHandlers.set(channel,fn),on:()=>{}};
    export const ipcRenderer={invoke:(channel,...args)=>Promise.resolve(globalThis.__managementHandlers.get(channel)({},...args)),on:()=>{},removeListener:()=>{},send:()=>{}};
    export const contextBridge={exposeInMainWorld:(_name,api)=>{globalThis.__managementApi=api}};`)
  globalThis.__managementHandlers = new Map()
  globalThis.__managementScope = { root, generation: 1 }
  const request = createRequire(import.meta.url)
  await build({ stdin: { contents: `export * from './src/main/services/acp'; export * from './src/main/services/acp/history-core';
    export * from './src/main/services/acp/session-preferences'; export {setSettings} from './src/main/services/store';
    export {registerAcpIpc} from './src/main/ipc/acp'; import './src/preload/index';`, resolveDir: process.cwd(), loader: 'ts' },
    outfile: join(temporary, 'facade.mjs'), bundle: true, format: 'esm', platform: 'node', external: ['acpx', 'acpx/*'],
    banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(resolve('package.json')).href)});` },
    alias: { electron: mock }, plugins: [{ name: 'management-boundaries', setup(builder) {
      builder.onResolve({ filter: /^acpx\// }, (args) => ({ path: pathToFileURL(request.resolve(args.path)).href, external: true }))
      builder.onResolve({ filter: /^\.\.\/state$/ }, (args) => args.importer.replaceAll('\\', '/').endsWith('/ipc/acp.ts') ? { path: 'scope', namespace: 'management' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'management' }, () => ({ contents: 'export const getProjectRoot=()=>globalThis.__managementScope.root;export const getProjectGeneration=()=>globalThis.__managementScope.generation;' }))
    } }], logLevel: 'silent' })
  acp = await import(pathToFileURL(join(temporary, 'facade.mjs')).href)
  acp.registerAcpIpc()
  const api = globalThis.__managementApi
  const prefsPath = acp.sessionPreferencesPath(directory, root)
  const source = join(temporary, 'acp-sessions'); mkdirSync(source)
  const fixtures = [record('old', 1), record('tie-a'), record('tie-b'), { ...record('legacy', 2), schemaVersion: 1 }, record('same-id'), record('same-id', 100, other)]
  for (const [index, item] of fixtures.entries()) writeFileSync(join(source, `${index}.json`), JSON.stringify(item))
  core = new acp.AcpHistoryCore(directory)
  core.append(fixtures.map((item) => ({ root: canonical(item.projectRoot), record: item, events: item.events })))
  const frozen = core.list(key, { limit: 1 })
  acp.updateSessionPreferences(directory, root, 'old', { title: '  Unique manual title  ', pinned: true })
  assert.throws(() => core.list(key, { limit: 1, cursor: frozen.nextCursor }), acp.HistoryCursorError)
  assert.equal(core.list(key).sessions[0].sessionId, 'old')
  assert.deepEqual(core.list(key).sessions.slice(1, 3).map((item) => item.sessionId), ['tie-b', 'tie-a'])
  assert.equal(core.list(key, { query: 'unique manual' }).sessions[0].customTitle, 'Unique manual title')
  core.append([{ root: key, record: record('old', 1), events: [] }])
  core.close(); core = new acp.AcpHistoryCore(directory)
  assert.equal(core.session(key, 'old').title, 'Unique manual title', 'reopen/append cannot replace human title')
  assert.equal(core.events(key, 'old').session.pinnedAt, core.session(key, 'old').pinnedAt)
  assert.equal(core.session(otherKey, 'same-id').customTitle, undefined)
  core.close(); core = undefined

  for (const input of [{}, { title: '   ' }, { title: 'x'.repeat(201) }, { title: null }, { pinned: 1 }, { archived: 'true' }, { ignored: true }, { title: 'valid', ignored: true }, { pinned: undefined }]) {
    fail(await api.acpHistoryUpdate('old', input), 'E_INVALID_ARG')
  }
  fail(await api.acpHistoryUpdate('../old', { pinned: true }), 'E_INVALID_ARG')
  fail(await api.acpHistoryUpdate('missing', { pinned: true }), 'E_NOT_FOUND')
  const beforeDrift = readFileSync(prefsPath)
  const stale = api.acpHistoryUpdate('old', { title: 'must not persist' })
  globalThis.__managementScope.generation++
  fail(await stale, 'E_NO_PROJECT')
  assert.deepEqual(readFileSync(prefsPath), beforeDrift)
  globalThis.__managementScope.root = null
  fail(await api.acpHistoryUpdate('old', { pinned: true }), 'E_NO_PROJECT')
  globalThis.__managementScope.root = root
  success(await api.acpHistoryUpdate('legacy', { title: 'Legacy manual' }))
  success(await api.acpHistoryUpdate('same-id', { title: 'Root A only' }))
  assert.equal(success(await acp.getAcpHistorySession(other, 'same-id')).session.title, 'automatic same-id')
  const page = success(await api.acpHistoryList({ limit: 1 }))
  success(await api.acpHistoryUpdate('tie-b', { archived: true }))
  fail(await api.acpHistoryList({ limit: 1, cursor: page.nextCursor }), 'E_CONFLICT')
  assert.equal(success(await api.acpHistoryList({ archive: 'archived' })).sessions[0].sessionId, 'tie-b')
  assert.equal(success(await api.acpHistoryList()).sessions.some((item) => item.sessionId === 'tie-b'), false)
  assert.equal(success(await api.acpHistoryList({ archive: 'all' })).sessions.length, 5)
  const paged = [], read = async (cursor) => success(await api.acpHistoryList({ limit: 1, cursor }))
  let next = await read()
  while (true) { paged.push(...next.sessions.map((item) => item.sessionId)); if (!next.nextCursor) break; next = await read(next.nextCursor) }
  assert.deepEqual(paged, success(await api.acpHistoryList()).sessions.map((item) => item.sessionId))
  success(await api.acpHistoryUpdate('tie-b', { archived: false }))
  assert.equal(success(await api.acpHistorySession('tie-b')).session.archivedAt, undefined)
  console.log('PASS core reopen, effective search, pin/stable ties, archive-before-paging, root isolation, validation and IPC generation guard')

  // The actual owned peer logs every native request; edits run while approval is pending.
  const wire = join(temporary, 'wire.log'), peer = join(temporary, 'peer.mjs')
  writeFileSync(wire, '')
  writeFileSync(peer, `import {appendFileSync} from 'node:fs';\n` + readFileSync('scripts/smoke/fixtures/acp-history-peer.mjs', 'utf8')
    .replace('const message = JSON.parse(line)', `const message = JSON.parse(line);appendFileSync(${JSON.stringify(wire)},JSON.stringify(message)+'\\n')`))
  acp.setSettings({ acp: { nodePath: process.execPath, agents: [{ id: 'management-peer', name: 'Management peer', command: 'owned fixture',
    enabled: true, executable: process.execPath, args: [peer] }] } })
  const live = success(await acp.newAcpSession(root, { agentId: 'management-peer' })).sessionId
  const current = () => success(acp.listAcpSessions(root)).sessions.find((item) => item.sessionId === live)
  await wait(() => current()?.status === 'ready')
  success(await api.acpHistoryUpdate(live, { title: 'Human title', pinned: true }))
  success(await acp.promptAcpSession(root, live, 'runtime automatic title'))
  await wait(() => current()?.status === 'awaiting_permission')
  const pending = structuredClone(current().pendingPermissions), generation = current().connectionGeneration
  const content = success(await api.acpHistoryEvents(live)).events
  const wireBefore = readFileSync(wire)
  const edited = success(await api.acpHistoryUpdate(live, { title: '  Human final  ', archived: true, pinned: false })).session
  assert.equal(edited.title, 'Human final'); assert.equal(edited.pinnedAt, undefined); assert.ok(edited.archivedAt)
  assert.equal(current().status, 'awaiting_permission'); assert.equal(current().connectionGeneration, generation)
  assert.deepEqual(current().pendingPermissions, pending)
  assert.deepEqual(success(await api.acpHistoryEvents(live)).events, content)
  assert.equal(success(await api.acpHistorySession(live)).session.title, 'Human final', 'stale live automatic title cannot win')
  assert.deepEqual(readFileSync(wire), wireBefore, 'no native prompt/new/load/stop/config/permission dispatch')
  fail(await acp.updateAcpHistorySession(other, live, { title: 'foreign' }), 'E_DENIED')
  success(await api.acpHistoryUpdate(live, { archived: false }))
  success(acp.respondAcpPermission(root, pending[0].requestId, 'deny'))
  await wait(() => current()?.status === 'ready')
  const state = globalThis.__TPANEL_EVENTS__.filter((item) => item.channel === 'acp:state' && item.payload.sessionId === live && item.payload.session).at(-1)
  assert.equal(state.payload.session.title, 'Human final')
  success(await acp.killAcpSession(root, live))
  await acp.stopAcpHistory()
  assert.equal(success(await api.acpHistorySession(live)).session.title, 'Human final')
  console.log('PASS real facade live overrides, approval/transcript identity, archive reversal, zero native dispatch, worker reopen')

  await acp.stopAcpHistory()
  process.env.TRELLIS_ACP_HISTORY_WORKER_FILE = join(temporary, 'missing-worker.cjs')
  const degraded = success(await api.acpHistoryUpdate('old', { title: 'Degraded manual', archived: true })).session
  assert.equal(degraded.historyPersistence.state, 'degraded')
  assert.equal(success(await api.acpHistoryList({ archive: 'archived', query: 'degraded manual' })).sessions[0].title, 'Degraded manual')
  const fallbackPage = success(await api.acpHistoryList({ limit: 1, archive: 'all' }))
  success(await api.acpHistoryUpdate('legacy', { pinned: true }))
  fail(await api.acpHistoryList({ limit: 1, archive: 'all', cursor: fallbackPage.nextCursor }), 'E_CONFLICT')
  assert.equal(success(await api.acpHistoryEvents('old')).session.title, 'Degraded manual')
  process.env.TRELLIS_ACP_HISTORY_WORKER_FILE = workerFile
  assert.equal(success(await api.acpHistorySession('old')).session.archivedAt, degraded.archivedAt)
  await acp.stopAcpHistory()

  const saved = readFileSync(prefsPath)
  for (const bytes of ['{broken', JSON.stringify({ schemaVersion: 900 }), JSON.stringify({ ...JSON.parse(saved), sessions: { old: { archivedAt: 'yesterday' } } }),
    JSON.stringify({ ...JSON.parse(saved), projectRoot: otherKey })]) {
    writeFileSync(prefsPath, bytes)
    fail(await api.acpHistoryUpdate('old', { title: 'never' }), 'E_IO')
    fail(await api.acpHistoryList(), 'E_IO')
    assert.equal(readFileSync(prefsPath, 'utf8'), bytes, 'damaged/future preferences preserved')
  }
  writeFileSync(prefsPath, saved)
  const blocked = acp.sessionPreferencesPath(directory, other)
  mkdirSync(blocked)
  fail(await acp.updateAcpHistorySession(other, 'same-id', { pinned: true }), 'E_IO')
  console.log('PASS shared degraded store, restored worker, invalidation, malformed/future/root-mismatched preferences and honest I/O errors')
} finally {
  core?.close()
  if (acp) await acp.shutdownAcp()
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('trellis-session-management-'))
  rmSync(temporary, { recursive: true, force: true })
}
