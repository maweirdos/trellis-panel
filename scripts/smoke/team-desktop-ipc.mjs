/** Actual registry/preload/team IPC; explicit team/application/OS fixture boundaries. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
const temporary = mkdtempSync(join(tmpdir(), 'trellis-team-ipc-'))
const r = globalThis.__TEAM_IPC__ = { root: join(temporary, 'project-a'), generation: 1, handlers: new Map(), renderer: new EventEmitter(), reads: [], fixedReads: [], applications: 0, queued: [], notifications: 0, blockCanonical: null, canonicalReads: [], blockRead: null, blockQueue: null, serviceError: null }
mkdirSync(r.root, {recursive:true});r.root=realpathSync.native(r.root)
const mocks = {
  'node:fs/promises': `import{promises as fs}from'node:fs';export async function realpath(path){const r=globalThis.__TEAM_IPC__;r.canonicalReads.push(path);if(r.blockCanonical)await r.blockCanonical;return fs.realpath(path)}`,
  electron: `export const ipcMain={handle:(channel,fn)=>globalThis.__TEAM_IPC__.handlers.set(channel,fn),on(){}};export const ipcRenderer={invoke:(channel,...args)=>globalThis.__TEAM_IPC__.handlers.get(channel)({sender:{id:1}},...args),on:(channel,fn)=>globalThis.__TEAM_IPC__.renderer.on(channel,fn),removeListener:(channel,fn)=>globalThis.__TEAM_IPC__.renderer.removeListener(channel,fn),send(){}};export const contextBridge={exposeInMainWorld:(_key,value)=>globalThis.__TEAM_IPC__.api=value};`,
  '../state': 'export const getProjectRoot=()=>globalThis.__TEAM_IPC__.root;export const getProjectGeneration=()=>globalThis.__TEAM_IPC__.generation;',
  '../services/workflow-desktop': `export const getWorkflowApplication=async()=>({readArtifact:async input=>{const r=globalThis.__TEAM_IPC__;r.reads.push(input);if('kind' in input)throw Error('strict application input received renderer source discriminant');if(input.ref.endsWith('b'.repeat(64)))throw Object.assign(Error('foreign ref'),{code:'SCOPE_CHANGED'});if(r.blockRead)await r.blockRead;return {owner:{repositoryId:'actual-repository',workspaceId:'actual-workspace',taskRef:'original/task-ref'},material:{source:{kind:'trellis-file',relativePath:'.trellis/tasks/task-a/prd.md'},version:'immutable-version-A',kind:'trellis-prd'},text:'trusted immutable A',bodyDigest:'a'.repeat(64)}},readRecoveryArtifact:async input=>{const r=globalThis.__TEAM_IPC__;r.reads.push(input);if(input.run.runId!=='retained-run'||'kind' in input)throw Object.assign(Error('exact retained run absent'),{code:'NOT_FOUND'});return {owner:{repositoryId:'actual-repository',workspaceId:'actual-workspace',taskRef:'deleted-task'},material:{source:{kind:'trellis-file',relativePath:'.trellis/tasks/deleted-task/prd.md'},version:'retained-A',kind:'trellis-prd'},text:'retained immutable A',bodyDigest:'a'.repeat(64)}}});`,
  '../services/team-desktop': `const r=globalThis.__TEAM_IPC__;export const notifyDesktopTeamChanged=()=>r.notifications++;const service={connections:async()=>[{connectionId:'public-connection',state:'pending',projectId:null}],beginPairing:async()=>{if(r.serviceError)throw r.serviceError;return {connection:{state:'pending',projectId:null},browser:'opened'}},queueMaterialPublication:async(input,material)=>{r.queued.push({input,material});if(r.blockQueue)await r.blockQueue;return {commandId:input.commandId,state:'queued',outcomeUnknown:false}},queueFeedback:async input=>({commandId:input.commandId,state:'queued',receipt:null}),dispatch:async()=>{throw Object.assign(Error('Remote write may have happened td_'+'A'.repeat(43)),{code:'ACKNOWLEDGEMENT_UNKNOWN',outcomeUnknown:true})}};export const withDesktopTeamService=async(action)=>action(service);`
}
mocks['./workflow-desktop'] = mocks['../services/workflow-desktop'].replace('async()=>(', 'async()=>(globalThis.__TEAM_IPC__.applications++,')
mocks['./document-views'] = `export const getDocumentViews=()=>({selectedMaterial:async(root,token)=>{const r=globalThis.__TEAM_IPC__;r.fixedReads.push({root,token});if(token.endsWith('b'.repeat(64)))throw Object.assign(Error('foreign fixed source'),{code:'SCOPE_CHANGED'});return {owner:{repositoryId:'original-reader-repository',workspaceId:'original-reader-workspace',taskRef:'original-reader-task'},material:{source:{kind:'trellis-file',relativePath:'docs/original-product.md'},version:'reader-immutable-A',kind:'product-requirement'},text:'original reader immutable A',bodyDigest:'a'.repeat(64)}}});`
const groups = [], check = async (name, work) => { await work(); groups.push({ name, status: 'passed' }) }
try {
  await build({ stdin: { contents: "export {registerTeamDesktopIpc} from './src/main/ipc/team-desktop';export {ipcEvent} from './src/shared/ipc-channels';import './src/preload/index';", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(temporary, 'ipc.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'explicit-team-ipc-boundaries', setup(builder) { builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'team-boundary' } : null); builder.onLoad({ filter: /.*/, namespace: 'team-boundary' }, (args) => ({ contents: mocks[args.path], loader: 'js' })) } }] })
  const module = await import(pathToFileURL(join(temporary, 'ipc.mjs')).href); module.registerTeamDesktopIpc()
  const api = r.api.teamDesktop, root = r.root, source = { kind: 'task-run', taskDir: 'task-a', run: { runId: 'run-a', revision: 1 }, ref: 'wm-' + 'a'.repeat(64) }
  const input = { connectionId: randomUUID(), commandId: randomUUID(), materialId: randomUUID(), title: 'Selected PRD A', visibility: 'project', expectedVersion: null, source }
  await check('actual preload read has no write invalidation loop and pending is not active/online', async () => {
    const value = await api.connections(); assert.equal(value.ok, true); assert.equal(value.value[0].state, 'pending'); assert.equal(value.value[0].projectId, null); assert.equal(r.notifications, 0)
  })
  await check('foreign root, task path, scope and renderer old body fail before trusted source/queue', async () => {
    const count = r.reads.length
    assert.equal((await api.queueWorkflowMaterial(join(temporary, 'foreign'), input)).code, 'SCOPE_CHANGED')
    assert.equal((await api.queueWorkflowMaterial(root, { ...input, source: { ...source, taskDir: '../task-a' } })).code, 'INVALID_INPUT')
    assert.equal((await api.queueWorkflowMaterial(root, { ...input, text: 'renderer old body' })).code, 'INVALID_INPUT')
    assert.equal((await api.queueWorkflowMaterial(root, { ...input, source: { ...source, scope: { taskRef: 'forged' } } })).code, 'INVALID_INPUT')
    assert.equal(r.reads.length, count); assert.equal(r.queued.length, 0)
  })
  await check('publication resolves exact run/ref membership and sends only actual immutable main source', async () => {
    assert.equal((await api.queueWorkflowMaterial(root, { ...input, source: { ...source, ref: 'wm-' + 'b'.repeat(64) } })).code, 'SCOPE_CHANGED')
    assert.equal(r.queued.length, 0)
    const result = await api.queueWorkflowMaterial(root, input); assert.equal(result.ok, true); assert.equal(result.value.state, 'queued')
    assert.equal(r.queued[0].material.text, 'trusted immutable A'); assert.equal(r.queued[0].material.taskRef, 'original/task-ref'); assert.equal('source' in r.queued[0].input, false)
    assert.deepEqual(r.reads.at(-1), { taskDir: 'task-a', run: source.run, ref: source.ref })
  })
  await check('deleted source recovery uses only exact retained run and original immutable owner', async () => {
    const recovery = { ...input, commandId: randomUUID(), source: { kind: 'workspace-recovery', run: { runId: 'retained-run', revision: 2 }, ref: source.ref } }
    assert.equal((await api.queueWorkflowMaterial(root, { ...recovery, source: { ...recovery.source, run: source.run } })).code, 'NOT_FOUND')
    const result = await api.queueWorkflowMaterial(root, recovery); assert.equal(result.ok, true); assert.equal(r.queued.at(-1).material.taskRef, 'deleted-task'); assert.equal(r.queued.at(-1).material.text, 'retained immutable A')
    assert.equal('kind' in r.reads.at(-1), false); assert.equal('taskDir' in r.reads.at(-1), false)
  })
  await check('registered fixed token publication preserves original reader source without creating a workflow application', async () => {
    const count = r.applications, queued = r.queued.length, token = 'rd-' + 'a'.repeat(64)
    const fixed = { ...input, commandId: randomUUID(), source: { kind: 'fixed-document', token } }
    assert.equal((await api.queueWorkflowMaterial(root, { ...fixed, source: { ...fixed.source, text: 'old renderer text' } })).code, 'INVALID_INPUT')
    assert.equal((await api.queueWorkflowMaterial(root, { ...fixed, source: { kind: 'fixed-document', token: 'rd-' + 'b'.repeat(64) } })).code, 'SCOPE_CHANGED')
    assert.equal(r.queued.length, queued)
    assert.equal((await api.queueWorkflowMaterial(root, fixed)).ok, true)
    assert.equal(r.applications, count); assert.deepEqual(r.fixedReads.at(-1), { root, token })
    assert.equal(r.queued.at(-1).material.text, 'original reader immutable A'); assert.equal(r.queued.at(-1).material.taskRef, 'original-reader-task')
  })
  await check('project generation changes before queue prevent publication; changes after queue report unknown without rollback', async () => {
    let resumeRead; r.blockRead = new Promise((done) => { resumeRead = done }); const count = r.queued.length
    const pending = api.queueWorkflowMaterial(root, { ...input, commandId: randomUUID() }); await new Promise((done) => setTimeout(done, 5)); r.generation++; resumeRead()
    assert.equal((await pending).code, 'SCOPE_CHANGED'); assert.equal(r.queued.length, count); r.blockRead = null
    let resumeQueue; r.blockQueue = new Promise((done) => { resumeQueue = done }); const commandId = randomUUID()
    const queued = api.queueWorkflowMaterial(root, { ...input, commandId }); await new Promise((done) => setTimeout(done, 5)); r.generation++; resumeQueue()
    const unknown = await queued; assert.equal(unknown.code, 'SCOPE_CHANGED'); assert.equal(unknown.outcomeUnknown, true); assert.equal(r.queued.at(-1).input.commandId, commandId); r.blockQueue = null
  })
  await check('uncertain native transport preserves stable error code/unknown and redacts credential-shaped text', async () => {
    const result = await api.dispatch(input.commandId)
    assert.equal(result.code, 'ACKNOWLEDGEMENT_UNKNOWN'); assert.equal(result.outcomeUnknown, true); assert.equal(result.error.includes('td_'), false)
    const feedback = await api.queueFeedback({ commandId: input.commandId }); assert.equal(feedback.value.state, 'queued'); assert.equal(feedback.value.receipt, null)
  })
  await check('actual preload change subscription is removable and carries no body or credential payload', async () => {
    const updates = [], off = api.onChanged((value) => updates.push(value))
    const event = { connectionId: input.connectionId, reason: 'updated', occurredAt: Date.now() }
    r.renderer.emit(module.ipcEvent.teamDesktopChanged, {}, event); assert.deepEqual(updates, [event]); off()
    r.renderer.emit(module.ipcEvent.teamDesktopChanged, {}, event); assert.equal(updates.length, 1)
  })
  await check('verified canonical reader root and actual directory alias publish the same original source; missing/different roots fail closed', async () => {
    const alias=join(temporary,'project-a-alias');symlinkSync(root,alias,process.platform==='win32'?'junction':'dir')
    const expected=realpathSync.native(root);assert.equal(realpathSync.native(alias),expected)
    r.root=alias;r.generation++
    const fixed={...input,source:{kind:'fixed-document',token:'rd-'+'c'.repeat(64)}}
    try {
      const accepted=await api.queueWorkflowMaterial(expected,fixed)
      assert.equal(accepted.ok,true);assert.equal(r.fixedReads.at(-1).root,expected)
      assert.equal(r.queued.at(-1).material.text,'original reader immutable A')
      const count=r.queued.length,reads=r.fixedReads.length
      const other=join(temporary,'different-real-root');mkdirSync(other)
      assert.equal((await api.queueWorkflowMaterial(other,fixed)).code,'SCOPE_CHANGED')
      assert.equal((await api.queueWorkflowMaterial(join(temporary,'missing-root'),fixed)).code,'SCOPE_CHANGED')
      assert.equal(r.queued.length,count);assert.equal(r.fixedReads.length,reads)
    } finally {r.root=root;r.generation++}
  })
  await check('project switch during asynchronous actual realpath cannot resolve or queue a trusted source', async () => {
    let resume;r.blockCanonical=new Promise(done=>{resume=done});const count=r.canonicalReads.length,reads=r.fixedReads.length,queued=r.queued.length
    const pending=api.queueWorkflowMaterial(root,{...input,source:{kind:'fixed-document',token:'rd-'+'c'.repeat(64)}})
    while(r.canonicalReads.length<count+2)await new Promise(done=>setTimeout(done,1))
    r.generation++;resume();const result=await pending;r.blockCanonical=null
    assert.equal(result.code,'SCOPE_CHANGED');assert.equal(r.fixedReads.length,reads);assert.equal(r.queued.length,queued)
  })
  await check('preload source-state call sends no document token/path/owner parameters', async () => {
    let count=0;r.handlers.set('doc:source-state',(_event,...args)=>{count++;assert.deepEqual(args,[]);return {ok:true,sourceActive:true}})
    assert.deepEqual(await r.api.documentWindowSourceState(),{ok:true,sourceActive:true});assert.equal(count,1)
  })
  const report = { status: 'passed', groups: groups.length, scope: 'Actual main IPC registry/preload/source adapter with explicit service/application/OS boundaries; not native credential or server acceptance', results: groups }
  const index = process.argv.indexOf('--report'); if (index >= 0) { const path = resolve(process.argv[index + 1]); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2)) }
  console.log(`PASS team desktop IPC: ${groups.length} groups`)
} finally {
  assert.equal(dirname(realpathSync.native(temporary)), realpathSync.native(tmpdir()))
  assert.ok(basename(temporary).startsWith('trellis-team-ipc-'))
  rmSync(temporary, { recursive: true, force: true }); delete globalThis.__TEAM_IPC__
}
