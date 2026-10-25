import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'trellis-creation-desktop-'))
const require = createRequire(import.meta.url)
let passed = 0
const liveServices = new Set()
const check = async (name, run) => { await run(); passed++; console.log('PASS ' + name) }
const digest = (text) => createHash('sha256').update(text).digest('hex')
try {
  const output = join(root, 'creation-service.cjs')
  await build({ stdin: { contents: `export * from ${JSON.stringify(resolve('src/main/services/creations/service.ts'))}; export * from ${JSON.stringify(resolve('src/shared/creation-ai.ts'))}; export {DesktopTeamService} from ${JSON.stringify(resolve('src/main/services/team-platform/service.ts'))};`, resolveDir: process.cwd(), loader: 'ts' }, outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'owned-team-boundaries', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'owned' }))
    builder.onResolve({ filter: /^\.\.\/proxy$/ }, (args) => args.importer.replaceAll('\\', '/').endsWith('/team-platform/service.ts') ? { path: 'proxy', namespace: 'owned' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'owned' }, ({ path }) => ({ contents: path === 'electron' ? 'export const shell={openExternal:async()=>{throw Error("No real browser in fixture")}};export const safeStorage={isEncryptionAvailable:()=>false};' : 'export async function proxiedFetch(){throw Error("No network in fixture")}', loader: 'js' }))
  } }] })
  const { CreationMainService, applyCreationPatch, DesktopTeamService } = require(output)
  const people = ['owner', 'reviewer', 'developer'].map((id) => ({ id, name: id, role: 'member', avatarHue: 0, joinedAt: new Date().toISOString() }))
  const snapshot = { members: people, spaces: [{ id: 'space', name: '产品空间', key: 'P', memberIds: people.map((person) => person.id), multiAssignee: false, taskSeq: 1, createdAt: new Date().toISOString() }], tasks: [{ id: 'TASK-1', spaceId: 'space', iterationIds: ['v15'] }] }
  let context = { key: 'local', state: 'local', connectionId: null, projectId: null, actorId: 'owner', canManage: true, revision: 0, projectName: null, pendingCount: 0 }
  let captured = [], model = async () => ({ ok: true, content: JSON.stringify({ edits: [{ before: '<button id="export">导出</button>', after: '<button id="export" disabled>导出</button>' }] }) })
  const modelConfig = { enabled: true, model: 'fixture', baseUrl: 'http://fixture.invalid', apiKey: '' }
  const changes = []
  const deps = { dataDir: root, workspace: async () => ({ snapshot, context: { ...context } }), status: async () => ({ ...context }), remote: async () => { throw new Error('Local fixture cannot call network') }, model: () => modelConfig,
    chat: async (_config, messages, options) => { captured = messages; return model(options) }, changed: (...args) => changes.push(args) }
  const openService = (dependencies) => { const value = new CreationMainService(dependencies); liveServices.add(value); return value }
  const service = openService(deps)
  const creationId = randomUUID(), original = `<!doctype html><html><body><!--${'unrelated-data-'.repeat(12000)}--><button id="export">导出</button></body></html>`
  let view, r1, r2, opinion
  const create = { action: 'create', commandId: randomUUID(), creationId, expectedRevision: null, title: '盘点导出', kind: 'prototype', home: 'personal', spaceId: null, body: original, privateNotes: 'private exploratory note' }
  const command = async (value) => { const current = await service.get({ workspaceKey: 'local', creationId }); return service.command({ workspaceKey: 'local', command: { commandId: randomUUID(), creationId, expectedRevision: current.summary.revision, ...value } }) }
  await check('create personal prototype without any code project, metadata-only listing', async () => {
    await service.command({ workspaceKey: 'local', command: create })
    const list = await service.list({ workspaceKey: 'local', scope: 'personal' })
    assert.equal(list.items.length, 1); assert.equal(JSON.stringify(list).includes(original), false)
    assert.equal((await service.list({ workspaceKey: 'local', scope: 'team' })).items.length, 0)
    view = await service.get({ workspaceKey: 'local', creationId }); assert.equal(view.selected.body, original)
  })
  await check('publication shares a fixed view and keeps private notes out', async () => {
    const result = await command({ action: 'publish', spaceId: 'space', reviewerIds: ['reviewer'] }); r1 = result.result.revisionId
    context = { ...context, actorId: 'reviewer' }
    view = await service.get({ workspaceKey: 'local', creationId })
    assert.equal(view.selected.revisionId, r1); assert.equal(view.privateNotes, undefined); assert.equal(view.draft, undefined)
    const result2 = await command({ action: 'annotate', revisionId: r1, severity: 'required', body: '空数据时禁用导出', target: { kind: 'web', stableId: 'export', name: '导出', context: { fields: [{ name: '药房', value: '门诊药房' }] } } })
    opinion = result2.result.commentId
    context = { ...context, actorId: 'owner' }
  })
  await check('candidate model receives selected source fragments within hard byte budget', async () => {
    view = await service.get({ workspaceKey: 'local', creationId })
    const input = { workspaceKey: 'local', creationId, commandId: randomUUID(), expectedRevision: view.summary.revision, commentIds: [opinion] }
    const plan = await service.planCandidate(input)
    assert.ok(plan.inputBytes <= 12288); assert.ok(plan.estimatedTokens > 0); assert.equal(plan.fragmentCount, 1)
    const result = await service.generateCandidate(input)
    assert.ok(Buffer.byteLength(captured.map((item) => item.content).join('')) <= 12288)
    assert.equal(captured.some((item) => item.content.includes(original)), false)
    const candidate = await service.get({ workspaceKey: 'local', creationId, revisionId: result.result.candidateId })
    assert.ok(candidate.selected.body.includes('id="export" disabled'))
    assert.equal((await service.get({ workspaceKey: 'local', creationId, revisionId: r1 })).selected.body, original)
    await command({ action: 'candidateAdopt', candidateId: result.result.candidateId })
    r2 = (await command({ action: 'publish', spaceId: 'space', reviewerIds: ['reviewer'] })).result.revisionId
  })
  await check('new publication cannot bypass old required opinion; confirmation records displayed revision', async () => {
    await assert.rejects(command({ action: 'adoptForTask', taskId: 'TASK-1', revisionId: r2, confirmedCommentIds: [] }), /required|意见|Resolve/i)
    context = { ...context, actorId: 'reviewer' }
    const review = await service.get({ workspaceKey: 'local', creationId, revisionId: r2 })
    assert.ok(review.comments.some((item) => item.commentId === opinion))
    await command({ action: 'disposition', commentId: opinion, status: 'confirmed', finalRule: '空数据时禁用导出', reviewRevisionId: r2 })
    context = { ...context, actorId: 'owner' }
    await command({ action: 'adoptForTask', taskId: 'TASK-1', revisionId: r2, confirmedCommentIds: [opinion] })
  })
  await check('task reference stays on R2 after R3 and task keeps v15', async () => {
    await command({ action: 'saveDraft', body: original.replace('导出', '导出结果') })
    await command({ action: 'publish', spaceId: 'space', reviewerIds: ['reviewer'] })
    const list = await service.list({ workspaceKey: 'local', scope: 'team', taskId: 'TASK-1' })
    const adoption = list.items[0].adoptions.find((item) => item.taskId === 'TASK-1')
    assert.equal(adoption.revisionId, r2); assert.equal(adoption.confirmedRules[0].finalRule, '空数据时禁用导出')
    assert.deepEqual(snapshot.tasks[0].iterationIds, ['v15'])
    const restarted = openService(deps)
    assert.equal((await restarted.get({ workspaceKey: 'local', creationId, revisionId: r2 })).selected.body.includes('disabled'), true)
  })
  await check('original local command replay is idempotent after later publications', async () => {
    assert.equal((await service.command({ workspaceKey: 'local', command: create })).status, 'duplicate')
    assert.equal((await openService(deps).command({ workspaceKey: 'local', command: create })).status, 'duplicate')
    await assert.rejects(service.command({ workspaceKey: 'local', command: { ...create, title: 'changed payload' } }), /原操作标识/)
  })
  await check('source changes during generation preserve current draft', async () => {
    let finish, entered
    const started = new Promise((resolve) => { entered = resolve })
    model = async () => { entered(); return new Promise((resolve) => { finish = resolve }) }
    view = await service.get({ workspaceKey: 'local', creationId })
    const pending = service.generateCandidate({ workspaceKey: 'local', creationId, commandId: randomUUID(), expectedRevision: view.summary.revision, commentIds: [opinion] })
    await started; context = { ...context, key: 'another-source' }; finish({ ok: true, content: '{}' })
    await assert.rejects(pending, /来源已变化/)
    context = { ...context, key: 'local' }
    assert.equal((await service.get({ workspaceKey: 'local', creationId })).summary.revision, view.summary.revision)
  })
  await check('cancellation aborts model request and never writes a candidate', async () => {
    let entered
    const started = new Promise((resolve) => { entered = resolve })
    model = async ({ signal }) => { entered(); return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }), { once: true })) }
    view = await service.get({ workspaceKey: 'local', creationId })
    const commandId = randomUUID(), pending = service.generateCandidate({ workspaceKey: 'local', creationId, commandId, expectedRevision: view.summary.revision, commentIds: [opinion] })
    await started; assert.equal((await service.cancelCandidate({ workspaceKey: 'local', commandId })).cancelled, true)
    await assert.rejects(pending, /已取消/)
    assert.equal((await service.get({ workspaceKey: 'local', creationId })).summary.revision, view.summary.revision)
  })
  await check('exact patch refuses duplicate/unknown sources and preserves replacement dollar syntax', async () => {
    assert.throws(() => applyCreationPatch('xx', ['xx'], '{"edits":[{"before":"x","after":"y"}]}'), /不唯一/)
    assert.throws(() => applyCreationPatch('aaa', ['aaa'], '{"edits":[{"before":"aa","after":"y"}]}'), /不唯一/)
    assert.throws(() => applyCreationPatch('abc', ['a'], '{"edits":[{"before":"bc","after":"z"}]}'), /不唯一/)
    assert.equal(applyCreationPatch('unique', ['unique'], JSON.stringify({ edits: [{ before: 'unique', after: '$& literal' }] })), '$& literal')
  })
  const remoteFixture = () => {
    const f = { context: { key: 'remote-fixture', state: 'connected', connectionId: randomUUID(), projectId: randomUUID(), actorId: 'owner', epoch: randomUUID(), instanceId: randomUUID(), origin: 'https://owned.fixture.invalid', authorizationRevision: 1 }, sent: [], receiptValue: null, onCommand: null, onReceipt: null, onWorkspace: null, onHead: null, fingerprint: digest('initial head'), headCalls: [], notifications: [] }
    const original = structuredClone(f.context)
    f.command = { ...create, commandId: randomUUID(), creationId: randomUUID(), body: '<button>Owned remote fixture</button>' }
    f.reply = (value) => ({ status: 'committed', commandId: value.commandId, result: { projectId: original.projectId, creationId: value.creationId, epoch: original.epoch, revision: 1, action: value.action, scopeSpaceIds: [], scopeTaskIds: [], private: true } })
    f.remote = {
      creationHead: async (connectionId) => { f.headCalls.push(connectionId); const head = { projectId: f.context.projectId, epoch: f.context.epoch, fingerprint: f.fingerprint }; return f.onHead ? f.onHead(head) : head },
      creationCommand: async (_connectionId, value) => { f.sent.push(structuredClone(value)); return f.onCommand ? f.onCommand(value) : f.reply(value) },
      creationReceipt: async () => f.onReceipt ? f.onReceipt() : f.receiptValue
    }
    f.dataDir = join(root, randomUUID())
    f.deps = { ...deps, dataDir: f.dataDir, workspace: async () => { if (f.onWorkspace) await f.onWorkspace(); return { snapshot, context: structuredClone(f.context) } }, status: async () => structuredClone(f.context), remote: async (action) => action(f.remote), changed: (...args) => f.notifications.push(args) }
    f.open = () => { f.service?.close(); return openService(f.deps) }
    f.service = f.open()
    f.send = () => f.service.command({ workspaceKey: original.key, command: f.command })
    f.recover = () => f.service.recover({ workspaceKey: original.key, creationId: f.command.creationId })
    f.pending = async () => {
      const path = join(f.dataDir, 'creations', 'pending')
      const names = await readdir(path)
      return Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(path, name), 'utf8'))))
    }
    f.timeout = async () => {
      f.onCommand = () => { throw Object.assign(new Error('Owned timeout'), { code: 'NETWORK_UNAVAILABLE', outcomeUnknown: true }) }
      await assert.rejects(f.send(), /Owned timeout/)
      f.onCommand = null
    }
    return f
  }
  await check('remote timeout survives restart and recovery replays the exact original command', async () => {
    const f = remoteFixture(); await f.timeout()
    const [pending] = await f.pending()
    assert.deepEqual(pending.command, f.sent[0]); assert.equal(pending.projectId, f.context.projectId)
    f.service = f.open()
    assert.equal((await f.recover()).status, 'committed'); assert.equal(f.sent.length, 2)
    assert.deepEqual(f.sent[1], f.sent[0]); assert.deepEqual(await f.pending(), []); assert.equal(await f.recover(), null)
  })
  await check('source changes after remote acknowledgement retain the original pending receipt', async () => {
    for (const field of ['actorId', 'projectId', 'epoch', 'authorizationRevision']) {
      const f = remoteFixture(), original = structuredClone(f.context)
      f.onCommand = (value) => { const result = f.reply(value); f.context[field] = field === 'authorizationRevision' ? 2 : randomUUID(); return result }
      await assert.rejects(f.send(), /来源已变化/)
      const [pending] = await f.pending(); assert.ok(pending, field); assert.deepEqual(pending.command, f.sent[0])
      f.context = original; f.onCommand = null; f.receiptValue = f.reply(f.sent[0]); f.service = f.open()
      assert.equal((await f.recover()).commandId, f.command.commandId); assert.equal(f.sent.length, 1); assert.deepEqual(await f.pending(), [])
    }
  })
  await check('receipt lookup cannot replay under a changed actor, project or service epoch', async () => {
    for (const field of ['actorId', 'projectId', 'epoch']) {
      const f = remoteFixture(); await f.timeout()
      f.onReceipt = () => { f.context[field] = randomUUID(); return null }
      await assert.rejects(f.recover(), /来源已变化/)
      assert.equal(f.sent.length, 1, field); assert.equal((await f.pending()).length, 1)
    }
  })
  await check('foreign command, creation, action, project or epoch receipts cannot settle an unknown write', async () => {
    for (const field of ['commandId', 'creationId', 'action', 'projectId', 'epoch']) {
      const f = remoteFixture(); await f.timeout()
      f.receiptValue = f.reply(f.sent[0])
      if (field === 'commandId') f.receiptValue.commandId = randomUUID()
      else f.receiptValue.result[field] = field === 'action' ? 'saveDraft' : randomUUID()
      await assert.rejects(f.recover(), (error) => error.code === 'RECEIPT_MISMATCH' && error.outcomeUnknown === true)
      assert.equal((await f.pending()).length, 1, field); assert.equal(f.sent.length, 1)
    }
  })
  await check('pending commands cannot be retargeted when the selected project changes', async () => {
    const f = remoteFixture(); await f.timeout(); f.context.projectId = randomUUID(); f.service = f.open()
    await assert.rejects(f.send(), /来源|团队|世代/); assert.equal(f.sent.length, 1); assert.equal((await f.pending()).length, 1)
    await assert.rejects(f.recover(), /来源|团队|世代/); assert.equal(f.sent.length, 1)
  })
  await check('workspace refresh cannot silently admit an operation under a newly observed epoch', async () => {
    const f = remoteFixture()
    f.onWorkspace = () => { f.context.epoch = randomUUID() }
    await assert.rejects(f.send(), /来源|团队|世代/); assert.equal(f.sent.length, 0)
  })
  await check('a definite rejection on a later retry preserves the original unknown write', async () => {
    const f = remoteFixture(); await f.timeout()
    f.onCommand = () => { throw Object.assign(new Error('Owned revision conflict'), { code: 'REVISION_CONFLICT', outcomeUnknown: false }) }
    await assert.rejects(f.send(), (error) => error.code === 'REVISION_CONFLICT' && error.outcomeUnknown === true)
    assert.equal((await f.pending()).length, 1); assert.deepEqual(f.sent[1], f.sent[0])
  })
  await check('closing during the final source check retains the acknowledged command for recovery', async () => {
    const f = remoteFixture()
    let enter, finish
    const entered = new Promise((resolve) => { enter = resolve }), wait = new Promise((resolve) => { finish = resolve })
    f.onCommand = (value) => { f.deps.status = async () => { enter(); await wait; return structuredClone(f.context) }; return f.reply(value) }
    const pending = f.send(); await entered; f.service.close(); finish()
    await assert.rejects(pending, (error) => error.code === 'SERVICE_CLOSED' && error.outcomeUnknown === true)
    assert.equal((await f.pending()).length, 1)
  })
  await check('uppercase UUID creation files and receipts survive restart', async () => {
    const value = { ...create, commandId: randomUUID(), creationId: randomUUID().toUpperCase(), body: '<p>Owned uppercase identity</p>' }
    await service.command({ workspaceKey: 'local', command: value })
    await assert.rejects(service.command({ workspaceKey: 'local', command: { ...value, commandId: randomUUID(), creationId: value.creationId.toLowerCase(), body: '<p>Must not replace a filesystem alias</p>' } }), /身份.*冲突/)
    const restarted = openService(deps)
    assert.equal((await restarted.get({ workspaceKey: 'local', creationId: value.creationId })).selected.body, value.body)
    assert.equal((await restarted.command({ workspaceKey: 'local', command: value })).status, 'duplicate')
  })
  await check('local creation count rejects the first unreadable record and preserves restart access', async () => {
    const dependencies = { ...deps, dataDir: join(root, 'owned-capacity') }, bounded = openService(dependencies)
    let retained
    for (let i = 0; i < 256; i++) {
      retained = { ...create, commandId: randomUUID(), creationId: randomUUID(), body: '<p>Owned bounded store</p>' }
      await bounded.command({ workspaceKey: 'local', command: retained })
    }
    await assert.rejects(bounded.command({ workspaceKey: 'local', command: { ...retained, commandId: randomUUID(), creationId: randomUUID() } }), /数量.*限额/)
    const restarted = openService(dependencies)
    assert.equal((await restarted.get({ workspaceKey: 'local', creationId: retained.creationId })).selected.body, retained.body)
    assert.equal((await readdir(join(dependencies.dataDir, 'creations', 'local'))).length, 256)
  })

  const teamFixture = () => {
    const c = { connectionId: randomUUID(), origin: 'https://owned.fixture.invalid', deviceId: randomUUID(), pairingId: randomUUID(), ownerId: randomUUID(), projectId: randomUUID(), state: 'active', accessLocked: false }
    const token = 'td_' + 'a'.repeat(43)
    c.encryptedToken = JSON.stringify({ version: 1, connectionId: c.connectionId, origin: c.origin, deviceId: c.deviceId, pairingId: c.pairingId, token })
    const f = { connection: structuredClone(c), epoch: randomUUID(), requests: [], onHead: null, onSession: null }
    const store = { call: async (value) => { assert.ok(['connection', 'update-connection'].includes(value.op)); return structuredClone(f.connection) }, close: async () => {} }
    f.client = new DesktopTeamService(store, { dataDir: root, revealSecret: (value) => value, fetch: async (url, init) => {
      const path = new URL(url).pathname; f.requests.push(path)
      assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.headers.Authorization, `Bearer ${token}`)
      let value
      if (path === '/api/session') value = f.onSession ? f.onSession() : { contractVersion: 1, authentication: 'device', csrfToken: null, deviceId: c.deviceId, person: { userId: c.ownerId, displayName: 'Owned person', active: true, isPlatformAdmin: false, revision: 1 } }
      else { assert.equal(path, `/api/projects/${c.projectId}/creations/head`); const head = { projectId: c.projectId, epoch: f.epoch, fingerprint: digest('authorized metadata') }; value = f.onHead ? f.onHead(head) : head }
      return new Response(JSON.stringify({ ok: true, value }), { headers: { 'Content-Type': 'application/json' } })
    } })
    f.read = () => f.client.creationHead(c.connectionId)
    return f
  }
  await check('real team adapter polls only authenticated metadata and rejects project or binding changes', async () => {
    const normal = teamFixture(); assert.equal((await normal.read()).epoch, normal.epoch)
    assert.equal(normal.requests.length, 2); assert.equal(normal.requests[0], '/api/session'); assert.ok(normal.requests[1].endsWith('/creations/head'))
    await normal.client.close()
    for (const field of ['projectId', 'ownerId', 'pairingId', 'deviceId', 'origin']) {
      const f = teamFixture(); f.onHead = (head) => { f.connection[field] = field === 'origin' ? 'https://changed.fixture.invalid' : randomUUID(); return head }
      await assert.rejects(f.read(), /身份|团队|账号|凭据|绑定|来源/); await f.client.close()
    }
    const foreign = teamFixture(); foreign.onHead = (head) => ({ ...head, projectId: randomUUID() })
    await assert.rejects(foreign.read(), (error) => error.code === 'BINDING_CHANGED'); await foreign.client.close()
    const malformed = teamFixture(); malformed.onHead = (head) => ({ ...head, body: '<p>Must never poll HTML</p>' })
    await assert.rejects(malformed.read(), (error) => error.code === 'INVALID_RESPONSE'); await malformed.client.close()
    const denied = teamFixture(); denied.onSession = () => ({ contractVersion: 1, authentication: 'device', csrfToken: null, deviceId: randomUUID(), person: { userId: randomUUID(), displayName: 'Foreign fixture person', active: true, isPlatformAdmin: false, revision: 1 } })
    await assert.rejects(denied.read(), (error) => error.code === 'BINDING_CHANGED'); assert.equal(denied.requests.length, 1); await denied.client.close()
  })

  // A controlled clock drives only the service's timer; persistence still uses real TEMP files.
  const withClock = async (run) => {
    for (const value of liveServices) value.close()
    const savedSet = globalThis.setTimeout, savedClear = globalThis.clearTimeout, timers = new Set()
    globalThis.setTimeout = (action, delay) => { const timer = { action, delay, unreferenced: false, unref() { this.unreferenced = true; return this } }; timers.add(timer); return timer }
    globalThis.clearTimeout = (timer) => timers.delete(timer)
    const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
    const clock = { timers, flush, next: () => { assert.equal(timers.size, 1); return [...timers][0] }, tick: async () => { const timer = clock.next(); timers.delete(timer); timer.action(); await flush() } }
    try { await run(clock) }
    finally { for (const value of liveServices) value.close(); globalThis.setTimeout = savedSet; globalThis.clearTimeout = savedClear }
  }
  await check('native head poll owns one unreferenced timer and notifies only first observation and changed metadata', () => withClock(async (clock) => {
    const f = remoteFixture(); assert.equal(clock.timers.size, 0)
    await f.send(); f.notifications.length = 0
    assert.equal(clock.next().delay, 8000); assert.equal(clock.next().unreferenced, true)
    await f.recover(); assert.equal(clock.timers.size, 1)
    await clock.tick(); assert.deepEqual(f.notifications, [[f.context.key, null]]); assert.equal(f.headCalls.length, 1)
    await clock.tick(); assert.equal(f.notifications.length, 1)
    f.fingerprint = digest('other device edited annotation'); await clock.tick(); assert.equal(f.notifications.length, 2)
    f.context.state = 'network-unavailable'; await clock.tick(); assert.equal(f.headCalls.length, 3)
    f.context.state = 'connected'; await clock.tick(); assert.equal(f.notifications.length, 3)
    f.service.close(); assert.equal(clock.timers.size, 0)
  }))
  await check('native head poll backs off to 32 seconds and resets after successful metadata read', () => withClock(async (clock) => {
    const f = remoteFixture(); await f.send(); f.notifications.length = 0
    f.onHead = () => { throw Error('Owned head outage') }
    for (const delay of [16000, 32000, 32000]) { await clock.tick(); assert.equal(clock.next().delay, delay) }
    assert.deepEqual(f.notifications, []); f.onHead = null
    await clock.tick(); assert.equal(clock.next().delay, 8000); assert.deepEqual(f.notifications, [[f.context.key, null]])
  }))
  await check('native head poll rejects actor, project, epoch and authority changes during awaits', () => withClock(async (clock) => {
    for (const field of ['actorId', 'projectId', 'epoch', 'authorizationRevision', 'origin', 'instanceId', 'key']) {
      const f = remoteFixture(); await f.send(); f.notifications.length = 0
      f.onHead = (head) => { f.context[field] = field === 'authorizationRevision' ? 2 : randomUUID(); return head }
      await clock.tick(); assert.deepEqual(f.notifications, [], field)
      f.service.close(); assert.equal(clock.timers.size, 0)
    }
    const f = remoteFixture(); await f.send(); f.notifications.length = 0
    f.onHead = (head) => ({ ...head, epoch: randomUUID() }); await clock.tick(); assert.deepEqual(f.notifications, [])
    f.onHead = (head) => ({ ...head, projectId: randomUUID() }); await clock.tick(); assert.deepEqual(f.notifications, [])
  }))
  await check('closing during a head request suppresses notifications and does not schedule another timer', () => withClock(async (clock) => {
    const f = remoteFixture(); await f.send(); f.notifications.length = 0
    let finish
    f.onHead = (head) => new Promise((resolve) => { finish = () => resolve(head) })
    await clock.tick(); assert.equal(clock.timers.size, 0)
    await f.recover(); assert.equal(clock.timers.size, 0, 'an active poll admitted a second timer')
    f.service.close(); finish(); await clock.flush()
    assert.deepEqual(f.notifications, []); assert.equal(clock.timers.size, 0)
  }))
  await check('first head and existing baselines cannot hide another device update following an own write', () => withClock(async (clock) => {
    const f = remoteFixture()
    f.onCommand = (value) => { f.fingerprint = digest('own write'); return f.reply(value) }
    await f.send(); f.notifications.length = 0
    f.fingerprint = digest('other device after own write before initial head')
    await clock.tick(); assert.deepEqual(f.notifications, [[f.context.key, null]])
    await f.send(); f.notifications.length = 0
    f.fingerprint = digest('other device after second own write')
    await clock.tick(); assert.deepEqual(f.notifications, [[f.context.key, null]])
    await clock.tick(); assert.equal(f.notifications.length, 1)
  }))
  assert.ok(changes.length > 0)
  console.log(`creation desktop: ${passed} passed`)
} finally {
  for (const value of liveServices) value.close()
  const safe = relative(tmpdir(), root)
  assert.ok(safe && !safe.startsWith('..') && !isAbsolute(safe) && safe.startsWith('trellis-creation-desktop-'))
  await rm(root, { recursive: true, force: true })
}
