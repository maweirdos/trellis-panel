import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createTeamService, teamGitlabIdentitySchema, parseTeamConfig } from '../dist/index.mjs'
import { BrowserAccount, createOidcFixture, freePort } from './oidc-fixture.mjs'

test('explicit GitLab origin pins mismatched scheme endpoints while preserving real signed OIDC and native public metadata', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-gitlab-identity-')), origin = `http://127.0.0.1:${await freePort()}`
  const identity = await createOidcFixture(origin, { advertisedEndpointProtocol: 'https:' })
  const service = await createTeamService({ dataDir: directory, publicOrigin: origin, oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true, gitlabBaseUrl: identity.issuer, gitlabIntegration: { baseUrl: identity.issuer, clientId: 'owned-native-public-client' } })
  await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  try {
    const alice = new BrowserAccount(origin, 'alice'), bob = new BrowserAccount(origin, 'bob')
    const a = await alice.signIn(), b = await bob.signIn()
    assert.notEqual(a.person.userId, b.person.userId)
    for (const [account, subject] of [[alice, 'alice'], [bob, 'bob']]) {
      const reply = await account.api('/api/identity'); assert.equal(reply.status, 200)
      const metadata = teamGitlabIdentitySchema.parse(reply.body.value)
      assert.equal(metadata.issuer, identity.issuer); assert.equal(metadata.subject, subject)
      assert.equal(metadata.baseUrl, new URL(identity.issuer).origin); assert.equal(metadata.clientId, 'owned-native-public-client')
      assert.deepEqual(metadata.scopes, ['openid', 'profile'])
      assert.deepEqual(Object.keys(metadata).sort(), ['baseUrl', 'clientId', 'issuer', 'provider', 'scopes', 'subject'])
    }
    assert.equal((await new BrowserAccount(origin, 'alice').api('/api/identity')).status, 401)
    for (const [parameter, value] of [['state', 'wrong-state'], ['nonce', 'wrong-nonce'], ['code_challenge', 'A'.repeat(43)]]) {
      const candidate = new BrowserAccount(origin, 'bob'), request = candidate.request.bind(candidate)
      let changed = false
      candidate.request = (url, init) => { const target = new URL(url, origin); if (!changed && target.origin === new URL(identity.issuer).origin && target.pathname === '/auth') { target.searchParams.set(parameter, value); changed = true }; return request(target, init) }
      await assert.rejects(candidate.signIn(), /401/); assert.equal(changed, true)
      assert.equal((await candidate.api('/api/session')).status, 401)
    }
  } finally {
    await service.close(); await identity.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-gitlab-identity-')); rmSync(directory, { recursive: true, force: true })
  }
})

for (const [label, options] of [['foreign endpoint authority', { advertisedEndpointHost: 'foreign.example.invalid' }], ['foreign issuer', { advertisedIssuer: 'https://foreign.example.invalid' }]]) test(`GitLab pinning rejects ${label} before any authenticated grant`, { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-gitlab-reject-')), origin = `http://127.0.0.1:${await freePort()}`
  const identity = await createOidcFixture(origin, options)
  const service = await createTeamService({ dataDir: directory, publicOrigin: origin, oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true, gitlabBaseUrl: identity.issuer })
  await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  try {
    const candidate = new BrowserAccount(origin, 'alice'), reply = await candidate.request('/auth/login')
    assert.equal(reply.status, 503)
    assert.equal((await candidate.api('/api/session')).status, 401)
    assert.equal(identity.observations.logins.length, 0)
  } finally {
    await service.close(); await identity.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('trellis-gitlab-reject-')); rmSync(directory, { recursive: true, force: true })
  }
})

test('GitLab origin configuration cannot retarget a different provider', () => {
  const config = { dataDir: './unused', publicOrigin: 'https://team.example.test', oidc: { issuer: 'https://identity.example.test', clientId: 'public-client' }, bootstrapSubject: 'owner' }
  assert.throws(() => parseTeamConfig({ ...config, gitlabBaseUrl: 'https://other.example.test' }), /exactly match/)
  assert.throws(() => parseTeamConfig({ ...config, gitlabIntegration: { baseUrl: 'https://other.example.test', clientId: 'native-client' } }), /exactly match/)
})
