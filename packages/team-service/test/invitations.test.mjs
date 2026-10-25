/** Real signed OIDC users and HTTP against the owned SQLite worker. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTeamService, parseTeamConfig, teamConfigFromEnvironment, teamInvitationSchema } from '../dist/index.mjs'
import { BrowserAccount, createOidcFixture, freePort } from './oidc-fixture.mjs'

const secret = () => 'ti_' + randomBytes(32).toString('base64url')
test('two signed accounts explicitly accept hash-only invitation links with scoped replay and durable revocation', { timeout: 60000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-invitations-'))
  const origin = `http://127.0.0.1:${await freePort()}`, identity = await createOidcFixture(origin)
  const config = { dataDir: join(directory, 'store'), publicOrigin: origin, oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true }
  let service = await createTeamService(config)
  const listen = () => service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  await listen()
  const alice = new BrowserAccount(origin, 'alice'), bob = new BrowserAccount(origin, 'bob')
  const ok = async (account, path, body) => { const reply = await account.api(path, body); assert.equal(reply.status, 200, JSON.stringify(reply.body)); return reply.body.value }
  let a, b, teamId, projectId, otherProject, creation, invitationId, acceptedInput
  const invite = (overrides = {}) => ({ commandId: randomUUID(), teamId, projectId, teamRoles: ['member'], projectRoles: ['developer', 'tester'], recipient: { kind: 'oidc-subject', subject: 'bob' }, token: secret(), expiresInMs: 60_000, ...overrides })
  const acceptance = (created, input, overrides = {}) => ({ commandId: randomUUID(), token: input.token, expectedUserId: b.person.userId, expectedTeamId: created.teamId, expectedProjectId: created.projectId, ...overrides })
  try {
    await t.test('invitation exists before the recipient first signs in and cannot grant access merely by login', async () => {
      a = await alice.signIn()
      teamId = (await ok(alice, '/api/teams', { commandId: randomUUID(), name: 'Inviting team' })).result.teamId
      projectId = (await ok(alice, '/api/projects', { commandId: randomUUID(), teamId, name: 'Invited project' })).result.projectId
      otherProject = (await ok(alice, '/api/projects', { commandId: randomUUID(), teamId, name: 'Other project' })).result.projectId
      creation = invite()
      const created = await ok(alice, '/api/invitations', creation)
      teamInvitationSchema.parse(created.result); invitationId = created.result.invitationId
      assert.equal(created.result.status, 'pending'); assert.equal('token' in created.result, false)
      const returnTo = `/?invitation=${invitationId}#token=${creation.token}`
      b = await bob.signIn(returnTo)
      assert.equal(bob.lastReturnTo, returnTo)
      assert.notEqual(a.person.userId, b.person.userId)
      assert.equal((await ok(bob, '/api/projects')).items.length, 0)
      assert.equal((await ok(alice, '/api/invitations', creation)).status, 'duplicate')
      assert.equal((await alice.api('/api/invitations', { ...creation, projectRoles: ['admin'] })).status, 409)
      assert.equal((await alice.api('/api/invitations', { ...creation, commandId: randomUUID() })).status, 409)
      assert.deepEqual(identity.observations.logins, ['alice', 'bob'])
    })
    await t.test('authenticated inspection and acceptance reject wrong account, token, target, CSRF, and project', async () => {
      acceptedInput = acceptance({ teamId, projectId }, creation)
      assert.equal((await bob.api(`/api/invitations/${invitationId}/inspect`, { token: creation.token })).status, 200)
      assert.equal((await alice.api(`/api/invitations/${invitationId}/inspect`, { token: creation.token })).status, 403)
      assert.equal((await alice.api(`/api/invitations/${invitationId}/accept`, { ...acceptedInput, expectedUserId: a.person.userId })).status, 403)
      assert.equal((await bob.api(`/api/invitations/${invitationId}/accept`, { ...acceptedInput, token: secret() })).status, 403)
      assert.equal((await bob.api(`/api/invitations/${invitationId}/accept`, { ...acceptedInput, expectedUserId: a.person.userId })).status, 403)
      assert.equal((await bob.api(`/api/invitations/${invitationId}/accept`, { ...acceptedInput, expectedProjectId: otherProject })).status, 403)
      assert.equal((await bob.api(`/api/invitations/${invitationId}/accept`, acceptedInput, { Origin: 'https://foreign.invalid' })).status, 403)
      assert.equal((await bob.api(`/api/invitations/${invitationId}/accept`, acceptedInput, { 'X-CSRF-Token': 'wrong' })).status, 403)
      assert.equal((await bob.api('/api/invitations?teamId=' + teamId)).status, 403)
      assert.equal((await bob.api('/api/invitations', invite())).status, 403)
      const stranger = new BrowserAccount(origin, 'bob')
      assert.equal((await stranger.api(`/api/invitations/${invitationId}/inspect`, { token: creation.token })).status, 401)
    })
    await t.test('one atomic acceptance, concurrent retry, immutable command and actual project ACL', async () => {
      const replies = await Promise.all([bob.api(`/api/invitations/${invitationId}/accept`, acceptedInput), bob.api(`/api/invitations/${invitationId}/accept`, acceptedInput)])
      assert.ok(replies.every((reply) => reply.status === 200), JSON.stringify(replies.map((reply) => reply.body)))
      assert.deepEqual(new Set(replies.map((reply) => reply.body.value.status)), new Set(['committed', 'duplicate']))
      const projects = await ok(bob, '/api/projects'); assert.equal(projects.items.length, 1); assert.equal(projects.items[0].projectId, projectId)
      assert.deepEqual(projects.items[0].roles, ['developer', 'tester'])
      assert.equal((await bob.api(`/api/invitations/${invitationId}/accept`, { ...acceptedInput, commandId: randomUUID() })).status, 409)
      assert.equal((await bob.api(`/api/invitations/${invitationId}/accept`, { ...acceptedInput, expectedTeamId: randomUUID() })).status, 403)
      assert.equal((await ok(bob, `/api/commands/${acceptedInput.commandId}`)).result.acceptedBy, b.person.userId)
      const receipt = await ok(alice, `/api/commands/${creation.commandId}`)
      assert.equal(JSON.stringify(receipt).includes(creation.token), false)
      const events = await ok(alice, '/api/events'); assert.equal(JSON.stringify(events).includes(creation.token), false)
      assert.ok(events.items.some((event) => event.type === 'invitation.accepted'))
    })
    let revokedId, revokedInput, expiredId, expiredInput
    await t.test('list and revoke retain the original invitation identity and never return its secret', async () => {
      revokedInput = invite({ projectId: otherProject, recipient: { kind: 'person', userId: b.person.userId } })
      const created = await ok(alice, '/api/invitations', revokedInput); revokedId = created.result.invitationId
      const revoke = { commandId: randomUUID() }
      assert.equal((await ok(alice, `/api/invitations/${revokedId}/revoke`, revoke)).result.status, 'revoked')
      assert.equal((await ok(alice, `/api/invitations/${revokedId}/revoke`, revoke)).status, 'duplicate')
      assert.equal((await bob.api(`/api/invitations/${revokedId}/accept`, acceptance(created.result, revokedInput))).status, 409)
      const listed = await ok(alice, `/api/invitations?teamId=${teamId}&limit=1`)
      assert.equal(listed.items.length, 1); assert.equal(listed.hasMore, true)
      assert.equal(JSON.stringify(listed).includes(revokedInput.token), false)
      expiredInput = invite({ projectId: otherProject }); expiredId = (await ok(alice, '/api/invitations', expiredInput)).result.invitationId
    })
    await t.test('restart retains hash-only secrets; expiration and old membership revocation survive restoration', async () => {
      await service.close()
      const db = new DatabaseSync(join(config.dataDir, 'team.sqlite'))
      try {
        const stored = db.prepare('SELECT * FROM invitations WHERE invitationId=?').get(invitationId)
        assert.equal(stored.tokenHash, createHash('sha256').update(creation.token).digest('hex'))
        assert.equal(JSON.stringify(stored).includes(creation.token), false)
        const commands = db.prepare('SELECT resultJson FROM commands').all(); assert.equal(JSON.stringify(commands).includes(creation.token), false)
        db.prepare('UPDATE invitations SET expiresAt=? WHERE invitationId=?').run(Date.now() - 1, expiredId)
      } finally { db.close() }
      service = await createTeamService(config); await listen()
      assert.equal((await bob.api(`/api/invitations/${expiredId}/accept`, acceptance({ teamId, projectId: otherProject }, expiredInput))).status, 409)
      assert.equal((await ok(bob, `/api/invitations/${invitationId}/accept`, acceptedInput)).status, 'duplicate')
      const pendingInput = invite(), pending = (await ok(alice, '/api/invitations', pendingInput)).result
      await ok(alice, `/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: b.person.userId, roles: ['developer'], active: false, expectedRevision: 1 })
      assert.equal((await bob.api(`/api/invitations/${invitationId}/accept`, acceptedInput)).status, 403)
      assert.equal((await bob.api(`/api/commands/${acceptedInput.commandId}`)).status, 403)
      await ok(alice, `/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: b.person.userId, roles: ['developer'], active: true, expectedRevision: 2 })
      assert.equal((await bob.api(`/api/invitations/${pending.invitationId}/accept`, acceptance(pending, pendingInput))).status, 409)
      assert.equal((await ok(alice, '/api/invitations?teamId=' + teamId)).items.find((item) => item.invitationId === pending.invitationId).status, 'revoked')
    })
    await t.test('creator demotion permanently revokes old pending invitations after role restoration', async () => {
      const ownedTeam = (await ok(bob, '/api/teams', { commandId: randomUUID(), name: 'Recipient owned team' })).result.teamId
      const ownedProject = (await ok(bob, '/api/projects', { commandId: randomUUID(), teamId: ownedTeam, name: 'Recipient owned project' })).result.projectId
      await ok(bob, `/api/teams/${ownedTeam}/members`, { commandId: randomUUID(), userId: a.person.userId, roles: ['owner'], active: true, expectedRevision: null })
      const pendingInput = invite({ teamId: ownedTeam, projectId: ownedProject, recipient: { kind: 'person', userId: a.person.userId } })
      const pending = (await ok(bob, '/api/invitations', pendingInput)).result
      await ok(alice, `/api/teams/${ownedTeam}/members`, { commandId: randomUUID(), userId: b.person.userId, roles: ['member'], active: true, expectedRevision: 1 })
      assert.equal((await alice.api(`/api/invitations/${pending.invitationId}/accept`, acceptance(pending, pendingInput, { expectedUserId: a.person.userId }))).status, 403)
      await ok(alice, `/api/teams/${ownedTeam}/members`, { commandId: randomUUID(), userId: b.person.userId, roles: ['owner'], active: true, expectedRevision: 2 })
      assert.equal((await alice.api(`/api/invitations/${pending.invitationId}/accept`, acceptance(pending, pendingInput, { expectedUserId: a.person.userId }))).status, 409)
    })
    await t.test('issuer-bound targets, mixed team/project, devices and disabled accounts fail closed', async () => {
      const otherTeam = (await ok(alice, '/api/teams', { commandId: randomUUID(), name: 'Unrelated team' })).result.teamId
      assert.equal((await alice.api('/api/invitations', invite({ teamId: otherTeam }))).status, 409)
      const enrollment = await fetch(origin + '/api/device-pairings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName: 'Invitation permission fixture', projectId, capabilityClaims: [] }) }).then((reply) => reply.json())
      await ok(bob, `/api/device-pairings/${enrollment.value.pairingId}/approve`, { commandId: randomUUID(), expectedProjectId: projectId, userCode: enrollment.value.userCode })
      const native = await fetch(origin + `/api/invitations?teamId=${teamId}`, { headers: { Authorization: `Bearer ${enrollment.value.deviceToken}` } })
      assert.equal(native.status, 403)
      const pendingInput = invite(), pending = (await ok(alice, '/api/invitations', pendingInput)).result
      await ok(alice, `/api/people/${b.person.userId}/status`, { commandId: randomUUID(), active: false, expectedRevision: 1 })
      assert.equal((await bob.api(`/api/invitations/${pending.invitationId}/accept`, acceptance(pending, pendingInput))).status, 401)
      await ok(alice, `/api/people/${b.person.userId}/status`, { commandId: randomUUID(), active: true, expectedRevision: 2 })
      b = await bob.signIn()
      assert.equal((await bob.api(`/api/invitations/${pending.invitationId}/accept`, acceptance(pending, pendingInput))).status, 409)
    })
  } finally {
    await service.close().catch(() => {}); await identity.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-invitations-'))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('private HTTP OIDC transport requires an exact origin allowlist; public or adjacent origins remain rejected', () => {
  const config = { dataDir: './unused-test-data', publicOrigin: 'https://team.example.test', oidc: { issuer: 'http://192.168.1.202:8929', clientId: 'test-only' }, bootstrapSubject: 'owner' }
  assert.throws(() => parseTeamConfig(config), /HTTPS/)
  assert.equal(parseTeamConfig({ ...config, allowedIntranetHttpOrigins: ['http://192.168.1.202:8929'] }).oidc.issuer, config.oidc.issuer)
  assert.throws(() => parseTeamConfig({ ...config, allowedIntranetHttpOrigins: ['http://192.168.1.202:8930'] }), /HTTPS/)
  assert.throws(() => parseTeamConfig({ ...config, allowedIntranetHttpOrigins: ['http://8.8.8.8'] }), /private IPv4/)
  assert.throws(() => parseTeamConfig({ ...config, allowedIntranetHttpOrigins: ['http://0xc0a801ca:8929'] }), /private IPv4/)
  assert.throws(() => parseTeamConfig({ ...config, allowedIntranetHttpOrigins: ['http://192.168.1.202:8929/oauth'] }), /origin/)
  const env = teamConfigFromEnvironment({ TEAM_ALLOWED_INTRANET_HTTP_ORIGINS: 'http://192.168.1.202:8929' })
  assert.deepEqual(env.allowedIntranetHttpOrigins, ['http://192.168.1.202:8929'])
})
