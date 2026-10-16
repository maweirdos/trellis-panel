// Clean-room public API experiment; no product/upstream changes or vendor calls.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ownRoot = dirname(fileURLToPath(import.meta.url))
const runRoot = join(ownRoot, 'runs', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(runRoot, { recursive: true })
const launchEnv = {}
for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATH', 'Path', 'PATHEXT']) {
  if (process.env[key] !== undefined) launchEnv[key] = process.env[key]
}
for (const [key, leaf] of Object.entries({ HOME: 'home', USERPROFILE: 'home', LOCALAPPDATA: 'local', APPDATA: 'roaming', TEMP: 'tmp', TMP: 'tmp' })) {
  launchEnv[key] = join(runRoot, leaf)
  mkdirSync(launchEnv[key], { recursive: true })
}
process.env = launchEnv
const packageArgument = process.argv[2]?.startsWith('--') ? undefined : process.argv[2]
const onlyArgument = process.argv.find(argument => argument.startsWith('--only='))
const only = onlyArgument ? new Set(onlyArgument.slice('--only='.length).split(',')) : null
const packageRoot = resolve(packageArgument ?? 'C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a143cf-354c-7ce0-a351-45db825fc514/acpx-validation/node_modules/acpx')
const packageMetadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
assert.equal(packageMetadata.version, '0.19.5')
const { createAcpRuntime, createFileSessionStore } = await import(pathToFileURL(join(packageRoot, 'dist/runtime.js')).href)
const { createAgentRegistry } = await import(pathToFileURL(join(packageRoot, 'dist/agent-registry.js')).href)
const peerPath = join(ownRoot, 'strict-peer.mjs')
const observations = []
const launches = []
const livePids = new Set()
let runtime = null
let requestSequence = 0

