import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)
const compatPath = fileURLToPath(new URL('../src/managed-cache-compat.cjs', import.meta.url))
const cachePath = fileURLToPath(new URL('../src/managed-plugin-cache.cjs', import.meta.url))
const launcher = fileURLToPath(new URL('../src/managed-zcode-launch.cjs', import.meta.url))
const compat = require(compatPath)
const fixture = fs.readFileSync(new URL('./fixtures/managed-empty-persistence-native.cjs', import.meta.url), 'utf8')

function createHarness({ persistence = 'immediate', persisted = false, title = '', persist } = {}) {
  const events = []
  const runtime = { sessionStore: {}, sessionPersisted: persisted,
    async ensureSessionPersistedForExternalActivity(text, options) {
      events.push('persist')
      assert.equal(text, '')
      assert.equal(options.traceContext, record.traceContext)
      if (persist) return persist(runtime)
      if (!runtime.sessionPersisted) { title = 'Untitled session'; runtime.sessionPersisted = true }
    } }
  const record = { persistence, traceContext: { traceId: 'trace_fixture' }, stateRevision: 0,
    eventStore: { async deleteSession() { events.push('delete-events') } },
    unsubscribe() { events.push('unsubscribe') },
    app: { runtime, async close() { events.push('close') }, async resume() { events.push('resume') },
      async setModel() { events.push('model') }, async setThoughtLevel() { events.push('thought') } } }
  const context = { sessions: new Map() }
  const scope = { module: { exports: {} }, Ra: (_schema, value) => value, Ont: {},
    lBn: async () => record, Dj: async (_app, fn) => fn(), U5e: value => value,
    mhc: (_app, value) => value, Uhc: async () => { events.push('import') } }
  vm.runInNewContext(compat.transformEmptyPersistenceSource(fixture), scope)
  const create = (extra = {}) => scope.module.exports.zhc(context, {
    sessionId: 'sess_fixture', persistence, workspace: { workspaceKey: 'fixture', workspacePath: '/fixture' }, ...extra
  }, undefined, async () => {
    events.push('snapshot')
    return { value: { sessionId: 'sess_fixture', title, messages: [] }, messageCount: 0 }
  })
  return { events, runtime, record, context, create }
}

