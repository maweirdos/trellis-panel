/** Actual registry + workflow handlers + preload; isolated application/OS boundaries. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-workflow-ipc-'))
const reportAt = process.argv.indexOf('--report')
const reports = []
const state = globalThis.__WORKFLOW_IPC_SMOKE__ = {
  root: join(temporary, 'project-a'), generation: 1, closed: false, handlers: new Map(),
  renderer: new EventEmitter(), sent: [], applications: [], artifacts: [], reads: [],
  permission: 'native-request-1', terminal: false, cursor: 0, deferStart: null,
  committed: 0, snapshotBlock: null, revisions: [], managedAdmissions: 0, recoveryReads: []
}
state.sender = Object.assign(new EventEmitter(), { id: 11, destroyed: false, isDestroyed() { return this.destroyed } })
const electron = `export const ipcMain={handle:(channel,fn)=>globalThis.__WORKFLOW_IPC_SMOKE__.handlers.set(channel,fn),on(){}};
 export const ipcRenderer={invoke:(channel,...args)=>globalThis.__WORKFLOW_IPC_SMOKE__.handlers.get(channel)({sender:globalThis.__WORKFLOW_IPC_SMOKE__.sender},...args),
 on:(channel,fn)=>globalThis.__WORKFLOW_IPC_SMOKE__.renderer.on(channel,fn),removeListener:(channel,fn)=>globalThis.__WORKFLOW_IPC_SMOKE__.renderer.removeListener(channel,fn),send(){}};
 export const contextBridge={exposeInMainWorld:(key,value)=>{globalThis.__WORKFLOW_IPC_SMOKE__[key]=value}};`
const mocks = {
  '../state': `export const getProjectRoot=()=>globalThis.__WORKFLOW_IPC_SMOKE__.root; export const getProjectGeneration=()=>globalThis.__WORKFLOW_IPC_SMOKE__.generation;`,
  '../services/workflow-desktop': `const r=globalThis.__WORKFLOW_IPC_SMOKE__;
    export const isWorkflowAdmissionClosed=()=>r.closed;
    export const withManagedWorkflowAdmission=async(_root,action)=>{r.managedAdmissions++;return action()};
    export const workflowDesktopTemplates=()=>[{id:'actual-template',name:'Actual template',description:'fixture adapter'}];
    export async function getWorkflowApplication(root){r.applications.push(root);return {
      preview:async input=>({previewId:'opaque-preview',...input}),
      previewRevision:async input=>{r.revisions.push({kind:'preview',input});return {state:'saved',previewId:'revision-preview',target:input.run}},
      acceptRevision:async input=>{r.revisions.push({kind:'accept',input});return {state:'waiting-boundary',commandId:input.commandId,target:input.run}},
      cancelRevision:async input=>{r.revisions.push({kind:'cancel',input});return {state:'cancelled',commandId:input.commandId}},
      revisionStatus:async input=>{r.revisions.push({kind:'status',input});return {state:'stop-unconfirmed',commandId:input.commandId}},
      inspectWorkspaceRecovery:async input=>{r.recoveryReads.push(input);if(input.run?.runId==='foreign-run')throw Object.assign(Error('exact run absent'),{code:'NOT_FOUND'});return {scope:{taskRef:'original-retained-task'},ownership:{state:'recovery-required',recoveryRequired:true},projection:{snapshot:{run:{run:input.run??{runId:'run-a',revision:1}}}},source:{state:'missing',alias:null,candidates:[],reason:'original task missing'}}},
      readRecoveryArtifact:async input=>{r.recoveryReads.push(input);if(input.ref.endsWith('b'.repeat(64)))throw Object.assign(Error('foreign recovery artifact'),{code:'SCOPE_CHANGED'});return {ref:input.ref,text:'retained-immutable-A',owner:{taskRef:'original-retained-task'}}},
      start:async input=>{r.committed++;if(r.deferStart)await r.deferStart;return {commandId:input.commandId,status:'committed',run:{runId:'run-a',revision:1}}},
      snapshot:async input=>{if(r.snapshotBlock)await r.snapshotBlock;return {snapshot:{run:{state:r.terminal?'verified':'running',run:{runId:'run-a',revision:1}}},
        origin:{sessionId:'origin-a',connectionGeneration:'generation-a'},stageSessions:[{sessionId:'stage-b',connectionGeneration:'generation-b',pendingPermissions:[{requestId:r.permission,options:[{optionId:'native-allow-once'}]}]}],
        nodes:[],cursor:'cursor-'+r.cursor,composer:{target:r.terminal?'ordinary':'managed'},recoveryRequired:false}},
      events:async input=>({items:r.cursor++===0?[{event:{type:'workflow.observed'}}]:[],cursor:'cursor-'+r.cursor,resetRequired:false,hasMore:false}),
      stop:async input=>({commandId:input.commandId,run:input.run,status:'unconfirmed'}),
      readArtifact:async input=>{r.reads.push(input);if(input.ref.endsWith('b'.repeat(64)))throw Object.assign(Error('foreign run artifact'),{code:'SCOPE_CHANGED'});return {ref:input.ref,text:'immutable-A',owner:{taskRef:'verified-task'}}}
    }}`,
  '../services/document-views': `export const getDocumentViews=()=>({registerMaterial:async(root,stored)=>{globalThis.__WORKFLOW_IPC_SMOKE__.artifacts.push({root,stored});return {token:'rd-main-owned',digest:'a'.repeat(64),revision:'selected-A',relativePath:'.trellis/tasks/task-a/prd.md'}}});`,
  '../services/bridge': `export function broadcastToWindows(channel,payload){const r=globalThis.__WORKFLOW_IPC_SMOKE__;r.sent.push({channel,payload});r.renderer.emit(channel,{},payload)}`
}
const wait = async (predicate, label) => { const end = Date.now() + 4000; while (Date.now() < end) { if (predicate()) return; await new Promise((done) => setTimeout(done, 15)) } throw Error(`Timeout: ${label}`) }
const check = async (name, fn) => { await fn(); reports.push({ name, status: 'passed' }) }
let module
try {
  await build({ stdin: { contents: "export * from './src/main/ipc/workflow';export {ipcInvoke,ipcEvent} from './src/shared/ipc-channels';import './src/preload/index'", loader: 'ts', resolveDir: process.cwd() },
    outfile: join(temporary, 'ipc.mjs'), bundle: true, format: 'esm', platform: 'node', plugins: [{ name: 'workflow-ipc-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => args.path === 'electron' || Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'workflow-ipc-boundary' } : null)
      builder.onLoad({ filter: /.*/, namespace: 'workflow-ipc-boundary' }, (args) => ({ contents: args.path === 'electron' ? electron : mocks[args.path], loader: 'js' }))
    } }] })
  module = await import(pathToFileURL(join(temporary, 'ipc.mjs')).href)
  module.registerWorkflowIpc()
  const api = state.trellis.managedWorkflow
  const rootA = state.root
  await check('real registry/preload reject missing, foreign and malformed scope before application access', async () => {
    const count = state.applications.length
    state.root = null
    assert.equal((await api.snapshot(rootA, { taskDir: 'task-a' })).code, 'E_NO_PROJECT')
    state.root = rootA
    assert.equal((await api.snapshot(join(temporary, 'project-b'), { taskDir: 'task-a' })).code, 'E_CONFLICT')
    assert.equal((await api.snapshot(rootA, { taskDir: '../task-a' })).code, 'E_INVALID_ARG')
    assert.equal(state.applications.length, count)
  })
  await check('preview discloses new native-session defaults rather than claiming transient model settings are inherited', async () => {
    const preview = await api.preview(rootA, { taskDir: 'task-a', flowId: 'template-a', origin: { sessionId: 'origin-a', connectionGeneration: 'generation-a' } })
    assert.equal(preview.ok, true)
    assert.ok(preview.value.limitations.some((line) => line.includes('默认模型') && line.includes('不会自动沿用')))
  })
  await check('admitted write with project switch returns conflict without pretending rollback or replay', async () => {
    let resume
    state.deferStart = new Promise((done) => { resume = done })
    const pending = api.start(rootA, { taskDir: 'task-a', commandId: 'stable-command', previewId: 'opaque-preview' })
    await wait(() => state.committed === 1, 'commit admitted')
    state.root = join(temporary, 'project-b'); state.generation++
    resume(); const result = await pending
    assert.equal(result.code, 'E_CONFLICT'); assert.equal(state.committed, 1)
    state.root = rootA; state.generation++; state.deferStart = null
  })
  await check('quit admission closure blocks new work but leaves reads and uncertain stop outcomes visible', async () => {
    state.closed = true
    assert.equal((await api.start(rootA, { taskDir: 'task-a', commandId: 'closed-command', previewId: 'preview' })).code, 'E_CONFLICT')
    assert.equal((await api.snapshot(rootA, { taskDir: 'task-a' })).ok, true)
    const stop = await api.stop(rootA, { taskDir: 'task-a', commandId: 'stop-command', run: { runId: 'run-a', revision: 1 } })
    assert.equal(stop.value.status, 'unconfirmed'); state.closed = false
  })
  await check('artifact bridge accepts only authorized immutable main bytes, never renderer old text', async () => {
    const valid = { taskDir: 'task-a', ref: `wm-${'a'.repeat(64)}` }
    assert.equal((await api.artifact(rootA, { ...valid, text: 'renderer-forgery' })).code, 'E_INVALID_ARG')
    assert.equal(state.artifacts.length, 0)
    assert.equal((await api.artifact(rootA, { ...valid, ref: `wm-${'b'.repeat(64)}` })).code, 'E_CONFLICT')
    assert.equal(state.artifacts.length, 0)
    assert.equal((await api.artifact(rootA, valid)).value.revision, 'selected-A')
    assert.equal(state.artifacts[0].stored.text, 'immutable-A')
    assert.equal(state.artifacts[0].stored.owner.taskRef, 'verified-task')
  })
  await check('revision intents retain strict scope and saved/waiting/uncertain states without fresh-start admission', async () => {
    const input = { taskDir: 'task-a', run: { runId: 'run-a', revision: 1 }, flowId: 'actual-template', reason: 'Apply recorded requirement change', boundary: 'after-current-stage' }
    const count = state.revisions.length
    assert.equal((await api.previewRevision(rootA, { ...input, scope: { taskRef: 'client-authority' } })).code, 'E_INVALID_ARG')
    assert.equal(state.revisions.length, count)
    assert.equal((await api.previewRevision(rootA, input)).value.state, 'saved')
    const starts = state.managedAdmissions
    const accept = await api.acceptRevision(rootA, { taskDir: 'task-a', run: input.run, previewId: 'revision-preview', commandId: 'revision-command' })
    assert.equal(accept.value.state, 'waiting-boundary'); assert.equal(state.managedAdmissions, starts)
    assert.equal((await api.revisionStatus(rootA, { taskDir: 'task-a', commandId: 'revision-command' })).value.state, 'stop-unconfirmed')
    assert.equal((await api.cancelRevision(rootA, { taskDir: 'task-a', commandId: 'revision-command' })).value.state, 'cancelled')
  })
  await check('path-free recovery is readonly, exact-run scoped and registers only original stored material', async () => {
    const reads = state.recoveryReads.length, starts = state.managedAdmissions
    const run = { runId: 'run-a', revision: 1 }
    assert.equal((await api.inspectRecovery(rootA, { run, taskDir: 'replacement-task' })).code, 'E_INVALID_ARG')
    assert.equal((await api.inspectRecovery(rootA, { scope: { taskRef: 'forged' } })).code, 'E_INVALID_ARG')
    assert.equal((await api.inspectRecovery(join(temporary, 'project-b'), { run })).code, 'E_CONFLICT')
    assert.equal(state.recoveryReads.length, reads)
    state.closed = true
    const result = await api.inspectRecovery(rootA, { run })
    assert.equal(result.ok, true)
    assert.equal(result.value.source.state, 'missing')
    assert.equal(result.value.ownership.recoveryRequired, true)
    assert.deepEqual(result.value.projection.snapshot.run.run, run)
    assert.equal((await api.inspectRecovery(rootA, { run: { runId: 'foreign-run', revision: 1 } })).code, 'E_NOT_FOUND')
    const count = state.artifacts.length, input = { run, ref: `wm-${'a'.repeat(64)}` }
    assert.equal((await api.recoveryArtifact(rootA, { ...input, text: 'renderer-forgery' })).code, 'E_INVALID_ARG')
    assert.equal((await api.recoveryArtifact(rootA, { ...input, ref: `wm-${'b'.repeat(64)}` })).code, 'E_CONFLICT')
    assert.equal(state.artifacts.length, count)
    assert.equal((await api.recoveryArtifact(rootA, input)).ok, true)
    assert.equal(state.artifacts.at(-1).stored.text, 'retained-immutable-A')
    assert.equal(state.artifacts.at(-1).stored.owner.taskRef, 'original-retained-task')
    assert.equal(state.managedAdmissions, starts)
    state.closed = false
  })
  await check('projection stream preserves native stage request/option IDs, emits actual terminal and releases', async () => {
    const updates = []; const done = []
    const off = api.onOutput((event) => updates.push(event)); const offDone = api.onDone((event) => done.push(event))
    const result = await api.subscribe(rootA, { taskDir: 'task-a' })
    await wait(() => updates.some((event) => event.leaseId === result.value.leaseId), 'first projection')
    assert.equal(updates[0].snapshot.stageSessions[0].sessionId, 'stage-b')
    assert.equal(updates[0].snapshot.stageSessions[0].pendingPermissions[0].requestId, 'native-request-1')
    assert.equal(updates[0].snapshot.stageSessions[0].pendingPermissions[0].options[0].optionId, 'native-allow-once')
    state.terminal = true
    await wait(() => done.length === 1, 'terminal output')
    assert.equal(done[0].leaseId, result.value.leaseId)
    off(); offDone(); state.terminal = false
  })
  await check('project generation change discards in-flight subscription results', async () => {
    let resume; state.snapshotBlock = new Promise((done) => { resume = done })
    const old = state.sent.length
    const result = await api.subscribe(rootA, { taskDir: 'task-a' })
    await new Promise((done) => setTimeout(done, 20))
    state.generation++; resume(); state.snapshotBlock = null
    await new Promise((done) => setTimeout(done, 30))
    assert.equal(state.sent.slice(old).some((event) => event.payload.leaseId === result.value.leaseId), false)
  })
  await check('sender lease count bounded; unsubscribe cannot release another owner and cleanup does not accumulate listeners', async () => {
    const ids = []
    for (let index = 0; index < 8; index++) ids.push((await api.subscribe(rootA, { taskDir: 'task-a' })).value.leaseId)
    assert.equal((await api.subscribe(rootA, { taskDir: 'task-a' })).code, 'E_DENIED')
    const own = state.sender
    state.sender = Object.assign(new EventEmitter(), { id: 12, isDestroyed: () => false })
    await api.unsubscribe(ids[0])
    state.sender = own
    assert.equal((await api.subscribe(rootA, { taskDir: 'task-a' })).code, 'E_DENIED')
    for (const id of ids) await api.unsubscribe(id)
    for (let index = 0; index < 12; index++) { const value = await api.subscribe(rootA, { taskDir: 'task-a' }); await api.unsubscribe(value.value.leaseId) }
    assert.equal(own.listenerCount('destroyed'), 1)
    own.destroyed = true; own.emit('destroyed')
  })
  const report = { status: 'passed', scenarios: reports.length, scope: 'Actual workflow IPC/registry/preload with explicit application/native boundaries; not real engine or UI acceptance', results: reports }
  if (reportAt >= 0) { const path = resolve(process.argv[reportAt + 1]); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2) + '\n') }
  console.log(`PASS workflow desktop IPC: ${reports.length} boundary scenarios`)
} finally { module?.stopWorkflowSubscriptions(); rmSync(temporary, { recursive: true, force: true }); delete globalThis.__WORKFLOW_IPC_SMOKE__ }
