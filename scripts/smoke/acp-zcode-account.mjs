/** Owned account/auth protocol fixtures; never reads real credentials or calls a provider. */
import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createAccountContext } from '../../adapters/zcode-acp/src/account-context.mjs'

const root = mkdtempSync(join(tmpdir(), 'trellis-zcode-account-'))
const directory = join(root, '.zcode', 'v2')
mkdirSync(directory, { recursive: true })
const settingsPath = join(root, 'desktop-settings.json')
const builtinPath = join(root, 'builtin.json')
const credentialPath = join(directory, 'credentials.json')
const providerId = 'account:bigmodel-individual-coding-plan'
const apiKey = 'SECRET-FIXTURE-native-account-key'
const secret = 'SECRET-FIXTURE-local-encryption'
const oauth = 'SECRET-FIXTURE-oauth-token'
const scopeHash = value => createHash('sha256').update(value).digest('hex')
const contexts = []
let mode = 'valid'
let requests = 0
let wrongAuthorization = false
let onSubscriptionResponse
const server = createServer((request, response) => {
  requests += 1
  wrongAuthorization ||= request.headers.authorization !== apiKey
  assert.equal(request.method, 'GET')
  assert.equal(request.url, '/api/biz/subscription/list')
  response.setHeader('content-type', 'application/json')
  if (mode === 'redirect') { response.writeHead(302, { location: '/must-not-follow' }); response.end(); return }
  if (mode === 'oversized') { response.end(JSON.stringify({ data: ['x'.repeat(70_000)] })); return }
  if (mode === 'malformed') { response.end('{ malformed'); return }
  onSubscriptionResponse?.()
  response.end(JSON.stringify({ code: 200, data: mode === 'not-entitled' ? [] : [
    { productId: 'glm-coding-pro', status: 'VALID', inCurrentPeriod: true }
  ] }))
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const env = { ZCODE_CREDENTIAL_SECRET: secret, BIGMODEL_API_BASE_URL: `http://127.0.0.1:${server.address().port}` }
function encrypt(value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv)
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()])
  return `enc:v1:${[iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.')}`
}
const settings = { providerFamilyDomain: 'bigmodel', providerFamilyConnectionSelections: { bigmodel: { kind: 'individual-coding-plan' } } }
const profileId = 'fixture-account'
function writeCredentials(changes = {}) {
  const plaintext = { 'oauth:active_provider': 'bigmodel', 'oauth:bigmodel:access_token': oauth,
    zcodejwttoken: 'SECRET-FIXTURE-zcode-jwt',
    'oauth:bigmodel:user_info': JSON.stringify({ id: profileId, username: 'fixture', displayName: 'Fixture' }),
    [`account-provider:coding-plan:${providerId}:account:${profileId}:api-key`]: apiKey, ...changes }
  writeFileSync(credentialPath, JSON.stringify(Object.fromEntries(Object.entries(plaintext).map(([key, value]) => [key, encrypt(value)]))))
}
function reset() {
  mode = 'valid'
  onSubscriptionResponse = undefined
  writeFileSync(settingsPath, JSON.stringify(settings))
  writeCredentials()
  writeFileSync(builtinPath, JSON.stringify({ schemaVersion: 1, revision: 17, config: { providerConfigRules: { providerRules: [
    { providerId, config: { access: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'individual-coding-plan' } } },
    { providerId: 'account:unrelated', config: { access: { type: 'zhipu-account', accountType: 'zai', mode: 'team-coding-plan' } } }
  ] } } }))
}
function make(overrides = {}) {
  const context = createAccountContext({ dataBaseDir: root, builtinPath, settingsPath, env, ...overrides })
  contexts.push(context)
  const snapshots = []
  const backend = { async request(method, snapshot) {
    assert.equal(method, 'provider/updateAccountConfig')
    assert.ok(!JSON.stringify(snapshot).includes('SECRET-FIXTURE'), 'Native account overlay must carry no credential')
    snapshots.push(snapshot)
    return { receivedRevision: snapshot.revision, status: 'received' }
  } }
  return { context, backend, snapshots }
}
const workspace = { workspacePath: root, workspaceKey: 'owned-workspace' }
const params = { sessionId: 'owned-session', providerId, modelSelection: { providerId, modelId: 'GLM-5.3' }, workspace,
  accountAccess: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'individual-coding-plan', entitled: true } }
