const { app, safeStorage } = require('electron')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomBytes, randomUUID, createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const fixture = process.env.TPANEL_TEAM_NATIVE_FIXTURE, reportDir = process.env.TPANEL_TEAM_NATIVE_REPORT
if (!fixture || !reportDir) throw Error('Owned fixture paths missing')
const profile = join(fixture, 'profile'); mkdirSync(profile)
app.setPath('userData', profile)
const results = [], check = async (name, work) => { await work(); results.push({ name, status: 'passed' }); console.log(`PASS ${name}`) }
let service
const watchdog = setTimeout(() => app.exit(1), 35000)
app.whenReady().then(async () => {
  assert.equal(safeStorage.isEncryptionAvailable(), true, 'Real OS encryption must be available; no plaintext test fallback')
  const { DesktopTeamService } = require(join(fixture, 'service.cjs'))
  const token = 'td_' + randomBytes(32).toString('base64url'), pairingId = randomUUID(), deviceId = randomUUID(), now = Date.now()
  const origin = 'https://owned-team-native.example.invalid', dataDir = join(fixture, 'store')
  let browserCalls = 0, decryptedHeaderMatches = 0, browserFailure = null
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname
    if (path === '/api/device-pairings') return new Response(JSON.stringify({ ok: true, value: { pairingId, deviceId, deviceToken: token, userCode: 'ABCDEFGHJK', verificationUri: `${origin}/?pairing=${pairingId}`, expiresAt: now + 60000, pollAfterMs: 1 } }), { status: 200 })
    if (path === `/api/device-pairings/${pairingId}/status`) {
      assert.equal(options.headers.Authorization === `Bearer ${token}`, true, 'Original candidate must be decrypted for its exact request'); decryptedHeaderMatches++
      return new Response(JSON.stringify({ ok: true, value: { deviceId, deviceName: 'Owned native credential fixture', lastSeenAt: null, online: false, capabilityClaims: [], capabilityEvidence: 'device-declared', sequence: -1, status: 'pending', projectId: null, ownerId: null } }), { status: 200 })
    }
    throw Error('Unexpected native credential fixture HTTP path')
  }
  const browser = async (url) => {
    assert.equal(url, `${origin}/?pairing=${pairingId}`)
    const db = new DatabaseSync(join(dataDir, 'team-desktop.sqlite'), { readOnly: true })
    try {
      const row = JSON.parse(db.prepare('SELECT data FROM connections').get().data)
      assert.notEqual(row.encryptedToken, token)
      const protectedValue = JSON.parse(safeStorage.decryptString(Buffer.from(row.encryptedToken, 'base64')))
      assert.equal(protectedValue.token === token, true, 'Actual Windows decrypt must recover the exact owned candidate')
      assert.equal(protectedValue.origin, origin); assert.equal(protectedValue.deviceId, deviceId); assert.equal(protectedValue.pairingId, pairingId)
      assert.equal(readFileSync(join(dataDir, 'team-desktop.sqlite')).includes(Buffer.from(token)), false)
    } finally { db.close() }
    browserCalls++
  }
  const options = { dataDir, workerFile: join(fixture, 'team-desktop-worker.js'), fetch: fetcher, openExternal: async (url) => { try { await browser(url) } catch (error) { browserFailure = error; throw error } } }
  // Protection/reveal adapters are intentionally NOT supplied: actual Electron
  // defaults must encrypt before browser opening and decrypt after store reopen.
  service = await DesktopTeamService.open(options)
  let connectionId
  await check('real Windows protection and actual worker commit precede browser opening without exposing the candidate', async () => {
    const result = await service.beginPairing({ origin, deviceName: 'Owned native credential fixture', capabilityClaims: [] })
    if (browserFailure) throw browserFailure
    connectionId = result.connection.connectionId
    assert.equal(browserCalls, 1); assert.equal(result.browser, 'opened'); assert.equal(result.connection.state, 'pending'); assert.equal(result.connection.projectId, null)
    assert.equal(JSON.stringify(result).includes(token), false); assert.equal('encryptedToken' in result.connection, false)
  })
  await service.close(); service = await DesktopTeamService.open(options)
  await check('actual Electron worker reopen decrypts the same pending candidate only in main', async () => {
    await new Promise((done) => setTimeout(done, 20))
    const value = await service.pollPairing(connectionId)
    assert.equal(value.state, 'pending'); assert.equal(value.remoteDevice.online, false); assert.equal(value.ownerId, null); assert.equal(decryptedHeaderMatches, 1)
    assert.equal(JSON.stringify(await service.connections()).includes(token), false)
  })
  await service.close(); service = null
  writeFileSync(join(reportDir, 'native-credential-report.json'), JSON.stringify({ status: 'passed-observed-native-subset', versions: process.versions, platform: process.platform, protection: 'Actual Electron Windows safeStorage defaults, no crypto stub', storage: 'Actual Electron SQLite worker commit/close/reopen', http: 'Explicit owned HTTPS response fixture; no network or company SSO', results, browserCalls, decryptedHeaderMatches, nativeModelCalls: 0, credentialLogged: false, serviceBundleSha256: createHash('sha256').update(readFileSync(join(fixture, 'service.cjs'))).digest('hex'), notRun: ['production SSO/TLS', 'real service enrollment in this OS gate', 'packaged upgrade/backup', 'cross-user OS credential migration'] }, null, 2))
  clearTimeout(watchdog); app.once('will-quit', () => console.log('TEAM_DESKTOP_NATIVE_PASSED')); app.quit()
}).catch(async (error) => {
  if (service) await service.close().catch(() => {})
  const redact = (text) => String(text).replace(/td_[A-Za-z0-9_-]{43}/g, '[owned-fixture-candidate]')
  writeFileSync(join(reportDir, `native-credential-failure-${Date.now()}.json`), JSON.stringify({ status: 'failed', message: redact(error.message), stack: redact(error.stack), results }, null, 2))
  console.error(redact(error.stack)); clearTimeout(watchdog); app.exit(1)
})
