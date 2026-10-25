/** Actual desktop SQLite/HTTP transport and remote coordinator. Owned bearer/crypto/server fixtures; no Electron or company identity. */
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'trellis-hifox-remote-'))
const directory = join(root, 'client'), key = randomBytes(32), wire = [], receipts = new Map(), projects = new Map(), connections = new Map(), results = []
const heads = { instanceId: randomUUID(), epoch: randomUUID(), authorizationRevision: 0 }
const protect = (text) => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64') }
const reveal = (text) => { const bytes = Buffer.from(text, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8') }
const check = async (name, action) => { await action(); results.push(name); console.log('PASS ' + name) }
const fail = (code, status = 403) => ({ status, body: { ok: false, code, error: 'Owned transport fixture boundary' } })
let api, service, client, origin, offline = false, dropped = false, dropBeforeCommit = false, failSettlement = false, corrupt = null, hold = null, commandHold = null, epochFailureCode = 'EPOCH_CONFLICT', offlineAfterEpochConflict = false, revoked = new Set(), postCount = 0
const stateFile = (scopeKey) => join(directory, 'hifox-remote', scopeKey, 'state.json')
const readState = (scopeKey = client.status().key) => JSON.parse(readFileSync(stateFile(scopeKey), 'utf8'))
const snapshot = (connection) => {
  const value = projects.get(connection.projectId)
  return { projectId: connection.projectId, ...heads, revision: value.revision, actor: value.snapshot.members.find((item) => item.id === connection.ownerId), canManage: true, snapshot: structuredClone(value.snapshot), serverTime: Date.now() }
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin), token = request.headers.authorization?.replace(/^Bearer /, ''), connection = connections.get(token)
    let body
    if (request.method === 'POST') { const chunks = []; for await (const chunk of request) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    wire.push({ path: url.pathname, method: request.method, commandId: body?.commandId, body, connectionId: connection?.connectionId })
    const send = (body, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }
    if (!connection || revoked.has(connection.connectionId)) { const denied = fail('DEVICE_REVOKED'); return send(denied.body, denied.status) }
    if (url.pathname === '/api/session') return send({ ok: true, value: { contractVersion: 1, authentication: 'device', deviceId: connection.deviceId, csrfToken: null, person: { userId: connection.ownerId, displayName: 'Owned account', active: true, isPlatformAdmin: false, revision: 1 } } })
    if (url.pathname === '/api/identity') return send({ ok: true, value: { provider: 'gitlab', issuer: origin, subject: connection.ownerId, baseUrl: origin, clientId: 'owned-native-pkce', username: 'owned-user' } })
    if (url.pathname === '/api/projects') return send({ ok: true, value: { items: [{ projectId: connection.projectId, teamId: connection.teamId, name: 'Owned project', createdAt: 0, roles: ['admin'] }], hasMore: false, nextCursor: null } })
    if (url.pathname === `/api/projects/${connection.projectId}/hifox/snapshot`) {
      let frozen
      if (hold) { const current = hold; hold = null; if (current.freezeSnapshot) frozen = snapshot(connection); current.enter(); await current.wait }
      const value = frozen ?? snapshot(connection)
      if (corrupt === 'project') value.projectId = randomUUID()
      if (corrupt === 'actor') value.actor = { ...value.actor, id: randomUUID() }
      if (corrupt === 'instance') value.instanceId = randomUUID()
      return send({ ok: true, value })
    }
    if (url.pathname.startsWith('/api/commands/')) {
      const commandId = url.pathname.split('/').at(-1), receipt = receipts.get(connection.ownerId + ':' + commandId)
      return receipt ? send({ ok: true, value: { commandId, kind: 'hifoxCommand', status: 'committed', recordedAt: Date.now(), result: receipt.result } }) : send(fail('NOT_FOUND', 404).body, 404)
    }
    if (url.pathname === `/api/projects/${connection.projectId}/hifox/commands`) {
      postCount++
      if (body.expectedEpoch !== heads.epoch) {
        if (offlineAfterEpochConflict) { offlineAfterEpochConflict = false; offline = true }
        return send(fail(epochFailureCode, 409).body, 409)
      }
      const prior = receipts.get(connection.ownerId + ':' + body.commandId)
      if (prior) { assert.deepEqual(body, prior.body, 'retry changed the original payload'); return send({ ok: true, value: { commandId: body.commandId, status: 'duplicate', result: prior.result } }) }
      const saved = readState(connection.scopeKey)
      assert.equal(saved.pending.state, 'dispatching', 'POST preceded the durable dispatch marker')
      assert.deepEqual(saved.pending.command, body, 'HTTP body differs from durable command')
      assert.equal(saved.binding.connectionId, connection.connectionId)
      if (dropBeforeCommit) { dropBeforeCommit = false; response.destroy(); return }
      const value = projects.get(connection.projectId)
      if (value.revision !== body.expectedRevision) return send(fail('REVISION_CONFLICT', 409).body, 409)
      const executed = api.executeHifoxDomain(value.snapshot, body.operation, body.input, connection.ownerId)
      value.snapshot = executed.snapshot; value.revision++
      const result = { ...snapshot(connection), ...(executed.taskId ? { taskId: executed.taskId } : {}) }
      receipts.set(connection.ownerId + ':' + body.commandId, { result, body })
      if (commandHold) { const current = commandHold; commandHold = null; current.enter(); await current.wait }
      if (failSettlement) {
        failSettlement = false
        const file = stateFile(connection.scopeKey)
        renameSync(file, file + '.owned-backup'); mkdirSync(file)
      }
      if (dropped) { dropped = false; response.destroy(); return }
      return send({ ok: true, value: { commandId: body.commandId, status: 'committed', result } })
    }
    send(fail('NOT_FOUND', 404).body, 404)
  } catch (error) { console.error(error); response.writeHead(500); response.end(JSON.stringify(fail('FIXTURE_FAILURE', 500).body)) }
})

