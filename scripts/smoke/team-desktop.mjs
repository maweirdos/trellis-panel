/** Actual desktop client/SQLite worker + HTTP/OIDC service; OS crypto/browser are explicit fixtures. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { createTeamService } from '../../packages/team-service/dist/index.mjs'
import { BrowserAccount, createOidcFixture, freePort } from '../../packages/team-service/test/oidc-fixture.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-team-desktop-')), results = [], digest = (value) => createHash('sha256').update(value).digest('hex')
const reportAt = process.argv.indexOf('--report'), key = randomBytes(32), browsers = [], wire = []
const protect = (text) => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64') }
const reveal = (text) => { const bytes = Buffer.from(text, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8') }
const check = async (name, action) => { await action(); results.push({ name, status: 'passed' }); console.log('PASS ' + name) }
const waitForPoll = async (c) => { const milliseconds = c.nextPollAt - Date.now() + 20; if (milliseconds > 0) await new Promise((done) => setTimeout(done, milliseconds)) }
let client, server, oidc, api, offline = false, dropCommand = null, failPostCommand = null, corruptReceiptAuthor = null, killAfterPost = null, token = null, failDecrypt = false, corruptRead = false, denyHtml = false, forceEventMore = false, projectPageBoundary = 0, heldWrite = null
const origin = `http://127.0.0.1:${await freePort()}`, directory = join(temporary, 'client'), workerFile = join(temporary, 'team-desktop-worker.cjs'), bundleFile = join(temporary, 'client.mjs')
const fetcher = async (url, init) => {
  if (offline) throw Error('Owned offline network boundary')
  const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : undefined
  wire.push({ path, method: init.method, commandId: body?.commandId, redirect: init.redirect, hasOrigin: new Headers(init.headers).has('Origin'), hasCookie: new Headers(init.headers).has('Cookie') })
  if (body?.commandId && body.commandId === failPostCommand) { failPostCommand = null; throw Error('Owned posted request lost before an observable upstream acknowledgement') }
  let actualUrl = url
  if (path === '/api/projects' && projectPageBoundary === 2 && new URL(url).searchParams.get('cursor') === 'owned-empty-page') { const adjusted = new URL(url); adjusted.searchParams.delete('cursor'); actualUrl = adjusted.href; projectPageBoundary = 3 }
  const response = await fetch(actualUrl, init)
  if (path === '/api/device-pairings' && response.ok) token = (await response.clone().json()).value.deviceToken
  if (heldWrite && body?.commandId === heldWrite.commandId) { heldWrite.enter(); await heldWrite.wait }
  if (dropCommand && body?.commandId === dropCommand) { dropCommand = null; await response.body?.cancel(); throw Error('Owned response loss after actual service commit') }
  if (killAfterPost && body?.commandId === killAfterPost) { killAfterPost = null; await client.store.worker.terminate() }
  if (corruptReceiptAuthor && body?.commandId === corruptReceiptAuthor && response.ok) { corruptReceiptAuthor = null; const value = await response.json(); value.value.result.authorId = aliceSession.person.userId; return new Response(JSON.stringify(value), { status: 200 }) }
  if (corruptRead && path.includes('/versions/')) { const value = await response.json(); value.value.material.bodyDigest = '0'.repeat(64); return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
  if (denyHtml && path.includes('/versions/')) return new Response('<h1>Access denied by owned proxy fixture</h1>', { status: 403, headers: { 'Content-Type': 'text/html' } })
  if (path === '/api/projects' && projectPageBoundary === 1) { const value = await response.json(); value.value = { items: [], hasMore: true, nextCursor: 'owned-empty-page' }; projectPageBoundary = 2; return new Response(JSON.stringify(value), { status: 200 }) }
  if (path === '/api/events' && forceEventMore) { const value = await response.json(); value.value.hasMore = true; return new Response(JSON.stringify(value), { status: 200 }) }
  return response
}
const options = { dataDir: directory, workerFile, allowLoopbackHttp: true, protectSecret: protect, revealSecret: (value) => { if (failDecrypt) throw Error('Owned locked OS store'); return reveal(value) }, fetch: fetcher, openExternal: async (url) => {
  assert.equal(new URL(url).origin, origin); assert.equal(url.includes(token ?? 'credential-not-present'), false)
  // The pending credential and connection were committed before browser dispatch.
  const db = new DatabaseSync(join(directory, 'team-desktop.sqlite'), { readOnly: true })
  const rows = db.prepare('SELECT data FROM connections').all(); db.close()
  assert.ok(rows.length); assert.ok(rows.some((row) => JSON.parse(reveal(JSON.parse(row.data).encryptedToken)).token === token)); browsers.push(url)
} }
const outboxAll = async (connectionId) => { const items = []; let cursor; for (let index = 0; index < 50; index++) { const page = await client.outbox(connectionId, { limit: 2, ...(cursor ? { cursor } : {}) }); items.push(...page.items); if (!page.hasMore) return items; cursor = page.nextCursor } throw Error('Owned outbox scan limit') }
let alice, bob, aliceSession, bobSession, projectId, teamId, connectionId, pairing, publicationId, publicationCommand, feedbackCommand
const authored = (extra = {}) => ({ connectionId, commandId: randomUUID(), materialId: randomUUID(), title: 'Owned requirements', visibility: 'project', expectedVersion: null, kind: 'trellis-prd', text: '# Version A\n\n姓名🙂 exact selected text.\n', sourceVersion: 'local/selected-A', ...extra })
const approve = async (pair, browser = bob, project = projectId) => {
  const response = await browser.api(`/api/device-pairings/${pair.connection.pairingId}/approve`, { commandId: randomUUID(), userCode: pair.connection.userCode, expectedProjectId: project }); assert.equal(response.status, 200)
  await waitForPoll((await client.connections()).find((item) => item.connectionId === pair.connection.connectionId))
  const active = await client.pollPairing(pair.connection.connectionId); assert.equal(active.state, 'active'); assert.equal(active.remoteDevice.online, false); return active
}
try {
  await build({ entryPoints: ['src/main/services/team-platform/store-worker.ts'], outfile: workerFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const mocks = { electron: 'export const shell={openExternal:async()=>{throw Error("OS browser fixture required")}};export const safeStorage={isEncryptionAvailable:()=>false};', '../proxy': 'export const proxiedFetch=(url,init)=>fetch(url,init);' }
  await build({ stdin: { contents: "export * from './src/main/services/team-platform';export {DesktopTeamStore} from './src/main/services/team-platform/store-client';export {canonicalTeamOrigin,verificationUrl,TeamHttp} from './src/main/services/team-platform/http'", resolveDir: process.cwd(), loader: 'ts' }, outfile: bundleFile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', plugins: [{ name: 'explicit-desktop-os-boundaries', setup(builder) { builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'owned-desktop' } : null); builder.onLoad({ filter: /.*/, namespace: 'owned-desktop' }, (args) => ({ contents: mocks[args.path], loader: 'js' })) } }] })
  api = await import(pathToFileURL(bundleFile).href)
  oidc = await createOidcFixture(origin)
  server = await createTeamService({ dataDir: join(temporary, 'server'), publicOrigin: origin, oidc: { issuer: oidc.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true, onlineTtlMs: 1000, pairingTtlMs: 60000 })
  await server.app.listen({ host: '127.0.0.1', port: Number(new URL(origin).port) })
  alice = new BrowserAccount(origin, 'alice'); bob = new BrowserAccount(origin, 'bob'); aliceSession = await alice.signIn(); bobSession = await bob.signIn()
  teamId = (await alice.api('/api/teams', { commandId: randomUUID(), name: 'Desktop integration team' })).body.value.result.teamId
  await alice.api(`/api/teams/${teamId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['member'], active: true, expectedRevision: null })
  projectId = (await alice.api('/api/projects', { commandId: randomUUID(), teamId, name: 'Desktop integration project' })).body.value.result.projectId
  await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['developer', 'tester'], active: true, expectedRevision: null })
  client = await api.DesktopTeamService.open(options)
  await check('configured origin and verification URL cannot forward a device credential to another origin', async () => {
    for (const url of ['http://intranet.invalid', 'https://user:secret@example.invalid', 'https://example.invalid/path', 'https://example.invalid/?query=1', 'https://example.invalid/#fragment']) assert.throws(() => api.canonicalTeamOrigin(url, true))
    const count = wire.length; await assert.rejects(client.beginPairing({ origin: 'http://company.invalid', deviceName: 'Invalid', capabilityClaims: [] })); assert.equal(wire.length, count)
    assert.throws(() => api.verificationUrl(origin, 'https://foreign.invalid/?pairing=' + randomUUID(), randomUUID()))
    let headers; const http = new api.TeamHttp(async (_url, init) => { headers = init; return new Response('', { status: 302, headers: { Location: 'https://foreign.invalid' } }) }, 1000)
    await assert.rejects(http.request(origin, '/api/session', { parse: (value) => value }, 'td_' + 'a'.repeat(43)), (error) => error.code === 'REDIRECT_REJECTED')
    assert.equal(headers.redirect, 'manual'); assert.equal(headers.credentials, 'omit')
  })
  await check('actual enrollment persists protected candidate before browser; pending has no authority', async () => {
    pairing = await client.beginPairing({ origin, deviceName: 'Owned native desktop', capabilityClaims: ['workflow.read', 'session/prompt'] }); connectionId = pairing.connection.connectionId
    assert.equal(pairing.browser, 'opened'); assert.equal(pairing.connection.projectId, null); assert.equal(pairing.connection.ownerId, null); assert.equal(pairing.connection.state, 'pending')
    assert.equal(JSON.stringify(pairing).includes(token), false); assert.equal(readFileSync(join(directory, 'team-desktop.sqlite')).includes(Buffer.from(token)), false)
    await assert.rejects(client.heartbeat(connectionId), (error) => error.code === 'ACCESS_LOCKED')
    await assert.rejects(client.queueAuthoredPublication(authored()), (error) => error.code === 'ACCESS_LOCKED')
    assert.equal(wire.some((item) => item.path === '/api/devices/heartbeat'), false)
  })
  await check('unavailable system encryption never opens verification browser or saves an unprotected token', async () => {
    const isolated = await api.DesktopTeamService.open({ ...options, dataDir: join(temporary, 'crypto-failure'), protectSecret: () => { throw Error('Owned unavailable crypto') }, openExternal: async () => { throw Error('Must never open') } })
    const count = browsers.length
    await assert.rejects(isolated.beginPairing({ origin, deviceName: 'Crypto failure', capabilityClaims: [] }), (error) => error.code === 'CREDENTIAL_UNAVAILABLE')
    assert.equal((await isolated.connections()).length, 0); assert.equal(browsers.length, count); await isolated.close()
  })
  await check('pending setup polling remains eligible without granting heartbeat or publication', async () => {
    await waitForPoll((await client.connections()).find((item) => item.connectionId === connectionId))
    const pending = await client.pollPairing(connectionId)
    assert.equal(pending.state, 'pending'); assert.equal(pending.accessLocked, false); assert.equal(pending.remoteDevice.online, false)
    await assert.rejects(client.heartbeat(connectionId), (error) => error.code === 'ACCESS_LOCKED')
  })
  await check('real OIDC browser selects project and device binds exact person once; approval is not online', async () => {
    const current = await approve(pairing)
    assert.equal(current.projectId, projectId); assert.equal(current.ownerId, bobSession.person.userId); assert.equal(current.accessLocked, false)
    assert.equal(current.userCode, null); assert.equal(current.verificationUri, null)
    assert.equal(current.remoteDevice.capabilityEvidence, 'device-declared')
  })
  await check('connection context uses current actual OIDC person/project roles and follows an explicitly empty page boundary', async () => {
    const context = await client.connectionContext(connectionId)
    assert.equal(context.person.userId, bobSession.person.userId); assert.equal(context.person.displayName, bobSession.person.displayName); assert.equal(context.project.projectId, projectId); assert.equal(context.project.name, 'Desktop integration project'); assert.deepEqual(context.project.roles, ['developer', 'tester'])
    projectPageBoundary = 1
    const afterEmptyPage = await client.connectionContext(connectionId); assert.equal(projectPageBoundary, 3); assert.equal(afterEmptyPage.project.projectId, projectId); projectPageBoundary = 0
    offline = true; await assert.rejects(client.connectionContext(connectionId), (error) => error.code === 'NETWORK_UNAVAILABLE'); offline = false
  })
  await check('actual authenticated heartbeat reserves persistent sequence and records server receipt', async () => {
    const a = await client.heartbeat(connectionId), b = await client.heartbeat(connectionId)
    assert.equal(a.remoteDevice.online, true); assert.ok(a.remoteDevice.lastSeenAt); assert.equal(b.remoteDevice.sequence, a.remoteDevice.sequence + 1)
    assert.ok(wire.every((item) => !item.hasOrigin && !item.hasCookie))
  })
  await check('queued selected immutable material survives offline restart and later disk B without replacing A', async () => {
    const selectedPath = join(temporary, 'selected.md'), textA = '# Selected immutable A\n\n姓名🙂 quote A.'; writeFileSync(selectedPath, textA)
    publicationId = randomUUID(); publicationCommand = randomUUID()
    offline = true
    const queued = await client.queueMaterialPublication({ connectionId, commandId: publicationCommand, materialId: publicationId, title: 'Selected A', visibility: 'project', expectedVersion: null }, { repositoryId: 'C:/private/project', workspaceId: 'local/worktree-A', taskRef: 'tasks/topic-A', relativePath: '.trellis/tasks/topic-A/prd.md', version: 'native/version-A', text: readFileSync(selectedPath, 'utf8'), bodyDigest: digest(textA), kind: 'trellis-prd' })
    assert.equal(queued.state, 'queued'); assert.equal(queued.outcomeUnknown, false)
    writeFileSync(selectedPath, '# Disk B must not be sent')
    await assert.rejects(client.dispatch(publicationCommand), (error) => error.code === 'NETWORK_UNAVAILABLE')
    assert.equal((await outboxAll(connectionId)).find((item) => item.commandId === publicationCommand).state, 'queued')
    await client.close(); client = await api.DesktopTeamService.open(options)
    assert.equal((await outboxAll(connectionId)).find((item) => item.commandId === publicationCommand).state, 'queued')
    offline = false
    const committed = await client.dispatch(publicationCommand); assert.equal(committed.state, 'committed'); assert.equal(committed.outcomeUnknown, false)
    const document = await client.readDocument({ connectionId, materialId: publicationId, version: 1 }); assert.equal(document.document.text, textA)
    assert.notEqual(document.document.material.source.repositoryId, 'C:/private/project'); assert.notEqual(document.document.material.source.taskRef, 'tasks/topic-A')
    assert.equal(JSON.stringify(document.document.material.source).includes('C:/private'), false)
  })
  await check('same command cannot overwrite payload; Unicode/UTF8/envelope violations stop before POST', async () => {
    const value = authored(), first = await client.queueAuthoredPublication(value)
    await assert.rejects(client.queueAuthoredPublication({ ...value, title: 'Changed' }), (error) => error.code === 'COMMAND_CONFLICT')
    assert.equal((await outboxAll(connectionId)).find((item) => item.commandId === first.commandId).title, value.title)
    const sent = wire.filter((item) => item.path === '/api/materials').length
    await assert.rejects(client.queueAuthoredPublication(authored({ text: '中'.repeat(400000) })), (error) => error.code === 'CAPACITY_EXCEEDED')
    await assert.rejects(client.queueAuthoredPublication(authored({ text: '\u0000'.repeat(400000) })), (error) => error.code === 'CAPACITY_EXCEEDED')
    await assert.rejects(client.queueAuthoredPublication(authored({ text: 'Bad \ud800' })))
    assert.equal(wire.filter((item) => item.path === '/api/materials').length, sent)
  })
  await check('actual worker admission followed by main-process exit reopens unknown, never automatically requeues or resends', async () => {
    const value = authored(); await client.queueAuthoredPublication(value); await client.close()
    const child = await promisify(execFile)(process.execPath, [resolve('scripts/smoke/fixtures/team-desktop-store-child.mjs'), pathToFileURL(bundleFile).href, directory, workerFile, value.commandId], { windowsHide: true, timeout: 15000 })
    assert.ok(child.stdout.includes('OWNED_DESKTOP_CLAIM_COMMITTED'))
    client = await api.DesktopTeamService.open(options)
    const retained = (await outboxAll(connectionId)).find((item) => item.commandId === value.commandId)
    assert.equal(retained.state, 'acknowledgement-unknown'); assert.equal(retained.outcomeUnknown, true)
    assert.ok(readdirSync(directory).some((name) => name.endsWith('.stale')))
    await assert.rejects(client.dispatch(value.commandId), (error) => error.code === 'RECONCILE_REQUIRED')
    const missing = await client.reconcile(value.commandId); assert.equal(missing.reconciliation, 'missing-at-read-point'); assert.equal(missing.state, 'acknowledgement-unknown')
    assert.equal((await client.dispatch(value.commandId, { retryUnknown: true })).state, 'committed')
  })
  await check('response loss after actual HTTP commit reconciles original receipt after restart without a second publication', async () => {
    const value = authored(); await client.queueAuthoredPublication(value); dropCommand = value.commandId
    const unknown = await client.dispatch(value.commandId); assert.equal(unknown.state, 'acknowledgement-unknown'); assert.equal(unknown.outcomeUnknown, true)
    assert.equal((await alice.api(`/api/materials/${value.materialId}/versions`)).body.value.items.length, 1)
    const count = wire.filter((item) => item.commandId === value.commandId).length
    await client.close(); client = await api.DesktopTeamService.open(options)
    const reconciled = await client.reconcile(value.commandId); assert.equal(reconciled.state, 'committed'); assert.equal(reconciled.attempts, 1); assert.equal(reconciled.outcomeUnknown, false)
    assert.equal((await client.dispatch(value.commandId)).state, 'committed'); assert.equal(wire.filter((item) => item.commandId === value.commandId).length, count)
  })
  await check('mismatched publication author in an owned response cannot settle a real remote commit as a verified receipt', async () => {
    const value = authored(); await client.queueAuthoredPublication(value); corruptReceiptAuthor = value.commandId
    const observed = await client.dispatch(value.commandId)
    assert.equal(observed.state, 'acknowledgement-unknown'); assert.equal(observed.outcomeUnknown, true); assert.equal(observed.lastErrorCode, 'RECEIPT_MISMATCH'); assert.equal(observed.receipt, null)
    const actual = await alice.api(`/api/materials/${value.materialId}/versions/1`); assert.equal(actual.status, 200); assert.equal(actual.body.value.material.authorId, bobSession.person.userId)
    const reconciled = await client.reconcile(value.commandId); assert.equal(reconciled.state, 'committed'); assert.equal(reconciled.receipt.authorId, bobSession.person.userId); assert.equal(reconciled.attempts, 1)
  })
  await check('selected old remote version and UTF16 feedback survive publisher offline, later B and local restart', async () => {
    const a = await client.readDocument({ connectionId, materialId: publicationId, version: 1 }), quote = '姓名🙂 quote A.', start = a.document.text.indexOf(quote)
    const next = authored({ materialId: publicationId, title: 'Selected B', expectedVersion: 1, sourceVersion: 'selected-B', text: '# New B without the old quote' }); await client.queueAuthoredPublication(next); assert.equal((await client.dispatch(next.commandId)).state, 'committed')
    offline = true; const cached = await client.readDocument({ connectionId, materialId: publicationId, version: 1, allowOffline: true }); assert.equal(cached.freshness, 'cached-offline'); assert.equal(cached.authorization, 'last-observed'); assert.equal(cached.document.text, a.document.text)
    feedbackCommand = randomUUID()
    const feedback = { connectionId, commandId: feedbackCommand, feedbackId: randomUUID(), materialId: publicationId, version: 1, body: 'Recorded product suggestion', quote, anchor: { start, end: start + quote.length } }
    await assert.rejects(client.queueFeedback({ ...feedback, anchor: { start: 0, end: quote.length } }), (error) => error.code === 'ANCHOR_MISMATCH')
    await client.queueFeedback(feedback); await client.close()
    const onlineWhileDesktopOff = await alice.api(`/api/materials/${publicationId}/versions/1`); assert.equal(onlineWhileDesktopOff.body.value.text, a.document.text)
    offline = false; client = await api.DesktopTeamService.open(options)
    const result = await client.dispatch(feedbackCommand); assert.equal(result.state, 'committed'); assert.equal(result.receipt.version, 1); assert.equal(result.receipt.applied, false); assert.equal(result.receipt.state, 'recorded')
    assert.equal((await client.listFeedback({ connectionId, materialId: publicationId, version: 1 })).items.length, 1)
  })
  await check('actual cursor reset requires authorized snapshot; selected cached version and paging stay independent', async () => {
    const first = await client.syncEvents(connectionId); assert.equal(first.snapshotRequired, true)
    const snapshot = await client.refreshSharedSnapshot(connectionId); assert.ok(snapshot.items.length); assert.equal(snapshot.resetRequired, false)
    const list = await client.listMaterials({ connectionId, limit: 1 }); assert.equal(list.items.length, 1); assert.equal(list.hasMore, true)
    const later = await client.listMaterials({ connectionId, limit: 1, cursor: list.nextCursor }); assert.notEqual(later.items[0].materialId, list.items[0].materialId)
    assert.equal((await client.readDocument({ connectionId, materialId: publicationId, version: 1 })).document.material.version, 1)
    const members = await alice.api(`/api/projects/${projectId}/members`); const bobMember = members.body.value.items.find((item) => item.userId === bobSession.person.userId)
    await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['developer', 'tester'], active: true, expectedRevision: bobMember.revision })
    const reset = await client.syncEvents(connectionId); assert.equal(reset.page.resetRequired, true); assert.equal(reset.snapshotRequired, true)
    assert.equal((await client.cachedSnapshot(connectionId)).resetRequired, true)
    await client.refreshSharedSnapshot(connectionId); assert.equal((await client.cachedSnapshot(connectionId)).resetRequired, false)
  })
  await check('declared event backlog stays visible across restart instead of becoming caught-up from a metadata snapshot', async () => {
    forceEventMore = true; assert.equal((await client.syncEvents(connectionId)).page.hasMore, true)
    assert.equal((await client.refreshSharedSnapshot(connectionId)).eventsHasMore, true)
    assert.equal((await client.cachedSnapshot(connectionId)).eventsHasMore, true)
    await client.close(); client = await api.DesktopTeamService.open(options)
    assert.equal((await client.cachedSnapshot(connectionId)).eventsHasMore, true)
    forceEventMore = false; assert.equal((await client.syncEvents(connectionId)).page.hasMore, false); assert.equal((await client.cachedSnapshot(connectionId)).eventsHasMore, false)
  })
  await check('bounded outbox paging retains every row and deliberate queued cancellation never sends', async () => {
    const value = authored(); await client.queueAuthoredPublication(value); const before = wire.length
    const cancelled = await client.cancelQueued(value.commandId); assert.equal(cancelled.state, 'cancelled-before-dispatch')
    assert.equal((await client.dispatch(value.commandId)).state, 'cancelled-before-dispatch'); assert.equal(wire.length, before)
    const all = await outboxAll(connectionId); assert.equal(new Set(all.map((item) => item.commandId)).size, all.length); assert.ok(all.length >= 7)
    const page = await client.outbox(connectionId, { limit: 1 }); assert.equal(page.hasMore, true)
    assert.equal((await client.outbox(connectionId, { cursor: page.nextCursor, limit: 1 })).items.length, 1)
  })
  await check('offline cache validates the exact requested material/version identity even when stored body digest remains valid', async () => {
    await client.close()
    const path = join(directory, 'team-desktop.sqlite'), db = new DatabaseSync(path), key = `${connectionId}:${publicationId}:1`
    const row = db.prepare('SELECT data FROM documents WHERE key=?').get(key), original = row.data
    const copied = JSON.parse(original); copied.document.material.materialId = randomUUID(); copied.document.material.version = 99
    db.prepare('UPDATE documents SET data=? WHERE key=?').run(JSON.stringify(copied), key); db.close()
    try {
      client = await api.DesktopTeamService.open(options); offline = true
      await assert.rejects(client.readDocument({ connectionId, materialId: publicationId, version: 1, allowOffline: true }), (error) => error.code === 'CORRUPT_STORE')
    } finally {
      offline = false; await client.close(); const restore = new DatabaseSync(path); restore.prepare('UPDATE documents SET data=? WHERE key=?').run(original, key); restore.close(); client = await api.DesktopTeamService.open(options)
    }
  })
  await check('cached metadata copied from a different project cannot be displayed as the current connection snapshot', async () => {
    await client.close()
    const path = join(directory, 'team-desktop.sqlite'), db = new DatabaseSync(path), original = db.prepare('SELECT data FROM sync WHERE connectionId=?').get(connectionId).data
    const copied = JSON.parse(original); assert.ok(copied.snapshot.items.length); copied.snapshot.items[0].projectId = randomUUID()
    db.prepare('UPDATE sync SET data=? WHERE connectionId=?').run(JSON.stringify(copied), connectionId); db.close()
    try { client = await api.DesktopTeamService.open(options); await assert.rejects(client.cachedSnapshot(connectionId), (error) => error.code === 'CORRUPT_STORE') }
    finally { await client.close(); const restore = new DatabaseSync(path); restore.prepare('UPDATE sync SET data=? WHERE connectionId=?').run(original, connectionId); restore.close(); client = await api.DesktopTeamService.open(options) }
  })
  await check('an earlier unknown dispatch survives a later actual CAS rejection after explicit missing-receipt reconciliation', async () => {
    const value = authored({ materialId: publicationId, expectedVersion: null }); await client.queueAuthoredPublication(value); failPostCommand = value.commandId
    assert.equal((await client.dispatch(value.commandId)).outcomeUnknown, true)
    const retry = await client.dispatch(value.commandId, { retryUnknown: true })
    assert.equal(retry.lastErrorCode, 'REVISION_CONFLICT'); assert.equal(retry.outcomeUnknown, true); assert.equal(retry.state, 'acknowledgement-unknown')
    await client.close(); client = await api.DesktopTeamService.open(options)
    assert.equal((await outboxAll(connectionId)).find((item) => item.commandId === value.commandId).outcomeUnknown, true)
    const firstKnownConflict = authored({ materialId: publicationId, expectedVersion: null }); await client.queueAuthoredPublication(firstKnownConflict)
    const known = await client.dispatch(firstKnownConflict.commandId); assert.equal(known.state, 'conflict'); assert.equal(known.outcomeUnknown, false)
  })
  await check('valid command data copied under another SQLite command key fails closed without retargeting an operation', async () => {
    const copy = authored(); await client.queueAuthoredPublication(copy); await client.close()
    const path = join(directory, 'team-desktop.sqlite'), db = new DatabaseSync(path)
    const original = db.prepare('SELECT data FROM commands WHERE id=?').get(publicationCommand).data
    const copied = db.prepare('SELECT data FROM commands WHERE id=?').get(copy.commandId).data
    db.prepare('UPDATE commands SET data=? WHERE id=?').run(copied, publicationCommand); db.close()
    try {
      await assert.rejects(async () => { client = await api.DesktopTeamService.open(options) }, (error) => error.code === 'CORRUPT_STORE')
      const retained = new DatabaseSync(path, { readOnly: true }); try { assert.equal(retained.prepare('SELECT data FROM commands WHERE id=?').get(publicationCommand).data, copied) } finally { retained.close() }
    } finally {
      await client.close(); const restore = new DatabaseSync(path); restore.prepare('UPDATE commands SET data=? WHERE id=?').run(original, publicationCommand); restore.close(); client = await api.DesktopTeamService.open(options)
    }
  })
  await check('bad immutable-body digest is a visible protocol failure and never silently falls back to cached success', async () => {
    corruptRead = true; await assert.rejects(client.readDocument({ connectionId, materialId: publicationId, version: 1, allowOffline: true }), (error) => error.code === 'BODY_MISMATCH'); corruptRead = false
    failDecrypt = true; const before = wire.length; await assert.rejects(client.heartbeat(connectionId), (error) => error.code === 'CREDENTIAL_UNAVAILABLE'); assert.equal(wire.length, before); failDecrypt = false
    const locked = (await client.connections()).find((item) => item.connectionId === connectionId); assert.equal(locked.accessLocked, true); await waitForPoll(locked); assert.equal((await client.pollPairing(connectionId)).accessLocked, false)
  })
  await check('protected enrollment tuple rejects a tampered origin before network or cached-body access', async () => {
    await client.close()
    const path = join(directory, 'team-desktop.sqlite'), db = new DatabaseSync(path), row = db.prepare('SELECT data FROM connections WHERE id=?').get(connectionId), original = row.data
    const modified = JSON.parse(original); modified.origin = 'https://other-origin.invalid'; db.prepare('UPDATE connections SET data=? WHERE id=?').run(JSON.stringify(modified), connectionId); db.close()
    client = await api.DesktopTeamService.open(options); const before = wire.length
    await assert.rejects(client.readDocument({ connectionId, materialId: publicationId, version: 1, allowOffline: true }), (error) => error.code === 'CREDENTIAL_UNAVAILABLE')
    assert.equal(wire.length, before); await assert.rejects(client.cachedSnapshot(connectionId), (error) => error.code === 'ACCESS_LOCKED')
    await client.close(); const restore = new DatabaseSync(path); restore.prepare('UPDATE connections SET data=? WHERE id=?').run(original, connectionId); restore.close()
    client = await api.DesktopTeamService.open(options); await client.heartbeat(connectionId)
  })
  await check('non-JSON HTTP access denial locks cache; explicit original-binding reverify can resume a never-sent intent', async () => {
    const value = authored(); await client.queueAuthoredPublication(value)
    denyHtml = true
    await assert.rejects(client.readDocument({ connectionId, materialId: publicationId, version: 1, allowOffline: true }), (error) => error.code === 'FORBIDDEN')
    await assert.rejects(client.cachedSnapshot(connectionId), (error) => error.code === 'ACCESS_LOCKED')
    const locked = (await client.connections()).find((item) => item.connectionId === connectionId)
    const intent = (await outboxAll(connectionId)).find((item) => item.commandId === value.commandId); assert.equal(intent.state, 'access-revoked'); assert.equal(intent.outcomeUnknown, false)
    denyHtml = false; await waitForPoll(locked); assert.equal((await client.pollPairing(connectionId)).accessLocked, false)
    await assert.rejects(client.dispatch(value.commandId), (error) => error.code === 'RECONCILE_REQUIRED')
    assert.equal((await client.dispatch(value.commandId, { retryUnknown: true })).state, 'committed')
  })
  await check('concurrent close drains an admitted actual POST and receipt before releasing the writer', async () => {
    const value = authored(); await client.queueAuthoredPublication(value)
    let enter, release; const entered = new Promise((done) => { enter = done }), wait = new Promise((done) => { release = done }); heldWrite = { commandId: value.commandId, enter, wait }
    const dispatch = client.dispatch(value.commandId); await entered
    let closed = false; const first = client.close().then(() => { closed = true }), second = client.close()
    await new Promise((done) => setTimeout(done, 30)); assert.equal(closed, false)
    await assert.rejects(client.connections(), (error) => error.code === 'SERVICE_CLOSED')
    release(); assert.equal((await dispatch).state, 'committed'); await Promise.all([first, second]); heldWrite = null
    client = await api.DesktopTeamService.open(options); assert.equal((await outboxAll(connectionId)).find((item) => item.commandId === value.commandId).state, 'committed')
  })
  await check('actual committed local write with lost worker acknowledgement remains unknown and original main lock stays held', async () => {
    const coreFile = join(temporary, 'desktop-core.cjs'), faultFile = join(temporary, 'ack-loss-worker.cjs'), faultDirectory = join(temporary, 'worker-ack-loss')
    await build({ entryPoints: ['src/main/services/team-platform/store-core.ts'], outfile: coreFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    writeFileSync(faultFile, `const {parentPort}=require('node:worker_threads');const {DesktopTeamStoreCore}=require(${JSON.stringify(coreFile)});let core;parentPort.on('message',request=>{if(request.op==='init'){core=new DesktopTeamStoreCore(request.input.dataDir);parentPort.postMessage({requestId:request.requestId,ok:true,value:core.dispatch({op:'health'})});return}const value=core.dispatch(request);if(request.op==='add-connection')process.exit(0);parentPort.postMessage({requestId:request.requestId,ok:true,value})});`)
    const store = await api.DesktopTeamStore.open({ dataDir: faultDirectory, workerFile: faultFile })
    const record = { connectionId: randomUUID(), origin, pairingId: randomUUID(), deviceId: randomUUID(), deviceName: 'Owned local ACK fault', state: 'pending', projectId: null, ownerId: null, userCode: 'ABCDEFGHIJ', verificationUri: origin + '/', expiresAt: Date.now() + 10000, pollAfterMs: 1000, nextPollAt: Date.now() + 1000, encryptedToken: protect('Owned local encrypted fixture'), capabilityClaims: [], sequence: -1, accessLocked: false, network: 'unknown', lastCheckedAt: null, lastErrorCode: null, remoteDevice: null }
    await assert.rejects(store.call({ op: 'add-connection', input: record }), (error) => error.code === 'ACKNOWLEDGEMENT_UNKNOWN' && error.outcomeUnknown)
    await assert.rejects(api.DesktopTeamStore.open({ dataDir: faultDirectory, workerFile }), (error) => error.code === 'STORE_OWNED')
    await store.close()
    const reopened = await api.DesktopTeamStore.open({ dataDir: faultDirectory, workerFile }); assert.equal((await reopened.call({ op: 'connections' }))[0].connectionId, record.connectionId)
    await assert.rejects(reopened.call({ op: 'add-connection', input: { body: 'x'.repeat(4 * 1024 * 1024) } }), (error) => error.code === 'CAPACITY_EXCEEDED'); await reopened.close()
  })
  await check('actual HTTP commit followed by local writer death cannot be reported as a certainly failed remote action', async () => {
    const value = authored(); await client.queueAuthoredPublication(value); killAfterPost = value.commandId
    await assert.rejects(client.dispatch(value.commandId), (error) => error.code === 'ACKNOWLEDGEMENT_UNKNOWN' && error.outcomeUnknown)
    await client.close(); client = await api.DesktopTeamService.open(options)
    const record = (await outboxAll(connectionId)).find((item) => item.commandId === value.commandId); assert.equal(record.state, 'acknowledgement-unknown'); assert.equal(record.outcomeUnknown, true)
    assert.equal((await client.reconcile(value.commandId)).state, 'committed'); assert.equal((await alice.api(`/api/materials/${value.materialId}/versions`)).body.value.items.length, 1)
  })
  await check('revocation locks cached bodies and preserves unknown outbound outcome; new pairing cannot retarget it', async () => {
    const value = authored(); await client.queueAuthoredPublication(value); dropCommand = value.commandId; assert.equal((await client.dispatch(value.commandId)).state, 'acknowledgement-unknown')
    const members = await alice.api(`/api/projects/${projectId}/members`); const member = members.body.value.items.find((item) => item.userId === bobSession.person.userId)
    await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: member.userId, roles: member.roles, active: false, expectedRevision: member.revision })
    await assert.rejects(client.reconcile(value.commandId), (error) => error.code === 'UNAUTHORIZED' && error.outcomeUnknown === true)
    await assert.rejects(client.dispatch(value.commandId, { retryUnknown: true }), (error) => error.code === 'ACCESS_LOCKED' && error.outcomeUnknown === true)
    const stranded = (await outboxAll(connectionId)).find((item) => item.commandId === value.commandId); assert.equal(stranded.state, 'access-revoked'); assert.equal(stranded.outcomeUnknown, true)
    await assert.rejects(client.readDocument({ connectionId, materialId: publicationId, version: 1, allowOffline: true }), (error) => error.code === 'ACCESS_LOCKED'); await assert.rejects(client.cachedSnapshot(connectionId), (error) => error.code === 'ACCESS_LOCKED')
    const fresh = await client.beginPairing({ origin, deviceName: 'Other person actual device', capabilityClaims: [] }); const active = await approve(fresh, alice)
    assert.notEqual(active.ownerId, bobSession.person.userId)
    await assert.rejects(client.queueAuthoredPublication({ ...value, connectionId: active.connectionId }), (error) => error.code === 'COMMAND_CONFLICT')
    const oldCursor = (await client.outbox(connectionId, { limit: 1 })).nextCursor
    await assert.rejects(client.outbox(active.connectionId, { cursor: oldCursor, limit: 1 }), (error) => error.code === 'CURSOR_CONFLICT')
    const changedMembers = await alice.api(`/api/projects/${projectId}/members`); const revoked = changedMembers.body.value.items.find((item) => item.userId === member.userId)
    await alice.api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: member.userId, roles: member.roles, active: true, expectedRevision: revoked.revision })
    const old = (await client.connections()).find((item) => item.connectionId === connectionId); await waitForPoll(old); assert.equal((await client.pollPairing(connectionId)).state, 'revoked')
  })
  await check('live main owner is not stolen; actual writer exit retains main lock; future database is preserved', async () => {
    await assert.rejects(api.DesktopTeamService.open(options), (error) => error.code === 'STORE_OWNED')
    await client.store.worker.terminate(); await new Promise((done) => setTimeout(done, 20))
    await assert.rejects(api.DesktopTeamService.open(options), (error) => error.code === 'STORE_OWNED')
    await client.close(); client = await api.DesktopTeamService.open(options); await client.close(); client = null
    const path = join(directory, 'team-desktop.sqlite'), db = new DatabaseSync(path); db.exec('PRAGMA user_version=99'); db.close(); const before = digest(readFileSync(path))
    await assert.rejects(api.DesktopTeamService.open(options), (error) => error.code === 'STORE_VERSION'); assert.equal(digest(readFileSync(path)), before)
  })
  const report = { status: 'passed', scenarios: results.length, results, scope: 'Actual desktop service/store/worker/process-exit and HTTP/OIDC two-account server integration; explicit owned AES/browser/fetch failure seams, not real OS safeStorage or UI/corporate deployment', versions: { node: process.version }, notRun: ['real Electron safeStorage', 'root IPC/preload/renderer integration', 'company SSO/TLS/deployment', 'OS power-loss durability', 'full R2/source scenarios'] }
  if (reportAt >= 0) { const reportPath = resolve(process.argv[reportAt + 1]); mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n') }
  console.log(`PASS team desktop: ${results.length} actual integration groups`)
} finally {
  if (client) await client.close().catch(() => {})
  if (server) await server.close()
  if (oidc) await oidc.close()
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir())); assert.ok(basename(temporary).startsWith('trellis-team-desktop-')); rmSync(temporary, { recursive: true, force: true })
}
