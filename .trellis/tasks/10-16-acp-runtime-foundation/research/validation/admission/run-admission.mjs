// Clean-room public-store/facade experiment; no upstream/product edits.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ownRoot = dirname(fileURLToPath(import.meta.url))
const runRoot = join(ownRoot, 'runs', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(runRoot, { recursive: true })
const safeEnvironment = {}
for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATH', 'Path', 'PATHEXT']) {
  if (process.env[key] !== undefined) safeEnvironment[key] = process.env[key]
}
for (const [key, leaf] of Object.entries({ HOME: 'home', USERPROFILE: 'home', LOCALAPPDATA: 'local', APPDATA: 'roaming', TEMP: 'tmp', TMP: 'tmp' })) {
  safeEnvironment[key] = join(runRoot, leaf)
  mkdirSync(safeEnvironment[key], { recursive: true })
}
process.env = safeEnvironment
const packageRoot = resolve(process.argv[2] ?? 'C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a143cf-354c-7ce0-a351-45db825fc514/acpx-validation/node_modules/acpx')
assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version, '0.19.5')
const { createAcpRuntime, createFileSessionStore } = await import(pathToFileURL(join(packageRoot, 'dist/runtime.js')).href)
const { createAgentRegistry } = await import(pathToFileURL(join(packageRoot, 'dist/agent-registry.js')).href)
const peerPath = resolve(ownRoot, '..', 'protocol', 'strict-peer.mjs')
const outcomes = []
const pendingPids = new Set()
let sequence = 0
const errorView = error => ({ message: error?.message, code: error?.code })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function bounded(promise, label, milliseconds = 10000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Research deadline: ${label}`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
function isAlive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
function readWire(directory) {
  const path = join(directory, 'peer-wire.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
function containsString(value, target) {
  if (value === target) return true
  if (Array.isArray(value)) return value.some(entry => containsString(entry, target))
  return value && typeof value === 'object' ? Object.values(value).some(entry => containsString(entry, target)) : false
}
const watchdog = setTimeout(() => {
  // Recorded PIDs refer only to these bounded fixture launches; no global kill.
  for (const pid of pendingPids) { try { process.kill(pid) } catch {} }
  writeFileSync(join(runRoot, 'watchdog.json'), JSON.stringify(outcomes, null, 2))
  process.exit(2)
}, 100000)

try {
  for (const scenario of ['normal', 'malformed-init', 'wrong-version', 'missing-new-id', 'foreign-update']) {
    const directory = join(runRoot, scenario)
    mkdirSync(directory, { recursive: true })
    const timeline = []
    const note = (kind, detail = {}) => timeline.push({ seq: ++sequence, kind, ...detail })
    const baseStore = createFileSessionStore({ stateDir: join(directory, 'runtime-store') })
    const processIds = []
    const outcome = { scenario, directory, timeline, guard: 'public camelCase protocolVersion !== 1, then nonempty handle.backendSessionId' }
    const store = {
      load: id => baseStore.load(id),
      async save(record) {
        const markerPresent = JSON.stringify(record.messages).includes('WRONG-SESSION-MARKER')
        note('store-save', { protocolVersion: record.protocolVersion, hasSnakeCaseProtocolField: Object.hasOwn(record, 'protocol_version'),
          backendSessionId: record.acpSessionId, markerPresent,
          foreignEnvelopeIdPresent: containsString(record, 'foreign-unowned-session') })
        if (record.protocolVersion !== 1) {
          note('store-rejected-version', { value: record.protocolVersion })
          const error = new Error(`Host version admission rejected ${JSON.stringify(record.protocolVersion)}`)
          error.code = 'HOST_PROTOCOL_VERSION_REJECTED'
          throw error
        }
        // Timing probe only: marker-based content rejection is NOT an identity policy.
        if (scenario === 'foreign-update' && markerPresent) {
          note('store-rejected-marker')
          const error = new Error('Host timing probe rejected projected marker')
          error.code = 'HOST_PROJECTED_MARKER_REJECTED'
          throw error
        }
        return baseStore.save(record)
      }
    }
    const registry = createAgentRegistry({ overrides: {
      'admission-peer': [process.execPath, peerPath, directory, scenario === 'foreign-update' ? 'normal' : scenario]
    } })
    const runtime = createAcpRuntime({ cwd: directory, sessionStore: store, agentRegistry: registry,
      permissionMode: 'deny-all', nonInteractivePermissions: 'deny', timeoutMs: 4000, fs: false, terminal: false,
      processLifecycle: {
        onBeforeSpawn(info) { assert.equal(resolve(info.command), resolve(process.execPath)); assert.ok(info.args.includes(peerPath)); note('before-spawn') },
        onSpawned(info) { processIds.push(info.pid); pendingPids.add(info.pid); note('spawned', { pid: info.pid }) },
        onExit(info) { pendingPids.delete(info.pid); note('exit', { pid: info.pid, code: info.code, signal: info.signal }) }
      }
    })
    let handle
    try {
      try {
        handle = await bounded(runtime.ensureSession({ sessionKey: `admission-${scenario}`, agent: 'admission-peer', mode: 'persistent' }), 'ensure')
        note('ensure-returned', { backendSessionId: handle.backendSessionId })
        outcome.handle = handle
        if (typeof handle.backendSessionId !== 'string' || !handle.backendSessionId.trim()) {
          note('facade-rejected-handle')
          const error = new Error('Host admission rejected missing backendSessionId')
          error.code = 'HOST_SESSION_ID_REJECTED'
          throw error
        }
        note('facade-admitted')
        outcome.admitted = true
      } catch (error) {
        outcome.admitted = false
        outcome.admissionError = errorView(error)
        note('admission-failed', outcome.admissionError)
      }
      if (outcome.admitted) {
        const turn = runtime.startTurn({ handle, text: scenario === 'foreign-update' ? 'foreign-update' : 'normal fixture turn', mode: 'prompt', requestId: `admission-${scenario}` })
        const started = turn.promptStarted.then(() => note('prompt-started'), error => note('prompt-not-started', errorView(error)))
        const events = []
        const drain = (async () => {
          for await (const event of turn.events) {
            events.push(event)
            if (event.type === 'text_delta') note('normalized-text', { text: event.text })
          }
        })()
        const [result] = await bounded(Promise.all([turn.result, drain, started]), 'turn')
        outcome.turn = { result, events }
        note('turn-settled', { result })
      }
      await wait(150)
      outcome.aliveBeforeCallerCleanup = processIds.map(pid => ({ pid, alive: isAlive(pid) }))
      if (!outcome.admitted && handle) {
        try { await bounded(runtime.close({ handle, reason: 'host invalid-handle admission' }), 'close invalid handle'); outcome.close = 'resolved' }
        catch (error) { outcome.close = errorView(error) }
        await wait(100)
        outcome.aliveAfterClose = processIds.map(pid => ({ pid, alive: isAlive(pid) }))
      }
    } catch (error) {
      outcome.experimentError = errorView(error)
      note('experiment-error', outcome.experimentError)
    } finally {
      try { await bounded(runtime.shutdown(), 'finally shutdown', 12000); outcome.shutdown = 'resolved' }
      catch (error) { outcome.shutdown = errorView(error) }
      await wait(100)
      outcome.aliveAfterShutdown = processIds.map(pid => ({ pid, alive: isAlive(pid) }))
      const wire = readWire(directory)
      outcome.requests = wire.filter(row => row.kind === 'in').map(row => ({ method: row.message.method, sessionId: row.message.params?.sessionId }))
      outcome.promptTransmitted = outcome.requests.some(request => request.method === 'session/prompt')
      outcome.newSessionTransmitted = outcome.requests.some(request => request.method === 'session/new')
      const markerEvent = timeline.find(row => row.kind === 'normalized-text' && row.text.includes('WRONG-SESSION-MARKER'))
      const markerSave = timeline.find(row => row.kind === 'store-save' && row.markerPresent)
      outcome.markerTiming = { normalizedSeq: markerEvent?.seq, firstProjectedSaveSeq: markerSave?.seq,
        envelopeIdExposedInPublicSave: timeline.some(row => row.kind === 'store-save' && row.foreignEnvelopeIdPresent) }
      writeFileSync(join(directory, 'result.json'), JSON.stringify(outcome, null, 2))
      outcomes.push(outcome)
      console.log(JSON.stringify({ scenario, admitted: outcome.admitted, error: outcome.admissionError,
        promptTransmitted: outcome.promptTransmitted, newSessionTransmitted: outcome.newSessionTransmitted,
        aliveBeforeCallerCleanup: outcome.aliveBeforeCallerCleanup, close: outcome.close,
        aliveAfterClose: outcome.aliveAfterClose, shutdown: outcome.shutdown, aliveAfterShutdown: outcome.aliveAfterShutdown,
        markerTiming: outcome.markerTiming, turnResult: outcome.turn?.result }))
    }
  }
} finally {
  for (const pid of pendingPids) { try { process.kill(pid) } catch {} }
  clearTimeout(watchdog)
  const summary = { cleanRoom: true, package: 'acpx@0.19.5', node: process.version, runRoot, outcomes }
  writeFileSync(join(runRoot, 'results.json'), JSON.stringify(summary, null, 2))
  writeFileSync(join(ownRoot, 'latest-run.json'), JSON.stringify({ runRoot, results: join(runRoot, 'results.json') }, null, 2))
  console.log(`RESULTS ${join(runRoot, 'results.json')}`)
  process.exitCode = outcomes.some(value => value.experimentError || value.shutdown !== 'resolved' || value.aliveAfterShutdown?.some(row => row.alive)) ? 1 : 0
}
