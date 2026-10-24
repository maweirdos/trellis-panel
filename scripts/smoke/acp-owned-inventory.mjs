/** Actual ACP facade/public acpx, owned local stdio peer; no vendor/model calls. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createFileSessionStore } from 'acpx/runtime'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-owned-inventory-'))
const oldData = process.env.TPAP_SMOKE_DIR
process.env.TPAP_SMOKE_DIR = temporary
await prepareAcpHistoryWorker(temporary)
const root = join(temporary, 'project-a'), nested = join(root, 'packages', 'ordinary-b')
for (const project of [root, nested]) {
  const task = join(project, '.trellis', 'tasks', 'task-a'); mkdirSync(task, { recursive: true })
  writeFileSync(join(task, 'task.json'), JSON.stringify({ id: 'task-a', status: 'planning' }))
}
const checks = [], check = async (name, work) => { await work(); checks.push({ name, status: 'passed' }) }
const wait = async (test, label) => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { const result = test(); if (result) return result; await new Promise((done) => setTimeout(done, 15)) }
  throw Error('Timeout: ' + label)
}
const state = globalThis.__OWNED_INVENTORY__ = { ensureGate: null, shutdownGate: null, discoveryGate: null, launchGate: null, discoveryEntered: 0, launchEntered: 0, failShutdown: false }
let acp, first, second
try {
  const runtimeUrl = pathToFileURL(createRequire(import.meta.url).resolve('acpx/runtime')).href
  await build({ stdin: { contents: "export * from './src/main/services/acp';export {sessionPreferencesPath} from './src/main/services/acp/session-preferences';export {acpDataPath} from './src/main/services/acp/metadata';", loader: 'ts', resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', outfile: join(temporary, 'service.mjs'), logLevel: 'silent', alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, banner: { js: "import{createRequire as fixtureRequire}from'node:module';const require=fixtureRequire(import.meta.url);" }, plugins: [{ name: 'owned-native-lifecycle-gates', setup(builder) {
    builder.onResolve({ filter: /^\.\/acp\/setup$/ }, () => ({ path: 'setup', namespace: 'inventory-setup' }))
    builder.onResolve({ filter: /.*/, namespace: 'inventory-setup' }, (args) => ({ path: args.path, namespace: 'file' }))
    builder.onLoad({ filter: /.*/, namespace: 'inventory-setup' }, () => ({ loader: 'js', contents: `
      export * from ${JSON.stringify(resolve('src/main/services/acp/setup.ts').replaceAll('\\', '/'))};
      import{resolveAcpRuntimeLaunch as resolveLaunch,launchArgv as launch}from ${JSON.stringify(resolve('src/main/services/acp/setup.ts').replaceAll('\\', '/'))};
      export async function resolveAcpRuntimeLaunch(...args){const s=globalThis.__OWNED_INVENTORY__;s.discoveryEntered++;if(s.discoveryGate)await s.discoveryGate;return resolveLaunch(...args)}
      export async function launchArgv(...args){const s=globalThis.__OWNED_INVENTORY__;s.launchEntered++;if(s.launchGate)await s.launchGate;return launch(...args)}
    ` }))
    builder.onResolve({ filter: /^acpx\/runtime$/ }, () => ({ path: 'runtime', namespace: 'inventory-runtime' }))
    builder.onResolve({ filter: /^file:/ }, (args) => ({ path: args.path, external: true }))
    builder.onLoad({ filter: /.*/, namespace: 'inventory-runtime' }, () => ({ loader: 'js', contents: `
      export * from ${JSON.stringify(runtimeUrl)};
      import {createAcpRuntime as upstream} from ${JSON.stringify(runtimeUrl)};
      export function createAcpRuntime(options){
        const runtime=upstream(options),ensure=runtime.ensureSession.bind(runtime),shutdown=runtime.shutdown.bind(runtime);
        runtime.ensureSession=async(...args)=>{if(globalThis.__OWNED_INVENTORY__.ensureGate)await globalThis.__OWNED_INVENTORY__.ensureGate;return ensure(...args)};
        runtime.shutdown=async()=>{if(globalThis.__OWNED_INVENTORY__.shutdownGate)await globalThis.__OWNED_INVENTORY__.shutdownGate;if(globalThis.__OWNED_INVENTORY__.failShutdown)throw Error('Owned inventory cleanup failure');return shutdown()};
        return runtime;
      }` }))
  } }] })
  acp = await import(pathToFileURL(join(temporary, 'service.mjs')).href)
  const facts = (id) => acp.listOwnedAcpSessionFacts().find((row) => row.sessionId === id)
  await check('actual starting ownership is visible before native startup; copied scalar DTO exposes no transcript/history/credentials', async () => {
    let release; state.ensureGate = new Promise((done) => { release = done })
    first = await acp.newAcpSession(root, { agentId: 'mock' }); assert.equal(first.ok, true)
    const row = facts(first.sessionId)
    assert.equal(row.status, 'starting'); assert.equal(row.leaseHeld, true)
    assert.deepEqual(Object.keys(row).sort(), ['projectRoot', 'cwd', 'sessionId', 'connectionGeneration', 'status', 'accepting', 'closing', 'disconnected', 'leaseHeld', 'cleanupRequired', 'backgroundWork', 'unfinishedTools', 'turnActive', 'settling', 'pendingPermission'].sort())
    assert.ok(Object.values(row).every((value) => value === null || ['string', 'boolean'].includes(typeof value)))
    row.status = 'closed'; row.projectRoot = 'mutated-copy'; acp.listOwnedAcpSessionFacts().splice(0)
    assert.equal(facts(first.sessionId).status, 'starting'); assert.equal(facts(first.sessionId).projectRoot, root)
    state.ensureGate = null; release(); await wait(() => facts(first.sessionId)?.status === 'ready', 'first ready')
    assert.equal(facts(first.sessionId).leaseHeld, false)
  })
  await check('inventory spans nested project roots and ignores historical records plus damaged presentation preferences', async () => {
    second = await acp.newAcpSession(nested, { agentId: 'mock' }); assert.equal(second.ok, true)
    await wait(() => facts(second.sessionId)?.status === 'ready', 'nested ready')
    assert.equal(acp.listAcpSessions(root).sessions.some((row) => row.sessionId === second.sessionId), false)
    assert.equal(facts(second.sessionId).projectRoot, nested)
    const historical = join(temporary, 'acp-sessions', 'historical-busy.json'); mkdirSync(dirname(historical), { recursive: true })
    writeFileSync(historical, JSON.stringify({ sessionId: 'historical-busy', projectRoot: root, status: 'busy', events: [{ text: 'PRIVATE TRANSCRIPT MUST NOT LEAK' }] }))
    assert.ok(acp.listAcpSessions(root).sessions.some((row) => row.sessionId === 'historical-busy'))
    const preferences = acp.sessionPreferencesPath(acp.acpDataPath(), root); mkdirSync(dirname(preferences), { recursive: true }); writeFileSync(preferences, '{broken')
    try {
      assert.equal(acp.listAcpSessions(root).ok, false, 'presentation projection deliberately unavailable')
      const rows = acp.listOwnedAcpSessionFacts(); assert.equal(rows.length, 2)
      assert.equal(rows.some((row) => row.sessionId === 'historical-busy'), false)
      assert.equal(JSON.stringify(rows).includes('PRIVATE TRANSCRIPT'), false)
    } finally { rmSync(preferences); rmSync(historical) }
  })
  await check('actual accepting flag is visible while metadata still says ready during asynchronous binding', async () => {
    const binding = acp.bindAcpSessionTask(root, first.sessionId, { taskDir: 'task-a', expectedConnectionGeneration: facts(first.sessionId).connectionGeneration })
    assert.equal(facts(first.sessionId).status, 'ready'); assert.equal(facts(first.sessionId).accepting, true)
    assert.equal((await binding).ok, true); assert.equal(facts(first.sessionId).accepting, false)
  })
  await check('actual owned peer exit remains visible as disconnected until explicit facade cleanup', async () => {
    const current = acp.listAcpSessions(root).sessions.find((row) => row.sessionId === first.sessionId)
    const store = createFileSessionStore({ stateDir: acp.acpDataPath('runtime-store') })
    const record = await store.load(current.acpxRecordId)
    assert.ok(record.pid && record.pid !== process.pid)
    process.kill(record.pid) // Only this test's recorded local stdio peer.
    await wait(() => facts(first.sessionId)?.disconnected, 'owned peer exited')
    assert.equal(facts(first.sessionId).status, 'disconnected')
    assert.equal((await acp.killAcpSession(root, first.sessionId)).ok, true)
    assert.equal(facts(first.sessionId), undefined)
  })
  await check('actual turn and pending permission ownership remain visible independently of selected project', async () => {
    const sent = await acp.promptAcpSession(nested, second.sessionId, 'Owned inventory permission probe'); assert.equal(sent.ok, true)
    await wait(() => facts(second.sessionId)?.pendingPermission, 'original permission')
    assert.equal(facts(second.sessionId).turnActive, true); assert.equal(facts(second.sessionId).leaseHeld, true)
    const permission = globalThis.__TPANEL_EVENTS__.filter((event) => event.channel === 'acp:permission').map((event) => event.payload).find((event) => event.sessionId === second.sessionId)
    assert.equal(acp.respondAcpPermission(nested, permission.requestId, 'reject').ok, true)
    await wait(() => facts(second.sessionId)?.status === 'ready', 'denied turn settled')
  })
  await check('model turn completion does not erase actual unfinished tool and directory ownership', async () => {
    assert.equal((await acp.promptAcpSession(nested, second.sessionId, 'review-unfinished-tool')).ok, true)
    await wait(() => facts(second.sessionId)?.status === 'ready' && facts(second.sessionId)?.unfinishedTools, 'unfinished native tool')
    const row = facts(second.sessionId)
    assert.equal(row.turnActive, false); assert.equal(row.leaseHeld, true); assert.equal(row.backgroundWork, true)
  })
  await check('actual drain and failed cleanup stay owned until confirmed shutdown; historical closed rows never reappear', async () => {
    let release; state.shutdownGate = new Promise((done) => { release = done })
    const closing = acp.killAcpSession(nested, second.sessionId)
    assert.equal(facts(second.sessionId).closing, true); assert.equal(facts(second.sessionId).leaseHeld, true)
    state.failShutdown = true; state.shutdownGate = null; release(); assert.equal((await closing).ok, false)
    assert.equal(facts(second.sessionId).cleanupRequired, true); assert.equal(facts(second.sessionId).leaseHeld, true)
    state.failShutdown = false; assert.equal((await acp.killAcpSession(nested, second.sessionId)).ok, true)
    assert.equal(facts(second.sessionId), undefined)
    assert.equal(acp.listAcpSessions(nested).sessions.some((row) => row.sessionId === second.sessionId), true)
  })
  await check('quit reaches actual facade shutdown while new/resume discovery is pending and neither can resurrect native ownership afterwards', async () => {
    for (const kind of ['new', 'resume']) {
      const fresh = await import(pathToFileURL(join(temporary, 'service.mjs')).href + '?quit-case=' + kind)
      let release
      const key = kind === 'new' ? 'discoveryGate' : 'launchGate', counter = kind === 'new' ? 'discoveryEntered' : 'launchEntered'
      state[key] = new Promise((done) => { release = done }); const count = state[counter]
      const pending = kind === 'new' ? fresh.newAcpSession(root, { agentId: 'mock' }) : fresh.resumeAcpSession(nested, second.sessionId)
      await wait(() => state[counter] > count, kind + ' discovery entered')
      assert.equal(fresh.listOwnedAcpSessionFacts().length, 0)
      let drained = false
      const shutdown = fresh.shutdownAcp().then(() => { drained = true })
      await new Promise((done) => setTimeout(done, 20))
      assert.equal(drained, false, 'Canonical shutdown must wait for the admitted discovery/launch operation')
      state[key] = null; release(); await shutdown
      assert.equal((await pending).ok, false)
      assert.deepEqual(fresh.listOwnedAcpSessionFacts(), [])
      await fresh.stopAcpHistory()
    }
  })
  const report = { status: 'passed', scenarios: checks.length, checks, scope: 'Actual acp.ts and public acpx runtime with owned local stdio process; test-only startup/shutdown gates and cleanup fault. No real vendor/model or packaged OS acceptance.' }
  const index = process.argv.indexOf('--report'); if (index >= 0) writeFileSync(resolve(process.argv[index + 1]), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  state.ensureGate = null; state.shutdownGate = null; state.discoveryGate = null; state.launchGate = null; state.failShutdown = false
  if (acp) { await acp.shutdownAcp(); await acp.stopAcpHistory() }
  delete globalThis.__OWNED_INVENTORY__
  if (oldData === undefined) delete process.env.TPAP_SMOKE_DIR; else process.env.TPAP_SMOKE_DIR = oldData
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir())); assert.ok(basename(temporary).startsWith('tpanel-owned-inventory-'))
  rmSync(temporary, { recursive: true, force: true })
}