async function headers(context, input = params) {
  let count = 0
  const result = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned account callback deadline')), 2000)
    assert.equal(context.handleRequest('interaction/requestProviderRuntimeHeaders', input, value => {
      count += 1; clearTimeout(timer); done(value)
    }), true)
  })
  await new Promise(done => setImmediate(done))
  assert.equal(count, 1)
  return result
}
try {
  reset()
  const good = make()
  assert.deepEqual(await good.context.sync(good.backend), { status: 'verified', reason: 'verified' })
  assert.equal(good.snapshots[0].providers[providerId].access.entitled, true)
  assert.equal(good.snapshots[0].providers['account:unrelated'].access.entitled, false)
  assert.equal(good.snapshots[0].basedOnZCodeBuiltinRevision, `zcode-builtin:17:${scopeHash(resolve(builtinPath))}`)
  good.context.bindSession('owned-session', workspace)
  const auth = await headers(good.context)
  assert.equal(auth.headersApplied, true)
  assert.equal(auth.requestAuth.apiKey, apiKey)
  assert.notEqual(auth.requestAuth.apiKey, oauth, 'OAuth must not substitute for a model credential')
  assert.equal(good.context.handleRequest('unrelated/method', {}, () => {}), false)
  for (const change of [
    { sessionId: 'foreign' }, { providerId: 'account:unrelated' },
    { modelSelection: { providerId: 'account:unrelated', modelId: 'GLM-5.3' } },
    { workspace: { ...workspace, workspacePath: join(root, 'foreign') } },
    { workspace: { ...workspace, workspaceKey: 'foreign' } },
    { accountAccess: { ...params.accountAccess, mode: 'team-coding-plan' } },
    { expectedAccountScope: 'foreign' },
    { expectedAccountScope: auth.requestAuth.accountScope, rejectedProjectTokenFingerprint: scopeHash(apiKey) }
  ]) assert.equal((await headers(good.context, { ...params, ...change })).headersApplied, false)
  console.log('PASS verified native account overlay, exact credential type and session/workspace/provider/account fences')

  writeCredentials({ 'oauth:bigmodel:access_token': 'SECRET-FIXTURE-switched-oauth' })
  assert.equal((await headers(good.context)).headersApplied, false)
  good.context.dispose()
  assert.equal((await headers(good.context)).headersApplied, false)
  await assert.rejects(good.context.sync(good.backend), /account_disposed/)
  console.log('PASS login-scope change and disposed generations cannot receive native headers')

  reset()
  const switchedDuringValidation = make()
  onSubscriptionResponse = () => writeCredentials({ 'oauth:bigmodel:access_token': 'SECRET-FIXTURE-switched-during-validation' })
  assert.deepEqual(await switchedDuringValidation.context.sync(switchedDuringValidation.backend), {
    status: 'unavailable', reason: 'account_scope_changed'
  })
  assert.equal(switchedDuringValidation.snapshots[0].providers[providerId].access.entitled, false)
  assert.equal(switchedDuringValidation.snapshots[0].states[providerId].availability, 'unavailable')
  assert.equal(switchedDuringValidation.snapshots[0].states[providerId].entitled, false)
  assert.equal(switchedDuringValidation.snapshots[0].states[providerId].current, false)
  switchedDuringValidation.context.bindSession('owned-session', workspace)
  assert.equal((await headers(switchedDuringValidation.context)).headersApplied, false)
  console.log('PASS login change during entitlement validation cannot publish an available account overlay')

  for (const scenario of ['not-entitled', 'malformed', 'oversized', 'redirect']) {
    reset(); mode = scenario
    const fixture = make()
    const result = await fixture.context.sync(fixture.backend)
    assert.equal(result.status, 'unavailable')
    assert.equal(fixture.snapshots[0].providers[providerId].access.entitled, false)
    fixture.context.bindSession('owned-session', workspace)
    assert.deepEqual(await headers(fixture.context), { headersApplied: false, errorMessage: 'ZCode BigModel account is unavailable; refresh the current account explicitly.' })
  }
  console.log('PASS absent entitlement, malformed/oversized responses and redirects never enable the subscription')

  reset()
  const before = requests
  const expired = `fixture.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.fixture`
  writeCredentials({ 'oauth:bigmodel:access_token': expired })
  const expiry = make(); assert.equal((await expiry.context.sync(expiry.backend)).status, 'unavailable')
  assert.equal(requests, before)
  reset(); writeFileSync(credentialPath, '{ malformed SECRET-FIXTURE')
  const corrupt = make(); assert.equal((await corrupt.context.sync(corrupt.backend)).status, 'unavailable')
  assert.equal(requests, before)
  reset(); writeFileSync(settingsPath, JSON.stringify({ providerFamilyDomain: 'zai' }))
  const wrongFamily = make(); assert.equal((await wrongFamily.context.sync(wrongFamily.backend)).status, 'unavailable')
  assert.equal(requests, before)
  reset()
  const rejected = make()
  await assert.rejects(rejected.context.sync({ request: async () => ({ receivedRevision: 'wrong', status: 'received' }) }), /unacknowledged/)
  assert.equal(wrongAuthorization, false)
  console.log('PASS expired/corrupt/wrong-account sources and rejected native acknowledgement fail closed without exposing credentials')
} finally {
  for (const context of contexts) context.dispose()
  server.closeAllConnections()
  await new Promise(done => server.close(done))
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  assert.ok(basename(root).startsWith('trellis-zcode-account-'))
  rmSync(root, { recursive: true, force: true })
}
