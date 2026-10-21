/** Real SQLite/process/worker acceptance for R1-01; no engine/Jira action is performed. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { scope, digest, event, command, startInput, adoptionInput } from './fixtures/workflow-control-data.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-workflow-control-'))
const results = []; const active = new Set(); const children = new Set()
const entry = join(temporary, 'entry.ts'); const bundle = join(temporary, 'control.mjs'); const worker = join(temporary, 'worker.cjs')
const source = (file) => resolve(file).replace(/\\/g, '/')
const fixture = resolve('scripts/smoke/fixtures/workflow-control-peer.mjs')
writeFileSync(entry, `export * from '${source('src/main/services/workflow-control/index.ts')}';\nexport * from '${source('src/shared/workflow/index.ts')}';\nexport { LocalControlStore, LOCAL_CONTROL_MAIN_BUSY_TIMEOUT_MS } from '${source('src/main/services/local-task/control-store.ts')}';`)
await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' })
await build({ entryPoints: ['src/main/services/workflow-control/worker.ts'], outfile: worker, bundle: true, format: 'cjs', platform: 'node', target: 'node22', logLevel: 'silent' })
const api = await import(pathToFileURL(bundle).href)
let index = 0
const directory = () => { const path = join(temporary, 'case-' + ++index); mkdirSync(path); return path }
const coreAt = (path, options) => { const core = new api.WorkflowControlCore(path, options); core.open(); active.add(core); return core }
const leaseAt = (core, ownerId = 'owner-a') => { const claimed = core.claimWorkspace({ scope, ownerId, ttlMs: 30_000 }); assert.notEqual(claimed.status, 'owner-conflict'); return claimed.lease.owner }
async function check(name, work) { const start = performance.now(); await work(); results.push({ name, status: 'passed', elapsedMs: Math.round(performance.now() - start) }); console.log('PASS ' + name) }
function child(mode, path, argument = '') {
  const processHandle = fork(fixture, [mode, bundle, path, argument], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  children.add(processHandle); let stderr = ''; const messages = []
  processHandle.stderr.on('data', (data) => { stderr += data })
  processHandle.on('message', (message) => messages.push(message))
  const done = new Promise((resolveDone, reject) => {
    processHandle.once('error', reject)
    processHandle.once('exit', (code, signal) => { children.delete(processHandle); resolveDone({ code, signal, stderr, messages }) })
  })
  return { handle: processHandle, done, messages }
}
async function waitFor(predicate, timeout = 8_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Bounded fixture wait timed out'); await new Promise((resolveWait) => setTimeout(resolveWait, 5)) }
}

try {
  await check('workspace read: no invented task, no renewal/event write, expired living owner and project mismatch remain fenced', async () => {
    let now = 100
    const dir = directory(); const core = coreAt(dir, { now: () => now })
    const identity = { projectId: scope.projectId, repositoryId: scope.repositoryId, workspaceId: scope.workspaceId }
    assert.equal(core.workspaceOwner(identity), null)
    const owner = leaseAt(core)
    const before = core.workspaceOwner(identity)
    assert.deepEqual(before.scope, scope)
    assert.deepEqual(before.owner, owner)
    now = 100_000
    const after = core.workspaceOwner(identity)
    assert.equal(after.state, 'active')
    assert.equal(after.leaseUntil, before.leaseUntil, 'readonly lookup cannot renew an expired owner')
    assert.deepEqual(after.owner, before.owner)
    assert.equal(core.events({ scope, cursor: null, limit: 10 }).items.length, 0)
    assert.equal(core.workspaceOwner({ ...identity, workspaceId: 'another-workspace' }), null)
    assert.throws(() => core.workspaceOwner({ ...identity, projectId: 'foreign-project' }), (error) => error.code === 'SCOPE_CHANGED')
    assert.throws(() => core.workspaceOwner({ ...identity, taskRef: 'invented' }))
  })
  await check('workspace read: actual worker retains released and uncertain owner scope without claiming a new owner', async () => {
    const service = new api.WorkflowControlService(directory(), { workerFile: worker }); active.add(service)
    const identity = { projectId: scope.projectId, repositoryId: scope.repositoryId, workspaceId: scope.workspaceId }
    assert.equal(await service.workspaceOwner(identity), null)
    const owned = await service.claimWorkspace(scope)
    assert.deepEqual((await service.workspaceOwner(identity)).scope, scope)
    await service.releaseWorkspace(scope, owned.lease.owner)
    assert.equal((await service.workspaceOwner(identity)).state, 'released')
    const again = await service.claimWorkspace(scope)
    await service.commitWithManifests(startInput(api, again.lease.owner))
    await service.claimOperation({ scope, owner: again.lease.owner, operationId: 'operation-a' })
    await service.settleOperation({ scope, owner: again.lease.owner, operationId: 'operation-a', state: 'outcome-unknown', result: null, evidenceRefs: ['actual-missing-ack-fixture'] })
    const uncertain = await service.workspaceOwner(identity)
    assert.equal(uncertain.recoveryRequired, true)
    assert.equal(uncertain.state, 'active')
    assert.deepEqual(uncertain.owner, again.lease.owner)
  })
  await check('AC01/04: additive migration preserves real legacy aliases, source links and local operations', async () => {
    const dir = directory(); const legacy = new api.LocalControlStore(dir); legacy.open(); active.add(legacy)
    legacy.upsertAlias('task:legacy', 'legacy', '.trellis/tasks/legacy')
    legacy.insertOperation('legacy-operation', 'workspace-a', 'registered', { operationKey: { workspaceId: 'workspace-a', instanceId: 'jira', issueIdentifier: '100', ordinal: 1 } })
    legacy.insertSourceLink({ workspaceId: 'workspace-a', taskRef: 'task:legacy', sourceKind: 'jira', sourceKey: 'issue-100', payload: { remote: true } })
    const core = coreAt(dir); assert.equal(core.health().journalMode, 'delete'); assert.equal(core.health().synchronous, 2)
    assert.equal(core.getAlias('task:legacy').currentDir, '.trellis/tasks/legacy')
    assert.equal(legacy.getOperation('legacy-operation').stage, 'registered')
    core.upsertAlias('task:legacy', 'legacy', '.trellis/tasks/archive/2026-10/legacy')
    assert.equal(legacy.getAlias('task:legacy').currentDir, '.trellis/tasks/archive/2026-10/legacy')
    assert.throws(() => core.upsertAlias('task:other', 'legacy', '.trellis/tasks/legacy'))
    assert.equal(existsSync(join(dir, 'observations.sqlite')), false)
    assert.equal(existsSync(join(dir, 'history.sqlite')), false)
  })
  await check('AC01: command/run/manifest/events/outbox and sync intents commit together and reopen', async () => {
    const dir = directory(); const core = coreAt(dir); const owner = leaseAt(core)
    const input = startInput(api, owner); const accepted = await core.commitWithManifests(input)
    assert.equal(accepted.status, 'committed'); assert.ok(accepted.cursor.sequence > 0)
    assert.equal((await core.load(scope, input.journal.runChanges[0].run)).manifest.inputFingerprint, input.manifests[0].inputFingerprint)
    assert.equal(core.getOperation(scope, 'operation-a').operation.state, 'pending')
    assert.ok(core.syncPage(scope).length >= 3)
    core.close(); const reopened = coreAt(dir)
    assert.equal((await reopened.head(scope)).run.run.runId, 'run-a')
    assert.equal(reopened.getCommand(scope, 'command-a').status, 'committed')
  })
  await check('AC01/02: duplicate commands are idempotent; semantic changes conflict without overwriting', async () => {
    const core = coreAt(directory()); const owner = leaseAt(core); const input = startInput(api, owner)
    const first = await core.commitWithManifests(input); input.journal.command.requestedAt = 500
    const duplicate = await core.commitWithManifests(input)
    assert.equal(duplicate.status, 'duplicate'); assert.deepEqual(duplicate.cursor, first.cursor)
    input.journal.command.payload = { changed: true }; input.journal.command.payloadDigest = digest(api.canonicalWorkflowJson(input.journal.command.payload))
    assert.equal((await core.commitWithManifests(input)).status, 'payload-conflict')
    assert.equal(core.getCommand(scope, 'command-a').command.payload.purpose, 'control fixture')
  })
  await check('AC02: a reused command cannot silently substitute a different manifest or operation intent', async () => {
    const core = coreAt(directory()); const owner = leaseAt(core); const input = startInput(api, owner); await core.commitWithManifests(input)
    const changed = structuredClone(input); changed.manifests[0].inputFingerprint = digest('changed effective input')
    assert.equal((await core.commitWithManifests(changed)).status, 'payload-conflict')
    const otherOperation = structuredClone(input); otherOperation.journal.outbox[0].operationId = 'other-operation'
    assert.equal((await core.commitWithManifests(otherOperation)).status, 'payload-conflict')
    const transportChange = structuredClone(input); transportChange.manifests[0].recordedAt = 999; transportChange.journal.events[0].receivedAt = 999; transportChange.journal.runChanges[0].createdAt = 999
    assert.equal((await core.commitWithManifests(transportChange)).status, 'duplicate')
    assert.equal((await core.head(scope)).manifest.inputFingerprint, input.manifests[0].inputFingerprint)
  })
  await check('AC01: failed validation rolls back every table in the same actual SQLite transaction', async () => {
    const core = coreAt(directory()); const owner = leaseAt(core); const input = startInput(api, owner)
    input.manifests[0].definition.revision = 9
    await assert.rejects(core.commitWithManifests(input))
    assert.equal(await core.head(scope), null); assert.equal(core.getCommand(scope, 'command-a'), null)
    assert.equal(core.events({ scope }).items.length, 0); assert.equal(core.getOperation(scope, 'operation-a'), null)
  })
  await check('AC01: later run-state updates preserve the original creation timestamp', async () => {
    const core = coreAt(directory()); const owner = leaseAt(core); const initial = startInput(api, owner, { noOperation: true })
    await core.commitWithManifests(initial)
    const original = initial.journal.runChanges[0]
    const update = { command: command(api, 'status-update', 'request-stop'), owner, expectedCurrent: original.run,
      runChanges: [{ ...original, state: 'stopped', createdAt: 999 }], events: [], outbox: [] }
    assert.equal((await core.commit(update)).status, 'committed')
    assert.equal((await core.head(scope)).run.createdAt, original.createdAt)
    assert.equal((await core.head(scope)).run.state, 'stopped')
    update.runChanges[0].createdAt = 1_000
    assert.equal((await core.commit(update)).status, 'duplicate')
    assert.equal((await core.head(scope)).run.createdAt, original.createdAt)
  })
  for (const stage of ['before-commit', 'after-commit']) await check(`AC01: process.exit ${stage} leaves a complete old or new transaction`, async () => {
    const dir = directory(); const run = await child('crash', dir, stage).done
    assert.equal(run.code, stage === 'before-commit' ? 76 : 77, run.stderr)
    const core = coreAt(dir); const record = core.getCommand(scope, 'command-a')
    assert.equal(record !== null, stage === 'after-commit')
    assert.equal((await core.head(scope)) !== null, stage === 'after-commit')
    assert.equal(core.getOperation(scope, 'operation-a') !== null, stage === 'after-commit')
    assert.equal(core.events({ scope }).items.length > 0, stage === 'after-commit')
  })
  await check('AC02: two actual processes racing startup produce one owner/commit and a visible conflict', async () => {
    const dir = directory(); coreAt(dir).close(); const barrier = join(dir, 'go')
    const a = child('race', dir, 'owner-a|start|' + barrier); const b = child('race', dir, 'owner-b|start|' + barrier)
    await waitFor(() => a.messages.some((m) => m.kind === 'ready') && b.messages.some((m) => m.kind === 'ready'))
    writeFileSync(barrier, 'go'); const done = await Promise.all([a.done, b.done]); done.forEach((result) => assert.equal(result.code, 0, result.stderr))
    const states = done.map((result) => result.messages.find((m) => m.kind === 'result').result.status).sort()
    assert.deepEqual(states, ['committed', 'owner-conflict'])
    const core = coreAt(dir); assert.equal(core.getCommand(scope, 'command-a').status, 'committed')
    assert.equal(core.getOperation(scope, 'operation-a').attempts, 0)
  })
  await check('AC02: revision reservation and CAS allow one successor, including competing connections', async () => {
    const dir = directory(); const first = coreAt(dir); const owner = leaseAt(first)
    await first.commitWithManifests(startInput(api, owner)); const second = coreAt(dir)
    const a = adoptionInput(api, owner, 'adopt-a'); const b = adoptionInput(api, owner, 'adopt-b')
    const result = await Promise.all([first.commitWithManifests(a), second.commitWithManifests(b)])
    assert.deepEqual(result.map((r) => r.status).sort(), ['committed', 'revision-conflict'])
    assert.equal((await first.head(scope)).run.run.runId, 'adopt-a-run')
    assert.equal((await first.load(scope, { runId: 'run-a', revision: 1 })).run.run.revision, 1)
  })
  await check('AC02: two processes competing for an adopted revision cannot create two successors', async () => {
    const dir = directory(); const core = coreAt(dir); const owner = leaseAt(core)
    await core.commitWithManifests(startInput(api, owner, { noOperation: true })); core.releaseWorkspace(scope, owner); core.close()
    const barrier = join(dir, 'go'); const a = child('race', dir, 'adopt-a|adopt|' + barrier); const b = child('race', dir, 'adopt-b|adopt|' + barrier)
    await waitFor(() => a.messages.some((m) => m.kind === 'ready') && b.messages.some((m) => m.kind === 'ready'))
    writeFileSync(barrier, 'go'); const results = await Promise.all([a.done, b.done]); results.forEach((r) => assert.equal(r.code, 0, r.stderr))
    assert.deepEqual(results.map((r) => r.messages.find((m) => m.kind === 'result').result.status).sort(), ['committed', 'owner-conflict'])
    assert.equal((await coreAt(dir).head(scope)).run.run.revision, 2)
  })
  await check('AC02: cancelled boundary reservations preserve history, release the slot and cannot revive', async () => {
    const core = coreAt(directory()); const owner = leaseAt(core); await core.commitWithManifests(startInput(api, owner))
    const input = adoptionInput(api, owner, 'reserved-a')
    assert.equal((await core.reserveCommand(input.journal.command, owner)).status, 'committed')
    assert.equal(core.getCommand(scope, 'reserved-a').status, 'reserved')
    assert.equal((await core.commitWithManifests(adoptionInput(api, owner, 'competing'))).status, 'revision-conflict')
    assert.equal(core.cancelReservedCommand(scope, 'reserved-a', owner, ['actual-user-cancel']).status, 'committed')
    assert.equal(core.getCommand(scope, 'reserved-a').status, 'cancelled')
    assert.equal(core.cancelReservedCommand(scope, 'reserved-a', owner, ['actual-user-cancel']).status, 'duplicate')
    await assert.rejects(core.commitWithManifests(input), (error) => error.code === 'COMMAND_CANCELLED')
    assert.equal((await core.commitWithManifests(adoptionInput(api, owner, 'replacement'))).status, 'committed')
  })
  await check('AC02: an adoption cannot falsely finish without a successor', async () => {
    const core = coreAt(directory()); const owner = leaseAt(core); const initial = startInput(api, owner); await core.commitWithManifests(initial)
    const input = adoptionInput(api, owner); input.journal.runChanges = initial.journal.runChanges; input.journal.events = []; input.journal.outbox = []; input.manifests = []
    await assert.rejects(core.commitWithManifests(input), (error) => error.code === 'INVALID_ADOPTION')
    assert.equal(core.getCommand(scope, 'adopt-a'), null); assert.equal((await core.head(scope)).run.run.revision, 1)
  })
  await check('AC02/03: expired but living owners cannot be stolen; stale fencing is rejected', async () => {
    let now = 1_000; const core = coreAt(directory(), { now: () => now }); const owner = leaseAt(core)
    now += 40_000
    assert.equal(core.claimWorkspace({ scope, ownerId: 'other-owner', ttlMs: 30_000 }).status, 'owner-conflict')
    assert.throws(() => core.recoverProcessOwner(scope, owner), (error) => error.code === 'OWNER_STILL_ALIVE')
    const renewed = core.renewWorkspace({ scope, ownerId: owner.ownerId, ttlMs: 30_000 }, owner)
    assert.equal(renewed.owner.fencingToken, owner.fencingToken)
    await assert.rejects(core.commitWithManifests(startInput(api, { ...owner, fencingToken: owner.fencingToken + 1 })), (error) => error.code === 'OWNER_CONFLICT')
  })
  await check('AC03: side effect before process death becomes unknown and is never blindly redispatched', async () => {
    const dir = directory(); const exited = await child('side-effect', dir).done; assert.equal(exited.code, 78, exited.stderr)
    const core = coreAt(dir); const operation = core.getOperation(scope, 'operation-a'); assert.equal(operation.operation.state, 'dispatched')
    core.recoverProcessOwner(scope, { ownerId: operation.operation.ownerId, fencingToken: operation.operation.fencingToken })
    assert.equal(core.getOperation(scope, 'operation-a').operation.state, 'outcome-unknown')
    const attemptState = () => {
      const db = new DatabaseSync(join(dir, 'control.sqlite'))
      try { return db.prepare('SELECT state,resultJson FROM workflow_dispatch_attempts WHERE scopeKey=? AND operationId=? AND attempt=1').get(api.workflowScopeIdentity(scope), 'operation-a') }
      finally { db.close() }
    }
    assert.equal(attemptState().state, 'outcome-unknown')
    const claimed = core.claimWorkspace({ scope, ownerId: 'recovering-owner', ttlMs: 30_000 }); assert.equal(claimed.lease.recoveryRequired, true)
    assert.throws(() => core.claimOperation({ scope, owner: claimed.lease.owner, operationId: 'operation-a' }), (error) => error.code === 'OUTCOME_UNKNOWN')
    assert.equal(core.claimWorkspace({ scope: { ...scope, taskRef: 'task:unrelated' }, ownerId: 'other-task', ttlMs: 30_000 }).status, 'owner-conflict')
    const confirmed = core.reconcileOperation({ scope, owner: claimed.lease.owner, operationId: 'operation-a', status: 'confirmed', result: { actualFile: 'performed-once' }, evidenceRefs: ['actual-side-effect-file'] })
    assert.equal(confirmed.operation.state, 'confirmed'); assert.equal(confirmed.attempts, 1)
    assert.equal(attemptState().state, 'confirmed')
    assert.deepEqual(JSON.parse(attemptState().resultJson), { actualFile: 'performed-once' })
    assert.throws(() => core.claimOperation({ scope, owner: claimed.lease.owner, operationId: 'operation-a' }))
    assert.equal(readFileSync(join(dir, 'actual-side-effect.txt'), 'utf8'), 'performed-once')
  })
  await check('AC03: dispatch is persisted before action; wrong owner and second claim fail', async () => {
    const core = coreAt(directory()); const owner = leaseAt(core); await core.commitWithManifests(startInput(api, owner))
    assert.equal(core.claimOperation({ scope, owner, operationId: 'operation-a' }).operation.state, 'dispatched')
    assert.throws(() => core.claimOperation({ scope, owner, operationId: 'operation-a' }))
    assert.throws(() => core.settleOperation({ scope, owner: { ...owner, fencingToken: 999 }, operationId: 'operation-a', state: 'confirmed', result: {}, evidenceRefs: ['invalid'] }))
    assert.equal(core.settleOperation({ scope, owner, operationId: 'operation-a', state: 'confirmed', result: { delivered: true }, evidenceRefs: ['actual-ack'] }).operation.state, 'confirmed')
  })
  await check('AC02/03: superseded execution is refused while the exact current revision can dispatch', async () => {
    const core = coreAt(directory()); const owner = leaseAt(core); const initial = startInput(api, owner)
    await core.commitWithManifests(initial); await core.commitWithManifests(adoptionInput(api, owner))
    assert.throws(() => core.claimOperation({ scope, owner, operationId: 'operation-a' }), (error) => error.code === 'REVISION_CONFLICT')
    assert.equal(core.getOperation(scope, 'operation-a').attempts, 0)
    assert.equal(core.getOperation(scope, 'operation-a').operation.state, 'pending')
    assert.equal(core.claimOperation({ scope, owner, operationId: 'adopt-a-operation' }).operation.state, 'dispatched')
    assert.equal(Object.hasOwn(core.getOperation(scope, 'operation-a').operation, 'purpose'), false)
  })
  await check('AC03: step execution refuses stopping and terminal heads without dispatch attempts', async () => {
    for (const state of ['stopping', 'stopped', 'cancelled', 'failed', 'verified', 'outcome-unknown']) {
      const core = coreAt(directory()); const owner = leaseAt(core)
      await core.commitWithManifests(startInput(api, owner, { state }))
      assert.throws(() => core.claimOperation({ scope, owner, operationId: 'operation-a' }), (error) => error.code === (state === 'outcome-unknown' ? 'OUTCOME_UNKNOWN' : 'EXECUTION_INACTIVE'))
      assert.equal(core.getOperation(scope, 'operation-a').attempts, 0)
    }
  })
  await check('AC02/03: pinned predecessor cleanup remains available during recovery with real ownership', async () => {
    const core = coreAt(directory()); const owner = leaseAt(core); await core.commitWithManifests(startInput(api, owner))
    const adoption = adoptionInput(api, owner)
    adoption.journal.runChanges[0].state = 'outcome-unknown'
    for (const purpose of ['stop-run', 'reconcile']) adoption.journal.outbox.push({
      ...adoption.journal.outbox[0], operationId: purpose + '-old', purpose, run: { runId: 'run-a', revision: 1 }
    })
    assert.equal((await core.commitWithManifests(adoption)).status, 'committed')
    const changed = structuredClone(adoption); changed.journal.outbox[1].purpose = 'execute-step'
    assert.equal((await core.commitWithManifests(changed)).status, 'payload-conflict')
    assert.equal(core.getOperation(scope, 'stop-run-old').operation.purpose, 'stop-run')
    assert.throws(() => core.claimOperation({ scope, owner, operationId: 'adopt-a-operation' }), (error) => error.code === 'OUTCOME_UNKNOWN')
    for (const purpose of ['stop-run', 'reconcile']) {
      const operationId = purpose + '-old'
      assert.throws(() => core.claimOperation({ scope, owner: { ...owner, fencingToken: owner.fencingToken + 1 }, operationId }), (error) => error.code === 'OWNER_CONFLICT')
      assert.throws(() => core.claimOperation({ scope: { ...scope, projectId: 'foreign-project' }, owner, operationId }), (error) => error.code === 'OWNER_CONFLICT')
      assert.equal(core.claimOperation({ scope, owner, operationId }).operation.purpose, purpose)
    }
  })
  await check('AC03: cleanup purpose never admits or dispatches a nonexistent run', async () => {
    const dir = directory(); const core = coreAt(dir); const owner = leaseAt(core); const input = startInput(api, owner)
    input.journal.outbox[0].purpose = 'stop-run'; input.journal.outbox[0].run = { runId: 'unknown-run', revision: 1 }
    await assert.rejects(core.commitWithManifests(input), (error) => error.issues?.some((issue) => issue.message === 'Outbox operation is not for an admitted run'))
    assert.equal(await core.head(scope), null); assert.equal(core.getCommand(scope, 'command-a'), null)
    input.journal.outbox[0].run = { runId: 'run-a', revision: 1 }; await core.commitWithManifests(input)
    // A stale/damaged imported row still cannot use cleanup intent to invoke unknown work.
    const db = new DatabaseSync(join(dir, 'control.sqlite'))
    try { db.prepare('UPDATE workflow_dispatch_outbox SET operationJson=? WHERE operationId=?').run(api.canonicalWorkflowJson({ ...input.journal.outbox[0], run: { runId: 'unknown-run', revision: 1 } }), 'operation-a') }
    finally { db.close() }
    assert.throws(() => core.claimOperation({ scope, owner, operationId: 'operation-a' }), (error) => error.code === 'NOT_FOUND')
    assert.equal(core.getOperation(scope, 'operation-a').attempts, 0)
  })
  await check('AC04: event cursors are scope/store bound and late old revisions do not replace the head', async () => {
    const core = coreAt(directory()); const owner = leaseAt(core); await core.commitWithManifests(startInput(api, owner))
    const page = core.events({ scope, limit: 1 }); assert.equal(page.hasMore, true)
    const second = core.events({ scope, cursor: page.cursor }); assert.ok(second.items.length)
    assert.equal(core.events({ scope: { ...scope, taskRef: 'task:other' }, cursor: page.cursor }).resetRequired, true)
    await core.commitWithManifests(adoptionInput(api, owner))
    const late = event(api, { runId: 'run-a', revision: 1 }, 'late-old')
    const report = { event: late, payloadDigest: digest(api.canonicalWorkflowJson(late)) }
    assert.equal((await core.append(report)).status, 'committed'); assert.equal((await core.append(report)).status, 'duplicate')
    assert.equal((await core.head(scope)).run.run.runId, 'adopt-a-run')
    const different = structuredClone(late); different.payload = { changed: true }
    await assert.rejects(core.append({ event: different, payloadDigest: digest(api.canonicalWorkflowJson(different)) }))
  })
  await check('AC04: optional observations/history deletion does not affect control snapshots or steps', async () => {
    const dir = directory(); const core = coreAt(dir); const owner = leaseAt(core); await core.commitWithManifests(startInput(api, owner))
    core.recordStep({ scope, owner, step: { runId: 'run-a', revision: 1, nodeId: 'node-a', attempt: 1 }, state: 'verified', inputFingerprint: digest('input'), materialRefs: [], outputRefs: [], sessionId: 'session-a', turnId: 'turn-a', historySeq: 5, historyCommitted: true, updatedAt: 10 })
    for (const name of ['observations.sqlite', 'history.sqlite']) { const file = join(dir, name); writeFileSync(file, 'optional fixture'); rmSync(file) }
    core.close(); const reopened = coreAt(dir)
    assert.equal((await reopened.head(scope)).manifest.definition.definitionId, 'definition-a')
    assert.equal(reopened.steps(scope, { runId: 'run-a', revision: 1 })[0].historySeq, 5)
  })
  await check('AC01/04: a step attempt keeps its input identity while later evidence can advance', async () => {
    const core = coreAt(directory()); const owner = leaseAt(core); await core.commitWithManifests(startInput(api, owner))
    const material = (id) => ({ materialId: id, version: 'v1', kind: 'spec', source: { kind: 'trellis-file', relativePath: '.trellis/spec/' + id + '.md' }, sourceDigest: digest(id) })
    const record = { scope, owner, step: { runId: 'run-a', revision: 1, nodeId: 'node-a', attempt: 1 }, state: 'running',
      inputFingerprint: digest('original input'), materialRefs: [material('a'), material('b')], outputRefs: [], sessionId: null, turnId: null,
      historySeq: null, historyCommitted: false, updatedAt: 10 }
    core.recordStep(record)
    core.recordStep({ ...record, state: 'verified', outputRefs: [material('output')], sessionId: 'session-a', turnId: 'turn-a', historySeq: 7, historyCommitted: true, updatedAt: 11 })
    assert.throws(() => core.recordStep({ ...record, inputFingerprint: digest('changed input'), updatedAt: 12 }), (error) => error.code === 'IDENTITY_CONFLICT')
    assert.throws(() => core.recordStep({ ...record, materialRefs: [material('c')], updatedAt: 12 }), (error) => error.code === 'IDENTITY_CONFLICT')
    assert.throws(() => core.recordStep({ ...record, materialRefs: [...record.materialRefs].reverse(), updatedAt: 12 }), (error) => error.code === 'IDENTITY_CONFLICT')
    const run = { runId: record.step.runId, revision: record.step.revision }
    assert.equal(core.steps(scope, run)[0].state, 'verified')
    assert.equal(core.steps(scope, run)[0].inputFingerprint, record.inputFingerprint)
    assert.deepEqual(core.steps(scope, run)[0].outputRefs, [material('output')])
    assert.equal(core.steps(scope, run)[0].historySeq, 7)
    core.recordStep({ ...record, step: { ...record.step, attempt: 2 }, inputFingerprint: digest('changed input'), materialRefs: [material('c')], updatedAt: 12 })
    assert.equal(core.steps(scope, run).length, 2)
  })
  await check('AC01/04: future schemas and damaged files are preserved rather than rewritten', async () => {
    const dir = directory(); coreAt(dir).close(); const db = new DatabaseSync(join(dir, 'control.sqlite'))
    db.prepare("UPDATE workflow_meta SET value='9' WHERE key='schemaVersion'").run(); db.close()
    assert.throws(() => coreAt(dir), (error) => error.code === 'FUTURE_SCHEMA')
    const corrupt = directory(); const file = join(corrupt, 'control.sqlite'); writeFileSync(file, 'not a sqlite file')
    const bytes = readFileSync(file); assert.throws(() => coreAt(corrupt)); assert.deepEqual(readFileSync(file), bytes)
  })
  await check('AC04: real competing-process lock bounds the legacy main write and permits deliberate retry', async () => {
    const dir = directory(); const legacy = new api.LocalControlStore(dir); legacy.open(); active.add(legacy)
    const locked = child('lock', dir, '650'); await waitFor(() => locked.messages.some((m) => m.kind === 'locked'))
    const start = performance.now(); assert.throws(() => legacy.insertOperation('busy-operation', 'ws', 'registered', { operationKey: {} }))
    const elapsed = performance.now() - start
    assert.equal(api.LOCAL_CONTROL_MAIN_BUSY_TIMEOUT_MS, 50); assert.ok(elapsed >= 25 && elapsed < 250, `actual legacy blocking ${elapsed}ms`)
    assert.equal(legacy.currentState, 'active'); assert.equal(legacy.getOperation('busy-operation'), null)
    assert.equal((await locked.done).code, 0)
    assert.equal(legacy.insertOperation('busy-operation', 'ws', 'registered', { operationKey: {} }).stage, 'registered')
    results.push({ name: 'legacy lock measurement', status: 'passed', observedMs: Math.round(elapsed), configuredBudgetMs: 50 })
  })
  await check('AC04: transient migration lock is busy, not corruption, and explicit reopen succeeds', async () => {
    const dir = directory(); const locked = child('lock', dir, '550'); await waitFor(() => locked.messages.some((m) => m.kind === 'locked'))
    const legacy = new api.LocalControlStore(dir); active.add(legacy)
    assert.throws(() => legacy.open()); assert.equal(legacy.currentState, 'busy')
    await locked.done; legacy.open(); assert.equal(legacy.currentState, 'active')
    assert.equal(legacy.insertOperation('after-busy-open', 'ws', 'registered', { operationKey: {} }).stage, 'registered')
  })
  await check('AC04: real worker event writes retain caller heartbeat and load committed data', async () => {
    const service = new api.WorkflowControlService(directory(), { workerFile: worker }); active.add(service)
    await service.open(); const claimed = await service.claimWorkspace(scope); const owner = claimed.lease.owner
    await service.commitWithManifests(startInput(api, owner))
    let ticks = 0; let maxGap = 0; let last = performance.now()
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++ }, 5)
    try {
      for (let batch = 0; batch < 10; batch++) await Promise.all(Array.from({ length: 20 }, (_, i) => {
        const value = event(api, { runId: 'run-a', revision: 1 }, `worker-${batch}-${i}`)
        return service.append({ event: value, payloadDigest: digest(api.canonicalWorkflowJson(value)) })
      }))
    } finally { clearInterval(timer) }
    assert.ok(ticks > 0); assert.ok(maxGap < 250, `caller heartbeat stalled ${maxGap}ms`)
    assert.equal((await service.head(scope)).run.run.runId, 'run-a')
    results.push({ name: 'worker heartbeat measurement', status: 'passed', ticks, maxGapMs: Math.round(maxGap), eventCount: 200 })
    await service.close()
  })
  await check('AC03/04: writer exit never releases a still-live execution owner or repeats its dispatched work', async () => {
    const dir = directory(); const service = new api.WorkflowControlService(dir, { workerFile: worker }); active.add(service)
    const lease = await service.claimWorkspace(scope); await service.commitWithManifests(startInput(api, lease.lease.owner))
    await service.claimOperation({ scope, owner: lease.lease.owner, operationId: 'operation-a' })
    const handle = service.worker; assert.ok(handle); await handle.terminate()
    assert.equal((await service.head(scope)).run.run.runId, 'run-a')
    const resumed = await service.claimWorkspace(scope); assert.equal(resumed.lease.owner.fencingToken, lease.lease.owner.fencingToken)
    assert.equal((await service.getOperation(scope, 'operation-a')).operation.state, 'dispatched')
    await assert.rejects(service.recoverProcessOwner(scope, lease.lease.owner), (error) => error.code === 'OWNER_STILL_ALIVE')
    await assert.rejects(service.claimOperation({ scope, owner: lease.lease.owner, operationId: 'operation-a' }), (error) => error.code === 'OPERATION_NOT_PENDING')
    await service.close()
  })
  await check('AC01/04: worker deadlines do not free in-flight queue budgets or claim false failure', async () => {
    const dir = directory(); const service = new api.WorkflowControlService(dir, { workerFile: worker, requestTimeoutMs: 150 }); active.add(service)
    await service.open(); const claimed = await service.claimWorkspace(scope); await service.commitWithManifests(startInput(api, claimed.lease.owner))
    const locked = child('lock', dir, '700'); await waitFor(() => locked.messages.some((m) => m.kind === 'locked'))
    const value = event(api, { runId: 'run-a', revision: 1 }, 'late-ack')
    const jobs = [service.append({ event: value, payloadDigest: digest(api.canonicalWorkflowJson(value)) }), ...Array.from({ length: 63 }, () => service.health())]
    const settled = await Promise.allSettled(jobs)
    assert.ok(settled.some((r) => r.status === 'rejected' && r.reason.outcomeUnknown === true))
    await assert.rejects(service.health(), (error) => error.code === 'QUEUE_FULL')
    await locked.done; await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    const page = await service.events({ scope, limit: 200 }); assert.ok(page.items.some((item) => item.event.eventId === 'late-ack'))
    assert.equal((await service.claimWorkspace(scope)).lease.owner.fencingToken, claimed.lease.owner.fencingToken)
    await service.close()
  })
  if (process.argv.includes('--built-worker')) await check('Build integration: emitted workflow worker loads and legacy worker outputs remain available', async () => {
    for (const name of ['diff-worker.js', 'observation-worker.js', 'history-worker.js', 'workflow-control-worker.js']) assert.ok(existsSync(resolve('out/main', name)), name)
    const service = new api.WorkflowControlService(directory(), { workerFile: resolve('out/main/workflow-control-worker.js') }); active.add(service)
    assert.equal((await service.open()).workflowSchemaVersion, 1)
    const owned = await service.claimWorkspace(scope); await service.commitWithManifests(startInput(api, owned.lease.owner))
    assert.equal((await service.head(scope)).manifest.inputFingerprint, digest('effective input'))
    assert.deepEqual((await service.workspaceOwner({ projectId: scope.projectId, repositoryId: scope.repositoryId, workspaceId: scope.workspaceId })).owner, owned.lease.owner)
    await service.close()
  })
  const report = { status: 'passed', scope: 'R1-01 actual file SQLite, process faults and worker service; not power-loss or native execution acceptance', scenarios: results.filter((r) => r.elapsedMs !== undefined).length, builtWorker: process.argv.includes('--built-worker') ? 'passed' : 'not_run', results }
  const reportIndex = process.argv.indexOf('--report')
  if (reportIndex >= 0) writeFileSync(process.argv[reportIndex + 1], JSON.stringify(report, null, 2) + '\n')
  console.log(`workflow-control: ${report.scenarios} scenarios passed`)
} finally {
  for (const object of active) { try { await object.close() } catch { /* retain test cleanup even after a failure */ } }
  for (const processHandle of children) processHandle.kill()
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir())); assert.ok(temporary.includes('trellis-workflow-control-'))
  rmSync(temporary, { recursive: true, force: true })
}