test('immediate persistence awaits after model/thought/import and before snapshot', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const h = createHarness({ persist: async runtime => { await gate; runtime.sessionPersisted = true } })
  const creating = h.create({ model: 'native-model', thoughtLevel: 'native-thought', importedHistory: {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.events, ['model', 'thought', 'import', 'resume', 'persist'])
  release()
  const result = await creating
  assert.equal(result.sessionId, 'sess_fixture')
  assert.deepEqual(h.events, ['model', 'thought', 'import', 'resume', 'persist', 'snapshot'])
})

test('failed persistence rejects through native cleanup without publishing a snapshot', async () => {
  const failure = new Error('write-denied')
  const h = createHarness({ persist: async () => { throw failure } })
  await assert.rejects(h.create(), error => error === failure)
  assert.equal(h.context.sessions.size, 0)
  assert.deepEqual(h.events, ['persist', 'unsubscribe', 'close', 'delete-events'])
})

test('an absent store or a silent persistence no-op cannot claim successful creation', async () => {
  const absent = createHarness()
  absent.runtime.sessionStore = undefined
  await assert.rejects(absent.create(), /requires a session store/)
  assert.ok(!absent.events.includes('persist'))
  const noop = createHarness({ persist: async () => {} })
  await assert.rejects(noop.create(), /did not complete/)
  for (const h of [absent, noop]) {
    assert.ok(!h.events.includes('snapshot'))
    assert.equal(h.context.sessions.size, 0)
  }
})

test('deferred creation retains native behavior even without a store', async () => {
  const h = createHarness({ persistence: 'deferred' })
  h.runtime.sessionStore = undefined
  const result = await h.create()
  assert.equal(result.title, '')
  assert.equal(h.runtime.sessionPersisted, false)
  assert.deepEqual(h.events, ['snapshot'])
})

test('empty input uses the native default title without a message or goal', async () => {
  const h = createHarness()
  const result = await h.create()
  assert.equal(result.title, 'Untitled session')
  assert.deepEqual(result.messages, [])
  assert.deepEqual(h.events, ['persist', 'snapshot'])
})

for (const imported of [false, true]) {
  test(`already persisted title survives immediate creation (imported=${imported})`, async () => {
    const h = createHarness({ persisted: true, title: 'User-owned title' })
    const result = await h.create(imported ? { importedHistory: {} } : {})
    assert.equal(result.title, 'User-owned title')
    assert.deepEqual(h.events, imported ? ['import', 'resume', 'persist', 'snapshot'] : ['persist', 'snapshot'])
  })
}

test('exact hash and unique persistence anchors are required', () => {
  assert.equal(compat.inspectCompatibility(Buffer.from(fixture)).supported, false)
  assert.equal(compat.transformVerifiedSource(fixture), undefined)
  assert.equal(compat.transformVerifiedSource(fixture, false, { cache: false }), undefined)
  assert.equal(compat.transformEmptyPersistenceSource(fixture.replace('async function zhc(', 'async function changed(')), undefined)
  assert.equal(compat.transformEmptyPersistenceSource(fixture + fixture), undefined)
  assert.equal(compat.transformEmptyPersistenceSource(fixture.replace('let O=Date.now(),U=await o(h)', 'let O=0,U=await o(h)')), undefined)
  assert.equal(compat.transformEmptyPersistenceSource(compat.transformEmptyPersistenceSource(fixture)), undefined)
})

test('native empty persistence leaves first real input eligible for generated titles and protects custom titles', async () => {
  const source = fs.readFileSync(new URL('./fixtures/managed-empty-persistence-title.cjs', import.meta.url), 'utf8')
  let row
  const events = []
  const updates = []
  const scope = { module: { exports: {} }, Sr: () => ({}), EOe: value => value, jwe: value => value.trim(),
    N6o: async () => {}, Jkt: async () => {}, NZ: () => ({}), NP: () => ({}), tt: { SessionTitleUpdated: 'title' } }
  vm.runInNewContext(source, scope)
  const api = scope.module.exports
  const runtime = { sessionId: 'sess_fixture', workingDirectory: '/fixture', appVersion: '0.16.9',
    config: { taskType: 'interactive', titleGeneration: { enabled: true } }, turnNumber: 0,
    sessionTitleGenerationAttempted: false, sessionPersisted: false, rootTraceContext: {},
    getSessionModelSelection: () => undefined, createEvent: (type, payload) => ({ type, payload }),
    async appendEvent(event) { events.push(event) },
    sessionStore: { async createSession(value) { row = { ...value } }, async getSession() { return row },
      async updateSession(update) {
        updates.push(update)
        if (!update.expectedTitleSources || update.expectedTitleSources.includes(row.titleSource)) row = { ...row, ...update }
        return row
      } },
    ensureSessionPersisted(text, trace) { return api.l$o.call(this, text, trace) } }
  await api.J6o.call(runtime, '', { traceContext: runtime.rootTraceContext })
  assert.equal(row.title, 'Untitled session')
  assert.equal(row.titleSource, 'first_input')
  assert.equal(runtime.sessionPersisted, true)
  assert.equal(runtime.sessionTitleGenerationAttempted, false)
  assert.equal(runtime.turnNumber, 0)
  assert.equal(api.D4a(runtime, 'A sufficiently long real first input'), true)
  assert.equal(api.D4a(runtime, ''), false)
  // Exercise only the native title writer, using an already generated title;
  // neither the fixture nor the live test sends an input/model request.
  await api.N4a.call(runtime, { messageID: 'message_first', title: 'Native generated title', traceContext: {} })
  assert.equal(row.title, 'Native generated title')
  assert.equal(row.titleSource, 'generated')
  assert.ok(updates[0].expectedTitleSources.includes('first_input'))
  assert.equal(events[0].payload.title, 'Untitled session')
  assert.equal(events[1].payload.previousTitle, 'Untitled session')
  row = { ...row, title: 'Imported or user title', titleSource: 'custom' }
  await api.N4a.call(runtime, { messageID: 'message_next', title: 'Must not overwrite', traceContext: {} })
  await api.J6o.call(runtime, '', { traceContext: {} })
  assert.equal(row.title, 'Imported or user title')
  assert.equal(row.titleSource, 'custom')
  assert.equal(updates.length, 1)
  assert.equal(events.length, 2)
})

test('unknown source with matching persistence anchors executes completely unmodified', async t => {
  const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-empty-unknown-')))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const filename = path.join(temporary, 'native.cjs')
  fs.writeFileSync(filename, fixture)
  const cacheDir = path.join(temporary, 'cache')
  const code = `const o=JSON.parse(process.argv[1]),api=require(o.launcher).launch([o.filename,'app-server']);process.stdout.write(JSON.stringify({source:api.zhc.toString(),argv:process.argv.slice(1),filename:process.mainModule.filename}));`
  const result = await promisify(execFile)(process.execPath, ['-e', code, JSON.stringify({ filename, launcher })],
    { env: { ...process.env, TRELLIS_ZCODE_STARTUP_CACHE_DIR: cacheDir }, cwd: temporary, windowsHide: true, timeout: 10_000 })
  const value = JSON.parse(result.stdout)
  const scope = { module: { exports: {} } }
  vm.runInNewContext(fixture, scope)
  assert.equal(value.source, scope.module.exports.zhc.toString())
  assert.deepEqual(value.argv, [filename, 'app-server'])
  assert.equal(value.filename, filename)
  assert.equal(result.stderr, '')
  assert.equal(fs.existsSync(cacheDir), false)
  assert.equal(fs.readFileSync(filename, 'utf8'), fixture)
})

for (const damage of ['no-cache-dir', 'missing-cache-module', 'cache-construction-failed', 'trusted-assets-unavailable']) {
  test(`launcher retains correctness-only source and native assets with ${damage}`, async t => {
    const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-empty-launch-')))
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
    const filename = path.join(temporary, 'native.cjs')
    fs.writeFileSync(filename, fixture)
    // Only this child admits a fixture. Production keeps its closed hash check.
    const code = `const o=JSON.parse(process.argv[1]),c=require(o.compatPath);c.inspectCompatibility=()=>({hash:c.CLI_SHA256,supported:true});c.transformVerifiedSource=(s,p,opts)=>{if(p)throw new Error('prepare must not execute');if(opts?.cache!==false)throw new Error('cache must not transform');return c.transformEmptyPersistenceSource(s)};const M=require('node:module'),load=M._load;M._load=function(id,...args){if(id==='./managed-plugin-cache.cjs'&&o.damage==='missing-cache-module')throw new Error('missing');return load.call(this,id,...args)};if(o.damage!=='missing-cache-module')require.cache[o.cachePath]={exports:{createManagedPluginCache(){if(o.damage==='cache-construction-failed')throw new Error('private-error');return {trustedAssetsAvailable:false}}}};const api=require(o.launcher).launch([o.filename,'app-server']);process.stdout.write(JSON.stringify({corrected:api.zhc.toString().includes('ensureSessionPersistedForExternalActivity'),nativeAssets:!api.zhc.toString().includes('__trellisCache'),main:process.mainModule.filename===o.filename}));`
    const env = { ...process.env }
    delete env.TRELLIS_ZCODE_STARTUP_CACHE_DIR
    if (damage !== 'no-cache-dir') env.TRELLIS_ZCODE_STARTUP_CACHE_DIR = path.join(temporary, 'cache')
    const result = await promisify(execFile)(process.execPath, ['-e', code, JSON.stringify({ damage, filename, compatPath, cachePath, launcher })],
      { env, cwd: temporary, windowsHide: true, timeout: 10_000 })
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), { corrected: true, nativeAssets: true, main: true })
    assert.equal(fs.readFileSync(filename, 'utf8'), fixture)
  })
}
