/** Production application + RuntimeHost + ACP/history + admission, owned peer only. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-daemon-build-application-')))
const key = `__daemonApplication${randomUUID().replaceAll('-', '')}`
const previous = new Map(['TPAP_SMOKE_DIR', 'TRELLIS_AGENT_CONTEXT_JOURNAL', 'TRELLIS_ACP_HISTORY_WORKER_FILE'].map(name => [name, process.env[name]]))
const pause = ms => new Promise(done => setTimeout(done, ms))
const gate = () => { let open; const promise = new Promise(done => { open = done }); return { promise, open } }
const fixture = { facts: null, workflowGate: null, pollGate: null, prepareGate: null }
globalThis[key] = fixture
process.env.TPAP_SMOKE_DIR = directory
process.env.TRELLIS_AGENT_CONTEXT_JOURNAL = join(directory, 'peer.jsonl')
const roleAdded = !process.argv.includes('--trellis-role=daemon')
if (roleAdded) process.argv.push('--trellis-role=daemon')
let actual, application
async function until(test, label) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { if (test()) return; await pause(10) }
  throw Error(`Timeout: ${label}`)
}
try {
  const root = join(directory, 'project'); mkdirSync(join(root, '.trellis', 'tasks'), { recursive: true })
  await prepareAcpHistoryWorker(directory)
  const req = createRequire(import.meta.url)
  const mockModules = {
    './native-state': `export class DaemonNativeState{async prepare(){await globalThis[${JSON.stringify(key)}].prepareGate?.promise}initialize(){}install(){}}`,
    './native-state-actions': 'export const createNativeStateActions=()=>({snapshot:()=>({phase:"daemon",revision:1}),write:()=>{throw Error("No settings effects")}})',
    './jira': `export const installJiraDomain=()=>({jira:{pollDue:async()=>{await globalThis[${JSON.stringify(key)}].pollGate?.promise}},authority:{resolve:async()=>{throw Error('No provider network')}}})`,
    './gitlab': 'export const installGitlabDomain=()=>({poll:async()=>{},admission:{resolve:async()=>{throw Error("No provider network")}}})',
    '../services/integrations/providers': 'export const integrationRegistry={catalog:()=>[],get:()=>{throw Error("No external providers")}}'
  }
  const unused = { './flow': 'export const listFlows=()=>[]', './document-views': 'export const getDocumentViews=()=>null;export const readerMaterialOwner=()=>({})' }
  const outfile = join(directory, 'application.cjs')
  await build({ stdin: { contents: `export {createDaemonApplication} from './src/main/daemon/application';export {DaemonDispatcher} from './src/main/daemon/dispatcher';export {DaemonRepository} from './src/main/daemon/repository';export {RuntimeCommands} from './src/main/daemon/runtime/commands';export * from './src/main/services/acp';export {setSettings} from './src/main/services/store';export * from './src/main/services/workflow-admission';export {setWorkflowAdmissionClosed} from './src/main/services/workflow-desktop';export {createDingTalkWorkspace} from './src/main/services/integrations/dingtalk-workspace';`, resolveDir: process.cwd(), loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['better-sqlite3'],
    alias: { electron: resolve('tests/agent-runtime/mock-electron.mjs') },
    plugins: [{ name: 'owned-composition', setup(builder) {
      builder.onResolve({ filter: /^acpx(?:\/.*)?$/ }, args => ({ path: req.resolve(args.path), external: true }))
      builder.onResolve({ filter: /(^|\/)native$/ }, args => ({ path: args.path, namespace: 'native-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'native-fixture' }, () => ({ contents: `const s=globalThis[${JSON.stringify(key)}];export const sameOwner=(a,b)=>JSON.stringify(a)===JSON.stringify(b);export const processIdentity=async()=>s.owner;export const nativeResource=()=>{throw Error('No real native helper')};export const powershellPath=()=>{throw Error('No real native helper')};export const protectDirectory=()=>{throw Error('No real native helper')}` }))
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.importer.replaceAll('\\', '/').endsWith('daemon/application.ts') && Object.hasOwn(mockModules, args.path)) return { path: args.path, namespace: 'composition-fixture' }
        if (Object.hasOwn(unused, args.path)) return { path: args.path, namespace: 'unused' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'composition-fixture' }, args => ({ contents: mockModules[args.path] }))
      builder.onLoad({ filter: /.*/, namespace: 'unused' }, args => ({ contents: unused[args.path] }))
      // Inject observation-only facts and an await gate into the bundled test
      // copies. Production sources/owners are never mutated by these cases.
      builder.onLoad({ filter: /[\\/]services[\\/]acp\.ts$/ }, args => {
        const source = readFileSync(args.path, 'utf8'), needle = 'export function listOwnedAcpSessionFacts(): OwnedAcpSessionFacts[] {'
        assert.ok(source.includes(needle))
        return { contents: source.replace(needle, `${needle}\nconst controlled=globalThis[${JSON.stringify(key)}].facts;if(controlled)return structuredClone(controlled);`), loader: 'ts' }
      })
      builder.onLoad({ filter: /[\\/]services[\\/]workflow-desktop\.ts$/ }, args => {
        const source = readFileSync(args.path, 'utf8'), needle = 'export async function countOwnedWorkflowApplications(root?: string): Promise<number> {'
        assert.ok(source.includes(needle))
        return { contents: source.replace(needle, `${needle}\nawait globalThis[${JSON.stringify(key)}].workflowGate?.promise;`), loader: 'ts' }
      })
    } }] })
  actual = req(outfile)
  actual.setSettings({ acp: { nodePath: process.execPath, agents: [{ id: 'idle-peer', name: 'Owned idle peer', enabled: true, command: 'controlled peer', launchKind: 'custom', executable: process.execPath, args: [resolve('tests/agent-runtime/fixtures/acp-agent-context-peer.mjs')] }] } })
  const owner = { pid: process.pid, startedAt: '639283392000000000', userId: 'fixture-user', executable: process.execPath }
  fixture.owner = owner
  const identity = { profileId: 'a'.repeat(64), userId: owner.userId, mode: 'development', appVersion: '0.1.0', installationId: 'b'.repeat(64) }
  const nativeDirectory = join(directory, 'native'); mkdirSync(join(nativeDirectory, 'owner'), { recursive: true })
  const context = { directory: nativeDirectory, userData: directory, owner, identity }
  const lease = { version: 1, epoch: randomUUID(), nonce: randomUUID(), identity, owner, acquiredAt: Date.now() }
  writeFileSync(join(nativeDirectory, 'owner', 'lease.json'), JSON.stringify(lease))
  const assertOwner = () => assert.deepEqual(JSON.parse(readFileSync(join(nativeDirectory, 'owner', 'lease.json'))), lease)
  const repository = new actual.DaemonRepository(nativeDirectory, lease.epoch, assertOwner, owner)
  const scheduler = { closed: false, stops: 0, closeAdmission() { this.closed = true }, hasRunning: () => false, async shutdown() { this.stops++ } }
  application = actual.createDaemonApplication({ context, repository, settings: { authority: () => 'daemon' }, assertOwner })
  const prepare = gate(); fixture.prepareGate = prepare
  const starting = application.start(scheduler)
  await assert.rejects(application.domains.shutdownIfIdle(), error => error.code === 'E_BUSY', 'actual pending initialization blocks guarded stop')
  assert.equal(application.domains.ready(), false)
  prepare.open(); await starting; fixture.prepareGate = null
  assert.equal(application.domains.ready(), true)
  let exits = 0
  const dispatcher = new actual.DaemonDispatcher(context, lease, repository, { authority: () => 'daemon' }, scheduler, { append() {} }, () => { exits++ }, application.domains)
  const request = (method, payload, workspace) => ({ type: 'request', version: 1, requestId: randomUUID(), commandId: randomUUID(), expectedEpoch: lease.epoch, method, payload, ...(workspace ? { workspace } : {}) })
  await dispatcher.dispatch(request('workspace.grant', { workspaceId: 'project', root, expectedRevision: 0 }), owner)
  const grant = repository.grant('project')
  const domain = async (method, body) => {
    const bytes = Buffer.from(JSON.stringify(body))
    if (bytes.length <= 96 * 1024) return application.domains.dispatch(request(method, { inline: body }, grant), owner)
    const blob = await application.domains.dispatch(request('runtime.blob.open', { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, grant), owner)
    for (let offset = 0; offset < bytes.length; offset += 96 * 1024) await application.domains.dispatch(request('runtime.blob.append', { id: blob.id, offset, data: bytes.subarray(offset, offset + 96 * 1024).toString('base64') }, grant), owner)
    await application.domains.dispatch(request('runtime.blob.seal', { id: blob.id }, grant), owner)
    try { return await application.domains.dispatch(request(method, { blob }, grant), owner) }
    finally { await application.domains.dispatch(request('runtime.blob.release', { id: blob.id }, grant), owner) }
  }
  const stop = () => dispatcher.dispatch(request('daemon.stop', { expectedOwner: owner, idleOnly: true }), owner)
  const createdWire = await domain('runtime.new', { input: { agentId: 'idle-peer' } })
  assert.equal(createdWire.inline.ok, true, JSON.stringify(createdWire))
  const id = createdWire.inline.sessionId
  const facts = () => actual.listOwnedAcpSessionFacts().find(row => row.sessionId === id)
  const ready = () => facts()?.status === 'ready' && !facts()?.turnActive && !facts()?.settling
  await until(ready, 'owned native connection ready')
  const sent = await domain('runtime.prompt', { sessionId: id, text: 'hold' })
  assert.equal(sent.inline.ok, true)
  await until(() => facts()?.turnActive, 'actual model turn active')
  await assert.rejects(stop(), error => error.code === 'E_BUSY')
  assert.equal(facts().turnActive, true, 'busy refusal must not cancel the actual native turn')
  assert.equal(scheduler.closed, false); assert.equal(exits, 0); assert.equal(application.domains.ready(), true)
  const journal = () => readFileSync(process.env.TRELLIS_AGENT_CONTEXT_JOURNAL, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(journal().filter(row => row.method === 'session/cancel').length, 0)
  // An explicit user cancellation alone releases the controlled held turn.
  assert.equal((await actual.cancelAcpSession(root, id)).ok, true)
  await until(ready, 'explicit cancellation settled')
  const idle = facts()
  for (const field of ['accepting', 'closing', 'disconnected', 'leaseHeld', 'cleanupRequired', 'backgroundWork', 'unfinishedTools', 'turnActive', 'settling', 'pendingPermission']) {
    fixture.facts = [{ ...idle, [field]: true }]
    await assert.rejects(stop(), error => error.code === 'E_BUSY', field)
    fixture.facts = null
    assert.equal(scheduler.closed, false); assert.equal(facts().status, 'ready')
  }
  for (const status of ['starting', 'busy', 'awaiting_permission', 'cancelling', 'error', 'disconnected']) {
    fixture.facts = [{ ...idle, status }]
    await assert.rejects(stop(), error => error.code === 'E_BUSY', status)
    fixture.facts = null
  }
  const first = actual.claimWorkspaceAdmission(root, 'ordinary', undefined, { projectRoot: root, owner: { sessionId: 'A', connectionGeneration: 'A' } })
  const second = actual.claimWorkspaceAdmission(root, 'ordinary', undefined, { projectRoot: root, owner: { sessionId: 'B', connectionGeneration: 'B' } })
  first.release()
  await assert.rejects(stop(), error => error.code === 'E_BUSY', 'second ordinary token remains an owner after first releases')
  assert.equal(second.isCurrent(), true); second.release()
  const ownProbe = actual.probeWorkspaceAdmissions(), otherProbe = actual.probeWorkspaceAdmissions()
  ownProbe.release()
  assert.throws(() => actual.claimWorkspaceAdmission(root, 'ordinary'), /正在核对空闲停止/, 'probe release cannot reopen another probe')
  otherProbe.release(); actual.claimWorkspaceAdmission(root, 'ordinary').release()
  const unknown = actual.claimWorkspaceAdmission(root, 'ordinary')
  unknown.retainNative(() => { throw Error('Original inventory is unavailable') })
  await assert.rejects(stop(), error => error.code === 'E_BUSY', 'unknown retained native admission stays fenced')
  assert.equal(unknown.isCurrent(), true); unknown.release()
  const polling = gate(); fixture.pollGate = polling
  const poll = application.domains.poll()
  await assert.rejects(stop(), error => error.code === 'E_BUSY', 'actual composition polling is counted')
  polling.open(); await poll; fixture.pollGate = null
  // Wait inside the real runtime idle inspection and attempt every admission
  // path after the temporary fences have already been installed.
  const inspection = gate(); fixture.workflowGate = inspection
  const probing = stop()
  await until(() => {
    try { const token = actual.claimWorkspaceAdmission(root, 'ordinary'); token.release(); return false } catch { return true }
  }, 'temporary workflow fence installed')
  await assert.rejects(domain('runtime.prompt', { sessionId: id, text: 'must never dispatch' }), error => error.code === 'E_BUSY')
  await assert.rejects(application.admission.resolve(grant, { providerId: 'jira' }), error => error.code === 'E_BUSY')
  // Turn active while inspection waits: final facts must refuse, then reopen.
  fixture.facts = [{ ...idle, accepting: true }]
  inspection.open(); await assert.rejects(probing, error => error.code === 'E_BUSY')
  fixture.workflowGate = null; fixture.facts = null
  actual.claimWorkspaceAdmission(root, 'ordinary').release()
  const rich = '原生历史😀'.repeat(18000)
  assert.equal((await domain('runtime.prompt', { sessionId: id, text: rich })).inline.ok, true)
  await until(ready, 'rich completed turn is healthy idle')
  const history = await domain('runtime.historyEvents', { sessionId: id, input: { limit: 500 } })
  assert.ok(history.blob, 'rich history exercises real writable seal/fsync')
  let offset = 0; const chunks = []
  while (true) {
    const page = await application.domains.dispatch(request('runtime.blob.read', { blob: history.blob, offset }, grant), owner)
    chunks.push(Buffer.from(page.data, 'base64')); offset = page.next
    if (page.done) break
  }
  assert.ok(Buffer.concat(chunks).toString('utf8').includes(rich), 'bulk history keeps the complete original rich text')
  const peerPid = journal().find(row => row.method === 'initialize').pid
  await stop()
  assert.equal(exits, 1); assert.equal(scheduler.closed, true); assert.equal(actual.listOwnedAcpSessionFacts().length, 0)
  await until(() => { try { process.kill(peerPid, 0); return false } catch (error) { return error.code === 'ESRCH' } }, 'canonical original peer exit')
  const retained = await actual.getAcpHistoryEvents(root, id, { limit: 500 })
  assert.equal(retained.ok, true, JSON.stringify(retained)); assert.ok(JSON.stringify(retained).includes(rich), 'canonical stop retains archived rich history')
  assert.equal(retained.coverage.state, 'complete', 'retained history is the complete archive, not a partial fallback')
  await actual.stopAcpHistory()
  // Real DingTalk worker: a Stream still initializing is busy, and temporary
  // probes pause only new intake; releasing one probe cannot release another.
  let intake, closeCount = 0
  const stream = gate()
  const dingState = { apps: [{ id: 'app', revision: 1, state: 'credentials-verified' }], assistants: [{ id: 'assistant', appId: 'app', appRevision: 1, enabled: true, revision: 1, workspace: grant }], inbox: [], deliveries: [] }
  const ding = actual.createDingTalkWorkspace({ repository: { read: () => structuredClone(dingState), change: change => change(dingState) }, workspace: { assertWorkspace() {} }, stream: { version: '2.1.5', async create(input) { intake = input.onMessage; await stream.promise; return { async close() { closeCount++ } } } } })
  const activating = ding.start(), dingProbe = ding.probeIdle()
  assert.equal(dingProbe.busy(), true, 'Stream initialization is actual in-flight work')
  assert.equal(closeCount, 0); dingProbe.release(); stream.open(); await activating
  const one = ding.probeIdle(), two = ding.probeIdle()
  assert.equal(one.busy(), false, 'healthy idle Stream is not active work')
  one.release(); assert.equal(intake({}), false, 'another probe still fences incoming Stream frames')
  two.release(); await ding.shutdown(); assert.equal(closeCount, 1)
  console.log('PASS production application guarded shutdown: active turn continues, complete idle history + canonical peer exit, all busy facts, multiple ordinary tokens, initialization/polling and admission races, real DingTalk probes')
} finally {
  fixture.facts = null; fixture.workflowGate?.open(); fixture.pollGate?.open(); fixture.prepareGate?.open()
  try { await application?.domains.shutdown() } finally { await actual?.stopAcpHistory() }
  delete globalThis[key]
  if (roleAdded) process.argv.splice(process.argv.indexOf('--trellis-role=daemon'), 1)
  for (const [name, value] of previous) if (value === undefined) delete process.env[name]; else process.env[name] = value
  assert.ok(directory.startsWith(realpathSync.native(tmpdir()) + '\\trellis-daemon-build-application-') || directory.startsWith(join(realpathSync.native(tmpdir()), 'trellis-daemon-build-application-')))
  rmSync(directory, { recursive: true, force: true })
}