async function bounded(promise, label, milliseconds = 10000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Research deadline: ${label}`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
function record(name, status, detail) {
  observations.push({ name, status, detail })
  console.log(`${status.toUpperCase()} ${name}: ${JSON.stringify(detail)}`)
}
function readState(directory) { return JSON.parse(readFileSync(join(directory, 'peer-state.json'), 'utf8')) }
function wire(directory) {
  const path = join(directory, 'peer-wire.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
function makeRuntime(name, scenario = 'normal') {
  const directory = join(runRoot, name)
  mkdirSync(directory, { recursive: true })
  const registry = createAgentRegistry({ overrides: { 'research-peer': [process.execPath, peerPath, directory, scenario] } })
  const store = createFileSessionStore({ stateDir: join(directory, 'runtime-store') })
  const value = createAcpRuntime({
    cwd: directory, agentRegistry: registry, sessionStore: store, permissionMode: 'deny-all',
    nonInteractivePermissions: 'deny', timeoutMs: 4000, fs: false, terminal: false,
    processLifecycle: {
      onBeforeSpawn(launch) {
        assert.equal(resolve(launch.command), resolve(process.execPath), 'Only controlled Node executable may launch')
        assert.ok(launch.args.includes(peerPath), 'Only owned strict peer may launch')
      },
      onSpawned(launch) { launches.push({ phase: 'spawned', ...launch }); livePids.add(launch.pid) },
      onExit(launch) { launches.push({ phase: 'exit', ...launch }); livePids.delete(launch.pid) }
    }
  })
  return { value, directory, registry }
}
async function stop() {
  if (!runtime) return
  const current = runtime
  runtime = null
  await bounded(current.shutdown(), 'runtime shutdown', 12000)
}
async function runTurn(handle, text, options = {}) {
  const turn = runtime.startTurn({ handle, text, mode: 'prompt', requestId: `research-${++requestSequence}`, ...options })
  // Subscribe to both channels immediately, including expected rejection paths.
  const started = turn.promptStarted.then(() => ({ accepted: true }), error => ({ accepted: false, message: error.message }))
  const eventsTask = (async () => { const events = []; for await (const event of turn.events) events.push(event); return events })()
  const resultTask = turn.result
  const [result, events, admission] = await bounded(Promise.all([resultTask, eventsTask, started]), `turn ${text}`)
  return { result, events, admission }
}
async function check(name, work) {
  if (only && !only.has(name)) return
  try { await work() }
  catch (error) { record(name, 'failed', { message: error.message, stack: error.stack?.split('\n').slice(0, 5) }) }
}

const watchdog = setTimeout(() => {
  for (const pid of livePids) { try { process.kill(pid) } catch {} }
  writeFileSync(join(runRoot, 'watchdog.json'), JSON.stringify({ observations, launches, livePids: [...livePids] }, null, 2))
  console.error('Research watchdog stopped only recorded fixture PIDs')
  process.exit(2)
}, 120000)

try {
  let fixture = makeRuntime('normal')
  runtime = fixture.value
  const handle = await bounded(runtime.ensureSession({ sessionKey: 'research-conversation', agent: 'research-peer', mode: 'persistent' }), 'ensure normal')
  writeFileSync(join(runRoot, 'handle-initial.json'), JSON.stringify(handle, null, 2))
  let first
  await check('remote identity and two turns', async () => {
    first = await runTurn(handle, 'first fixture turn')
    const second = await runTurn(handle, 'second fixture turn')
    assert.equal(first.result.status, 'completed')
    assert.equal(second.result.status, 'completed')
    const requests = wire(fixture.directory).filter(entry => entry.kind === 'in' && entry.message.method === 'session/prompt')
    assert.equal(requests.length, 2)
    assert.ok(requests.every(entry => entry.message.params.sessionId === readState(fixture.directory).remoteId))
    assert.notEqual(handle.acpxRecordId, handle.backendSessionId)
    record('remote identity and two turns', 'passed', { handle, promptSessionIds: requests.map(entry => entry.message.params.sessionId), results: [first.result, second.result] })
  })
  await check('split Unicode and tool patch', async () => {
    assert.ok(first, 'first turn must have returned')
    const text = first.events.filter(event => event.type === 'text_delta').map(event => event.text).join('')
    assert.ok(text.includes('你好，协议✅'))
    assert.ok(!text.includes('\uFFFD'))
    const patch = first.events.find(event => event.type === 'tool_call' && event.tag === 'tool_call_update')
    assert.equal(patch?.toolCallId, 'fixed-tool')
    assert.equal(patch?.status, 'completed')
    assert.deepEqual(patch?.rawOutput, { fixture: true })
    assert.ok(patch?.content?.length)
    record('split Unicode and tool patch', 'passed', { text, patch })
  })
  await check('acknowledged model mode and config', async () => {
    await bounded(runtime.setMode({ handle, mode: 'edit' }), 'set mode')
    await bounded(runtime.setModel({ handle, model: 'large' }), 'set model')
    const reply = await bounded(runtime.setConfigOption({ handle, key: 'quality', value: 'careful' }), 'set config')
    assert.equal(readState(fixture.directory).currentMode, 'edit')
    assert.equal(readState(fixture.directory).currentModel, 'large')
    assert.equal(reply.configOptions[0].currentValue, 'careful')
    await assert.rejects(bounded(runtime.setConfigOption({ handle, key: 'quality', value: 'invalid' }), 'reject config'))
    assert.equal(readState(fixture.directory).quality, 'careful')
    const status = await runtime.getStatus({ handle })
    assert.equal(status.models.currentModelId, 'large')
    record('acknowledged model mode and config', 'passed', { state: readState(fixture.directory), status, reply })
  })
  await check('all four permission kinds and original IDs', async () => {
    const observed = []
    for (const kind of ['allow_once', 'allow_always', 'reject_once', 'reject_always']) {
      const before = readState(fixture.directory).appliedActions
      const output = await runTurn(handle, `permission:${kind}`, { onPermissionRequest: async request => {
        observed.push({ kind, rawOptions: request.raw.options })
        return { outcome: kind }
      } })
      assert.equal(output.result.status, 'completed')
      const response = wire(fixture.directory).filter(entry => entry.kind === 'permission-answer').at(-1).response
      assert.equal(response.outcome.optionId, `opaque-${kind.replace('_', '-')}`)
      assert.equal(readState(fixture.directory).appliedActions, before + (kind.startsWith('allow') ? 1 : 0))
    }
    record('all four permission kinds and original IDs', 'passed', observed)
  })
  await check('duplicate-kind option limitation', async () => {
    let desiredId
    const output = await runTurn(handle, 'permission:duplicate', { onPermissionRequest: async request => {
      desiredId = request.raw.options[1].optionId
      return { outcome: 'allow_once' }
    } })
    assert.equal(output.result.status, 'completed')
    const selectedId = wire(fixture.directory).filter(entry => entry.kind === 'permission-answer').at(-1).response.outcome.optionId
    assert.equal(desiredId, 'opaque-second-once')
    assert.equal(selectedId, 'opaque-first-once')
    record('duplicate-kind option limitation', 'limitation', { desiredId, selectedId, contract: 'Public handler chooses a kind; no original optionId field is supported' })
  })
  await check('cancel while permission pending', async () => {
    let callbackEntered
    const entered = new Promise(resolve => { callbackEntered = resolve })
    let signalAborted = false
    const turn = runtime.startTurn({ handle, text: 'permission:pending', mode: 'prompt', requestId: `research-${++requestSequence}`,
      onPermissionRequest: (_request, context) => new Promise(resolve => {
        callbackEntered()
        context.signal.addEventListener('abort', () => { signalAborted = true; resolve({ outcome: 'cancel' }) }, { once: true })
      }) })
    const admission = turn.promptStarted.catch(error => ({ error: error.message }))
    const events = (async () => { const values = []; for await (const event of turn.events) values.push(event); return values })()
    const result = turn.result
    await bounded(entered, 'permission entered')
    await bounded(turn.cancel({ reason: 'controlled permission cancellation' }), 'cancel permission')
    const settled = await bounded(result, 'cancel result')
    await bounded(Promise.all([events, admission]), 'cancel events drain')
    const response = wire(fixture.directory).filter(entry => entry.kind === 'permission-answer').at(-1).response
    assert.equal(signalAborted, true)
    assert.equal(response.outcome.outcome, 'cancelled')
    assert.equal(settled.status, 'cancelled')
    record('cancel while permission pending', 'passed', { response, result: settled, signalAborted })
  })
  await check('foreign session update filtering', async () => {
    const output = await runTurn(handle, 'foreign-update')
    const text = output.events.filter(event => event.type === 'text_delta').map(event => event.text).join('')
    if (text.includes('WRONG-SESSION-MARKER')) record('foreign session update filtering', 'failed', { text, reason: 'Foreign notification projected into active turn; public normalized event has no sessionId to gate afterward' })
    else record('foreign session update filtering', 'passed', { text })
  })
  await stop()
  await check('same-session store restart', async () => {
    const old = readState(fixture.directory)
    fixture = makeRuntime('normal')
    runtime = fixture.value
    const restored = await bounded(runtime.ensureSession({ sessionKey: 'research-conversation', agent: 'research-peer', mode: 'persistent' }), 'restore handle')
    const output = await runTurn(restored, 'restored fixture turn')
    assert.equal(output.result.status, 'completed')
    assert.equal(restored.backendSessionId, handle.backendSessionId)
    const after = readState(fixture.directory)
    assert.equal(after.newCount, 1)
    assert.equal(after.turnCount, old.turnCount + 1)
    const load = wire(fixture.directory).find(entry => entry.kind === 'in' && entry.message.method === 'session/load')
    assert.equal(load?.message.params.sessionId, old.remoteId)
    record('same-session store restart', 'passed', { old, after, restored, load })
  })
  await stop()
  await check('failed load never creates replacement', async () => {
    const state = readState(fixture.directory)
    state.failLoad = true
    writeFileSync(join(fixture.directory, 'peer-state.json'), JSON.stringify(state, null, 2))
    fixture = makeRuntime('normal')
    runtime = fixture.value
    const restored = await bounded(runtime.ensureSession({ sessionKey: 'research-conversation', agent: 'research-peer', mode: 'persistent' }), 'failed load handle')
    const output = await runTurn(restored, 'must not replay on a new session')
    assert.equal(output.result.status, 'failed')
    assert.equal(readState(fixture.directory).newCount, 1)
    assert.equal(readState(fixture.directory).turnCount, state.turnCount)
    record('failed load never creates replacement', 'passed', { result: output.result, state: readState(fixture.directory) })
  })
  await stop()
  for (const scenario of ['auth-required', 'malformed-init', 'wrong-version', 'missing-new-id']) {
    await check(scenario, async () => {
      fixture = makeRuntime(scenario, scenario)
      runtime = fixture.value
      let error
      let output
      let broken
      try {
        broken = await bounded(runtime.ensureSession({ sessionKey: scenario, agent: 'research-peer', mode: 'persistent' }), `ensure ${scenario}`)
        output = await runTurn(broken, 'must fail before a fixture prompt')
      } catch (value) { error = { message: value.message, code: value.code } }
      const prompts = wire(fixture.directory).filter(entry => entry.kind === 'in' && entry.message.method === 'session/prompt')
      record(`${scenario} wire observation`, 'observed', { error, output, broken,
        requests: wire(fixture.directory).filter(entry => entry.kind === 'in').map(entry => ({ method: entry.message.method, sessionId: entry.message.params?.sessionId })),
        initReply: wire(fixture.directory).find(entry => entry.kind === 'out' && entry.message.result?.protocolVersion !== undefined)?.message.result })
      assert.ok(error || output?.result.status === 'failed')
      assert.equal(prompts.length, 0)
      if (scenario === 'missing-new-id') assert.ok(error && !broken, 'Missing new session ID must reject ensure, rather than return an unusable handle')
      record(scenario, 'passed', { error, output, publicAuthenticateMethod: typeof runtime.authenticate })
    })
    await stop()
  }
} catch (error) {
  record('suite infrastructure', 'failed', { message: error.message, stack: error.stack?.split('\n').slice(0, 8) })
} finally {
  try { await stop() } catch (error) { record('finally shutdown', 'failed', { message: error.message }) }
  for (const pid of livePids) {
    try { process.kill(pid, 0); process.kill(pid); record('owned fixture cleanup fallback', 'limitation', { pid }) }
    catch {}
  }
  clearTimeout(watchdog)
  const summary = { cleanRoom: true, package: { name: packageMetadata.name, version: packageMetadata.version }, node: process.version,
    runRoot, observations, launches, verdict: observations.some(item => item.status === 'failed') ? 'needs-review' : 'public-protocol-experiment-completed-with-recorded-limitations' }
  writeFileSync(join(runRoot, 'results.json'), JSON.stringify(summary, null, 2))
  writeFileSync(join(ownRoot, 'latest-run.json'), JSON.stringify({ runRoot, results: join(runRoot, 'results.json') }, null, 2))
  console.log(`RESULTS ${join(runRoot, 'results.json')}`)
  process.exitCode = observations.some(item => item.status === 'failed') ? 1 : 0
}
