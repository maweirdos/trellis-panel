// Protocol-only acceptance for the real bridge and public acpx; never runs a real provider.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createAcpRuntime, createFileSessionStore } from 'acpx/runtime'
import { createAgentRegistry } from 'acpx/agent-registry'
import { zSessionUpdate } from '../../node_modules/acpx/node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js'
import { zcodeLaunch, redactDiagnostic } from '../../adapters/zcode-acp/src/zcode-backend.mjs'

const root = mkdtempSync(join(tmpdir(), 'trellis-zcode-protocol-'))
const entry = resolve('adapters/zcode-acp/src/index.mjs')
const peer = resolve('scripts/smoke/fixtures/zcode-native-peer.mjs')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function bounded(promise, label, ms = 15000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Deadline ${label}`)), ms) })]) }
  finally { clearTimeout(timer) }
}
const wireAt = directory => readFileSync(join(directory, 'native-wire.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
async function assertDead(directory) {
  const path = join(directory, 'native-pid')
  if (!existsSync(path)) return
  const pid = Number(readFileSync(path, 'utf8'))
  for (let tries = 0; tries < 100; tries++) {
    try { process.kill(pid, 0) } catch { return }
    await pause(20)
  }
  assert.fail(`Owned native process ${pid} leaked`)
}

async function directFixture() {
  const directory = join(root, 'direct path with spaces')
  mkdirSync(directory)
  // Omit --zcode-bin to regress the broken environment fallback.
  const child = spawn(process.execPath, [entry, '--isolated', directory], { cwd: directory,
    env: { ...process.env, TRELLIS_ZCODE_BIN: peer }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', value => { stderr += value })
  const frames = []
  const pending = new Map()
  let id = 0
  let permissionAnswer = 'native-allow-b'
  let permissionCount = 0
  let schemaError
  const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  createInterface({ input: child.stdout }).on('line', line => {
    const frame = JSON.parse(line)
    frames.push(frame)
    if (frame.method === 'session/update') {
      try { zSessionUpdate.parse(frame.params.update) } catch (error) { schemaError = error }
    }
    if (frame.method === 'session/request_permission') {
      permissionCount++
      assert.deepEqual(frame.params.options.map(value => value.optionId), ['native-allow-a', 'native-allow-b', 'native-deny'])
      assert.equal(frame.params.toolCall.rawInput.path, 'owned.txt')
      if (permissionAnswer === 'invalid-then-allow') {
        send({ id: frame.id, result: { outcome: { outcome: 'selected', optionId: 'invented' } } })
        setTimeout(() => send({ id: frame.id, result: { outcome: { outcome: 'selected', optionId: 'native-allow-b' } } }), 30)
      } else if (permissionAnswer !== 'hold') send({ id: frame.id, result: { outcome: { outcome: 'selected', optionId: permissionAnswer } } })
    } else if (frame.id !== undefined && pending.has(frame.id)) {
      pending.get(frame.id)(frame)
      pending.delete(frame.id)
    }
  })
  const call = (method, params) => {
    const requestId = ++id
    const result = new Promise(resolve => pending.set(requestId, resolve))
    send({ id: requestId, method, params })
    return bounded(result, `${method}; stderr=${stderr}`)
  }
  const sessionId = 'sess_owned_zcode'
  const mcpServers = [{ name: 'owned-stdio', command: process.execPath, args: ['path with spaces/server.mjs'], env: [{ name: 'FIXTURE', value: 'yes' }] },
    { name: 'owned-http', type: 'http', url: 'http://127.0.0.1:9/fixture', headers: [] }]
  const prompt = text => call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  const assertSuccess = response => { assert.equal(response.error, undefined, response.error?.message); assert.equal(response.result.stopReason, 'end_turn') }
  try {
    assert.equal((await call('initialize', { protocolVersion: 1, clientCapabilities: {} })).result.protocolVersion, 1)
    const created = await call('session/new', { cwd: directory, mcpServers })
    assert.equal(created.error, undefined, created.error?.message)
    assert.equal(created.result.sessionId, sessionId)
    assert.deepEqual(wireAt(directory).find(value => value.method === 'session/create').params.mcpServers, mcpServers)
    assert.equal(created.result.configOptions[0].currentValue, 'p/unlisted')
    assert.equal(created.result.configOptions[0].options.length, 3)
    for (const text of ['early', 'duplicates', 'gap']) {
      const start = frames.length
      assertSuccess(await prompt(text))
      const updates = frames.slice(start).filter(frame => frame.method === 'session/update').map(frame => frame.params.update)
      assert.equal(updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.content.text).join(''), 'one two')
      assert.deepEqual(updates.find(update => update.status === 'completed')?.rawOutput, { output: 'tool NONCE', nested: { ok: true } })
      assert.equal(updates.find(update => update.status === 'pending')?.rawInput.path, 'nonce.txt')
      console.log(`PASS native ${text}: exact text/tool output and single terminal`)
    }
    for (const error of ['error_max_turns', 'error_max_budget', 'error_max_tool_calls', 'error_during_execution', 'turn-failed', 'send-rejected']) {
      assert.ok((await prompt(error)).error, `${error} must not report inference success`)
    }
    assertSuccess(await prompt('after-failure'))
    const selected = await call('session/set_config_option', { sessionId, configId: 'zcode.model', value: 'p/b' })
    assert.equal(selected.result.configOptions[0].currentValue, 'p/b')
    assert.equal(selected.result.configOptions[0].options.length, 3, 'current-only snapshot cannot replace complete catalog')
    const rejected = await call('session/set_config_option', { sessionId, configId: 'zcode.model', value: 'p/reject' })
    assert.equal(rejected.error.data.reason, 'unavailable')
    const noChange = await call('session/set_config_option', { sessionId, configId: 'zcode.model', value: 'p/b' })
    assert.equal(noChange.result.configOptions[0].currentValue, 'p/b')
    assert.equal((await call('session/set_mode', { sessionId, modeId: 'edit' })).error, undefined)
    assert.equal(frames.filter(frame => frame.params?.update?.sessionUpdate === 'current_mode_update').at(-1).params.update.currentModeId, 'edit')
    for (const ordering of ['event-first', 'rpc-first']) {
      const before = permissionCount
      const start = frames.length
      assertSuccess(await prompt(`permission:${ordering}`))
      await pause(120)
      assert.equal(permissionCount, before + 1, 'Both native channels share one ACP approval')
      assert.deepEqual(wireAt(directory).filter(value => value.kind === 'permission-answer').at(-1).result, { decision: 'allow', reason: 'exact B' })
      const updates = frames.slice(start).filter(frame => frame.method === 'session/update' && frame.params.update.toolCallId).map(frame => frame.params.update)
      assert.deepEqual(updates.map(update => update.status), ['pending', 'in_progress', 'completed'], 'Allow resolution must not settle a tool or let foreign/late denial affect it')
      assert.equal(new Set(updates.map(update => update.toolCallId)).size, 1, 'Unmatched/foreign resolutions cannot create tools')
      assert.deepEqual(updates.at(-1).rawOutput, { output: 'actually executed' })
    }
    permissionAnswer = 'native-deny'
    for (const ordering of ['event-first', 'rpc-first', 'resolution-gap']) {
      const start = frames.length
      assertSuccess(await prompt(`permission:${ordering}`))
      assert.equal(wireAt(directory).filter(value => value.kind === 'permission-answer').at(-1).result.decision, 'deny')
      const updates = frames.slice(start).filter(frame => frame.method === 'session/update' && frame.params.update.toolCallId).map(frame => frame.params.update)
      assert.deepEqual(updates.map(update => update.status), ['pending', 'failed'], 'Exactly the original denied tool settles once despite replay/order/semantic duplicates')
      assert.equal(new Set(updates.map(update => update.toolCallId)).size, 1)
      assert.equal(updates[1].rawOutput.toolCallId, updates[0].toolCallId)
      assert.equal(updates[1].rawOutput.decision, 'deny')
      assert.equal(updates[1].rawOutput.reason, 'exact reject')
    }
    permissionAnswer = 'invalid-then-allow'
    assertSuccess(await prompt('permission:event-first'))
    assert.equal(wireAt(directory).filter(value => value.kind === 'permission-answer').at(-1).result.reason, 'exact B')
    permissionAnswer = 'hold'
    const cancel = prompt('permission:cancel')
    await pause(150)
    send({ method: 'session/cancel', params: { sessionId: 'sess_foreign' } })
    await pause(50)
    assert.ok(!wireAt(directory).some(value => value.method === 'session/stop'), 'Foreign cancel must not reach the native process')
    send({ method: 'session/cancel', params: { sessionId } })
    assert.equal((await cancel).result.stopReason, 'cancelled')
    assert.match(wireAt(directory).filter(value => value.kind === 'permission-answer').at(-1).result.reason, /cancelled/)
    assertSuccess(await prompt('after-cancel'))
    const beforeLoad = wireAt(directory).filter(value => value.method === 'session/send').length
    const loaded = await call('session/load', { sessionId, cwd: directory, mcpServers })
    assert.equal(loaded.error, undefined)
    assert.deepEqual(wireAt(directory).find(value => value.method === 'session/resume').params.mcpServers, mcpServers)
    assert.equal(loaded.result.configOptions[0].currentValue, 'p/b')
    assert.equal(wireAt(directory).filter(value => value.method === 'session/send').length, beforeLoad)
    assertSuccess(await prompt('after-load'))
    assert.equal(schemaError, undefined, schemaError?.message)
    const replies = frames.filter(frame => typeof frame.id === 'number')
    assert.equal(new Set(replies.map(frame => frame.id)).size, replies.length, 'Every ACP request settles at most once')
    assert.match((await prompt('unrecoverable-gap')).error.message, /sequence gap/)
    console.log('PASS native failures, exact permission IDs/orderings/denial/cancel, config acknowledgements, same-session load')
  } finally {
    child.stdin.end()
    await bounded(new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve) }), 'adapter shutdown')
    await assertDead(directory)
  }
}

async function publicRuntimeFixture() {
  const directory = join(root, 'public acpx')
  mkdirSync(directory)
  const makeRuntime = () => createAcpRuntime({ cwd: directory, sessionStore: createFileSessionStore({ stateDir: join(directory, 'store') }),
    agentRegistry: createAgentRegistry({ overrides: { 'owned-zcode': [process.execPath, entry, '--zcode-bin', peer, '--isolated', directory] } }),
    permissionMode: 'deny-all', nonInteractivePermissions: 'deny', timeoutMs: 12000, fs: false, terminal: false })
  let runtime = makeRuntime()
  try {
    const session = await bounded(runtime.ensureSession({ sessionKey: 'owned', agent: 'owned-zcode', mode: 'persistent' }), 'public ensure')
    for (const text of ['early', 'gap', 'error_max_budget', 'after-failure', 'permission:event-first']) {
      const turn = runtime.startTurn({ handle: session, text, requestId: text, mode: 'prompt' })
      const stream = (async () => { const events = []; for await (const event of turn.events) events.push(event); return events })()
      const [result, events] = await bounded(Promise.all([turn.result, stream, turn.promptStarted]), `public ${text}`)
      if (text.startsWith('error_')) assert.equal(result.status, 'failed')
      else {
        assert.equal(result.status, 'completed')
        if (text.startsWith('permission:')) {
          const tools = events.filter(event => event.type === 'tool_call')
          assert.deepEqual(tools.map(event => event.status), ['pending', 'failed'])
          assert.equal(tools[1].toolCallId, tools[0].toolCallId)
          assert.equal(tools[1].rawOutput.decision, 'deny')
        } else assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), 'one two')
      }
    }
    console.log('PASS actual adapter through public acpx: early terminal, gap recovery, failure and continued same-session inference fixture')
    await runtime.shutdown()
    await assertDead(directory)
    runtime = makeRuntime()
    const restored = await bounded(runtime.ensureSession({ sessionKey: 'owned', agent: 'owned-zcode', mode: 'persistent' }), 'restored public ensure')
    const resumedTurn = runtime.startTurn({ handle: restored, text: 'after-restart', requestId: 'restored-request', mode: 'prompt' })
    const resumedStream = (async () => { for await (const _event of resumedTurn.events) { /* Drain real events. */ } })()
    const [resumedResult] = await bounded(Promise.all([resumedTurn.result, resumedStream]), 'new input after adapter restart')
    assert.equal(resumedResult.status, 'completed', 'Input IDs must not collide with native persisted IDs after a process restart')
    console.log('PASS restart/load preserves native input deduplication without reusing process-local IDs')
  } finally { await runtime.shutdown(); await assertDead(directory) }
}

try {
  assert.equal(zcodeLaunch('node', 'C:/tools/zcode.exe', ['app-server'], 'win32').command, 'C:/tools/zcode.exe')
  assert.deepEqual(zcodeLaunch('node', 'C:/tools/zcode.cjs', ['app-server'], 'win32').args, ['C:/tools/zcode.cjs', 'app-server'])
  assert.ok(zcodeLaunch('node', 'C:/tools path/zcode.cmd', ['--cwd', 'C:/work path'], 'win32').windowsVerbatimArguments)
  assert.ok(!redactDiagnostic('apiKey=SECRET-FIXTURE authorization=Bearer sk-ABCDEFGH123').includes('SECRET-FIXTURE'))
  await directFixture()
  await publicRuntimeFixture()
  console.log('PASS owned ZCode protocol fixtures (no real provider inference)')
} finally { rmSync(root, { recursive: true, force: true }) }
