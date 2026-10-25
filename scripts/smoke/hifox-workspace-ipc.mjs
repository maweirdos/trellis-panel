/** Real HiFox preload/registry/services and SQLite/HTTP; owned identity, credential and native-boundary fixtures. */
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'trellis-hifox-ipc-')), key = randomBytes(32)
const r = globalThis.__HIFOX_IPC__ = { handlers: new Map(), events: new EventEmitter(), calls: [], broadcasts: [], helpers: [], dataDir: join(root, 'normal'), replyHold: null, rejectInvokes: false }
const protect = (text) => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64') }
const reveal = (text) => { const bytes = Buffer.from(text, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8') }
const wire = [], projects = new Map(), credentials = new Map(), receipts = new Map(), groups = []
const heads = { instanceId: randomUUID(), epoch: randomUUID(), authorizationRevision: 0 }
let module, service, api, origin, offline = false, drop = false, requestHold = null, serial = 0, identityOverride = null
const check = async (name, work) => { await work(); groups.push(name); console.log('PASS ' + name) }
const gate = () => { let enter, release; const entered = new Promise((done) => { enter = done }), wait = new Promise((done) => { release = done }); return { enter, entered, wait, release } }
const snapshot = (connection) => {
  const project = projects.get(connection.projectId)
  return { projectId: connection.projectId, ...heads, revision: project.revision, actor: project.snapshot.members.find((member) => member.id === connection.ownerId), canManage: true, snapshot: structuredClone(project.snapshot), serverTime: Date.now() }
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin), connection = credentials.get(request.headers.authorization?.replace(/^Bearer /, ''))
    const send = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (!connection) return send({ ok: false, code: 'UNAUTHORIZED', error: 'Owned bearer fixture rejected' }, 401)
    let body
    if (request.method === 'POST') { const chunks = []; for await (const chunk of request) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    wire.push({ path: url.pathname, method: request.method, connectionId: connection.connectionId, body })
    if (requestHold?.path === url.pathname) { const held = requestHold; requestHold = null; held.enter(); await held.wait }
    if (url.pathname === '/api/session') return send({ ok: true, value: { contractVersion: 1, authentication: 'device', deviceId: connection.deviceId, csrfToken: null, person: { userId: connection.ownerId, displayName: 'Owned person', active: true, isPlatformAdmin: false, revision: 1 } } })
    if (url.pathname === '/api/projects') return send({ ok: true, value: { items: [{ projectId: connection.projectId, teamId: connection.teamId, name: 'Owned project', createdAt: 0, roles: ['admin'] }], hasMore: false, nextCursor: null } })
    if (url.pathname === '/api/identity') return send({ ok: true, value: { provider: 'gitlab', issuer: origin, subject: connection.ownerId, baseUrl: identityOverride ?? origin, clientId: 'owned-optional-client' } })
    if (url.pathname.endsWith('/hifox/snapshot')) return send({ ok: true, value: snapshot(connection) })
    if (url.pathname.startsWith('/api/commands/')) {
      const commandId = url.pathname.split('/').at(-1), prior = receipts.get(connection.ownerId + ':' + commandId)
      return prior ? send({ ok: true, value: { commandId, kind: 'hifoxCommand', status: 'committed', recordedAt: Date.now(), result: prior.result } }) : send({ ok: false, code: 'NOT_FOUND', error: 'Owned receipt absent' }, 404)
    }
    if (url.pathname.endsWith('/hifox/commands')) {
      if (body.expectedEpoch !== heads.epoch) return send({ ok: false, code: 'EPOCH_CONFLICT', error: 'Owned stale epoch rejected before apply/replay' }, 409)
      const saved = JSON.parse(readFileSync(join(r.dataDir, 'hifox-remote', (await module.hifoxWorkspaceStatus()).key, 'state.json'), 'utf8'))
      assert.equal(saved.pending.state, 'dispatching'); assert.deepEqual(saved.pending.command, body)
      const prior = receipts.get(connection.ownerId + ':' + body.commandId)
      if (prior) { assert.deepEqual(prior.body, body); return send({ ok: true, value: { commandId: body.commandId, status: 'duplicate', result: prior.result } }) }
      const project = projects.get(connection.projectId)
      if (project.revision !== body.expectedRevision) return send({ ok: false, code: 'REVISION_CONFLICT', error: 'Owned revision conflict' }, 409)
      const result = module.executeHifoxDomain(project.snapshot, body.operation, body.input, connection.ownerId)
      project.snapshot = result.snapshot; project.revision++
      const value = { ...snapshot(connection), ...(result.taskId ? { taskId: result.taskId } : {}) }
      receipts.set(connection.ownerId + ':' + body.commandId, { result: value, body })
      if (drop) { drop = false; response.destroy(); return }
      return send({ ok: true, value: { commandId: body.commandId, status: 'committed', result: value } })
    }
    send({ ok: false, code: 'NOT_FOUND', error: 'Owned route absent' }, 404)
  } catch (error) { console.error(error); response.writeHead(500); response.end(JSON.stringify({ ok: false, code: 'FIXTURE_FAILURE', error: 'Owned fixture failed' })) }
})
const mocks = {
  electron: `const r=globalThis.__HIFOX_IPC__;export const app={getPath:()=>r.dataDir};export const safeStorage={isEncryptionAvailable:()=>false};export const shell={openExternal:async()=>{throw Error('Owned fixture never opens browser')}};export const ipcMain={handle:(channel,fn)=>r.handlers.set(channel,fn),on(){}};export const ipcRenderer={async invoke(channel,...args){r.calls.push({channel,args});if(r.rejectInvokes)return {ok:false,code:'OWNED_REJECTION',error:'Owned transport rejection'};const value=await r.handlers.get(channel)({},...args);if(r.replyHold?.channel===channel){const held=r.replyHold;r.replyHold=null;held.enter();await held.wait}return structuredClone(value)},on:(channel,fn)=>r.events.on(channel,fn),removeListener:(channel,fn)=>r.events.removeListener(channel,fn),send(){}};export const contextBridge={exposeInMainWorld:(_name,value)=>r.api=value};`,
  '../proxy': 'export const proxiedFetch=(url,init)=>fetch(url,init)'
}
const boundaries = { name: 'owned-hifox-ipc-boundaries', setup(builder) {
  builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'owned-hifox' } : null)
  builder.onLoad({ filter: /.*/, namespace: 'owned-hifox' }, (args) => ({ contents: mocks[args.path], loader: 'js' }))
} }
async function load(directory, configure = true) {
  r.dataDir = directory; r.handlers.clear(); r.events.removeAllListeners(); r.broadcasts.length = 0; r.helpers.length = 0
  module = await import(pathToFileURL(join(root, 'main.mjs')).href + '?instance=' + ++serial)
  if (configure) module.configureHifoxConnectionService({
    withService: (action) => action(r.service),
    notify: (channel, value) => { r.broadcasts.push({ channel, value }); r.events.emit(channel, {}, structuredClone(value)) },
    ensureGitlab: async (identity, owner, signal) => {
      const work = owner.assertCurrent(); r.helpers.push({ identity, owner, signal, work }); await work
      if (r.helperHold) { const held = r.helperHold; r.helperHold = null; held.enter(); await held.wait }
      await owner.assertCurrent()
      return { connectionId: null, state: 'authorization-required', detail: 'Owned fixture does not authorize GitLab' }
    }
  })
  module.registerHifoxIpc()
  await import(pathToFileURL(join(root, 'preload.mjs')).href + '?instance=' + serial)
  api = r.api.hifox
}
const select = (connection) => api.selectWorkspace({ connectionId: connection?.connectionId ?? null })
const task = (title) => api.createTask({ spaceId: 'sp-eng', title })
const settleHelpers = async () => { for (let attempt = 0; attempt < 100 && !r.helpers.length; attempt++) await new Promise((done) => setTimeout(done, 10)); assert.ok(r.helpers.length); await r.helpers.at(-1).work }

