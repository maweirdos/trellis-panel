/** Actual application + worker SQLite + material + stage driver; native transport is an owned fixture. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-workflow-application-'))
const source = (path) => resolve(path).replace(/\\/g, '/')
const digest = (text) => createHash('sha256').update(text).digest('hex')
const asset = (id) => ({ assetId: id, version: 'v1', digest: digest(id) })
const checks = []; const opened = []
const check = async (name, fn) => { await fn(); checks.push({ name, status: 'passed' }) }
const reportPath = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null
let api
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, description) => {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await sleep(20) }
  throw new Error('Timed out: ' + description)
}
function fakeAcp(root, { permission = false, deferredCreate = false } = {}) {
  const sessions = new Map([['origin', { sessionId: 'origin', agentId: 'fixture', agentName: 'Owned fixture', taskDir: 'task-a', projectRoot: root, status: 'ready', startedAt: Date.now(), connectionGeneration: 'origin-generation' }]])
  const observers = new Set(); const history = []; const prompts = []
  let creates = 0; let seq = 0; let releaseCreate
  const gate = new Promise((resolve) => { releaseCreate = resolve })
  let permissionResolve
  const emit = (session, kind, payload) => {
    const event = { id: randomUUID(), ts: Date.now(), source: 'acp', kind, projectRoot: root, taskDir: session.taskDir, sessionId: session.sessionId, turnId: session.turnId, connectionGeneration: session.connectionGeneration, payload }
    history.push({ ...event, historySeq: ++seq })
    for (const observer of observers) observer.event?.(event)
  }
  const port = {
    create: async (_root, input) => {
      creates++
      if (deferredCreate) await gate
      const id = 'stage-' + creates
      sessions.set(id, { sessionId: id, agentId: input.agentId, agentName: 'Owned stage', taskDir: input.taskDir, projectRoot: root, status: 'ready', startedAt: Date.now(), connectionGeneration: 'stage-generation-' + creates })
      return { ok: true, sessionId: id }
    },
    get: async (_root, sessionId) => sessions.has(sessionId) ? { ok: true, session: structuredClone(sessions.get(sessionId)) } : { ok: false, code: 'E_NOT_FOUND', error: 'No owned fixture session' },
    list: () => ({ ok: true, sessions: [...sessions.values()].map((session) => ({ ...session, events: [] })) }),
    prompt: async (_root, sessionId, text, _options, prepared) => {
      const session = sessions.get(sessionId); assert.ok(session)
      prepared.assertActive()
      session.status = 'busy'; session.turnId = 'turn-' + (prompts.length + 1)
      prompts.push({ text, packet: prepared.materials.text, sessionId, turnId: session.turnId })
      const identity = { sessionId, turnId: session.turnId, connectionGeneration: session.connectionGeneration }
      prepared.onAdmitted?.(identity); prepared.onPromptWritten?.(identity)
      void (async () => {
        if (permission) {
          session.pendingPermissions = [{ requestId: 'exact-request', toolCall: { title: 'Write declared task document' }, options: [{ optionId: 'exact-allow-once', name: 'Allow once', kind: 'allow_once' }] }]
          emit(session, 'permission', { requestId: 'exact-request' })
          await new Promise((resolve) => { permissionResolve = resolve })
          session.pendingPermissions = []
        }
        await sleep(25)
        if (session.status === 'closed') return
        const task = join(root, '.trellis', 'tasks', session.taskDir)
        if (text.includes('STAGE_PRD')) writeFileSync(join(task, 'prd.md'), '# PRD\nACTUAL_PRD_OUTPUT\n')
        if (text.includes('STAGE_DESIGN')) {
          assert.ok(prepared.materials.text.includes('ACTUAL_PRD_OUTPUT'), 'next stage must receive captured preceding output')
          writeFileSync(join(task, 'design.md'), '# Design\nACTUAL_DESIGN_OUTPUT\n')
        }
        session.status = 'ready'
        emit(session, 'turn-done', { result: { status: 'completed', stopReason: 'end_turn' } })
      })().catch((error) => { session.error = error.message; session.status = 'error' })
      return { ok: true, turnId: session.turnId }
    },
    cancel: async () => ({ ok: true }), end: async (_root, id) => { const session = sessions.get(id); if (session) session.status = 'closed'; permissionResolve?.(); return { ok: true } },
    resume: async (_root, sessionId) => ({ ok: true, sessionId }),
    observe: (observer) => { observers.add(observer); return () => observers.delete(observer) },
    flushHistory: async () => {}, persistence: () => ({ state: 'saved', pendingCount: 0, committedThroughSeq: seq, committedThroughEventId: history.at(-1)?.id ?? null }),
    historyEvents: async () => ({ ok: true, events: history, historyPersistence: port.persistence() })
  }
  return { port, sessions, prompts, releaseCreate, allow: () => permissionResolve?.(), get creates() { return creates } }
}
async function harness(options = {}) {
  const root = join(temporary, 'root-' + randomUUID())
  const task = join(root, '.trellis', 'tasks', 'task-a')
  mkdirSync(task, { recursive: true })
  mkdirSync(join(root, '.trellis', 'flows'), { recursive: true })
  writeFileSync(join(task, 'task.json'), JSON.stringify({ id: 'task-a', status: 'planning' }))
  const flow = { version: 1, id: 'paired', name: 'Owned PRD and design', description: 'Isolated integration fixture', inputs: [], phases: [{ id: 'plan', name: 'Planning', trellisPhase: 'plan', steps: [
    { id: 'prd', name: 'Write PRD', kind: 'agent', instruction: 'STAGE_PRD Generate the declared requirement artifact.' },
    { id: 'design', name: 'Write design', kind: 'agent', instruction: 'STAGE_DESIGN Read the captured PRD and generate design.' }
  ] }] }
  if (options.tool) flow.phases[0].steps.push({ id: 'tool', name: 'Unsupported tool', kind: 'tool', tool: 'not-connected', args: {} })
  writeFileSync(join(root, '.trellis', 'flows', 'paired.flow.json'), JSON.stringify(flow))
  const fake = fakeAcp(root, options)
  const binding = { bindingId: 'fixture-binding', engineId: 'fixture', engineVersion: 'unknown', adapterVersion: 'fixture-1', configuration: asset('fixture-engine-config'), capabilities: { engineExecutableVersion: { status: 'unknown', reason: 'Owned fixture does not establish native executable version' } } }
  const policies = {
    prd: { output: { contract: asset('prd-output'), files: [{ relativePath: '.trellis/tasks/task-a/prd.md', kind: 'trellis-prd', required: true }], maxRepairTurns: 0 } },
    design: { output: { contract: asset('design-output'), files: [{ relativePath: '.trellis/tasks/task-a/design.md', kind: 'design', required: true }], maxRepairTurns: 0 } }
  }
  const config = { projectRoot: root, acp: fake.port, driverTimeouts: { startupTimeoutMs: 1000, turnTimeoutMs: 4000 }, resolveDefinition: (input) => api.readLocalApplicationDefinition({ projectRoot: root, flowId: input.flowId, executor: { binding, agentId: 'fixture' }, nodes: policies }) }
  const app = await api.WorkflowApplicationService.create(config); opened.push(app)
  const previewInput = { taskDir: 'task-a', flowId: 'paired', origin: { sessionId: 'origin', connectionGeneration: 'origin-generation' } }
  return { root, task, fake, app, config, previewInput, flow }
}
try {
  process.env.TPAP_SMOKE_DIR = temporary
  const worker = join(temporary, 'workflow-control-worker.cjs')
  await build({ entryPoints: [resolve('src/main/services/workflow-control/worker.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: worker, logLevel: 'silent' })
  process.env.TRELLIS_WORKFLOW_CONTROL_WORKER_FILE = worker
  const bundle = join(temporary, 'application.mjs')
  await build({ stdin: { contents: `export * from '${source('src/main/services/workflow-application/index.ts')}';`, loader: 'ts', resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm',
    alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, banner: { js: "import {createRequire as smokeRequire} from 'node:module';const require=smokeRequire(import.meta.url);" }, outfile: bundle, logLevel: 'silent' })
  api = await import(pathToFileURL(bundle).href)
  await check('Real worker/control/driver executes distinct PRD and design instructions with pinned boundary lineage', async () => {
    const h = await harness()
    const preview = await h.app.preview(h.previewInput)
    assert.equal(h.fake.prompts.length, 0, 'preview must not dispatch')
    const admission = await h.app.start({ taskDir: 'task-a', commandId: 'start-a', previewId: preview.previewId })
    assert.equal(admission.status, 'committed')
    const final = await until(async () => { const snapshot = await h.app.snapshot({ taskDir: 'task-a' }); return snapshot.snapshot?.run.state === 'verified' ? snapshot : null }, 'paired workflow completes')
    assert.equal(final.snapshot.run.run.runId, admission.run.runId)
    assert.equal(final.snapshot.run.run.revision, 2)
    assert.deepEqual(final.snapshot.run.predecessor, { runId: admission.run.runId, revision: 1 })
    assert.equal(final.nodes.length, 2); assert.ok(final.nodes.every((node) => node.state === 'verified' && node.historyCommitted))
    assert.equal(h.fake.prompts.length, 2); assert.ok(h.fake.prompts[0].text.includes('STAGE_PRD')); assert.ok(h.fake.prompts[1].text.includes('STAGE_DESIGN')); assert.ok(!h.fake.prompts[1].text.includes('STAGE_PRD'))
    assert.deepEqual(final.origin, h.previewInput.origin)
    assert.equal(final.graph.nodes[0].nodeId, preview.graph.nodes[0].nodeId)
    const output = await h.app.readArtifact({ taskDir: 'task-a', ref: final.nodes[0].outputRefs[0] })
    assert.ok(output.text.includes('ACTUAL_PRD_OUTPUT'))
    const before = await h.app.snapshot({ taskDir: 'task-a', run: admission.run })
    assert.equal(before.snapshot.run.state, 'verified'); assert.equal(before.nodes[1].state, 'planned', 'late current revision must not mutate old projection')
    assert.equal((await h.app.start({ taskDir: 'task-a', commandId: 'start-a', previewId: preview.previewId })).status, 'duplicate')
    await assert.rejects(h.app.start({ taskDir: 'task-a', commandId: 'start-a', previewId: 'foreign-preview' }), (e) => e.code === 'COMMAND_PAYLOAD_CONFLICT')
    await h.app.close()
    const reopened = await api.WorkflowApplicationService.create(h.config); opened.push(reopened)
    const restored = await reopened.snapshot({ taskDir: 'task-a' })
    assert.deepEqual(restored.origin, h.previewInput.origin); assert.ok(restored.nodes.every((n) => n.state === 'verified')); assert.equal(h.fake.prompts.length, 2, 'reopen cannot replay native actions')
    const identityFile = join(h.root, '.trellis', '.panel', 'runtime', 'workflow-local-identity.json')
    const pinned = readFileSync(identityFile, 'utf8')
    writeFileSync(join(h.root, '.trellis', '.panel', 'runtime', 'binding.json'), JSON.stringify({ schemaVersion: 1, installationId: 'later-observation', repositoryId: 'other-repository', workspaceId: 'other-workspace', canonicalRoot: h.root, boundAtMs: Date.now(), collectionEnabled: false }))
    assert.equal((await reopened.snapshot({ taskDir: 'task-a' })).scope.workspaceId, preview.scope.workspaceId)
    assert.equal(readFileSync(identityFile, 'utf8'), pinned)
    assert.equal(existsSync(join(h.root, '.trellis', '.panel', 'runtime', 'observations.sqlite')), false)
  })
  await check('Changed source and unsupported tool are rejected before native dispatch', async () => {
    const h = await harness()
    const preview = await h.app.preview(h.previewInput)
    writeFileSync(join(h.task, 'task.json'), JSON.stringify({ id: 'task-a', status: 'in_progress' }))
    await assert.rejects(h.app.start({ taskDir: 'task-a', commandId: 'changed-a', previewId: preview.previewId }), (e) => e.code === 'MATERIAL_CHANGED')
    assert.equal(h.fake.creates, 0)
    const unsupported = await harness({ tool: true })
    await assert.rejects(unsupported.app.preview(unsupported.previewInput), (e) => e.code === 'CAPABILITY_UNAVAILABLE')
    assert.equal(unsupported.fake.creates, 0)
  })
  await check('Explicit native round budgets and enabled completion effects reject at preview before native creation', async () => {
    for (const field of ['maxRounds', 'notify', 'saveNote', 'both-effects']) {
      const h = await harness()
      if (field === 'maxRounds') h.flow.phases[0].steps[0].maxRounds = 1
      else h.flow.hooks = { onComplete: { notify: field === 'notify' || field === 'both-effects', saveNote: field === 'saveNote' || field === 'both-effects' } }
      writeFileSync(join(h.root, '.trellis', 'flows', 'paired.flow.json'), JSON.stringify(h.flow))
      await assert.rejects(h.app.preview(h.previewInput), (error) => error.code === 'CAPABILITY_UNAVAILABLE')
      assert.equal(h.fake.creates, 0, `${field} cannot silently lose its declared semantics after native admission`)
      assert.equal((await h.app.snapshot({ taskDir: 'task-a' })).snapshot, null)
    }
  })
  await check('Disabled completion options remain an intentional no-op and do not disable output repair configuration', async () => {
    const h = await harness()
    h.flow.hooks = { onComplete: { notify: false, saveNote: false } }
    writeFileSync(join(h.root, '.trellis', 'flows', 'paired.flow.json'), JSON.stringify(h.flow))
    const preview = await h.app.preview(h.previewInput)
    assert.equal(h.fake.creates, 0)
    await h.app.start({ taskDir: 'task-a', commandId: 'disabled-completion-start', previewId: preview.previewId })
    await until(async () => (await h.app.snapshot({ taskDir: 'task-a' })).snapshot.run.state === 'verified', 'disabled completion options still permit actual preset execution')
    assert.equal(h.fake.prompts.length, 2)
  })
  await check('Rejected unsupported draft options do not stop or replace an already admitted healthy run', async () => {
    const h = await harness({ permission: true })
    const preview = await h.app.preview(h.previewInput)
    const admission = await h.app.start({ taskDir: 'task-a', commandId: 'unsupported-draft-old-run', previewId: preview.previewId })
    await until(async () => (await h.app.snapshot({ taskDir: 'task-a' })).stageSessions.some((session) => session.pendingPermissions?.length), 'original stage pending actual fixture permission')
    h.flow.phases[0].steps[0].maxRounds = 1
    writeFileSync(join(h.root, '.trellis', 'flows', 'paired.flow.json'), JSON.stringify(h.flow))
    await assert.rejects(h.app.preview(h.previewInput), (error) => error.code === 'CAPABILITY_UNAVAILABLE')
    const current = await h.app.snapshot({ taskDir: 'task-a' })
    assert.deepEqual(current.snapshot.run.run, admission.run)
    assert.equal(current.snapshot.run.state, 'running')
    assert.equal(current.stageSessions.find((session) => session.pendingPermissions?.length).pendingPermissions[0].requestId, 'exact-request')
    await until(async () => { h.fake.allow(); return (await h.app.snapshot({ taskDir: 'task-a' })).snapshot.run.state === 'verified' }, 'healthy old run completes after rejected draft')
    assert.equal(h.fake.prompts.length, 2)
  })
  await check('Pending permission remains the exact stage request while origin chat is unchanged; restart exposes recovery', async () => {
    const h = await harness({ permission: true })
    const preview = await h.app.preview(h.previewInput)
    const admission = await h.app.start({ taskDir: 'task-a', commandId: 'permission-a', previewId: preview.previewId })
    const running = await until(async () => { const snap = await h.app.snapshot({ taskDir: 'task-a' }); return snap.stageSessions.some((s) => s.pendingPermissions?.length) ? snap : null }, 'permission exposed in origin projection')
    assert.equal(running.origin.sessionId, 'origin')
    const pending = running.stageSessions.find((s) => s.pendingPermissions?.length)
    assert.notEqual(pending.sessionId, 'origin'); assert.equal(pending.pendingPermissions[0].requestId, 'exact-request'); assert.equal(pending.pendingPermissions[0].options[0].optionId, 'exact-allow-once')
    assert.equal(running.composer.target, 'managed')
    assert.equal(await h.app.isOriginManaged({ taskDir: 'task-a', ...h.previewInput.origin }), true)
    await assert.rejects(h.app.close(), (e) => e.code === 'OUTCOME_UNKNOWN')
    const reopened = await api.WorkflowApplicationService.create(h.config); opened.push(reopened)
    assert.equal((await reopened.snapshot({ taskDir: 'task-a' })).recoveryRequired, true)
    await assert.rejects(reopened.start({ taskDir: 'task-a', commandId: 'different-controller', previewId: 'not-owned' }), (e) => e.code === 'STALE_PREVIEW')
    const stop = await h.app.stop({ taskDir: 'task-a', commandId: 'stop-permission', run: admission.run })
    assert.equal(stop.status, 'stopped')
    await until(async () => (await h.app.snapshot({ taskDir: 'task-a' })).snapshot.run.state === 'stopped', 'durable stopped state')
    assert.equal(h.fake.prompts.length, 1, 'no next stage after stop')
  })
  await check('Task/source scopes reject foreign identity and duplicate task IDs without native launch', async () => {
    const h = await harness()
    await assert.rejects(h.app.preview({ ...h.previewInput, origin: { sessionId: 'origin', connectionGeneration: 'old-generation' } }), (e) => e.code === 'SCOPE_CHANGED')
    await assert.rejects(h.app.preview({ ...h.previewInput, taskDir: '../task-a' }))
    const projectOwner = await h.app.resolveMaterialOwner('.trellis/spec/shared/index.md')
    assert.equal(projectOwner.taskRef, null)
    const taskOwner = await h.app.resolveMaterialOwner('.trellis/tasks/task-a/prd.md')
    assert.equal(taskOwner.taskRef, 'task:task-a')
    const foreign = await h.app.materials.captureText({ owner: taskOwner, source: { kind: 'published', publicationId: 'not-a-run-input' }, kind: 'other', text: 'Private unrelated same-task snapshot' })
    await assert.rejects(h.app.readArtifact({ taskDir: 'task-a', ref: foreign.ref }), (e) => e.code === 'NOT_FOUND')
    mkdirSync(join(h.root, '.trellis', 'tasks', 'copy'), { recursive: true }); writeFileSync(join(h.root, '.trellis', 'tasks', 'copy', 'task.json'), JSON.stringify({ id: 'task-a' }))
    await assert.rejects(h.app.preview(h.previewInput), (e) => e.code === 'REVISION_CONFLICT')
    assert.equal(h.fake.creates, 0)
  })
  await check('Stop during unresolved native creation stays unconfirmed until actual late session shutdown', async () => {
    const h = await harness({ deferredCreate: true })
    const preview = await h.app.preview(h.previewInput)
    const admission = await h.app.start({ taskDir: 'task-a', commandId: 'deferred-a', previewId: preview.previewId })
    await until(async () => h.fake.creates === 1, 'native creation begins')
    const stop = await h.app.stop({ taskDir: 'task-a', commandId: 'stop-deferred', run: admission.run })
    assert.equal(stop.status, 'unconfirmed')
    assert.notEqual((await h.app.snapshot({ taskDir: 'task-a' })).snapshot.run.state, 'stopped')
    h.fake.releaseCreate()
    await until(async () => (await h.app.snapshot({ taskDir: 'task-a' })).snapshot.run.state === 'stopped', 'late native session canonical shutdown').catch(async (error) => {
      const snapshot = await h.app.snapshot({ taskDir: 'task-a' }); const events = await h.app.events({ taskDir: 'task-a', limit: 200 })
      console.error(JSON.stringify({ state: snapshot.snapshot.run.state, nodes: snapshot.nodes, events: events.items.map(({event}) => ({type:event.type,payload:event.payload})) }, null, 2)); throw error
    })
    assert.equal(h.fake.prompts.length, 0)
    assert.equal(h.fake.sessions.get('stage-1').status, 'closed')
  })
  await check('An edited invalid Flow draft and origin disconnect do not replace or abort the admitted definition', async () => {
    const h = await harness({ permission: true })
    const preview = await h.app.preview(h.previewInput)
    const admission = await h.app.start({ taskDir: 'task-a', commandId: 'pinned-draft-start', previewId: preview.previewId })
    await until(async () => (await h.app.snapshot({ taskDir: 'task-a' })).stageSessions.some((session) => session.pendingPermissions?.length), 'pinned first stage waits')
    writeFileSync(join(h.root, '.trellis', 'flows', 'paired.flow.json'), '{"version":999,"draft":"incomplete edit"}')
    h.fake.sessions.get('origin').status = 'disconnected'
    await assert.rejects(h.app.preview(h.previewInput), 'a fresh preview still validates current sources and origin')
    const final = await until(async () => {
      h.fake.allow()
      const snapshot = await h.app.snapshot({ taskDir: 'task-a' })
      if (snapshot.snapshot.run.state === 'outcome-unknown') throw Error('Accepted old definition was aborted by mutable draft/origin state')
      return snapshot.snapshot.run.state === 'verified' ? snapshot : null
    }, 'admitted definition continues across draft edit')
    assert.equal(final.snapshot.run.run.runId, admission.run.runId)
    assert.equal(final.snapshot.run.run.revision, 2)
    assert.equal(h.fake.prompts.length, 2)
    assert.ok(h.fake.prompts[1].text.includes('STAGE_DESIGN'))
    assert.equal(final.graph.nodes.length, 2)
  })
  await check('Persisted run failure cannot turn an unconfirmed stop retry into a shutdown confirmation', async () => {
    const h = await harness({ deferredCreate: true })
    const originalEnd = h.fake.port.end
    h.fake.port.end = async () => ({ ok: false, code: 'E_IO', error: 'owned shutdown not acknowledged' })
    const preview = await h.app.preview(h.previewInput)
    const admission = await h.app.start({ taskDir: 'task-a', commandId: 'stop-result-start', previewId: preview.previewId })
    await until(async () => h.fake.creates === 1, 'late creation starts')
    const input = { taskDir: 'task-a', commandId: 'stop-result-unknown', run: admission.run }
    assert.equal((await h.app.stop(input)).status, 'unconfirmed')
    h.fake.releaseCreate()
    await until(async () => (await h.app.snapshot({ taskDir: 'task-a' })).snapshot.run.state === 'outcome-unknown', 'actual missing shutdown acknowledgement')
    const operation = await h.app.control.getOperation(preview.scope, 'stop:stop-result-unknown')
    assert.equal(operation.operation.state, 'outcome-unknown')
    // Explicit authorized-control reconciliation fixture: the work failed, while
    // the stop operation still has no shutdown evidence. These facts may differ.
    const live = h.app.live.get(admission.run.runId)
    await h.app.updateState(live, 'failed', 'fixture.run-failed-without-stop-evidence', { reason: 'run failure is not a shutdown receipt' })
    assert.equal((await h.app.stop(input)).status, 'unconfirmed', 'terminal failure is not a confirmed stop acknowledgement')
    h.fake.port.end = originalEnd
    await originalEnd(h.root, 'stage-1')
  })
  await check('Terminal controller close drains its outstanding owner release before closing the writer', async () => {
    const h = await harness()
    const original = h.app.control.releaseWorkspace.bind(h.app.control)
    let entered = false; let release
    const gate = new Promise((done) => { release = done })
    h.app.control.releaseWorkspace = async (...args) => { entered = true; await gate; return original(...args) }
    const preview = await h.app.preview(h.previewInput)
    await h.app.start({ taskDir: 'task-a', commandId: 'close-drain-start', previewId: preview.previewId })
    await until(async () => entered, 'terminal owner release entered')
    let closed = false
    const closing = h.app.close().then(() => { closed = true })
    try {
      await sleep(30)
      assert.equal(closed, false, 'a verified head is not proof all controller persistence has drained')
    } finally { release(); await closing }
  })
  await check('A damaged admitted output retains its storage diagnostic instead of being reported as a foreign artifact', async () => {
    const h = await harness()
    const preview = await h.app.preview(h.previewInput)
    await h.app.start({ taskDir: 'task-a', commandId: 'damaged-output-start', previewId: preview.previewId })
    const snapshot = await until(async () => { const value = await h.app.snapshot({ taskDir: 'task-a' }); return value.snapshot.run.state === 'verified' ? value : null }, 'actual checked output')
    const ref = snapshot.nodes[0].outputRefs[0]
    const stored = await h.app.readArtifact({ taskDir: 'task-a', ref })
    writeFileSync(join(h.app.runtimeDir, 'workflow-materials', 'blobs', `${stored.bodyDigest}.blob`), 'damaged owned immutable bytes')
    await assert.rejects(h.app.readArtifact({ taskDir: 'task-a', ref }), (error) => error.code === 'STORE_CORRUPTED')
  })
  await check('Oversize context manifest is refused before reading its body', async () => {
    const h = await harness()
    const file = join(h.task, 'implement.jsonl')
    writeFileSync(file, 'x'.repeat(128 * 1024 + 1))
    const original = fs.readFile
    let reads = 0
    fs.readFile = async (...args) => { if (resolve(String(args[0])) === resolve(file)) reads++; return original(...args) }
    try {
      await assert.rejects(h.app.preview(h.previewInput), (error) => error.code === 'CAPACITY_EXCEEDED')
      assert.equal(reads, 0, 'an over-budget manifest must not allocate its full body first')
    } finally { fs.readFile = original }
    assert.equal(h.fake.creates, 0)
  })
  const report = { status: 'passed', nativeTransport: 'owned-fixture', actual: ['WorkflowApplicationService', 'WorkflowControlService worker', 'file SQLite', 'AcpxWorkflowDriver', 'WorkflowMaterialStore', 'local Flow source'], checks, limits: ['No actual native model, Electron UI, packaged app, Jira or team acceptance'], date: new Date().toISOString() }
  if (reportPath) { mkdirSync(resolve(reportPath, '..'), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n') }
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const app of opened.reverse()) { await app.requestShutdown().catch(() => {}); await app.close().catch(() => {}); await app.control.close().catch(() => {}) }
  rmSync(temporary, { recursive: true, force: true })
}
