import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { CONNECTION_STAGES, CONNECTION_TIMINGS_FILE } from '../src/connection-timings.mjs'

const root = mkdtempSync(join(tmpdir(), 'trellis-zcode-timing-'))
const entry = resolve('adapters/zcode-acp/src/index.mjs')
const peer = resolve('adapters/zcode-acp/test/connection-peer.mjs')
const providerId = 'account:bigmodel-individual-coding-plan'
let subscriptionCount = 0
const server = createServer((_request, response) => {
  subscriptionCount++
  setTimeout(() => response.end(JSON.stringify({ code: 200,
    data: [{ productId: 'coding-fixture', status: 'VALID', inCurrentPeriod: true }] })), 50)
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
async function bounded(promise, ms = 15_000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timing fixture deadline')), ms) })]) }
  finally { clearTimeout(timer) }
}
function validate(value, operation, status) {
  assert.equal(value.version, 1)
  assert.equal(value.operation, operation)
  assert.equal(value.status, status)
  assert.equal(typeof value.backendReused, 'boolean')
  assert.ok(Number.isSafeInteger(value.totalDurationMs) && value.totalDurationMs >= 0)
  assert.deepEqual(value.stages.map(value => value.stage), CONNECTION_STAGES)
  for (const stage of value.stages) {
    assert.ok(['completed', 'failed', 'skipped'].includes(stage.status))
    if (stage.status === 'skipped') assert.equal(stage.durationMs, undefined)
    else assert.ok(Number.isSafeInteger(stage.durationMs) && stage.durationMs >= 0 && stage.durationMs <= value.totalDurationMs + 1)
  }
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 4096)
  assert.ok(!JSON.stringify(value).includes('SECRET-FIXTURE'))
  return Object.fromEntries(value.stages.map(stage => [stage.stage, stage]))
}
async function fixture(scenario, action, account = false) {
  const directory = join(root, scenario)
  const nativeDirectory = join(directory, '.zcode', 'v2')
  mkdirSync(nativeDirectory, { recursive: true })
  const builtinPath = join(directory, 'builtin.json')
  writeFileSync(builtinPath, JSON.stringify({ schemaVersion: 1, revision: 1,
    config: { providerConfigRules: { providerRules: [
      { providerId, config: { access: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'individual-coding-plan' } } }
    ] } } }))
  writeFileSync(join(nativeDirectory, 'setting.json'), JSON.stringify({ providerFamilyDomain: 'bigmodel',
    providerFamilyConnectionSelections: { bigmodel: { kind: 'individual-coding-plan' } } }))
  writeFileSync(join(nativeDirectory, 'credentials.json'), JSON.stringify({ 'oauth:active_provider': 'bigmodel',
    'oauth:bigmodel:access_token': 'SECRET-FIXTURE-oauth', zcodejwttoken: 'SECRET-FIXTURE-jwt',
    'oauth:bigmodel:user_info': JSON.stringify({ id: 'fixture', username: 'fixture', displayName: 'Fixture' }),
    [`account-provider:coding-plan:${providerId}:account:fixture:api-key`]: 'SECRET-FIXTURE-key' }))
  const child = spawn(process.execPath, [entry, '--zcode-bin', peer, ...(account ? [] : ['--isolated', directory])], {
    cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
      ZCODE_TIMING_FIXTURE: scenario, TRELLIS_ZCODE_DIAGNOSTICS_DIR: directory,
      ZCODE_DATA_BASE_DIR: directory, ZCODE_DESKTOP_HOME_DIR: directory, HOME: directory, USERPROFILE: directory,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(nativeDirectory, 'provider_config.json'),
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath, BIGMODEL_API_BASE_URL: `http://127.0.0.1:${server.address().port}` }
  })
  const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })))
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-2000) })
  const frames = []
  const pending = new Map()
  let nextId = 0
  const send = frame => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
  createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line)
    frames.push(value)
    pending.get(value.id)?.(value)
    pending.delete(value.id)
  })
  const call = (method, params) => {
    const id = ++nextId
    const response = new Promise(done => pending.set(id, done))
    send({ id, method, params })
    return bounded(response)
  }
  const timing = () => JSON.parse(readFileSync(join(directory, CONNECTION_TIMINGS_FILE), 'utf8'))
  const wire = () => readFileSync(join(directory, 'timing-peer.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try { if (predicate(wire())) return } catch { /* Native log may not exist before spawn. */ }
      await new Promise(done => setTimeout(done, 10))
    }
    throw new Error('Native fixture stage deadline')
  }
  try {
    const initialized = await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
    assert.equal(initialized.result.agentCapabilities.promptCapabilities.embeddedContext, true)
    await action({ child, call, send, timing, directory, wire, frames, exited, waitFor })
  } catch (error) { error.message += `; fixture=${scenario}; stderr=${stderr}`; throw error }
  finally {
    child.stdin.end()
    await bounded(exited)
    for (const pid of wire().filter(value => value.started).map(value => value.started)) {
      assert.throws(() => process.kill(pid, 0), 'Owned backend must be gone after adapter cleanup')
    }
  }
}

