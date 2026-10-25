import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync, rmdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-daemon-build-manager-'))
const fixtureKey = `__daemonBuild${randomUUID().replaceAll('-', '')}`
const require = createRequire(import.meta.url)
const realNow = Date.now
const identity = { profileId: 'a'.repeat(64), userId: 'fixture-user', mode: 'development', appVersion: '0.1.0', installationId: 'b'.repeat(64) }
const ticks = ms => String(BigInt(ms) * 10000n + 621355968000000000n)
let sequence = 0
try {
  async function scenario({ stamp = true, changed = true, stopMode = 'exit', race = false } = {}) {
    Date.now = realNow
    const directory = join(temporary, `case-${sequence++}`); mkdirSync(directory)
    const profile = join(directory, 'profile'); mkdirSync(join(profile, 'owner'), { recursive: true })
    const bundle = join(directory, 'daemon-host.js'); writeFileSync(bundle, 'original bytes')
    const owner = { pid: 111, startedAt: ticks(realNow() - 1000), userId: identity.userId, executable: 'C:\\fixture\\electron.exe' }
    const context = { directory: profile, identity, owner: { ...owner, pid: 222, startedAt: ticks(realNow()) }, userData: profile }
    const lease = { version: 1, epoch: randomUUID(), nonce: randomUUID(), identity, owner, acquiredAt: realNow() }
    const leaseFile = join(profile, 'owner', 'lease.json')
    writeFileSync(leaseFile, JSON.stringify(lease))
    const stampPath = join(profile, `daemon-build-${lease.epoch}-${lease.nonce}.json`)
    const state = { context, lease, stopped: false, spawned: 0, commands: [], featureCalls: [], controls: 0, ordinary: 0, clients: 0, closes: 0, stopMode, race, bundle, stampPath }
    const root = realpathSync(profile), rootKey = process.platform === 'win32' ? root.toLowerCase() : root
    state.workspace = { workspaceId: createHash('sha256').update(rootKey).digest('hex'), root, grantId: randomUUID(), revision: 1 }
    state.status = () => ({ protocol: 1, epoch: state.lease.epoch, owner: state.lease.owner, identity, state: 'running', runtimeAuthority: 'daemon', settingsAuthority: 'daemon', preferences: { revision: 1, keepRunning: true, startup: 'client' }, eventCursor: { epoch: state.lease.epoch, sequence: 0 }, activeJobs: 0, unknownJobs: 0, capabilities: ['foundation', 'native-protection'] })
    state.client = () => {
      state.clients++; state.onConnect?.(state.clients)
      const captured = structuredClone(state.lease)
      const connection = lease => ({ lease, epoch: lease.epoch, connected: true, close() { if (this.connected) state.closes++; this.connected = false }, onDisconnect() { return () => {} }, onInvalidation() { return () => {} }, request: state.request })
      if (state.race) {
        state.race = false
        state.lease = { ...state.lease, epoch: randomUUID(), nonce: randomUUID(), owner: { ...owner, pid: 333 } }
        writeFileSync(leaseFile, JSON.stringify(state.lease))
        return connection(state.lease)
      }
      return connection(captured)
    }
    state.request = async (method, payload, options) => {
      if (method === 'daemon.status') { state.onStatus?.(); return { ok: true, data: state.status() } }
      if (method === 'workspace.get') { state.onScope?.(); return { ok: true, data: state.noGrant ? null : state.workspace } }
      if (method !== 'daemon.stop') {
        state.featureCalls.push({ method, payload, options })
        assert.notEqual(method, 'workspace.grant', 'cleanup must never create a replacement workspace grant')
        const controlled = await state.onFeature?.(method, payload, options)
        if (controlled) return controlled
        return { ok: true, data: { inline: { ok: true, profiles: [] } } }
      }
      assert.equal(method, 'daemon.stop')
      state.commands.push({ payload, commandId: options.commandId, epoch: state.lease.epoch })
      if (state.stopMode === 'busy') return { ok: false, code: 'E_BUSY', error: 'busy', outcome: 'not-admitted', commandId: options.commandId }
      if (state.stopMode === 'timeout') {
        Date.now = (() => { let now = realNow(); return () => now += 16000 })()
        return { ok: true, data: { state: 'stopping' } }
      }
      if (state.stopMode === 'unknown') return { ok: false, code: 'E_UNKNOWN', error: 'lost stop acknowledgement', outcome: 'unknown', commandId: options.commandId }
      state.stopped = true
      if (state.stopMode !== 'retained-lease') { rmSync(leaseFile); rmdirSync(join(profile, 'owner')); state.lease = null }
      return { ok: true, data: { state: 'stopping' } }
    }
    state.spawn = () => {
      state.spawned++
      assert.equal(state.stopped, true, 'no new owner before old owner actually exits')
      state.stopped = false
      mkdirSync(join(profile, 'owner'))
      state.lease = { ...lease, epoch: randomUUID(), nonce: randomUUID(), owner: { ...owner, pid: 444, startedAt: ticks(realNow()) }, acquiredAt: realNow() }
      writeFileSync(leaseFile, JSON.stringify(state.lease))
      state.api.publishDaemonBuild({ ...context, owner: state.lease.owner }, state.lease, { ...state.api.captureDaemonBuild(), modifiedAt: realNow() - 1000, capturedAt: state.lease.acquiredAt })
      return { pid: state.lease.owner.pid }
    }
    globalThis[fixtureKey] = state
    const file = join(directory, 'manager.cjs')
    await build({ stdin: { contents: `export * from './src/main/services/daemon-client/manager';export * from './src/main/daemon/build-identity';export {DaemonConnectionPool} from './src/main/services/daemon-client/pool';export {nativeDomainCall,nativeProviderReadCall} from './src/main/services/daemon-client/runtime'`, resolveDir: process.cwd(), loader: 'ts' }, outfile: file, bundle: true, format: 'cjs', platform: 'node', plugins: [{ name: 'controlled-manager', setup(builder) {
      builder.onResolve({ filter: /^electron$|^node:child_process$|(^|\/)context$|(^|\/)native$|(^|\/)launch$|^\.\/client$|^\.\/pool$|^\.\.\/bridge$/ }, args => {
        if (args.path === './context' && !args.importer.endsWith('manager.ts')) return
        return { path: args.path, namespace: 'fixture' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
        const state = `const s=globalThis[${JSON.stringify(fixtureKey)}];`
        if (args.path === '../bridge') return { contents: 'export const broadcastToWindows=()=>{}' }
        if (args.path === 'electron') return { contents: `${state}export const app={isPackaged:false,getAppPath:()=>s.context.directory}` }
        if (args.path === 'node:child_process') return { contents: `${state}export const spawn=(...args)=>s.spawn(...args)` }
        if (args.path.endsWith('launch')) return { contents: `${state}export const launchDaemonProcess=async()=>s.spawn()` }
        if (args.path.endsWith('context')) return { contents: `${state}export const createDaemonContext=async()=>s.context` }
        if (args.path.endsWith('native')) return { contents: `${state}export const sameOwner=(a,b)=>a.pid===b.pid&&a.startedAt===b.startedAt&&a.userId===b.userId&&a.executable===b.executable;export const processIdentity=async(pid)=>s.stopped?null:(s.lease?.owner.pid===pid?s.lease.owner:null)` }
        if (args.path === './client') return { contents: `${state}export const DaemonClient={connect:async()=>s.client()}` }
        if (args.path === './pool') return { contents: `${state}export const DAEMON_OBSERVATION={hintMs:25,healthMs:15000,retryMs:1000};export const disposeDaemonPools=()=>{};export const observePooledWorkspace=()=>{throw Error('No live observer')};export const daemonConnectionPool=()=>({getControl:async()=>{s.controls++;return s.client()},get:async()=>{s.ordinary++;return s.client()},status:async client=>{const result=await client.request('daemon.status',{});return result.data}})` }
        throw new Error(args.path)
      })
    } }] })
    state.api = require(file)
    if (stamp) {
      utimesSync(bundle, new Date(realNow() - 2000), new Date(realNow() - 2000))
      state.api.publishDaemonBuild({ ...context, owner }, lease, { ...state.api.captureDaemonBuild(), capturedAt: lease.acquiredAt })
      if (stamp === 'foreign') {
        const foreign = JSON.parse(readFileSync(stampPath, 'utf8')); foreign.lease.nonce = randomUUID()
        writeFileSync(stampPath, JSON.stringify(foreign))
      }
    }
    if (changed) writeFileSync(bundle, 'new bytes')
    return state
  }
  {
    const state = await scenario({ changed: false })
    writeFileSync(join(state.context.directory, '..', 'daemon-host.js'), 'original bytes')
    const result = await state.api.daemonManager.start()
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(state.commands.length, 0); assert.equal(state.spawned, 0)
  }
  {
    const state = await scenario()
    const [a, b] = await Promise.all([state.api.daemonManager.start(), state.api.daemonManager.start()])
    assert.equal(a.ok, true, JSON.stringify(a)); assert.deepEqual(a, b)
    assert.equal(state.commands.length, 1); assert.equal(state.spawned, 1)
    assert.equal(state.commands[0].payload.idleOnly, true)
  }
  for (const [stamp, changed] of [[false, false], [false, true], ['foreign', true]]) {
    const state = await scenario({ stamp, changed })
    const result = await state.api.daemonManager.start()
    assert.equal(result.code, 'E_VERSION'); assert.equal(state.commands.length, 0); assert.equal(state.spawned, 0)
    assert.equal((await state.api.daemonManager.status()).ok, true, 'status remains usable for recovery')
    const explicit = await state.api.daemonManager.stop()
    assert.equal(explicit.ok, true); assert.equal(state.commands[0].payload.idleOnly, undefined, 'explicit user stop retains forced semantics')
  }
  {
    const state = await scenario({ stopMode: 'busy' })
    const result = await state.api.daemonManager.start()
    assert.equal(result.code, 'E_BUSY'); assert.equal(state.spawned, 0); assert.equal(state.stopped, false)
    await assert.rejects(state.api.pooledDaemonClient(), error => error.code === 'E_VERSION')
  }
  for (const stopMode of ['timeout', 'retained-lease', 'unknown']) {
    const state = await scenario({ stopMode })
    const first = await state.api.daemonManager.start()
    assert.equal(first.code, 'E_UNKNOWN'); assert.ok(first.commandId)
    if (stopMode === 'unknown') Date.now = (() => { let now = realNow(); return () => now += 16000 })()
    const again = await state.api.daemonManager.start()
    assert.equal(again.code, 'E_UNKNOWN'); assert.equal(again.commandId, first.commandId)
    assert.equal(state.commands.length, 1); assert.equal(state.spawned, 0, 'failed release cannot start duplicate owner')
  }
  {
    const state = await scenario({ race: true })
    const result = await state.api.daemonManager.start()
    assert.equal(result.code, 'E_CONFLICT'); assert.equal(state.commands.length, 0); assert.equal(state.spawned, 0)
  }
  {
    const state = await scenario()
    const first = state.api.daemonManager.start()
    const stopping = state.api.daemonManager.stop()
    const last = state.api.daemonManager.start()
    assert.notEqual(first, last, 'Start after queued Stop cannot join the earlier Start')
    const results = await Promise.all([first, stopping, last])
    assert.ok(results.every(result => result.ok), JSON.stringify(results))
    assert.equal(state.spawned, 2); assert.equal(state.commands.length, 2)
    assert.equal(state.stopped, false)
    const [one, two] = await Promise.all([state.api.daemonManager.stop(), state.api.daemonManager.stop()])
    assert.equal(one.ok, true); assert.deepEqual(one, two)
    assert.equal(state.commands.length, 3, 'Adjacent Stop entrypoints share one native command')
    assert.equal(state.stopped, true, 'No queued startup may survive the final Stop')
  }
  {
    const state = await scenario({ changed: false, stopMode: 'unknown' })
    const original = await state.api.daemonManager.stop()
    assert.equal(original.code, 'E_UNKNOWN'); assert.ok(original.commandId)
    Date.now = (() => { let now = realNow(); return () => now += 16000 })()
    for (const method of ['stop', 'restart', 'start']) {
      const result = await state.api.daemonManager[method]()
      assert.equal(result.ok, false); assert.equal(result.commandId, original.commandId)
      assert.equal(state.commands.length, 1, 'Unknown original stop is never dispatched under another identity')
      assert.equal(state.spawned, 0)
    }
    Date.now = realNow
    state.stopped = true
    rmSync(join(state.context.directory, 'owner', 'lease.json'))
    rmdirSync(join(state.context.directory, 'owner'))
    assert.equal((await state.api.daemonManager.stop()).ok, true, 'Original exit and lease release reconcile the retained receipt')
    assert.equal(state.commands.length, 1)
  }
  {
    const state = await scenario({ changed: false, stopMode: 'busy' })
    const refused = await state.api.daemonManager.stop()
    assert.equal(refused.outcome, 'not-admitted')
    state.stopMode = 'exit'
    const retry = await state.api.daemonManager.stop()
    assert.equal(retry.ok, true); assert.equal(state.commands.length, 2)
    assert.notEqual(state.commands[0].commandId, state.commands[1].commandId, 'Known not-admitted refusal permits a fresh explicit request')
  }
  {
    const state = await scenario({ changed: false }), pool = new state.api.DaemonConnectionPool(state.context)
    const client = await pool.get()
    await pool.status(client)
    writeFileSync(state.bundle, 'original bytes')
    assert.equal(await pool.get(), client, 'identical rebuild preserves the ordinary connection')
    writeFileSync(state.bundle, 'changed bytes')
    await assert.rejects(pool.get(), error => error.code === 'E_VERSION', 'cached ordinary pool cannot attach after a rebuild')
    await assert.rejects(async () => pool.status(client), error => error.code === 'E_VERSION', 'cached capabilities cannot make an outdated owner current')
    assert.equal(client.connected, true, 'build rejection must not disconnect admitted shared work')
    const control = await pool.getControl()
    assert.equal((await control.request('daemon.status', {})).ok, true, 'management remains usable on the old owner')
    pool.dispose()
  }
  for (const stamp of [false, true, 'foreign']) {
    const state = await scenario({ stamp })
    await assert.rejects(state.api.nativeDomainCall(state.workspace.root, 'runtime.profiles', {}), error => error.code === 'E_VERSION', 'direct runtime ordinary path must check build even with a permissive pool')
    const pool = new state.api.DaemonConnectionPool(state.context)
    await assert.rejects(pool.get(), error => error.code === 'E_VERSION', 'initial ordinary pool also enforces freshness')
    assert.equal(state.featureCalls.length, 0); assert.equal(state.commands.length, 0)
    // Only exact retained-grant cleanup methods bypass build freshness. No
    // arbitrary method, authorization or fresh workspace enters that lane.
    for (const method of ['runtime.cancel', 'runtime.end', 'runtime.permission', 'runtime.workflow.stop', 'runtime.workflow.cancelRevision', 'jira.workspace.cancelRead', 'jira.workspace.cancel', 'gitlab.workspace.cancelJob', 'dingtalk.workspace.cancelExecution']) {
      const commandId = randomUUID(), body = method === 'runtime.permission' ? { requestId: 'original-permission', optionId: 'allow_once' } : { sessionId: 'original-owner' }
      const result = await state.api.nativeDomainCall(state.workspace.root, method, body, commandId)
      assert.equal(result.ok, true, method)
      const sent = state.featureCalls.at(-1)
      assert.equal(sent.method, method); assert.deepEqual(sent.options.workspace, state.workspace)
      assert.deepEqual(sent.payload.inline, body); assert.equal(sent.options.commandId, commandId)
    }
    const submitted = state.featureCalls.length
    state.noGrant = true
    await assert.rejects(state.api.nativeDomainCall(state.workspace.root, 'runtime.cancel', { sessionId: 'original-owner' }), error => error.code === 'E_CONFLICT', 'cleanup cannot create a missing grant')
    assert.equal(state.featureCalls.length, submitted)
    pool.dispose()
  }
  for (const boundary of ['onStatus', 'onScope']) {
    const state = await scenario({ changed: false })
    state[boundary] = () => { writeFileSync(state.bundle, 'replaced during awaited attachment') }
    await assert.rejects(state.api.nativeDomainCall(state.workspace.root, 'runtime.profiles', {}), error => error.code === 'E_VERSION', `rebuild during ${boundary} must fence feature submission`)
    assert.equal(state.featureCalls.length, 0)
  }
  {
    const state = await scenario({ stamp: false })
    state.onScope = () => {
      state.lease = { ...state.lease, epoch: randomUUID(), nonce: randomUUID() }
      writeFileSync(join(state.context.directory, 'owner', 'lease.json'), JSON.stringify(state.lease))
    }
    await assert.rejects(state.api.nativeDomainCall(state.workspace.root, 'runtime.cancel', { sessionId: 'original-owner' }), error => error.code === 'E_CONFLICT')
    assert.equal(state.featureCalls.length, 0, 'cleanup cannot silently retarget a replacement owner')
  }
  {
    const state = await scenario()
    state.onConnect = connections => { if (connections === 2) writeFileSync(state.bundle, 'original bytes') }
    const result = await state.api.daemonManager.start()
    assert.equal(result.code, 'E_CONFLICT'); assert.equal(state.commands.length, 0); assert.equal(state.spawned, 0, 'a build restored during preflight cannot cause a needless restart')
  }
  {
    const state = await scenario({ changed: false }), abort = new AbortController()
    let release
    const original = new Promise(done => { release = done })
    state.onFeature = async method => {
      if (method === 'gitlab.workspace.snapshot') await original
      if (method === 'provider.read.cancel') return { ok: true, data: { state: 'cancel-requested', active: true } }
    }
    const pending = state.api.nativeProviderReadCall(state.workspace.root, 'gitlab.workspace.snapshot', { expectedRoot: state.workspace.root }, randomUUID(), abort.signal)
    const deadline = realNow() + 2000
    while (!state.featureCalls.length && realNow() < deadline) await new Promise(done => setTimeout(done, 5))
    assert.equal(state.featureCalls[0]?.method, 'gitlab.workspace.snapshot')
    rmSync(state.stampPath)
    writeFileSync(state.bundle, 'rebuilt after original read admission')
    abort.abort(); release()
    await pending
    const cancellation = state.featureCalls.find(row => row.method === 'provider.read.cancel')
    assert.ok(cancellation, 'original transient cancellation stays available after both build change and missing stamp')
    assert.deepEqual(cancellation.options.workspace, state.workspace)
    assert.deepEqual(cancellation.payload, { ...state.featureCalls[0].payload.inline.providerRead, method: 'gitlab.workspace.snapshot' })
    assert.equal(state.featureCalls.filter(row => row.method === 'provider.read.cancel').length, 1, 'exact cancellation is not replayed')
  }
  console.log('PASS daemon manager: safe replacement, exact stop identity, real pool/direct runtime freshness, bounded original cleanup lanes and asynchronous rebuild/owner fences')
} finally {
  Date.now = realNow
  delete globalThis[fixtureKey]
  assert.ok(temporary.startsWith(join(tmpdir(), 'trellis-daemon-build-manager-')))
  rmSync(temporary, { recursive: true, force: true })
}
