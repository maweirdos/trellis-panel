/** Real shared-code contract checks only; no engine, Jira, store or UI integration. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-workflow-contracts-'))
const digest = (text) => createHash('sha256').update(text).digest('hex')
const hashA = digest('source A'); const hashB = digest('source B')
const clone = (value) => structuredClone(value)
const results = []
const check = async (name, action) => { await action(); results.push({ name, status: 'passed' }) }
try {
  const bundle = join(temporary, 'contracts.mjs')
  await build({ entryPoints: ['src/shared/workflow/index.ts'], bundle: true, format: 'esm', platform: 'node', outfile: bundle })
  // A real browser-target build catches accidental Node dependencies in the shared boundary.
  await build({ entryPoints: ['src/shared/workflow/index.ts'], bundle: true, format: 'esm', platform: 'browser', outfile: join(temporary, 'browser.mjs') })
  const api = await import(pathToFileURL(bundle).href)
  const asset = (assetId, version = 'v1', hash = hashA) => ({ assetId, version, digest: hash })
  const scope = { projectId: 'project-a', repositoryId: 'repo-a', workspaceId: 'workspace-a', taskRef: 'task-a' }
  const localA = { repositoryId: 'repo-a', workspaceId: 'workspace-a', taskRef: 'task-a' }
  const localB = { ...localA, taskRef: 'task-b' }
  const issue = { instanceId: 'jira-a', issueId: '10001' }
  const issue2 = { instanceId: 'jira-a', issueId: '10002' }
  const executor = {
    bindingId: 'codex-local', engineId: 'codex', engineVersion: 'fixture-version', adapterVersion: 'acpx-fixture',
    configuration: asset('executor-config'),
    capabilities: { prompt: { status: 'supported', evidenceRef: 'probe-fixture' }, nativeChildren: { status: 'unknown', reason: 'not observed' } }
  }
  const role = { ref: asset('full-stack'), visibility: { kind: 'personal', ownerId: 'developer' }, methods: [asset('trellis-method')], instructionDigest: hashA }
  const flow = {
    version: 1, id: 'order-export', name: 'Order export', description: 'Contract fixture',
    inputs: [{ name: 'subject', label: 'Subject', required: true }],
    phases: [{ id: 'plan', name: 'Plan', steps: [
      { id: 'prd', name: 'Write PRD', kind: 'agent', instruction: 'Use {{input.subject}}', maxRounds: 3, tools: ['kb_search'], saveOutputAs: 'prd' },
      { id: 'review', name: 'Check PRD', kind: 'gate', check: { stepId: 'prd', minLength: 10 }, onFail: 'goto', gotoStepId: 'prd', maxRetries: 1 }
    ] }, { id: 'implement', name: 'Implement', steps: [
      { id: 'code', name: 'Implement', kind: 'agent', instruction: 'Implement {{vars.prd}}' }
    ] }], hooks: { onStart: 'Retain business rules', onPhase: { plan: 'Plan before coding' }, onComplete: { notify: true } },
    extension: { custom: 'preserved' }, updatedAt: 10
  }
  const definition = {
    contractVersion: 1, ref: { definitionId: 'order-export', revision: 1 }, flow,
    defaultExecutor: executor, nodeBindings: [{ stepId: 'prd', role, requiredCapabilities: ['prompt'] }],
    trellisPhases: { plan: 'plan', implement: 'implement' }
  }
  const context = {
    scope, instruction: 'Implement order export', inputs: { subject: 'order export' },
    materials: [{ material: { materialId: 'business-requirement', version: 'v1', kind: 'product-requirement', source: { kind: 'published', publicationId: 'publication-1' }, sourceDigest: hashA }, inclusion: 'full', includedDigest: hashA, reason: null }],
    engineeringBaseline: asset('engineering-baseline'), outputContract: asset('output-schema'), budgetBytes: 4096, complete: true
  }
  const compiled = await api.compileWorkflowDefinition(definition, context, digest)

  await check('AC01: one issue/two local tasks preserve independent local/archive/remote states', () => {
    const catalog = api.workCatalogSchema.parse({ contractVersion: 1, project: { projectId: scope.projectId },
      issues: [{ projectId: scope.projectId, issue, issueKey: 'DEMO-1', remoteStatus: 'In Progress', remoteUpdatedAt: 10, versions: [] }],
      bindings: [
        { projectId: scope.projectId, issue, localTask: localA, localStatus: 'completed', archived: true, requiredForDelivery: true },
        { projectId: scope.projectId, issue, localTask: localB, localStatus: 'in_progress', archived: false, requiredForDelivery: true }
      ] })
    assert.equal(catalog.issues[0].remoteStatus, 'In Progress')
    assert.equal(catalog.bindings[0].archived, true); assert.equal(catalog.bindings[1].localStatus, 'in_progress')
  })
  await check('AC01: one requirement can reference several independently identified Jira issues', () => {
    const row = (ref) => ({ projectId: scope.projectId, issue: ref, remoteStatus: 'Open', remoteUpdatedAt: null, versions: [] })
    const value = api.workCatalogSchema.parse({ contractVersion: 1, project: { projectId: scope.projectId }, issues: [row(issue), row(issue2)], bindings: [], requirementLinks: [issue, issue2].map((ref) => ({ requirement: asset('requirements'), issue: ref })) })
    assert.equal(value.requirementLinks.length, 2)
  })
  await check('AC02: Jira instance, workspace, repository and tuple delimiters prevent accidental identity collapse', () => {
    assert.notEqual(api.jiraIssueIdentity(issue), api.jiraIssueIdentity({ ...issue, instanceId: 'jira-b' }))
    assert.notEqual(api.localTaskIdentity(localA), api.localTaskIdentity({ ...localA, workspaceId: 'workspace-b' }))
    assert.notEqual(api.localTaskIdentity(localA), api.localTaskIdentity({ ...localA, repositoryId: 'repo-b' }))
    assert.notEqual(api.jiraIssueIdentity({ instanceId: 'a:b', issueId: 'c' }), api.jiraIssueIdentity({ instanceId: 'a', issueId: 'b:c' }))
  })
  await check('AC02: foreign and duplicate issue/task bindings are rejected', () => {
    const row = { projectId: scope.projectId, issue, localTask: localA, localStatus: 'planning', archived: false, requiredForDelivery: true }
    const base = { contractVersion: 1, project: { projectId: scope.projectId }, issues: [{ projectId: scope.projectId, issue, remoteStatus: 'Open', remoteUpdatedAt: null, versions: [] }], bindings: [row, row] }
    assert.equal(api.workCatalogSchema.safeParse(base).success, false)
    base.bindings = [{ ...row, issue: { ...issue, instanceId: 'foreign' } }]
    assert.equal(api.workCatalogSchema.safeParse(base).success, false)
  })
  await check('AC02: custom legacy status and nested unknown JSON survive without source mutation or alias guessing', () => {
    const original = { id: 'task-native', status: 'awaiting-special-review', meta: { custom: ['a', { b: 2 }] }, ownerExtension: { keep: true } }
    const before = clone(original); const snapshot = api.snapshotLegacyTask(original, localA)
    assert.equal(snapshot.localStatus, 'awaiting-special-review'); assert.deepEqual(snapshot.original, original)
    snapshot.original.meta.custom[1].b = 9
    assert.deepEqual(original, before); assert.equal(snapshot.localTask.taskRef, localA.taskRef)
    assert.throws(() => api.snapshotLegacyTask({ ...original, id: '' }, localA))
  })
  await check('AC02: invalid revisions, nonfinite JSON and short content digests are rejected', () => {
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(api.definitionRefSchema.safeParse({ definitionId: 'flow', revision }).success, false)
    assert.equal(api.workflowJsonSchema.safeParse({ invalid: Infinity }).success, false)
    assert.equal(api.workflowDigestSchema.safeParse(hashA.slice(0, 16)).success, false)
  })
  await check('AC02: complete version scope needs a known matching total and exact instance identities', () => {
    const base = { project: { projectId: scope.projectId }, version: { instanceId: 'jira-a', versionId: 'v1' }, branches: [{ repositoryId: 'repo-a', branchRef: 'release/v1' }], issues: [issue], query: 'fixVersion=fixture', queriedAt: 10, sourceTotal: 1, complete: true }
    assert.equal(api.versionScopeSchema.safeParse(base).success, true)
    assert.equal(api.versionScopeSchema.safeParse({ ...base, sourceTotal: null }).success, false)
    assert.equal(api.versionScopeSchema.safeParse({ ...base, sourceTotal: 100 }).success, false)
    assert.equal(api.versionScopeSchema.safeParse({ ...base, issues: [{ ...issue, instanceId: 'foreign' }] }).success, false)
  })
  await check('AC03: plan and graph have exactly matching node/edge identities', () => {
    assert.deepEqual(compiled.plan.nodes.map((n) => n.nodeId), compiled.graph.nodes.map((n) => n.nodeId))
    assert.deepEqual(compiled.plan.edges, compiled.graph.edges)
    assert.equal(compiled.plan.nodes[0].trellisPhase, 'plan'); assert.equal(compiled.plan.nodes[2].trellisPhase, 'implement')
  })
  await check('AC03: gate check, bounded goto and default feedback are explicit declared edges', () => {
    const gate = compiled.plan.nodes.find((n) => n.stepId === 'review')
    const prd = compiled.plan.nodes.find((n) => n.stepId === 'prd')
    assert.ok(gate && prd)
    assert.ok(compiled.plan.edges.some((e) => e.kind === 'retry' && e.from === gate.nodeId && e.to === prd.nodeId && e.maxRetries === 1))
    assert.ok(compiled.plan.edges.some((e) => e.kind === 'feedback' && e.from === gate.nodeId && e.to === prd.nodeId))
    assert.ok(compiled.plan.edges.some((e) => e.kind === 'check' && e.from === prd.nodeId && e.to === gate.nodeId))
    assert.equal(gate.step.onFail, 'goto')
  })
  await check('AC03: moving/collapsing nodes leaves topology, execution config and full input fingerprint unchanged', async () => {
    const layout = { nodes: { [compiled.plan.nodes[0].nodeId]: { x: 80, y: 120, collapsed: true } } }
    const moved = await api.compileWorkflowDefinition(definition, context, digest, layout)
    assert.equal(moved.inputFingerprint, compiled.inputFingerprint)
    assert.deepEqual(moved.plan, compiled.plan); assert.deepEqual(moved.graph.edges, compiled.graph.edges)
    assert.notDeepEqual(moved.graph.layout, compiled.graph.layout)
  })
  await check('AC03: effective instruction, actual input, material/output/baseline, role and capability changes invalidate input identity', async () => {
    const contextMutations = [
      (c) => { c.instruction += ' revised' }, (c) => { c.inputs.subject = 'another feature' },
      (c) => { c.materials[0].material.version = 'v2' },
      (c) => { c.materials[0].material.sourceDigest = hashB; c.materials[0].includedDigest = hashB },
      (c) => { c.engineeringBaseline.version = 'v2' }, (c) => { c.outputContract.digest = hashB }
    ]
    for (const mutate of contextMutations) { const c = clone(context); mutate(c); assert.notEqual((await api.compileWorkflowDefinition(definition, c, digest)).inputFingerprint, compiled.inputFingerprint) }
    const definitionMutations = [
      (d) => { d.nodeBindings[0].role.ref.version = 'v2' },
      (d) => { d.nodeBindings[0].role.instructionDigest = hashB },
      (d) => { d.flow.hooks.onStart += ' revised' },
      (d) => { d.defaultExecutor.capabilities.nativeChildren = { status: 'unsupported', reason: 'probe shows unavailable' } }
    ]
    for (const mutate of definitionMutations) { const d = clone(definition); mutate(d); assert.notEqual((await api.compileWorkflowDefinition(d, context, digest)).inputFingerprint, compiled.inputFingerprint) }
  })
  await check('AC03: persistence timestamps and object key ordering do not change input identity', async () => {
    const other = clone(definition); other.flow.updatedAt = 999; other.flow.createdAt = 30
    assert.equal((await api.compileWorkflowDefinition(other, context, digest)).inputFingerprint, compiled.inputFingerprint)
    assert.equal(api.canonicalWorkflowJson({ b: { z: 1, a: 2 }, a: 0 }), api.canonicalWorkflowJson({ a: 0, b: { a: 2, z: 1 } }))
  })
  await check('AC03: explicit per-node engine override remains separate from inherited engine', async () => {
    const next = clone(definition)
    next.nodeBindings.push({ stepId: 'code', role: null, executor: { ...executor, bindingId: 'claude-local', engineId: 'claude' }, requiredCapabilities: ['prompt'] })
    const value = await api.compileWorkflowDefinition(next, context, digest)
    assert.equal(value.plan.nodes[0].executorSelection, 'inherited')
    assert.equal(value.plan.nodes[2].executorSelection, 'override'); assert.equal(value.plan.nodes[2].executor.engineId, 'claude')
    assert.notEqual(value.inputFingerprint, compiled.inputFingerprint)
  })
  await check('AC02/03: unsupported or unknown required capability cannot silently choose a different engine', async () => {
    const next = clone(definition); next.nodeBindings[0].requiredCapabilities = ['nativeChildren']
    await assert.rejects(api.compileWorkflowDefinition(next, context, digest), (error) => error.code === 'CAPABILITY_UNAVAILABLE')
    next.nodeBindings[0].requiredCapabilities = ['nonexistent']
    await assert.rejects(api.compileWorkflowDefinition(next, context, digest), (error) => error.code === 'CAPABILITY_UNAVAILABLE')
  })
  await check('AC02: conflicting executor and role snapshots under the same versioned identity are rejected', async () => {
    const next = clone(definition)
    next.nodeBindings.push({ stepId: 'code', role: null, executor: { ...executor, engineVersion: 'different' }, requiredCapabilities: [] })
    await assert.rejects(api.compileWorkflowDefinition(next, context, digest), (error) => error.code === 'IDENTITY_CONFLICT')
    const nextRole = clone(definition)
    nextRole.nodeBindings.push({ stepId: 'code', role: { ...role, instructionDigest: hashB }, requiredCapabilities: [] })
    await assert.rejects(api.compileWorkflowDefinition(nextRole, context, digest), (error) => error.code === 'IDENTITY_CONFLICT')
  })
  await check('AC02: duplicate nodes/phases, malformed references and unknown layout identities are rejected', async () => {
    const next = clone(definition); next.flow.phases[1].steps[0].id = 'prd'
    assert.equal(api.workflowDefinitionSchema.safeParse(next).success, false)
    const phase = clone(definition); phase.flow.phases[1].id = 'plan'
    assert.equal(api.workflowDefinitionSchema.safeParse(phase).success, false)
    const badBinding = clone(definition); badBinding.nodeBindings[0].stepId = 'foreign'
    assert.equal(api.workflowDefinitionSchema.safeParse(badBinding).success, false)
    await assert.rejects(api.compileWorkflowDefinition(definition, context, digest, { nodes: { foreign: { x: 0, y: 0 } } }), (error) => error.code === 'INVALID_LAYOUT')
  })
  await check('AC02: native Flow JSON and extensions remain unchanged after adaptation', () => {
    const before = clone(flow); const adapted = api.adaptLegacyFlow(flow, definition.ref, executor)
    assert.equal(adapted.ok, true); assert.deepEqual(adapted.original, flow)
    assert.deepEqual(api.readLegacyFlow(flow), flow)
    adapted.original.extension.custom = 'changed snapshot'
    assert.deepEqual(flow, before)
  })
  await check('AC02: unsupported forward/self/unknown goto and source versions retain original JSON', () => {
    for (const target of ['review', 'code', 'missing']) {
      const raw = clone(flow); raw.phases[0].steps[1].gotoStepId = target
      const adapted = api.adaptLegacyFlow(raw, definition.ref, executor)
      assert.equal(adapted.ok, false); assert.equal(adapted.code, 'UNSUPPORTED_LEGACY_FLOW'); assert.deepEqual(adapted.original, raw)
    }
    const raw = { ...flow, version: 2 }
    assert.equal(api.adaptLegacyFlow(raw, definition.ref, executor).ok, false)
  })
  await check('AC02: material completeness cannot claim missing bytes or rewrite short digest semantics', () => {
    const missing = clone(context); missing.materials[0].material.sourceDigest = null
    assert.equal(api.contextManifestSchema.safeParse(missing).success, false)
    const short = clone(context); short.materials[0].material.sourceDigest = hashA.slice(0, 16)
    assert.equal(api.contextManifestSchema.safeParse(short).success, false)
    const path = clone(context); path.materials[0].material.source = { kind: 'trellis-file', relativePath: '../private' }
    assert.equal(api.contextManifestSchema.safeParse(path).success, false)
    const duplicate = clone(context); duplicate.materials.push(clone(duplicate.materials[0]))
    assert.equal(api.contextManifestSchema.safeParse(duplicate).success, false)
  })
  await check('AC03: unknown baseline or omitted material disables reuse without fabricating evidence', async () => {
    const partial = clone(context); partial.engineeringBaseline = null
    assert.equal((await api.compileWorkflowDefinition(definition, partial, digest)).reuseEligible, false)
    const indexOnly = clone(context); indexOnly.complete = false; indexOnly.materials[0].inclusion = 'index-only'; indexOnly.materials[0].includedDigest = null
    assert.equal((await api.compileWorkflowDefinition(definition, indexOnly, digest)).reuseEligible, false)
  })
  await check('AC02: digest adapter must return a complete digest and compiled structures cannot drift by mutation', async () => {
    await assert.rejects(api.compileWorkflowDefinition(definition, context, () => 'short'))
    assert.ok(Object.isFrozen(compiled)); assert.ok(Object.isFrozen(compiled.plan.nodes)); assert.ok(Object.isFrozen(compiled.plan.nodes[0].step))
    assert.throws(() => compiled.plan.nodes.push({})); assert.throws(() => { compiled.graph.edges[0].to = 'foreign' })
  })
  await check('AC02: event unknown ownership is explicit and cross-run step attribution is invalid', () => {
    const base = { contractVersion: 1, eventId: 'event-a', source: 'engine', type: 'context.emitted', attribution: { kind: 'unassigned', reason: 'no verifiable task binding' }, occurredAt: 1, receivedAt: 2, epoch: 'epoch-a', sequence: 1, payload: { text: 'done' } }
    assert.equal(api.executionEventSchema.parse(base).attribution.kind, 'unassigned')
    base.attribution = { kind: 'assigned', scope, run: { runId: 'run-a', revision: 1 }, step: { runId: 'foreign-run', revision: 1, nodeId: compiled.plan.nodes[0].nodeId, attempt: 1 }, sessionId: null, turnId: null, historySeq: null }
    assert.equal(api.executionEventSchema.safeParse(base).success, false)
  })
  await check('AC02: run/context scope mismatch and backward successor revisions are invalid', () => {
    const manifest = { contractVersion: 1, scope, run: { runId: 'run-a', revision: 1 }, definition: definition.ref, roles: [role], executors: [executor], extensions: [], context, inputFingerprint: compiled.inputFingerprint, recordedAt: 1 }
    assert.equal(api.runManifestSchema.safeParse(manifest).success, true)
    const other = clone(manifest); other.context.scope = { ...other.context.scope, taskRef: 'foreign' }
    assert.equal(api.runManifestSchema.safeParse(other).success, false)
    const run = { contractVersion: 1, scope, run: { runId: 'run-a', revision: 2 }, definition: definition.ref, state: 'outcome-unknown', predecessor: { runId: 'run-a', revision: 2 }, createdAt: 1 }
    assert.equal(api.workflowRunSchema.safeParse(run).success, false)
    run.predecessor.revision = 1; assert.equal(api.workflowRunSchema.safeParse(run).success, true)
  })
  await check('AC02: actual command payload is verified separately from admission and external success', async () => {
    const payload = { previewId: 'preview-a', boundary: 'next-step' }
    const command = { contractVersion: 1, commandId: 'command-a', scope, runId: 'run-a', expectedRevision: 1, kind: 'adopt-revision', payloadDigest: digest(api.canonicalWorkflowJson(payload)), payload, requestedAt: 10 }
    assert.equal((await api.verifyWorkflowCommand(command, digest)).commandId, 'command-a')
    command.payload.boundary = 'different'
    await assert.rejects(api.verifyWorkflowCommand(command, digest), (error) => error.code === 'COMMAND_PAYLOAD_CONFLICT')
    assert.equal(api.commandAdmissionSchema.parse({ commandId: 'command-a', status: 'accepted', operationId: 'operation-a' }).status, 'accepted')
    assert.equal(api.operationStateSchema.parse('outcome-unknown'), 'outcome-unknown')
  })
  await check('ECR-01: immutable methods, roles and extensions reject conflicting and identical duplicate version entries', () => {
    assert.equal(api.agentRoleRevisionSchema.safeParse({ ...role, methods: [asset('method'), asset('method', 'v1', hashB)] }).success, false)
    assert.equal(api.agentRoleRevisionSchema.safeParse({ ...role, methods: [asset('method'), asset('method')] }).success, false)
    const manifest = { contractVersion: 1, scope, run: { runId: 'run-a', revision: 1 }, definition: definition.ref, roles: [role], executors: [executor], extensions: [], context, inputFingerprint: compiled.inputFingerprint, recordedAt: 1 }
    for (const duplicate of [clone(role), { ...role, ref: { ...role.ref, digest: hashB } }]) assert.equal(api.runManifestSchema.safeParse({ ...manifest, roles: [role, duplicate] }).success, false)
    for (const ref of [asset('plugin'), asset('plugin', 'v1', hashB)]) assert.equal(api.runManifestSchema.safeParse({ ...manifest, extensions: [asset('plugin'), ref] }).success, false)
    assert.equal(api.runManifestSchema.safeParse({ ...manifest, extensions: [asset(role.methods[0].assetId, 'v1', hashB)] }).success, false)
    const secondRole = { ...role, ref: asset('reviewer') }
    assert.equal(api.runManifestSchema.safeParse({ ...manifest, roles: [role, secondRole] }).success, true)
  })
  await check('R0 ports: driver identity/pins, durable acknowledgement and atomic journal scopes are validated without implementing I/O', () => {
    const manifest = { contractVersion: 1, scope, run: { runId: 'run-a', revision: 1 }, definition: definition.ref, roles: [role], executors: [executor], extensions: [], context, inputFingerprint: compiled.inputFingerprint, recordedAt: 1 }
    const dispatch = { operationId: 'operation-a', owner: { ownerId: 'owner-a', fencingToken: 1 }, manifest, step: { runId: 'run-a', revision: 1, nodeId: compiled.plan.nodes[0].nodeId, attempt: 1 }, node: compiled.plan.nodes[0], executorBindingId: executor.bindingId }
    assert.equal(api.driverDispatchSchema.safeParse(dispatch).success, true)
    assert.equal(api.driverDispatchSchema.safeParse({ ...dispatch, step: { ...dispatch.step, revision: 2 } }).success, false)
    assert.equal(api.driverDispatchSchema.safeParse({ ...dispatch, executorBindingId: 'foreign' }).success, false)
    assert.equal(api.driverDispatchSchema.safeParse({ ...dispatch, node: { ...dispatch.node, executor: { ...executor, engineVersion: 'unadopted' } } }).success, false)
    assert.equal(api.workflowWriteAcknowledgementSchema.safeParse({ id: 'command-a', status: 'committed', cursor: null }).success, false)
    const run = { contractVersion: 1, scope, run: { runId: 'run-a', revision: 2 }, definition: definition.ref, state: 'queued', predecessor: { runId: 'run-a', revision: 1 }, createdAt: 1 }
    const command = { contractVersion: 1, commandId: 'command-a', scope, runId: 'run-a', expectedRevision: 1, kind: 'adopt-revision', payloadDigest: hashA, payload: {}, requestedAt: 1 }
    const commit = { command, owner: dispatch.owner, expectedCurrent: { runId: 'run-a', revision: 1 }, runChanges: [run], events: [], outbox: [] }
    assert.equal(api.journalCommitSchema.safeParse(commit).success, true)
    assert.equal(api.journalCommitSchema.safeParse({ ...commit, expectedCurrent: null }).success, false)
    assert.equal(api.journalCommitSchema.safeParse({ ...commit, runChanges: [{ ...run, scope: { ...scope, taskRef: 'foreign' } }] }).success, false)
    assert.equal(api.journalCommitSchema.safeParse({ ...commit, runChanges: [run, run] }).success, false)
    assert.equal(api.journalSnapshotSchema.safeParse({ run, manifest, cursor: { epoch: 'control-a', sequence: 1 } }).success, false)
  })
  await check('ECR-02: journal admission preserves valid predecessor/successor work and rejects unrelated same-scope runs or owners', () => {
    const current = { runId: 'run-a', revision: 1 }; const successor = { runId: 'run-b', revision: 2 }
    const unrelated = { runId: 'unrelated-run', revision: 9 }; const owner = { ownerId: 'owner-a', fencingToken: 7 }
    const record = (ref, predecessor = null) => ({ contractVersion: 1, scope, run: ref, definition: definition.ref, state: 'queued', predecessor, createdAt: 1 })
    const event = (run) => ({ contractVersion: 1, eventId: 'adopt-event', source: 'platform', type: 'run.adopted', attribution: { kind: 'assigned', scope, run, step: null, sessionId: null, turnId: null, historySeq: null }, occurredAt: 1, receivedAt: 1, epoch: 'control-a', sequence: 1, payload: {} })
    const operation = (run) => ({ operationId: 'adopt-operation', commandId: 'adopt-command', scope, run, state: 'pending', ownerId: owner.ownerId, fencingToken: owner.fencingToken, result: null })
    const command = { contractVersion: 1, commandId: 'adopt-command', scope, runId: current.runId, expectedRevision: current.revision, kind: 'adopt-revision', payloadDigest: hashA, payload: {}, requestedAt: 1 }
    const valid = { command, owner, expectedCurrent: current, runChanges: [record(current), record(successor, current)], events: [event(successor)], outbox: [operation(successor)] }
    assert.equal(api.journalCommitSchema.safeParse(valid).success, true)
    assert.equal(api.journalCommitSchema.safeParse({ ...valid, runChanges: [record(successor, current)], events: [event(current)], outbox: [operation(current)] }).success, true)
    assert.equal(api.journalCommitSchema.safeParse({ ...valid, runChanges: [record(unrelated)] }).success, false)
    assert.equal(api.journalCommitSchema.safeParse({ ...valid, events: [event(unrelated)] }).success, false)
    assert.equal(api.journalCommitSchema.safeParse({ ...valid, outbox: [operation(unrelated)] }).success, false)
    for (const patch of [{ ownerId: 'foreign-owner' }, { fencingToken: 8 }, { ownerId: null, fencingToken: 0 }]) {
      assert.equal(api.journalCommitSchema.safeParse({ ...valid, outbox: [{ ...operation(successor), ...patch }] }).success, false)
    }
  })
  await check('ECR-02: startup and later commands admit only their target lineage, with one explicit adoption successor', () => {
    const current = { runId: 'run-a', revision: 1 }; const successor = { runId: 'run-b', revision: 2 }
    const record = (ref, predecessor = null) => ({ contractVersion: 1, scope, run: ref, definition: definition.ref, state: 'queued', predecessor, createdAt: 1 })
    const command = { contractVersion: 1, commandId: 'lineage-command', scope, runId: current.runId, expectedRevision: current.revision, kind: 'start', payloadDigest: hashA, payload: {}, requestedAt: 1 }
    const valid = { command, owner: { ownerId: 'owner-a', fencingToken: 1 }, expectedCurrent: null, runChanges: [record(current)], events: [], outbox: [] }
    assert.equal(api.journalCommitSchema.safeParse(valid).success, true)
    assert.equal(api.journalCommitSchema.safeParse({ ...valid, runChanges: [record(successor, current)] }).success, false)
    const adoption = { ...valid, command: { ...command, kind: 'adopt-revision' }, expectedCurrent: current }
    assert.equal(api.journalCommitSchema.safeParse({ ...adoption, runChanges: [record(successor, current)] }).success, true)
    assert.equal(api.journalCommitSchema.safeParse({ ...adoption, runChanges: [record(successor, { runId: 'foreign', revision: 1 })] }).success, false)
    assert.equal(api.journalCommitSchema.safeParse({ ...adoption, runChanges: [record(successor, current), record({ runId: 'second-successor', revision: 2 }, current)] }).success, false)
    for (const kind of ['request-stop', 'reconcile']) {
      const later = { ...adoption, command: { ...command, kind } }
      assert.equal(api.journalCommitSchema.safeParse(later).success, true)
      assert.equal(api.journalCommitSchema.safeParse({ ...later, runChanges: [record(successor, current)] }).success, false)
    }
  })
  await check('ECR-03: snapshot pins the same adopted definition as its run, including the definition revision', () => {
    const run = { contractVersion: 1, scope, run: { runId: 'run-a', revision: 1 }, definition: definition.ref, state: 'queued', predecessor: null, createdAt: 1 }
    const manifest = { contractVersion: 1, scope, run: run.run, definition: definition.ref, roles: [role], executors: [executor], extensions: [], context, inputFingerprint: compiled.inputFingerprint, recordedAt: 1 }
    const valid = { run, manifest, cursor: { epoch: 'control-a', sequence: 1 } }
    assert.equal(api.journalSnapshotSchema.safeParse(valid).success, true)
    assert.equal(api.journalSnapshotSchema.safeParse({ ...valid, manifest: null }).success, true)
    assert.equal(api.journalSnapshotSchema.safeParse({ ...valid, manifest: { ...manifest, definition: { ...definition.ref, definitionId: 'another-definition' } } }).success, false)
    assert.equal(api.journalSnapshotSchema.safeParse({ ...valid, manifest: { ...manifest, definition: { ...definition.ref, revision: definition.ref.revision + 1 } } }).success, false)
  })
  await check('AC04: current migration/reuse contract documents exact pins, clean-room scope and nonintegrated candidates', () => {
    const documentation = readFileSync('docs/workflow-contracts.md', 'utf8')
    for (const required of ['0a1fc56d279fd1001f78387bd81aec1c26767411', '687f282e8625c6b8d11ff58211a90524be2e4317', 'Apache-2.0', 'MIT', 'TPD-009', 'TPD-026', 'not integrated', 'fallback']) assert.ok(documentation.includes(required), required)
  })
  const report = { status: 'passed', scope: 'R0-01 real shared-code contracts and pure projection only', scenarios: results.length, results, engineIntegration: 'not_run', jiraIntegration: 'not_run', persistence: 'not_run', browserRuntime: 'not_run', browserTargetBundle: 'passed' }
  const reportPath = process.argv.indexOf('--report')
  if (reportPath >= 0) {
    const file = process.argv[reportPath + 1]
    if (!file) throw new Error('--report requires a file path')
    writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(`workflow-contracts: ${results.length} scenarios passed; node/browser-target bundles passed; no runtime integration claimed`)
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(temporary.includes('trellis-workflow-contracts-'))
  rmSync(temporary, { recursive: true, force: true })
}
