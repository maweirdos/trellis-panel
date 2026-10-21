import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createTeamService, restoreTeamBackup, teamSessionSchema, teamPublishedDocumentSchema, teamDeviceEnrollmentSchema, teamDeviceSchema, teamEventPageSchema, teamPageSchema, teamFeedbackSchema, parseTeamDevicePairing } from '../dist/index.mjs'
import { BrowserAccount, createOidcFixture, freePort } from './oidc-fixture.mjs'

test('real OIDC accounts, HTTP clients, SQLite worker, immutable publication and recovery', { timeout: 90000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-http-'))
  const origin = `http://127.0.0.1:${await freePort()}`
  const identity = await createOidcFixture(origin)
  const config = { dataDir: join(directory, 'store'), publicOrigin: origin, oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true, onlineTtlMs: 1000, pairingTtlMs: 2000 }
  let service = await createTeamService(config)
  await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  const alice = new BrowserAccount(origin, 'alice'); const bob = new BrowserAccount(origin, 'bob')
  const records = []
  let completed = false
  let aliceSession, bobSession, teamId, projectId, otherProjectId, materialId, privateId, bobMaterialId, bobPublication, device, originalPublication, latestPublication, priorCursor
  const check = async (name, fn) => t.test(name, async () => { try { await fn(); records.push({ name, status: 'passed' }) } catch (error) { records.push({ name, status: 'failed', message: error.message }); throw error } })
  const native = async (path, token, body, extra = {}) => {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const published = (id, visibility, content, expectedVersion = null) => ({ commandId: randomUUID(), materialId: id, projectId, title: visibility + ' requirements', kind: 'trellis-prd', visibility, text: content, expectedVersion, source: { kind: 'local-material', repositoryId: 'repository-1', workspaceId: 'workspace-1', taskRef: 'task-1', relativePath: '.trellis/tasks/task-1/prd.md', version: createHash('sha256').update(content).digest('hex') } })
  try {
    await check('two actual OIDC subjects complete signed code+PKCE/state/nonce flow; headers cannot impersonate', async () => {
      aliceSession = await alice.signIn(); bobSession = await bob.signIn()
      teamSessionSchema.parse(aliceSession); teamSessionSchema.parse(bobSession)
      assert.notEqual(aliceSession.person.userId, bobSession.person.userId)
      assert.equal(aliceSession.person.isPlatformAdmin, true); assert.equal(bobSession.person.isPlatformAdmin, false)
      assert.deepEqual(identity.observations.logins, ['alice', 'bob'])
      assert.ok(identity.observations.authorizationRequests.every((entry) => entry.challengeMethod === 'S256' && entry.hasChallenge && entry.hasState && entry.hasNonce))
      assert.equal((await native('/api/session', null, undefined, { 'X-Team-User': aliceSession.person.userId })).status, 401)
      assert.equal((await alice.api('/auth/callback?state=forged&code=forged')).status, 401)
      assert.equal((await alice.api('/api/session')).status, 200)
    })
    await check('explicit team/project memberships allow combined responsibilities without global grants', async () => {
      const team = await alice.api('/api/teams', { commandId: randomUUID(), name: 'Owned test team' }); assert.equal(team.status, 200)
      teamId = team.body.value.result.teamId
      const member = await alice.api(`/api/teams/${teamId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['member'], active: true, expectedRevision: null }); assert.equal(member.status, 200)
      const project = await alice.api('/api/projects', { commandId: randomUUID(), teamId, name: 'Project A' }); assert.equal(project.status, 200)
      projectId = project.body.value.result.projectId
      const other = await alice.api('/api/projects', { commandId: randomUUID(), teamId, name: 'Project B' }); otherProjectId = other.body.value.result.projectId
      assert.equal((await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['developer', 'tester'], active: true, expectedRevision: null })).status, 200)
      const projects = await bob.api('/api/projects'); assert.equal(projects.body.value.items.length, 1)
      assert.deepEqual(projects.body.value.items[0].roles, ['developer', 'tester'])
      assert.equal((await bob.api(`/api/projects/${projectId}/members`)).status, 403)
      assert.equal((await bob.api('/api/people')).status, 403)
    })
    await check('HTTP Origin/CSRF/Host and redirect validation reject before mutations', async () => {
      const input = { commandId: randomUUID(), name: 'Must not exist' }
      assert.equal((await alice.api('/api/teams', input, { Origin: 'https://foreign.invalid' })).status, 403)
      assert.equal((await alice.api('/api/teams', input, { 'X-CSRF-Token': 'bad' })).status, 403)
      const hostStatus = await new Promise((done, reject) => {
        const req = httpRequest(origin + '/api/session', { headers: { Host: 'foreign.invalid' } }, (response) => { response.resume(); done(response.statusCode) })
        req.once('error', reject); req.end()
      })
      assert.equal(hostStatus, 421)
      const redirect = await alice.request('/auth/login?returnTo=//foreign.invalid'); assert.equal(redirect.status, 400)
      assert.equal((await alice.api('/api/teams')).body.value.items.length, 1)
    })
    await check('immutable UTF8 versions, command replay/conflict and current-version CAS survive real concurrent requests', async () => {
      materialId = randomUUID(); originalPublication = published(materialId, 'project', '# Requirement A\n\n姓名🙂\n')
      const [first, duplicate] = await Promise.all([alice.api('/api/materials', originalPublication), alice.api('/api/materials', originalPublication)])
      assert.equal(first.status, 200); assert.equal(duplicate.status, 200)
      assert.deepEqual(new Set([first.body.value.status, duplicate.body.value.status]), new Set(['committed', 'duplicate']))
      assert.equal(first.body.value.result.version, 1)
      assert.equal(first.body.value.result.bodyDigest, createHash('sha256').update(originalPublication.text).digest('hex'))
      assert.equal((await alice.api('/api/materials', { ...originalPublication, title: 'Changed request' })).status, 409)
      assert.equal((await alice.api('/api/materials', { ...originalPublication, commandId: randomUUID() })).status, 409)
      latestPublication = published(materialId, 'project', '# Requirement B\n\nChanged after publication A.\n', 1)
      assert.equal((await alice.api('/api/materials', latestPublication)).body.value.result.version, 2)
      const old = await bob.api(`/api/materials/${materialId}/versions/1`); assert.equal(old.body.value.text, originalPublication.text)
      teamPublishedDocumentSchema.parse(old.body.value)
      assert.equal((await bob.api(`/api/materials/${materialId}/versions/2`)).body.value.text, latestPublication.text)
    })
    await check('personal content stays owner-only even for bootstrap admin; malformed source metadata does not create blobs', async () => {
      privateId = randomUUID(); const privateDoc = published(privateId, 'personal', '# Bob private notes')
      assert.equal((await bob.api('/api/materials', privateDoc)).status, 200)
      assert.equal((await alice.api(`/api/materials/${privateId}/versions/1`)).status, 403)
      const before = readdirSync(join(directory, 'store/blobs')).length
      const invalid = published(randomUUID(), 'project', '# Must not publish')
      invalid.source.relativePath = 'C:/private/source.md'
      assert.equal((await alice.api('/api/materials', invalid)).status, 400)
      assert.equal((await alice.api('/api/materials', { ...published(randomUUID(), 'project', '# Not a transcript'), projectRoot: 'C:/private' })).status, 400)
      assert.equal(readdirSync(join(directory, 'store/blobs')).length, before)
    })
    await check('feedback references the actual selected old version and never claims applied or business completion', async () => {
      const quote = 'Requirement A'; const start = originalPublication.text.indexOf(quote)
      const feedback = { commandId: randomUUID(), feedbackId: randomUUID(), materialId, version: 1, body: 'Remove the private phone field.', quote, anchor: { start, end: start + quote.length } }
      const created = await bob.api('/api/feedback', feedback); assert.equal(created.status, 200)
      assert.equal(created.body.value.result.state, 'recorded'); assert.equal(created.body.value.result.applied, false)
      assert.equal((await bob.api('/api/feedback', feedback)).body.value.status, 'duplicate')
      assert.equal((await alice.api(`/api/materials/${materialId}/feedback?version=1`)).body.value.items.length, 1)
      teamPageSchema(teamFeedbackSchema).parse((await alice.api(`/api/materials/${materialId}/feedback?version=1`)).body.value)
      assert.equal((await bob.api('/api/feedback', { ...feedback, commandId: randomUUID(), feedbackId: randomUUID(), version: 2 })).status, 409)
    })
    await check('pending device has no authority; exact browser approval binds only the selected project', async () => {
      const enrollment = await native('/api/device-pairings', null, { deviceName: 'Owned desktop', projectId, capabilityClaims: ['workflow.read', 'workflow.publish'] }); assert.equal(enrollment.status, 200)
      device = enrollment.body.value
      teamDeviceEnrollmentSchema.parse(device)
      assert.equal((await native('/api/session', device.deviceToken)).status, 401)
      const inspect = await bob.api(`/api/device-pairings/${device.pairingId}`); assert.equal(inspect.status, 200); assert.equal('userCode' in inspect.body.value, false)
      parseTeamDevicePairing(inspect.body.value)
      assert.equal((await bob.api(`/api/device-pairings/${device.pairingId}/approve`, { commandId: randomUUID(), userCode: device.userCode, expectedProjectId: otherProjectId })).status, 403)
      assert.equal((await bob.api(`/api/device-pairings/${device.pairingId}/approve`, { commandId: randomUUID(), userCode: device.userCode, expectedProjectId: projectId })).status, 200)
      assert.equal((await native(`/api/device-pairings/${device.pairingId}/status`, device.deviceToken)).body.value.status, 'active')
      assert.equal((await native('/api/session', device.deviceToken)).body.value.authentication, 'device')
      assert.equal((await native('/api/projects', device.deviceToken)).body.value.items.length, 1)
      assert.equal((await native(`/api/events?projectId=${otherProjectId}`, device.deviceToken)).status, 403)
      assert.equal((await native('/api/session', device.deviceToken, undefined, { Origin: origin })).status, 403)
      const mismatch = await native('/api/device-pairings', null, { deviceName: 'Targeted cannot retarget', projectId, capabilityClaims: [] })
      assert.equal((await alice.api(`/api/device-pairings/${mismatch.body.value.pairingId}/approve`, { commandId: randomUUID(), userCode: mismatch.body.value.userCode, expectedProjectId: otherProjectId })).status, 409)
    })
    await check('desktop-first unscoped enrollment grants nothing until one browser project selection and cannot later rebind', async () => {
      const enrollment = await native('/api/device-pairings', null, { deviceName: 'Project selected in browser', capabilityClaims: [] })
      assert.equal(enrollment.status, 200); const candidate = enrollment.body.value
      const pending = await native(`/api/device-pairings/${candidate.pairingId}/status`, candidate.deviceToken)
      assert.equal(pending.body.value.projectId, null); assert.equal(pending.body.value.ownerId, null); assert.equal(pending.body.value.online, false)
      teamDeviceSchema.parse(pending.body.value)
      assert.equal((await native('/api/projects', candidate.deviceToken)).status, 401)
      assert.equal((await native('/api/events', candidate.deviceToken)).status, 401)
      assert.equal((await alice.api(`/api/device-pairings/${candidate.pairingId}`)).body.value.projectId, null)
      const approval = { commandId: randomUUID(), userCode: candidate.userCode, expectedProjectId: otherProjectId }
      assert.equal((await alice.api(`/api/device-pairings/${candidate.pairingId}/approve`, approval)).body.value.status, 'committed')
      assert.equal((await alice.api(`/api/device-pairings/${candidate.pairingId}/approve`, approval)).body.value.status, 'duplicate')
      assert.equal((await alice.api(`/api/device-pairings/${candidate.pairingId}/approve`, { ...approval, commandId: randomUUID(), expectedProjectId: projectId })).status, 409)
      assert.equal((await native('/api/projects', candidate.deviceToken)).body.value.items[0].projectId, otherProjectId)
      assert.equal((await native(`/api/events?projectId=${projectId}`, candidate.deviceToken)).status, 403)
      const active = await native(`/api/device-pairings/${candidate.pairingId}/status`, candidate.deviceToken)
      assert.equal(active.body.value.projectId, otherProjectId); assert.equal(active.body.value.ownerId, aliceSession.person.userId)
      assert.equal((await alice.api(`/api/devices/${candidate.deviceId}/revoke`, { commandId: randomUUID() })).status, 200)
      assert.equal((await native('/api/session', candidate.deviceToken)).status, 401)
    })
    await check('all list pages keep scoped opaque cursors and exact historical feedback remains reachable', async () => {
      const first = await alice.api('/api/projects?limit=1'); assert.equal(first.body.value.items.length, 1); assert.equal(first.body.value.hasMore, true)
      const cursor = first.body.value.nextCursor
      const second = await alice.api('/api/projects?limit=1&cursor=' + encodeURIComponent(cursor)); assert.equal(second.body.value.items.length, 1)
      assert.notEqual(first.body.value.items[0].projectId, second.body.value.items[0].projectId); assert.equal(second.body.value.hasMore, false)
      assert.equal((await alice.api('/api/teams?cursor=' + encodeURIComponent(cursor))).status, 409)
      assert.equal((await bob.api('/api/projects?cursor=' + encodeURIComponent(cursor))).status, 409)
      const latest = await bob.api(`/api/materials/${materialId}/versions?limit=1`); assert.equal(latest.body.value.items[0].version, 2)
      const old = await bob.api(`/api/materials/${materialId}/versions?limit=1&cursor=${encodeURIComponent(latest.body.value.nextCursor)}`)
      assert.equal(old.body.value.items[0].version, 1); assert.equal(old.body.value.hasMore, false)
      assert.equal((await bob.api(`/api/materials/${privateId}/versions?cursor=${encodeURIComponent(latest.body.value.nextCursor)}`)).status, 409)
      const doc = published(randomUUID(), 'project', '# Feedback paging source'); assert.equal((await alice.api('/api/materials', doc)).status, 200)
      for (const body of ['First recorded note', 'Second recorded note']) assert.equal((await bob.api('/api/feedback', { commandId: randomUUID(), feedbackId: randomUUID(), materialId: doc.materialId, version: 1, body })).status, 200)
      const comments = await alice.api(`/api/materials/${doc.materialId}/feedback?version=1&limit=1`); assert.equal(comments.body.value.items.length, 1); assert.equal(comments.body.value.hasMore, true)
      const older = await alice.api(`/api/materials/${doc.materialId}/feedback?version=1&limit=1&cursor=${encodeURIComponent(comments.body.value.nextCursor)}`)
      assert.equal(older.body.value.items.length, 1); assert.equal(older.body.value.hasMore, false); assert.notEqual(comments.body.value.items[0].feedbackId, older.body.value.items[0].feedbackId)
      const ids = new Set([comments.body.value.items[0].feedbackId, older.body.value.items[0].feedbackId])
      for (let index = 0; index < 12; index++) {
        const feedbackId = randomUUID(); ids.add(feedbackId)
        assert.equal((await bob.api('/api/feedback', { commandId: randomUUID(), feedbackId, materialId: doc.materialId, version: 1, body: '汉'.repeat(20_000) })).status, 200)
      }
      const received = new Set(); let next = ''
      for (let page = 0; page < 5; page++) {
        const result = await alice.api(`/api/materials/${doc.materialId}/feedback?version=1&limit=100${next ? '&cursor=' + encodeURIComponent(next) : ''}`)
        assert.equal(result.status, 200); assert.ok(Buffer.byteLength(JSON.stringify(result.body)) < 600 * 1024)
        for (const item of result.body.value.items) { assert.equal(received.has(item.feedbackId), false); received.add(item.feedbackId) }
        if (!result.body.value.hasMore) break
        assert.ok(result.body.value.nextCursor); assert.notEqual(result.body.value.nextCursor, next); next = result.body.value.nextCursor
      }
      assert.deepEqual(received, ids)
    })
    await check('actual heartbeat establishes liveness; replay cannot keep an offline device falsely online', async () => {
      let list = await bob.api('/api/devices'); assert.equal(list.body.value.items[0].online, false)
      const beat = { sequence: 0, capabilityClaims: ['workflow.read'] }
      const current = await native('/api/devices/heartbeat', device.deviceToken, beat); assert.equal(current.status, 200); assert.equal(current.body.value.online, true)
      const time = current.body.value.lastSeenAt
      await new Promise((done) => setTimeout(done, 1100))
      const replay = await native('/api/devices/heartbeat', device.deviceToken, beat)
      assert.equal(replay.body.value.lastSeenAt, time); assert.equal(replay.body.value.online, false)
      assert.equal((await native('/api/devices/heartbeat', device.deviceToken, { sequence: 0, capabilityClaims: ['other'] })).status, 409)
    })
    await check('lost HTTP response reuses one durable publication command and no second version', async () => {
      const input = published(randomUUID(), 'project', '# Published before connection dropped')
      await new Promise((done, reject) => {
        const req = httpRequest(origin + '/api/materials', { method: 'POST', headers: { Authorization: `Bearer ${device.deviceToken}`, 'Content-Type': 'application/json' } }, (response) => { assert.equal(response.statusCode, 200); response.destroy(); done() })
        req.once('error', reject); req.end(JSON.stringify(input))
      })
      const retry = await native('/api/materials', device.deviceToken, input)
      assert.equal(retry.status, 200); assert.equal(retry.body.value.status, 'duplicate'); assert.equal(retry.body.value.result.version, 1)
      const receipt = await native(`/api/commands/${input.commandId}`, device.deviceToken)
      assert.equal(receipt.status, 200); assert.equal(receipt.body.value.result.materialId, input.materialId)
      assert.equal((await alice.api(`/api/commands/${input.commandId}`)).status, 404)
      bobMaterialId = input.materialId; bobPublication = input
    })
    await check('current ACL revocation defeats stale browser/device/replayed-command grants and regrant does not revive old devices', async () => {
      priorCursor = (await bob.api(`/api/events?projectId=${projectId}`)).body.value.cursor
      teamEventPageSchema.parse((await bob.api(`/api/events?projectId=${projectId}`)).body.value)
      const revoked = await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['developer', 'tester'], active: false, expectedRevision: 1 }); assert.equal(revoked.status, 200)
      assert.equal((await bob.api(`/api/materials/${materialId}/versions/1`)).status, 403)
      assert.equal((await native('/api/session', device.deviceToken)).status, 401)
      assert.equal((await bob.api('/api/materials', bobPublication)).status, 403)
      assert.equal((await bob.api('/api/session')).status, 200)
      assert.equal((await bob.api('/api/devices')).body.value.items[0].status, 'revoked')
      assert.equal((await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['developer', 'tester'], active: true, expectedRevision: 2 })).status, 200)
      assert.equal((await native('/api/session', device.deviceToken)).status, 401)
      const reset = await bob.api(`/api/events?projectId=${projectId}&cursor=${encodeURIComponent(priorCursor)}`)
      assert.equal(reset.status, 200); assert.equal(reset.body.value.resetRequired, true)
      const aliceCursor = (await alice.api(`/api/events?projectId=${projectId}`)).body.value.cursor
      assert.equal((await bob.api(`/api/events?projectId=${projectId}&cursor=${encodeURIComponent(aliceCursor)}`)).body.value.resetRequired, true)
    })
    await check('published versions remain readable with publisher offline and through service restart', async () => {
      await service.close()
      service = await createTeamService(config); await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
      assert.equal((await bob.api(`/api/materials/${materialId}/versions/1`)).body.value.text, originalPublication.text)
      assert.equal((await alice.api('/api/materials', latestPublication)).body.value.status, 'duplicate')
      assert.equal((await bob.api('/api/devices')).body.value.items[0].online, false)
      assert.equal((await bob.api(`/api/materials/${bobMaterialId}/versions/1`)).body.value.text, bobPublication.text)
      assert.equal((await bob.api(`/api/materials/${materialId}/feedback?version=1`)).body.value.items.length, 1)
    })
    await check('platform account revocation invalidates every old session and cannot be bypassed by a new valid SSO token', async () => {
      const old = bob.cookies.get('127.0.0.1').get('tp_team_session')
      const revoke = await alice.api(`/api/people/${bobSession.person.userId}/status`, { commandId: randomUUID(), active: false, expectedRevision: 1 })
      assert.equal(revoke.status, 200); assert.equal(revoke.body.value.result.revision, 2)
      assert.equal((await bob.api('/api/session')).status, 401)
      await assert.rejects(bob.signIn(), /403|failed/)
      assert.equal((await alice.api(`/api/people/${aliceSession.person.userId}/status`, { commandId: randomUUID(), active: false, expectedRevision: 1 })).status, 409)
      assert.equal((await alice.api(`/api/people/${bobSession.person.userId}/status`, { commandId: randomUUID(), active: true, expectedRevision: 2 })).status, 200)
      assert.equal((await native('/api/session', null, undefined, { Cookie: `tp_team_session=${old}` })).status, 401)
      assert.equal((await bob.signIn()).person.revision, 3)
    })
    await check('actual SQLite/blob backup+verified restore preserve identities, exact versions, command results and cursor epoch', async () => {
      const cursor = (await alice.api(`/api/events?projectId=${projectId}`)).body.value.cursor
      const backup = join(directory, 'backup'); const saved = await service.store.backup(backup)
      assert.ok(saved.blobCount >= 4)
      await assert.rejects(service.store.backup(backup), /already exists/)
      const restore = join(directory, 'restored'); const restored = restoreTeamBackup(backup, restore)
      assert.equal(restored.instanceId, saved.instanceId); assert.equal(restored.epoch, saved.epoch)
      await service.close(); service = await createTeamService({ ...config, dataDir: restore }); await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
      assert.equal((await alice.api('/api/session')).body.value.person.userId, aliceSession.person.userId)
      assert.equal((await bob.api(`/api/materials/${materialId}/versions/1`)).body.value.text, originalPublication.text)
      assert.equal((await alice.api('/api/materials', latestPublication)).body.value.status, 'duplicate')
      const events = await alice.api(`/api/events?projectId=${projectId}&cursor=${encodeURIComponent(cursor)}`); assert.equal(events.body.value.resetRequired, false)
      assert.equal((await native('/api/session', device.deviceToken)).status, 401)
      const manifest = JSON.parse(readFileSync(join(backup, 'backup.json'), 'utf8')); writeFileSync(join(backup, 'blobs', manifest.blobs[0].digest), 'tampered')
      assert.throws(() => restoreTeamBackup(backup, join(directory, 'corrupt-restore')), /verification/)
    })
    await check('production has no principal injection, remote shell or naked blob endpoint', async () => {
      for (const path of ['/api/execute', '/api/shell', '/api/run', '/blobs/' + 'a'.repeat(64)]) {
        const result = await alice.api(path); assert.equal(result.status, 404)
      }
      assert.equal((await alice.api('/api/materials', { ...published(randomUUID(), 'project', '# no'), userId: bobSession.person.userId })).status, 400)
      const exposed = JSON.stringify((await alice.api('/api/materials')).body)
      assert.equal(exposed.includes(directory), false); assert.equal(exposed.includes(device.deviceToken), false)
    })
    await check('authorized published reads survive issuer outage while new login reports unavailable without a demo identity', async () => {
      await identity.close()
      assert.equal((await bob.api(`/api/materials/${materialId}/versions/1`)).body.value.text, originalPublication.text)
      const unauthenticated = new BrowserAccount(origin, 'alice')
      const response = await unauthenticated.request('/auth/login')
      assert.equal(response.status, 503); assert.equal((await response.json()).ok, false)
      assert.equal((await unauthenticated.api('/api/session')).status, 401)
    })
    completed = true
  } finally {
    await service.close().catch(() => {})
    await identity.close()
    if (process.env.TEAM_TEST_REPORT) { const at = resolve(process.env.TEAM_TEST_REPORT); mkdirSync(dirname(at), { recursive: true }); writeFileSync(at, JSON.stringify({ status: !completed ? 'incomplete' : records.every((record) => record.status === 'passed') ? 'passed' : 'failed', scope: 'actual Fastify HTTP, two signed OIDC provider subjects, real Node SQLite worker, immutable blob and backup/restore; isolated test identity provider only', checks: records, limits: ['No company SSO/deployment proof', 'No desktop local outbox/Web UI integration acceptance', 'Single-instance SQLite baseline; no hardware power-loss or scale SLA'] }, null, 2) + '\n') }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-http-')); rmSync(directory, { recursive: true, force: true })
  }
})
