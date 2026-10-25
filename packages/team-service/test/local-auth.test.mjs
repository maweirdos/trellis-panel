import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTeamService, teamAuthOptionsSchema, teamLocalAuthReplySchema, teamIdentitySchema, parseTeamConfig } from '../dist/index.mjs'
import { BrowserAccount, createOidcFixture, freePort } from './oidc-fixture.mjs'

async function local(account, operation, username, password, extra = {}) {
  const options = await account.api('/api/auth/options'); assert.equal(options.status, 200)
  const reply = await account.api(`/auth/local/${operation}`, { username, password, ...(operation === 'register' ? { displayName: username } : {}), ...extra }, { 'X-CSRF-Token': options.body.value.csrfToken })
  if (reply.status === 200) { teamLocalAuthReplySchema.parse(reply.body.value); account.csrf = reply.body.value.session.csrfToken }
  return reply
}
async function hifox(account, projectId, operation, input) {
  const path = `/api/projects/${projectId}/hifox`
  const current = await account.api(`${path}/snapshot`); assert.equal(current.status, 200)
  const reply = await account.api(`${path}/commands`, { commandId: randomUUID(), expectedEpoch: current.body.value.epoch, expectedRevision: current.body.value.revision, operation, input })
  assert.equal(reply.status, 200, JSON.stringify(reply.body))
  return reply.body.value.result
}
test('independent registration, local sessions, cross-account invitation and task collaboration need no OIDC app', { timeout: 30000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-local-accounts-')), origin = `http://127.0.0.1:${await freePort()}`
  const config = { dataDir: join(directory, 'store'), publicOrigin: origin }
  let service = await createTeamService(config)
  const start = () => service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  await start()
  const alice = new BrowserAccount(origin, 'unused'), bob = new BrowserAccount(origin, 'unused')
  const password = 'owned-test-password-123!'
  let a, b, teamId, projectId, inviteInput, invitation, oldCookies
  try {
    await t.test('public auth options expose configured methods and registration never creates an administrator', async () => {
      const options = await alice.api('/api/auth/options'); teamAuthOptionsSchema.parse(options.body.value)
      assert.equal(options.body.value.oidcLogin, false); assert.equal(options.body.value.selfRegistration, true)
      assert.equal((await alice.request('/auth/login')).status, 404)
      const response = await local(alice, 'register', 'Alice.Local', password)
      assert.equal(response.status, 200, JSON.stringify(response.body)); a = response.body.value.session
      assert.equal(a.person.provider, 'local'); assert.equal(a.person.isPlatformAdmin, false)
      const identity = await alice.api('/api/identity'); teamIdentitySchema.parse(identity.body.value)
      assert.equal(identity.body.value.provider, 'local'); assert.equal(identity.body.value.subject, 'alice.local')
      assert.equal((await alice.api('/api/people/' + a.person.userId + '/status', { commandId: randomUUID(), active: false, expectedRevision: 1 })).status, 403)
      teamId = (await alice.api('/api/teams', { commandId: randomUUID(), name: 'Local owners team' })).body.value.result.teamId
      assert.deepEqual((await alice.api(`/api/teams/${teamId}/members`)).body.value.items[0].roles, ['owner'])
      projectId = (await alice.api('/api/projects', { commandId: randomUUID(), teamId, name: 'Local collaborative project' })).body.value.result.projectId
    })
    await t.test('link can precede local registration; correct named account explicitly joins and can use real task authority', async () => {
      inviteInput = { commandId: randomUUID(), teamId, projectId, teamRoles: ['member'], projectRoles: ['developer', 'tester'], recipient: { kind: 'local', username: 'Bob.Local' }, token: 'ti_' + randomBytes(32).toString('base64url') }
      const created = await alice.api('/api/invitations', inviteInput); assert.equal(created.status, 200); invitation = created.body.value.result
      const returnTo = `/?invitation=${invitation.invitationId}#token=${inviteInput.token}`
      const response = await local(bob, 'register', 'BOB.LOCAL', password, { returnTo })
      assert.equal(response.status, 200); assert.equal(response.body.value.returnTo, returnTo); b = response.body.value.session
      assert.notEqual(a.person.userId, b.person.userId); assert.equal(b.person.isPlatformAdmin, false)
      assert.equal((await bob.api('/api/projects')).body.value.items.length, 0)
      assert.equal((await alice.api(`/api/invitations/${invitation.invitationId}/inspect`, { token: inviteInput.token })).status, 403)
      const accepted = await bob.api(`/api/invitations/${invitation.invitationId}/accept`, { commandId: randomUUID(), token: inviteInput.token, expectedUserId: b.person.userId, expectedTeamId: teamId, expectedProjectId: projectId })
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
      const workspace = await bob.api(`/api/projects/${projectId}/hifox/snapshot`); assert.equal(workspace.status, 200)
      assert.equal(workspace.body.value.actor.id, b.person.userId)
      assert.deepEqual((await bob.api('/api/projects')).body.value.items[0].roles, ['developer', 'tester'])
      const space = (await hifox(alice, projectId, 'createSpace', { name: 'Local collaboration', key: 'LOCAL' })).snapshot.spaces[0]
      await hifox(alice, projectId, 'setSpaceMembers', { spaceId: space.id, memberIds: [a.person.userId, b.person.userId] })
      const task = await hifox(bob, projectId, 'createTask', { spaceId: space.id, title: 'Task from the invited local account', assigneeIds: [b.person.userId] })
      const shared = await alice.api(`/api/projects/${projectId}/hifox/snapshot`)
      assert.equal(shared.body.value.snapshot.tasks.find((item) => item.id === task.taskId).creatorId, b.person.userId)
    })
    await t.test('password validation, generic failures, exact login Origin and CSRF prevent bypass and open redirects', async () => {
      assert.equal((await local(new BrowserAccount(origin, ''), 'register', 'short-password', 'short')).status, 400)
      const unknown = await local(new BrowserAccount(origin, ''), 'login', 'missing-person', password)
      const wrong = await local(new BrowserAccount(origin, ''), 'login', 'alice.local', 'wrong-password')
      assert.equal(unknown.status, 401); assert.deepEqual(unknown.body, wrong.body)
      const candidate = new BrowserAccount(origin, '')
      const options = await candidate.api('/api/auth/options')
      assert.equal((await candidate.api('/auth/local/login', { username: 'alice.local', password }, { 'X-CSRF-Token': options.body.value.csrfToken, Origin: 'https://foreign.invalid' })).status, 403)
      assert.equal((await candidate.api('/auth/local/login', { username: 'alice.local', password })).status, 403)
      assert.equal((await candidate.api('/auth/local/register', { username: 'csrf-attempt', password, displayName: 'CSRF test' }, { 'X-CSRF-Token': options.body.value.csrfToken, Origin: 'https://foreign.invalid' })).status, 403)
      assert.equal((await candidate.api('/auth/local/register', { username: 'csrf-attempt', password, displayName: 'CSRF test' })).status, 403)
      assert.equal((await local(candidate, 'login', 'alice.local', 'x'.repeat(257))).status, 400)
      const oversized = await service.app.inject({ method: 'POST', url: '/auth/local/login', headers: { host: new URL(origin).host, 'Content-Type': 'application/json' }, payload: JSON.stringify({ username: 'alice.local', password: 'x'.repeat(2 * 1024 * 1024) }) })
      assert.equal(oversized.statusCode, 413)
      assert.equal((await candidate.api('/api/session')).status, 401)
      assert.equal((await local(candidate, 'login', 'alice.local', password, { returnTo: '//foreign.invalid' })).status, 400)
      assert.equal((await local(candidate, 'register', 'privilege-attempt', password, { isPlatformAdmin: true })).status, 400)
      assert.equal((await local(candidate, 'register', 'ALICE.LOCAL', password)).status, 409)
    })
    await t.test('same browser login rotates the opaque cookie and invalidates the old session while preserving current CSRF', async () => {
      oldCookies = new Map(alice.cookies.get('127.0.0.1'))
      const reply = await local(alice, 'login', 'ALICE.LOCAL', password)
      assert.equal(reply.status, 200)
      assert.notEqual(oldCookies.get('tp_team_session'), alice.cookies.get('127.0.0.1').get('tp_team_session'))
      const old = new BrowserAccount(origin, ''); old.cookies.set('127.0.0.1', oldCookies)
      assert.equal((await old.api('/api/session')).status, 401)
      assert.equal((await alice.api('/api/session')).status, 200)
    })
    await t.test('salted scrypt survives restart without raw passwords in SQLite or command receipts', async () => {
      await service.close()
      const db = new DatabaseSync(join(config.dataDir, 'team.sqlite'))
      try {
        const credentials = db.prepare('SELECT * FROM local_credentials ORDER BY username').all()
        assert.equal(credentials.length, 2); assert.notEqual(credentials[0].salt, credentials[1].salt); assert.notEqual(credentials[0].passwordHash, credentials[1].passwordHash)
        for (const credential of credentials) assert.equal(credential.passwordHash, scryptSync(password, Buffer.from(credential.salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex'))
        assert.equal(db.prepare('SELECT COUNT(*) AS total FROM people WHERE isPlatformAdmin<>0').get().total, 0)
      } finally { db.close() }
      const storedBytes = readFileSync(join(config.dataDir, 'team.sqlite'))
      for (const secret of [password, alice.cookies.get('127.0.0.1').get('tp_team_session'), bob.cookies.get('127.0.0.1').get('tp_team_session'), inviteInput.token]) assert.equal(storedBytes.includes(Buffer.from(secret)), false)
      service = await createTeamService(config); await start()
      assert.equal((await local(bob, 'login', 'bob.local', password)).status, 200)
      assert.equal((await bob.api(`/api/projects/${projectId}/hifox/snapshot`)).status, 200)
    })
    await t.test('logout requires current Origin and CSRF and permanently invalidates its session cookie', async () => {
      for (const headers of [{ Origin: 'https://foreign.invalid' }, { 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'incorrect-token' }]) assert.equal((await alice.api('/auth/logout', {}, headers)).status, 403)
      const noOrigin = await alice.request('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': alice.csrf }, body: '{}' })
      assert.equal(noOrigin.status, 403)
      assert.equal((await alice.api('/api/session')).status, 200)
      const stale = new BrowserAccount(origin, ''); stale.cookies.set('127.0.0.1', new Map(alice.cookies.get('127.0.0.1'))); stale.csrf = alice.csrf
      assert.equal((await alice.api('/auth/logout', {})).status, 200)
      assert.equal((await alice.api('/api/session')).status, 401)
      assert.equal((await stale.api('/api/session')).status, 401)
      assert.equal((await stale.api('/auth/logout', {})).status, 401)
    })
  } finally {
    await service.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-local-accounts-')); rmSync(directory, { recursive: true, force: true })
  }
})

test('optional signed GitLab identity remains separate from same-named local user and disabled local accounts cannot log in', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-mixed-accounts-')), origin = `http://127.0.0.1:${await freePort()}`, oidc = await createOidcFixture(origin)
  const service = await createTeamService({ dataDir: directory, publicOrigin: origin, oidc: { issuer: oidc.issuer, clientId: 'team-owned-fixture' }, gitlabBaseUrl: oidc.issuer, bootstrapSubject: 'alice', allowLoopbackHttp: true })
  await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  try {
    const admin = new BrowserAccount(origin, 'alice'), user = new BrowserAccount(origin, '')
    const gitlab = await admin.signIn(), registered = await local(user, 'register', 'alice', 'owned-local-password!')
    const localPerson = registered.body.value.session.person
    assert.equal(gitlab.person.provider, 'gitlab'); assert.equal(localPerson.provider, 'local'); assert.equal(localPerson.isPlatformAdmin, false); assert.notEqual(localPerson.userId, gitlab.person.userId)
    const team = (await admin.api('/api/teams', { commandId: randomUUID(), name: 'Mixed identity team' })).body.value.result.teamId
    const project = (await admin.api('/api/projects', { commandId: randomUUID(), teamId: team, name: 'Mixed identity project' })).body.value.result.projectId
    const pending = []
    for (const recipient of [{ kind: 'local', username: 'alice' }, { kind: 'oidc-subject', subject: 'alice' }]) {
      const token = 'ti_' + randomBytes(32).toString('base64url')
      const invitation = await admin.api('/api/invitations', { commandId: randomUUID(), teamId: team, projectId: project, recipient, token, teamRoles: ['member'], projectRoles: ['developer'] })
      assert.equal(invitation.status, 200); pending.push(invitation.body.value.result.invitationId)
      const target = recipient.kind === 'local' ? user : admin, other = recipient.kind === 'local' ? admin : user
      const inspect = `/api/invitations/${invitation.body.value.result.invitationId}/inspect`
      assert.equal((await target.api(inspect, { token })).status, 200)
      assert.equal((await other.api(inspect, { token })).status, 403)
    }
    assert.equal((await admin.api(`/api/people/${localPerson.userId}/status`, { commandId: randomUUID(), active: false, expectedRevision: 1 })).status, 200)
    const invitations = (await admin.api(`/api/invitations?teamId=${team}`)).body.value.items
    assert.equal(invitations.find((invitation) => invitation.invitationId === pending[0]).status, 'revoked')
    assert.equal(invitations.find((invitation) => invitation.invitationId === pending[1]).status, 'pending')
    assert.equal((await user.api('/api/session')).status, 401)
    const disabled = await local(user, 'login', 'alice', 'owned-local-password!')
    const unknown = await local(new BrowserAccount(origin, ''), 'login', 'unknown-name', 'owned-local-password!')
    assert.equal(disabled.status, 401); assert.deepEqual(disabled.body, unknown.body)
    assert.equal((await admin.api(`/api/people/${localPerson.userId}/status`, { commandId: randomUUID(), active: true, expectedRevision: 2 })).status, 200)
    assert.equal((await user.api('/api/session')).status, 401)
    assert.equal((await local(user, 'login', 'alice', 'owned-local-password!')).status, 200)
  } finally { await service.close(); await oidc.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-mixed-accounts-')); rmSync(directory, { recursive: true, force: true }) }
})

test('local registration defaults on only for local mode; intranet policy is explicit', () => {
  assert.equal(parseTeamConfig({ dataDir: './unused' }).allowSelfRegistration, true)
  assert.throws(() => parseTeamConfig({ dataDir: './unused', publicOrigin: 'https://team.example.test', deploymentMode: 'intranet' }), /allowSelfRegistration/)
  assert.equal(parseTeamConfig({ dataDir: './unused', publicOrigin: 'https://team.example.test', deploymentMode: 'intranet', allowSelfRegistration: false }).allowSelfRegistration, false)
  assert.equal(parseTeamConfig({ dataDir: './unused', publicOrigin: 'https://team.example.test' }).allowSelfRegistration, false)
})

test('disabled registration and login route rate limit are enforced by actual HTTP before session creation', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-local-auth-policy-')), origin = `http://127.0.0.1:${await freePort()}`
  const service = await createTeamService({ dataDir: directory, publicOrigin: origin, allowSelfRegistration: false })
  await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  try {
    const account = new BrowserAccount(origin, '')
    assert.equal((await account.api('/api/auth/options')).body.value.selfRegistration, false)
    assert.equal((await local(account, 'register', 'closed-registration', 'owned-password-123')).status, 403)
    let reply
    for (let index = 0; index < 21; index++) reply = await local(account, 'login', 'unknown-person', 'owned-password-123')
    assert.equal(reply.status, 429)
    assert.equal((await account.api('/api/session')).status, 401)
  } finally { await service.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-local-auth-policy-')); rmSync(directory, { recursive: true, force: true }) }
})
