/** Actual admission/host/ACP IPC/control worker; native/model boundary is an owned fixture. */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { promisify } from 'node:util'
const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), 'tpanel-admission-')))
const r = globalThis.__ADMISSION_SMOKE__ = { apps: new Map(), sessions: [], handlers: new Map(), writes: [], entered: [], root: '', preflight: null, cancels: [], ends: [], lifecycle: [], lifecycleGate: null }
const controls = [], results = []
const digest = (value) => createHash('sha256').update(value).digest('hex')
const reportIndex = process.argv.indexOf('--report')
const check = async (name, work) => { await work(); results.push({ name, status: 'passed' }) }
const wait = async (test, label) => { const end = Date.now() + 6000; while (Date.now() < end) { if (test()) return; await new Promise((done) => setTimeout(done, 10)) } throw Error('Timeout: ' + label) }
const git = (...args) => execFileSync('git', ['-c', 'init.templateDir=', '-c', `core.hooksPath=${join(temporary, 'empty-hooks')}`, ...args], { windowsHide: true, stdio: 'pipe' })
const acp = `const r=globalThis.__ADMISSION_SMOKE__;
export const listOwnedAcpSessionFacts=()=>r.sessions.filter(s=>s.connectionOwned!==false).map(s=>({projectRoot:s.projectRoot,cwd:s.cwd??null,sessionId:s.sessionId,connectionGeneration:s.connectionGeneration??null,status:s.status,accepting:false,closing:false,disconnected:false,leaseHeld:false,cleanupRequired:!!s.cleanupRequired,backgroundWork:false,unfinishedTools:false,turnActive:false,settling:false,pendingPermission:false,...s.ownedFacts,...(s.directoryLeaseReason?{leaseHeld:true}:{})}));
export const listAcpSessions=root=>({ok:true,sessions:r.sessions.filter(s=>s.projectRoot===root)});
export const getAcpHistorySession=async(root,id)=>{const session=r.sessions.find(s=>s.projectRoot===root&&s.sessionId===id);return session?{ok:true,session}:{ok:false}};
export const promptAcpSession=async(root,id,text,options,isCurrent)=>{const session=r.sessions.find(s=>s.projectRoot===root&&s.sessionId===id);r.entered.push(id);if(r.preflight?.id===id)await r.preflight.promise;if(!isCurrent())return{ok:false,code:'E_CONFLICT',error:'pre-write admission revoked'};session.status='busy';r.writes.push(id);return{ok:true,turnId:'owned-turn-'+r.writes.length}};
export const cancelAcpSession=async(root,id)=>{r.cancels.push(id);r.sessions.find(s=>s.projectRoot===root&&s.sessionId===id).status='ready';return{ok:true}};
export const killAcpSession=async(root,id)=>{r.ends.push(id);r.sessions.find(s=>s.projectRoot===root&&s.sessionId===id).status='closed';return{ok:true}};
export const listAcpAgents=async()=>({ok:true,agents:[]});export const listAcpProfiles=()=>({ok:true,profiles:[]});
export const newAcpSession=async(root,input)=>{r.lifecycle.push({kind:'new',root});if(r.lifecycleGate)await r.lifecycleGate;const session={sessionId:'new-lifecycle-'+r.lifecycle.length,projectRoot:root,cwd:root,connectionGeneration:'new-lifecycle-gen',status:'ready',connectionOwned:true};r.sessions.push(session);return{ok:true,sessionId:session.sessionId}};
export const resumeAcpSession=async(root,id)=>{r.lifecycle.push({kind:'resume',root,id});if(r.lifecycleGate)await r.lifecycleGate;return{ok:true,sessionId:id}};
export const recoverAcpSessionModel=async(root,id,input,isCurrent)=>{r.lifecycle.push({kind:'recover',root,id});if(r.lifecycleGate)await r.lifecycleGate;return isCurrent()?{ok:true,sessionId:id}:{ok:false,code:'E_CONFLICT'}};
export const configureAcpSession=async(root,id)=>{r.lifecycle.push({kind:'configure',root,id});if(r.lifecycleGate)await r.lifecycleGate;return{ok:true,sessionId:id}};
${['respondAcpPermission','saveAcpProfile','deleteAcpProfile','setupAcpRuntime','pickAcpNode','bindAcpSessionTask','listAcpHistorySessions','getAcpHistoryEvents','updateAcpHistorySession','retryAcpHistorySession'].map((name) => `export const ${name}=async()=>({ok:true,events:[]});`).join('\n')}`
const mocks = {
  './acp': acp, '../services/acp': acp,
  '../state': `export const getProjectRoot=()=>globalThis.__ADMISSION_SMOKE__.root;export const getProjectGeneration=()=>1;`,
  './acp/setup': 'export const runtimeDefinitions=()=>[];', './workflow-runtime': 'export const createFacadeWorkflowAcpPort=()=>({});',
  './workflow-application': `export class WorkflowApplicationError extends Error{constructor(code,message){super(message);this.code=code}};export const readLocalApplicationDefinition=()=>{};export const WorkflowApplicationService={create:async options=>{const app=globalThis.__ADMISSION_SMOKE__.apps.get(options.projectRoot);if(!app)throw Error('Unregistered owned application fixture');return app}};`,
  './documents': 'export const readDocument=()=>{};', './flow': 'export const listFlows=()=>[];', './document-views': 'export const getDocumentViews=()=>null;export const readerMaterialOwner=()=>({});',
  electron: 'export const ipcMain={handle:(channel,fn)=>globalThis.__ADMISSION_SMOKE__.handlers.set(channel,fn),on(){}};'
}
let actual
async function make(root) {
  mkdirSync(join(root, '.trellis', 'tasks', 'task-a'), { recursive: true })
  mkdirSync(join(root, '.trellis', 'tasks', 'task-b'), { recursive: true })
  const runtime = join(root, '.trellis', '.panel', 'runtime'); mkdirSync(runtime, { recursive: true })
  const id = digest(root).slice(0, 24)
  const identity = { projectId: 'project-' + id, repositoryId: 'owned-real-git-repository', workspaceId: 'workspace-' + id }
  writeFileSync(join(runtime, 'workflow-local-identity.json'), JSON.stringify({ schemaVersion: 1, canonicalRoot: root, ...identity }))
  const control = new actual.WorkflowControlService(runtime, { workerFile: join(temporary, 'worker.cjs') }); await control.open(); controls.push(control)
  const scope = { ...identity, taskRef: 'task:task-a' }
  const app = { projectRoot: root, runtimeDir: runtime, identity, control, scope, activeRuns: () => [], requestShutdown: async () => [], close: async () => {}, resolveMaterialOwner: async () => scope,
    snapshot: async ({ taskDir }) => { const snapshot = taskDir === 'task-a' ? await control.head(scope) : null; return { snapshot, origin: { sessionId: origin.sessionId, connectionGeneration: origin.connectionGeneration }, composer: { target: snapshot && !['verified', 'failed', 'stopped', 'cancelled'].includes(snapshot.run.state) ? 'managed' : 'ordinary' }, recoveryRequired: false, stageSessions: [] } } }
  r.apps.set(root, app)
  const session = (name, taskDir) => ({ sessionId: id + '-' + name, taskDir, projectRoot: root, cwd: root, connectionGeneration: 'generation-' + id + '-' + name, status: 'ready', connectionOwned: true })
  const ordinary = session('ordinary'), different = session('different', 'task-b'), origin = session('origin', 'task-a')
  r.sessions.push(ordinary, different, origin)
  return { root, app, control, scope, ordinary, different, origin }
}
function invoke(h, session = h.ordinary) { r.root = h.root; return r.handlers.get(actual.ipcInvoke.acp.sessionPrompt)({ sender: { id: 1 } }, session.sessionId, 'Owned mutable test request', { expectedConnectionGeneration: session.connectionGeneration }) }
async function managed(h, suffix = randomUUID()) {
  return actual.withManagedWorkflowAdmission(h.root, async () => {
    const lease = await h.control.claimWorkspace(h.scope)
    assert.notEqual(lease.status, 'owner-conflict'); h.owner = lease.lease.owner
    const run = { runId: 'run-' + suffix, revision: 1 }; const definition = { definitionId: 'guard-fixture', revision: 1 }
    const payload = { previewId: 'preview-' + suffix, taskDir: 'task-a' }
    const command = { contractVersion: 1, commandId: 'start-' + suffix, scope: h.scope, runId: run.runId, expectedRevision: 1, kind: 'start', payload, payloadDigest: digest(actual.canonicalWorkflowJson(payload)), requestedAt: Date.now() }
    const record = { contractVersion: 1, scope: h.scope, run, definition, state: 'running', predecessor: null, createdAt: Date.now() }
    const accepted = await h.control.commit({ command, owner: h.owner, expectedCurrent: null, runChanges: [record], events: [], outbox: [] })
    assert.equal(accepted.status, 'committed'); h.run = record; h.command = command
    return accepted
  })
}
async function release(h) {
  const head = await h.control.head(h.scope)
  if (head && h.owner) {
    const payload = { reason: 'owned fixture contains no managed native dispatch' }
    await h.control.commit({ command: { contractVersion: 1, commandId: randomUUID(), scope: h.scope, runId: head.run.run.runId, expectedRevision: head.run.run.revision, kind: 'reconcile', payload, payloadDigest: digest(actual.canonicalWorkflowJson(payload)), requestedAt: Date.now() }, owner: h.owner, expectedCurrent: head.run.run, runChanges: [{ ...head.run, state: 'stopped' }], events: [], outbox: [] })
  }
  if (h.owner) await h.control.releaseWorkspace(h.scope, h.owner)
}
try {
  mkdirSync(join(temporary, 'empty-hooks'))
  await build({ entryPoints: ['src/main/services/workflow-control/worker.ts'], outfile: join(temporary, 'worker.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  await build({ stdin: { contents: "export * from './src/main/services/workflow-desktop';export * from './src/main/services/workflow-admission';export * from './src/main/services/workflow-control';export {canonicalWorkflowJson} from './src/shared/workflow';export {registerAcpIpc} from './src/main/ipc/acp';export {ipcInvoke} from './src/shared/ipc-channels';", loader: 'ts', resolveDir: process.cwd() }, outfile: join(temporary, 'admission.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'owned-admission-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'owned-admission' } : null)
    builder.onLoad({ filter: /.*/, namespace: 'owned-admission' }, (args) => ({ contents: mocks[args.path], loader: 'js' }))
  } }] })
  await build({ entryPoints: ['src/main/services/workflow-admission.ts'], outfile: join(temporary, 'metadata.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  actual = await import(pathToFileURL(join(temporary, 'admission.mjs')).href); actual.registerAcpIpc()
  const root = join(temporary, 'worktree-a'); git('init', root); git('-C', root, '-c', 'user.name=Workflow Smoke', '-c', 'user.email=workflow-smoke@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Owned admission fixture')
  const otherRoot = join(temporary, 'worktree-b'); git('-C', root, 'worktree', 'add', '--detach', otherRoot, 'HEAD')
  const h = await make(root), other = await make(otherRoot)
  await check('managed owner fences origin/unbound/different-task native IPC while readonly history and ordinary drain controls remain usable', async () => {
    await managed(h)
    const count = r.writes.length
    for (const session of [h.origin, h.ordinary, h.different]) assert.equal((await invoke(h, session)).code, 'E_CONFLICT')
    assert.equal(r.writes.length, count)
    r.root = root
    assert.equal((await r.handlers.get(actual.ipcInvoke.acp.historyEvents)({}, h.ordinary.sessionId, {})).ok, true)
    assert.equal((await r.handlers.get(actual.ipcInvoke.acp.sessionCancel)({}, h.ordinary.sessionId)).ok, true)
    assert.equal((await r.handlers.get(actual.ipcInvoke.acp.sessionKill)({}, h.ordinary.sessionId)).ok, true)
    h.ordinary.taskDir = 'task-a'; h.ordinary.status = 'busy'
    assert.equal((await r.handlers.get(actual.ipcInvoke.acp.sessionKill)({}, h.ordinary.sessionId)).ok, true, 'ordinary same-task turn remains stoppable for drain')
    assert.equal((await r.handlers.get(actual.ipcInvoke.acp.sessionKill)({}, h.origin.sessionId)).code, 'E_CONFLICT')
    h.ordinary.taskDir = undefined
    h.ordinary.status = 'ready'
    await release(h)
  })
  await check('distinct real linked Git worktree may execute while the original workspace remains managed', async () => {
    await managed(h)
    assert.equal((await invoke(other)).ok, true)
    assert.equal(r.writes.at(-1), other.ordinary.sessionId)
    other.ordinary.status = 'ready'; await release(h)
  })
  await check('exact committed start retry reads its original receipt without a second admission or native write', async () => {
    await managed(h)
    const owner = await h.control.workspaceOwner(h.app.identity)
    h.origin.status = 'busy'
    const input = { taskDir: 'task-a', commandId: h.command.commandId, previewId: h.command.payload.previewId }
    const before = r.writes.length
    const receipt = await actual.withManagedWorkflowAdmission(root, () => h.control.getCommand(h.scope, input.commandId), input)
    assert.equal(receipt.status, 'committed')
    assert.deepEqual((await h.control.workspaceOwner(h.app.identity)).owner, owner.owner)
    assert.equal(r.writes.length, before)
    await assert.rejects(actual.withManagedWorkflowAdmission(root, async () => { throw Error('must not reach new dispatch') }, { ...input, commandId: 'unknown-start' }), (error) => error.code === 'E_CONFLICT')
    h.origin.status = 'ready'; await release(h)
  })
  await check('nested cwd shares one physical worktree and cannot bypass its managed owner', async () => {
    mkdirSync(join(root, 'src')); h.ordinary.cwd = join(root, 'src')
    await managed(h)
    assert.equal((await invoke(h)).code, 'E_CONFLICT')
    await release(h); h.ordinary.cwd = root
  })
  await check('ordinary preflight wins admission once; managed start cannot overtake it or the delivered native turn', async () => {
    let resume; const promise = new Promise((done) => { resume = done }); r.preflight = { id: h.ordinary.sessionId, promise }
    const pending = invoke(h); const before = r.entered.length
    await wait(() => r.entered.length > before, 'ordinary preflight entry')
    let actions = 0
    await assert.rejects(actual.withManagedWorkflowAdmission(root, async () => { actions++ }), (error) => error.code === 'E_CONFLICT')
    assert.equal(actions, 0)
    resume(); assert.equal((await pending).ok, true); r.preflight = null
    await assert.rejects(actual.withManagedWorkflowAdmission(root, async () => { actions++ }), (error) => error.code === 'E_CONFLICT')
    r.root = root; await r.handlers.get(actual.ipcInvoke.acp.sessionCancel)({}, h.ordinary.sessionId)
    await managed(h); await release(h)
  })
  await check('actual owned ACP busy, starting and unconfirmed-cleanup facts reject managed admission without changing the task', async () => {
    for (const patch of [{ status: 'busy' }, { status: 'starting' }, { status: 'disconnected' }, { status: 'ready', cleanupRequired: true }, { status: 'ready', directoryLeaseReason: 'owned unfinished tools' }]) {
      Object.assign(h.ordinary, patch)
      let called = false
      await assert.rejects(actual.withManagedWorkflowAdmission(root, async () => { called = true }), (error) => error.code === 'E_CONFLICT')
      assert.equal(called, false)
      Object.assign(h.ordinary, { status: 'ready', cleanupRequired: false, directoryLeaseReason: undefined })
    }
  })
  await check('late stale free-owner query is read again under the token after a competing managed commit', async () => {
    const original = h.control.workspaceOwner.bind(h.control)
    let captured = false, resume; const gate = new Promise((done) => { resume = done })
    h.control.workspaceOwner = async (...args) => { const value = await original(...args); if (!captured) { captured = true; await gate } return value }
    const pending = invoke(h); await wait(() => captured, 'old free query held')
    await managed(h); resume()
    assert.equal((await pending).code, 'E_CONFLICT')
    h.control.workspaceOwner = original; await release(h)
  })
  await check('registered nested project is discovered after host reopen without recent-project history', async () => {
    const nested = await make(join(root, 'packages', 'nested-a'))
    const sibling = await make(join(root, 'packages', 'nested-b'))
    await managed(nested)
    const fresh = await import(pathToFileURL(join(temporary, 'admission.mjs')).href + '?reopened=' + randomUUID())
    r.handlers.clear(); fresh.registerAcpIpc(); r.root = sibling.root
    assert.equal((await r.handlers.get(fresh.ipcInvoke.acp.sessionPrompt)({}, sibling.ordinary.sessionId, 'Owned restart request', { expectedConnectionGeneration: sibling.ordinary.connectionGeneration })).code, 'E_CONFLICT')
    assert.ok((await fresh.workspaceProjects(root)).includes(nested.root))
    await release(nested); r.handlers.clear(); actual.registerAcpIpc()
  })
  await check('another project in the same worktree cannot start a second managed owner', async () => {
    const nested = await make(join(root, 'packages', 'collision-project'))
    await managed(h)
    await assert.rejects(managed(nested), (error) => error.code === 'E_CONFLICT')
    assert.equal(await nested.control.workspaceOwner(nested.app.identity), null)
    assert.equal((await h.control.head(h.scope)).run.state, 'running')
    await release(h)
  })
  await check('missing/corrupted discovery metadata fails closed rather than claiming a free workspace', async () => {
    const path = join(root, '.git', 'trellis-panel', 'workspace-discovery', 'projects.json')
    const bytes = readFileSync(path)
    try {
      writeFileSync(path, '{broken')
      assert.equal((await invoke(h)).code, 'E_CONFLICT')
      rmSync(path)
      assert.equal((await invoke(h)).code, 'E_CONFLICT')
    } finally { writeFileSync(path, bytes) }
  })
  await check('discovery lock keeps live writers fenced and recovers only an actual exited metadata writer', async () => {
    const lock = join(root, '.git', 'trellis-panel', 'workspace-discovery', 'projects.lock')
    writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'live-owned-fixture' }))
    await assert.rejects(actual.registerWorkspaceProject(root, root), (error) => error.code === 'E_CONFLICT')
    rmSync(lock)
    const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { windowsHide: true, encoding: 'utf8' }))
    writeFileSync(lock, JSON.stringify({ pid, nonce: 'actual-dead-writer-fixture' }))
    await actual.registerWorkspaceProject(root, root)
    assert.equal(existsSync(lock), false)
    assert.ok((await actual.workspaceProjects(root)).includes(root))
  })
  await check('two actual metadata-recovery contenders cannot remove a replacement writer or lose an acknowledged project ref', async () => {
    const directory = join(root, '.git', 'trellis-panel', 'workspace-discovery')
    const lock = join(directory, 'projects.lock'), recovery = join(directory, 'projects.recovery.lock')
    const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { windowsHide: true, encoding: 'utf8' }))
    const projects = [await make(join(root, 'packages', 'metadata-race-a')), await make(join(root, 'packages', 'metadata-race-b'))]
    writeFileSync(lock, JSON.stringify({ pid, nonce: 'actual-dead-contended-writer' }))
    writeFileSync(recovery, 'in-flight-recovery-owned-fixture')
    await assert.rejects(actual.registerWorkspaceProject(root, root), (error) => error.code === 'E_CONFLICT')
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).nonce, 'actual-dead-contended-writer')
    rmSync(recovery)
    const child = 'const a=await import(process.argv[1]);try{await a.registerWorkspaceProject(process.argv[2],process.argv[3]);console.log(JSON.stringify({registered:true}))}catch(e){if(e.code!=="E_CONFLICT")throw e;console.log(JSON.stringify({registered:false}))}'
    const outcomes = await Promise.all(projects.map((project) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', child, pathToFileURL(join(temporary, 'metadata.mjs')).href, root, project.root], { windowsHide: true, timeout: 10000 })))
    const registered = outcomes.map((outcome) => JSON.parse(outcome.stdout).registered)
    assert.ok(registered.some(Boolean))
    const discovered = await actual.workspaceProjects(root)
    for (let i = 0; i < projects.length; i++) if (registered[i]) assert.ok(discovered.includes(projects[i].root))
    assert.equal(existsSync(lock), false); assert.equal(existsSync(recovery), false)
  })
  await check('actual native inventory blocks another nested project starting/draining/held owner despite ready metadata and absent prompt token', async () => {
    const nested = await make(join(root, 'packages', 'ordinary-unregistered-project'))
    for (const patch of [{ status: 'starting' }, { status: 'disconnected' }, ...['accepting', 'closing', 'disconnected', 'leaseHeld', 'cleanupRequired', 'backgroundWork', 'unfinishedTools', 'turnActive', 'settling', 'pendingPermission'].map((flag) => ({ status: 'ready', ownedFacts: { [flag]: true } }))]) {
      Object.assign(nested.ordinary, patch)
      let admitted = false
      await assert.rejects(actual.withManagedWorkflowAdmission(root, async () => { admitted = true }), (error) => error.code === 'E_CONFLICT')
      assert.equal(admitted, false)
      Object.assign(nested.ordinary, { status: 'ready', ownedFacts: {} })
    }
    // Existing idle peers do not claim execution. A held distinct linked worktree
    // also remains independent from this physical worktree's managed admission.
    other.ordinary.status = 'busy'
    let admitted = false; await actual.withManagedWorkflowAdmission(root, async () => { admitted = true })
    assert.equal(admitted, true); other.ordinary.status = 'ready'
    nested.ordinary.ownedFacts = { accepting: true }; nested.ordinary.cwd = join(root, 'missing-native-cwd')
    await assert.rejects(actual.withManagedWorkflowAdmission(root, async () => { throw Error('ambiguous owner must not pass') }), (error) => error.code === 'E_CONFLICT')
    nested.ordinary.cwd = nested.root; nested.ordinary.ownedFacts = {}
  })
  await check('new/resume/recover/config lifecycle cannot slip behind managed inventory check; other physical worktree remains usable', async () => {
    let resume, entered = false; const gate = new Promise((done) => { resume = done })
    const pending = actual.withManagedWorkflowAdmission(root, async () => { entered = true; await gate })
    await wait(() => entered, 'managed action after inventory')
    r.root = root; const count = r.lifecycle.length
    for (const [channel, args] of [[actual.ipcInvoke.acp.sessionNew, [{ agentId: 'owned-fixture' }]], [actual.ipcInvoke.acp.sessionResume, [h.ordinary.sessionId]], [actual.ipcInvoke.acp.sessionRecoverModel, [h.ordinary.sessionId, { modelId: 'fixture', expectedConnectionGeneration: h.ordinary.connectionGeneration }]], [actual.ipcInvoke.acp.sessionConfigure, [h.ordinary.sessionId, { kind: 'mode', id: 'fixture' }]]]) {
      assert.equal((await r.handlers.get(channel)({}, ...args)).code, 'E_CONFLICT')
    }
    assert.equal(r.lifecycle.length, count)
    r.root = other.root; assert.equal((await r.handlers.get(actual.ipcInvoke.acp.sessionNew)({}, { agentId: 'owned-fixture' })).ok, true)
    resume(); await pending
  })
  await check('inflight ordinary lifecycle holds admission yet lets quit reach native shutdown; end/cancel stay available', async () => {
    let resume; r.lifecycleGate = new Promise((done) => { resume = done })
    r.root = root; const before = r.lifecycle.length
    const pending = r.handlers.get(actual.ipcInvoke.acp.sessionResume)({}, h.ordinary.sessionId)
    await wait(() => r.lifecycle.length > before, 'ordinary lifecycle native entry')
    await assert.rejects(actual.withManagedWorkflowAdmission(root, async () => { throw Error('must not overtake lifecycle') }), (error) => error.code === 'E_CONFLICT')
    assert.equal((await r.handlers.get(actual.ipcInvoke.acp.sessionCancel)({}, h.ordinary.sessionId)).ok, true)
    actual.setWorkflowAdmissionClosed(true)
    let drained = false; const closing = actual.shutdownWorkflowApplications().then(() => { drained = true })
    await wait(() => drained, 'quit can reach native shutdown instead of waiting for native init')
    await closing; resume(); assert.equal((await pending).ok, true)
    r.lifecycleGate = null; actual.setWorkflowAdmissionClosed(false)
  })
  await check('quit closes final pre-write predicate and waits pending admission before disposing controllers', async () => {
    let resume; const promise = new Promise((done) => { resume = done }); r.preflight = { id: h.ordinary.sessionId, promise }
    const before = r.entered.length; const pending = invoke(h); await wait(() => r.entered.length > before, 'quit preflight entry')
    actual.setWorkflowAdmissionClosed(true)
    let drained = false; const closing = actual.shutdownWorkflowApplications().then(() => { drained = true })
    await new Promise((done) => setTimeout(done, 20)); assert.equal(drained, false)
    resume(); assert.equal((await pending).code, 'E_CONFLICT'); await closing
    r.preflight = null; actual.setWorkflowAdmissionClosed(false)
  })
  const report = { status: 'passed', scenarios: results.length, results, scope: 'Actual control SQLite/worker + host/admission/ACP IPC and real Git worktrees; native process/model boundary explicitly owned fixture', limits: ['No actual native model/vendor, OS restart, packaged UI or team/Jira proof'] }
  if (reportIndex >= 0) { const path = resolve(process.argv[reportIndex + 1]); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2) + '\n') }
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const control of controls) await control.close().catch(() => {})
  assert.equal(realpathSync.native(dirname(temporary)), realpathSync.native(tmpdir())); assert.ok(basename(temporary).startsWith('tpanel-admission-'))
  rmSync(temporary, { recursive: true, force: true }); delete globalThis.__ADMISSION_SMOKE__
}
