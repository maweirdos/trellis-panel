/** Actual PKCE/callback, adapter, protected repository and HTTP; browser/OS crypto are explicit fixtures. */
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'trellis-team-gitlab-'))
const bundle = join(directory, 'integration.mjs'), key = randomBytes(32), teamDevice = randomBytes(32).toString('hex')
const codes = new Map(), tokens = new Map(), emittedSecrets = [], wire = []
let browserUser = 7, expectedSubject = '7', active = true, opens = 0, denyEncryption = false, holdUser = null, redirectUser = false
let api, server, baseUrl
const passed = []
const check = async (name, action) => { await action(); passed.push(name); console.log('PASS ' + name) }
const deferred = () => { let resolvePromise; const promise = new Promise((done) => { resolvePromise = done }); return { promise, resolve: resolvePromise } }
const hold = () => ({ entered: deferred(), release: deferred() })
const requestOf = (c) => ({ connectionId: c.id, connectionRevision: c.revision })
const plainToken = (token) => tokens.get(token)
const identity = async () => {
  const response = await fetch(`${baseUrl}/api/identity`, { headers: { Authorization: `Bearer ${teamDevice}` }, redirect: 'error' })
  assert.equal(response.status, 200)
  return response.json()
}
const owner = (extra = {}) => ({
  connectionId: randomUUID(), origin: baseUrl, ownerId: 'person-7', deviceId: randomUUID(), projectId: 'project-1', clientRevision: 0,
  assertCurrent: async () => { const response = await fetch(`${baseUrl}/api/identity`, { headers: { Authorization: `Bearer ${teamDevice}` }, redirect: 'error' }); if (response.status !== 200) throw Error('Fixture device revoked') }, ...extra
})
const ensure = (id, binding, controller = new AbortController()) => api.ensureTeamGitlabConnection(id, binding, controller.signal)
const rows = () => api.readIntegrationState().connections
const publicRow = (id) => api.integrationSnapshot().connections.find((c) => c.id === id)
const noCredential = (id) => assert.deepEqual(rows().find((c) => c.id === id)?.secrets, {})
const protect = (text) => { if (denyEncryption) throw Error('Fixture locked encryption'); const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]) }
const reveal = (value) => { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') }
const bounded = (promise) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Owned smoke boundary timed out')), 10000); timer.unref() })])
globalThis.__teamGitlabSmoke = {
  directory, protect, reveal,
  openExternal: async (url) => {
    opens++
    const parsed = new URL(url)
    assert.equal(parsed.origin, baseUrl); assert.equal(parsed.pathname, '/oauth/authorize')
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(parsed.searchParams.get('scope'), 'read_api read_user')
    assert.equal(parsed.searchParams.get('redirect_uri'), 'http://127.0.0.1:17654/oauth/callback/gitlab')
    assert.equal(parsed.searchParams.has('client_secret'), false)
    const response = await fetch(url, { redirect: 'manual' })
    assert.equal(response.status, 302)
    const callback = new URL(response.headers.get('location'))
    const bad = new URL(callback); bad.searchParams.set('state', 'unrelated-state')
    assert.equal((await fetch(bad, { redirect: 'error' })).status, 400)
    assert.equal((await fetch(callback, { redirect: 'error' })).status, 200)
  },
  fetch: (url, init) => {
    assert.equal(init.redirect, 'error')
    wire.push({ path: new URL(url).pathname, method: init.method ?? 'GET' })
    return fetch(url, init)
  }
}

try {
  server = createServer(async (request, response) => {
    const url = new URL(request.url, baseUrl ?? 'http://127.0.0.1')
    const json = (status, body) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    try {
      if (url.pathname === '/api/identity') {
        if (!active || request.headers.authorization !== `Bearer ${teamDevice}`) return json(403, { error: 'denied' })
        return json(200, { provider: 'gitlab', issuer: baseUrl, subject: expectedSubject, baseUrl, clientId: 'native-public-client', username: 'same-display-name' })
      }
      if (url.pathname === '/oauth/authorize') {
        const code = randomUUID()
        codes.set(code, { user: browserUser, challenge: url.searchParams.get('code_challenge') })
        const callback = new URL(url.searchParams.get('redirect_uri'))
        callback.searchParams.set('code', code); callback.searchParams.set('state', url.searchParams.get('state'))
        response.writeHead(302, { Location: callback.href }).end(); return
      }
      if (url.pathname === '/oauth/token') {
        let body = ''; for await (const chunk of request) body += chunk
        const params = new URLSearchParams(body)
        assert.equal(params.get('client_id'), 'native-public-client'); assert.equal(params.has('client_secret'), false)
        assert.equal(params.get('grant_type'), 'authorization_code')
        assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:17654/oauth/callback/gitlab')
        const saved = codes.get(params.get('code')); assert.ok(saved)
        assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), saved.challenge)
        codes.delete(params.get('code'))
        const access = randomBytes(32).toString('hex'), refresh = randomBytes(32).toString('hex')
        tokens.set(access, saved.user); emittedSecrets.push(access, refresh)
        return json(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'read_api read_user' })
      }
      if (url.pathname === '/api/v4/user') {
        const user = plainToken(request.headers.authorization?.replace(/^Bearer /, ''))
        if (!user) return json(401, { error: 'denied' })
        if (holdUser) { const gate = holdUser; holdUser = null; gate.entered.resolve(); await gate.release.promise }
        if (redirectUser) { response.writeHead(302, { Location: `${baseUrl}/forbidden-forward` }).end(); return }
        return json(200, { id: user, username: 'same-display-name', email: 'same@example.invalid' })
      }
      json(404, { error: 'not found' })
    } catch { json(500, { error: 'owned fixture assertion failed' }) }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  const mocks = {
    electron: 'export const app={getPath:()=>globalThis.__teamGitlabSmoke.directory}; export const shell={openExternal:(url)=>globalThis.__teamGitlabSmoke.openExternal(url)}; export const safeStorage={isEncryptionAvailable:()=>true,encryptString:(text)=>globalThis.__teamGitlabSmoke.protect(text),decryptString:(value)=>globalThis.__teamGitlabSmoke.reveal(value)};',
    '../../state': 'export const getSnapshot=()=>null;export const getProjectRoot=()=>null;',
    '../store': 'export const getSettings=()=>({jira:{baseUrl:""},gitlab:{baseUrl:""}});export const setSettings=()=>{throw Error("Legacy settings must not be written")};',
    '../gitlab': 'export const clearGitlabTokenCache=()=>{};export const clearGitlabStatusCache=()=>{};',
    '../local-task': 'export class LocalControlStore{};export const localRuntimeDirOf=()=>"";export const workspaceIdForRoot=()=>"";',
    '../proxy': 'export const proxiedFetch=(url,init)=>globalThis.__teamGitlabSmoke.fetch(url,init);',
    './providers': `import {INTEGRATION_CATALOG} from ${JSON.stringify(resolve('src/shared/integrations.ts'))};import {IntegrationRegistry} from ${JSON.stringify(resolve('src/main/services/integrations/registry.ts'))};import {gitlabAuthorization} from ${JSON.stringify(resolve('src/main/services/integrations/providers/gitlab-authorization.ts'))};export const integrationRegistry=new IntegrationRegistry();integrationRegistry.register({manifest:INTEGRATION_CATALOG.find((c)=>c.id==='gitlab'),authorization:gitlabAuthorization,repository:{inspect:()=>{throw Error('Unused repository boundary')},repositories:()=>{throw Error('Unused repository boundary')},pullRequests:()=>{throw Error('Unused repository boundary')}}});`
  }
  await build({ stdin: { contents: "export * from './src/main/services/integrations/team-gitlab';export * from './src/main/services/integrations/service';export {readIntegrationState} from './src/main/services/integrations/repository';", loader: 'ts', resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent', plugins: [{ name: 'explicit-browser-os-and-unrelated-domains', setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'smoke-boundary' } : null)
    builder.onLoad({ filter: /.*/, namespace: 'smoke-boundary' }, (args) => ({ contents: mocks[args.path], loader: 'js', resolveDir: process.cwd() }))
  } }] })
  api = await import(pathToFileURL(bundle).href)

  await check('protected device identity is required; unsupported subjects and foreign issuers fail before browser dispatch', async () => {
    assert.equal((await fetch(`${baseUrl}/api/identity`)).status, 403)
    const id = await identity(), count = opens
    assert.equal((await ensure({ ...id, subject: 'same-display-name' }, owner())).state, 'authorization-required')
    assert.equal((await ensure({ ...id, issuer: 'https://foreign.invalid' }, owner())).state, 'authorization-required')
    assert.equal((await ensure({ ...id, provider: 'local' }, owner())).state, 'authorization-required')
    assert.equal((await ensure({ ...id, clientId: '' }, owner())).state, 'authorization-required')
    assert.equal(opens, count); assert.equal(rows().length, 0)
  })

  let first, firstOwner, firstIdentity
  await check('concurrent enrollment completion shares one real PKCE grant and saves only protected verified credentials', async () => {
    firstIdentity = await identity(); firstOwner = owner(); const count = opens
    const results = await bounded(Promise.all(Array.from({ length: 8 }, () => ensure(firstIdentity, firstOwner))))
    first = results[0]; assert.equal(first.state, 'connected'); assert.ok(results.every((result) => result.connectionId === first.connectionId && result.state === 'connected'))
    assert.equal(opens, count + 1); assert.equal(rows().length, 1)
    assert.ok(rows()[0].secrets.oauthTokens); assert.equal(rows()[0].teamGitlab.subject, '7')
    assert.equal('teamGitlab' in publicRow(first.connectionId), false)
    const disk = readFileSync(join(directory, 'integrations.json'), 'utf8'), safe = JSON.stringify(results)
    for (const secret of [teamDevice, ...emittedSecrets]) { assert.equal(disk.includes(secret), false); assert.equal(safe.includes(secret), false) }
  })

  await check('polls do not reopen browser; ordinary authorization cannot replace a team-bound account', async () => {
    const count = opens
    for (let i = 0; i < 5; i++) assert.equal((await ensure(firstIdentity, firstOwner)).state, 'connected')
    await assert.rejects(api.authorizeConnection(requestOf(publicRow(first.connectionId)), new AbortController().signal))
    assert.equal(opens, count)
  })

  let mismatch, mismatchOwner, mismatchIdentity
  await check('browser account switch with identical username/email rejects linkage before any token is stored', async () => {
    browserUser = 8; mismatchIdentity = await identity(); mismatchOwner = owner()
    mismatch = await bounded(ensure(mismatchIdentity, mismatchOwner)); assert.equal(mismatch.state, 'mismatch'); noCredential(mismatch.connectionId)
    const count = opens; assert.equal((await ensure(mismatchIdentity, mismatchOwner)).state, 'mismatch'); assert.equal(opens, count)
  })

  await check('failed attempts remain suppressed after restart; explicit retry reuses the pending connection', async () => {
    const restarted = await import(pathToFileURL(bundle).href + '?restart'), count = opens
    assert.equal((await restarted.ensureTeamGitlabConnection(mismatchIdentity, mismatchOwner, new AbortController().signal)).state, 'authorization-required')
    assert.equal(opens, count); browserUser = 7
    const result = await bounded(api.retryTeamGitlabConnection(mismatchIdentity, mismatchOwner, new AbortController().signal))
    assert.equal(result.state, 'connected'); assert.equal(result.connectionId, mismatch.connectionId); assert.equal(opens, count + 1)
  })

  await check('manual client edits retain ownership and cannot trigger a new automatic connection after restart', async () => {
    const current = publicRow(mismatch.connectionId), count = opens, size = rows().length
    api.saveConnection({ id: current.id, revision: current.revision, providerId: 'gitlab', name: current.name, enabled: true, config: { ...current.config, clientId: 'manually-changed-client' }, secrets: {} })
    const restarted = await import(pathToFileURL(bundle).href + '?after-edit')
    assert.equal((await restarted.ensureTeamGitlabConnection(mismatchIdentity, mismatchOwner, new AbortController().signal)).state, 'authorization-required')
    assert.equal(opens, count); assert.equal(rows().length, size)
  })

  await check('cancelled candidate cannot become globally usable and polling cannot reopen authorization', async () => {
    const gate = hold(), binding = owner(), id = await identity(), controller = new AbortController(); holdUser = gate
    const result = ensure(id, binding, controller); await bounded(gate.entered.promise); controller.abort(); gate.release.resolve()
    const cancelled = await bounded(result); assert.equal(cancelled.state, 'authorization-required'); noCredential(cancelled.connectionId)
    const count = opens; assert.equal((await ensure(id, binding)).state, 'authorization-required'); assert.equal(opens, count)
  })

  await check('device revocation while user identity is in flight prevents credential persistence', async () => {
    const gate = hold(), binding = owner(), id = await identity(); holdUser = gate
    const result = ensure(id, binding); await bounded(gate.entered.promise); active = false; gate.release.resolve()
    const revoked = await bounded(result); assert.notEqual(revoked.state, 'connected'); noCredential(revoked.connectionId)
    active = true
  })

  await check('native connection revision changes during browser grant reject the stale write', async () => {
    const gate = hold(), binding = owner(), id = await identity(); holdUser = gate
    const result = ensure(id, binding); await bounded(gate.entered.promise)
    const pending = rows().findLast((row) => !row.secrets.oauthTokens && row.teamGitlab?.authorizationAttempted)
    api.saveConnection({ id: pending.id, revision: pending.revision, providerId: 'gitlab', name: 'Edited during grant', enabled: true, config: pending.config, secrets: {} })
    gate.release.resolve(); const stale = await bounded(result); assert.notEqual(stale.state, 'connected'); noCredential(stale.connectionId)
  })

  await check('a newer client generation wins even when the older protected owner check completes last', async () => {
    const gate = hold(), id = await identity(); let generation = 0
    const binding = owner({ assertCurrent: async () => { gate.entered.resolve(); await gate.release.promise; if (generation !== 0) throw Error('Fixture superseded') } })
    const older = ensure(id, binding); await bounded(gate.entered.promise); generation = 1
    const newBinding = { ...binding, clientRevision: 1, assertCurrent: async () => { assert.equal(generation, 1) } }
    const newer = await bounded(ensure(id, newBinding))
    assert.equal(newer.state, 'connected'); gate.release.resolve(); assert.notEqual((await bounded(older)).state, 'connected')
    assert.equal((await ensure(id, binding)).state, 'authorization-required')
    assert.equal((await ensure(id, newBinding)).state, 'connected')
  })

  await check('disabled or deleted managed connections are not silently recreated on retry', async () => {
    const c = publicRow(first.connectionId)
    api.saveConnection({ id: c.id, revision: c.revision, providerId: 'gitlab', name: c.name, enabled: false, config: c.config, secrets: {} })
    const count = opens, size = rows().length
    assert.equal((await ensure(firstIdentity, firstOwner)).state, 'authorization-required')
    api.removeConnection(requestOf(publicRow(c.id)))
    assert.equal((await api.retryTeamGitlabConnection(firstIdentity, firstOwner, new AbortController().signal)).state, 'authorization-required')
    assert.equal(rows().length, size); assert.equal(opens, count)
  })

  await check('an unrelated authorized account is preserved; an existing matching native account is reused', async () => {
    const standalone = api.saveConnection({ providerId: 'gitlab', name: 'Personal account', enabled: true, config: { baseUrl, clientId: 'native-public-client', authMethod: 'oauth2' }, secrets: {} })
    browserUser = 8; const other = await bounded(api.authorizeConnection(requestOf(standalone), new AbortController().signal))
    const original = JSON.stringify(rows().find((c) => c.id === other.id)); browserUser = 7
    assert.equal((await bounded(ensure(await identity(), owner()))).state, 'connected')
    assert.equal(JSON.stringify(rows().find((c) => c.id === other.id)), original)
    const matching = api.saveConnection({ providerId: 'gitlab', name: 'Matching native account', enabled: true, config: { baseUrl, clientId: 'native-public-client', authMethod: 'oauth2' }, secrets: {} })
    const connected = await bounded(api.authorizeConnection(requestOf(matching), new AbortController().signal)), count = opens, size = rows().length
    const reused = await ensure(await identity(), owner()); assert.equal(reused.state, 'connected'); assert.equal(reused.connectionId, connected.id)
    assert.equal(opens, count); assert.equal(rows().length, size); assert.equal(rows().find((c) => c.id === connected.id).teamGitlab, undefined)
  })

  await check('credential-bearing redirects and unavailable encryption do not persist candidates', async () => {
    // A different verified subject avoids reusing the matching standalone account.
    expectedSubject = '9'; browserUser = 9; redirectUser = true
    const redirected = await bounded(ensure(await identity(), owner())); assert.notEqual(redirected.state, 'connected'); noCredential(redirected.connectionId)
    redirectUser = false; denyEncryption = true
    const locked = await bounded(ensure(await identity(), owner())); assert.notEqual(locked.state, 'connected'); noCredential(locked.connectionId)
    denyEncryption = false; assert.equal(wire.some((row) => row.path === '/forbidden-forward'), false)
  })
  console.log(`Passed ${passed.length} team GitLab login checks; browser and OS encryption were explicit fixtures.`)
} finally {
  server?.close(); server?.closeAllConnections()
  delete globalThis.__teamGitlabSmoke
  // This directory is created by this script and contains only its owned fixtures.
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
  assert.ok(basename(directory).startsWith('trellis-team-gitlab-'))
  rmSync(directory, { recursive: true, force: true })
}