try {
  await fixture('success', async ({ call, timing, directory, send, wire, waitFor }) => {
    const creating = call('session/new', { cwd: directory, mcpServers: [] })
    const conflicting = await call('session/load', { cwd: directory, sessionId: 'sess_timing_fixture', mcpServers: [] })
    assert.equal(conflicting.error.code, -32010, 'Concurrent connection attempts cannot race native session ownership')
    await waitFor(wire => wire.some(value => value.method === 'session/subscribe'))
    const premature = await call('session/prompt', { sessionId: 'sess_timing_fixture', prompt: [{ type: 'text', text: 'must-not-send' }] })
    assert.equal(premature.error.code, -32000, 'An in-flight subscription is not a ready session')
    const created = await creating
    assert.equal(created.error, undefined)
    assert.equal(created.result.modes.currentModeId, 'plan', 'State changes during snapshot-free subscription must survive')
    assert.ok(created.result.configOptions[0].options.length > 0, 'Retain the full create model catalog')
    assert.deepEqual(created.result._meta.trellisZcode.connectionTimings, timing())
    const stages = validate(timing(), 'new', 'completed')
    for (const stage of ['backend-process', 'storage-ready', 'session-create-or-resume', 'subscribe']) assert.equal(stages[stage].status, 'completed')
    for (const stage of ['storage-ready', 'session-create-or-resume', 'subscribe']) assert.ok(stages[stage].durationMs >= 45, `${stage} must measure the actual delayed work`)
    assert.equal(stages['account-sync'].reason, 'isolated')
    const sessionId = created.result.sessionId
    for (const block of [{ type: 'image', mimeType: 'image/png', data: 'fixture' },
      { type: 'resource', resource: { uri: 'https://example.invalid/context', text: 'must-not-send', mimeType: 'text/plain' } }]) {
      const invalid = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'must-not-send' }, block] })
      assert.equal(invalid.error.code, -32602, 'Unsupported prompt blocks must be a typed ACP input error')
    }
    for (const text of ['first', 'second']) assert.equal((await call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })).result.stopReason, 'end_turn')
    const cancelled = call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'wait-cancel' }] })
    send({ method: 'session/cancel', params: { sessionId } })
    assert.equal((await cancelled).result.stopReason, 'cancelled')
    const loading = call('session/load', { sessionId, cwd: directory, mcpServers: [] })
    await waitFor(wire => wire.some(value => value.method === 'session/resume'))
    try { assert.equal(timing().operation, 'load', 'An old successful new-session timing cannot survive a new load attempt') }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
    const loaded = await loading
    assert.equal(loaded.error, undefined)
    const reuse = validate(timing(), 'load', 'completed')
    assert.equal(timing().backendReused, true)
    for (const stage of ['backend-process', 'storage-ready', 'account-sync']) assert.equal(reuse[stage].reason, 'backend_reused')
    assert.equal((await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'after-load' }] })).result.stopReason, 'end_turn')
    assert.equal(wire().filter(value => value.started).length, 1)
    assert.equal(wire().filter(value => value.method === 'session/create').length, 1)
    assert.equal(wire().filter(value => value.method === 'session/send').length, 4, 'Premature prompt cannot reach the backend')
    const subscriptions = wire().filter(value => value.method === 'session/subscribe')
    assert.equal(subscriptions[0].afterSeq, 0)
    assert.equal(subscriptions[1].afterSeq, undefined)
    assert.equal(subscriptions[0].includeSnapshot, false, 'New session must not rebuild its already-received snapshot')
    assert.equal(subscriptions[1].includeSnapshot, true, 'Restore retains its current subscription snapshot')
  })
  for (const scenario of ['session-failed', 'subscribe-failed', 'bad-watermark', 'wrong-resume']) {
    await fixture(scenario, async ({ call, timing, directory }) => {
      const operation = scenario === 'wrong-resume' ? 'load' : 'new'
      const result = await call(`session/${operation}`, { cwd: directory, sessionId: 'sess_timing_fixture', mcpServers: [] })
      assert.ok(result.error)
      assert.deepEqual(result.error.data._meta.trellisZcode.connectionTimings, timing())
      const stages = validate(timing(), operation, 'failed')
      const failedStage = ['session-failed', 'wrong-resume'].includes(scenario) ? 'session-create-or-resume' : 'subscribe'
      assert.equal(stages[failedStage].status, 'failed')
      assert.ok(stages[failedStage].durationMs >= 45)
      if (scenario === 'bad-watermark') assert.equal(stages.subscribe.reason, 'invalid_subscription')
      if (scenario === 'wrong-resume') assert.equal(stages[failedStage].reason, 'invalid_session')
    })
  }
  const before = subscriptionCount
  for (const scenario of ['account-success', 'account-rejected']) {
    await fixture(scenario, async ({ call, timing, directory }) => {
      assert.equal((await call('session/new', { cwd: directory, mcpServers: [] })).error, undefined)
      const stages = validate(timing(), 'new', 'completed')
      assert.ok(stages['account-sync'].durationMs >= 90)
      assert.equal(stages['account-sync'].status, scenario === 'account-success' ? 'completed' : 'failed')
      if (scenario === 'account-rejected') assert.equal(stages['account-sync'].reason, 'account_sync_unacknowledged')
    }, true)
  }
  assert.equal(subscriptionCount, before + 2)
  await fixture('never-ready', async ({ send, child, exited, timing, directory, waitFor }) => {
    send({ id: 2, method: 'session/new', params: { cwd: directory, mcpServers: [] } })
    await waitFor(wire => wire.some(value => value.started))
    child.stdin.end()
    await bounded(exited)
    const stages = validate(timing(), 'new', 'cancelled')
    assert.equal(stages['storage-ready'].status, 'failed')
    assert.equal(stages['storage-ready'].reason, 'cancelled')
    assert.equal(stages['session-create-or-resume'].status, 'skipped')
  })
  await fixture('exit-before-ready', async ({ send, exited, timing, directory }) => {
    send({ id: 2, method: 'session/new', params: { cwd: directory, mcpServers: [] } })
    assert.equal((await bounded(exited)).code, 1)
    const stages = validate(timing(), 'new', 'failed')
    assert.equal(stages['storage-ready'].reason, 'backend_exited')
    assert.equal(stages['session-create-or-resume'].status, 'skipped')
  })
  console.log('PASS measured ZCode connection stages, failures, account ACK, persistent reuse, watermarks, cancellation and cleanup (controlled peer)')
} finally {
  server.closeAllConnections()
  await new Promise(done => server.close(done))
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  assert.ok(basename(root).startsWith('trellis-zcode-timing-'))
  rmSync(root, { recursive: true, force: true })
}
