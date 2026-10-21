/** Actual desktop host with explicit ACP/application boundaries; no native launch. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-workflow-host-')))
const reportIndex = process.argv.indexOf('--report')
const results = []
const state = globalThis.__WORKFLOW_HOST_SMOKE__ = { roots: [], calls: [], options: [], failStop: false, terminal: false, live: [], sessions: [], runtime: [{ id: 'fixture', name: 'Owned engine', command: 'owned-fixture', enabled: true, launchKind: 'custom' }] }
const current = (root) => ({ sessionId: 'origin', taskDir: 'task-a', projectRoot: root, connectionGeneration: 'connection-a', status: 'ready', agentId: 'fixture', runtimeSnapshot: structuredClone(state.runtime[0]) })
const mocks = {
  './acp': `export const listOwnedAcpSessionFacts=()=>[];export const listAcpSessions=(root)=>({ok:true,sessions:globalThis.__WORKFLOW_HOST_SMOKE__.sessions.filter(s=>s.projectRoot===root)});
    export async function getAcpHistorySession(root,id){const s=globalThis.__WORKFLOW_HOST_SMOKE__.sessions.find(s=>s.projectRoot===root&&s.sessionId===id);return s?{ok:true,session:s}:{ok:false}}
    export const listAcpAgents=async()=>({ok:true,agents:[{id:'fixture',available:true,adapterVersion:'owned-adapter-v1'}]}); export const listAcpProfiles=()=>({ok:true,profiles:[]});`,
  './acp/setup': 'export const runtimeDefinitions=()=>globalThis.__WORKFLOW_HOST_SMOKE__.runtime;',
  './workflow-runtime': 'export const createFacadeWorkflowAcpPort=()=>({});',
  './workflow-application': `const r=globalThis.__WORKFLOW_HOST_SMOKE__;
    export class WorkflowApplicationError extends Error {constructor(code,message){super(message);this.code=code}}
    export const readLocalApplicationDefinition=()=>{throw Error('not used')};
    export const WorkflowApplicationService={create:async options=>{r.roots.push(options.projectRoot);r.options.push(options);return {
      activeRuns:()=>r.live,
      snapshot:async input=>{r.calls.push(input);return {snapshot:{run:{state:r.terminal?'verified':'running'}},composer:{target:r.terminal?'ordinary':'managed'},recoveryRequired:!r.terminal,
        origin:{sessionId:'origin',connectionGeneration:'connection-a'},stageSessions:[{sessionId:'stage',connectionGeneration:'connection-stage'}]}},
      requestShutdown:async()=>r.failStop?[{taskDir:'task-a',status:'unconfirmed'}]:[],close:async()=>{r.closed=(r.closed??0)+1},resolveMaterialOwner:async()=>({taskRef:null})
    }}};`,
  './flow': 'export const listFlows=()=>[];',
  './documents': 'export const readDocument=()=>({ok:true,rawText:JSON.stringify({status:"in_progress"})});',
  './document-views': 'export const getDocumentViews=()=>null;export const readerMaterialOwner=()=>({taskRef:null});'
}
const check = async (name, fn) => { await fn(); results.push({ name, status: 'passed' }) }
try {
  const output = join(temporary, 'host.mjs')
  await build({ entryPoints: [resolve('src/main/services/workflow-desktop.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'host-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => args.importer.endsWith('workflow-desktop.ts') && Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'workflow-host-boundary' } : null)
    builder.onLoad({ filter: /.*/, namespace: 'workflow-host-boundary' }, (args) => ({ contents: mocks[args.path], loader: 'js' }))
  } }] })
  const host = await import(pathToFileURL(output).href)
  const root = join(temporary, 'used-project'); mkdirSync(root)
  state.sessions = [current(root), { ...current(root), sessionId: 'stage', connectionGeneration: 'connection-stage' }]
  await host.getWorkflowApplication(root)
  await check('retained recovery head protects origin and stage composers even with no in-process live run', async () => {
    assert.equal(await host.isManagedWorkflowOrigin(root, 'origin', 'connection-a'), true, JSON.stringify({ roots: state.roots, sessions: state.sessions, calls: state.calls }))
    assert.equal(await host.isManagedWorkflowOrigin(root, 'stage', 'connection-stage'), true)
    assert.equal(await host.isManagedWorkflowOrigin(root, 'origin', 'stale-generation'), false)
    state.terminal = true
    assert.equal(await host.isManagedWorkflowOrigin(root, 'origin', 'connection-a'), false)
    state.terminal = false
  })
  await check('restart consults an existing workflow marker while untouched ordinary project remains free of control files', async () => {
    const untouched = join(temporary, 'untouched'); mkdirSync(untouched)
    state.sessions.push(current(untouched))
    const count = state.roots.length
    assert.equal(await host.isManagedWorkflowOrigin(untouched, 'origin', 'connection-a'), false)
    assert.equal(state.roots.length, count)
    assert.equal(existsSync(join(untouched, '.trellis', '.panel', 'runtime', 'control.sqlite')), false)
    const restored = join(temporary, 'restored'); const runtime = join(restored, '.trellis', '.panel', 'runtime'); mkdirSync(runtime, { recursive: true })
    writeFileSync(join(runtime, 'workflow-local-identity.json'), '{}')
    state.sessions.push(current(restored))
    assert.equal(await host.isManagedWorkflowOrigin(restored, 'origin', 'connection-a'), true)
    assert.ok(state.roots.includes(restored))
  })
  await check('admitted execution ignores origin disconnect while the actual pinned launch configuration remains fenced', async () => {
    const source = await state.options[0].resolveDefinition({ flowId: host.TRELLIS_MANAGED_FLOW, origin: { sessionId: 'origin', connectionGeneration: 'connection-a' }, taskDir: 'task-a' })
    source.assertCurrent()
    state.sessions[0].status = 'disconnected'
    assert.doesNotThrow(() => source.assertExecutionCurrent())
    assert.throws(() => source.assertCurrent(), (error) => error.code === 'SCOPE_CHANGED')
    const original = state.runtime
    state.runtime = [{ ...original[0], command: 'changed-launch-command' }]
    assert.throws(() => source.assertExecutionCurrent(), (error) => error.code === 'MATERIAL_CHANGED')
    state.sessions[0].status = 'ready'; state.sessions[0].runtimeSnapshot = structuredClone(state.runtime[0])
    const changed = await state.options[0].resolveDefinition({ flowId: host.TRELLIS_MANAGED_FLOW, origin: { sessionId: 'origin', connectionGeneration: 'connection-a' }, taskDir: 'task-a' })
    assert.notEqual(changed.definition.defaultExecutor.configuration.digest, source.definition.defaultExecutor.configuration.digest)
    assert.notEqual(changed.definition.defaultExecutor.configuration.version, source.definition.defaultExecutor.configuration.version, 'changed immutable configuration cannot reuse a fixed version1 identity')
    state.runtime = original; state.sessions[0].status = 'ready'
    state.sessions[0].runtimeSnapshot = structuredClone(original[0])
  })
  await check('quit refuses unknown stop outcomes and keeps controllers available for a later deliberate retry', async () => {
    state.failStop = true
    await assert.rejects(host.shutdownWorkflowApplications(), (error) => error.code === 'OUTCOME_UNKNOWN')
    assert.equal(state.closed ?? 0, 0)
    state.failStop = false
    await host.shutdownWorkflowApplications()
    assert.ok(state.closed >= 1)
  })
  const report = { status: 'passed', scenarios: results.length, results, limits: ['Host boundary adapters are explicit fixtures; no native model, renderer, OS or team proof'] }
  if (reportIndex >= 0) { const path = resolve(process.argv[reportIndex + 1]); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2) + '\n') }
  console.log(`PASS workflow desktop host: ${results.length} boundary scenarios`)
} finally { rmSync(temporary, { recursive: true, force: true }); delete globalThis.__WORKFLOW_HOST_SMOKE__ }
