/** Actual facade/public acpx: concurrent chats, bounded warm owners and exact restore. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const directory = mkdtempSync(join(tmpdir(), 'trellis-conversation-pool-'))
const root = join(directory, 'project')
const foreign = join(directory, 'foreign-project')
mkdirSync(root)
mkdirSync(foreign)
process.env.TPAP_SMOKE_DIR = directory
process.env.TRELLIS_AGENT_CONTEXT_JOURNAL = join(directory, 'wire.jsonl')
if (!process.argv.includes('--trellis-role=daemon')) process.argv.push('--trellis-role=daemon')
const runtimeUrl = pathToFileURL(resolve('node_modules/acpx/dist/runtime.js')).href
const zcodePeer = join(directory, 'zcode-empty-peer.mjs')
const zcodeLedger = join(directory, 'zcode-native-persisted.json')
const pause = ms => new Promise(done => setTimeout(done, ms))
const wire = () => existsSync(process.env.TRELLIS_AGENT_CONTEXT_JOURNAL) ? readFileSync(process.env.TRELLIS_AGENT_CONTEXT_JOURNAL, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
let acp
let releaseLaunch
const gate = () => { let open; const promise = new Promise(done => { open = done }); return { promise, open } }
let prepareGate, shutdownGate, materialsGate
const state = id => acp.listAcpSessions(root, 100).sessions.find(session => session.sessionId === id)
const facts = () => acp.listOwnedAcpSessionFacts()
async function until(predicate, label) {
  const deadline = Date.now() + 35_000
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await pause(10) }
  throw new Error(`Deadline: ${label}`)
}
async function create(agentId = 'conversation-peer') {
  const result = await acp.newAcpSession(root, { agentId })
  assert.equal(result.ok, true, result.error)
  await until(() => state(result.sessionId)?.status === 'ready', 'actual new readiness')
  return result.sessionId
}
async function send(id, text, workflow) {
  const result = await acp.promptAcpSession(root, id, text, undefined, () => true, 0, workflow)
  assert.equal(result.ok, true, result.error)
  if (!['hold', 'permission-hold'].includes(text)) await until(() => state(id)?.status === 'ready', 'terminal ready')
  return result
}
async function cancel(id) {
  assert.equal((await acp.cancelAcpSession(root, id)).ok, true)
  await until(() => state(id)?.status === 'ready', 'matching cancelled turn settled')
}
try {
  await prepareAcpHistoryWorker(directory)
  await build({ stdin: { contents: "export * from './src/main/services/acp'; export {setSettings} from './src/main/services/store';", resolveDir: process.cwd(), loader: 'ts' },
    outfile: join(directory, 'service.mjs'), bundle: true, format: 'esm', platform: 'node', alias: { electron: resolve('tests/agent-runtime/mock-electron.mjs') },
    banner: { js: "import {createRequire as fixtureRequire} from 'node:module'; const require=fixtureRequire(import.meta.url);" },
    plugins: [{ name: 'controlled-pool-boundaries', setup(builder) {
      builder.onResolve({ filter: /^file:/ }, ({ path }) => ({ path, external: true }))
      builder.onResolve({ filter: /^acpx\/runtime$/ }, ({ importer }) => /[/\\]services[/\\]acp\.ts$/.test(importer) ? { path: 'runtime', namespace: 'fixture' } : undefined)
      builder.onResolve({ filter: /^\.\/acp\/setup$/ }, ({ importer }) => /[/\\]services[/\\]acp\.ts$/.test(importer) ? { path: 'setup', namespace: 'fixture' } : undefined)
      builder.onResolve({ filter: /^\.\/acp\/materials$/ }, ({ importer }) => /[/\\]services[/\\]acp\.ts$/.test(importer) ? { path: 'materials', namespace: 'fixture' } : undefined)
      builder.onResolve({ filter: /^actual-pool-setup$/ }, () => ({ path: resolve('src/main/services/acp/setup.ts') }))
      builder.onResolve({ filter: /^actual-pool-materials$/ }, () => ({ path: resolve('src/main/services/acp/materials.ts') }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents: path === 'runtime'
        ? `export * from ${JSON.stringify(runtimeUrl)}; import{createAcpRuntime as actual}from ${JSON.stringify(runtimeUrl)};
          export const createAcpRuntime=options=>{const runtime=actual(options),stop=runtime.shutdown.bind(runtime),ensure=runtime.ensureSession.bind(runtime);let key;
          runtime.ensureSession=async input=>{key=input.sessionKey;if(globalThis.__POOL_PREPARE_GATE__){globalThis.__POOL_PREPARE_ENTERED__.push(key);await globalThis.__POOL_PREPARE_GATE__};return ensure(input)};
          runtime.shutdown=async()=>{if(globalThis.__POOL_SHUTDOWN_GATE__){globalThis.__POOL_SHUTDOWN_ENTERED__=key;await globalThis.__POOL_SHUTDOWN_GATE__};if(globalThis.__POOL_FAIL_SHUTDOWN__){globalThis.__POOL_FAIL_SHUTDOWN__=false;throw Error('Owned cleanup failure')};return stop()};return runtime};`
        : path === 'materials'
        ? `export * from 'actual-pool-materials';import{preparePromptMaterials as actual}from 'actual-pool-materials';
          export const preparePromptMaterials=async(...args)=>{if(globalThis.__POOL_MATERIALS_GATE__){globalThis.__POOL_MATERIALS_ENTERED__=true;await globalThis.__POOL_MATERIALS_GATE__};return actual(...args)};`
        : `export * from 'actual-pool-setup';import{launchArgv as actual,resolveAcpRuntimeLaunch as actualResolve}from 'actual-pool-setup';
          const zcodeArgv=${JSON.stringify([process.execPath, zcodePeer])};
          export const resolveAcpRuntimeLaunch=async id=>id==='zcode'?{config:{id,name:'Owned ZCode persistence peer',command:'owned peer',enabled:true,launchKind:'bundled'},argv:zcodeArgv}:actualResolve(id);
          export const launchArgv=async input=>{if(globalThis.__POOL_LAUNCH_GATE__){globalThis.__POOL_LAUNCH_ENTERED__=true;await globalThis.__POOL_LAUNCH_GATE__};return input.id==='zcode'&&input.launchKind==='bundled'?zcodeArgv:actual(input)};` }))
    } }] })
  acp = await import(pathToFileURL(join(directory, 'service.mjs')).href)
  const noLoadPeer = join(directory, 'no-load-peer.mjs')
  writeFileSync(noLoadPeer, readFileSync(resolve('tests/agent-runtime/fixtures/acp-agent-context-peer.mjs'), 'utf8').replace('loadSession: true', 'loadSession: false'))
  // Match native ZCode's load=true/new-empty-in-RAM contract without invoking
  // the installation, account, user daemon or any actual model provider.
  writeFileSync(zcodePeer, `import{existsSync as nativeExists,readFileSync as nativeRead,writeFileSync as nativeWrite}from'node:fs';
    const nativeLedger=${JSON.stringify(zcodeLedger)};
    const nativeIds=()=>nativeExists(nativeLedger)?JSON.parse(nativeRead(nativeLedger,'utf8')):[];
    const persistNative=id=>nativeWrite(nativeLedger,JSON.stringify([...new Set([...nativeIds(),id])]));\n` +
    readFileSync(resolve('tests/agent-runtime/fixtures/acp-agent-context-peer.mjs'), 'utf8')
      .replace("if (method === 'session/load') sessionId = params.sessionId", "if (method === 'session/load') { if (!nativeIds().includes(params.sessionId)) { send({id,error:{code:-32004,message:'Session not found'}}); continue }; sessionId = params.sessionId }")
      .replace("const text = params.prompt.find(block => block.type === 'text')?.text", "const text = params.prompt.find(block => block.type === 'text')?.text; if(text==='failed-native-turn'){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Partial output is not persistence proof'}});send({id,error:{code:-32000,message:'Owned native turn failed'}});continue}")
      .replace("update({ sessionUpdate: 'agent_message_chunk'", "if (!text.startsWith('/')) persistNative(sessionId); update({ sessionUpdate: 'agent_message_chunk'"))
  acp.setSettings({ acp: { agents: [
    { id: 'conversation-peer', name: 'Owned conversation peer', enabled: true, command: 'owned peer',
      launchKind: 'custom', executable: process.execPath, args: [resolve('tests/agent-runtime/fixtures/acp-agent-context-peer.mjs')] },
    { id: 'no-load-peer', name: 'Owned nonresumable peer', enabled: true, command: 'owned nonresumable peer',
      launchKind: 'custom', executable: process.execPath, args: [noLoadPeer] }
  ] } })
  const [a, b] = await Promise.all([create(), create()])
  const c = await create()
  await Promise.all([send(a, 'hold'), send(b, 'hold')])
  assert.equal(state(a).status, 'busy'); assert.equal(state(b).status, 'busy')
  assert.equal(acp.saveAcpProfile(foreign, { id: 'shared-cwd', name: 'Foreign project', description: '', instructions: '',
    runtimeId: 'conversation-peer', cwd: root, maxTurnMinutes: 30 }).ok, true)
  const beforeForeign = wire().length
  const foreignOwner = await acp.newAcpSession(foreign, { agentId: 'conversation-peer', profileId: 'shared-cwd' })
  assert.equal(foreignOwner.ok, false); assert.equal(foreignOwner.code, 'E_CONFLICT')
  assert.equal(wire().length, beforeForeign, 'A different project cannot dispatch into an occupied shared cwd')
  const workflow = { materials: { text: '', files: [], sources: [], changed: [] }, assertActive() {} }
  const exclusive = await acp.promptAcpSession(root, c, 'hold', undefined, () => true, 0, workflow)
  assert.equal(exclusive.ok, false, 'Managed turns remain exclusive while ordinary chats run')
  await cancel(a)
  assert.equal(state(b).status, 'busy', 'Cancelling A cannot cancel B')
  await send(a, 'A continues while B runs')
  await cancel(b)
  await send(c, 'hold', workflow)
  assert.equal((await acp.promptAcpSession(root, a, 'blocked by managed')).ok, false)
  await cancel(c)
  console.log('PASS shared ordinary turns, independent cancellation/next turn and exclusive managed work')

  await Promise.all([send(a, 'permission-hold'), send(b, 'permission-hold')])
  await until(() => state(a)?.pendingPermissions?.length === 1 && state(b)?.pendingPermissions?.length === 1, 'two independent permissions')
  const pa = state(a).pendingPermissions[0], pb = state(b).pendingPermissions[0]
  assert.notEqual(pa.requestId, pb.requestId)
  assert.equal(acp.respondAcpPermission(root, pb.requestId, 'allow-second').ok, true)
  await until(() => state(b)?.status === 'ready', 'B exact original second option')
  assert.equal(state(a).status, 'awaiting_permission')
  assert.equal(acp.respondAcpPermission(root, pa.requestId, 'reject').ok, true)
  await until(() => state(a)?.status === 'ready', 'A original rejection')
  const selectedA = state(a).events.filter(event => event.kind === 'tool-call' && event.payload?.rawOutput?.selected).at(-1).payload.rawOutput.selected
  const selectedB = state(b).events.filter(event => event.kind === 'tool-call' && event.payload?.rawOutput?.selected).at(-1).payload.rawOutput.selected
  assert.equal(selectedA, 'reject'); assert.equal(selectedB, 'allow-second')
  console.log('PASS simultaneous native permission IDs/kinds stay separate and exact')

  await send(b, 'hold')
  const d = await create(), e = await create()
  const all = [a, b, c, d, e]
  assert.equal(facts().length, 4)
  assert.equal(state(b).status, 'busy')
  const evicted = all.find(id => !facts().some(item => item.sessionId === id))
  const remote = state(evicted).backendSessionId
  assert.equal(state(evicted).status, 'disconnected'); assert.equal(state(evicted).canResume, true)
  const opens = wire().filter(call => ['initialize', 'session/new', 'session/load'].includes(call.method)).length
  for (const id of all) assert.equal((await acp.getAcpHistorySession(root, id)).ok, true)
  assert.equal(wire().filter(call => ['initialize', 'session/new', 'session/load'].includes(call.method)).length, opens, 'History reads never connect engines')
  const creates = wire().filter(call => call.method === 'session/new').length
  assert.equal((await acp.resumeAcpSession(root, evicted)).ok, true)
  assert.equal(state(evicted).backendSessionId, remote)
  await send(evicted, 'same remote after idle cache release')
  assert.equal(wire().filter(call => call.method === 'session/new').length, creates)
  assert.equal(state(b).status, 'busy')
  console.log('PASS >4 histories, bounded native owners, busy protection, read-only selection and same-session idle restore')

  await acp.killAcpSession(root, evicted)
  globalThis.__POOL_LAUNCH_GATE__ = new Promise(done => { releaseLaunch = done })
  const restoring = acp.resumeAcpSession(root, evicted)
  await until(() => globalThis.__POOL_LAUNCH_ENTERED__, 'cold launch gate')
  const beforeCancelLoad = wire().filter(call => call.method === 'session/load').length
  const stopping = acp.killAcpSession(root, evicted)
  releaseLaunch(); globalThis.__POOL_LAUNCH_GATE__ = undefined
  const [restoreResult, stopResult] = await Promise.all([restoring, stopping])
  assert.equal(restoreResult.ok, false); assert.equal(stopResult.ok, true)
  assert.ok(!facts().some(item => item.sessionId === evicted))
  assert.equal(wire().filter(call => call.method === 'session/load').length, beforeCancelLoad)
  console.log('PASS explicit Stop fences an in-flight cold resume before native dispatch')

  while (facts().length < 4) await create()
  globalThis.__POOL_FAIL_SHUTDOWN__ = true
  const refused = await acp.newAcpSession(root, { agentId: 'conversation-peer' })
  assert.equal(refused.ok, false)
  const uncertain = facts().find(item => item.cleanupRequired)
  assert.ok(uncertain)
  const blockedIdle = facts().find(item => item.sessionId !== uncertain.sessionId && item.status === 'ready').sessionId
  assert.equal((await acp.promptAcpSession(root, blockedIdle, 'must not overtake cleanup')).ok, false)
  assert.equal((await acp.killAcpSession(root, uncertain.sessionId)).ok, true)
  assert.equal(state(b).status, 'busy')
  await send(blockedIdle, 'healthy admission after cleanup')
  await cancel(b)
  console.log('PASS unconfirmed idle cleanup retains ownership and retries canonically without stopping B')

  while (facts().length < 4) await create()
  const active = facts().map(item => item.sessionId)
  await Promise.all(active.map(id => send(id, 'hold')))
  const saturated = await acp.newAcpSession(root, { agentId: 'conversation-peer' })
  assert.equal(saturated.ok, false)
  assert.equal(facts().length, 4)
  assert.ok(active.every(id => state(id).status === 'busy'))
  console.log('PASS all-busy capacity refuses a fifth owner without killing or replaying existing work')

  await Promise.all(active.map(cancel))
  await Promise.all(facts().map(item => acp.killAcpSession(root, item.sessionId)))
  prepareGate = gate()
  globalThis.__POOL_PREPARE_GATE__ = prepareGate.promise
  globalThis.__POOL_PREPARE_ENTERED__ = []
  const beforeRacePrompts = wire().filter(call => call.method === 'session/prompt').length
  const beforeRaceCreates = wire().filter(call => call.method === 'session/new').length
  const beforeRaceLoads = wire().filter(call => call.method === 'session/load').length
  const previousRemotes = new Map([a, b, c].map(id => [id, state(id).backendSessionId]))
  const restoreA = acp.resumeAcpSession(root, a)
  assert.equal(acp.resumeAcpSession(root, a), restoreA, 'Same-owner restores join the exact in-flight promise')
  assert.equal((await acp.resumeAcpSession(foreign, a)).ok, false, 'Foreign roots cannot join a restore')
  const competing = [restoreA, acp.resumeAcpSession(root, b), acp.resumeAcpSession(root, c),
    acp.newAcpSession(root, { agentId: 'conversation-peer' }), acp.newAcpSession(root, { agentId: 'conversation-peer' })]
  const competingResults = []
  const competed = Promise.all(competing.map(request => request.then(result => { competingResults.push(result); return result })))
  await until(() => globalThis.__POOL_PREPARE_ENTERED__.length > 4
    || (globalThis.__POOL_PREPARE_ENTERED__.length === 4 && competingResults.some(result => !result.ok)), 'four reserved owners and a rejected fifth request')
  assert.equal(facts().length, 4)
  assert.equal(globalThis.__POOL_PREPARE_ENTERED__.length, 4, 'A fifth request cannot overtake pending reservations')
  prepareGate.open(); globalThis.__POOL_PREPARE_GATE__ = undefined
  const raced = await competed
  assert.equal(raced.filter(result => result.ok).length, 4)
  assert.equal(raced.filter(result => !result.ok && result.code === 'E_CONFLICT').length, 1)
  await until(() => facts().every(item => item.status === 'ready'), 'four racing owners ready')
  for (const [id, remote] of previousRemotes) if (facts().some(item => item.sessionId === id)) assert.equal(state(id).backendSessionId, remote)
  assert.equal(wire().filter(call => call.method === 'session/prompt').length, beforeRacePrompts)
  assert.equal(wire().filter(call => call.method === 'session/new').length - beforeRaceCreates, raced.slice(3).filter(result => result.ok).length)
  assert.equal(wire().filter(call => call.method === 'session/load').length - beforeRaceLoads, raced.slice(0, 3).filter(result => result.ok).length)
  console.log('PASS concurrent new/restore reservations share one cap, exact duplicate promise and zero hidden prompts')

  shutdownGate = gate()
  globalThis.__POOL_SHUTDOWN_GATE__ = shutdownGate.promise
  globalThis.__POOL_SHUTDOWN_ENTERED__ = undefined
  const replacing = acp.newAcpSession(root, { agentId: 'conversation-peer' })
  await until(() => globalThis.__POOL_SHUTDOWN_ENTERED__, 'LRU eviction begins canonical shutdown')
  const stoppingId = globalThis.__POOL_SHUTDOWN_ENTERED__
  const beforeEvictionLoads = wire().filter(call => call.method === 'session/load').length
  const waitingRestore = acp.resumeAcpSession(root, stoppingId)
  const explicitStop = acp.killAcpSession(root, stoppingId)
  assert.equal((await acp.resumeAcpSession(root, stoppingId)).ok, false)
  shutdownGate.open(); globalThis.__POOL_SHUTDOWN_GATE__ = undefined
  const [replacement, stoppedRestore, stopped] = await Promise.all([replacing, waitingRestore, explicitStop])
  assert.equal(replacement.ok, true, replacement.error)
  assert.equal(stoppedRestore.ok, false); assert.equal(stopped.ok, true)
  assert.equal(state(stoppingId).status, 'closed')
  assert.ok(!facts().some(item => item.sessionId === stoppingId))
  assert.equal(wire().filter(call => call.method === 'session/load').length, beforeEvictionLoads)
  await until(() => facts().every(item => item.status === 'ready'), 'replacement ready after fenced eviction')
  console.log('PASS explicit Stop overrides idle eviction and fences a restore waiting on that eviction')

  const admittedId = facts()[0].sessionId
  materialsGate = gate()
  globalThis.__POOL_MATERIALS_GATE__ = materialsGate.promise
  globalThis.__POOL_MATERIALS_ENTERED__ = false
  const admitted = acp.promptAcpSession(root, admittedId, 'hold')
  await until(() => globalThis.__POOL_MATERIALS_ENTERED__, 'ordinary preflight owns its lease')
  globalThis.__POOL_FAIL_SHUTDOWN__ = true
  assert.equal((await acp.newAcpSession(root, { agentId: 'conversation-peer' })).ok, false)
  const failedCleanup = facts().find(item => item.cleanupRequired)
  assert.ok(failedCleanup)
  const newAdmission = facts().find(item => item.sessionId !== failedCleanup.sessionId && item.sessionId !== admittedId)
  assert.equal((await acp.promptAcpSession(root, newAdmission.sessionId, 'must stay unsent')).ok, false)
  materialsGate.open(); globalThis.__POOL_MATERIALS_GATE__ = undefined
  assert.equal((await admitted).ok, true, 'A cleanup barrier cannot revoke a previously admitted peer')
  await until(() => facts().find(item => item.sessionId === admittedId)?.turnActive, 'admitted peer dispatches')
  await cancel(admittedId)
  assert.equal((await acp.killAcpSession(root, failedCleanup.sessionId)).ok, true)
  assert.equal(wire().some(call => call.params?.prompt?.some(block => block.text === 'must stay unsent')), false)
  console.log('PASS cleanup uncertainty blocks new owners while an already admitted preflight dispatches and cancels independently')

  await Promise.all(facts().map(item => acp.killAcpSession(root, item.sessionId)))
  const nonresumable = await create('no-load-peer')
  assert.equal(state(nonresumable).canResume, false)
  for (let index = 0; index < 4; index++) await create()
  assert.ok(facts().some(item => item.sessionId === nonresumable), 'LRU eviction must preserve an owner that cannot be restored')
  await Promise.all(facts().filter(item => item.sessionId !== nonresumable).map(item => acp.killAcpSession(root, item.sessionId)))
  for (let index = 0; index < 3; index++) await create('no-load-peer')
  const nonresumableOwners = facts().map(item => item.sessionId)
  const beforeNoLoadCreates = wire().filter(call => call.method === 'session/new').length
  const refusedNoLoad = await acp.newAcpSession(root, { agentId: 'conversation-peer' })
  assert.equal(refusedNoLoad.ok, false, 'Four nonresumable owners cannot be discarded for a new connection')
  assert.equal(refusedNoLoad.code, 'E_CONFLICT')
  assert.deepEqual(facts().map(item => item.sessionId), nonresumableOwners)
  assert.equal(wire().filter(call => call.method === 'session/new').length, beforeNoLoadCreates)
  console.log('PASS nonresumable idle owners are protected; full nonresumable capacity rejects without identity loss')

  await Promise.all(facts().map(item => acp.killAcpSession(root, item.sessionId)))
  const emptyZcode = []
  for (let index = 0; index < 4; index++) emptyZcode.push(await create('zcode'))
  assert.ok(emptyZcode.every(id => state(id).canResume === true), 'Advertised load remains a capability, not native durability evidence')
  const beforeEmptyCreates = wire().filter(call => call.method === 'session/new').length
  const beforeEmptyPrompts = wire().filter(call => call.method === 'session/prompt').length
  const emptyCapacity = await acp.newAcpSession(root, { agentId: 'conversation-peer' })
  assert.equal(emptyCapacity.ok, false, 'Four new ZCode owners must retain unsent drafts even though they advertise native load')
  assert.equal(emptyCapacity.code, 'E_CONFLICT')
  assert.deepEqual(facts().map(item => item.sessionId), emptyZcode)
  assert.equal(wire().filter(call => call.method === 'session/new').length, beforeEmptyCreates)
  assert.equal(wire().filter(call => call.method === 'session/prompt').length, beforeEmptyPrompts)
  console.log('PASS new empty ZCode owners cannot be evicted based on load capability or cached startup metadata')

  await send(emptyZcode[0], '/help')
  await send(emptyZcode[1], 'hold'); await cancel(emptyZcode[1])
  await send(emptyZcode[2], 'failed-native-turn')
  assert.ok(state(emptyZcode[2]).events.some(event => event.kind === 'message' && event.text === 'Partial output is not persistence proof'))
  const unprovedCapacity = await acp.newAcpSession(root, { agentId: 'conversation-peer' })
  assert.equal(unprovedCapacity.ok, false, 'Slash completion, cancellation and partial/failed conversation cannot unlock native eviction')
  assert.deepEqual(facts().map(item => item.sessionId), emptyZcode)
  assert.equal(existsSync(zcodeLedger), false, 'This peer has no durable native sessions yet')

  await send(emptyZcode[0], 'ordinary native completion')
  const proven = emptyZcode[0]
  const nativeId = state(proven).backendSessionId
  assert.deepEqual(JSON.parse(readFileSync(zcodeLedger, 'utf8')), [nativeId])
  const nextOwner = await create()
  assert.ok(!facts().some(item => item.sessionId === proven), 'Only the owner with a normal completed native turn becomes evictable')
  assert.ok(emptyZcode.slice(1).every(id => facts().some(item => item.sessionId === id)))
  const beforeNativeRestoreCreates = wire().filter(call => call.method === 'session/new').length
  assert.equal((await acp.resumeAcpSession(root, proven)).ok, true)
  assert.equal(state(proven).backendSessionId, nativeId)
  assert.ok(!facts().some(item => item.sessionId === nextOwner))
  assert.equal(wire().filter(call => call.method === 'session/new').length, beforeNativeRestoreCreates)
  assert.ok(wire().some(call => call.method === 'session/load' && call.params.sessionId === nativeId))
  await create()
  assert.ok(!facts().some(item => item.sessionId === proven), 'A new owner with successful same-identity native load may be evicted without another prompt')

  const missing = emptyZcode[1]
  await acp.killAcpSession(root, missing)
  const beforeMissingCreates = wire().filter(call => call.method === 'session/new').length
  assert.equal((await acp.resumeAcpSession(root, missing)).ok, false)
  assert.ok(!facts().some(item => item.sessionId === missing))
  assert.equal(wire().filter(call => call.method === 'session/new').length, beforeMissingCreates, 'Failed native load must not fabricate a replacement session')
  console.log('PASS ZCode native turn/load proof gates eviction; failed/cancelled/slash turns and failed load never grant it or replace identity')
} finally {
  releaseLaunch?.(); globalThis.__POOL_LAUNCH_GATE__ = undefined; globalThis.__POOL_FAIL_SHUTDOWN__ = false
  prepareGate?.open(); globalThis.__POOL_PREPARE_GATE__ = undefined
  shutdownGate?.open(); globalThis.__POOL_SHUTDOWN_GATE__ = undefined
  materialsGate?.open(); globalThis.__POOL_MATERIALS_GATE__ = undefined
  await acp?.shutdownAcp()
  assert.ok(directory.startsWith(join(tmpdir(), 'trellis-conversation-pool-')))
  rmSync(directory, { recursive: true, force: true })
}
