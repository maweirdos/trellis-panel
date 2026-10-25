/** Real authenticated HTTP, worker SQLite and portable pure-domain regression with owned fixture accounts. */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { createTeamService, restoreTeamBackup } from '../dist/index.mjs'
import { BrowserAccount, createOidcFixture, freePort } from './oidc-fixture.mjs'

const domainDirectory = mkdtempSync(join(tmpdir(), 'trellis-creations-domain-'))
after(async () => {
  assert.equal(dirname(resolve(domainDirectory)), resolve(tmpdir()))
  assert.ok(basename(domainDirectory).startsWith('trellis-creations-domain-'))
  await rm(domainDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
const bundle = join(domainDirectory, 'domain.cjs')
await build({ stdin: { contents: "export * from './creations'; export * from './creations-domain'", resolveDir: fileURLToPath(new URL('../../../src/shared/', import.meta.url)), loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node24' })
const shared = createRequire(import.meta.url)(bundle)
const sha = (value) => createHash('sha256').update(value).digest('hex')

test('pure model is atomic, bounded and desktop reusable', () => {
  const actorId = randomUUID(), editorId = randomUUID(), reviewerId = randomUUID(), spaceId = 's-local', projectId = 'local', taskId = 'task-local'
  const ctx = { projectId, actorId, now: Date.now(), epoch: randomUUID(), activeMemberIds: [actorId, editorId, reviewerId], spaces: [{ id: spaceId, memberIds: [actorId, editorId, reviewerId], canRead: true, canWrite: true, archived: false }], tasks: [{ id: taskId, spaceId }], digestBody: sha }
  const common = { creationId: randomUUID(), expectedRevision: null, action: 'create', title: 'Local prototype', kind: 'prototype', home: 'team', spaceId, editorIds: [editorId], body: '<h1>A</h1>', privateNotes: 'Owner secret' }
  let record = shared.executeCreationCommand(null, { commandId: randomUUID(), ...common }, ctx)
  const initial = structuredClone(record)
  assert.throws(() => shared.executeCreationCommand(record, { commandId: randomUUID(), creationId: record.creationId, expectedRevision: 0, action: 'saveDraft', body: 'bad' }, ctx))
  assert.deepEqual(record, initial)
  const editCtx = { ...ctx, actorId: editorId }
  assert.equal(shared.viewCreation(record, editCtx).selected.body, '<h1>A</h1>')
  assert.equal(shared.viewCreation(record, editCtx).privateNotes, undefined)
  record = shared.executeCreationCommand(record, { commandId: randomUUID(), creationId: record.creationId, expectedRevision: record.revision, action: 'saveDraft', body: '<h1>B</h1>' }, editCtx)
  assert.equal(record.draft.bodyDigest, sha('<h1>B</h1>'))
  assert.throws(() => shared.executeCreationCommand(record, { commandId: randomUUID(), creationId: record.creationId, expectedRevision: record.revision, action: 'saveDraft', body: 'bad', privateNotes: 'Intrusion' }, editCtx), /cannot access/)
  assert.throws(() => shared.executeCreationCommand(record, { commandId: randomUUID(), creationId: record.creationId, expectedRevision: record.revision, expectedEpoch: randomUUID(), action: 'publish', spaceId, reviewerIds: [] }, ctx), (e) => e.code === 'EPOCH_CONFLICT')
  assert.equal(shared.creationBodySchema.safeParse('中'.repeat(90_000)).success, false)
  assert.equal(shared.creationBodySchema.safeParse('a'.repeat(256 * 1024)).success, true)
  assert.equal(shared.creationTargetSchema.safeParse({ kind: 'web', selector: 'main > button', context: { route: '/filters', fields: [{ name: 'status', value: 'open' }] } }).success, true)
  for (const fields of [[{ name: 'password', value: 'unsafe' }], [{ selector: '[name=api-token]', value: 'unsafe' }], [{ name: 'normal', value: '<html>' }]]) assert.equal(shared.creationTargetSchema.safeParse({ kind: 'web', selector: 'button', context: { fields } }).success, false)
  assert.equal(shared.creationTargetSchema.safeParse({ kind: 'web', selector: 'button', screenshotRefs: ['data:image/png;base64,aaa'] }).success, false)
  const commands = (fields) => ({ commandId: randomUUID(), creationId: record.creationId, expectedRevision: record.revision, ...fields })
  const pub = commands({ action: 'publish', spaceId, reviewerIds: [reviewerId] }); record = shared.executeCreationCommand(record, pub, ctx)
  for (let i = 1; i < 40; i++) record = shared.executeCreationCommand(record, commands({ action: 'publish', spaceId, reviewerIds: [reviewerId] }), ctx)
  const bounded = structuredClone(record)
  assert.throws(() => shared.executeCreationCommand(record, commands({ action: 'publish', spaceId, reviewerIds: [reviewerId] }), ctx), (e) => e.code === 'CAPACITY_EXCEEDED')
  assert.deepEqual(record, bounded)
  assert.equal(shared.creationScenarioSchema.safeParse({ id: 'manual', title: 'Manual expectation', preconditions: [], steps: ['Click'], expectedResult: 'Expected only' }).success, true)
  assert.throws(() => shared.createInitialCreationRecord({ ...common, commandId: randomUUID(), scenarios: Array.from({ length: 41 }, (_, i) => ({ id: String(i), title: 'Manual', preconditions: [], steps: ['Click'], expectedResult: 'Expected only' })) }, ctx))
  const archiveCtx = { ...ctx, spaces: ctx.spaces.map((entry) => ({ ...entry, archived: true })) }
  assert.throws(() => shared.executeCreationCommand(record, commands({ action: 'saveDraft', body: 'Archive must reject' }), archiveCtx), (e) => e.code === 'SPACE_ARCHIVED')
  let carried = structuredClone(initial)
  const apply = (fields, actor = ctx) => {
    const command = { commandId: randomUUID(), creationId: carried.creationId, expectedRevision: carried.revision, ...fields }
    carried = shared.executeCreationCommand(carried, command, actor); return command
  }
  const reviewCtx = { ...ctx, actorId: reviewerId }
  const first = apply({ action: 'publish', spaceId, reviewerIds: [reviewerId] }).commandId
  const immutableTarget = { kind: 'web', selector: 'main > button', context: { fields: [{ name: 'status', value: 'empty' }] } }
  const oldOpinion = apply({ action: 'annotate', revisionId: first, target: immutableTarget, severity: 'required', body: 'Disable empty approval' }, reviewCtx).commandId
  const second = apply({ action: 'publish', spaceId, reviewerIds: [reviewerId] }).commandId
  const futureOpinion = apply({ action: 'annotate', revisionId: second, target: { kind: 'general' }, severity: 'question', body: 'A future R2 question' }, reviewCtx).commandId
  assert.equal(shared.viewCreation(carried, reviewCtx, { revisionId: second }).comments.some((entry) => entry.commentId === oldOpinion), true)
  assert.equal(shared.viewCreation(carried, reviewCtx, { revisionId: first }).comments.some((entry) => entry.commentId === futureOpinion), false)
  assert.throws(() => apply({ action: 'adoptForTask', taskId, revisionId: second, confirmedCommentIds: [] }), (e) => e.code === 'REQUIRED_OPINIONS_OPEN')
  apply({ action: 'disposition', commentId: oldOpinion, status: 'confirmed', finalRule: 'Disable empty approval.', reviewRevisionId: first }, reviewCtx)
  assert.throws(() => apply({ action: 'adoptForTask', taskId, revisionId: second, confirmedCommentIds: [oldOpinion] }), (e) => e.code === 'RULE_CONFLICT')
  assert.throws(() => apply({ action: 'disposition', commentId: futureOpinion, status: 'confirmed', finalRule: 'Old context forbidden.', reviewRevisionId: first }, reviewCtx), (e) => e.code === 'REVIEW_CONTEXT_CONFLICT')
  apply({ action: 'disposition', commentId: oldOpinion, status: 'confirmed', finalRule: 'Disable empty approval.', reviewRevisionId: second }, reviewCtx)
  assert.throws(() => apply({ action: 'adoptForTask', taskId, revisionId: first, confirmedCommentIds: [] }), (e) => e.code === 'REQUIRED_OPINIONS_OPEN')
  apply({ action: 'adoptForTask', taskId, revisionId: second, confirmedCommentIds: [oldOpinion] })
  const pin = structuredClone(carried.adoptions[0])
  assert.equal(pin.confirmedRules[0].sourceRevisionId, first); assert.equal(pin.confirmedRules[0].reviewedRevisionId, second)
  assert.deepEqual(pin.confirmedRules[0].target, immutableTarget); assert.equal(pin.confirmedRules[0].originalBody, 'Disable empty approval')
  apply({ action: 'disposition', commentId: oldOpinion, status: 'open' }, reviewCtx)
  const third = apply({ action: 'publish', spaceId, reviewerIds: [reviewerId] }).commandId
  assert.throws(() => apply({ action: 'adoptForTask', taskId, revisionId: third, confirmedCommentIds: [] }), (e) => e.code === 'REQUIRED_OPINIONS_OPEN')
  assert.deepEqual(carried.adoptions[0], pin)
  assert.deepEqual(shared.summarizeCreation(carried, ctx).adoptions[0].confirmedRules, [])
  assert.deepEqual(shared.summarizeCreation(carried, ctx, { taskId }).adoptions[0].confirmedRules, pin.confirmedRules)
})

test('real authenticated HTTP, writer SQLite, review pins and reauthorization', { timeout: 120_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-creations-http-'))
  const origin = `http://127.0.0.1:${await freePort()}`, identity = await createOidcFixture(origin)
  const config = { dataDir: join(directory, 'store'), publicOrigin: origin, oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true }
  const alice = new BrowserAccount(origin, 'alice'), bob = new BrowserAccount(origin, 'bob')
  let service, projectId, teamId, spaceId, foreignSpaceId, taskId, task2Id, foreignTaskId, aliceId, bobId, personalId, teamCreationId, r1, r2, r3, originalPublish, requiredId, originalAdopt
  const start = async () => { service = await createTeamService(config); await service.app.listen({ host: '127.0.0.1', port: Number(new URL(origin).port) }) }
  const path = (suffix = '') => `/api/projects/${projectId}/creations${suffix}`
  const snap = async (who = alice) => (await who.api(`/api/projects/${projectId}/hifox/snapshot`)).body.value
  const hifox = async (operation, input, who = alice) => {
    const current = await snap(who), response = await who.api(`/api/projects/${projectId}/hifox/commands`, { commandId: randomUUID(), expectedEpoch: current.epoch, expectedRevision: current.revision, operation, input })
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.value.result
  }
  const view = async (id, who = alice, revisionId) => {
    const response = await who.api(path(`/${id}${revisionId ? '?revisionId=' + revisionId : ''}`))
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.value
  }
  const request = async (id, fields, who = alice, expectedRevision) => {
    const current = fields.action === 'create' ? null : await view(id, who)
    return { commandId: randomUUID(), creationId: id, expectedRevision: expectedRevision ?? current?.summary.revision ?? null, expectedEpoch: (await snap(who)).epoch, ...fields }
  }
  const post = (body, who = alice) => who.api(path('/commands'), body)
  const head = async (who = alice) => {
    const response = await who.api(path('/head'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(shared.creationHeadSchema.safeParse(response.body.value).success, true)
    assert.deepEqual(Object.keys(response.body.value).sort(), ['epoch', 'fingerprint', 'projectId'])
    assert.ok(Buffer.byteLength(JSON.stringify(response.body)) < 256)
    return response.body.value
  }
  const command = async (id, fields, who = alice) => {
    const body = await request(id, fields, who), response = await post(body, who)
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(shared.creationCommandReplySchema.safeParse(response.body.value).success, true)
    return { body, result: response.body.value.result }
  }
  try {
    await start()
    aliceId = (await alice.signIn()).person.userId; bobId = (await bob.signIn()).person.userId
    teamId = (await alice.api('/api/teams', { commandId: randomUUID(), name: 'Creation test team' })).body.value.result.teamId
    assert.equal((await alice.api(`/api/teams/${teamId}/members`, { commandId: randomUUID(), userId: bobId, roles: ['member'], active: true, expectedRevision: null })).status, 200)
    projectId = (await alice.api('/api/projects', { commandId: randomUUID(), teamId, name: 'Creation project' })).body.value.result.projectId
    assert.equal((await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobId, roles: ['developer'], active: true, expectedRevision: null })).status, 200)
    spaceId = (await hifox('createSpace', { name: 'Private Review', key: 'REV', visibility: 'private' })).snapshot.spaces[0].id
    await hifox('setSpaceMembers', { spaceId, memberIds: [aliceId, bobId] })
    foreignSpaceId = (await hifox('createSpace', { name: 'Other space', key: 'OTH', visibility: 'private' })).snapshot.spaces.find((x) => x.id !== spaceId).id
    taskId = (await hifox('createTask', { spaceId, title: 'Implement approved review' })).taskId
    task2Id = (await hifox('createTask', { spaceId, title: 'Second consumer' })).taskId
    foreignTaskId = (await hifox('createTask', { spaceId: foreignSpaceId, title: 'Foreign task' })).taskId

    await t.test('v8 to v9 additive migration retains identity, workspace, publication, receipts and verified backups', async () => {
      const publication = { commandId: randomUUID(), materialId: randomUUID(), projectId, visibility: 'project', title: 'Retained schema 8 document', kind: 'design', text: '\uFEFF# Retained before creations\n原始正文\n', source: { kind: 'authored', sourceId: 'schema-8-document', version: 'original' }, expectedVersion: null }
      const published = await alice.api('/api/materials', publication)
      assert.equal(published.status, 200, JSON.stringify(published.body))
      const documentPath = `/api/materials/${publication.materialId}/versions/1`
      const originalDocument = await bob.api(documentPath)
      assert.equal(originalDocument.status, 200, JSON.stringify(originalDocument.body))
      const before = await snap(), bobBefore = await snap(bob), identityBefore = await service.store.call('health', {})
      await service.close()
      const db = new DatabaseSync(join(config.dataDir, 'team.sqlite'))
      try {
        db.exec('DROP TABLE creation_task_references; DROP TABLE creations; PRAGMA user_version=8')
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8)
        assert.equal(db.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name IN ('creations','creation_task_references')").get().total, 0)
      } finally { db.close() }
      await start()
      const identityAfter = await service.store.call('health', {})
      assert.equal(identityAfter.schemaVersion, 9)
      assert.equal(identityAfter.instanceId, identityBefore.instanceId)
      assert.equal(identityAfter.epoch, identityBefore.epoch)
      assert.deepEqual((await snap()).snapshot, before.snapshot)
      assert.deepEqual((await bob.api(documentPath)).body, originalDocument.body)
      assert.equal((await alice.api('/api/materials', publication)).body.value.status, 'duplicate')
      assert.equal((await alice.api(path())).status, 200)

      const backup = join(directory, 'migrated-backup'), restored = join(directory, 'migrated-restored')
      const saved = await service.store.backup(backup)
      assert.ok(saved.blobCount >= 1)
      const originalBackup = readFileSync(join(backup, 'team.sqlite')), originalManifest = readFileSync(join(backup, 'backup.json'))
      assert.equal(JSON.parse(originalManifest.toString('utf8')).databaseSchemaVersion, 9)
      const result = restoreTeamBackup(backup, restored)
      assert.equal(result.instanceId, identityBefore.instanceId)
      assert.notEqual(result.epoch, identityBefore.epoch)
      const restoredService = await createTeamService({ ...config, dataDir: restored })
      try {
        const cookies = [...(bob.cookies.get(new URL(origin).hostname) ?? new Map())].map(([key, value]) => `${key}=${value}`).join('; ')
        const headers = { host: new URL(origin).host, cookie: cookies }
        const document = await restoredService.app.inject({ method: 'GET', url: documentPath, headers })
        assert.equal(document.statusCode, 200, document.body)
        assert.deepEqual(document.json(), originalDocument.body)
        const workspace = await restoredService.app.inject({ method: 'GET', url: `/api/projects/${projectId}/hifox/snapshot`, headers })
        assert.equal(workspace.statusCode, 200, workspace.body)
        assert.deepEqual(workspace.json().value.snapshot, bobBefore.snapshot)
        const head = await restoredService.store.call('health', {})
        assert.equal(head.schemaVersion, 9)
        assert.equal(head.epoch, result.epoch)
      } finally { await restoredService.close() }
      assert.deepEqual(readFileSync(join(backup, 'team.sqlite')), originalBackup)
      assert.deepEqual(readFileSync(join(backup, 'backup.json')), originalManifest)
    })

    await t.test('actual UTF-8 bounds and strict server actor prevent admission', async () => {
      const id = randomUUID(), body = await request(id, { action: 'create', title: 'Overflow', kind: 'prototype', home: 'personal', spaceId: null, body: '中'.repeat(90_000) })
      assert.equal((await post(body)).status, 400)
      assert.equal((await alice.api(`/api/commands/${body.commandId}`)).status, 404)
      assert.equal((await post({ ...body, body: 'small', actorId: bobId })).status, 400)
    })

    await t.test('personal raw drafts and notes remain owner-only even against bootstrap admin', async () => {
      const bobPrivate = randomUUID()
      await command(bobPrivate, { action: 'create', title: 'Bob secret', kind: 'document', home: 'personal', spaceId: null, body: 'Bob original secret', privateNotes: 'Bob note secret' }, bob)
      assert.equal((await alice.api(path(`/${bobPrivate}`))).status, 403)
      assert.equal(JSON.stringify((await alice.api(path('?scope=personal'))).body).includes('Bob secret'), false)
      personalId = randomUUID()
      await command(personalId, { action: 'create', title: 'Personal published title', kind: 'prototype', home: 'personal', spaceId: null, body: '<h1>Published A</h1>', privateNotes: 'Alice personal note' })
      originalPublish = (await command(personalId, { action: 'publish', spaceId, reviewerIds: [bobId], editorIds: [bobId] })).body
      const selected = await view(personalId, bob)
      assert.equal(selected.selected.body, '<h1>Published A</h1>'); assert.equal(selected.draft, undefined); assert.equal(selected.privateNotes, undefined)
      assert.equal(selected.revisions.some((entry) => 'body' in entry), false)
      await command(personalId, { action: 'saveDraft', title: 'Unpublished secret title', body: '<p>Private B</p>', privateNotes: 'Alice changed note' })
      const draft = await view(personalId), candidate = await command(personalId, { action: 'candidateSave', body: '<p>Candidate C</p>', baseDraftRevision: draft.draft.serial, selectedCommentIds: [] })
      assert.equal((await view(personalId, alice, candidate.result.candidateId)).selected.body, '<p>Candidate C</p>')
      for (const revisionId of [draft.draft.revisionId, candidate.result.candidateId]) assert.equal((await bob.api(path(`/${personalId}?revisionId=${revisionId}`))).status, 404)
      for (const action of [{ action: 'saveDraft', body: 'Forbidden' }, { action: 'candidateSave', body: 'Forbidden', baseDraftRevision: draft.draft.serial, selectedCommentIds: [] }, { action: 'publish', spaceId, reviewerIds: [] }]) assert.equal((await post(await request(personalId, action, bob), bob)).status, 403)
      const list = await bob.api(path('?scope=team'))
      assert.equal(list.status, 200); const json = JSON.stringify(list.body)
      for (const secret of ['Private B', 'Candidate C', 'Unpublished secret', 'Alice changed note', 'comments', 'privateNotes']) assert.equal(json.includes(secret), false, secret)
      assert.equal(list.body.value.items.find((entry) => entry.creationId === personalId).title, 'Personal published title')
      assert.equal(JSON.stringify(await alice.api(`/api/commands/${candidate.body.commandId}`)).includes('Candidate C'), false)
    })

    await t.test('team coauthor edits preserve notes and immutable selected revisions', async () => {
      teamCreationId = randomUUID()
      await command(teamCreationId, { action: 'create', title: 'Team prototype', kind: 'prototype', home: 'team', spaceId, editorIds: [bobId], body: '<button id="approve">Approve R1</button>', privateNotes: 'Only Alice private note', scenarios: [{ id: 's1', title: 'Approve', preconditions: ['User signed in'], steps: ['Press approve'], expectedResult: 'Dialog opens' }] })
      assert.equal((await view(teamCreationId, bob)).selected.published, false)
      assert.equal((await view(teamCreationId, bob)).privateNotes, undefined)
      assert.equal((await post(await request(teamCreationId, { action: 'saveDraft', body: 'bad', privateNotes: 'intrusion' }, bob), bob)).status, 403)
      await command(teamCreationId, { action: 'saveDraft', body: '<button id="approve">Approve R1 by Bob</button>' }, bob)
      r1 = (await command(teamCreationId, { action: 'publish', spaceId, reviewerIds: [bobId] }, bob)).result.revisionId
      await command(teamCreationId, { action: 'saveDraft', body: '<button id="approve">Approve R2</button>' }, bob)
      r2 = (await command(teamCreationId, { action: 'publish', spaceId, reviewerIds: [bobId] })).result.revisionId
      assert.equal((await view(teamCreationId, bob, r1)).selected.body.includes('R1 by Bob'), true)
      assert.equal((await view(teamCreationId, bob, r2)).selected.number, 2)
      assert.equal((await view(teamCreationId)).privateNotes, 'Only Alice private note')
      assert.equal((await post(await request(teamCreationId, { action: 'publish', spaceId, reviewerIds: [randomUUID()] }))).body.code, 'REVIEWER_SCOPE_CONFLICT')
    })

    await t.test('required R1 review carries into R2 without exposing future-origin comments in R1', async () => {
      const inherited = (await command(teamCreationId, { action: 'annotate', revisionId: r1, target: { kind: 'general' }, body: 'Inherited R1 requirement', severity: 'required' }, bob)).result.commentId
      const future = (await command(teamCreationId, { action: 'annotate', revisionId: r2, target: { kind: 'general' }, body: 'Future R2 question', severity: 'question' }, bob)).result.commentId
      assert.equal((await view(teamCreationId, bob, r2)).comments.some((entry) => entry.commentId === inherited), true)
      assert.equal((await view(teamCreationId, bob, r1)).comments.some((entry) => entry.commentId === future), false)
      assert.equal((await post(await request(teamCreationId, { action: 'adoptForTask', taskId, revisionId: r2, confirmedCommentIds: [] }))).body.code, 'REQUIRED_OPINIONS_OPEN')
      await command(teamCreationId, { action: 'disposition', commentId: inherited, status: 'confirmed', finalRule: 'Confirmed while inspecting R2.', reviewRevisionId: r2 }, bob)
      assert.equal((await view(teamCreationId, bob, r2)).comments.find((entry) => entry.commentId === inherited).reviewedRevisionId, r2)
      assert.equal((await post(await request(teamCreationId, { action: 'adoptForTask', taskId, revisionId: r1, confirmedCommentIds: [] }))).body.code, 'REQUIRED_OPINIONS_OPEN')
    })

    await t.test('structured review, human rules and only required open opinions block adoption', async () => {
      const target = { kind: 'web', stableId: 'approve', selector: 'main > button#approve', role: 'button', name: 'Approve', box: { x: .1, y: .2, width: .3, height: .1 }, state: 'focus', screenshotRefs: ['shot-001'], context: { route: '/reviews', hash: '#selected', scroll: { x: 0, y: 250 }, viewport: { width: 1280, height: 720 }, fields: [{ selector: 'select[name=status]', name: 'status', value: 'open' }] } }
      requiredId = (await command(teamCreationId, { action: 'annotate', revisionId: r2, target, body: 'Require explicit confirmation', severity: 'required' }, bob)).result.commentId
      await command(teamCreationId, { action: 'reply', commentId: requiredId, body: 'Accepted for review' }, bob)
      const blocked = await post(await request(teamCreationId, { action: 'adoptForTask', taskId, revisionId: r2, confirmedCommentIds: [] }))
      assert.equal(blocked.body.code, 'REQUIRED_OPINIONS_OPEN')
      assert.equal((await post(await request(teamCreationId, { action: 'disposition', commentId: requiredId, status: 'confirmed' }))).body.code, 'FINAL_RULE_REQUIRED')
      await command(teamCreationId, { action: 'disposition', commentId: requiredId, status: 'confirmed', finalRule: 'Require a confirmation dialog before approval.' })
      await command(teamCreationId, { action: 'annotate', revisionId: r2, target: { kind: 'general' }, body: 'Optional spacing polish', severity: 'suggestion' }, bob)
      await command(teamCreationId, { action: 'annotate', revisionId: r2, target: { kind: 'scenario', scenarioId: 's1' }, body: 'What happens offline?', severity: 'question' }, bob)
      assert.equal((await post(await request(teamCreationId, { action: 'adoptForTask', taskId: foreignTaskId, revisionId: r2, confirmedCommentIds: [requiredId] }))).body.code, 'TASK_SCOPE_CONFLICT')
      const before = structuredClone((await snap()).snapshot.tasks)
      originalAdopt = (await command(teamCreationId, { action: 'adoptForTask', taskId, revisionId: r2, confirmedCommentIds: [requiredId] })).body
      await command(teamCreationId, { action: 'adoptForTask', taskId: task2Id, revisionId: r2, confirmedCommentIds: [] }, bob)
      const pinned = (await view(teamCreationId)).summary.adoptions.find((entry) => entry.taskId === taskId)
      assert.equal(pinned.bodyDigest, sha('<button id="approve">Approve R2</button>'))
      assert.equal(pinned.confirmedRules[0].finalRule, 'Require a confirmation dialog before approval.')
      assert.deepEqual(pinned.confirmedRules[0].target, target)
      assert.equal(pinned.confirmedRules[0].originalBody, 'Require explicit confirmation')
      await command(teamCreationId, { action: 'saveDraft', body: '<h1>R3</h1>' })
      r3 = (await command(teamCreationId, { action: 'publish', spaceId, reviewerIds: [bobId] })).result.revisionId
      await command(teamCreationId, { action: 'disposition', commentId: requiredId, status: 'open' })
      assert.deepEqual((await view(teamCreationId)).summary.adoptions.find((entry) => entry.taskId === taskId), pinned)
      assert.deepEqual((await snap()).snapshot.tasks, before)
      assert.equal(JSON.stringify((await snap()).snapshot).includes('<button'), false)
      const byTask = await bob.api(path(`?scope=team&taskId=${taskId}`))
      assert.equal(byTask.status, 200); assert.equal(byTask.body.value.items.length, 1)
      assert.equal(byTask.body.value.items[0].adoptions.length, 1)
      assert.equal(byTask.body.value.items[0].adoptions[0].revisionId, r2)
      const defaultList = await bob.api(path('?scope=team'))
      assert.ok(defaultList.body.value.items.every((item) => item.adoptions.every((entry) => entry.confirmedRules.length === 0)))
      const selected = await view(teamCreationId, bob, r2)
      assert.deepEqual(selected.comments.find((entry) => entry.commentId === requiredId).target, target)
      assert.ok(selected.comments.every((entry) => selected.revisions.find((item) => item.revisionId === entry.revisionId).number <= 2))
    })

    await t.test('authorized metadata head sees other-user review and authorization changes without exposing invisible personal creations', async () => {
      const aliceBefore = await head(), bobBefore = await head(bob), hiddenId = randomUUID()
      await command(hiddenId, { action: 'create', title: 'Hidden personal head title', kind: 'document', home: 'personal', spaceId: null, body: 'Hidden personal head body', privateNotes: 'Hidden personal head note' }, bob)
      assert.deepEqual(await head(), aliceBefore)
      const bobAfterCreate = await head(bob)
      assert.notEqual(bobAfterCreate.fingerprint, bobBefore.fingerprint)
      await command(hiddenId, { action: 'saveDraft', body: 'Hidden edited body', privateNotes: 'Hidden edited note' }, bob)
      assert.deepEqual(await head(), aliceBefore)
      assert.notEqual((await head(bob)).fingerprint, bobAfterCreate.fingerprint)
      const beforeAnnotation = await head()
      await command(teamCreationId, { action: 'annotate', revisionId: r2, target: { kind: 'general' }, severity: 'question', body: 'Review received from another computer account' }, bob)
      const afterAnnotation = await head()
      assert.notEqual(afterAnnotation.fingerprint, beforeAnnotation.fingerprint)
      assert.equal(afterAnnotation.epoch, beforeAnnotation.epoch)
      for (const hidden of ['Hidden', 'body', 'privateNotes', 'comments', 'html']) assert.equal(JSON.stringify(afterAnnotation).includes(hidden), false)
      const visibleBefore = (await alice.api(path('?scope=team'))).body.value.items.map((entry) => [entry.creationId, entry.revision])
      const roleChanged = await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobId, roles: ['developer', 'tester'], active: true, expectedRevision: 1 })
      assert.equal(roleChanged.status, 200, JSON.stringify(roleChanged.body))
      assert.deepEqual((await alice.api(path('?scope=team'))).body.value.items.map((entry) => [entry.creationId, entry.revision]), visibleBefore)
      assert.notEqual((await head()).fingerprint, afterAnnotation.fingerprint)
      assert.equal((await fetch(origin + path('/head'))).status, 401)
    })

    await t.test('CAS, stale candidates and original UUID retry preserve unknown outcomes', async () => {
      const base = await view(teamCreationId), epoch = (await snap()).epoch
      const concurrent = await Promise.all(['A', 'B'].map((value) => post({ commandId: randomUUID(), creationId: teamCreationId, expectedRevision: base.summary.revision, expectedEpoch: epoch, action: 'saveDraft', body: `<h1>Concurrent ${value}</h1>` })))
      assert.deepEqual(concurrent.map((entry) => entry.status).sort(), [200, 409])
      assert.equal((await view(teamCreationId)).summary.revision, base.summary.revision + 1)
      const stale = await request(teamCreationId, { action: 'saveDraft', body: 'stale attempt' })
      const draftNote = await command(teamCreationId, { action: 'annotate', revisionId: (await view(teamCreationId)).selected.revisionId, target: { kind: 'general' }, severity: 'question', body: 'Private draft discussion' })
      const source = await view(teamCreationId)
      const generated = await command(teamCreationId, { action: 'candidateSave', body: '<h1>Candidate</h1>', baseDraftRevision: source.draft.serial, selectedCommentIds: [requiredId] })
      assert.equal((await post(stale)).body.code, 'REVISION_CONFLICT')
      assert.equal((await post(generated.body)).body.value.status, 'duplicate')
      assert.equal((await post({ ...generated.body, body: 'changed intent' })).body.code, 'COMMAND_CONFLICT')
      assert.equal((await view(teamCreationId, bob, generated.result.candidateId)).selected.body, '<h1>Candidate</h1>')
      await command(teamCreationId, { action: 'saveDraft', body: '<h1>Later user draft</h1>' })
      assert.equal((await post(draftNote.body)).body.value.status, 'duplicate')
      assert.equal((await post(await request(teamCreationId, { action: 'candidateAdopt', candidateId: generated.result.candidateId }))).body.code, 'DRAFT_CONFLICT')
      await command(teamCreationId, { action: 'candidateDiscard', candidateId: generated.result.candidateId })
      const freshSource = await view(teamCreationId), fresh = await command(teamCreationId, { action: 'candidateSave', body: '<h1>Fresh candidate</h1>', baseDraftRevision: freshSource.draft.serial, selectedCommentIds: [] })
      await command(teamCreationId, { action: 'candidateAdopt', candidateId: fresh.result.candidateId })
      assert.equal((await view(teamCreationId)).selected.body, '<h1>Fresh candidate</h1>')
      assert.equal((await view(teamCreationId, alice, r3)).selected.body, '<h1>R3</h1>')
      const receipt = await alice.api(`/api/commands/${generated.body.commandId}`)
      assert.equal(receipt.status, 200); assert.equal(receipt.body.value.result.candidateId, generated.result.candidateId)
      assert.equal(JSON.stringify(receipt.body).includes('Candidate</h1>'), false)
      const lost = await request(teamCreationId, { action: 'saveDraft', body: '<h1>Acknowledgement lost</h1>' })
      const response = await alice.request(path('/commands'), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': alice.csrf }, body: JSON.stringify(lost) })
      assert.equal(response.status, 200); await response.body.cancel()
      assert.equal((await alice.api(`/api/commands/${lost.commandId}`)).body.value.result.creationId, teamCreationId)
      assert.equal((await post(lost)).body.value.status, 'duplicate')
    })

    await t.test('CSRF, epoch fence and data-free bounded pagination', async () => {
      const body = await request(personalId, { action: 'saveDraft', body: 'CSRF must not write' })
      assert.equal((await post({ ...body, expectedEpoch: randomUUID() })).body.code, 'EPOCH_CONFLICT')
      const csrf = await alice.api(path('/commands'), body, { 'X-CSRF-Token': 'wrong' })
      assert.equal(csrf.status, 403); assert.equal(csrf.body.code, 'CSRF_REJECTED')
      const page = await alice.api(path('?scope=team&limit=1'))
      assert.equal(page.status, 200); assert.equal(page.body.value.items.length, 1); assert.equal(page.body.value.hasMore, true)
      const next = await alice.api(path(`?scope=team&limit=1&cursor=${encodeURIComponent(page.body.value.nextCursor)}`))
      assert.equal(next.status, 200); assert.notEqual(next.body.value.items[0].creationId, page.body.value.items[0].creationId)
      assert.equal((await bob.api(path(`?scope=team&limit=1&cursor=${encodeURIComponent(page.body.value.nextCursor)}`))).body.code, 'CURSOR_CONFLICT')
      const str = JSON.stringify(page.body)
      assert.ok(Buffer.byteLength(str) < shared.CREATION_MAX_RESPONSE_BYTES)
      for (const key of ['"body"', '"comments"', '"privateNotes"', '"candidate"', '"draft"']) assert.equal(str.includes(key), false)
    })

    await t.test('replay reauthorizes original space and participants on POST and receipt lookup', async () => {
      const old = (await command(teamCreationId, { action: 'annotate', revisionId: r3, target: { kind: 'general' }, body: 'Bob review grant', severity: 'question' }, bob)).body
      const beforeRevocation = await head(bob)
      await hifox('setSpaceMembers', { spaceId, memberIds: [aliceId] })
      assert.notEqual((await head(bob)).fingerprint, beforeRevocation.fingerprint)
      assert.equal((await bob.api(path(`/${teamCreationId}`))).status, 403)
      assert.equal((await post(old, bob)).status, 403)
      assert.equal((await bob.api(`/api/commands/${old.commandId}`)).status, 403)
      assert.equal((await post(originalPublish)).body.code, 'REVIEWER_SCOPE_CONFLICT')
      assert.equal((await alice.api(`/api/commands/${originalPublish.commandId}`)).status, 403)
      assert.equal((await bob.api(path('?scope=team'))).body.value.items.length, 0)
      await hifox('setSpaceMembers', { spaceId, memberIds: [aliceId, bobId] })
      assert.equal((await post(old, bob)).body.value.status, 'duplicate')
      const cancelled = (await snap()).snapshot.taskStatuses.find((entry) => entry.spaceId === spaceId && entry.category === 'cancelled').id
      for (const id of [taskId, task2Id]) await hifox('updateTask', { id, patch: { statusId: cancelled } })
      await hifox('updateSpace', { id: spaceId, archived: true })
      assert.equal((await post(await request(teamCreationId, { action: 'saveDraft', body: 'archived change' }))).body.code, 'SPACE_ARCHIVED')
      assert.equal((await view(teamCreationId, bob, r2)).selected.number, 2)
      await hifox('updateSpace', { id: spaceId, archived: false })
    })

    await t.test('restart retains immutable bodies, pins and command receipts; digest corruption fails closed', async () => {
      const before = await view(teamCreationId, alice, r2)
      await service.close(); await start()
      assert.deepEqual(await view(teamCreationId, alice, r2), before)
      assert.equal((await post(originalAdopt)).body.value.status, 'duplicate')
      const oldEpoch = (await snap()).epoch, backup = join(directory, 'creation-backup'), restored = join(directory, 'creation-restored')
      await service.store.backup(backup)
      restoreTeamBackup(backup, restored)
      await service.close(); config.dataDir = restored; await start()
      assert.notEqual((await snap()).epoch, oldEpoch)
      assert.deepEqual(await view(teamCreationId, alice, r2), before)
      assert.equal((await post(originalAdopt)).body.code, 'EPOCH_CONFLICT')
      assert.equal((await alice.api(`/api/commands/${originalAdopt.commandId}`)).body.code, 'EPOCH_CONFLICT')
      const beforeCorruption = await head()
      await service.close()
      const db = new DatabaseSync(join(config.dataDir, 'team.sqlite'))
      const row = db.prepare('SELECT recordJson FROM creations WHERE creationId=?').get(teamCreationId), data = JSON.parse(row.recordJson)
      data.revisions[0].body = 'tampered bytes'
      const json = JSON.stringify(data)
      db.prepare('UPDATE creations SET recordJson=?,byteLength=? WHERE creationId=?').run(json, Buffer.byteLength(json), teamCreationId); db.close()
      await start()
      assert.deepEqual(await head(), beforeCorruption, 'Metadata head must not read or hash changed recordJson/body bytes')
      const response = await alice.api(path(`/${teamCreationId}?revisionId=${r1}`))
      assert.equal(response.status, 503); assert.equal(response.body.code, 'CORRUPT_STORE')
    })
  } finally {
    try { await service?.close() }
    finally {
      await identity.close()
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('trellis-creations-http-'))
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})
