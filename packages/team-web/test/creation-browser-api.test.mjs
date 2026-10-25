import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const { build } = createRequire(join(repo, 'package.json'))('esbuild')
const { createTeamService, restoreTeamBackup } = await import(pathToFileURL(join(repo, 'packages/team-service/dist/index.mjs')).href)
const { BrowserAccount, createOidcFixture, freePort } = await import(pathToFileURL(join(repo, 'packages/team-service/test/oidc-fixture.mjs')).href)

test('authenticated CreationApi routes, recovery and cross-computer head polling', { timeout: 120_000 }, async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'trellis-creation-browser-'))
  const originalFetch = globalThis.fetch, originalLocation = globalThis.location, originalStorage = globalThis.sessionStorage, originalDocument = globalThis.document
  const page = new EventTarget(); page.visibilityState = 'visible'; globalThis.document = page
  const storage = new Map(), commands = [], reads = [], events = []
  let identity, service, workspace, release, unsubscribe
  const releaseGates = new Set()
  const bounded = async (promise, label) => {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Timeout: ' + label)), 20000) })]) }
    finally { clearTimeout(timer) }
  }
  const wait = async (predicate, label, timeout = 20000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 25)) }
    throw Error('Timeout: ' + label)
  }
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    for (const finish of releaseGates) finish()
    unsubscribe?.(); release?.(); workspace?.dispose()
    globalThis.fetch = originalFetch; globalThis.location = originalLocation; globalThis.sessionStorage = originalStorage; globalThis.document = originalDocument
    try { await service?.close() } finally { await identity?.close() }
    const cleanupTarget = resolve(temporary)
    assert.ok(cleanupTarget.startsWith(resolve(tmpdir()) + sep) && basename(cleanupTarget).startsWith('trellis-creation-browser-'))
    rmSync(cleanupTarget, { recursive: true, force: true })
  }
  t.after(cleanup)
  try {
    const origin = `http://127.0.0.1:${await freePort()}`
    identity = await createOidcFixture(origin)
    await build({ stdin: { contents: "export {BrowserHifoxWorkspace,bindBrowserHifox,api} from './packages/team-web/src/hifox-browser-api';export {setClientSession,pendingCommands} from './packages/team-web/src/client';", resolveDir: repo, loader: 'ts' }, outfile: join(temporary, 'client.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    let client = await import(pathToFileURL(join(temporary, 'client.mjs')).href)
    const config = (dataDir) => ({ dataDir, publicOrigin: origin, oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true })
    service = await createTeamService(config(join(temporary, 'store')))
    await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
    const alice = new BrowserAccount(origin, 'alice'), bob = new BrowserAccount(origin, 'bob')
    const session = await alice.signIn(), bobSession = await bob.signIn()
    const admin = async (path, body) => { const response = await alice.api(path, body); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.value }
    const team = await admin('/api/teams', { commandId: randomUUID(), name: 'Creation adapter team' })
    const projectReply = await admin('/api/projects', { commandId: randomUUID(), teamId: team.result.teamId, name: 'Creation adapter project' })
    const project = { projectId: projectReply.result.projectId, teamId: team.result.teamId, name: 'Creation adapter project', roles: ['pm'], createdAt: Date.now() }
    globalThis.location = { origin }
    globalThis.sessionStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
    const cookies = () => [...alice.cookies.get('127.0.0.1')].map(([key, value]) => `${key}=${value}`).join('; ')
    const transport = async (path, options = {}) => {
      if (typeof path !== 'string' || !path.startsWith('/')) return originalFetch(path, options)
      assert.equal(options.credentials, 'same-origin')
      assert.equal(options.redirect, 'error')
      if (options.body) { commands.push({ path, body: JSON.parse(options.body) }); assert.equal(options.headers['X-CSRF-Token'], session.csrfToken) }
      else reads.push(path)
      return originalFetch(origin + path, { ...options, headers: { ...options.headers, Origin: origin, Cookie: cookies() } })
    }
    globalThis.fetch = transport
    const connect = async (reload = false) => {
      unsubscribe?.(); release?.(); workspace?.dispose()
      if (reload) client = await import(pathToFileURL(join(temporary, 'client.mjs')).href + '?' + randomUUID())
      client.setClientSession(session)
      workspace = new client.BrowserHifoxWorkspace({ project, session }); release = client.bindBrowserHifox(workspace)
      const initial = await workspace.hifox.snapshot(); assert.equal(initial.ok, true)
      unsubscribe = client.api.creations.onChanged((event) => events.push(event))
    }
    await connect()
    const key = () => workspace.context().key
    const creationId = randomUUID()
    const command = (action, expectedRevision, fields = {}, id = creationId) => ({ workspaceKey: key(), command: { action, commandId: randomUUID(), creationId: id, expectedRevision, ...fields } })
    const invoke = async (input) => { const result = await client.api.creations.command(input); assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
    const created = await invoke(command('create', null, { title: 'Browser private creation', kind: 'prototype', home: 'personal', spaceId: null, body: '<html><body>中文🙂SOURCE_BODY_PRIVATE</body></html>', privateNotes: 'PRIVATE_NOTE_NOT_IN_JOURNAL' }))
    assert.equal(created.result.creationId, creationId)
    assert.equal(commands.at(-1).body.expectedEpoch, workspace.context().epoch)
    assert.equal(events.at(-1).creationId, creationId); assert.equal(events.at(-1).workspaceKey, key())
    const listing = await client.api.creations.list({ workspaceKey: key(), scope: 'personal', limit: 20 })
    assert.equal(listing.ok, true); assert.equal(listing.value.items[0].creationId, creationId)
    assert.ok(!JSON.stringify(listing).includes('SOURCE_BODY_PRIVATE'))
    const read = await client.api.creations.get({ workspaceKey: key(), creationId })
    assert.equal(read.ok, true); assert.ok(read.value.selected.body.includes('中文🙂SOURCE_BODY_PRIVATE'))
    let mismatch = false
    globalThis.fetch = async (path, options) => {
      const response = await transport(path, options)
      if (!mismatch && path.startsWith(`/api/projects/${project.projectId}/creations/${creationId}?`)) { mismatch = true; const raw = await response.json(); raw.value.selected.body = 'tampered'; return Response.json(raw) }
      return response
    }
    assert.equal((await client.api.creations.get({ workspaceKey: key(), creationId })).code, 'BODY_MISMATCH')
    globalThis.fetch = transport
    t.diagnostic('actual authenticated browser shim routes, CSRF, list/view identity, body digest and write notifications')

    const generation = { workspaceKey: key(), creationId, commandId: randomUUID(), expectedRevision: 1, commentIds: [randomUUID()] }
    const beforeModels = commands.length
    assert.equal((await client.api.creations.planCandidate(generation)).code, 'MODEL_UNAVAILABLE')
    assert.equal((await client.api.creations.generateCandidate(generation)).code, 'MODEL_UNAVAILABLE')
    assert.deepEqual(await client.api.creations.cancelCandidate({ workspaceKey: key(), commandId: generation.commandId }), { ok: true, value: { cancelled: false } })
    assert.equal(commands.length, beforeModels)
    t.diagnostic('unavailable browser model generation is structured and cancellation reports false')

    let lost = false
    globalThis.fetch = async (path, options) => { const response = await transport(path, options); if (options.body && path.endsWith('/creations/commands') && !lost) { lost = true; await response.body.cancel(); throw Error('lost committed reply') }; return response }
    const unknown = await client.api.creations.command(command('saveDraft', 1, { body: '<html>Retained original中文🙂</html>', privateNotes: 'UNPERSISTED_NOTE' }))
    assert.equal(unknown.ok, false); assert.equal(unknown.outcomeUnknown, true)
    const original = structuredClone(commands.at(-1)), journal = storage.get('trellis-team-command-refs-v1')
    assert.ok(journal.includes(original.body.commandId)); assert.ok(!journal.includes('Retained original')); assert.ok(!journal.includes('UNPERSISTED_NOTE')); assert.ok(!journal.includes(session.csrfToken))
    assert.equal((await client.api.creations.command(command('saveDraft', 1, { body: 'Different intent' }))).code, 'PENDING_OPERATION')
    const count = commands.length
    globalThis.fetch = async (path, options) => path.startsWith('/api/commands/') ? Response.json({ ok: false, code: 'CREATION_FORBIDDEN', error: 'Receipt temporarily forbidden' }, { status: 403 }) : transport(path, options)
    const deniedRecovery = await client.api.creations.recover({ workspaceKey: key(), creationId })
    assert.equal(deniedRecovery.code, 'CREATION_FORBIDDEN'); assert.equal(deniedRecovery.outcomeUnknown, true)
    assert.ok(client.pendingCommands(session.person.userId).some((entry) => entry.commandId === original.body.commandId)); assert.equal(commands.length, count)
    globalThis.fetch = transport
    const recovered = await client.api.creations.recover({ workspaceKey: key(), creationId })
    assert.equal(recovered.ok, true, JSON.stringify(recovered)); assert.equal(recovered.value.commandId, original.body.commandId); assert.equal(commands.length, count)
    assert.equal(client.pendingCommands(session.person.userId).length, 0)
    assert.equal(events.at(-1).creationId, creationId)
    t.diagnostic('committed lost ACK reconciles the exact journal UUID without a second POST')

    let prevented = false, originalBody
    globalThis.fetch = async (path, options) => { if (options.body && path.endsWith('/creations/commands') && !prevented) { prevented = true; originalBody = JSON.parse(options.body); throw Error('lost before commit') }; return transport(path, options) }
    const originalInput = command('saveDraft', 2, { body: 'Exact retained payload 🙂' })
    assert.equal((await client.api.creations.command(originalInput)).outcomeUnknown, true)
    originalInput.command.body = 'Caller mutated its object'
    globalThis.fetch = transport
    const retry = await client.api.creations.recover({ workspaceKey: key(), creationId })
    assert.equal(retry.ok, true, JSON.stringify(retry)); assert.deepEqual(commands.at(-1).body, originalBody); assert.equal(retry.value.commandId, originalBody.commandId)
    t.diagnostic('absent receipt retries retained original UUID/payload instead of allocating a new command')

    lost = false
    globalThis.fetch = async (path, options) => { const response = await transport(path, options); if (options.body && path.endsWith('/creations/commands') && !lost) { lost = true; await response.body.cancel(); throw Error('lost before reload') }; return response }
    assert.equal((await client.api.creations.command(command('saveDraft', 3, { body: 'Committed before hard reload' }))).outcomeUnknown, true)
    const reloadCommand = structuredClone(commands.at(-1)), posts = commands.length
    globalThis.fetch = transport; await connect(true)
    const reloadRecovered = await client.api.creations.recover({ workspaceKey: key(), creationId })
    assert.equal(reloadRecovered.ok, true, JSON.stringify(reloadRecovered)); assert.equal(reloadRecovered.value.commandId, reloadCommand.body.commandId); assert.equal(commands.length, posts)
    prevented = false
    globalThis.fetch = async (path, options) => { if (options.body && path.endsWith('/creations/commands') && !prevented) { prevented = true; originalBody = JSON.parse(options.body); throw Error('original body unavailable after reload') }; return transport(path, options) }
    assert.equal((await client.api.creations.command(command('saveDraft', 4, { body: 'Unknown nonpersisted request' }))).outcomeUnknown, true)
    globalThis.fetch = transport; await connect(true)
    const noPayload = await client.api.creations.recover({ workspaceKey: key(), creationId })
    assert.equal(noPayload.ok, false); assert.equal(noPayload.code, 'PAYLOAD_UNAVAILABLE'); assert.equal(noPayload.outcomeUnknown, true)
    assert.ok(client.pendingCommands(session.person.userId).some((entry) => entry.commandId === originalBody.commandId))
    assert.equal(commands.length, posts)
    t.diagnostic('hard reload reconciles committed references but cannot reconstruct or replace missing original payloads')

    const readCount = reads.length
    client.setClientSession(bobSession)
    assert.equal((await client.api.creations.list({ workspaceKey: key(), scope: 'personal' })).code, 'OWNER_CHANGED')
    assert.equal(reads.length, readCount)
    client.setClientSession(session)
    assert.equal((await client.api.creations.list({ workspaceKey: 'another-project', scope: 'personal' })).code, 'OWNER_CHANGED')
    let entered, resume
    const began = new Promise((resolve) => { entered = resolve }), gate = new Promise((resolve) => { resume = resolve })
    globalThis.fetch = async (path, options) => { const response = await transport(path, options); if (path.startsWith(`/api/projects/${project.projectId}/creations/${creationId}?`)) { entered(); await gate }; return response }
    releaseGates.add(() => resume())
    const late = client.api.creations.get({ workspaceKey: key(), creationId }); await bounded(began, 'owned view request reached the gate')
    globalThis.fetch = transport; await connect(); resume()
    assert.equal((await late).code, 'OWNER_CHANGED')
    t.diagnostic('account/project/lease fences discard old-source responses across A -> B -> A')

    const pollingId = randomUUID()
    await invoke(command('create', null, { title: 'Remote poll target', kind: 'document', home: 'personal', spaceId: null, body: 'Remote version 1' }, pollingId))
    assert.equal((await client.api.creations.list({ workspaceKey: key(), scope: 'personal' })).ok, true)
    // First head tick can observe the writes already notified by their receipts.
    // Thereafter unchanged fingerprints must remain quiet.
    await new Promise((resolve) => setTimeout(resolve, 8500))
    const pollEvents = events.length, pollReads = reads.length
    await new Promise((resolve) => setTimeout(resolve, 8500))
    assert.equal(events.length, pollEvents, 'Unchanged metadata cannot emit repeated notifications')
    assert.ok(reads.slice(pollReads).filter((path) => path.endsWith('/creations/head')).length >= 1)
    const remote = await admin(`/api/projects/${project.projectId}/creations/commands`, { commandId: randomUUID(), creationId: pollingId, expectedRevision: 1, expectedEpoch: workspace.context().epoch, action: 'saveDraft', body: 'Remote version 2 from another computer' })
    assert.equal(remote.status, 'committed')
    await wait(() => events.length > pollEvents, 'real multi-computer metadata invalidation')
    assert.equal(events.length, pollEvents + 1)
    assert.equal(events.at(-1).creationId, null)
    await new Promise((resolve) => setTimeout(resolve, 8500))
    assert.equal(events.length, pollEvents + 1, 'Same metadata does not repeatedly notify')
    assert.ok(!reads.slice(pollReads).some((path) => /\/creations\/[0-9a-f-]+\?/.test(path)), 'Polling never downloads document/HTML bodies')
    assert.ok(!reads.slice(pollReads).some((path) => path.includes('/creations?')), 'Polling never re-downloads lists')
    const headCount = () => reads.filter((path) => path.endsWith('/creations/head')).length
    const visibleCount = headCount()
    page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 8500))
    assert.equal(headCount(), visibleCount, 'Hidden tabs do not poll')
    page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange'))
    await wait(() => headCount() > visibleCount, 'Visible tab resumes head polling')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const beforeForeign = events.length
    page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 25))
    const beforeWrongHead = headCount()
    globalThis.fetch = async (path, options) => { const response = await transport(path, options); if (path.endsWith('/creations/head')) { const raw = await response.json(); raw.value.epoch = randomUUID(); raw.value.fingerprint = 'a'.repeat(64); return Response.json(raw) }; return response }
    page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange'))
    await wait(() => headCount() > beforeWrongHead, 'Wrong-epoch head response received')
    await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(events.length, beforeForeign)
    page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 25))
    const beforeWrongProject = headCount()
    globalThis.fetch = async (path, options) => { const response = await transport(path, options); if (path.endsWith('/creations/head')) { const raw = await response.json(); raw.value.projectId = randomUUID(); raw.value.fingerprint = 'b'.repeat(64); return Response.json(raw) }; return response }
    page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange'))
    await wait(() => headCount() > beforeWrongProject, 'Wrong-project head response received')
    await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(events.length, beforeForeign)
    page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 25))
    let headEntered, releaseHead, pollAborted = false
    const headBegan = new Promise((resolve) => { headEntered = resolve }), headGate = new Promise((resolve) => { releaseHead = resolve })
    globalThis.fetch = async (path, options) => { const response = await transport(path, options); if (path.endsWith('/creations/head')) { options.signal.addEventListener('abort', () => { pollAborted = true }, { once: true }); headEntered(); await headGate }; return response }
    releaseGates.add(() => releaseHead())
    page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange')); await bounded(headBegan, 'owned head request reached the gate')
    page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'))
    assert.equal(pollAborted, true, 'In-flight head request aborts when page becomes inactive')
    releaseHead(); globalThis.fetch = transport
    await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(events.length, beforeForeign)
    page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange'))
    t.diagnostic('8-second head-only sync, distinct fingerprints, inactive tab pause/abort and project/epoch guards')

    const oldEpoch = workspace.context().epoch, backup = join(temporary, 'backup'), restored = join(temporary, 'restored')
    await service.store.backup(backup); await service.close(); restoreTeamBackup(backup, restored)
    service = await createTeamService(config(restored)); await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
    assert.equal((await workspace.hifox.snapshot()).ok, true); assert.notEqual(workspace.context().epoch, oldEpoch)
    const beforeEpochRetry = commands.length
    const oldPending = await client.api.creations.recover({ workspaceKey: key(), creationId })
    assert.equal(oldPending.code, 'EPOCH_CONFLICT'); assert.equal(oldPending.outcomeUnknown, true); assert.equal(commands.length, beforeEpochRetry)
    t.diagnostic('restored source epoch refuses retargeting/replaying retained old commands')
    t.diagnostic('all browser CreationApi assertions')
  } finally {
    await cleanup()
  }
})
