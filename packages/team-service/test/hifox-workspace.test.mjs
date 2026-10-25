/** Owned signed OIDC fixture + actual HTTP/worker/SQLite; not a company-SSO or separate-machine claim. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createTeamService, restoreTeamBackup } from '../dist/index.mjs'
import { BrowserAccount, createOidcFixture, freePort } from './oidc-fixture.mjs'

test('workspace authority through real two-user HTTP, commands, private inbox and restart', { timeout: 90_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-hifox-http-'))
  const origin = `http://127.0.0.1:${await freePort()}`
  const identity = await createOidcFixture(origin)
  const config = { dataDir: join(directory, 'store'), publicOrigin: origin, oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true }
  let service
  const alice = new BrowserAccount(origin, 'alice'); const bob = new BrowserAccount(origin, 'bob')
  let aliceId, bobId, teamId, projectId, spaceId, taskId, replay, device
  let memberRevision = 1
  const path = (suffix) => `/api/projects/${projectId}/hifox/${suffix}`
  const snapshot = async (account = alice) => {
    const response = await account.api(path('snapshot'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body.value
  }
  const post = async (account, operation, input, expectedRevision, commandId = randomUUID()) => account.api(path('commands'), { commandId, expectedEpoch: (await snapshot(account)).epoch, expectedRevision, operation, input })
  const command = async (account, operation, input) => {
    const current = await snapshot(account)
    const response = await post(account, operation, input, current.revision)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body.value
  }
  const native = async (token, suffix = 'snapshot', body, project = projectId) => {
    const response = await fetch(`${origin}/api/projects/${project}/hifox/${suffix}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const start = async () => {
    service = await createTeamService(config)
    await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  }
  try {
    await start()
    await t.test('real accounts and empty project workspace have no local/sample identities', async () => {
      aliceId = (await alice.signIn()).person.userId; bobId = (await bob.signIn()).person.userId
      teamId = (await alice.api('/api/teams', { commandId: randomUUID(), name: 'Workspace test team' })).body.value.result.teamId
      assert.equal((await alice.api(`/api/teams/${teamId}/members`, { commandId: randomUUID(), userId: bobId, roles: ['member'], active: true, expectedRevision: null })).status, 200)
      projectId = (await alice.api('/api/projects', { commandId: randomUUID(), teamId, name: 'Workspace project' })).body.value.result.projectId
      assert.equal((await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobId, roles: ['developer'], active: true, expectedRevision: null })).status, 200)
      const initial = await snapshot(bob)
      assert.equal(initial.revision, 0); assert.equal(initial.actor.id, bobId); assert.equal(initial.canManage, false)
      assert.deepEqual(new Set(initial.snapshot.members.map((member) => member.id)), new Set([aliceId, bobId]))
      assert.deepEqual(initial.snapshot.tasks, []); assert.deepEqual(initial.snapshot.spaces, []); assert.deepEqual(initial.snapshot.agents, [])
      assert.equal((await snapshot()).canManage, true)
      const created = await command(alice, 'createSpace', { name: 'Engineering', key: 'ENG' })
      spaceId = created.result.snapshot.spaces[0].id
      await command(alice, 'setSpaceMembers', { spaceId, memberIds: [aliceId, bobId] })
    })

    await t.test('ordinary members cannot configure or impersonate real membership', async () => {
      const revision = (await snapshot(bob)).revision
      for (const [operation, input] of [['createSpace', { name: 'Forbidden', key: 'BAD' }], ['saveAgent', { spaceId, name: 'Forbidden Agent', instructions: 'No execution' }]]) {
        const response = await post(bob, operation, input, revision)
        assert.equal(response.status, 403); assert.equal(response.body.code, 'OPERATION_FORBIDDEN')
      }
      assert.equal((await snapshot(bob)).actor.id, bobId, 'operation denial must preserve authorized project reading')
      for (const [operation, input] of [['inviteMember', { name: 'Fake', role: 'owner' }], ['updateMember', { id: bobId, role: 'owner' }], ['removeMember', { id: bobId }]]) {
        const response = await post(alice, operation, input, revision)
        assert.equal(response.status, 403); assert.equal(response.body.code, 'MANAGEMENT_REQUIRED')
      }
      assert.equal((await snapshot()).revision, revision)
      for (const url of ['file:///C:/private/repo', 'https://user:secret@example.invalid/repo.git']) {
        assert.equal((await post(alice, 'saveAgent', { spaceId, name: 'Unsafe reference', instructions: 'Configuration only', repositories: [{ name: 'Repository', url }] }, revision)).status, 400)
      }
      const elevated = await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobId, roles: ['pm'], active: true, expectedRevision: memberRevision })
      assert.equal(elevated.status, 200); memberRevision++
      assert.equal((await snapshot(bob)).canManage, true)
      assert.ok((await snapshot(bob)).revision > revision)
      await command(bob, 'createLabel', { spaceId, name: 'PM managed label' })
      assert.equal((await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobId, roles: ['developer'], active: true, expectedRevision: memberRevision })).status, 200); memberRevision++
      assert.equal((await snapshot(bob)).canManage, false)
    })

    await t.test('CAS commits one concurrent command and identities are server projected', async () => {
      const head = await snapshot(bob), revision = head.revision
      const inputs = ['One', 'Two'].map((title) => ({ commandId: randomUUID(), expectedEpoch: head.epoch, expectedRevision: revision, operation: 'createTask', input: { spaceId, title, creatorId: aliceId, assigneeIds: [bobId], triagePending: true } }))
      const responses = await Promise.all(inputs.map((input) => bob.api(path('commands'), input)))
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409])
      const winner = responses.findIndex((response) => response.status === 200)
      replay = inputs[winner]; taskId = responses[winner].body.value.result.taskId
      const current = await snapshot(bob)
      assert.equal(current.revision, revision + 1); assert.equal(current.snapshot.tasks.length, 1)
      assert.equal(current.snapshot.tasks[0].creatorId, bobId); assert.equal(taskId, current.snapshot.tasks[0].id)
      assert.equal(current.snapshot.tasks[0].triagePending, true)
      assert.equal(current.snapshot.tasks[0].workflow, undefined, 'legacy intake does not opt into managed handoffs without work kind or criteria')
      assert.equal(current.snapshot.tasks[0].workKind, undefined)
      assert.equal(responses[1 - winner].body.code, 'REVISION_CONFLICT')
      const duplicate = await bob.api(path('commands'), replay)
      assert.equal(duplicate.status, 200); assert.equal(duplicate.body.value.status, 'duplicate'); assert.equal(duplicate.body.value.result.taskId, taskId)
      assert.equal((await bob.api(path('commands'), { ...replay, input: { ...replay.input, title: 'Changed intent' } })).status, 409)
      const epochRevision = (await snapshot(bob)).revision
      for (const stale of [
        { ...replay, expectedEpoch: randomUUID() },
        { commandId: randomUUID(), expectedEpoch: randomUUID(), expectedRevision: epochRevision, operation: 'updateTask', input: { id: taskId, patch: { title: 'Stale epoch must not write' } } }
      ]) {
        const rejected = await bob.api(path('commands'), stale)
        assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'WORKSPACE_EPOCH_CHANGED')
      }
      assert.equal((await snapshot(bob)).revision, epochRevision)
      await command(bob, 'addComment', { taskId, body: 'Verified human comment', authorId: 'agent:forged-agent' })
      assert.equal((await snapshot()).snapshot.comments[0].authorId, bobId)
      await command(bob, 'triage', { taskId, disposition: 'park', actorId: 'agent:forged-agent' })
      assert.equal((await snapshot()).snapshot.triageDecisions[0].actorId, bobId)
      assert.equal((await snapshot()).snapshot.tasks[0].workflow, undefined, 'legacy triage preserves the original API workflow')
      const before = (await snapshot()).revision
      const invalid = await post(bob, 'updateTask', { id: taskId, patch: { title: 'Invalid write', statusId: 'foreign-status' } }, before)
      assert.equal(invalid.status, 400); assert.equal((await snapshot()).revision, before)
      await command(bob, 'updateTask', { id: taskId, patch: { followerToggle: aliceId } })
      assert.deepEqual((await snapshot()).snapshot.tasks[0].followerIds, [bobId])
      await command(bob, 'updateTask', { id: taskId, patch: { assigneeIds: [aliceId] } })
      await command(alice, 'updateTask', { id: taskId, patch: { assigneeIds: [bobId] } })
      const configured = await command(alice, 'saveAgent', { spaceId, name: 'Configuration only', instructions: 'Wait for an actual Runtime', repositories: [{ name: 'Remote repo', url: 'https://example.invalid/repo.git' }] })
      const agent = configured.result.snapshot.agents[0]
      await command(bob, 'updateTask', { id: taskId, patch: { executor: { kind: 'agent', id: agent.id, name: agent.name } } })
      assert.ok(['queued', 'waiting_runtime'].includes((await snapshot()).snapshot.tasks[0].dispatch.status))
    })

    await t.test('private inbox read, snooze, clear and restore never mutate another account', async () => {
      const before = await snapshot(bob); const reminder = before.snapshot.inbox.find((item) => item.kind === 'assign')
      const aliceReminder = (await snapshot(alice)).snapshot.inbox.find((item) => item.kind === 'assign')
      assert.ok(reminder); assert.ok(aliceReminder); assert.notEqual(reminder.id, aliceReminder.id)
      assert.ok(before.snapshot.inbox.every((item) => item.recipientIds.includes(bobId)))
      assert.equal(before.snapshot.inbox.some((item) => item.id === aliceReminder.id), false)
      await command(bob, 'markInboxRead', { all: true })
      assert.ok((await snapshot(bob)).snapshot.inbox.every((item) => item.read))
      assert.ok((await snapshot(alice)).snapshot.inbox.every((item) => !item.read))
      await command(bob, 'snoozeInbox', { id: reminder.id, option: '20m' })
      assert.ok((await snapshot(bob)).snapshot.inbox.find((item) => item.id === reminder.id).snoozedUntil)
      assert.ok((await snapshot(alice)).snapshot.inbox.every((item) => !item.snoozedUntil))
      const revision = (await snapshot(bob)).revision
      assert.equal((await post(bob, 'snoozeInbox', { id: aliceReminder.id, option: '20m' }, revision)).status, 400)
      await command(alice, 'clearInbox', { all: true })
      assert.ok((await snapshot(alice)).snapshot.inbox.every((item) => item.cleared))
      assert.ok((await snapshot(bob)).snapshot.inbox.every((item) => !item.cleared))
      await command(alice, 'restoreInbox', { id: aliceReminder.id })
      assert.equal((await snapshot(alice)).snapshot.inbox.find((item) => item.id === aliceReminder.id).cleared, false)
    })

    await t.test('bounded long polling observes commits within 500ms and validates queries', async () => {
      const revision = (await snapshot(bob)).revision
      const waiting = bob.api(path(`snapshot?afterRevision=${revision}&waitMs=2000`))
      await delay(80)
      await command(alice, 'updateTask', { id: taskId, patch: { title: 'Visible on another client' } })
      const committedAt = Date.now(); const response = await waiting
      assert.equal(response.status, 200); assert.ok(response.body.value.revision > revision)
      assert.ok(Date.now() - committedAt < 500)
      assert.equal(response.body.value.snapshot.tasks[0].title, 'Visible on another client')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal((await alice.api(path('snapshot?waitMs=10001'))).status, 400)
      assert.equal((await alice.api(path('snapshot?afterRevision=1.2'))).status, 400)
      const timedAt = Date.now()
      assert.equal((await alice.api(path(`snapshot?afterRevision=${response.body.value.revision}&waitMs=180`))).status, 200)
      assert.ok(Date.now() - timedAt >= 160)
    })

    await t.test('project-bound device, member revocation during a wait and retry reauthorization', async () => {
      const enrollment = await bob.api('/api/device-pairings', { deviceName: 'Workspace native client', projectId, capabilityClaims: [] })
      // Enrollment is a desktop-only endpoint, so use a request without browser cookie/Origin.
      assert.equal(enrollment.status, 403)
      const enrolled = await fetch(`${origin}/api/device-pairings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName: 'Workspace native client', projectId, capabilityClaims: [] }) })
      device = (await enrolled.json()).value
      assert.equal((await bob.api(`/api/device-pairings/${device.pairingId}/approve`, { commandId: randomUUID(), expectedProjectId: projectId, userCode: device.userCode })).status, 200)
      assert.equal((await native(device.deviceToken)).status, 200)
      const another = (await alice.api('/api/projects', { commandId: randomUUID(), teamId, name: 'Other private project' })).body.value.result.projectId
      assert.equal((await native(device.deviceToken, 'snapshot', undefined, another)).status, 403)
      const revision = (await snapshot(bob)).revision
      const waiting = bob.api(path(`snapshot?afterRevision=${revision}&waitMs=2000`))
      await delay(80)
      const revoked = await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobId, roles: ['developer'], active: false, expectedRevision: memberRevision })
      assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
      memberRevision++
      const revokedAt = Date.now(); const response = await waiting
      assert.equal(response.status, 403); assert.equal(response.body.code, 'FORBIDDEN'); assert.ok(Date.now() - revokedAt < 500)
      assert.equal((await bob.api(path('commands'), replay)).status, 403)
      assert.equal((await bob.api(`/api/commands/${replay.commandId}`)).status, 403)
      assert.ok([401, 403].includes((await native(device.deviceToken)).status))
      assert.equal((await snapshot()).snapshot.members.some((member) => member.id === bobId), false)
      assert.equal((await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobId, roles: ['developer'], active: true, expectedRevision: memberRevision })).status, 200)
      memberRevision++
      assert.ok([401, 403].includes((await native(device.deviceToken)).status))
    })

    await t.test('SQLite restart preserves original receipts and private inbox state', async () => {
      const before = await snapshot(bob)
      await service.store.backup(join(directory, 'backup'))
      const restoredDirectory = join(directory, 'restored')
      restoreTeamBackup(join(directory, 'backup'), restoredDirectory)
      const restored = await createTeamService({ ...config, dataDir: restoredDirectory })
      try {
        const cookies = [...(bob.cookies.get(new URL(origin).hostname) ?? new Map())].map(([key, value]) => `${key}=${value}`).join('; ')
        const headers = { Host: new URL(origin).host, Cookie: cookies }
        const restoredSnapshot = await restored.app.inject({ method: 'GET', url: path('snapshot'), headers })
        assert.equal(restoredSnapshot.statusCode, 200, restoredSnapshot.body)
        const restoredHead = restoredSnapshot.json().value
        assert.deepEqual(restoredHead.snapshot, before.snapshot)
        assert.equal(restoredHead.instanceId, before.instanceId)
        assert.notEqual(restoredHead.epoch, before.epoch)
        const receipt = await restored.app.inject({ method: 'POST', url: path('commands'), headers: { ...headers, Origin: origin, 'X-CSRF-Token': bob.csrf }, payload: replay })
        assert.equal(receipt.statusCode, 409, receipt.body); assert.equal(receipt.json().code, 'WORKSPACE_EPOCH_CHANGED')
        const fresh = { commandId: randomUUID(), expectedEpoch: before.epoch, expectedRevision: restoredHead.revision, operation: 'updateTask', input: { id: taskId, patch: { title: 'Stale generation write' } } }
        const rejected = await restored.app.inject({ method: 'POST', url: path('commands'), headers: { ...headers, Origin: origin, 'X-CSRF-Token': bob.csrf }, payload: fresh })
        assert.equal(rejected.statusCode, 409, rejected.body); assert.equal(rejected.json().code, 'WORKSPACE_EPOCH_CHANGED')
        const unchanged = await restored.app.inject({ method: 'GET', url: path('snapshot'), headers })
        assert.equal(unchanged.json().value.revision, restoredHead.revision)
        assert.deepEqual(unchanged.json().value.snapshot, restoredHead.snapshot)
        const historical = await restored.app.inject({ method: 'GET', url: `/api/commands/${replay.commandId}`, headers })
        assert.equal(historical.statusCode, 200, historical.body)
        assert.equal(historical.json().value.result.epoch, replay.expectedEpoch, 'historical receipt must prove the original command epoch')
        assert.equal(historical.json().value.result.instanceId, before.instanceId)
        assert.equal(historical.json().value.result.revision, replay.expectedRevision + 1)
        assert.equal(historical.json().value.result.authorizationRevision, restoredHead.authorizationRevision)
      } finally { await restored.close() }
      const waiting = bob.api(path(`snapshot?afterRevision=${before.revision}&waitMs=10000`))
      await delay(40)
      const closingAt = Date.now()
      await service.close(); service = undefined
      assert.ok(Date.now() - closingAt < 1000)
      const cancelled = await waiting
      assert.equal(cancelled.status, 503)
      await start()
      const after = await snapshot(bob)
      assert.equal(after.revision, before.revision); assert.deepEqual(after.snapshot, before.snapshot)
      const duplicate = await bob.api(path('commands'), replay)
      assert.equal(duplicate.status, 200); assert.equal(duplicate.body.value.status, 'duplicate')
      assert.equal(duplicate.body.value.result.taskId, taskId)
      assert.equal((await snapshot()).snapshot.tasks.length, 1)
      const receipt = await bob.api(`/api/commands/${replay.commandId}`)
      assert.equal(receipt.status, 200)
    })

    await t.test('account disable rechecks existing session and historical command', async () => {
      const response = await alice.api(`/api/people/${bobId}/status`, { commandId: randomUUID(), active: false, expectedRevision: 1 })
      assert.equal(response.status, 200)
      assert.equal((await bob.api(path('snapshot'))).status, 401)
      assert.equal((await bob.api(path('commands'), replay)).status, 401)
      assert.equal((await bob.api(`/api/commands/${replay.commandId}`)).status, 401)
    })
  } finally {
    await service?.close(); await identity.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-hifox-http-'))
    rmSync(directory, { recursive: true, force: true })
  }
})

for (const legacyVersion of [4, 5]) test(`additive v${legacyVersion} workspace migration preserves the existing service identity`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-hifox-migration-'))
  const config = { dataDir: join(directory, 'store'), publicOrigin: 'https://team-owned.invalid', oidc: { issuer: 'https://issuer-owned.invalid', clientId: 'owned-fixture' }, bootstrapSubject: 'alice' }
  let service
  try {
    service = await createTeamService(config)
    const before = await service.store.call('health', {})
    await service.close(); service = undefined
    const database = new DatabaseSync(join(config.dataDir, 'team.sqlite'))
    try {
      for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'hifox_workspace_%'").all()) {
        assert.match(row.name, /^hifox_workspace_[a-z_]+$/)
        database.exec(`DROP TRIGGER ${row.name};`)
      }
      database.exec('DROP TABLE hifox_inbox_preferences; DROP TABLE hifox_workspaces;')
      if (legacyVersion === 4) database.exec('DROP TABLE invitations;')
      database.exec(`PRAGMA user_version=${legacyVersion};`)
    }
    finally { database.close() }
    service = await createTeamService(config)
    const after = await service.store.call('health', {})
    assert.equal(after.instanceId, before.instanceId); assert.equal(after.epoch, before.epoch)
    await service.close(); service = undefined
    const migrated = new DatabaseSync(join(config.dataDir, 'team.sqlite'), { readOnly: true })
    try { assert.equal(migrated.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE name IN ('invitations','hifox_workspaces','hifox_inbox_preferences')").get().total, 3) }
    finally { migrated.close() }
  } finally {
    await service?.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-hifox-migration-'))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('space privacy, real self-join, private roster authority and archive boundaries through HTTP/SQLite', { timeout: 90_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-hifox-space-acl-'))
  const origin = `http://127.0.0.1:${await freePort()}`
  const identity = await createOidcFixture(origin)
  const config = { dataDir: join(directory, 'store'), publicOrigin: origin, oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true }
  const alice = new BrowserAccount(origin, 'alice'), bob = new BrowserAccount(origin, 'bob')
  let service, projectId, aliceId, bobId, publicSpace, privateSpace, alicePrivate, publicTask, secretTask, secretAgent, secretCrew, secretSkill, globalSkill, globalLabel, secretType, secretStatus, privateReceipt
  const route = (suffix) => `/api/projects/${projectId}/hifox/${suffix}`
  const read = async (account = alice) => {
    const response = await account.api(route('snapshot'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body.value
  }
  const post = async (account, operation, input, commandId = randomUUID()) => {
    const head = await read(account)
    return account.api(route('commands'), { commandId, operation, input, expectedEpoch: head.epoch, expectedRevision: head.revision })
  }
  const write = async (account, operation, input) => {
    const response = await post(account, operation, input)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    return response.body.value.result
  }
  const rejected = async (account, operation, input, status) => {
    const before = await read(account)
    const response = await post(account, operation, input)
    assert.equal(response.status, status, `${operation}: ${JSON.stringify(response.body)}`)
    if (status === 403) assert.equal(response.body.code, 'SPACE_ACCESS_DENIED', `${operation} must not report whole-project revocation`)
    assert.equal((await read(account)).revision, before.revision, `${operation} changed revision despite rejection`)
    return response
  }
  const contains = (snapshot, token) => JSON.stringify(snapshot).includes(token)
  try {
    service = await createTeamService(config)
    await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
    aliceId = (await alice.signIn()).person.userId; bobId = (await bob.signIn()).person.userId
    const teamId = (await alice.api('/api/teams', { commandId: randomUUID(), name: 'Space privacy team' })).body.value.result.teamId
    assert.equal((await alice.api(`/api/teams/${teamId}/members`, { commandId: randomUUID(), userId: bobId, roles: ['member'], active: true, expectedRevision: null })).status, 200)
    projectId = (await alice.api('/api/projects', { commandId: randomUUID(), teamId, name: 'Space boundary project' })).body.value.result.projectId
    assert.equal((await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobId, roles: ['pm'], active: true, expectedRevision: null })).status, 200)

    await t.test('private creator is the authenticated PM, public join ignores a forged member', async () => {
      publicSpace = (await write(alice, 'createSpace', { name: 'Shared name', key: 'PUB1234' })).snapshot.spaces.at(-1).id
      publicTask = (await write(alice, 'createTask', { spaceId: publicSpace, title: 'Public task' })).taskId
      assert.ok((await read(bob)).snapshot.tasks.some((task) => task.id === publicTask), 'public task reading does not require joining')
      await rejected(bob, 'createTask', { spaceId: publicSpace, title: 'Must join before creating' }, 400)
      privateSpace = (await write(bob, 'createSpace', { name: 'Shared name', key: 'SEC', visibility: 'private' })).snapshot.spaces.at(-1).id
      const own = (await read(bob)).snapshot.spaces.find((space) => space.id === privateSpace)
      assert.equal(own.ownerId, bobId); assert.deepEqual(own.memberIds, [bobId])
      assert.ok((await read()).snapshot.spaces.find((space) => space.id === publicSpace).visibility === 'public')
      const publicBefore = (await read(bob)).snapshot.spaces.find((space) => space.id === publicSpace)
      assert.equal(publicBefore.memberIds.includes(bobId), false)
      await write(bob, 'joinSpace', { spaceId: publicSpace, memberId: aliceId })
      assert.deepEqual(new Set((await read()).snapshot.spaces.find((space) => space.id === publicSpace).memberIds), new Set([aliceId, bobId]))
      await rejected(alice, 'joinSpace', { spaceId: privateSpace, memberId: bobId }, 403)
      await rejected(alice, 'setSpaceMembers', { spaceId: privateSpace, memberIds: [aliceId, bobId] }, 403)
      const metadata = (await read()).snapshot.spaces.find((space) => space.id === privateSpace)
      assert.deepEqual(metadata.memberIds, []); assert.equal(metadata.ownerId, undefined)
      await write(alice, 'updateSpace', { id: privateSpace, description: 'Administrators can manage metadata' })
      assert.deepEqual((await read(bob)).snapshot.spaces.find((space) => space.id === privateSpace).memberIds, [bobId])
    })

    await t.test('all private payload collections and cross-space references are filtered for a nonmember admin', async () => {
      assert.match(publicTask, /^PUB1234-1$/)
      secretTask = (await write(bob, 'createTask', { spaceId: privateSpace, title: 'Secret body sentinel', description: 'Private task description' })).taskId
      secretType = (await write(bob, 'createTaskType', { spaceId: privateSpace, name: 'Secret type sentinel' })).snapshot.taskTypes.at(-1).id
      secretStatus = (await write(bob, 'createTaskStatus', { spaceId: privateSpace, name: 'Secret status sentinel', category: 'todo' })).snapshot.taskStatuses.at(-1).id
      await write(bob, 'createLabel', { spaceId: privateSpace, name: 'Secret label sentinel' })
      globalLabel = (await write(alice, 'createLabel', { name: 'Organization label' })).snapshot.taskLabels.at(-1).id
      secretSkill = (await write(bob, 'saveSkill', { spaceId: privateSpace, name: 'Secret skill sentinel', content: 'Secret skill content' })).snapshot.skills.at(-1).id
      globalSkill = (await write(alice, 'saveSkill', { name: 'Organization skill', content: 'Shared knowledge' })).snapshot.skills.at(-1).id
      secretAgent = (await write(bob, 'saveAgent', { spaceId: privateSpace, name: 'Secret agent sentinel', instructions: 'Private instructions', skillIds: [secretSkill, globalSkill] })).snapshot.agents.at(-1).id
      secretCrew = (await write(bob, 'saveCrew', { spaceId: privateSpace, name: 'Secret crew sentinel', captainAgentId: secretAgent, memberRefs: [{ kind: 'member', id: bobId }] })).snapshot.crews.at(-1).id
      await write(bob, 'createProject', { spaceId: privateSpace, name: 'Secret project sentinel' })
      await write(bob, 'createIteration', { spaceId: privateSpace, name: 'Secret iteration sentinel', startDate: '2026-10-01', endDate: '2026-10-31', taskIds: [secretTask] })
      await write(bob, 'saveView', { spaceId: privateSpace, name: 'Secret view sentinel', filter: { typeIds: [secretType] }, groupBy: 'status' })
      await write(bob, 'addComment', { taskId: secretTask, authorId: aliceId, body: 'Secret comment sentinel' })
      await write(bob, 'saveAutomation', { spaceId: privateSpace, name: 'Secret automation sentinel', trigger: { kind: 'comment', value: 'Secret' }, target: { kind: 'member', id: bobId }, instruction: 'Secret reminder sentinel' })
      const rule = (await read(bob)).snapshot.automations.at(-1)
      await write(bob, 'runAutomation', { id: rule.id })
      await write(bob, 'addRelation', { taskId: publicTask, relation: { kind: 'related', taskId: secretTask } })
      const visible = (await read()).snapshot
      for (const collection of ['taskTypes', 'taskStatuses', 'taskLabels', 'tasks', 'projects', 'iterations', 'views', 'automations', 'agents', 'skills', 'crews']) assert.ok(visible[collection].every((entry) => entry.spaceId !== privateSpace), collection)
      assert.equal(contains(visible, 'Secret'), false)
      assert.equal(contains(visible, secretTask), false, 'reverse relation activities must not reveal a private task identifier')
      assert.deepEqual(visible.tasks.find((task) => task.id === publicTask).relations, [])
      assert.ok(visible.skills.some((skill) => skill.id === globalSkill)); assert.ok(visible.taskLabels.some((label) => label.id === globalLabel))
      assert.ok((await read(bob)).snapshot.inbox.some((item) => item.spaceId === privateSpace && !item.taskId && item.body === 'Secret reminder sentinel'))
      await rejected(alice, 'addComment', { taskId: secretTask, authorId: aliceId, body: 'Forbidden' }, 403)
      await rejected(alice, 'updateTask', { id: secretTask, patch: { title: 'Forbidden' } }, 403)
      await rejected(alice, 'addRelation', { taskId: publicTask, relation: { kind: 'blocks', taskId: secretTask } }, 403)
      await rejected(alice, 'removeRelation', { taskId: publicTask, targetTaskId: secretTask }, 403)
      await rejected(alice, 'removeTask', { id: publicTask }, 403)
      await rejected(alice, 'saveView', { spaceId: publicSpace, name: 'Foreign view', filter: { typeIds: [secretType] }, groupBy: 'type' }, 403)
      await rejected(alice, 'createTask', { spaceId: publicSpace, title: 'Foreign parent', parentTaskId: secretTask }, 403)
      await rejected(alice, 'removeSkill', { id: globalSkill }, 403)
    })

    await t.test('ordinary members self-join public spaces and private members manage their real roster', async () => {
      alicePrivate = (await write(alice, 'createSpace', { name: 'Alice private', key: 'ALI', visibility: 'private' })).snapshot.spaces.at(-1).id
      await write(alice, 'createTask', { spaceId: alicePrivate, title: 'Alice-only task' })
      assert.equal((await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobId, roles: ['developer'], active: true, expectedRevision: 1 })).status, 200)
      assert.equal((await read(bob)).snapshot.spaces.some((space) => space.id === alicePrivate), false)
      const newlyPublic = (await write(alice, 'createSpace', { name: 'Open membership', key: 'OPEN' })).snapshot.spaces.at(-1).id
      await write(bob, 'joinSpace', { spaceId: newlyPublic, memberId: aliceId })
      assert.ok((await read(bob)).snapshot.spaces.find((space) => space.id === newlyPublic).memberIds.includes(bobId))
      await rejected(bob, 'joinSpace', { spaceId: alicePrivate }, 403)
      await write(bob, 'setSpaceMembers', { spaceId: privateSpace, memberIds: [aliceId, bobId] })
      assert.ok((await read()).snapshot.tasks.some((task) => task.id === secretTask))
      const commandId = randomUUID(), head = await read()
      privateReceipt = { commandId, expectedEpoch: head.epoch, expectedRevision: head.revision, operation: 'addComment', input: { taskId: secretTask, authorId: aliceId, body: 'Historical secret receipt' } }
      assert.equal((await alice.api(route('commands'), privateReceipt)).status, 200)
      const publicHead = await read()
      const publicReceipt = { commandId: randomUUID(), expectedEpoch: publicHead.epoch, expectedRevision: publicHead.revision, operation: 'createTask', input: { spaceId: publicSpace, title: 'Public historical command' } }
      const publicCreated = await alice.api(route('commands'), publicReceipt)
      assert.equal(publicCreated.status, 200)
      assert.ok(contains(publicCreated.body.value.result.snapshot, 'Secret body sentinel'))
      await write(bob, 'setSpaceMembers', { spaceId: privateSpace, memberIds: [bobId] })
      const replay = await alice.api(route('commands'), privateReceipt)
      assert.equal(replay.status, 200); assert.equal(contains(replay.body.value.result.snapshot, 'Secret body sentinel'), false)
      const receipt = await alice.api(`/api/commands/${commandId}`)
      assert.equal(receipt.status, 200); assert.equal(contains(receipt.body, 'Secret body sentinel'), false)
      for (const response of [await alice.api(route('commands'), publicReceipt), await alice.api(`/api/commands/${publicReceipt.commandId}`)]) {
        assert.equal(response.status, 200)
        assert.equal(contains(response.body, 'Secret body sentinel'), false, 'a public command receipt must hide unrelated private bodies after revocation')
      }
      const replayedPublic = await alice.api(route('commands'), publicReceipt)
      assert.equal(replayedPublic.body.value.result.taskId, publicCreated.body.value.result.taskId)
      assert.equal(replayedPublic.body.value.result.revision, publicCreated.body.value.result.revision)
      assert.equal(replayedPublic.body.value.result.serverTime, publicCreated.body.value.result.serverTime)
      const latestHead = await read()
      assert.equal(replayedPublic.body.value.result.epoch, latestHead.epoch)
      assert.equal(replayedPublic.body.value.result.authorizationRevision, latestHead.authorizationRevision)
      await rejected(bob, 'setSpaceMembers', { spaceId: privateSpace, memberIds: [bobId, 'local-owner'] }, 400)
      assert.deepEqual(new Set((await read()).snapshot.members.map((member) => member.id)), new Set([aliceId, bobId]))
    })

    await t.test('archive rejects unfinished tasks and every mutation checks both sides of archived relations', async () => {
      const failure = await rejected(alice, 'updateSpace', { id: privateSpace, archived: true }, 400)
      assert.match(failure.body.error, /取消|移到/)
      const own = (await read(bob)).snapshot
      const cancelled = own.taskStatuses.find((status) => status.spaceId === privateSpace && status.category === 'cancelled').id
      await write(bob, 'updateTask', { id: secretTask, patch: { statusId: cancelled } })
      await write(alice, 'updateSpace', { id: privateSpace, archived: true })
      const archived = (await read(bob)).snapshot
      assert.equal(archived.spaces.find((space) => space.id === privateSpace).archived, true)
      assert.ok(archived.tasks.some((task) => task.id === secretTask))
      assert.ok(archived.automations.filter((rule) => rule.spaceId === privateSpace).every((rule) => !rule.enabled))
      for (const [operation, input, account] of [
        ['createTask', { spaceId: privateSpace, title: 'Forbidden archived task' }, bob],
        ['updateTask', { id: secretTask, patch: { title: 'Forbidden edit' } }, bob],
        ['addComment', { taskId: secretTask, authorId: bobId, body: 'Forbidden comment' }, bob],
        ['setSpaceMembers', { spaceId: privateSpace, memberIds: [aliceId, bobId] }, bob],
        ['joinSpace', { spaceId: privateSpace }, bob],
        ['removeRelation', { taskId: publicTask, targetTaskId: secretTask }, bob],
        ['removeTask', { id: publicTask }, bob],
        ['updateSpace', { id: privateSpace, description: 'Forbidden metadata' }, alice],
        ['createLabel', { spaceId: privateSpace, name: 'Forbidden label' }, alice],
        ['updateSpace', { id: privateSpace, archived: false, name: 'Restore must be separate' }, alice]
      ]) await rejected(account, operation, input, account === alice && operation === 'createLabel' ? 403 : 400)
      await write(alice, 'updateSpace', { id: privateSpace, archived: false })
      await write(bob, 'addComment', { taskId: secretTask, authorId: bobId, body: 'Writable after restore' })
      const readonlySpace = (await write(alice, 'createSpace', { name: 'Readonly config', key: 'READ' })).snapshot.spaces.at(-1).id
      await write(alice, 'updateSpace', { id: readonlySpace, archived: true })
      for (const [operation, input] of [
        ['createTask', { spaceId: readonlySpace, title: 'Forbidden' }],
        ['createTaskType', { spaceId: readonlySpace, name: 'Forbidden' }],
        ['createTaskStatus', { spaceId: readonlySpace, name: 'Forbidden', category: 'todo' }],
        ['createLabel', { spaceId: readonlySpace, name: 'Forbidden' }],
        ['createProject', { spaceId: readonlySpace, name: 'Forbidden' }],
        ['createIteration', { spaceId: readonlySpace, name: 'Forbidden', startDate: '2026-10-01', endDate: '2026-10-31' }],
        ['saveView', { spaceId: readonlySpace, name: 'Forbidden', filter: {}, groupBy: 'status' }],
        ['saveAgent', { spaceId: readonlySpace, name: 'Forbidden', instructions: 'Readonly' }],
        ['saveSkill', { spaceId: readonlySpace, name: 'Forbidden', content: 'Readonly' }],
        ['saveCrew', { spaceId: readonlySpace, name: 'Forbidden', captainAgentId: secretAgent, memberRefs: [] }],
        ['saveAutomation', { spaceId: readonlySpace, name: 'Forbidden', trigger: { kind: 'task_created' }, target: { kind: 'none' } }]
      ]) assert.match((await rejected(alice, operation, input, 400)).body.error, /停用/)
      await rejected(bob, 'joinSpace', { spaceId: readonlySpace }, 400)
      await service.close(); service = undefined
      service = await createTeamService(config); await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
      assert.equal((await read()).snapshot.spaces.find((space) => space.id === privateSpace).archived, false)
      assert.deepEqual((await read()).snapshot.spaces.find((space) => space.id === privateSpace).memberIds, [])
      assert.deepEqual((await read(bob)).snapshot.spaces.find((space) => space.id === privateSpace).memberIds, [bobId])
    })
  } finally {
    await service?.close(); await identity.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-hifox-space-acl-'))
    rmSync(directory, { recursive: true, force: true })
  }
})
