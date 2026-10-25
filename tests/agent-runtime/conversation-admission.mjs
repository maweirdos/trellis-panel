/** Independent ordinary admissions and real facade/acpx turns through desktop wrappers. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createFileSessionStore } from 'acpx/runtime'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-conversation-admission-')))
const root = join(directory, 'project with spaces')
const foreign = join(root, 'nested project')
mkdirSync(foreign, { recursive: true })
const savedEnvironment = new Map(['TPAP_SMOKE_DIR', 'TRELLIS_AGENT_CONTEXT_JOURNAL', 'TRELLIS_ACP_HISTORY_WORKER_FILE'].map(key => [key, process.env[key]]))
process.env.TPAP_SMOKE_DIR = directory
process.env.TRELLIS_AGENT_CONTEXT_JOURNAL = join(directory, 'wire.jsonl')
if (!process.argv.includes('--trellis-role=daemon')) process.argv.push('--trellis-role=daemon')
const pause = ms => new Promise(done => setTimeout(done, ms))
const gate = () => { let open; const promise = new Promise(done => { open = done }); return { promise, open } }
const checks = []
const check = async (name, work) => { await work(); checks.push(name); console.log(`PASS ${name}`) }
const conflict = error => error.code === 'E_CONFLICT'
async function until(test, name) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) { if (test()) return; await pause(10) }
  throw Error(`Timeout: ${name}`)
}
const nativeOwner = id => ({ sessionId: id, connectionGeneration: `generation-${id}` })
const git = (...args) => execFileSync('git', ['-c', 'init.templateDir=', '-c', `core.hooksPath=${join(directory, 'empty-hooks')}`, ...args], { windowsHide: true, stdio: 'pipe' })
let actual
try {
  mkdirSync(join(directory, 'empty-hooks'))
  git('init', root)
  git('-C', root, '-c', 'user.name=Admission Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Owned admission fixture')
  await build({ entryPoints: ['src/main/services/workflow-admission.ts'], outfile: join(directory, 'admission.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const admission = await import(pathToFileURL(join(directory, 'admission.mjs')).href)
  const claim = (kind = 'ordinary', owner, recovery) => admission.claimWorkspaceAdmission(root, kind, recovery, { projectRoot: root, owner })

  await check('ordinary A and B own independent tokens; managed remains exclusive until both release', async () => {
    const a = claim('ordinary', nativeOwner('a')), b = claim('ordinary', nativeOwner('b'))
    assert.ok(a.isCurrent() && b.isCurrent())
    assert.throws(() => claim('managed'), conflict)
    a.release(); a.release(); a.retainNative(() => true)
    assert.equal(a.isCurrent(), false); assert.equal(b.isCurrent(), true)
    assert.throws(() => claim('managed'), conflict)
    b.release()
    const managed = claim('managed')
    assert.throws(() => claim(), conflict)
    assert.throws(() => claim('managed'), conflict)
    managed.release()
  })
  await check('canonical project aliases share; a foreign project in the same Git workspace rejects', async () => {
    assert.equal(admission.executionWorkspaceRoot(foreign), root)
    const a = claim()
    assert.throws(() => admission.claimWorkspaceAdmission(root, 'ordinary', undefined, { projectRoot: foreign }), conflict)
    const alias = join(directory, 'project alias')
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const b = admission.claimWorkspaceAdmission(alias, 'ordinary', undefined, { projectRoot: alias })
    assert.ok(a.isCurrent() && b.isCurrent()); a.release(); b.release()
    const linked = join(directory, 'linked worktree')
    git('-C', root, 'worktree', 'add', '--detach', linked, 'HEAD')
    const managed = claim('managed')
    const other = admission.claimWorkspaceAdmission(admission.executionWorkspaceRoot(linked), 'ordinary')
    other.release(); managed.release()
    const malformed = join(directory, 'malformed'); mkdirSync(malformed)
    writeFileSync(join(malformed, '.git'), 'unverified git marker')
    assert.throws(() => admission.executionWorkspaceRoot(malformed), conflict)
  })
  await check('exact recovery replaces only A, rejects stale/busy owners and exposes no managed gap', async () => {
    const owner = nativeOwner('recover-a'), ownerB = nativeOwner('recover-b')
    const a = claim('ordinary', owner), b = claim('ordinary', ownerB)
    let recoverable = false
    a.retainNative(() => true, requested => {
      assert.throws(() => claim('managed'), conflict)
      return recoverable && requested.sessionId === owner.sessionId && requested.connectionGeneration === owner.connectionGeneration
    })
    b.retainNative(() => true, () => false)
    assert.throws(() => claim('ordinary', owner, owner), conflict)
    recoverable = true
    assert.throws(() => claim('ordinary', owner, { ...owner, connectionGeneration: 'stale' }), conflict)
    const next = claim('ordinary', owner, owner)
    assert.equal(a.isCurrent(), false); assert.ok(next.isCurrent() && b.isCurrent())
    a.release(); a.retainNative(() => false)
    assert.ok(next.isCurrent() && b.isCurrent())
    assert.throws(() => claim('ordinary', owner, owner), conflict)
    next.release(); assert.throws(() => claim('managed'), conflict)
    b.release(); claim('managed').release()
  })
  await check('idle pruning and unknown native occupancy cannot erase another conversation', async () => {
    const a = claim(), b = claim()
    a.retainNative(() => false)
    b.retainNative(() => { throw Error('unconfirmed native facts') })
    assert.throws(() => claim('managed'), conflict)
    assert.equal(a.isCurrent(), false); assert.equal(b.isCurrent(), true)
    b.release(); claim('managed').release()
  })
  await check('cap128 counts independent tokens, including recovery replacements', async () => {
    const owner = nativeOwner('bounded-recovery')
    const entries = [claim('ordinary', owner), ...Array.from({ length: 127 }, () => claim())]
    entries[0].retainNative(() => true, requested => requested.sessionId === owner.sessionId && requested.connectionGeneration === owner.connectionGeneration)
    assert.throws(() => claim(), conflict)
    const replacement = claim('ordinary', owner, owner)
    entries[0].release(); assert.equal(replacement.isCurrent(), true)
    assert.throws(() => claim(), conflict)
    entries[1].release(); const available = claim(); available.release()
    for (const entry of entries) entry.release()
    replacement.release()
  })
  await check('shutdown admission drain joins every ordinary owner', async () => {
    const a = claim(), b = claim()
    let drained = false
    const waiting = admission.waitForWorkspaceAdmissions().then(() => { drained = true })
    a.release(); await pause(10); assert.equal(drained, false)
    b.release(); await waiting; assert.equal(drained, true)
  })

  // Real wrappers with explicit owned inventory exercise cleanup/recovery flags
  // independently of the facade directory leases and vendor transport.
  const fixture = globalThis.__TRELLIS_CONVERSATION_ADMISSION_FIXTURE__ = { sessions: [], unavailable: false }
  const mocked = {
    './acp': `const fixture=globalThis.__TRELLIS_CONVERSATION_ADMISSION_FIXTURE__;
      export const listOwnedAcpSessionFacts=()=>{if(fixture.unavailable)throw Error('Inventory unavailable');return fixture.sessions.map(session=>({cwd:session.projectRoot,accepting:false,closing:false,disconnected:session.status==='disconnected',leaseHeld:false,cleanupRequired:false,backgroundWork:false,unfinishedTools:false,turnActive:false,settling:false,pendingPermission:false,...session}))};
      export const listAcpSessions=root=>({ok:true,sessions:fixture.sessions.filter(session=>session.projectRoot===root)});
      export const getAcpHistorySession=async(root,id)=>{const session=fixture.sessions.find(session=>session.projectRoot===root&&session.sessionId===id);return session?{ok:true,session}:{ok:false}};
      export const listAcpProfiles=()=>({ok:true,profiles:[]});export const listAcpAgents=async()=>({ok:true,agents:[]});`,
    './workflow-runtime': 'export const createFacadeWorkflowAcpPort=()=>({});',
    './workflow-application': 'export class WorkflowApplicationError extends Error{};export const WorkflowApplicationService={create:()=>{throw Error("No managed fixture controller")}};export const readLocalApplicationDefinition=()=>{};',
    './acp/setup': 'export const runtimeDefinitions=()=>[];',
    './documents': 'export const readDocument=()=>{};',
    './flow': 'export const listFlows=()=>[];',
    './document-views': 'export const getDocumentViews=()=>null;export const readerMaterialOwner=()=>({});'
  }
  await build({ stdin: { contents: "export * from './src/main/services/workflow-desktop';export * from './src/main/services/workflow-admission';", loader: 'ts', resolveDir: process.cwd() },
    outfile: join(directory, 'wrappers.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'owned-inventory', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocked, args.path) ? { path: args.path, namespace: 'owned-inventory' } : null)
      builder.onLoad({ filter: /.*/, namespace: 'owned-inventory' }, args => ({ contents: mocked[args.path], loader: 'js' }))
    } }] })
  const wrapper = await import(pathToFileURL(join(directory, 'wrappers.mjs')).href)
  const session = id => ({ ...nativeOwner(id), projectRoot: root, cwd: root, status: 'ready' })
  const wrapperPrompt = (entry, action) => wrapper.withOrdinaryWorkflowAdmission(root, entry.sessionId, entry.connectionGeneration, action)
  await check('actual wrappers retain independent native owners and allow an idle A lifecycle while B is busy', async () => {
    const a = session('wrapper-a'), b = session('wrapper-b'); fixture.sessions = [a, b]
    for (const entry of [a, b]) assert.equal((await wrapperPrompt(entry, async current => { assert.equal(current(), true); entry.status = 'busy'; return { ok: true } })).ok, true)
    assert.throws(() => wrapper.claimWorkspaceAdmission(root, 'managed'), conflict)
    a.status = 'ready'
    await wrapper.withOrdinaryConnectionAdmission(root, { sessionId: a.sessionId }, async () => ({ ok: true }))
    const owned = wrapper.claimWorkspaceAdmission(root, 'ordinary', undefined, { projectRoot: root, owner: a }); owned.release()
    assert.throws(() => wrapper.claimWorkspaceAdmission(root, 'managed'), conflict)
    b.status = 'ready'; wrapper.claimWorkspaceAdmission(root, 'managed').release()
  })
  await check('actual recovery checks every target busy flag while preserving the independent B token', async () => {
    const a = session('flag-a'), b = session('flag-b'); fixture.sessions = [a, b]
    for (const entry of [a, b]) await wrapperPrompt(entry, async () => { entry.status = 'busy'; return { ok: true } })
    a.status = 'disconnected'
    let dispatched = 0
    const recover = () => wrapper.withOrdinaryConnectionAdmission(root, { sessionId: a.sessionId }, async () => { dispatched++; a.status = 'ready'; return { ok: true } })
    for (const flag of ['accepting', 'closing', 'leaseHeld', 'cleanupRequired', 'backgroundWork', 'unfinishedTools', 'turnActive', 'settling', 'pendingPermission']) {
      a[flag] = true; await assert.rejects(recover(), conflict); a[flag] = false
      assert.equal(dispatched, 0, flag)
    }
    const generation = a.connectionGeneration; a.connectionGeneration = 'foreign-generation'
    await assert.rejects(wrapper.withOrdinaryWorkflowAdmission(root, a.sessionId, generation, async () => { throw Error('Stale prompt must not dispatch') }), conflict)
    a.connectionGeneration = generation
    fixture.unavailable = true
    await assert.rejects(recover(), /Inventory unavailable/)
    fixture.unavailable = false
    assert.equal((await recover()).ok, true); assert.equal(dispatched, 1)
    assert.throws(() => wrapper.claimWorkspaceAdmission(root, 'managed'), conflict)
    b.status = 'ready'; wrapper.claimWorkspaceAdmission(root, 'managed').release()
  })
  await check('failed lifecycle keeps its sole original blocker and exact recovery reachable', async () => {
    const a = session('failed-new-owner'); a.status = 'disconnected'; fixture.sessions = [a]
    const held = gate(), entered = gate()
    const failing = wrapper.withOrdinaryConnectionAdmission(root, {}, async () => { entered.open(); await held.promise; throw Error('Owned lifecycle failed') })
    await entered.promise
    await assert.rejects(wrapper.withOrdinaryConnectionAdmission(root, { sessionId: a.sessionId }, async () => { throw Error('Must remain pending') }), conflict)
    held.open(); await assert.rejects(failing, /Owned lifecycle failed/)
    assert.throws(() => wrapper.claimWorkspaceAdmission(root, 'managed'), conflict)
    await wrapper.withOrdinaryConnectionAdmission(root, { sessionId: a.sessionId }, async () => { a.status = 'ready'; return { ok: true } })
    wrapper.claimWorkspaceAdmission(root, 'managed').release()
    await wrapperPrompt(a, async () => { a.status = 'busy'; return { ok: true } })
    a.status = 'disconnected'
    await wrapper.withOrdinaryConnectionAdmission(root, {}, async () => ({ ok: false }))
    await wrapper.withOrdinaryConnectionAdmission(root, { sessionId: a.sessionId }, async () => { a.status = 'ready'; return { ok: true } })
    wrapper.claimWorkspaceAdmission(root, 'managed').release()
    fixture.sessions = []
  })
  await check('wrapper shutdown joins both prompt preflights and prevents delayed dispatch', async () => {
    const sessions = [session('drain-a'), session('drain-b')]; fixture.sessions = sessions
    const held = [gate(), gate()], entered = [gate(), gate()]
    const pending = sessions.map((entry, index) => wrapperPrompt(entry, async current => {
      entered[index].open(); await held[index].promise; assert.equal(current(), false); return { ok: false }
    }))
    await Promise.all(entered.map(value => value.promise))
    wrapper.setWorkflowAdmissionClosed(true)
    let drained = false
    const waiting = wrapper.waitForWorkspaceAdmissions().then(() => { drained = true })
    held[0].open(); await pending[0]; await pause(10); assert.equal(drained, false)
    held[1].open(); await pending[1]; await waiting
    wrapper.setWorkflowAdmissionClosed(false)
    fixture.sessions = []
  })
  await check('wrapper lifecycle handoffs settle for quit while both pending operations remain fenced', async () => {
    const sessions = [session('connection-a'), session('connection-b')]; fixture.sessions = sessions
    const held = [gate(), gate()], entered = [gate(), gate()]
    const pending = sessions.map((entry, index) => wrapper.withOrdinaryConnectionAdmission(root, { sessionId: entry.sessionId }, async () => {
      entered[index].open(); await held[index].promise; return { ok: false }
    }))
    await Promise.all(entered.map(value => value.promise))
    await wrapper.waitForWorkspaceAdmissions()
    assert.throws(() => wrapper.claimWorkspaceAdmission(root, 'managed'), conflict)
    held[0].open(); await pending[0]
    assert.throws(() => wrapper.claimWorkspaceAdmission(root, 'managed'), conflict)
    held[1].open(); await pending[1]
    wrapper.claimWorkspaceAdmission(root, 'managed').release()
    fixture.sessions = []
  })
  delete globalThis.__TRELLIS_CONVERSATION_ADMISSION_FIXTURE__

  if (!process.argv.includes('--admission-only')) {
    await prepareAcpHistoryWorker(directory)
    const req = createRequire(import.meta.url)
    const unused = { './flow': 'export const listFlows=()=>[];', './document-views': 'export const getDocumentViews=()=>null;export const readerMaterialOwner=()=>({});' }
    await build({ stdin: { contents: "export * from './src/main/services/acp';export * from './src/main/services/workflow-desktop';export * from './src/main/services/workflow-admission';export {acpDataPath} from './src/main/services/acp/metadata';export {setSettings} from './src/main/services/store';", loader: 'ts', resolveDir: process.cwd() },
      outfile: join(directory, 'service.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['better-sqlite3'],
      alias: { electron: resolve('tests/agent-runtime/mock-electron.mjs') },
      banner: { js: `import{createRequire as fixtureRequire}from'node:module';const require=fixtureRequire(${JSON.stringify(pathToFileURL(resolve('package.json')).href)});` },
      plugins: [{ name: 'public-acpx-and-unused-readers', setup(builder) {
        builder.onResolve({ filter: /^acpx(?:\/.*)?$/ }, args => ({ path: pathToFileURL(req.resolve(args.path)).href, external: true }))
        builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(unused, args.path) ? { path: args.path, namespace: 'unused-desktop' } : null)
        builder.onLoad({ filter: /.*/, namespace: 'unused-desktop' }, args => ({ contents: unused[args.path], loader: 'js' }))
      } }] })
    actual = await import(pathToFileURL(join(directory, 'service.mjs')).href)
    actual.setSettings({ acp: { nodePath: process.execPath, agents: [{ id: 'admission-peer', name: 'Admission peer', enabled: true, command: 'owned admission peer', launchKind: 'custom', executable: process.execPath, args: [resolve('tests/agent-runtime/fixtures/acp-agent-context-peer.mjs')] }] } })
    const facts = id => actual.listOwnedAcpSessionFacts().find(row => row.sessionId === id)
    const ready = id => facts(id)?.status === 'ready' && !facts(id)?.turnActive && !facts(id)?.settling
    const wire = () => existsSync(process.env.TRELLIS_AGENT_CONTEXT_JOURNAL) ? readFileSync(process.env.TRELLIS_AGENT_CONTEXT_JOURNAL, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
    const promptCount = () => wire().filter(row => row.method === 'session/prompt').length
    const send = (id, text = 'hold') => actual.withOrdinaryWorkflowAdmission(root, id, facts(id).connectionGeneration,
      admitted => actual.promptAcpSession(root, id, text, undefined, admitted))
    const create = () => actual.withOrdinaryConnectionAdmission(root, {}, () => actual.newAcpSession(root, { agentId: 'admission-peer' }))
    const cancel = async id => { assert.equal((await actual.cancelAcpSession(root, id)).ok, true); await until(() => ready(id), 'cancel settles its own turn') }
    let a, b
    await check('real wrapper turns A and B both dispatch while A continues in background', async () => {
      const first = await create(); assert.equal(first.ok, true, first.error); a = first.sessionId
      await until(() => ready(a), 'A ready')
      assert.equal((await send(a)).ok, true)
      const second = await create(); assert.equal(second.ok, true, second.error); b = second.sessionId
      await until(() => ready(b), 'B ready while A busy')
      assert.equal((await send(b)).ok, true)
      await until(() => promptCount() === 2, 'both actual ACP writes')
      assert.ok(facts(a).turnActive && facts(b).turnActive)
      const records = actual.listAcpSessions(root).sessions
      assert.notEqual(records.find(row => row.sessionId === a).backendSessionId, records.find(row => row.sessionId === b).backendSessionId)
      assert.throws(() => actual.claimWorkspaceAdmission(root, 'managed'), conflict)
      let entered = false
      await assert.rejects(actual.withOrdinaryWorkflowAdmission(root, a, facts(a).connectionGeneration, async () => { entered = true; return { ok: true } }), conflict)
      assert.equal(entered, false)
      await assert.rejects(actual.withOrdinaryConnectionAdmission(foreign, {}, async () => { entered = true; return { ok: true } }), conflict)
      assert.equal(entered, false)
    })
    await check('cancel/release A preserves B; an idle lifecycle A does not retain busy B', async () => {
      await cancel(a)
      assert.equal(facts(b).turnActive, true)
      assert.throws(() => actual.claimWorkspaceAdmission(root, 'managed'), conflict)
      const ownLifecycle = await actual.withOrdinaryConnectionAdmission(root, { sessionId: a }, async () => ({ ok: true }))
      assert.equal(ownLifecycle.ok, true)
      const independent = actual.claimWorkspaceAdmission(root, 'ordinary', undefined, { projectRoot: root, owner: { sessionId: a, connectionGeneration: facts(a).connectionGeneration } })
      independent.release()
      assert.equal((await send(a, 'completed A while B is busy')).ok, true)
      await until(() => ready(a), 'A second turn settles')
      assert.equal(facts(b).turnActive, true)
    })
    await check('exact A recovery while B is busy neither replaces B nor replays a prompt', async () => {
      const before = actual.listAcpSessions(root).sessions.find(row => row.sessionId === a)
      const record = await createFileSessionStore({ stateDir: actual.acpDataPath('runtime-store') }).load(before.acpxRecordId)
      assert.ok(record.pid && record.pid !== process.pid)
      process.kill(record.pid) // Only the owned fixture peer recorded by acpx.
      await until(() => facts(a)?.status === 'disconnected' && !facts(a)?.cleanupRequired, 'confirmed owned peer exit')
      assert.throws(() => actual.claimWorkspaceAdmission(root, 'managed'), conflict)
      const held = gate(), entered = gate(), beforePrompts = promptCount()
      const restoring = actual.withOrdinaryConnectionAdmission(root, { sessionId: a }, async () => {
        entered.open(); await held.promise; return actual.resumeAcpSession(root, a)
      })
      await entered.promise
      assert.throws(() => actual.claimWorkspaceAdmission(root, 'managed'), conflict)
      assert.equal(facts(b).turnActive, true)
      held.open()
      const restored = await restoring; assert.equal(restored.ok, true, restored.error)
      await until(() => ready(a), 'A exact restore')
      const after = actual.listAcpSessions(root).sessions.find(row => row.sessionId === a)
      assert.equal(after.backendSessionId, before.backendSessionId)
      assert.notEqual(after.connectionGeneration, before.connectionGeneration)
      assert.equal(promptCount(), beforePrompts)
      assert.equal(wire().filter(row => row.method === 'session/new').length, 2)
      assert.equal(wire().filter(row => row.method === 'session/load').length, 1)
      assert.equal(facts(b).turnActive, true)
      await cancel(b)
      const managed = actual.claimWorkspaceAdmission(root, 'managed'); managed.release()
    })
    await check('shutdown joins two wrapper preflights and fences both delayed native writes', async () => {
      const gates = [gate(), gate()], entered = [gate(), gate()], before = promptCount()
      const actions = [a, b].map((id, index) => actual.withOrdinaryWorkflowAdmission(root, id, facts(id).connectionGeneration, async admitted => {
        entered[index].open(); await gates[index].promise
        return actual.promptAcpSession(root, id, 'must remain unsent', undefined, admitted)
      }))
      await Promise.all(entered.map(value => value.promise))
      actual.setWorkflowAdmissionClosed(true)
      let drained = false
      const waiting = actual.waitForWorkspaceAdmissions().then(() => { drained = true })
      gates[0].open(); assert.equal((await actions[0]).ok, false)
      await pause(10); assert.equal(drained, false)
      gates[1].open(); assert.equal((await actions[1]).ok, false)
      await waiting; assert.equal(promptCount(), before)
      await assert.rejects(send(a, 'closed admission'), conflict)
      actual.setWorkflowAdmissionClosed(false)
    })
    await check('pending lifecycle handoffs allow quit to reach native shutdown for both owners', async () => {
      const gates = [gate(), gate()], entered = [gate(), gate()]
      const actions = [a, b].map((id, index) => actual.withOrdinaryConnectionAdmission(root, { sessionId: id }, async () => {
        entered[index].open(); await gates[index].promise; return { ok: false }
      }))
      await Promise.all(entered.map(value => value.promise))
      await actual.waitForWorkspaceAdmissions()
      assert.throws(() => actual.claimWorkspaceAdmission(root, 'managed'), conflict)
      gates[0].open(); await actions[0]
      assert.throws(() => actual.claimWorkspaceAdmission(root, 'managed'), conflict)
      gates[1].open(); await actions[1]
      actual.claimWorkspaceAdmission(root, 'managed').release()
    })
  }
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, scope: process.argv.includes('--admission-only') ? 'Actual admission and wrappers with explicit owned-inventory fixture.' : 'Actual admission/wrappers/facade/public acpx with owned local peers; UI and live vendor execution are separate checks.' }))
} finally {
  if (actual) { actual.setWorkflowAdmissionClosed(true); await actual.shutdownAcp(); await actual.stopAcpHistory() }
  for (const [key, value] of savedEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  assert.equal(realpathSync.native(dirname(directory)), realpathSync.native(tmpdir()))
  assert.ok(basename(directory).startsWith('trellis-conversation-admission-'))
  rmSync(directory, { recursive: true, force: true })
}
