// Behavioral regressions for the exact patched public runtime; no vendor/model requests.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAcpxCompatibility } from '../check-acpx-compat.mjs'
import { spawnSync } from 'node:child_process'

if (process.argv.includes('--assert-clean-stdio')) {
  const child = spawnSync(process.execPath, process.argv.slice(1).filter(argument => argument !== '--assert-clean-stdio'), { encoding: 'utf8', windowsHide: true, timeout: 120000 })
  assert.equal(child.status, 0, child.stderr || child.stdout)
  assert.ok(!`${child.stdout}${child.stderr}`.includes('SECRET-FIXTURE'), 'SDK rejection must not print the rejected raw credential fixture')
  process.stdout.write(child.stdout)
  console.log('PASS unknown diagnostic stdio contains no credential sentinel')
  process.exit(0)
}

await checkAcpxCompatibility()
const runRoot = mkdtempSync(join(tmpdir(), 'trellis-acpx-runtime-'))
const safeEnvironment = {}
for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATH', 'Path', 'PATHEXT']) {
  if (process.env[key] !== undefined) safeEnvironment[key] = process.env[key]
}
for (const [key, leaf] of Object.entries({ HOME: 'home', USERPROFILE: 'home', LOCALAPPDATA: 'local', APPDATA: 'roaming', TEMP: 'tmp', TMP: 'tmp' })) {
  safeEnvironment[key] = join(runRoot, leaf)
  mkdirSync(safeEnvironment[key], { recursive: true })
}
process.env = safeEnvironment
const { createAcpRuntime, createFileSessionStore, TRELLIS_ACPX_COMPAT_VERSION } = await import('acpx/runtime')
const { createAgentRegistry } = await import('acpx/agent-registry')
assert.equal(TRELLIS_ACPX_COMPAT_VERSION, 2)
const peerPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/acpx-strict-peer.mjs')
const livePids = new Set()
const observations = []
const fixtures = new Set()
const only = process.argv.find(argument => argument.startsWith('--only='))?.slice(7)
let sequence = 0
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function bounded(promise, label, milliseconds = 25000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
async function until(predicate, label) {
  const deadline = Date.now() + 25000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Deadline: ${label}`)
    await pause(10)
  }
}
function readWire(directory) {
  const file = join(directory, 'peer-wire.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
function readState(directory) { return JSON.parse(readFileSync(join(directory, 'peer-state.json'), 'utf8')) }
function writeState(directory, changes) {
  writeFileSync(join(directory, 'peer-state.json'), JSON.stringify({ ...readState(directory), ...changes }))
}
function makeFixture(name, scenario = 'normal', options = {}) {
  const directory = join(runRoot, name)
  mkdirSync(directory, { recursive: true })
  const store = createFileSessionStore({ stateDir: join(directory, 'runtime-store') })
  const exits = []
  const pids = []
  const runtime = createAcpRuntime({
    cwd: directory, sessionStore: store,
    agentRegistry: createAgentRegistry({ overrides: { 'strict-peer': [process.execPath, peerPath, directory, scenario] } }),
    permissionMode: 'deny-all', nonInteractivePermissions: 'deny', timeoutMs: 15000,
    fs: false, terminal: false, ...options,
    processLifecycle: {
      onBeforeSpawn(info) {
        assert.equal(resolve(info.command), resolve(process.execPath))
        assert.ok(info.args.includes(peerPath), 'Only the owned peer may launch')
      },
      onSpawned(info) { livePids.add(info.pid); pids.push(info.pid) },
      onExit(info) { livePids.delete(info.pid); exits.push(info.pid) }
    }
  })
  const fixture = { runtime, store, directory, pids, exits,
    ensure: (input = {}) => bounded(runtime.ensureSession({ sessionKey: name, agent: 'strict-peer', mode: 'persistent', ...input }), `ensure ${name}`),
    async close() {
      await bounded(runtime.shutdown(), `shutdown ${name}`)
      fixtures.delete(fixture)
      await until(() => pids.every(pid => exits.includes(pid)), `process exit ${name}`)
      assert.ok(pids.every(pid => !livePids.has(pid)))
    }
  }
  fixtures.add(fixture)
  return fixture
}
function watchTurn(fixture, handle, text, options = {}) {
  const turn = fixture.runtime.startTurn({ handle, text, requestId: `patched-${++sequence}`, mode: 'prompt', ...options })
  const admission = turn.promptStarted.then(() => true, () => false)
  const events = []
  const stream = (async () => { for await (const event of turn.events) events.push(event) })()
  return { turn, events, result: bounded(Promise.all([turn.result, stream, admission]).then(([result]) => ({ result, events })), `turn ${text}`) }
}
const runTurn = (fixture, handle, text, options) => watchTurn(fixture, handle, text, options).result
const textOf = events => events.filter(event => event.type === 'text_delta').map(event => event.text).join('')
const permissionAnswers = fixture => readWire(fixture.directory).filter(entry => entry.kind === 'permission-answer')
async function check(name, work) {
  if (only && !name.includes(only)) return
  try { await work(); observations.push({ name, status: 'passed' }); console.log(`PASS ${name}`) }
  catch (error) { observations.push({ name, status: 'failed', error: error.stack }); console.error(`FAIL ${name}: ${error.stack}`) }
  finally { for (const fixture of [...fixtures]) await fixture.close() }
}

const watchdog = setTimeout(() => {
  for (const pid of livePids) { try { process.kill(pid) } catch {} }
  console.error(`Fixture watchdog; owned evidence: ${runRoot}`)
  process.exit(2)
}, 480000)

try {
  for (const scenario of ['malformed-init', 'wrong-version', 'missing-init-version', 'malformed-capabilities']) {
    await check(`reject ${scenario} before session/new and clean process`, async () => {
      const fixture = makeFixture(scenario, scenario)
      await assert.rejects(fixture.ensure(), /initialize.*malformed|unsupported protocol/i)
      const requests = readWire(fixture.directory).filter(entry => entry.kind === 'in')
      assert.ok(!requests.some(entry => entry.message.method === 'session/new'))
      assert.equal(await fixture.store.load(scenario), undefined)
    })
  }
  for (const scenario of ['missing-new-id', 'empty-new-id']) {
    await check(`reject ${scenario} before readiness`, async () => {
      const fixture = makeFixture(scenario, scenario)
      await assert.rejects(fixture.ensure(), /non-empty sessionId/)
      assert.equal(await fixture.store.load(scenario), undefined)
      assert.ok(!readWire(fixture.directory).some(entry => entry.message?.method === 'session/prompt'))
    })
  }
  await check('owned remote identity, coherent turns, split Unicode and tool patches', async () => {
    const fixture = makeFixture('normal')
    const handle = await fixture.ensure()
    assert.notEqual(handle.acpxRecordId, handle.backendSessionId)
    const first = await runTurn(fixture, handle, 'first turn')
    const second = await runTurn(fixture, handle, 'second turn')
    assert.equal(first.result.status, 'completed')
    assert.equal(second.result.status, 'completed')
    assert.ok(textOf(first.events).includes('你好，协议✅'))
    assert.ok(!textOf(first.events).includes('\uFFFD'))
    const patch = first.events.find(event => event.type === 'tool_call' && event.tag === 'tool_call_update')
    assert.equal(patch?.toolCallId, 'fixed-tool')
    assert.equal(patch?.status, 'completed')
    assert.deepEqual(patch?.rawOutput, { fixture: true })
    const prompts = readWire(fixture.directory).filter(entry => entry.kind === 'in' && entry.message.method === 'session/prompt')
    assert.equal(prompts.length, 2)
    assert.ok(prompts.every(entry => entry.message.params.sessionId === handle.backendSessionId))
  })
  await check('configuration and model acknowledgement retain rejected effective values', async () => {
    const fixture = makeFixture('config')
    const handle = await fixture.ensure()
    await fixture.runtime.setMode({ handle, mode: 'edit' })
    await fixture.runtime.setModel({ handle, model: 'large' })
    const reply = await fixture.runtime.setConfigOption({ handle, key: 'quality', value: 'careful' })
    assert.equal(reply.configOptions[0].currentValue, 'careful')
    await assert.rejects(fixture.runtime.setConfigOption({ handle, key: 'quality', value: 'invalid' }))
    assert.equal(readState(fixture.directory).quality, 'careful')
    assert.equal((await fixture.runtime.getStatus({ handle })).models.currentModelId, 'large')
  })
  await check('unknown structured updates stay passive, bounded, redacted and owned', async () => {
    const fixture = makeFixture('unknown-events')
    const handle = await fixture.ensure()
    const watched = watchTurn(fixture, handle, 'unknown-events')
    let settled = false
    void watched.result.then(() => { settled = true })
    await until(() => watched.events.some(event => event.type === 'status' && event.rawUpdate), 'unknown diagnostic observed')
    assert.equal(settled, false, 'An update claiming completed must not settle the actual turn')
    const output = await watched.result
    const diagnostics = output.events.filter(event => event.type === 'status' && event.rawUpdate)
    assert.equal(output.result.status, 'completed')
    assert.ok(diagnostics.some(event => event.tag === 'notice'))
    assert.ok(diagnostics.some(event => event.tag === 'fixture_future_update'))
    assert.ok(diagnostics.every(event => !['done', 'error'].includes(event.type)))
    const text = JSON.stringify(diagnostics)
    assert.ok(text.includes('inspectable'))
    assert.ok(text.includes('[REDACTED]'))
    assert.ok(!text.includes('SECRET-FIXTURE'))
    assert.ok(!text.includes('FOREIGN-UNKNOWN'))
    assert.ok(diagnostics.every(event => Buffer.byteLength(JSON.stringify(event)) <= 10000))
    assert.ok(diagnostics.find(event => event.tag === 'fixture_future_update').text.includes('SDK'))
    assert.equal(diagnostics.find(event => event.tag === 'fixture_future_update').payloadUnavailable, true)
    assert.ok(diagnostics.some(event => event.tag === 'done' && event.type === 'status'))
    assert.ok(diagnostics.some(event => event.tag === 'error' && event.type === 'status'))
    assert.ok(diagnostics.find(event => event.tag === 'notice').rawUpdateTruncated)
  })
  await check('unknown early and suppressed replay updates retain ownership and stay passive', async () => {
    let fixture = makeFixture('unknown-replay', 'early-unknown')
    const handle = await fixture.ensure()
    const initial = JSON.stringify(await fixture.store.load('unknown-replay'))
    assert.ok(initial.includes('EARLY-NEW-0'))
    assert.ok(!initial.includes('FOREIGN'))
    await fixture.close()
    writeState(fixture.directory, { replayUnknownOnLoad: true })
    fixture = makeFixture('unknown-replay', 'early-unknown')
    const restored = await fixture.ensure()
    const output = await runTurn(fixture, restored, 'after unknown replay')
    assert.equal(output.result.status, 'completed')
    assert.ok(!output.events.some(event => event.rawUpdate))
    assert.ok(!JSON.stringify(output.events).includes('FOREIGN'))
    assert.equal(restored.backendSessionId, handle.backendSessionId)
    assert.equal(readState(fixture.directory).newCount, 1)
  })
  await check('public display metadata and advertised modes survive store clone and native load', async () => {
    let fixture = makeFixture('metadata')
    const handle = await fixture.ensure()
    const first = await fixture.store.load('metadata')
    assert.deepEqual(first.agentInfo, { name: 'independent-strict-peer', version: '1.0.0', title: 'Fixture Agent' })
    assert.deepEqual(first.authMethods, [{ id: 'fixture-login', name: 'Fixture login', description: 'Authenticate externally' }])
    assert.deepEqual(first.acpx.available_modes, [{ id: 'safe', name: 'Safe', description: 'Read safely' }, { id: 'edit', name: 'Edit' }])
    assert.equal(first.acpx.current_mode_id, 'safe')
    assert.ok(!JSON.stringify(first).includes('DO-NOT-PERSIST'))
    await fixture.runtime.setMode({ handle, mode: 'edit' })
    await runTurn(fixture, handle, 'retain modes through state cloning')
    await fixture.close()
    const afterTurn = await fixture.store.load('metadata')
    assert.equal(afterTurn.acpx.current_mode_id, 'edit')
    assert.deepEqual(afterTurn.acpx.available_modes, first.acpx.available_modes)
    assert.deepEqual(afterTurn.agentInfo, first.agentInfo)
    writeState(fixture.directory, { modeLabelSuffix: ' restored' })
    fixture = makeFixture('metadata')
    const loaded = await fixture.ensure({ sessionKey: 'metadata-loaded', resumeSessionId: handle.backendSessionId })
    assert.equal(loaded.backendSessionId, handle.backendSessionId)
    const afterLoad = await fixture.store.load('metadata-loaded')
    assert.equal(afterLoad.acpx.available_modes[0].name, 'Safe restored')
    assert.equal(afterLoad.acpx.current_mode_id, 'edit')
    assert.deepEqual(afterLoad.authMethods, first.authMethods)
    assert.deepEqual(afterLoad.agentInfo, first.agentInfo)
    assert.ok(!JSON.stringify(afterLoad).includes('DO-NOT-PERSIST'))
  })
  await check('all four kind decisions retain original upstream IDs', async () => {
    const fixture = makeFixture('kinds')
    const handle = await fixture.ensure()
    for (const kind of ['allow_once', 'allow_always', 'reject_once', 'reject_always']) {
      const before = readState(fixture.directory).appliedActions
      const output = await runTurn(fixture, handle, `permission:${kind}`, { onPermissionRequest: async request => {
        assert.equal(request.raw.options.length, 4)
        return { outcome: kind }
      } })
      assert.equal(output.result.status, 'completed')
      assert.equal(permissionAnswers(fixture).at(-1).response.outcome.optionId, `opaque-${kind.replace('_', '-')}`)
      assert.equal(readState(fixture.directory).appliedActions, before + Number(kind.startsWith('allow')))
    }
  })
  await check('same-kind exact second selection and exact reject selection', async () => {
    const fixture = makeFixture('exact')
    const handle = await fixture.ensure()
    for (const optionId of ['opaque-second-once', 'opaque-deny']) {
      const before = readState(fixture.directory).appliedActions
      const output = await runTurn(fixture, handle, 'permission:duplicate', {
        onPermissionRequest: async request => {
          assert.ok(request.raw.options.some(option => option.optionId === optionId))
          return { outcome: 'selected', optionId }
        }
      })
      assert.equal(output.result.status, 'completed')
      assert.equal(permissionAnswers(fixture).at(-1).response.outcome.optionId, optionId)
      assert.equal(readState(fixture.directory).appliedActions, before + Number(optionId === 'opaque-second-once'))
    }
  })
  await check('invalid exact decisions fail closed even with approve-all mode', async () => {
    const fixture = makeFixture('invalid-choice', 'normal', { permissionMode: 'approve-all' })
    const handle = await fixture.ensure()
    for (const decision of [{ outcome: 'selected', optionId: 'not-offered' }, { outcome: 'selected', optionId: '' }, { outcome: 'selected' }, { outcome: 'unknown-kind' }]) {
      const output = await runTurn(fixture, handle, 'permission:duplicate', { onPermissionRequest: async () => decision })
      assert.equal(output.result.status, 'completed')
      assert.equal(permissionAnswers(fixture).at(-1).response.outcome.outcome, 'cancelled')
    }
    assert.equal(readState(fixture.directory).appliedActions, 0)
  })
  await check('foreign text/tool/approval never project or invoke host handler', async () => {
    let callbacks = 0
    const fixture = makeFixture('foreign')
    const handle = await fixture.ensure()
    const output = await runTurn(fixture, handle, 'foreign-traffic', {
      onPermissionRequest: async () => { callbacks += 1; return { outcome: 'allow_once' } }
    })
    await until(() => readWire(fixture.directory).some(entry => entry.kind === 'foreign-answer'), 'foreign cancelled reply')
    const response = readWire(fixture.directory).find(entry => entry.kind === 'foreign-answer').response
    assert.equal(response.outcome.outcome, 'cancelled')
    assert.equal(callbacks, 0)
    assert.ok(!JSON.stringify(output.events).includes('WRONG-SESSION-MARKER'))
    assert.ok(!JSON.stringify(output.events).includes('FOREIGN-TOOL'))
    await fixture.close()
    assert.ok(!JSON.stringify(await fixture.store.load('foreign')).includes('WRONG-SESSION-MARKER'))
  })
  await check('legitimate pre-new updates buffer until authoritative ID, foreign early traffic drops', async () => {
    const fixture = makeFixture('early', 'early-new')
    await fixture.ensure()
    const record = JSON.stringify(await fixture.store.load('early'))
    assert.ok(record.includes('EARLY-NEW-0'))
    assert.ok(record.indexOf('EARLY-NEW-0') < record.indexOf('EARLY-NEW-1'))
    assert.ok(record.indexOf('EARLY-NEW-1') < record.indexOf('AFTER-NEW-RESPONSE'))
    assert.ok(record.includes('early-tool'))
    assert.ok(!record.includes('FOREIGN-EARLY'))
  })
  await check('foreign filesystem and terminal callbacks cannot act in approve-all mode', async () => {
    const fixture = makeFixture('foreign-clients', 'normal', { fs: true, terminal: true, permissionMode: 'approve-all' })
    const handle = await fixture.ensure()
    const output = await runTurn(fixture, handle, 'foreign-client-requests')
    assert.equal(output.result.status, 'completed')
    await until(() => readWire(fixture.directory).filter(entry => entry.kind === 'foreign-client-answer').length === 3, 'foreign callbacks rejected')
    const responses = readWire(fixture.directory).filter(entry => entry.kind === 'foreign-client-answer')
    assert.ok(responses.every(entry => entry.response.code === -32800))
    assert.equal(existsSync(join(fixture.directory, 'foreign-write.txt')), false)
    assert.ok(!output.events.some(event => event.type === 'client_operation' && event.status === 'completed'))
  })
  await check('bounded early admission rejects an overflowing stream', async () => {
    for (const scenario of ['early-overflow', 'early-bytes']) {
      const fixture = makeFixture(scenario, scenario)
      await assert.rejects(fixture.ensure(), /bounded admission buffer/)
      assert.equal(await fixture.store.load(scenario), undefined)
      await fixture.close()
    }
  })
  await check('pre-response native load and resume replay are retained only for owned ID', async () => {
    for (const scenario of ['normal', 'early-resume']) {
      const fixture = makeFixture(`replay-${scenario}`, scenario)
      const original = await fixture.ensure()
      await fixture.close()
      writeState(fixture.directory, { replayOnLoad: true })
      const restoredFixture = makeFixture(`replay-${scenario}`, scenario)
      const restored = await restoredFixture.ensure({ sessionKey: `loaded-${scenario}`, resumeSessionId: original.backendSessionId })
      assert.equal(restored.backendSessionId, original.backendSessionId)
      const record = JSON.stringify(await restoredFixture.store.load(`loaded-${scenario}`))
      assert.ok(record.includes('REPLAY-BEFORE-RESPONSE'))
      assert.ok(record.includes('replay-tool'))
      assert.ok(!record.includes('FOREIGN-REPLAY'))
      assert.equal(readState(fixture.directory).newCount, 1)
      await restoredFixture.close()
    }
  })
  await check('restart same stored session suppresses replay, failed load creates no replacement', async () => {
    let fixture = makeFixture('restart')
    const handle = await fixture.ensure()
    await runTurn(fixture, handle, 'before restart')
    await fixture.close()
    writeState(fixture.directory, { replayOnLoad: true })
    fixture = makeFixture('restart')
    const restored = await fixture.ensure()
    const output = await runTurn(fixture, restored, 'after restart')
    assert.equal(output.result.status, 'completed')
    assert.ok(!JSON.stringify(output.events).includes('REPLAY-BEFORE-RESPONSE'))
    assert.equal(readState(fixture.directory).newCount, 1)
    await fixture.close()
    writeState(fixture.directory, { failLoad: true })
    fixture = makeFixture('restart')
    const failedHandle = await fixture.ensure()
    const failed = await runTurn(fixture, failedHandle, 'must not replay')
    assert.equal(failed.result.status, 'failed')
    assert.equal(readState(fixture.directory).newCount, 1)
    assert.equal(readState(fixture.directory).turnCount, 2)
  })
  await check('failed pre-response explicit load drops buffered replay and creates no record', async () => {
    const first = makeFixture('failed-explicit')
    const handle = await first.ensure()
    await first.close()
    writeState(first.directory, { replayOnLoad: true, failLoad: true })
    const fixture = makeFixture('failed-explicit')
    await assert.rejects(fixture.ensure({ sessionKey: 'rejected-load', resumeSessionId: handle.backendSessionId }))
    assert.equal(await fixture.store.load('rejected-load'), undefined)
    assert.equal(readState(first.directory).newCount, 1)
  })
  await check('permission cancellation aborts callback, settles once and permits a later turn', async () => {
    const fixture = makeFixture('cancel-permission')
    const handle = await fixture.ensure()
    let entered = false
    let aborted = 0
    const watch = watchTurn(fixture, handle, 'permission:pending', { onPermissionRequest: (_request, context) => new Promise(resolve => {
      entered = true
      context.signal.addEventListener('abort', () => { aborted += 1; resolve({ outcome: 'cancel' }) }, { once: true })
    }) })
    await until(() => entered, 'permission callback')
    await watch.turn.cancel()
    const output = await watch.result
    assert.equal(output.result.status, 'cancelled')
    assert.equal(aborted, 1)
    assert.equal(permissionAnswers(fixture).at(-1).response.outcome.outcome, 'cancelled')
    assert.equal((await runTurn(fixture, handle, 'usable after cancel')).result.status, 'completed')
  })
  await check('cancelled turn ignores updates while cancelling and closed admission cannot become ready', async () => {
    const fixture = makeFixture('cancel-late')
    const handle = await fixture.ensure()
    const watch = watchTurn(fixture, handle, 'cancel-late')
    await until(() => textOf(watch.events).includes('TURN-STARTED'), 'turn started')
    await watch.turn.cancel()
    const output = await watch.result
    assert.equal(output.result.status, 'cancelled')
    assert.ok(!textOf(output.events).includes('CANCELLED-LATE-UPDATE'))
    const pending = makeFixture('closed-admission', 'hang-new')
    const result = pending.ensure().then(() => ({ ready: true }), error => ({ error: error.message }))
    await until(() => readWire(pending.directory).some(entry => entry.message?.method === 'session/new'), 'new pending')
    await pending.close()
    assert.equal((await result).ready, undefined)
    assert.equal(await pending.store.load('closed-admission'), undefined)
  })
} finally {
  for (const fixture of [...fixtures]) await fixture.close()
  clearTimeout(watchdog)
  assert.equal(livePids.size, 0, 'Every owned fixture process must exit')
  writeFileSync(join(runRoot, 'results.json'), JSON.stringify({ acpx: '0.19.5', compatVersion: 2, node: process.version, observations }, null, 2))
  console.log(`EVIDENCE ${join(runRoot, 'results.json')}`)
}
process.exitCode = observations.some(observation => observation.status === 'failed') ? 1 : 0