try {
  const localBundle = await build({ stdin: { contents: "export {registerHifoxIpc} from './src/main/ipc/hifox';export * from './src/main/services/hifox/connection-service';import './src/preload/index'", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(root, 'local.cjs'), bundle: true, platform: 'node', format: 'cjs', metafile: true, logLevel: 'silent', plugins: [boundaries] })
  assert.equal(Object.keys(localBundle.metafile.inputs).some((path) => /acp|native-runtime|services[\\/]bridge|services[\\/]team-desktop|integrations[\\/]team-gitlab/.test(path)), false, 'local IPC pulled remote/runtime implementation into its CJS bundle')
  r.dataDir = join(root, 'cjs-local')
  const cjs = (await import(pathToFileURL(join(root, 'local.cjs')).href)).default
  cjs.registerHifoxIpc()
  assert.equal((await r.api.hifox.snapshot()).ok, true)
  assert.equal((await r.api.hifox.createSpace({ name: 'Actual CJS local space', key: 'CJS' })).ok, true)
  await cjs.closeHifoxWorkspace()
  await build({ stdin: { contents: "export {registerHifoxIpc} from './src/main/ipc/hifox';export * from './src/main/services/hifox/connection-service';export {DesktopTeamService} from './src/main/services/team-platform/service';export {buildSeedSnapshot} from './src/shared/hifox-domain/seed';export {executeHifoxDomain,hifoxMutationNames} from './src/shared/hifox-domain/commands';export {ipcInvoke,ipcEvent} from './src/shared/ipc-channels'", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(root, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [boundaries] })
  await build({ entryPoints: ['src/preload/index.ts'], outfile: join(root, 'preload.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [boundaries] })
  await build({ entryPoints: ['src/main/services/team-platform/store-worker.ts'], outfile: join(root, 'worker.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  await load(join(root, 'unconfigured'), false)
  await check('unconfigured local IPC bundles as CJS without ACP and rejects remote admission explicitly', async () => {
    assert.equal((await api.snapshot()).ok, true)
    assert.equal((await api.createSpace({ name: 'Owned no-runtime local', key: 'LOCAL' })).ok, true)
    assert.equal((await select({ connectionId: randomUUID() })).code, 'SERVICE_UNCONFIGURED')
    await module.closeHifoxWorkspace()
  })
  await load(join(root, 'normal'))
  await new Promise((done) => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${server.address().port}`
  service = r.service = await module.DesktopTeamService.open({ dataDir: join(root, 'protected'), workerFile: join(root, 'worker.cjs'), allowLoopbackHttp: true, protectSecret: protect, revealSecret: reveal, fetch: (url, init) => { if (offline) throw Error('Owned offline fixture'); return fetch(url, init) } })
  const connect = async () => {
    const connection = { connectionId: randomUUID(), origin, pairingId: randomUUID(), deviceId: randomUUID(), deviceName: 'Owned IPC desktop', state: 'pending', ownerId: null, projectId: randomUUID(), userCode: 'ABCDEFGHJK', verificationUri: origin + '/', expiresAt: Date.now() + 60000, pollAfterMs: 1, nextPollAt: 0, capabilityClaims: [], sequence: -1, accessLocked: false, network: 'reachable', lastCheckedAt: Date.now(), lastErrorCode: null, remoteDevice: null }
    const ownerId = randomUUID(), token = 'td_' + randomBytes(32).toString('base64url')
    await service.store.call({ op: 'add-connection', input: { ...connection, encryptedToken: protect(JSON.stringify({ version: 1, connectionId: connection.connectionId, origin, pairingId: connection.pairingId, deviceId: connection.deviceId, token })) } })
    await service.store.call({ op: 'update-connection', input: { connectionId: connection.connectionId, device: { status: 'active', deviceId: connection.deviceId, deviceName: connection.deviceName, projectId: connection.projectId, ownerId, lastSeenAt: null, online: false, capabilityClaims: [], capabilityEvidence: 'device-declared', sequence: -1 } } })
    Object.assign(connection, { ownerId, teamId: randomUUID() })
    const domain = module.buildSeedSnapshot(); domain.members.push({ id: ownerId, name: 'Owned remote actor', role: 'owner', avatarHue: 180, joinedAt: new Date().toISOString() })
    domain.spaces.forEach((space) => space.memberIds.push(ownerId))
    projects.set(connection.projectId, { revision: 0, snapshot: domain }); credentials.set(token, connection)
    return connection
  }
  const a = await connect(), b = await connect(), c = await connect()

  await check('actual preload registers every mutation including joinSpace and preserves the local actor/role', async () => {
    const value = await api.snapshot(); assert.equal(value.ok, true); assert.equal(value.context.canManage, true); assert.ok(value.context.actorId); assert.equal(wire.length, 0)
    const space = await api.createSpace({ name: 'Owned local space', key: 'IPC' }); assert.equal(space.ok, true)
    assert.equal((await api.joinSpace({ spaceId: space.data.spaces[0].id })).ok, true)
    for (const operation of module.hifoxMutationNames) assert.equal(typeof api[operation], 'function', operation)
    const invalid = await api.selectWorkspace({ connectionId: 'invalid' }); assert.equal(invalid.ok, false); assert.equal(invalid.code, 'E_INVALID_ARG')
  })
  await check('selection persists; metadata invalidation is deduplicated across repeated reads', async () => {
    const value = await select(a); assert.equal(value.ok, true); assert.equal(value.context.actorId, a.ownerId)
    assert.deepEqual(JSON.parse(readFileSync(join(r.dataDir, 'hifox-remote/selection.json'), 'utf8')), { connectionId: a.connectionId })
    const count = r.broadcasts.length
    await api.snapshot(); await api.snapshot(); assert.equal(r.broadcasts.length, count)
    await settleHelpers(); assert.equal(r.helpers.at(-1).owner.ownerId, a.ownerId)
  })
  await check('same-revision roster changes invalidate once; serverTime alone never creates a refresh loop', async () => {
    const revision = (await api.workspaceStatus()).context.revision, count = r.broadcasts.length
    projects.get(a.projectId).snapshot.members.find((member) => member.id === a.ownerId).name = 'Owned updated roster name'
    heads.authorizationRevision++
    const value = await api.snapshot()
    assert.equal(value.ok, true); assert.equal(value.context.revision, revision)
    assert.equal(value.context.authorizationRevision, heads.authorizationRevision)
    assert.equal(value.data.members.find((member) => member.id === a.ownerId).name, 'Owned updated roster name')
    assert.equal(r.broadcasts.length, count + 1)
    await api.snapshot(); await api.snapshot(); assert.equal(r.broadcasts.length, count + 1)
  })
  await check('every legacy mutation captures the selected scope; joinSpace traverses real remote IPC', async () => {
    assert.equal((await api.joinSpace({ spaceId: 'sp-eng' })).ok, true)
    const scope = (await api.workspaceStatus()).context.key
    r.rejectInvokes = true
    try {
      for (const name of [...module.hifoxMutationNames, 'resetDemo', 'triageQueue', 'workspacePending', 'retryWorkspaceCommand', 'discardWorkspaceCommand']) {
        await api[name]({}); assert.equal(r.calls.at(-1).args[1], scope, name)
      }
    } finally { r.rejectInvokes = false }
  })
  await check('invalid or unavailable new selection keeps the previous context and never falls back to local', async () => {
    const before = (await api.workspaceStatus()).context
    const invalid = await select({ connectionId: randomUUID() }); assert.equal(invalid.ok, false); assert.equal(invalid.code, 'ACCESS_LOCKED')
    assert.deepEqual((await api.workspaceStatus()).context, before)
    offline = true
    const unavailable = await select(c); offline = false
    assert.equal(unavailable.ok, false); assert.equal(unavailable.context.key, before.key)
    assert.equal((await api.workspaceStatus()).context.key, before.key)
    assert.equal((await task('Still A after rejected selection')).ok, true)
    assert.equal(wire.findLast((entry) => entry.method === 'POST').connectionId, a.connectionId)
  })
  await check('IPC preserves queued/unknown flags and original UUID through lost acknowledgements', async () => {
    offline = true
    const queued = await task('Owned queued IPC'); offline = false
    assert.equal(queued.ok, false); assert.equal(queued.code, 'NETWORK_UNAVAILABLE'); assert.equal(queued.pending, true); assert.equal(queued.outcomeUnknown, false); assert.equal(queued.context.connectionId, a.connectionId)
    const pending = await api.workspacePending(); assert.equal(pending.ok, true); assert.equal(pending.data.length, 1)
    assert.equal((await api.retryWorkspaceCommand({ commandId: pending.data[0].commandId })).ok, true)
    drop = true
    const lost = await task('Owned lost IPC'); assert.equal(lost.ok, false); assert.equal(lost.outcomeUnknown, true); assert.equal(lost.pending, true)
    const unknown = (await api.workspacePending()).data[0], count = wire.filter((entry) => entry.method === 'POST').length
    assert.equal((await task('Owned lost IPC')).ok, true)
    assert.equal(wire.filter((entry) => entry.method === 'POST').length, count)
    assert.ok(wire.some((entry) => entry.path === '/api/commands/' + unknown.commandId))
  })
  await check('restore heads reach preload; lower revision removes private bodies and old-epoch commands stay fenced', async () => {
    const secret = 'owned-ipc-private-body-before-restore'
    const created = await api.createTask({ spaceId: 'sp-eng', title: 'Owned private restore task', description: secret })
    assert.equal(created.ok, true)
    offline = true; assert.equal((await task('Owned pre-restore draft')).ok, false); offline = false
    const scope = (await api.workspaceStatus()).context.key, file = join(r.dataDir, 'hifox-remote', scope, 'state.json')
    const original = JSON.parse(readFileSync(file, 'utf8')).pending.command, oldEpoch = original.expectedEpoch
    const project = projects.get(a.projectId)
    project.snapshot = module.executeHifoxDomain(project.snapshot, 'removeTask', { id: created.taskId }, a.ownerId).snapshot
    heads.epoch = randomUUID(); heads.authorizationRevision = 0; project.revision = 0
    const value = await api.snapshot()
    assert.equal(value.ok, true); assert.equal(value.context.epoch, heads.epoch); assert.equal(value.context.instanceId, heads.instanceId)
    assert.equal(value.context.revision, 0); assert.equal(value.context.authorizationRevision, 0)
    assert.equal(JSON.stringify(value).includes(secret), false); assert.equal(readFileSync(file, 'utf8').includes(secret), false)
    const count = wire.filter((entry) => entry.method === 'POST').length
    const rejected = await api.retryWorkspaceCommand({ commandId: original.commandId })
    assert.equal(rejected.ok, false); assert.equal(rejected.code, 'EPOCH_CONFLICT'); assert.equal(rejected.pending, true); assert.equal(rejected.outcomeUnknown, false)
    assert.equal(wire.filter((entry) => entry.method === 'POST').length, count)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).pending.command, original)
    assert.equal(original.expectedEpoch, oldEpoch); assert.notEqual(oldEpoch, heads.epoch)
    assert.equal((await api.discardWorkspaceCommand({ commandId: original.commandId })).ok, true)
    assert.equal((await task('Explicit reviewed new-epoch intent')).ok, true)
    assert.equal(wire.findLast((entry) => entry.method === 'POST').body.expectedEpoch, heads.epoch)
  })
  await check('late preload replies cannot retarget later calls after another selection', async () => {
    const held = gate(); r.replyHold = { ...held, channel: module.ipcInvoke.hifox.snapshot }
    const reading = api.snapshot(); await held.entered
    assert.equal((await select(b)).ok, true)
    held.release(); const late = await reading; assert.equal(late.context.connectionId, a.connectionId)
    const result = await task('Must write B after late A'); assert.equal(result.ok, true); assert.equal(result.context.connectionId, b.connectionId)
  })
  await check('switching after HTTP preflight admission blocks the original POST and retains its queued UUID', async () => {
    r.helpers.length = 0; await select(a); await settleHelpers()
    const held = gate(); requestHold = { ...held, path: '/api/projects' }
    const writing = task('Admitted preflight A'); await held.entered
    const before = wire.filter((entry) => entry.method === 'POST').length
    assert.equal((await select(b)).ok, true); held.release()
    const failed = await writing; assert.equal(failed.ok, false); assert.equal(failed.code, 'SCOPE_CHANGED'); assert.equal(failed.pending, true)
    assert.equal(wire.filter((entry) => entry.method === 'POST').length, before)
    assert.equal((await task('Current B after admitted A')).ok, true)
    assert.equal(wire.findLast((entry) => entry.method === 'POST').connectionId, b.connectionId)
    await select(a)
    const pending = (await api.workspacePending()).data[0]
    assert.equal(pending.state, 'queued'); assert.equal((await api.discardWorkspaceCommand({ commandId: pending.commandId })).ok, true)
  })
  await check('local admission is fenced when selection begins before its continuation', async () => {
    assert.equal((await select(null)).ok, true)
    const file = join(r.dataDir, 'hifox/store.json'), before = readFileSync(file, 'utf8')
    const writing = module.executeHifoxWorkspace('createSpace', { name: 'Stale local', key: 'STALE' }, 'local')
    const resetting = api.resetDemo()
    const changing = select(a)
    await assert.rejects(writing, (error) => error.code === 'SCOPE_CHANGED'); assert.equal((await changing).ok, true)
    assert.equal((await resetting).code, 'SCOPE_CHANGED')
    assert.equal(readFileSync(file, 'utf8'), before)
    const reading = api.workspacePending(), switching = select(b)
    assert.equal((await reading).code, 'SCOPE_CHANGED'); assert.equal((await switching).ok, true)
  })
  await check('a pending first remote selection never admits local writes or a demo reset', async () => {
    await select(null)
    const file = join(r.dataDir, 'hifox/store.json'), before = readFileSync(file, 'utf8'), held = gate()
    requestHold = { ...held, path: '/api/projects' }
    const selecting = select(a); await held.entered
    assert.equal((await api.createSpace({ name: 'Transient local', key: 'TRANSIENT' })).code, 'SCOPE_CHANGED')
    assert.equal((await api.resetDemo()).code, 'SCOPE_CHANGED')
    held.release(); assert.equal((await selecting).ok, true); assert.equal(readFileSync(file, 'utf8'), before)
  })
  await check('optional GitLab work is cancelled by selection and rejects changed provider identity/device binding', async () => {
    const held = gate(); r.helperHold = held
    r.helpers.length = 0; await select(a); await held.entered
    const original = r.helpers.at(-1)
    await select(b); assert.equal(original.signal.aborted, true); held.release(); await assert.rejects(original.owner.assertCurrent())
    r.helpers.length = 0; await select(a); await settleHelpers()
    const current = r.helpers.at(-1)
    identityOverride = origin + '/another-provider'; await assert.rejects(current.owner.assertCurrent()); identityOverride = null
    const saved = await service.store.call({ op: 'connection', input: a.connectionId })
    // An explicit native-boundary read fixture tests the helper's full tuple recheck.
    const connections = service.connections.bind(service)
    service.connections = async () => (await connections()).map((entry) => entry.connectionId === a.connectionId ? { ...entry, deviceId: randomUUID() } : entry)
    try { await assert.rejects(current.owner.assertCurrent()) } finally { service.connections = connections }
    assert.equal(saved.deviceId, a.deviceId)
  })
  await check('returning local restores its actual actor and management role in status and events', async () => {
    const value = await select(null), status = await api.workspaceStatus()
    assert.equal(value.ok, true); assert.equal(status.context.canManage, true); assert.equal(status.context.actorId, value.context.actorId)
    const event = r.broadcasts.findLast((entry) => entry.channel === module.ipcEvent.hifoxWorkspaceChanged)
    assert.equal(event.value.canManage, true); assert.equal(event.value.actorId, value.context.actorId)
  })
  await check('disconnect hides cached content, and shutdown rejects new local/remote admission', async () => {
    await select(c)
    await service.disconnect(c.connectionId)
    const value = await api.snapshot(); assert.equal(value.ok, false); assert.equal(value.code, 'ACCESS_LOCKED'); assert.equal(value.context.state, 'access-revoked')
    await select(b)
    const held = gate(); requestHold = { ...held, path: `/api/projects/${b.projectId}/hifox/snapshot` }
    const reading = api.snapshot(); await held.entered
    let closed = false
    const closing = module.closeHifoxWorkspace().then(() => { closed = true }), count = r.broadcasts.length
    await new Promise((done) => setImmediate(done)); assert.equal(closed, false)
    held.release(); await Promise.allSettled([reading, closing]); assert.equal(closed, true); assert.equal(r.broadcasts.length, count)
    assert.equal((await api.snapshot()).code, 'SERVICE_CLOSED'); assert.equal((await api.createSpace({ name: 'Closed', key: 'CLOSED' })).code, 'SERVICE_CLOSED')
  })
  await check('malformed persisted selection stays blocked and preserves bytes until an explicit recoverable choice', async () => {
    const directory = join(root, 'corrupt'), file = join(directory, 'hifox-remote/selection.json')
    mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '{owned malformed selection')
    await load(directory)
    assert.equal((await api.snapshot()).code, 'SELECTION_UNAVAILABLE')
    assert.equal((await api.createSpace({ name: 'Forbidden fallback', key: 'NO' })).code, 'SELECTION_UNAVAILABLE')
    assert.equal(readFileSync(file, 'utf8'), '{owned malformed selection'); assert.equal(existsSync(join(directory, 'hifox/store.json')), false)
    assert.equal((await select(null)).ok, true); assert.equal((await api.workspaceStatus()).context.canManage, true)
    await module.closeHifoxWorkspace()
  })
  await check('failed selection persistence rolls back context and still permits explicit recovery', async () => {
    await load(join(root, 'persist-failure')); await select(a)
    const file = join(r.dataDir, 'hifox-remote/selection.json')
    renameSync(file, file + '.backup'); mkdirSync(file)
    const value = await select(b); assert.equal(value.ok, false); assert.equal(typeof value.code, 'string')
    assert.equal((await api.workspaceStatus()).context.connectionId, a.connectionId)
    rmdirSync(file); renameSync(file + '.backup', file)
    assert.equal((await task('Still A after failed save')).ok, true)
    await module.closeHifoxWorkspace()
  })
  console.log(`HiFox workspace IPC: ${groups.length} checks passed (owned HTTP/credentials/native fixtures; no production server or GitLab authorization).`)
} finally {
  requestHold?.release(); r.replyHold?.release()
  await module?.closeHifoxWorkspace().catch(() => {}); await service?.close().catch(() => {})
  server.closeAllConnections(); await new Promise((done) => server.close(done))
  if (!resolve(root).startsWith(resolve(tmpdir()) + '/') && !resolve(root).startsWith(resolve(tmpdir()) + '\\')) throw Error('Owned fixture cleanup escaped temp root')
  rmSync(root, { recursive: true, force: true }); delete globalThis.__HIFOX_IPC__
}