try {
  const bundle = join(root, 'api.mjs'), worker = join(root, 'team-worker.cjs')
  const mocks = { electron: 'export const shell={openExternal:async()=>{throw Error("Owned fixture browser only")}};export const safeStorage={isEncryptionAvailable:()=>false}', '../proxy': 'export const proxiedFetch=(url,init)=>fetch(url,init)' }
  await build({ stdin: { contents: "export * from './src/main/services/hifox/remote';export {DesktopTeamService} from './src/main/services/team-platform/service';export {buildSeedSnapshot} from './src/shared/hifox-domain/seed';export {executeHifoxDomain} from './src/shared/hifox-domain/commands';export {canonicalTeamOrigin} from './src/main/services/team-platform/http'", resolveDir: process.cwd(), loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'owned-native-boundaries', setup(builder) { builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'fixture' } : null); builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: mocks[args.path], loader: 'js' })) } }] })
  await build({ entryPoints: ['src/main/services/team-platform/store-worker.ts'], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  api = await import(pathToFileURL(bundle).href)
  await new Promise((done) => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${server.address().port}`
  service = await api.DesktopTeamService.open({ dataDir: join(root, 'protected'), workerFile: worker, allowLoopbackHttp: true, protectSecret: protect, revealSecret: reveal, fetch: (url, init) => { if (offline) throw Error('Owned offline boundary'); return fetch(url, init) } })
  const connect = async (extra = {}) => {
    const record = { connectionId: randomUUID(), origin, pairingId: randomUUID(), deviceId: randomUUID(), deviceName: 'Owned fixture desktop', state: 'active', ownerId: randomUUID(), projectId: randomUUID(), teamId: randomUUID(), userCode: 'ABCDEFGHJK', verificationUri: origin + '/', expiresAt: Date.now() + 60000, pollAfterMs: 1, nextPollAt: 0, capabilityClaims: [], sequence: -1, accessLocked: false, network: 'reachable', lastCheckedAt: Date.now(), lastErrorCode: null, remoteDevice: null, ...extra }
    const token = 'td_' + randomBytes(32).toString('base64url'), { teamId, ...stored } = record
    stored.encryptedToken = protect(JSON.stringify({ version: 1, connectionId: record.connectionId, origin, pairingId: record.pairingId, deviceId: record.deviceId, token }))
    await service.store.call({ op: 'add-connection', input: { ...stored, state: 'pending', ownerId: null } })
    await service.store.call({ op: 'update-connection', input: { connectionId: record.connectionId, device: { status: 'active', deviceId: record.deviceId, deviceName: record.deviceName, projectId: record.projectId, ownerId: record.ownerId, lastSeenAt: null, online: false, capabilityClaims: [], capabilityEvidence: 'device-declared', sequence: -1 } } })
    const domain = projects.get(record.projectId)?.snapshot ?? api.buildSeedSnapshot()
    if (!domain.members.some((item) => item.id === record.ownerId)) domain.members.push({ id: record.ownerId, name: 'Owned authenticated actor', role: 'owner', avatarHue: 180, joinedAt: new Date().toISOString() })
    for (const space of domain.spaces) if (!space.memberIds.includes(record.ownerId)) space.memberIds.push(record.ownerId)
    if (!projects.has(record.projectId)) projects.set(record.projectId, { snapshot: domain, revision: 0 })
    connections.set(token, record)
    return record
  }
  const a = await connect(), b = await connect()
  client = new api.HifoxRemoteClient({ dataDir: directory, withService: (action) => action(service), autoPoll: false })
  const select = async (connection) => { const view = await client.select(connection.connectionId); connection.scopeKey = view.context.key; return view }
  const input = (title) => ({ spaceId: 'sp-eng', title })
  const create = (title, scope = client.status().key) => client.execute('createTask', input(title), scope)
  let originalId, originalCommand, keyA

  await check('explicit selection is required; local domain data is never opened or uploaded', async () => {
    assert.equal(client.snapshot().snapshot, null); assert.equal(client.status().state, 'local'); assert.equal(wire.length, 0)
    await assert.rejects(create('Local never uploaded', 'local'), (error) => error.code === 'SCOPE_CHANGED')
    const view = await select(a); keyA = view.context.key
    assert.equal(view.context.state, 'connected'); assert.equal(view.context.actorId, a.ownerId); assert.equal(view.context.projectId, a.projectId)
    assert.equal(postCount, 0); assert.equal(readdirSync(directory).includes('hifox'), false)
    assert.throws(() => api.canonicalTeamOrigin('http://private.invalid', true))
  })
  await check('real protected device HTTP validates actor/project and exposes only safe GitLab identity', async () => {
    const identity = await service.gitlabIdentity(a.connectionId)
    assert.equal(identity.provider, 'gitlab'); assert.equal(identity.clientId, 'owned-native-pkce'); assert.equal('token' in identity, false)
    const value = await create('Durable remote A')
    assert.ok(value.taskId); assert.equal(value.context.revision, 1); assert.equal(client.pending().length, 0)
    assert.equal(value.snapshot.tasks.find((item) => item.id === value.taskId).creatorId, a.ownerId)
  })
  await check('offline save persists a queued original operation and reports failure without optimistic state', async () => {
    const before = client.snapshot().snapshot, count = postCount
    offline = true
    await assert.rejects(create('Offline retained draft'), (error) => error.code === 'NETWORK_UNAVAILABLE' && error.pending && !error.outcomeUnknown)
    assert.deepEqual(client.snapshot().snapshot, before); assert.equal(postCount, count)
    assert.equal(client.snapshot().authorization, 'last-observed'); assert.equal(client.status().canManage, false)
    const saved = readState(); originalId = saved.pending.command.commandId; originalCommand = saved.pending.command
    assert.equal(saved.pending.state, 'queued'); assert.equal(saved.pending.command.input.title, 'Offline retained draft')
    await client.close(); client = new api.HifoxRemoteClient({ dataDir: directory, service, autoPoll: false })
    await select(a); assert.equal(client.status().state, 'offline'); assert.equal(client.pending()[0].commandId, originalId)
    offline = false
    await client.retry(originalId, keyA)
    assert.equal(client.pending().length, 0)
    assert.deepEqual(wire.findLast((item) => item.commandId === originalId && item.method === 'POST').body, originalCommand)
  })
  await check('acknowledgement loss survives restart; same input reconciles real receipt before another write', async () => {
    dropped = true
    await assert.rejects(create('Commit with lost response'), (error) => error.outcomeUnknown && error.pending)
    const saved = readState(); originalId = saved.pending.command.commandId; originalCommand = saved.pending.command
    assert.equal(saved.pending.state, 'acknowledgement-unknown')
    const count = postCount
    await client.close(); client = new api.HifoxRemoteClient({ dataDir: directory, service, autoPoll: false }); await select(a)
    const value = await create('Commit with lost response')
    assert.ok(value.taskId); assert.equal(postCount, count); assert.equal(client.pending().length, 0)
    assert.ok(wire.some((item) => item.path === '/api/commands/' + originalId))
  })
  await check('unknown missing receipt is read before explicit replay with identical UUID, revision and payload', async () => {
    dropBeforeCommit = true
    await assert.rejects(create('Unknown original payload'), (error) => error.outcomeUnknown && error.pending)
    const saved = readState(); originalId = saved.pending.command.commandId; originalCommand = saved.pending.command
    const count = postCount, boundary = wire.length
    await client.retry(originalId, keyA)
    assert.equal(postCount, count + 1)
    const subsequent = wire.slice(boundary), lookup = subsequent.findIndex((item) => item.path === '/api/commands/' + originalId), replay = subsequent.findIndex((item) => item.method === 'POST')
    assert.ok(lookup >= 0 && lookup < replay)
    assert.deepEqual(subsequent[replay].body, originalCommand)
  })
  await check('lost local acknowledgement retains an unknown original command and reconciles after restart', async () => {
    failSettlement = true
    await assert.rejects(create('Durable dispatch survives settlement failure'), (error) => error.outcomeUnknown && error.pending)
    const pending = client.pending()[0], file = stateFile(keyA), count = postCount
    assert.equal(pending.state, 'acknowledgement-unknown')
    rmdirSync(file); renameSync(file + '.owned-backup', file)
    assert.equal(readState().pending.state, 'dispatching')
    await client.close(); client = new api.HifoxRemoteClient({ dataDir: directory, service, autoPoll: false }); await select(a)
    assert.equal(client.pending()[0].outcomeUnknown, true)
    await client.retry(pending.commandId, keyA)
    assert.equal(client.pending().length, 0); assert.equal(postCount, count)
  })
  await check('queued commands cannot silently follow another project, account or device', async () => {
    offline = true; await assert.rejects(create('Pinned account draft'))
    const saved = readState(); originalId = saved.pending.command.commandId
    offline = false; await select(b)
    assert.notEqual(client.status().key, keyA); assert.equal(client.pending().length, 0)
    await assert.rejects(create('Old editor must stay', keyA), (error) => error.code === 'SCOPE_CHANGED')
    await assert.rejects(client.retry(originalId), (error) => error.code === 'COMMAND_SCOPE_MISMATCH')
    assert.deepEqual(readState(keyA).pending.command, saved.pending.command)
    await select(a); await client.retry(originalId, keyA)
  })
  await check('revision conflict refreshes actual server state and retains original draft/UUID until explicit discard', async () => {
    projects.get(a.projectId).revision++
    const prior = client.status().revision
    await assert.rejects(create('Conflicted user draft'), (error) => error.code === 'REVISION_CONFLICT' && error.pending && !error.outcomeUnknown)
    assert.equal(client.status().revision, prior + 1); assert.equal(client.pending()[0].command.input.title, 'Conflicted user draft')
    assert.equal(client.pending()[0].state, 'conflict')
    const count = postCount
    await assert.rejects(create('Changed draft'), (error) => error.code === 'PENDING_COMMAND'); assert.equal(postCount, count)
    await client.discardPending(keyA)
    await create('Explicitly resubmitted draft')
  })
  await check('atomic persistence failure stops all remote writes and retains editor operation', async () => {
    const file = stateFile(keyA), backup = file + '.owned-backup', count = postCount
    renameSync(file, backup); mkdirSync(file)
    await assert.rejects(create('Disk failure draft'), (error) => error.code === 'STORE_UNAVAILABLE' && !error.outcomeUnknown)
    assert.equal(postCount, count); assert.equal(client.pending().length, 0)
    rmdirSync(file); renameSync(backup, file)
  })
  await check('corrupt recovery file is preserved and never replaced with an empty remote namespace', async () => {
    await select(b)
    const file = stateFile(keyA), previous = readFileSync(file)
    writeFileSync(file, '{broken owned fixture')
    await assert.rejects(select(a)); assert.equal(readFileSync(file, 'utf8'), '{broken owned fixture')
    assert.equal(client.status().connectionId, b.connectionId, 'failed selection silently retargeted the editor to local')
    assert.notEqual(client.status().key, 'local')
    writeFileSync(file, previous); await select(a)
  })

  await check('invalid selection preserves the previous complete context and cache', async () => {
    const before = client.snapshot()
    await assert.rejects(client.select(randomUUID()), (error) => error.code === 'ACCESS_LOCKED')
    assert.deepEqual(client.snapshot(), before)
  })

  await check('admitted replies settle only their original command; queued writes cannot survive an A/B/A switch', async () => {
    let enter, release
    commandHold = { enter: () => enter(), wait: new Promise((done) => { release = done }) }
    const entered = new Promise((done) => { enter = done }), admitted = create('Admitted original A')
    await entered
    const count = postCount, queued = create('Queued original A'), settled = Promise.allSettled([admitted, queued])
    await select(b); await select(a)
    release()
    const outcomes = await settled
    for (const outcome of outcomes) { assert.equal(outcome.status, 'rejected'); assert.equal(outcome.reason.code, 'SCOPE_CHANGED') }
    assert.equal(postCount, count, 'queued write dispatched after returning to the same scope key')
    assert.equal(client.status().key, keyA)
    if (client.pending().length) await client.retry(client.pending()[0].commandId, keyA)
    assert.equal(client.pending().length, 0)
  })

  await check('restore accepts a lower revision only in a fresh epoch and clears old private bodies without rewriting queued commands', async () => {
    const connection = await connect(); await select(connection)
    const secret = 'owned-private-body-before-restore', oldEpoch = heads.epoch
    const created = await client.execute('createTask', { ...input('Owned private restore task'), description: secret }, client.status().key)
    offline = true; await assert.rejects(create('Original epoch queued draft')); offline = false
    const original = structuredClone(client.pending()[0].command)
    assert.equal(original.expectedEpoch, oldEpoch)
    const project = projects.get(connection.projectId)
    project.snapshot = api.executeHifoxDomain(project.snapshot, 'removeTask', { id: created.taskId }, connection.ownerId).snapshot
    heads.epoch = randomUUID(); heads.authorizationRevision = 0; project.revision = 0
    await client.refresh()
    assert.equal(client.status().state, 'connected'); assert.equal(client.status().revision, 0); assert.equal(client.status().epoch, heads.epoch)
    assert.equal(JSON.stringify(client.snapshot()).includes(secret), false)
    assert.equal(JSON.stringify(readState()).includes(secret), false)
    assert.deepEqual(client.pending()[0].command, original); assert.equal(client.pending()[0].state, 'conflict')
    assert.ok(readState().retiredEpochs.includes(oldEpoch))
    const count = postCount
    await assert.rejects(client.retry(original.commandId), (error) => error.code === 'EPOCH_CONFLICT' && !error.outcomeUnknown)
    assert.equal(postCount, count); await client.discardPending(client.status().key)
    const value = await create('Reviewed new epoch draft'); assert.ok(value.taskId)
    assert.equal(wire.findLast((entry) => entry.method === 'POST').body.expectedEpoch, heads.epoch)
    await client.close(); client = new api.HifoxRemoteClient({ dataDir: directory, service, autoPoll: false }); await select(connection)
    const currentEpoch = heads.epoch
    heads.epoch = oldEpoch
    await client.refresh(); assert.equal(client.status().state, 'offline'); assert.equal(client.snapshot().snapshot, null)
    assert.equal(client.status().epoch, currentEpoch, 'retired UUID epoch became current after restart')
    heads.epoch = currentEpoch; await client.refresh(); await select(a)
  })

  await check('unobserved restore rejects stale-epoch POST before apply or receipt replay and preserves the exact original command', async () => {
    for (const code of ['EPOCH_CONFLICT', 'WORKSPACE_EPOCH_CHANGED']) {
      const connection = await connect(); await select(connection)
      const secret = 'owned-old-private-body-rejected-' + code
      const created = await client.execute('createTask', { ...input('Private before rejected epoch'), description: secret }, client.status().key)
      offline = true; await assert.rejects(create('Owned stale epoch write')); offline = false
      const original = structuredClone(client.pending()[0].command), count = postCount, project = projects.get(connection.projectId)
      project.snapshot = api.executeHifoxDomain(project.snapshot, 'removeTask', { id: created.taskId }, connection.ownerId).snapshot
      heads.epoch = randomUUID(); project.revision = 0; epochFailureCode = code
      offlineAfterEpochConflict = code === 'WORKSPACE_EPOCH_CHANGED'
      await assert.rejects(client.retry(original.commandId), (error) => error.code === code && error.pending && !error.outcomeUnknown)
      epochFailureCode = 'EPOCH_CONFLICT'
      if (offline) {
        assert.equal(client.snapshot().snapshot, null, 'epoch rejection exposed old private cache when the reload went offline')
        assert.equal(readState().cache, null); offline = false; await client.refresh()
      }
      assert.equal(postCount, count + 1); assert.equal(project.revision, 0)
      assert.equal(JSON.stringify(client.snapshot()).includes(secret), false)
      assert.equal(project.snapshot.tasks.some((task) => task.title === 'Owned stale epoch write'), false)
      assert.deepEqual(client.pending()[0].command, original); assert.equal(client.pending()[0].state, 'conflict')
      assert.equal(client.status().epoch, heads.epoch); await client.discardPending(client.status().key)
    }
    await select(a)
  })

  await check('historical lost-ack receipts reconcile without restoring old private bodies or replaying under a new epoch', async () => {
    const connection = await connect(); await select(connection)
    const secret = 'owned-historical-receipt-private-body'
    dropped = true
    await assert.rejects(client.execute('createTask', { ...input('Historical original'), description: secret }, client.status().key), (error) => error.outcomeUnknown)
    const original = structuredClone(client.pending()[0].command), project = projects.get(connection.projectId), committed = receipts.get(connection.ownerId + ':' + original.commandId)
    project.snapshot = api.executeHifoxDomain(project.snapshot, 'removeTask', { id: committed.result.taskId }, connection.ownerId).snapshot
    heads.epoch = randomUUID(); project.revision = 0
    await client.refresh()
    assert.equal(client.pending()[0].outcomeUnknown, true)
    await assert.rejects(client.discardPending(client.status().key), (error) => error.code === 'RECONCILE_REQUIRED')
    const count = postCount
    await assert.rejects(client.retry(original.commandId), (error) => error.code === 'EPOCH_CONFLICT' && error.pending && !error.outcomeUnknown)
    assert.equal(postCount, count); assert.equal(JSON.stringify(client.snapshot()).includes(secret), false)
    assert.deepEqual(client.pending()[0].command, original); assert.equal(client.pending()[0].state, 'conflict')
    await client.discardPending(client.status().key); await select(a)
  })

  await check('a receipt missing after restore neither resends an unknown old-epoch command nor claims it was never committed', async () => {
    const connection = await connect(); await select(connection)
    dropBeforeCommit = true
    await assert.rejects(create('Unknown original across restore'), (error) => error.outcomeUnknown)
    const original = structuredClone(client.pending()[0].command), count = postCount
    heads.epoch = randomUUID(); projects.get(connection.projectId).revision = 0
    await client.refresh()
    await assert.rejects(client.retry(original.commandId), (error) => error.code === 'EPOCH_CONFLICT' && error.pending && error.outcomeUnknown)
    assert.equal(postCount, count); assert.deepEqual(client.pending()[0].command, original)
    await assert.rejects(client.discardPending(client.status().key), (error) => error.code === 'RECONCILE_REQUIRED')
    await client.close(); client = new api.HifoxRemoteClient({ dataDir: directory, service, autoPoll: false }); await select(connection)
    assert.deepEqual(client.pending()[0].command, original); assert.equal(client.pending()[0].outcomeUnknown, true)
    await select(a)
  })

  await check('late old-epoch reads cannot replace the new ACL-filtered view learned during a command rejection', async () => {
    const connection = await connect(); await select(connection)
    const oldEpoch = heads.epoch
    let enter, release
    hold = { freezeSnapshot: true, enter: () => enter(), wait: new Promise((done) => { release = done }) }
    const entered = new Promise((done) => { enter = done }), reading = client.refresh()
    await entered
    heads.epoch = randomUUID(); projects.get(connection.projectId).revision = 0
    await assert.rejects(create('Stale epoch while old read waits'), (error) => error.code === 'EPOCH_CONFLICT')
    const fresh = client.snapshot()
    release(); await reading
    assert.deepEqual(client.snapshot(), fresh); assert.notEqual(client.status().epoch, oldEpoch)
    await client.discardPending(client.status().key); await select(a)
  })

  await check('changed service instance locks the original protected connection and keeps its pinned authority after restart', async () => {
    const connection = await connect(); await select(connection)
    const instanceId = client.status().instanceId
    corrupt = 'instance'; await client.refresh(); corrupt = null
    assert.equal(client.status().state, 'access-revoked'); assert.equal(client.status().error, 'BINDING_CHANGED')
    assert.equal(client.snapshot().snapshot, null); assert.equal(readState().authority.instanceId, instanceId)
    assert.equal(readState().accessLocked, true)
    assert.equal((await service.connections()).find((entry) => entry.connectionId === connection.connectionId).accessLocked, true)
    await client.close(); client = new api.HifoxRemoteClient({ dataDir: directory, service, autoPoll: false }); await select(connection)
    assert.equal(client.status().state, 'access-revoked'); assert.equal(client.snapshot().snapshot, null); await select(a)
  })

  await check('same-epoch authorization and revision regressions stay fenced even after cache removal and restart', async () => {
    const connection = await connect(); await select(connection)
    await create('Current epoch watermark')
    heads.authorizationRevision += 2; await client.refresh()
    const revision = client.status().revision, authorizationRevision = heads.authorizationRevision
    projects.get(connection.projectId).revision = revision - 1
    await client.refresh(); assert.equal(client.status().error, 'REVISION_REGRESSED'); assert.equal(client.snapshot().snapshot, null)
    await client.close(); client = new api.HifoxRemoteClient({ dataDir: directory, service, autoPoll: false }); await select(connection)
    assert.equal(client.status().state, 'offline'); assert.equal(client.snapshot().snapshot, null)
    projects.get(connection.projectId).revision = revision; heads.authorizationRevision--
    await client.refresh(); assert.equal(client.status().error, 'AUTHORIZATION_REGRESSED'); assert.equal(client.snapshot().snapshot, null)
    heads.authorizationRevision = authorizationRevision; await client.refresh()
    assert.equal(client.status().state, 'connected'); await select(a)
  })
  await check('revocation clears cached content, locks writes and does not reuse a stale grant offline', async () => {
    offline = true; await assert.rejects(create('Revoked queued draft')); offline = false
    revoked.add(a.connectionId); await client.refresh()
    assert.equal(client.status().state, 'access-revoked'); assert.equal(client.status().canManage, false); assert.equal(client.snapshot().snapshot, null)
    assert.equal(readState().cache, null); assert.equal(client.pending()[0].state, 'access-revoked')
    const locked = client.status()
    await assert.rejects(client.select(randomUUID()))
    assert.deepEqual(client.status(), locked, 'failed selection weakened the original access lock')
    await assert.rejects(client.retry(client.pending()[0].commandId), (error) => error.code === 'ACCESS_LOCKED')
    offline = true; await client.close(); client = new api.HifoxRemoteClient({ dataDir: directory, service, autoPoll: false }); await select(a)
    assert.equal(client.snapshot().snapshot, null); offline = false
  })
  await check('cross-project and cross-actor remote snapshots lock their original protected connections', async () => {
    for (const kind of ['project', 'actor']) {
      const c = await connect(); corrupt = kind; const view = await select(c); corrupt = null
      assert.equal(view.context.state, 'access-revoked'); assert.equal(view.snapshot, null)
      assert.equal((await service.connections()).find((item) => item.connectionId === c.connectionId).accessLocked, true)
    }
  })
  await check('late reads cannot overwrite a new selection; close drains without emitting late events', async () => {
    await select(b)
    let enter, release
    hold = { enter: () => enter(), wait: new Promise((done) => { release = done }) }
    const entered = new Promise((done) => { enter = done }), refresh = client.refresh()
    await entered
    await client.select(null); release(); await assert.rejects(refresh)
    assert.equal(client.status().state, 'local'); assert.equal(client.snapshot().snapshot, null)
    await select(b)
    let events = 0; client.subscribe(() => { events++ })
    hold = { enter: () => enter(), wait: new Promise((done) => { release = done }) }
    const enteredClose = new Promise((done) => { enter = done }), reading = client.refresh()
    await enteredClose; const closing = client.close(), count = events; release()
    await Promise.allSettled([reading, closing]); assert.equal(events, count)
    await assert.rejects(create('Closed'), (error) => error.code === 'SERVICE_CLOSED')
  })
  await check('background polling accepts remote changes and releases its timer on close', async () => {
    let events = 0
    client = new api.HifoxRemoteClient({ dataDir: directory, service, pollWaitMs: 1, pollIntervalMs: 100, onChanged: () => { events++ } })
    await select(b)
    const revision = client.status().revision
    projects.get(b.projectId).revision++
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { unsubscribe(); reject(Error('Owned polling deadline')) }, 3000)
      const unsubscribe = client.subscribe((context) => { if (context.revision === revision + 1) { clearTimeout(deadline); unsubscribe(); resolve() } })
    })
    await client.close(); const count = events
    await new Promise((done) => setTimeout(done, 150)); assert.equal(events, count)
  })
  console.log(`HiFox remote client: ${results.length} checks passed (owned HTTP/identity/crypto fixtures).`)
} finally {
  if (hold) { hold = null }
  await client?.close().catch(() => {}); await service?.close().catch(() => {})
  await new Promise((done) => server.close(done)); server.closeAllConnections()
  if (!resolve(root).startsWith(resolve(tmpdir()) + '\\') && !resolve(root).startsWith(resolve(tmpdir()) + '/')) throw Error('Owned smoke cleanup escaped temp directory')
  rmSync(root, { recursive: true, force: true })
}
