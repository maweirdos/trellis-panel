import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTeamService, restoreTeamBackup } from '../../team-service/dist/index.mjs'
import { BrowserAccount, createOidcFixture, freePort } from '../../team-service/test/oidc-fixture.mjs'

const require = createRequire(new URL('../../../package.json', import.meta.url))
const { build } = require('esbuild')

test('browser HiFox adapter against authenticated HTTP/SQLite with retained commands and ownership fencing', { timeout: 60_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-hifox-browser-api-'))
  const origin = `http://127.0.0.1:${await freePort()}`
  const identity = await createOidcFixture(origin)
  const originalFetch = globalThis.fetch, originalLocation = globalThis.location, originalStorage = globalThis.sessionStorage
  const storage = new Map()
  const browserStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  globalThis.sessionStorage = browserStorage
  let service, workspace
  try {
    await build({ stdin: { contents: "export { BrowserHifoxWorkspace, api, bindBrowserHifox } from './src/hifox-browser-api'; export { setClientSession, authEvents, pendingCommands } from './src/client'", resolveDir: resolve('.') }, outfile: join(directory, 'adapter.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const client = await import(pathToFileURL(join(directory, 'adapter.mjs')).href)
    service = await createTeamService({ dataDir: join(directory, 'store'), publicOrigin: origin, oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true })
    await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
    const alice = new BrowserAccount(origin, 'alice'), bob = new BrowserAccount(origin, 'bob')
    const session = await alice.signIn(), bobSession = await bob.signIn()
    const api = async (path, body) => { const reply = await alice.api(path, body); assert.equal(reply.status, 200, JSON.stringify(reply.body)); return reply.body.value }
    const team = await api('/api/teams', { commandId: randomUUID(), name: 'Adapter team' })
    await api(`/api/teams/${team.result.teamId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['member'], active: true, expectedRevision: null })
    const created = await api('/api/projects', { commandId: randomUUID(), teamId: team.result.teamId, name: 'Adapter project' })
    const projectId = created.result.projectId
    await api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: bobSession.person.userId, roles: ['developer'], active: true, expectedRevision: null })
    const project = { projectId, teamId: team.result.teamId, name: 'Adapter project', roles: ['pm'], createdAt: Date.now() }
    const isolatedProject = async (name) => {
      const result = await api('/api/projects', { commandId: randomUUID(), teamId: team.result.teamId, name })
      return { ...project, projectId: result.result.projectId, name }
    }
    const reloadClient = () => import(pathToFileURL(join(directory, 'adapter.mjs')).href + '?reload=' + randomUUID())
    globalThis.location = { origin }
    const cookies = () => [...alice.cookies.get('127.0.0.1')].map(([name, value]) => `${name}=${value}`).join('; ')
    const commands = []
    const transport = async (path, options) => {
      if (typeof path !== 'string' || !path.startsWith('/')) return originalFetch(path, options)
      if (options.body) { const body = JSON.parse(options.body); commands.push(body); assert.equal(options.headers['X-CSRF-Token'], session.csrfToken) }
      assert.equal(options.credentials, 'same-origin')
      return originalFetch(origin + path, { ...options, headers: { ...options.headers, Origin: origin, Cookie: cookies() } })
    }
    globalThis.fetch = transport; client.setClientSession(session)
    workspace = new client.BrowserHifoxWorkspace({ project, session })
    let spaceId, taskId
    await t.test('real roster, task, Agent, squad and version persist through the typed browser bridge', async () => {
      const initial = await workspace.hifox.snapshot(); assert.equal(initial.ok, true); assert.equal(initial.context.actorId, session.person.userId); assert.equal(initial.data.tasks.length, 0)
      assert.match(initial.context.instanceId, /^[0-9a-f-]{36}$/); assert.match(initial.context.epoch, /^[0-9a-f-]{36}$/); assert.equal(typeof initial.context.authorizationRevision, 'number')
      assert.deepEqual(new Set(initial.data.members.map((m) => m.id)), new Set([session.person.userId, bobSession.person.userId]))
      const space = await workspace.hifox.createSpace({ name: 'Delivery', key: 'DEV' }); assert.equal(space.ok, true, JSON.stringify(space)); spaceId = space.data.spaces[0].id
      assert.equal(commands.at(-1).expectedEpoch, initial.context.epoch)
      const task = await workspace.hifox.createTask({ spaceId, title: 'Shared browser task', assigneeIds: [session.person.userId] }); assert.equal(task.ok, true); taskId = task.taskId
      const agent = await workspace.hifox.saveAgent({ spaceId, name: 'Browser Agent', instructions: 'Review the shared task; await runtime.' }); assert.equal(agent.ok, true)
      const captain = agent.data.agents[0]
      const crew = await workspace.hifox.saveCrew({ spaceId, name: 'Browser squad', captainAgentId: captain.id, memberRefs: [{ kind: 'agent', id: captain.id }], exclusiveAgentIds: [] }); assert.equal(crew.ok, true)
      const version = await workspace.hifox.createIteration({ spaceId, name: 'Browser version', startDate: '2026-10-24', endDate: '2026-10-31', taskIds: [taskId] }); assert.equal(version.ok, true)
      const read = await bob.api(`/api/projects/${projectId}/hifox/snapshot`); assert.equal(read.status, 200)
      assert.equal(read.body.value.snapshot.tasks[0].title, 'Shared browser task'); assert.equal(read.body.value.snapshot.crews[0].name, 'Browser squad'); assert.equal(read.body.value.snapshot.iterations[0].name, 'Browser version')
      assert.equal((await workspace.hifox.inviteMember({ name: 'Fake person' })).ok, false)
      const release = client.bindBrowserHifox(workspace)
      await assert.rejects(client.api.pickProject(), /网页版不支持桌面能力/)
      // Leave the bound workspace alive for the remaining checks.
      void release
    })
    await t.test('CAS conflict retains exact UUID/revision/payload and refuses a changed command', async () => {
      const current = await api(`/api/projects/${projectId}/hifox/snapshot`)
      await api(`/api/projects/${projectId}/hifox/commands`, { commandId: randomUUID(), expectedEpoch: current.epoch, expectedRevision: current.revision, operation: 'updateTask', input: { id: taskId, patch: { description: 'Another writer' } } })
      const original = { id: taskId, patch: { title: 'Draft survives conflict' } }
      const reply = await workspace.hifox.updateTask(original); assert.equal(reply.ok, false); assert.equal(reply.code, 'REVISION_CONFLICT')
      const first = structuredClone(commands.at(-1)); original.patch.title = 'Changed external object'
      await workspace.hifox.snapshot()
      const changed = await workspace.hifox.updateTask({ id: taskId, patch: { title: 'Different payload' } }); assert.equal(changed.code, 'PENDING_COMMAND')
      const count = commands.length, pending = await workspace.hifox.workspacePending()
      await workspace.hifox.retryWorkspaceCommand({ commandId: pending.data[0].commandId })
      assert.equal(commands.length, count + 1); assert.deepEqual(commands.at(-1), first)
      assert.equal((await workspace.hifox.discardWorkspaceCommand({ commandId: first.commandId })).ok, true)
      assert.equal((await workspace.hifox.updateTask({ id: taskId, patch: { title: 'Draft survives conflict' } })).ok, true)
    })
    await t.test('lost reply retries the same committed operation and does not create another task', async () => {
      let dropped = false
      globalThis.fetch = async (path, options) => { const response = await transport(path, options); if (typeof path === 'string' && path.startsWith('/') && options.body && !dropped) { dropped = true; await response.body.cancel(); throw Error('lost reply after commit') }; return response }
      const first = await workspace.hifox.createTask({ spaceId, title: 'Lost receipt task' }); assert.equal(first.ok, false)
      const pending = await workspace.hifox.workspacePending(); assert.equal(pending.data[0].outcomeUnknown, true)
      assert.equal((await workspace.hifox.discardWorkspaceCommand({ commandId: pending.data[0].commandId })).ok, false)
      const command = structuredClone(commands.at(-1))
      workspace.dispose(); workspace = new client.BrowserHifoxWorkspace({ project, session })
      assert.equal((await workspace.hifox.workspacePending()).data[0].commandId, command.commandId)
      globalThis.fetch = transport
      const retry = await workspace.hifox.retryWorkspaceCommand({ commandId: command.commandId }); assert.equal(retry.ok, true); assert.deepEqual(commands.at(-1), command)
      assert.equal(retry.data.tasks.filter((task) => task.title === 'Lost receipt task').length, 1)
    })
    await t.test('long polling publishes real changes and dispose aborts outstanding subscriptions', async () => {
      await workspace.hifox.snapshot()
      let observed, beganSecondPoll, polls = 0, aborted = false
      const secondPoll = new Promise((resolve) => { beganSecondPoll = resolve })
      globalThis.fetch = async (path, options) => { options.signal?.addEventListener('abort', () => { aborted = true }, { once: true }); if (typeof path === 'string' && path.includes('waitMs=') && ++polls === 2) beganSecondPoll(); return transport(path, options) }
      const observedChange = new Promise((resolve) => { observed = resolve })
      const before = workspace.context().revision
      const off = workspace.hifox.onWorkspaceChanged((context) => { if (context.revision > before) observed(context) })
      const current = await api(`/api/projects/${projectId}/hifox/snapshot`)
      await api(`/api/projects/${projectId}/hifox/commands`, { commandId: randomUUID(), expectedEpoch: current.epoch, expectedRevision: current.revision, operation: 'updateTask', input: { id: taskId, patch: { description: 'Live server change' } } })
      const context = await Promise.race([observedChange, new Promise((_, reject) => setTimeout(() => reject(Error('Subscription did not observe server change')), 4000).unref())]); assert.ok(context.revision > before)
      await secondPoll
      off(); workspace.dispose()
      workspace = new client.BrowserHifoxWorkspace({ project, session })
      globalThis.fetch = transport
      assert.equal(aborted, true)
    })
    await t.test('authorization head changes publish metadata even when the workspace revision is unchanged', async () => {
      const before = await workspace.hifox.snapshot(), changes = []
      const off = workspace.hifox.onWorkspaceChanged((context) => changes.push(context))
      try {
        await api('/api/projects', { commandId: randomUUID(), teamId: team.result.teamId, name: 'Independent authorization scope' })
        const after = await workspace.hifox.snapshot(); assert.equal(after.ok, true)
        assert.equal(after.context.revision, before.context.revision); assert.ok(after.context.authorizationRevision > before.context.authorizationRevision)
        assert.ok(changes.some((context) => context.revision === before.context.revision && context.authorizationRevision === after.context.authorizationRevision))
      } finally { off(); workspace.dispose(); workspace = new client.BrowserHifoxWorkspace({ project, session }) }
    })
    await t.test('real backup restore replaces a higher cache revision, rejects late old epochs and retires exact pending commands', async () => {
      await workspace.hifox.snapshot()
      const backup = join(directory, 'epoch-backup'), restoredDirectory = join(directory, 'restored-epoch')
      await service.store.backup(backup)
      // This acknowledged write is newer than the backup and must disappear on restore.
      const newer = await workspace.hifox.createTask({ spaceId, title: 'Only in the pre-restore cache' }); assert.equal(newer.ok, true)
      let dropped = false
      globalThis.fetch = async (path, options) => {
        const response = await transport(path, options)
        if (typeof path === 'string' && path.startsWith('/') && options.body && !dropped) { dropped = true; await response.body.cancel(); throw Error('lost old-epoch receipt') }
        return response
      }
      const unknown = await workspace.hifox.createTask({ spaceId, title: 'Unknown old-epoch command' }); assert.equal(unknown.ok, false)
      const original = structuredClone(commands.at(-1)), oldHead = workspace.context()
      assert.equal((await workspace.hifox.workspacePending()).data[0].outcomeUnknown, true)
      let release, entered
      const began = new Promise((resolve) => { entered = resolve }), gate = new Promise((resolve) => { release = resolve })
      globalThis.fetch = async (path, options) => { const response = await transport(path, options); if (typeof path === 'string' && path.startsWith('/') && !options.body) { entered(); await gate }; return response }
      const oldRead = workspace.hifox.snapshot(); await began
      try {
        await service.close(); restoreTeamBackup(backup, restoredDirectory)
        service = await createTeamService({ dataDir: restoredDirectory, publicOrigin: origin, oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true })
        await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
        globalThis.fetch = transport
        const restored = await workspace.hifox.snapshot(); assert.equal(restored.ok, true, JSON.stringify(restored))
        assert.equal(restored.context.instanceId, oldHead.instanceId); assert.notEqual(restored.context.epoch, oldHead.epoch); assert.ok(restored.context.revision < oldHead.revision)
        assert.equal(restored.data.tasks.some((task) => task.title === 'Only in the pre-restore cache'), false)
        release(); const late = await oldRead; assert.equal(late.ok, true); assert.equal(late.context.epoch, restored.context.epoch)
        assert.equal(late.data.tasks.some((task) => task.title === 'Only in the pre-restore cache'), false)
        const pending = (await workspace.hifox.workspacePending()).data[0]
        assert.equal(pending.commandId, original.commandId); assert.equal(pending.state, 'retired'); assert.equal(pending.outcomeUnknown, true)
        const dispatched = commands.length
        assert.equal((await workspace.hifox.retryWorkspaceCommand({ commandId: original.commandId })).code, 'WORKSPACE_EPOCH_CHANGED')
        assert.equal((await workspace.hifox.createTask({ spaceId, title: 'Unknown old-epoch command' })).code, 'WORKSPACE_EPOCH_CHANGED')
        assert.equal(commands.length, dispatched); assert.deepEqual(commands.at(-1), original)
        assert.equal((await workspace.hifox.discardWorkspaceCommand({ commandId: original.commandId })).ok, true)
        const archived = JSON.parse(storage.get('trellis-team-command-history-v1')).find((entry) => entry.commandId === original.commandId)
        assert.equal(archived.workspace.epoch, original.expectedEpoch); assert.equal(archived.outcomeUnknown, true)
        assert.equal(JSON.stringify(archived).includes('Unknown old-epoch command'), false)
        assert.equal(JSON.stringify(archived).includes(session.csrfToken), false)
        const fresh = await workspace.hifox.createTask({ spaceId, title: 'Explicit new-epoch intent' }); assert.equal(fresh.ok, true)
        assert.equal(commands.at(-1).expectedEpoch, restored.context.epoch); assert.notEqual(commands.at(-1).commandId, original.commandId)
      } finally { release(); await oldRead; globalThis.fetch = transport }
    })
    await t.test('a replacement service instance locks the original scope and cannot replay its pending intent', async () => {
      let dropped = false
      globalThis.fetch = async (path, options) => { const response = await transport(path, options); if (typeof path === 'string' && path.startsWith('/') && options.body && !dropped) { dropped = true; await response.body.cancel(); throw Error('lost receipt before instance change') }; return response }
      await workspace.hifox.updateTask({ id: taskId, patch: { description: 'Original service only' } })
      const original = structuredClone(commands.at(-1)), instanceId = workspace.context().instanceId
      globalThis.fetch = transport
      const backup = join(directory, 'instance-backup'), replacementDirectory = join(directory, 'replacement-instance')
      await service.store.backup(backup); restoreTeamBackup(backup, replacementDirectory)
      const db = new DatabaseSync(join(replacementDirectory, 'team.sqlite'))
      try { db.prepare('UPDATE team_meta SET value=? WHERE key=?').run(randomUUID(), 'instanceId') } finally { db.close() }
      const port = await freePort(), replacementOrigin = `http://127.0.0.1:${port}`
      const replacement = await createTeamService({ dataDir: replacementDirectory, publicOrigin: replacementOrigin, oidc: { issuer: identity.issuer, clientId: 'team-owned-fixture' }, bootstrapSubject: 'alice', allowLoopbackHttp: true })
      try {
        await replacement.app.listen({ port, host: '127.0.0.1' })
        globalThis.fetch = async (path, options) => typeof path === 'string' && path.startsWith('/') ? originalFetch(replacementOrigin + path, { ...options, headers: { ...options.headers, Origin: replacementOrigin, Cookie: cookies() } }) : originalFetch(path, options)
        const changed = await workspace.hifox.snapshot(); assert.equal(changed.ok, false); assert.equal(changed.code, 'WORKSPACE_INSTANCE_CHANGED')
        assert.equal(workspace.context().instanceId, instanceId); assert.equal(workspace.context().actorId, null); assert.equal(workspace.context().canManage, false)
        const pending = (await workspace.hifox.workspacePending()).data[0]
        assert.equal(pending.commandId, original.commandId); assert.equal(pending.state, 'retired'); assert.equal(pending.outcomeUnknown, true)
        const count = commands.length
        assert.equal((await workspace.hifox.retryWorkspaceCommand({ commandId: original.commandId })).ok, false)
        assert.equal((await workspace.hifox.updateTask({ id: taskId, patch: { description: 'Cannot migrate payload' } })).ok, false)
        assert.equal(commands.length, count)
        assert.equal((await workspace.hifox.discardWorkspaceCommand({ commandId: original.commandId })).ok, true)
      } finally { await replacement.close(); workspace.dispose(); workspace = new client.BrowserHifoxWorkspace({ project, session }); globalThis.fetch = transport }
    })
    await t.test('hard reload after a committed lost acknowledgement reconciles its durable original UUID without another POST', async () => {
      const target = await isolatedProject('Reload committed intent'), owned = new client.BrowserHifoxWorkspace({ project: target, session })
      let fresh
      try {
        await owned.hifox.snapshot()
        let dropped = false
        globalThis.fetch = async (path, options) => {
          const response = await transport(path, options)
          if (typeof path === 'string' && path.startsWith('/') && options.body && !dropped) { dropped = true; await response.body.cancel(); throw Error('acknowledgement lost') }
          return response
        }
        assert.equal((await owned.hifox.createSpace({ name: 'Private draft never persisted', key: 'ACK' })).ok, false)
        const original = structuredClone(commands.at(-1)), journal = storage.get('trellis-team-command-refs-v1')
        assert.ok(journal.includes(original.commandId)); assert.ok(journal.includes(original.expectedEpoch))
        assert.equal(journal.includes('Private draft never persisted'), false); assert.equal(journal.includes(session.csrfToken), false); assert.equal(journal.includes('"input"'), false)
        owned.dispose(); const reloaded = await reloadClient(); reloaded.setClientSession(session)
        fresh = new reloaded.BrowserHifoxWorkspace({ project: target, session }); globalThis.fetch = transport
        await fresh.hifox.snapshot()
        const refs = await fresh.hifox.workspacePending(); assert.equal(refs.data[0].commandId, original.commandId); assert.equal(refs.data[0].state, 'reference-only')
        assert.equal(refs.data[0].digest, JSON.parse(journal).find((entry) => entry.commandId === original.commandId).digest)
        const count = commands.length
        const repeated = await fresh.hifox.createSpace({ name: 'Private draft never persisted', key: 'ACK' })
        assert.equal(repeated.code, 'ORIGINAL_COMMAND_RECONCILED'); assert.equal(commands.length, count)
        assert.equal((await fresh.hifox.workspacePending()).data.length, 0)
        assert.equal((await fresh.hifox.snapshot()).data.spaces.filter((space) => space.key === 'ACK').length, 1)
      } finally { owned.dispose(); fresh?.dispose(); globalThis.fetch = transport }
    })
    await t.test('missing receipts after hard reload remain uncertain and cannot forge a retry or a new intent', async () => {
      const target = await isolatedProject('Reload absent receipt'), owned = new client.BrowserHifoxWorkspace({ project: target, session })
      let fresh
      try {
        await owned.hifox.snapshot()
        globalThis.fetch = async (path, options) => { if (typeof path === 'string' && path.startsWith('/') && options.body) throw Error('request disappeared before delivery'); return transport(path, options) }
        assert.equal((await owned.hifox.createSpace({ name: 'Volatile absent draft', key: 'ABSENT' })).ok, false)
        const entry = client.pendingCommands(session.person.userId).find((item) => item.projectId === target.projectId)
        owned.dispose(); const reloaded = await reloadClient(); reloaded.setClientSession(session)
        fresh = new reloaded.BrowserHifoxWorkspace({ project: target, session }); globalThis.fetch = transport
        await fresh.hifox.snapshot(); const count = commands.length
        assert.equal((await fresh.hifox.retryWorkspaceCommand({ commandId: entry.commandId })).code, 'PAYLOAD_UNAVAILABLE')
        assert.equal((await fresh.hifox.createSpace({ name: 'Cannot assume a new intent', key: 'NEW' })).code, 'PAYLOAD_UNAVAILABLE')
        assert.equal((await fresh.hifox.discardWorkspaceCommand({ commandId: entry.commandId })).code, 'OUTCOME_UNKNOWN')
        assert.equal(commands.length, count)
        const pending = await fresh.hifox.workspacePending(); assert.equal(pending.data[0].commandId, entry.commandId); assert.equal(pending.data[0].outcomeUnknown, true)
        assert.equal((await workspace.hifox.workspacePending()).data.some((item) => item.commandId === entry.commandId), false)
      } finally { owned.dispose(); fresh?.dispose(); globalThis.fetch = transport }
    })
    await t.test('storage failure before dispatch blocks POST and acknowledgement storage failure survives reload with original metadata', async () => {
      const target = await isolatedProject('Storage failure scope'), owned = new client.BrowserHifoxWorkspace({ project: target, session })
      let failWrites = false, fresh
      const setItem = browserStorage.setItem
      browserStorage.setItem = (key, value) => { if (failWrites) throw Error('storage unavailable'); return setItem(key, value) }
      try {
        await owned.hifox.snapshot(); failWrites = true
        const count = commands.length, before = storage.get('trellis-team-command-refs-v1')
        assert.equal((await owned.hifox.createSpace({ name: 'Must not leave browser', key: 'BLOCK' })).code, 'JOURNAL_UNAVAILABLE')
        assert.equal(commands.length, count); assert.equal(storage.get('trellis-team-command-refs-v1'), before)
        failWrites = false
        globalThis.fetch = async (path, options) => { const response = await transport(path, options); if (typeof path === 'string' && path.startsWith('/') && options.body) failWrites = true; return response }
        assert.equal((await owned.hifox.createSpace({ name: 'ACK storage loss', key: 'STATE' })).ok, false)
        const original = structuredClone(commands.at(-1)), prewritten = JSON.parse(storage.get('trellis-team-command-refs-v1')).find((entry) => entry.commandId === original.commandId)
        assert.equal(prewritten.state, 'pending'); assert.equal(prewritten.workspace.epoch, original.expectedEpoch)
        owned.dispose(); const reloaded = await reloadClient(); reloaded.setClientSession(session)
        fresh = new reloaded.BrowserHifoxWorkspace({ project: target, session }); globalThis.fetch = transport
        await fresh.hifox.snapshot(); assert.equal((await fresh.hifox.workspacePending()).data[0].outcomeUnknown, true)
        failWrites = false; const dispatched = commands.length
        assert.equal((await fresh.hifox.retryWorkspaceCommand({ commandId: original.commandId })).ok, true)
        assert.equal(commands.length, dispatched); assert.equal((await fresh.hifox.snapshot()).data.spaces.filter((space) => space.key === 'STATE').length, 1)
      } finally { failWrites = false; browserStorage.setItem = setItem; owned.dispose(); fresh?.dispose(); globalThis.fetch = transport }
    })
    await t.test('missing browser crypto blocks metadata and writes while authorized reads still work', async () => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'), count = commands.length, before = JSON.stringify([...storage])
      try {
        Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
        assert.equal((await workspace.hifox.snapshot()).ok, true)
        const reply = await workspace.hifox.createTask({ spaceId, title: 'No insecure UUID fallback' })
        assert.equal(reply.code, 'SECURE_CONTEXT_REQUIRED'); assert.match(reply.error, /HTTPS.*localhost/)
        assert.equal(commands.length, count); assert.equal(JSON.stringify([...storage]), before)
      } finally { Object.defineProperty(globalThis, 'crypto', descriptor) }
    })
    await t.test('account changes during asynchronous preparation retain the original metadata and cannot send through the next session', async () => {
      const target = await isolatedProject('Async preparation owner'), owned = new client.BrowserHifoxWorkspace({ project: target, session })
      const originalDigest = crypto.subtle.digest
      let release, entered
      const began = new Promise((resolve) => { entered = resolve }), gate = new Promise((resolve) => { release = resolve })
      try {
        await owned.hifox.snapshot(); const head = owned.context(), count = commands.length
        crypto.subtle.digest = async (...args) => { entered(); await gate; return originalDigest.apply(crypto.subtle, args) }
        const preparing = owned.hifox.createSpace({ name: 'Original account volatile draft', key: 'OWNER' })
        await began; client.setClientSession(bobSession); release()
        assert.equal((await preparing).ok, false); assert.equal(commands.length, count)
        const entry = client.pendingCommands(session.person.userId).find((item) => item.projectId === target.projectId)
        assert.ok(entry); assert.equal(entry.workspace.epoch, head.epoch); assert.equal(entry.accountId, session.person.userId)
        assert.equal(JSON.stringify(entry).includes('Original account volatile draft'), false)
        assert.equal((await owned.hifox.workspacePending()).ok, false)
      } finally { release(); crypto.subtle.digest = originalDigest; owned.dispose(); client.setClientSession(session) }
    })
    await t.test('business 403 keeps the authorized reader and unknown original metadata without global auth denial', async () => {
      const bobCookies = () => [...bob.cookies.get('127.0.0.1')].map(([name, value]) => `${name}=${value}`).join('; ')
      const bobTransport = (path, options) => typeof path === 'string' && path.startsWith('/') ? originalFetch(origin + path, { ...options, headers: { ...options.headers, Origin: origin, Cookie: bobCookies() } }) : originalFetch(path, options)
      client.setClientSession(bobSession); const owned = new client.BrowserHifoxWorkspace({ project, session: bobSession })
      let denied = 0; const listener = () => { denied++ }; client.authEvents.addEventListener('denied', listener)
      try {
        globalThis.fetch = bobTransport; await owned.hifox.snapshot()
        const draft = { spaceId, name: 'Preserved Agent draft', instructions: 'An ordinary member cannot configure this Agent.' }
        const blocked = await owned.hifox.saveAgent(draft); assert.equal(blocked.ok, false); assert.ok(['OPERATION_FORBIDDEN', 'MANAGEMENT_REQUIRED'].includes(blocked.code))
        assert.equal(owned.context().state, 'connected'); assert.equal(denied, 0); assert.equal(draft.name, 'Preserved Agent draft')
        globalThis.fetch = (path, options) => typeof path === 'string' && path.startsWith('/') && options.body ? Promise.reject(Error('unknown delivery')) : bobTransport(path, options)
        await owned.hifox.saveAgent(draft)
        const entry = client.pendingCommands(bobSession.person.userId).find((item) => item.projectId === projectId)
        globalThis.fetch = bobTransport
        const retry = await owned.hifox.retryWorkspaceCommand({ commandId: entry.commandId }); assert.equal(retry.ok, false)
        assert.equal(owned.context().state, 'connected'); assert.equal(denied, 0)
        assert.equal((await owned.hifox.workspacePending()).data[0].commandId, entry.commandId)
        assert.equal(client.pendingCommands(bobSession.person.userId).some((item) => item.commandId === entry.commandId), true)
      } finally { owned.dispose(); client.authEvents.removeEventListener('denied', listener); client.setClientSession(session); globalThis.fetch = transport }
      assert.equal((await workspace.hifox.workspacePending()).data.some((item) => item.commandId === client.pendingCommands(bobSession.person.userId)[0]?.commandId), false)
    })
    await t.test('account changes fence dispatch and late responses; forbidden replies clear authority and data', async () => {
      await workspace.hifox.snapshot()
      let release, entered
      const began = new Promise((resolve) => { entered = resolve }), gate = new Promise((resolve) => { release = resolve })
      globalThis.fetch = async (...args) => { const response = await transport(...args); entered(); await gate; return response }
      const reading = workspace.hifox.snapshot(); await began
      client.setClientSession(bobSession); release()
      const reply = await reading; assert.equal(reply.ok, false); assert.equal(workspace.context().state, 'access-revoked'); assert.equal(workspace.context().actorId, null)
      const count = commands.length; assert.equal((await workspace.hifox.updateTask({ id: taskId, patch: { title: 'Old owner' } })).ok, false); assert.equal(commands.length, count)
      workspace.dispose(); client.setClientSession(session); workspace = new client.BrowserHifoxWorkspace({ project, session }); globalThis.fetch = transport
      await workspace.hifox.snapshot()
      await api(`/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: session.person.userId, roles: ['pm'], active: false, expectedRevision: 1 })
      const denied = await workspace.hifox.snapshot(); assert.equal(denied.ok, false); assert.equal(workspace.context().state, 'access-revoked'); assert.equal(workspace.context().canManage, false); assert.equal(workspace.context().pendingCount, 0)
    })
  } finally {
    workspace?.dispose(); globalThis.fetch = originalFetch; globalThis.location = originalLocation; globalThis.sessionStorage = originalStorage
    await service?.close(); await identity.close()
    const target = resolve(directory)
    if (dirname(target) === resolve(tmpdir()) && basename(target).startsWith('trellis-hifox-browser-api-')) rmSync(target, { recursive: true, force: true })
  }
})
