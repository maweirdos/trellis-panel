/** Independent review probes through actual HTTP and signed OIDC accounts. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createTeamService } from '../dist/index.mjs'
import { BrowserAccount, createOidcFixture, freePort } from './oidc-fixture.mjs'

test('independent current ACL and exact publication representation review', { timeout: 60000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-team-review-'))
  const origin = `http://127.0.0.1:${await freePort()}`
  const identity = await createOidcFixture(origin)
  const service = await createTeamService({ dataDir: join(directory, 'store'), publicOrigin: origin, oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true })
  await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  try {
    const alice = new BrowserAccount(origin, 'alice'); const bob = new BrowserAccount(origin, 'bob')
    const a = await alice.signIn(); const b = await bob.signIn()
    for (const [parameter, value] of [['state', 'owned-wrong-state'], ['nonce', 'owned-wrong-nonce'], ['code_challenge', 'A'.repeat(43)]]) await t.test(`real signed OIDC rejects changed ${parameter} without creating an authenticated session`, async () => {
      const candidate = new BrowserAccount(origin, 'bob'); const request = candidate.request.bind(candidate)
      let changed = false
      candidate.request = (url, init) => {
        const target = new URL(url, origin)
        if (!changed && target.origin === new URL(identity.issuer).origin && target.pathname === '/auth') { target.searchParams.set(parameter, value); changed = true }
        return request(target, init)
      }
      await assert.rejects(candidate.signIn(), /401/); assert.equal(changed, true)
      assert.equal((await candidate.api('/api/session')).status, 401)
      candidate.request = request
      assert.equal((await candidate.signIn()).person.userId, b.person.userId)
    })
    await t.test('leaving a team removes old createTeam receipt/replay access without preventing a separate new team', async () => {
      const body = { commandId: randomUUID(), name: 'Formerly owned team' }
      const created = await bob.api('/api/teams', body); assert.equal(created.status, 200)
      const teamId = created.body.value.result.teamId
      assert.equal((await bob.api(`/api/teams/${teamId}/members`, { commandId: randomUUID(), userId: a.person.userId, roles: ['owner'], active: true, expectedRevision: null })).status, 200)
      assert.equal((await alice.api(`/api/teams/${teamId}/members`, { commandId: randomUUID(), userId: b.person.userId, roles: ['member'], active: false, expectedRevision: 1 })).status, 200)
      assert.equal((await bob.api('/api/teams')).body.value.items.some((team) => team.teamId === teamId), false)
      assert.equal((await bob.api(`/api/commands/${body.commandId}`)).status, 403)
      assert.equal((await bob.api('/api/teams', body)).status, 403)
      assert.equal((await bob.api('/api/teams', { commandId: randomUUID(), name: 'A separate authorized new team' })).status, 200)
    })
    await t.test('publication and feedback reject lone surrogates instead of silently changing accepted text into replacement characters', async () => {
      const team = await alice.api('/api/teams', { commandId: randomUUID(), name: 'Exact text team' })
      const project = await alice.api('/api/projects', { commandId: randomUUID(), teamId: team.body.value.result.teamId, name: 'Exact text project' })
      const input = { commandId: randomUUID(), materialId: randomUUID(), projectId: project.body.value.result.projectId, title: 'Exact text', kind: 'design', visibility: 'project', text: '# Broken Unicode\n\ud800', source: { kind: 'authored', sourceId: 'owned-source', version: 'v1' }, expectedVersion: null }
      const response = await alice.api('/api/materials', input)
      assert.equal(response.status, 400)
      assert.equal((await alice.api(`/api/commands/${input.commandId}`)).status, 404)
      const valid = { ...input, commandId: randomUUID(), text: '# Exact astral text\n🙂𐀀\n' }
      assert.equal((await alice.api('/api/materials', valid)).status, 200)
      assert.equal((await alice.api(`/api/materials/${valid.materialId}/versions/1`)).body.value.text, valid.text)
      const feedback = { commandId: randomUUID(), feedbackId: randomUUID(), materialId: valid.materialId, version: 1, body: 'Do not replace my comment\udfff' }
      assert.equal((await alice.api('/api/feedback', feedback)).status, 400)
      assert.equal((await alice.api(`/api/commands/${feedback.commandId}`)).status, 404)
      assert.equal((await alice.api('/api/feedback', { ...feedback, body: 'Keep the exact 🙂 comment' })).body.value.result.body, 'Keep the exact 🙂 comment')
    })
  } finally {
    await service.close(); await identity.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-team-review-'))
    rmSync(directory, { recursive: true, force: true })
  }
})
