/** Actual coordinator + file SQLite + stage driver; native transport is explicitly owned fixture. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { harness, agent, until, pause, createFixturePort } from './fixtures/workflow-revisions-harness.mjs'

const directory = mkdtempSync(join(tmpdir(), 'trellis-revisions-'))
const checks = []; const opened = []
const check = async (name, fn) => { await fn(); checks.push({ name, status: 'passed' }); console.log('PASS ' + name) }
const path = process.argv.includes('--report') ? resolve(process.argv[process.argv.indexOf('--report') + 1]) : null
let api; let readerApi
const own = async (options = {}) => { const value = await harness(api, directory, options); opened.push(value); return value }
try {
  const worker = join(directory, 'control-worker.cjs')
  await build({ entryPoints: [resolve('src/main/services/workflow-control/worker.ts')], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  process.env.TRELLIS_WORKFLOW_CONTROL_WORKER_FILE = worker; process.env.TPAP_SMOKE_DIR = directory
  const file = join(directory, 'application.mjs')
  await build({ entryPoints: [resolve('src/main/services/workflow-application/index.ts')], outfile: file, bundle: true, platform: 'node', format: 'esm', alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, banner: { js: "import {createRequire as fixtureRequire} from 'node:module';const require=fixtureRequire(import.meta.url);" }, logLevel: 'silent' })
  api = await import(pathToFileURL(file).href)
  const readerFile = join(directory, 'reader.mjs')
  await build({ entryPoints: [resolve('src/main/services/document-views.ts')], outfile: readerFile, bundle: true, platform: 'node', format: 'esm', alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, banner: { js: "import {createRequire as fixtureRequire} from 'node:module';const require=fixtureRequire(import.meta.url);" }, logLevel: 'silent' })
  readerApi = await import(pathToFileURL(readerFile).href)
  await check('invalid draft/unknown semantics cannot reserve or stop a healthy old native stage', async () => {
    const h = await own({ blocked: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old native prompt')
    const source = join(h.root, '.trellis/flows/revised.flow.json'); const original = readFileSync(source, 'utf8')
    writeFileSync(source, '{bad json')
    await assert.rejects(h.preview(admission.run)); assert.equal(h.fake.ends, 0)
    const variable = JSON.parse(original); variable.phases[0].steps[0].saveOutputAs = 'unimplemented_output_variable'; writeFileSync(source, JSON.stringify(variable))
    await assert.rejects(h.preview(admission.run), (error) => error.code === 'CAPABILITY_UNAVAILABLE'); assert.equal(h.fake.ends, 0)
    writeFileSync(source, original); const dto = await h.preview(admission.run)
    assert.equal(dto.state, 'saved'); assert.equal(dto.impact.automaticExecutionReuse, false); assert.equal(dto.after.nodes.length, 1)
    assert.ok(dto.impact.nodes.some((node) => node.change === 'removed')); assert.ok(dto.metadataRef.startsWith('wm-'))
    assert.equal(h.fake.ends, 0); assert.equal((await h.app.snapshot({ taskDir: 'task-a' })).snapshot.run.run.revision, 1)
    h.fake.release(); const final = await h.final(); assert.equal(final.snapshot.run.state, 'verified'); assert.deepEqual(h.fake.prompts.map((prompt) => prompt.step), ['old', 'obsolete'])
  })
  await check('accepted boundary revision suppresses old future dispatch, drains and starts exactly one successor with captured output', async () => {
    const h = await own({ blocked: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old native active')
    const dto = await h.preview(admission.run)
    const request = { taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'adopt-boundary' }
    const decisions = await Promise.all([h.app.acceptRevision(request), h.app.acceptRevision(request)])
    assert.ok(decisions.every((decision) => decision.state === 'waiting-boundary')); assert.equal(h.fake.ends, 0)
    await assert.rejects(h.app.acceptRevision({ ...request, commandId: 'competing-adoption' }), (error) => error.code === 'REVISION_CONFLICT')
    h.fake.release(); const final = await h.final(); assert.equal(final.snapshot.run.state, 'verified')
    assert.deepEqual(h.fake.prompts.map((prompt) => prompt.step), ['old', 'revised']); assert.ok(h.fake.prompts[1].packet.includes('ACTUAL_OUTPUT_old'))
    assert.ok(h.fake.prompts[1].instruction.includes(dto.reason)); assert.equal(h.fake.creates, 2); assert.ok(h.fake.ends >= 1)
    const status = await h.app.revisionStatus({ taskDir: 'task-a', commandId: request.commandId }); assert.equal(status.state, 'adopted'); assert.equal(status.successor.revision, 2)
    assert.equal((await h.app.acceptRevision(request)).state, 'adopted')
    await assert.rejects(h.app.acceptRevision({ ...request, previewId: 'different-preview' }), (error) => error.code === 'COMMAND_PAYLOAD_CONFLICT')
    const old = await h.app.snapshot({ taskDir: 'task-a', run: admission.run }); assert.equal(old.snapshot.run.state, 'stopped'); assert.equal(old.graph.nodes[0].nodeId, dto.before.nodes[0].nodeId)
    assert.notEqual(final.graph.nodes[0].nodeId, old.graph.nodes[0].nodeId)
  })
  await check('cancelling a waiting adoption releases the reservation and original preset flow continues', async () => {
    const h = await own({ blocked: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old native active')
    const dto = await h.preview(admission.run); await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'cancel-adoption' })
    assert.equal((await h.app.cancelRevision({ taskDir: 'task-a', commandId: 'cancel-adoption' })).state, 'cancelled')
    h.fake.release(); const final = await h.final(); assert.equal(final.snapshot.run.state, 'verified'); assert.deepEqual(h.fake.prompts.map((prompt) => prompt.step), ['old', 'obsolete'])
  })
  await check('immediate adoption waits for actual native shutdown before successor writes', async () => {
    const h = await own({ blocked: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old active')
    const dto = await h.preview(admission.run, 'now'); await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'immediate-adoption' })
    const final = await h.final(); assert.equal(final.snapshot.run.state, 'verified', JSON.stringify((await h.app.events({ taskDir: 'task-a', limit: 200 })).items.filter(({ event }) => event.type.includes('revision') || event.type === 'workflow.driver-result').map(({ event }) => ({ type: event.type, payload: event.payload })))); assert.deepEqual(h.fake.prompts.map((prompt) => prompt.step), ['old', 'revised']); assert.equal(h.fake.sessions.get('stage-1').status, 'closed')
    assert.equal((await h.app.revisionStatus({ taskDir: 'task-a', commandId: 'immediate-adoption' })).state, 'adopted')
  })
  await check('unconfirmed canonical shutdown blocks successor and keeps a recoverable accepted command', async () => {
    const h = await own({ blocked: true, endFails: true, turnTimeoutMs: 300 }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old active')
    const dto = await h.preview(admission.run, 'now'); await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'unknown-adoption' })
    const final = await h.final(); assert.equal(final.snapshot.run.state, 'outcome-unknown'); assert.equal(h.fake.prompts.length, 1)
    const status = await h.app.revisionStatus({ taskDir: 'task-a', commandId: 'unknown-adoption' }); assert.equal(status.state, 'recovery-required'); assert.equal(status.recoveryRequired, true)
  })
  await check('predefined artifact gates retry boundedly with actual provenance and no extra native gate prompt', async () => {
    const gate = { id: 'verify', name: 'Verify captured output', kind: 'gate', check: { stepId: 'draft', contains: 'PASS_MARKER' }, onFail: 'goto', gotoStepId: 'draft', maxRetries: 1 }
    const h = await own({ oldSteps: [agent('draft'), gate, agent('finish')], body: (step, attempt) => step === 'draft' ? attempt === 1 ? '# Draft\nNOT_YET\n' : '# Draft\nPASS_MARKER\n' : '# Finished\n' })
    await h.start(); const final = await h.final(); assert.equal(final.snapshot.run.state, 'verified'); assert.deepEqual(h.fake.prompts.map((prompt) => prompt.step), ['draft', 'draft', 'finish'])
    assert.ok(h.fake.prompts[1].instruction.includes('bounded retry 1/1')); assert.equal(final.nodes.find((node) => node.nodeId.endsWith(':verify'))?.sessionId ?? null, null)
    const page = await h.app.events({ taskDir: 'task-a', limit: 200 }); const gates = page.items.filter(({ event }) => event.type === 'workflow.gate-result')
    assert.equal(gates.length, 2); assert.deepEqual(gates.map(({ event }) => event.payload.pass), [false, true]); assert.equal(gates[0].event.payload.evaluator, 'platform-artifact-content-v1')
    assert.equal(gates[0].event.payload.nextRetry, 1)
    const metadata = final.snapshot.manifest.context.inputs.__trellisWorkflowApplication; assert.equal(metadata.gateRetries.verify, 1)
    await h.app.close()
    const reopened = await api.WorkflowApplicationService.create(h.config)
    try { assert.equal((await reopened.snapshot({ taskDir: 'task-a' })).snapshot.manifest.context.inputs.__trellisWorkflowApplication.gateRetries.verify, 1); assert.equal(h.fake.prompts.length, 3) }
    finally { await reopened.close() }
  })
  await check('gate exhaustion fails visibly and provider outcome unknown never enters its goto loop', async () => {
    const gate = { id: 'verify', name: 'Verify', kind: 'gate', check: { stepId: 'draft', contains: 'REQUIRED' }, onFail: 'goto', gotoStepId: 'draft', maxRetries: 1 }
    const h = await own({ oldSteps: [agent('draft'), gate], body: () => '# Always invalid gate content\n' }); await h.start(); assert.equal((await h.final()).snapshot.run.state, 'failed'); assert.equal(h.fake.prompts.length, 2)
    const uncertain = await own({ oldSteps: [agent('draft'), gate], providerFailure: true }); await uncertain.start(); assert.equal((await uncertain.final()).snapshot.run.state, 'outcome-unknown'); assert.equal(uncertain.fake.prompts.length, 1)
    assert.equal((await uncertain.app.events({ taskDir: 'task-a' })).items.some(({ event }) => event.type === 'workflow.gate-result'), false)
  })
  await check('gate continue records a failed check rather than pretending pass, and invalid gate expressions reject before dispatch', async () => {
    const gate = { id: 'verify', name: 'Nonblocking declared check', kind: 'gate', check: { stepId: 'draft', contains: 'MISSING' }, onFail: 'continue' }
    const h = await own({ oldSteps: [agent('draft'), gate, agent('finish')] }); await h.start(); const final = await h.final()
    assert.equal(final.snapshot.run.state, 'verified'); const observed = final.nodes.find((node) => node.nodeId.includes('verify')); assert.equal(observed.state, 'failed'); assert.equal(observed.sessionId, null)
    const event = (await h.app.events({ taskDir: 'task-a' })).items.find(({ event }) => event.type === 'workflow.gate-result'); assert.equal(event.event.payload.action, 'continue-after-failure')
    const invalid = await own({ oldSteps: [agent('draft'), { ...gate, check: { stepId: 'draft', contains: '{{unknown.expression}}' } }] })
    await assert.rejects(invalid.app.preview({ taskDir: 'task-a', flowId: 'old', origin: { sessionId: 'origin', connectionGeneration: 'origin-generation' } }), (error) => error.code === 'CAPABILITY_UNAVAILABLE'); assert.equal(invalid.fake.creates, 0)
  })
  await check('stop during in-flight native creation remains unconfirmed until the late session actually exits', async () => {
    const h = await own({ deferredCreate: true }); const admission = await h.start(); await until(() => h.fake.creates === 1, 'native create pending')
    const dto = await h.preview(admission.run, 'now'); await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'late-session-adoption' })
    await until(async () => (await h.app.revisionStatus({ taskDir: 'task-a', commandId: 'late-session-adoption' })).state === 'stop-unconfirmed', 'stop while native id missing')
    assert.equal(h.fake.prompts.length, 0); h.fake.releaseCreate()
    const final = await h.final(); assert.equal(final.snapshot.run.state, 'verified'); assert.deepEqual(h.fake.prompts.map((prompt) => prompt.step), ['revised']); assert.equal(h.fake.sessions.get('stage-1').status, 'closed')
    const operation = await h.app.control.getOperation(admission.scope, 'stop:revision-stop:late-session-adoption'); assert.equal(operation.operation.state, 'confirmed')
  })
  await check('ordinary task stop cancels the waiting structural successor and preserves exact stop intent', async () => {
    const h = await own({ blocked: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old stage active')
    const dto = await h.preview(admission.run); await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'stop-precedence-adoption' })
    const stop = await h.app.stop({ taskDir: 'task-a', run: admission.run, commandId: 'ordinary-stop' }); assert.equal(stop.status, 'stopped')
    assert.equal((await h.final()).snapshot.run.state, 'stopped'); assert.equal(h.fake.prompts.length, 1)
    assert.equal((await h.app.revisionStatus({ taskDir: 'task-a', commandId: 'stop-precedence-adoption' })).state, 'cancelled')
  })
  await check('cancelling after drain starts suppresses successor without silently restarting predecessor', async () => {
    const h = await own({ blocked: true, deferredEnd: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old active')
    const dto = await h.preview(admission.run); await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'cancel-during-drain' })
    h.fake.release(); await until(() => h.fake.ends === 1, 'canonical drain waiting')
    const cancelled = await h.app.cancelRevision({ taskDir: 'task-a', commandId: 'cancel-during-drain' }); assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.recoveryRequired, true)
    const reader = await api.WorkflowApplicationService.create(h.config)
    try {
      const persisted = await reader.revisionStatus({ taskDir: 'task-a', commandId: 'cancel-during-drain' })
      assert.equal(persisted.state, 'cancelled'); assert.equal(persisted.recoveryRequired, true, 'durable cancellation must not hide unresolved predecessor drain after reopening')
      assert.equal(h.fake.prompts.length, 1)
    } finally { await reader.close() }
    h.fake.releaseEnd(); assert.equal((await h.final()).snapshot.run.state, 'stopped'); assert.equal(h.fake.prompts.length, 1)
  })
  await check('late predecessor events remain readable but never replace successor graph or state', async () => {
    const h = await own({ blocked: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old active')
    const dto = await h.preview(admission.run); await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'late-old-event' }); h.fake.release(); const final = await h.final()
    const event = { contractVersion: 1, eventId: randomUUID(), source: 'engine', type: 'workflow.native-event', attribution: { kind: 'assigned', scope: admission.scope, run: admission.run, step: null, sessionId: 'stage-1', turnId: 'turn-1', historySeq: null }, occurredAt: Date.now(), receivedAt: Date.now(), epoch: 'late-owned-fixture', sequence: 1, payload: { status: 'failed', detail: 'late predecessor only' } }
    const canonical = (value) => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
    await h.app.control.append({ event, payloadDigest: createHash('sha256').update(JSON.stringify(canonical(event))).digest('hex') })
    const current = await h.app.snapshot({ taskDir: 'task-a' }); assert.equal(current.snapshot.run.state, 'verified'); assert.deepEqual(current.graph, final.graph)
    assert.ok((await h.app.events({ taskDir: 'task-a', run: admission.run })).items.some(({ event: value }) => value.eventId === event.eventId))
  })
  await check('actual child exit preserves reservation/side effect and reopen reports recovery without native replay', async () => {
    const root = join(directory, 'actual-child-project'); const marker = join(directory, 'child-exit.json')
    await promisify(execFile)(process.execPath, [resolve('scripts/smoke/fixtures/workflow-revisions-child.mjs'), root, file, marker], { env: process.env, windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024 })
    const accepted = JSON.parse(readFileSync(marker, 'utf8')); assert.ok(readFileSync(join(root, 'actual-child-side-effect.txt'), 'utf8').includes('before exit'))
    const fake = createFixturePort(root); const app = await api.WorkflowApplicationService.create({ projectRoot: root, acp: fake.port, resolveDefinition: async () => { throw Error('Recovery reads cannot re-resolve/dispatch an old native plan') } })
    try {
      const status = await app.revisionStatus({ taskDir: 'task-a', commandId: 'exit-reservation' }); assert.equal(status.state, 'recovery-required'); assert.equal(status.recoveryRequired, true)
      assert.equal((await app.snapshot({ taskDir: 'task-a' })).recoveryRequired, true)
      assert.equal((await app.acceptRevision({ taskDir: 'task-a', run: accepted.target, previewId: accepted.previewId, commandId: 'exit-reservation' })).state, 'recovery-required'); assert.equal(fake.creates, 0)
    } finally { await app.control.close(); await fake.teardown() }
  })
  await check('actual process exit after atomic adoption commit retains one pending startup and never duplicates native work', async () => {
    const root = join(directory, 'actual-commit-exit-project'); const marker = join(directory, 'child-commit-exit.json')
    await promisify(execFile)(process.execPath, [resolve('scripts/smoke/fixtures/workflow-revisions-child.mjs'), root, file, marker, 'commit'], { env: process.env, windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024 })
    const accepted = JSON.parse(readFileSync(marker, 'utf8')); const fake = createFixturePort(root)
    const app = await api.WorkflowApplicationService.create({ projectRoot: root, acp: fake.port, resolveDefinition: async () => { throw Error('No automatic source/native replay after process exit') } })
    try {
      const status = await app.revisionStatus({ taskDir: 'task-a', commandId: accepted.commandId }); assert.equal(status.state, 'recovery-required'); assert.equal(status.successor.revision, 2)
      const scope = (await app.snapshot({ taskDir: 'task-a' })).scope
      const operation = await app.control.getOperation(scope, `execute:${accepted.commandId}:successor`); assert.equal(operation.operation.state, 'pending'); assert.equal(operation.attempts, 0)
      const before = await app.snapshot({ taskDir: 'task-a', run: accepted.target }); assert.equal(before.snapshot.run.state, 'stopped')
      await app.acceptRevision({ taskDir: 'task-a', run: accepted.target, previewId: accepted.previewId, commandId: accepted.commandId }); assert.equal(fake.creates, 0)
    } finally { await app.control.close(); await fake.teardown() }
  })
  await check('lost adoption acknowledgement retains committed startup for reconciliation and never resumes predecessor writes', async () => {
    const h = await own({ blocked: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old active')
    const dto = await h.preview(admission.run); await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'lost-adoption-ack' })
    const commit = h.app.control.commitWithManifests.bind(h.app.control)
    h.app.control.commitWithManifests = async (request) => { const result = await commit(request); if (request.journal.command.commandId === 'lost-adoption-ack') throw Object.assign(Error('Owned lost acknowledgement after actual commit'), { code: 'ACKNOWLEDGEMENT_UNKNOWN' }); return result }
    h.fake.release()
    const status = await until(async () => { const value = await h.app.revisionStatus({ taskDir: 'task-a', commandId: 'lost-adoption-ack' }); return value.state === 'recovery-required' && value.successor ? value : null }, 'committed but not dispatched successor recovery')
    assert.equal(status.successor.revision, 2); assert.equal(h.fake.prompts.length, 1)
    const operation = await h.app.control.getOperation(admission.scope, 'execute:lost-adoption-ack:successor'); assert.equal(operation.operation.state, 'pending')
    assert.equal((await h.app.snapshot({ taskDir: 'task-a' })).recoveryRequired, true)
    h.app.control.commitWithManifests = commit
  })
  await check('execution fence failure after confirmed shutdown reports adoption failure with predecessor stopped', async () => {
    const h = await own({ blocked: true, deferredEnd: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old active')
    let drift = false; const original = h.config.resolveDefinition
    h.config.resolveDefinition = async (input) => { const source = await original(input); return input.flowId === 'revised' ? { ...source, assertExecutionCurrent() { if (drift) throw Object.assign(Error('Actual pinned execution configuration changed'), { code: 'MATERIAL_CHANGED' }) } } : source }
    const dto = await h.preview(admission.run); await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'drift-after-drain' })
    h.fake.release(); await until(() => h.fake.ends === 1, 'native shutdown in progress'); drift = true; h.fake.releaseEnd()
    assert.equal((await h.final()).snapshot.run.state, 'stopped'); assert.equal(h.fake.prompts.length, 1)
    const status = await h.app.revisionStatus({ taskDir: 'task-a', commandId: 'drift-after-drain' }); assert.equal(status.state, 'failed'); assert.ok(status.reason.includes('configuration changed'))
  })
  await check('stop between driver entry and durable native claim cancels intent without inventing a native process', async () => {
    const h = await own(); const get = h.app.control.getOperation.bind(h.app.control)
    let release; let held = false; let intercepted = false
    const wait = new Promise((done) => { release = done })
    h.app.control.getOperation = async (scope, id) => { const result = await get(scope, id); if (id === 'execute:start-old:1' && !intercepted) { intercepted = true; held = true; await wait } return result }
    try {
      const admission = await h.start(); await until(() => held, 'driver before atomic claim')
      const dto = await h.preview(admission.run, 'now'); await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'stop-before-native-claim' })
      await until(async () => (await h.app.revisionStatus({ taskDir: 'task-a', commandId: 'stop-before-native-claim' })).state === 'stopped', 'actual pending intent cancellation')
      assert.equal(h.fake.creates, 0); release(); h.app.control.getOperation = get
      assert.equal((await h.final()).snapshot.run.state, 'verified'); assert.deepEqual(h.fake.prompts.map((prompt) => prompt.step), ['revised'])
    } finally { release(); h.app.control.getOperation = get }
  })
  await check('externally archived task stays stoppable while new mutating revision admission is rejected', async () => {
    const h = await own({ blocked: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old stage active')
    const archive = join(h.root, '.trellis/tasks/archive/2026-10'); mkdirSync(archive, { recursive: true }); renameSync(h.task, join(archive, 'task-a'))
    await assert.rejects(h.preview(admission.run), (error) => error.code === 'SCOPE_CHANGED')
    assert.equal((await h.app.stop({ taskDir: 'task-a', run: admission.run, commandId: 'stop-after-archive' })).status, 'stopped')
    assert.equal((await h.final()).snapshot.run.state, 'stopped'); assert.equal(h.fake.prompts.length, 1)
  })
  await check('ordinary stop after native finalization keeps finalized node verified and remaining workflow stopped', async () => {
    const h = await own(); const append = h.app.control.append.bind(h.app.control)
    let release; let frozen = false; const boundary = new Promise((done) => { release = done })
    h.app.control.append = async (report) => { if (report.event.type === 'workflow.driver-result' && !frozen) { frozen = true; await boundary } return append(report) }
    try {
      const admission = await h.start(); await until(() => frozen, 'driver finalization frozen before controller result')
      const requested = await h.app.stop({ taskDir: 'task-a', run: admission.run, commandId: 'late-ordinary-stop' }); assert.equal(requested.status, 'unconfirmed')
      const before = await h.app.control.getOperation(admission.scope, 'stop:late-ordinary-stop'); assert.equal(before.operation.state, 'outcome-unknown')
      release(); const final = await h.final(); assert.equal(final.snapshot.run.state, 'stopped'); assert.equal(final.nodes.filter((node) => node.state === 'verified').length, 1)
      assert.equal(final.nodes[0].state, 'verified'); assert.equal(final.nodes[1].state, 'planned'); assert.equal(h.fake.prompts.length, 1)
      assert.equal((await h.app.stop({ taskDir: 'task-a', run: admission.run, commandId: 'late-ordinary-stop' })).status, 'stopped')
      const settled = await h.app.control.getOperation(admission.scope, 'stop:late-ordinary-stop'); assert.equal(settled.operation.state, 'confirmed')
    } finally { release(); h.app.control.append = append }
  })
  await check('adoption after native finalization drains finalized stage, preserves its verified artifact and starts revised successor', async () => {
    const h = await own(); const append = h.app.control.append.bind(h.app.control)
    let release; let frozen = false; const boundary = new Promise((done) => { release = done })
    h.app.control.append = async (report) => { if (report.event.type === 'workflow.driver-result' && !frozen) { frozen = true; await boundary } return append(report) }
    try {
      const admission = await h.start(); await until(() => frozen, 'driver finalization before adoption')
      const dto = await h.preview(admission.run, 'now'); await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'late-adoption-stop' })
      await until(async () => (await h.app.revisionStatus({ taskDir: 'task-a', commandId: 'late-adoption-stop' })).state === 'stop-unconfirmed', 'late driver stop rejected until settled output')
      release(); const final = await h.final(); assert.equal(final.snapshot.run.state, 'verified'); assert.deepEqual(h.fake.prompts.map((prompt) => prompt.step), ['old', 'revised'])
      const old = await h.app.snapshot({ taskDir: 'task-a', run: admission.run }); assert.equal(old.snapshot.run.state, 'stopped'); assert.equal(old.nodes[0].state, 'verified')
      assert.ok(h.fake.prompts[1].packet.includes('ACTUAL_OUTPUT_old')); assert.equal(h.fake.sessions.get('stage-1').status, 'closed')
      assert.equal((await h.app.control.getOperation(admission.scope, 'stop:revision-stop:late-adoption-stop')).operation.state, 'confirmed')
    } finally { release(); h.app.control.append = append }
  })
  await check('explicit successor start preserves input artifacts without claiming excluded new nodes executed', async () => {
    const h = await own({ blocked: true, newSteps: [agent('excluded'), agent('selected')] }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old active')
    const dto = await h.app.previewRevision({ taskDir: 'task-a', run: admission.run, flowId: 'revised', reason: 'Run only the explicitly selected successor work', boundary: 'after-current-stage', startStepId: 'selected' })
    assert.equal(dto.startStepId, 'selected'); assert.equal(dto.impact.nodes.find((node) => node.stepId === 'excluded').affected, false)
    await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'explicit-start' }); h.fake.release()
    const final = await h.final(); assert.deepEqual(h.fake.prompts.map((prompt) => prompt.step), ['old', 'selected']); assert.equal(final.nodes[0].state, 'not-selected'); assert.equal(final.nodes[0].attempts, 0)
    assert.ok(h.fake.prompts[1].packet.includes('ACTUAL_OUTPUT_old')); assert.equal(final.nodes[1].state, 'verified')
  })
  await check('already admitted exact-run Stop survives missing task metadata without stopping a replacement', async () => {
    const h = await own({ blocked: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old writer active')
    renameSync(h.task, join(h.root, 'removed-task'))
    await assert.rejects(h.preview(admission.run))
    const stop = await h.app.stop({ taskDir: 'task-a', run: admission.run, commandId: 'removed-task-stop' })
    assert.equal(stop.status, 'stopped'); assert.equal(h.fake.sessions.get('stage-1').status, 'closed')
    await until(async () => (await h.app.control.load(admission.scope, admission.run)).run.state === 'stopped', 'original stopped without task metadata')
    assert.equal(h.fake.prompts.length, 1)
    assert.equal((await h.app.stop({ taskDir: 'task-a', run: admission.run, commandId: 'removed-task-stop' })).status, 'stopped')
  })
  await check('retained exact adoption command stays queryable/cancellable after archive and same basename replacement', async () => {
    const h = await own({ blocked: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old writer active')
    const dto = await h.preview(admission.run)
    await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'ambiguous-path-adoption' })
    const archive = join(h.root, '.trellis/tasks/archive/2026-10'); mkdirSync(archive, { recursive: true }); renameSync(h.task, join(archive, 'task-a'))
    mkdirSync(h.task); writeFileSync(join(h.task, 'task.json'), JSON.stringify({ id: 'replacement-task' }))
    await assert.rejects(h.preview(admission.run), (error) => error.code === 'REVISION_CONFLICT')
    assert.equal((await h.app.revisionStatus({ taskDir: 'task-a', commandId: 'ambiguous-path-adoption' })).state, 'waiting-boundary')
    assert.equal((await h.app.cancelRevision({ taskDir: 'task-a', commandId: 'ambiguous-path-adoption' })).state, 'cancelled')
    await assert.rejects(h.app.stop({ taskDir: 'other-task', run: admission.run, commandId: 'wrong-task-stop' }))
    assert.equal(h.fake.ends, 0)
    assert.equal((await h.app.stop({ taskDir: 'task-a', run: admission.run, commandId: 'ambiguous-path-stop' })).status, 'stopped')
    await until(async () => (await h.app.control.load(admission.scope, admission.run)).run.state === 'stopped', 'original archived scope stopped')
    assert.equal((await h.app.control.getAlias(admission.scope.taskRef)).currentDir, '.trellis/tasks/task-a')
    assert.equal(JSON.parse(readFileSync(join(h.task, 'task.json'), 'utf8')).id, 'replacement-task')
  })
  await check('preview freezes main output policy objects rather than following later configuration-object mutation', async () => {
    const h = await own({ blocked: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old active')
    const dto = await h.preview(admission.run)
    h.policies.revised.output.files[0].relativePath = '.trellis/tasks/task-a/changed-after-consent.md'
    h.policies.revised.output.contract.version = createHash('sha256').update('different-contract').digest('hex')
    await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'pinned-output-policy' })
    h.fake.release(); const final = await h.final()
    assert.equal(final.snapshot.run.state, 'verified')
    assert.ok(h.fake.prompts[1].instruction.includes('.trellis/tasks/task-a/revised.md'))
    assert.equal(h.fake.prompts[1].instruction.includes('changed-after-consent.md'), false)
  })
  await check('expired consent and changed draft reject before reservation or stop; returned preview mutations grant nothing', async () => {
    const h = await own({ blocked: true, previewTtlMs: 1000 }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old active')
    const dto = await h.preview(admission.run)
    dto.boundary = 'now'; dto.reason = 'renderer changed reason'; dto.startStepId = 'other'; dto.impact.automaticExecutionReuse = true
    await pause(1100)
    await assert.rejects(h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'expired-adoption' }), (error) => error.code === 'STALE_PREVIEW')
    assert.equal(await h.app.control.getCommand(admission.scope, 'expired-adoption'), null); assert.equal(h.fake.ends, 0)
    const fresh = await h.preview(admission.run)
    writeFileSync(join(h.root, '.trellis/flows/revised.flow.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(h.root, '.trellis/flows/revised.flow.json'), 'utf8')), name: 'changed after preview' }))
    await assert.rejects(h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: fresh.previewId, commandId: 'changed-draft-adoption' }), (error) => error.code === 'MATERIAL_CHANGED')
    assert.equal(await h.app.control.getCommand(admission.scope, 'changed-draft-adoption'), null); assert.equal(h.fake.ends, 0)
    h.fake.release(); assert.equal((await h.final()).snapshot.run.state, 'verified')
  })
  await check('accepted consent survives presentation metadata loss and keeps immutable decision semantics', async () => {
    const h = await own({ blocked: true }); const admission = await h.start(); await until(() => h.fake.prompts.length, 'old active')
    const dto = await h.preview(admission.run); const expected = structuredClone(dto)
    dto.reason = 'renderer changed meaning before acceptance'; dto.boundary = 'now'; dto.fingerprint = '0'.repeat(64)
    await h.app.acceptRevision({ taskDir: 'task-a', run: admission.run, previewId: dto.previewId, commandId: 'consent-cache-loss' })
    rmSync(join(h.app.runtimeDir, 'workflow-materials/refs', `${dto.metadataRef}.json`))
    dto.reason = 'different meaning'; dto.boundary = 'now'; dto.fingerprint = '0'.repeat(64)
    const status = await h.app.revisionStatus({ taskDir: 'task-a', commandId: 'consent-cache-loss' })
    assert.deepEqual(status.preview, expected); assert.equal(status.state, 'waiting-boundary'); assert.equal(h.fake.ends, 0)
    h.fake.release(); assert.equal((await h.final()).snapshot.run.state, 'verified')
    assert.equal((await h.app.revisionStatus({ taskDir: 'task-a', commandId: 'consent-cache-loss' })).preview.reason, expected.reason)
  })
  await check('artifact gate evaluates contains, notContains and minLength against captured output, not later disk text', async () => {
    const gate = { id: 'verify', name: 'Actual captured text', kind: 'gate', check: { stepId: 'draft', contains: 'MARKER', notContains: 'FORBIDDEN', minLength: 12 }, onFail: 'abort' }
    const h = await own({ oldSteps: [agent('draft'), gate], body: () => '# MARKER captured output\n' }); const append = h.app.control.append.bind(h.app.control)
    h.app.control.append = async (report) => { const value = await append(report); if (report.event.type === 'workflow.driver-result') writeFileSync(join(h.task, 'draft.md'), 'FORBIDDEN'); return value }
    await h.start(); const final = await h.final(); assert.equal(final.snapshot.run.state, 'verified'); assert.equal(h.fake.prompts.length, 1)
    const result = (await h.app.events({ taskDir: 'task-a' })).items.find(({ event }) => event.type === 'workflow.gate-result').event.payload
    assert.equal(result.pass, true); assert.ok(result.materialRefs.every((ref) => ref.startsWith('wm-')))
    for (const [body, condition] of [['# MARKER FORBIDDEN\n', 'notContains'], ['MARKER', 'minLength']]) {
      const failed = await own({ oldSteps: [agent('draft'), gate], body: () => body }); await failed.start()
      assert.equal((await failed.final()).snapshot.run.state, 'failed', condition); assert.equal(failed.fake.prompts.length, 1)
    }
  })
  await check('path-free recovery on untouched workspace is empty and rejects renderer-supplied scope', async () => {
    const h = await own()
    const value = await h.app.inspectWorkspaceRecovery({})
    assert.equal(value.scope, null); assert.equal(value.ownership, null); assert.equal(value.projection, null); assert.equal(value.source.state, 'unknown')
    await assert.rejects(h.app.inspectWorkspaceRecovery({ run: { runId: 'unowned', revision: 1 } }), (error) => error.code === 'NOT_FOUND')
    await assert.rejects(h.app.inspectWorkspaceRecovery({ scope: { taskRef: 'renderer-grant' } }))
    assert.equal(h.fake.creates, 0); assert.equal(h.fake.ends, 0)
  })
  await check('actual reopened recovery retains exact graph/history/artifacts after task deletion and duplicate identity paths without changing ownership', async () => {
    const h = await own(); const admission = await h.start(); const completed = await h.final(); await h.app.close()
    const nativeCounts = { creates: h.fake.creates, ends: h.fake.ends }
    renameSync(h.task, join(h.root, 'removed-task'))
    const reader = await api.WorkflowApplicationService.create({ ...h.config, resolveDefinition: async () => { throw Error('Recovery must not resolve or execute a new definition') } })
    try {
      const identity = { projectId: admission.scope.projectId, repositoryId: admission.scope.repositoryId, workspaceId: admission.scope.workspaceId }
      const before = await reader.control.workspaceOwner(identity); const alias = await reader.control.getAlias(admission.scope.taskRef)
      const events = await reader.control.events({ scope: admission.scope, cursor: null, limit: 200 })
      const result = await reader.inspectWorkspaceRecovery({ run: completed.snapshot.run.run })
      assert.deepEqual(result.scope, admission.scope); assert.equal(result.source.state, 'missing'); assert.deepEqual(result.projection.graph, completed.graph)
      assert.deepEqual(result.projection.nodes, completed.nodes); assert.equal(result.projection.stageSessions.length, 0)
      assert.ok(result.projection.nodes.some((node) => node.sessionId && node.turnId && node.historyCommitted))
      const getAlias = reader.control.getAlias.bind(reader.control)
      reader.control.getAlias = async () => { throw Error('Owned alias-display failure') }
      try {
        const degraded = await reader.inspectWorkspaceRecovery({ run: completed.snapshot.run.run })
        assert.equal(degraded.source.state, 'unavailable'); assert.deepEqual(degraded.projection.nodes, completed.nodes)
      } finally { reader.control.getAlias = getAlias }
      const ref = result.projection.nodes.flatMap((node) => node.outputRefs)[0]
      const recovered = await reader.readRecoveryArtifact({ run: completed.snapshot.run.run, ref })
      assert.ok(recovered.text.includes('ACTUAL_OUTPUT_old'))
      const makeReader = () => new readerApi.DocumentViewService(() => ({ projectRoot: h.root, generation: 1 }), {
        storeForRoot: () => reader.materials, resolveOwner: () => { throw Error('Recovery material registration must not re-resolve a missing task path') }
      })
      const fixedReader = makeReader(); const fixed = await fixedReader.registerMaterial(h.root, recovered)
      assert.equal((await fixedReader.readFixed(h.root, fixed.token, { workspaceId: 'recovery-display' })).rawText, recovered.text)
      assert.equal(await fixedReader.taskRefForVersion(h.root, fixed.token), admission.scope.taskRef)
      const unadmitted = await reader.materials.captureText({ owner: admission.scope, source: { kind: 'external', instanceId: 'owned-test', objectId: 'not-admitted' }, kind: 'other', text: 'never an admitted run input' })
      await assert.rejects(reader.readRecoveryArtifact({ run: completed.snapshot.run.run, ref: unadmitted.ref }), (error) => error.code === 'SCOPE_CHANGED')
      for (const run of [{ runId: admission.run.runId, revision: 1000 }, { runId: 'different-run', revision: 1 }]) await assert.rejects(reader.inspectWorkspaceRecovery({ run }), (error) => error.code === 'NOT_FOUND')
      mkdirSync(h.task); writeFileSync(join(h.task, 'task.json'), JSON.stringify({ id: 'task-a' })); writeFileSync(join(h.task, 'old.md'), 'current file is NOT the admitted artifact')
      const duplicate = join(h.root, '.trellis/tasks/archive/2026-10/task-a'); mkdirSync(duplicate, { recursive: true }); writeFileSync(join(duplicate, 'task.json'), JSON.stringify({ id: 'task-a' }))
      const ambiguous = await reader.inspectWorkspaceRecovery({ run: completed.snapshot.run.run })
      assert.equal(ambiguous.source.state, 'ambiguous'); assert.equal(ambiguous.source.candidates.length, 2)
      assert.deepEqual(ambiguous.projection.nodes, completed.nodes)
      assert.ok((await reader.readRecoveryArtifact({ run: completed.snapshot.run.run, ref })).text.includes('ACTUAL_OUTPUT_old'))
      assert.equal((await makeReader().readFixed(h.root, fixed.token, { workspaceId: 'reopened-recovery-display' })).rawText, recovered.text)
      assert.deepEqual(await reader.control.workspaceOwner(identity), before); assert.deepEqual(await reader.control.getAlias(admission.scope.taskRef), alias)
      assert.deepEqual(await reader.control.events({ scope: admission.scope, cursor: null, limit: 200 }), events)
      assert.equal(h.fake.creates, nativeCounts.creates); assert.equal(h.fake.ends, nativeCounts.ends)
      const material = await reader.readRecoveryArtifact({ run: completed.snapshot.run.run, ref })
      rmSync(join(reader.runtimeDir, 'workflow-materials/blobs', `${material.bodyDigest}.blob`))
      await assert.rejects(reader.readRecoveryArtifact({ run: completed.snapshot.run.run, ref }), (error) => error.code === 'MATERIAL_UNAVAILABLE')
      await assert.rejects(fixedReader.readFixed(h.root, fixed.token, { workspaceId: 'recovery-display' }))
    } finally { await reader.close() }
  })
  await check('actual process-exit plus deleted source remains inspectable without release, stop proof or startup replay', async () => {
    const root = join(directory, 'recovery-child-project'); const marker = join(directory, 'recovery-child.json')
    await promisify(execFile)(process.execPath, [resolve('scripts/smoke/fixtures/workflow-revisions-child.mjs'), root, file, marker, 'commit'], { env: process.env, windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024 })
    const accepted = JSON.parse(readFileSync(marker, 'utf8')); renameSync(join(root, '.trellis/tasks/task-a'), join(root, 'removed-task'))
    const fake = createFixturePort(root); const reader = await api.WorkflowApplicationService.create({ projectRoot: root, acp: fake.port, resolveDefinition: async () => { throw Error('No native recovery dispatch') } })
    try {
      const before = await reader.control.workspaceOwner({ projectId: accepted.origin.projectId, repositoryId: accepted.origin.repositoryId, workspaceId: accepted.origin.workspaceId })
      const result = await reader.inspectWorkspaceRecovery({}); assert.equal(result.source.state, 'missing'); assert.equal(result.projection.snapshot.run.run.revision, 2)
      assert.equal(result.projection.recoveryRequired, true); assert.equal(result.ownership.state, before.state)
      const original = await reader.inspectWorkspaceRecovery({ run: accepted.target }); const ref = original.projection.nodes.flatMap((node) => node.outputRefs)[0]
      assert.ok((await reader.readRecoveryArtifact({ run: accepted.target, ref })).text.includes('ACTUAL_OUTPUT_old'))
      const operation = await reader.control.getOperation(accepted.origin, `execute:${accepted.commandId}:successor`)
      assert.equal(operation.operation.state, 'pending'); assert.equal(operation.attempts, 0)
      assert.deepEqual(await reader.control.workspaceOwner({ projectId: accepted.origin.projectId, repositoryId: accepted.origin.repositoryId, workspaceId: accepted.origin.workspaceId }), before)
      assert.equal(fake.creates, 0); assert.equal(fake.ends, 0)
    } finally { await reader.close(); await fake.teardown() }
  })
  await check('recovery rejects actual pinned project mismatch and never returns another owner scope', async () => {
    const h = await own(); await h.start(); await h.final(); await h.app.close()
    const nativeCounts = { creates: h.fake.creates, ends: h.fake.ends }
    const path = join(h.app.runtimeDir, 'workflow-local-identity.json'); const original = readFileSync(path, 'utf8')
    writeFileSync(path, JSON.stringify({ ...JSON.parse(original), projectId: 'different-pinned-project' }))
    let reader
    try {
      reader = await api.WorkflowApplicationService.create(h.config)
      await assert.rejects(reader.inspectWorkspaceRecovery({}), (error) => error.code === 'SCOPE_CHANGED')
      assert.equal(h.fake.creates, nativeCounts.creates); assert.equal(h.fake.ends, nativeCounts.ends)
    } finally { await reader?.close(); writeFileSync(path, original) }
  })
  const report = { status: 'passed', actual: ['application', 'worker SQLite', 'stage driver', 'immutable material store'], nativeTransport: 'owned-fixture', scenarios: checks.length, checks, limits: ['No vendor, rendered adoption UI, actual parallel drain, packaged application or team/Jira acceptance'] }
  if (path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2) + '\n') }
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const h of opened) await h.cleanup().catch(() => {})
  assert.equal(dirname(directory), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-revisions-')); rmSync(directory, { recursive: true, force: true })
}
