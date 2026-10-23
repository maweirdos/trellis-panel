/** Opt-in real application facade -> public acpx -> installed ZCode acceptance. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createFileSessionStore } from 'acpx/runtime'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

if (process.argv.includes('--self-test')) {
  await outcomeSelfTest()
  process.exit(0)
}
if (!process.argv.includes('--live')) {
  console.log('NOT RUN: live provider acceptance requires --live --zcode-bin <absolute CLI> [--model <exact negotiated ID>] [--permissions --native-session-db <existing native session SQLite>]')
  process.exit(0)
}
const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const bin = flag('--zcode-bin') ?? process.env.TRELLIS_ZCODE_BIN ?? process.env.ZCODE_BIN
assert.ok(bin && existsSync(bin), 'Select an installed ZCode CLI; no installation or config mutation occurs')
const requestedModel = flag('--model')
const permissionsOnly = process.argv.includes('--permissions')
const nativeSessionDb = flag('--native-session-db')
if (permissionsOnly) assert.ok(nativeSessionDb && isAbsolute(nativeSessionDb) && existsSync(nativeSessionDb),
  'Permission acceptance requires the explicit existing native session database for read-only rejection evidence')
const project = process.cwd()
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'trellis-zcode-live-')))
const workspace = join(root, 'workspace with spaces')
mkdirSync(workspace)
process.env.TPAP_SMOKE_DIR = root
// Exercise the actual native execution owner; never bypass its capability guard.
if (!process.argv.includes('--trellis-role=daemon')) process.argv.push('--trellis-role=daemon')
await prepareAcpHistoryWorker(root)
const require = createRequire(import.meta.url)
const evidence = { provider: 'real-installed-zcode', scope: permissionsOnly ? 'live-permissions' : 'live-runtime', startedAt: new Date().toISOString(), observations: [] }
const emit = (stage, detail = {}) => { const row = { stage, ...detail }; evidence.observations.push(row); console.log(JSON.stringify(row)) }
const safeError = value => String(value ?? '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 800)
const pause = ms => new Promise(done => setTimeout(done, ms))
let acp
let sessionId
const ownedPids = new Set()
const handledPermissions = new Set()
let permissionPolicy = 'deny'
let permissionCount = 0
let permissionAction
const permissionDecisions = []
let permissionTargets
const current = () => acp.listAcpSessions(workspace).sessions.find(session => session.sessionId === sessionId)
async function until(predicate, label, ms = 45_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await pause(50) }
  throw new Error(`Deadline: ${label}`)
}
function answerPermissions() {
  for (const event of globalThis.__TPANEL_EVENTS__ ?? []) {
    const request = event.payload
    if (event.channel !== 'acp:permission' || request.sessionId !== sessionId || handledPermissions.has(request.requestId)) continue
    handledPermissions.add(request.requestId)
    permissionCount += 1
    // Only approve an explicitly requested scratch-file action with its exact
    // correlated native input. Unknown/ambiguous actions remain denied.
    const state = current()
    const correlated = state.events.filter(item => item.kind === 'tool-call' && item.turnId === request.turnId &&
      item.connectionGeneration === request.connectionGeneration && item.payload?.toolCallId === request.toolCall?.toolCallId)
    const tool = correlated.findLast(item => item.payload?.rawInput !== undefined)
    const input = tool?.payload?.rawInput
    const title = request.toolCall?.title ?? ''
    const path = input && typeof input === 'object' ? input.file_path ?? input.path : undefined
    const owned = request.projectRoot === state.projectRoot && request.turnId === state.turnId &&
      request.connectionGeneration === state.connectionGeneration && correlated.some(item => item.payload?.title === title)
    const action = permissionAction
    const exactWrite = owned && action && title === 'Write' && input && !Array.isArray(input) &&
      Object.keys(input).length === 2 && typeof input.file_path === 'string' &&
      resolve(workspace, input.file_path) === action.path && input.content === action.content
    const allowRead = owned && !permissionsOnly && permissionPolicy === 'allow-scratch' && title === 'Read' &&
      typeof path === 'string' && resolve(workspace, path) === join(workspace, 'runtime-nonce.txt')
    const allow = allowRead || exactWrite && action.decision === 'allow_once' && action.decisions === 0
    const kind = allow ? 'allow_once' : 'reject_once'
    const options = request.options.filter(item => item.kind === kind)
    // Ambiguous same-kind options must never silently pick item one.
    assert.equal(options.length, 1, 'Native permission must advertise one exact requested decision')
    const option = options[0]
    const result = acp.respondAcpPermission(workspace, request.requestId, option.optionId)
    assert.equal(result.ok, true, result.error)
    if (exactWrite) action.decisions += 1
    const decision = { requestId: request.requestId, toolCallId: request.toolCall.toolCallId,
      turnId: request.turnId, connectionGeneration: request.connectionGeneration,
      optionId: option.optionId, kind, exactOwnedInput: Boolean(exactWrite),
      ...(exactWrite ? { rawInput: { file_path: input.file_path, content: input.content }, phase: action.label } : {}) }
    permissionDecisions.push(decision)
    emit('permission-decision', decision)
  }
}
async function turn(text, label, ms = 120_000) {
  const result = await acp.promptAcpSession(workspace, sessionId, text)
  assert.equal(result.ok, true, result.error)
  await settledTurn(result.turnId, 'completed', label, ms)
  return current().events.filter(event => event.turnId === result.turnId)
}
async function settledTurn(turnId, expectedStatus, label, ms = 120_000) {
  const generation = current().connectionGeneration
  const terminal = await until(() => {
    answerPermissions()
    const state = current()
    if (['error', 'closed', 'disconnected'].includes(state.status)) throw new Error(state.error ?? state.status)
    assert.equal(state.connectionGeneration, generation, 'Turn connection generation must remain owned')
    const matches = state.events.filter(event => event.turnId === turnId && event.connectionGeneration === generation && event.kind === 'turn-done')
    assert.ok(matches.length <= 1, 'An owned turn must have a unique terminal outcome')
    return state.status === 'ready' && matches[0]
  }, label, ms)
  const status = terminal.payload?.result?.status
  emit('turn-outcome', { label, turnId, connectionGeneration: generation, status, stopReason: terminal.payload?.stopReason })
  assert.equal(status, expectedStatus, `${label}: require the matching owned ${expectedStatus} result`)
  assert.ok(!current().error, current().error)
  return terminal
}
async function cancelTurn(turnId) {
  assert.equal((await acp.cancelAcpSession(workspace, sessionId)).ok, true)
  const terminal = await settledTurn(turnId, 'cancelled', 'cancel settlement', 20_000)
  emit('cancel', { passed: true, turnId, status: terminal.payload.result.status, nativeSessionId: current().backendSessionId })
}
async function nonceTurn(label) {
  const nonce = randomUUID()
  writeFileSync(join(workspace, 'runtime-nonce.txt'), nonce)
  const events = await turn('Use the Read tool to read runtime-nonce.txt from this workspace. Reply with only its exact content. Do not modify files or use other tools.', label)
  // The facade marks submitted user rows explicitly; streamed assistant deltas
  // have messageId/meta rather than a second synthetic role field.
  const assistant = events.filter(event => event.kind === 'message' && event.payload?.role !== 'user').map(event => event.text ?? '').join('')
  const tools = events.filter(event => event.kind === 'tool-call')
  assert.ok(assistant.includes(nonce), 'A fresh unseen nonce must be present in actual assistant text')
  assert.ok(tools.some(event => event.payload?.status === 'completed' && JSON.stringify(event.payload).includes(nonce)), 'A completed native tool must return the fresh nonce')
  emit(label, { passed: true, assistantText: true, completedFileTool: true, nativeSessionId: current().backendSessionId, modelId: current().currentModelId })
}
function absent(path) {
  try { lstatSync(path); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}
async function verifyNativeRejection(action, toolCallId) {
  const { DatabaseSync } = await import('node:sqlite')
  // Explicit evidence source only. Never discover/import credentials or write
  // native storage. Every row is restricted to this run's exact owned IDs.
  const db = new DatabaseSync(nativeSessionDb, { readOnly: true })
  try {
    const usage = db.prepare('SELECT status, error_type FROM tool_usage WHERE session_id = ? AND tool_call_id = ? LIMIT 2')
      .all(current().backendSessionId, toolCallId)
    assert.equal(usage.length, 1, 'The original denied tool must have one native usage result')
    assert.equal(usage[0].status, 'error')
    assert.equal(usage[0].error_type, 'permission_denied')
    const parts = db.prepare("SELECT data FROM part WHERE session_id = ? AND length(data) <= 32768 AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.callID') = ? LIMIT 2")
      .all(current().backendSessionId, toolCallId)
    assert.equal(parts.length, 1, 'The original denied tool must have one bounded native part')
    const part = JSON.parse(parts[0].data)
    assert.equal(part.tool, 'Write')
    assert.equal(part.state?.status, 'error')
    assert.deepEqual(part.state.input, { file_path: action.path, content: action.content })
    emit('native-rejection', { nativeSessionId: current().backendSessionId, toolCallId,
      source: 'explicit-native-session-sqlite-read-only', nativeUsageStatus: usage[0].status,
      nativeErrorType: usage[0].error_type, nativePartStatus: part.state.status, exactOwnedInput: true })
  } finally { db.close() }
}
async function permissionTurns() {
  // Installed 0.16.9 PermissionService.checkBuildMode asks for side effects;
  // edit auto-allows workspace edits and yolo/guarded bypass ordinary prompts.
  // This uses the existing acknowledged session mode API, never native settings.
  assert.ok(current().modes?.some(mode => mode.id === 'build'), 'Native build mode must be advertised')
  const selected = await acp.configureAcpSession(workspace, sessionId, { kind: 'mode', id: 'build' })
  assert.equal(selected.ok, true, selected.error)
  assert.equal(current().currentModeId, 'build', 'Native build mode must be acknowledged')
  const nativeId = current().backendSessionId
  const modelId = current().currentModelId
  emit('permission-mode', { modeId: current().currentModeId, nativeSessionId: current().backendSessionId })
  const actions = ['allow_once', 'reject_once'].map(decision => ({ decision, label: `write-${decision}`,
    path: join(workspace, `${decision}-marker.txt`), content: `${randomUUID()}\n`, decisions: 0 }))
  permissionTargets = actions
  assert.ok(actions.every(action => absent(action.path)), 'Both owned targets must initially be absent')
  for (const action of actions) {
    permissionAction = action
    const events = await turn(`Use only the Write tool exactly once with file_path ${JSON.stringify(action.path)} and content ${JSON.stringify(action.content)}. Do not use Read, Bash, Edit or any other tools. If approval is denied, stop without retrying or using another path/tool. Reply briefly with the actual result.`, action.label)
    permissionAction = undefined
    const decisions = permissionDecisions.filter(item => item.phase === action.label)
    assert.equal(decisions.length, 1, `${action.label}: a real correlated native permission request is required; native auto-allow is not coverage`)
    const decision = decisions[0]
    assert.equal(decision.kind, action.decision)
    assert.ok(events.some(event => event.kind === 'permission' && event.payload?.requestId === decision.requestId &&
      event.payload?.outcome === 'selected' && event.payload?.optionId === decision.optionId), 'Facade must record the exact selected permission ID')
    const toolEvents = events.filter(event => event.kind === 'tool-call' && event.payload?.toolCallId === decision.toolCallId)
    const statuses = toolEvents.map(event => event.payload.status).filter(Boolean)
    const terminalObserved = statuses.some(status => status === 'completed' || status === 'failed')
    assert.equal(current().backendSessionId, nativeId)
    assert.equal(current().currentModelId, modelId)
    assert.equal(current().currentModeId, 'build')
    if (action.decision === 'allow_once') {
      assert.ok(statuses.includes('completed'), 'The permitted original Write must complete')
      assert.ok(lstatSync(action.path).isFile() && !lstatSync(action.path).isSymbolicLink())
      assert.equal(readFileSync(action.path, 'utf8'), action.content)
    } else {
      assert.ok(statuses.includes('pending'), 'The original denied Write must be observed')
      const failed = toolEvents.find(event => event.payload?.status === 'failed')
      assert.ok(failed, 'Native denial must settle the original facade tool as failed')
      assert.equal(failed.payload.rawOutput?.decision, 'deny')
      assert.equal(failed.payload.rawOutput?.toolCallId, decision.toolCallId)
      assert.ok(!statuses.some(status => status === 'in_progress' || status === 'completed'), 'The rejected Write must not execute')
      await verifyNativeRejection(action, decision.toolCallId)
      const native = failed.payload.rawOutput
      emit('native-permission-resolution', { toolCallId: decision.toolCallId, nativePayload: {
        toolCallId: native.toolCallId, requestId: native.requestId, decision: native.decision, reason: native.reason } })
    }
    assert.ok(absent(actions[1].path), 'The denied target must remain absent, including dangling links')
    emit(action.label, { passed: true, toolCallId: decision.toolCallId, statuses, facadeToolTerminalObserved: terminalObserved,
      permittedFileExactContent: readFileSync(actions[0].path, 'utf8') === actions[0].content, deniedFileAbsent: absent(actions[1].path) })
  }
  assert.equal(permissionDecisions.filter(item => !item.exactOwnedInput).length, 0, 'Unexpected actions were denied and cannot count as permission acceptance')
  emit('permission-coverage', { observed: permissionCount, allowDenyVerified: true, facadeDenialTerminalVerified: true, nativeSessionId: current().backendSessionId })
}
function recordNativePids() {
  if (process.platform !== 'win32') return
  const literal = workspace.replace(/'/g, "''")
  const script = `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | Select-Object -ExpandProperty ProcessId`
  for (const id of execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)) if (/^\d+$/.test(id.trim())) ownedPids.add(Number(id))
}
try {
  const file = join(root, 'actual-facade.mjs')
  await build({ stdin: { contents: "export * from './src/main/services/acp'; export {setSettings} from './src/main/services/store';", resolveDir: project, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', banner: { js: "import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);" },
    alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, plugins: [{ name: 'real-public-acpx', setup(builder) {
      builder.onResolve({ filter: /^acpx\// }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
      // The GUI client is an independent owner. Leave that lazy branch external;
      // reaching it in this daemon-role harness must fail rather than impersonate it.
      builder.onResolve({ filter: /^\.\/daemon-client\/acp$/ }, () => ({ path: pathToFileURL(resolve('src/main/services/daemon-client/acp.ts')).href, external: true }))
    } }], outfile: file })
  acp = await import(pathToFileURL(file).href)
  acp.setSettings({ acp: { nodePath: process.execPath, agents: [], nativePaths: { zcode: bin } } })
  const created = await acp.newAcpSession(workspace, { agentId: 'zcode' })
  assert.equal(created.ok, true, created.error)
  sessionId = created.sessionId
  await until(() => {
    const state = current()
    if (state?.status === 'error') throw new Error(state.error)
    return state?.status === 'ready'
  }, 'native startup')
  const store = createFileSessionStore({ stateDir: join(root, 'acp', 'runtime-store') })
  const runtimeRecord = await store.load(current().acpxRecordId)
  if (runtimeRecord?.pid) ownedPids.add(runtimeRecord.pid)
  recordNativePids()
  const option = current().configOptions?.find(item => item.category === 'model')
  const model = requestedModel ?? current().currentModelId
  assert.ok(model && current().models?.some(item => item.modelId === model), 'Use only an exact negotiated model, never the first fallback')
  const selected = await acp.configureAcpSession(workspace, sessionId, option ? { kind: 'config', id: option.id, value: model } : { kind: 'model', id: model })
  assert.equal(selected.ok, true, selected.error)
  assert.equal(current().currentModelId, model)
  emit('model-and-source', { modelId: model, models: current().models, adapter: current().capabilities?.agentInfo })
  const nativeId = current().backendSessionId
  if (permissionsOnly) {
    await permissionTurns()
  } else {
    permissionPolicy = 'allow-scratch'
    await nonceTurn('first-real-turn')
    await nonceTurn('second-real-turn')
    const cancelled = await acp.promptAcpSession(workspace, sessionId, 'Think carefully for sixty seconds before replying. Do not call tools or modify files.')
    assert.equal(cancelled.ok, true, cancelled.error)
    await pause(300)
    await cancelTurn(cancelled.turnId)
    await nonceTurn('after-cancel')
    assert.equal((await acp.killAcpSession(workspace, sessionId)).ok, true)
    assert.equal((await acp.resumeAcpSession(workspace, sessionId)).ok, true)
    await until(() => current().status === 'ready' || current().status === 'error', 'same-session restore')
    assert.equal(current().status, 'ready', current().error)
    assert.equal(current().backendSessionId, nativeId)
    assert.equal(current().currentModelId, model)
    const restored = await store.load(current().acpxRecordId)
    if (restored?.pid) ownedPids.add(restored.pid)
    recordNativePids()
    await nonceTurn('after-same-session-restore')
    emit('permission-coverage', { observed: permissionCount, allowDenyVerified: false, note: 'Full controlled permission matrix is covered by protocol fixtures; no live approval is invented.' })
  }
  assert.equal((await acp.killAcpSession(workspace, sessionId)).ok, true)
  evidence.passed = true
} catch (error) { evidence.passed = false; emit('failure', { error: safeError(error.message) }); process.exitCode = 1 }
finally {
  try {
    await acp?.shutdownAcp()
    for (const pid of ownedPids) {
      await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, 'owned process cleanup', 10_000)
    }
    emit('owned-process-cleanup', { passed: true, count: ownedPids.size })
    if (permissionTargets) {
      const [allowed, denied] = permissionTargets
      const permittedFileExactContent = existsSync(allowed.path) && readFileSync(allowed.path, 'utf8') === allowed.content
      const deniedFileAbsent = absent(denied.path)
      emit('permission-files-after-shutdown', { permittedFileExactContent, deniedFileAbsent })
      assert.ok(permittedFileExactContent && deniedFileAbsent, 'Permission file outcomes must survive owned shutdown')
    }
  } catch (error) {
    evidence.passed = false
    process.exitCode = 1
    emit('cleanup-or-file-check-failure', { error: safeError(error.message) })
  }
  evidence.finishedAt = new Date().toISOString()
  const file = join(root, 'acceptance-evidence.json')
  writeFileSync(file, JSON.stringify(evidence, null, 2))
  console.log(`EVIDENCE ${file}`)
}

async function outcomeSelfTest() {
  // Run the actual helpers against an in-memory facade. A completed file tool
  // and matching assistant nonce cannot turn a cancelled turn into success.
  const fixture = (status, terminalTurnId = 'owned-turn') => {
    const emitted = []
    const generation = 'owned-generation'
    const state = { status: 'ready', connectionGeneration: generation, backendSessionId: 'native-owned', currentModelId: 'exact-model', events: [
      { kind: 'message', turnId: 'owned-turn', connectionGeneration: generation, text: 'helper-nonce', payload: {} },
      { kind: 'tool-call', turnId: 'owned-turn', connectionGeneration: generation, payload: { status: 'completed', output: 'helper-nonce' } },
      { kind: 'turn-done', turnId: terminalTurnId, connectionGeneration: generation, payload: { result: { status } } }
    ] }
    const sandbox = { assert, workspace: 'memory-only', sessionId: 'owned-session', join,
      current: () => state, answerPermissions() {}, randomUUID: () => 'helper-nonce', writeFileSync() {},
      emit: (stage, detail) => emitted.push({ stage, ...detail }),
      acp: { promptAcpSession: async () => ({ ok: true, turnId: 'owned-turn' }), cancelAcpSession: async () => ({ ok: true }) },
      until: async predicate => { const value = predicate(); assert.ok(value, 'No matching owned terminal in fixture'); return value } }
    const source = [turn, settledTurn, nonceTurn, cancelTurn].map(fn => fn.toString()).join('\n')
    return { emitted, api: runInNewContext(`${source}\n;({nonceTurn, cancelTurn})`, sandbox) }
  }
  for (const status of ['cancelled', 'failed', undefined, 'unknown']) {
    const rejected = fixture(status)
    await assert.rejects(rejected.api.nonceTurn('nonce regression'), /matching owned completed result/)
    assert.ok(!rejected.emitted.some(row => row.passed === true))
  }
  const completed = fixture('completed')
  await completed.api.nonceTurn('nonce regression')
  assert.ok(completed.emitted.some(row => row.passed === true))
  const cancelled = fixture('cancelled')
  await cancelled.api.cancelTurn('owned-turn')
  assert.ok(cancelled.emitted.some(row => row.stage === 'cancel' && row.status === 'cancelled' && row.passed === true))
  await assert.rejects(fixture('completed').api.cancelTurn('owned-turn'), /matching owned cancelled result/)
  await assert.rejects(fixture('cancelled', 'foreign-turn').api.cancelTurn('owned-turn'), /No matching owned terminal/)
  console.log('PASS actual live helpers: cancelled/failed/unknown nonce outcomes rejected; cancel requires owned cancelled result, not a natural completion or foreign turn (no I/O)')
}
