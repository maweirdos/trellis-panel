/** Real authenticated isolated pipe + production client/pool/facade/history hook.
 * No native profile, daemon process, provider, database or user body is touched. */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-daemon-reads-'))
const root = join(temporary, 'project')
mkdirSync(root)
const epoch = randomUUID(), secret = randomBytes(32)
const owner = { pid: process.pid, startedAt: 'fixture-process', userId: 'fixture-user', executable: process.execPath }
const identity = { profileId: 'a'.repeat(64), userId: owner.userId, mode: 'development', appVersion: 'fixture', installationId: 'b'.repeat(64) }
const lease = { epoch, owner, identity }
const context = { identity, owner, pipeName: `trellis-read-smoke-${randomUUID()}`, credential: () => secret, protection: { refresh: async () => {} } }
const grant = { workspaceId: 'fixture-workspace', root, grantId: randomUUID(), revision: 1 }
const listeners = new Set(), states = new Set(), dones = new Set(), resets = new Set(), sockets = new Set()
const calls = [], broadcasts = []
const attempts = [], failures = []
const gates = new Map()
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const wait = async (test, label) => { const end = Date.now() + 8000; while (!test()) { assert.ok(Date.now() < end, label); await new Promise(done => setTimeout(done, 5)) } }
let binding, activeHook
let selection = 'session-a'
let reset = true, replaySequence = 0, busyReplay = false, busyList = false
const summary = id => ({ sessionId: id, projectRoot: root, status: 'disconnected', agentId: 'fixture', agentName: 'Fixture', startedAt: 10, connectionGeneration: 'generation-a', events: [] })
const fixture = {
  context, lease, calls, broadcasts,
  state: { snapshot: { meta: { root } } },
  listen: async (pipeName, onPeer) => {
    const server = createServer(socket => {
      sockets.add(socket)
      const decoder = new binding.FrameDecoder()
      const peer = { owner, clientPid: owner.pid, isAlive: () => !socket.destroyed, close: () => socket.destroy(), send: value => socket.write(binding.encodeFrame(value)), onFrame: () => {}, onClose: () => {} }
      socket.on('data', bytes => { try { decoder.push(bytes, value => peer.onFrame(value)) } catch { socket.destroy() } })
      socket.on('close', () => { sockets.delete(socket); peer.onClose() })
      socket.on('error', () => {})
      onPeer(peer)
    })
    const address = process.platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : join(temporary, 'daemon.sock')
    await new Promise((done, reject) => { server.once('error', reject); server.listen(address, done) })
    return { close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)) } }
  },
  broadcast: (channel, payload) => {
    broadcasts.push({ channel, payload })
    if (channel === binding.ipcEvent.acpState) for (const listener of [...states]) listener(payload)
    if (channel === binding.ipcEvent.daemonRuntimeReset) for (const listener of [...resets]) listener(payload)
  },
  react: new Proxy({}, { get: (_, name) => (...args) => activeHook[name](...args) }),
  api: {
    acpHistoryList: input => binding.facade.listAcpHistorySessions(root, input),
    acpHistorySession: id => binding.facade.getAcpHistorySession(root, id),
    acpHistoryEvents: (id, input) => binding.facade.getAcpHistoryEvents(root, id, input),
    onAcpState: listener => { states.add(listener); return () => states.delete(listener) },
    onAcpDone: listener => { dones.add(listener); return () => dones.delete(listener) },
    onDaemonRuntimeReset: listener => { resets.add(listener); return () => resets.delete(listener) }
  }
}
globalThis.__DAEMON_READ_FIXTURE__ = fixture
class Hook {
  hooks = []; index = 0; effects = []; dirty = false
  same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  useState = initial => { const index = this.index++, slot = this.hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slot.value, value => { const next = typeof value === 'function' ? value(slot.value) : value; if (!Object.is(next, slot.value)) { slot.value = next; this.dirty = true } }] }
  useRef = initial => this.hooks[this.index++] ??= { current: initial }
  useMemo = (compute, deps) => { const index = this.index++, slot = this.hooks[index]; if (!slot || !this.same(slot.deps, deps)) this.hooks[index] = { deps, value: compute() }; return this.hooks[index].value }
  useCallback = (callback, deps) => this.useMemo(() => callback, deps)
  useEffect = (effect, deps) => { const index = this.index++, slot = this.hooks[index]; if (!slot || !this.same(slot.deps, deps)) this.effects.push(() => { slot?.cleanup?.(); this.hooks[index] = { deps, cleanup: effect() } }) }
  render() { let count = 0; do { assert.ok(++count < 30); activeHook = this; this.index = 0; this.effects = []; this.dirty = false; this.value = binding.useConversationHistory(root, selection); for (const effect of this.effects) effect() } while (this.dirty) }
  dispose() { for (const slot of this.hooks) slot?.cleanup?.() }
}
const mocks = {
  '../../daemon/lease': 'const f=globalThis.__DAEMON_READ_FIXTURE__; export const readLease=()=>f.lease; export const verifiedLease=async()=>f.lease;',
  './lease': 'export const assertLease=()=>{};',
  '../../daemon/native': 'export const sameOwner=(a,b)=>JSON.stringify(a)===JSON.stringify(b);',
  './native': 'export const sameOwner=(a,b)=>JSON.stringify(a)===JSON.stringify(b);',
  './transport': 'export const listenNativePipe=(...args)=>globalThis.__DAEMON_READ_FIXTURE__.listen(...args);',
  './manager': 'export const daemonClientContext=async()=>globalThis.__DAEMON_READ_FIXTURE__.context;',
  '../bridge': 'export const broadcastToWindows=(...args)=>globalThis.__DAEMON_READ_FIXTURE__.broadcast(...args);',
  '../acp/metadata': 'export const canonicalDirectory=value=>value.toLowerCase().replaceAll("\\\\","/");',
  '../services/acp/metadata': 'export const canonicalDirectory=value=>value.toLowerCase().replaceAll("\\\\","/");',
  '../acp/setup': 'export const pickAcpNode=()=>{}; export const pickAcpRuntimePath=()=>{};',
  './native-state': 'export const writeNativeSettings=()=>{};',
  react: ['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect'].map(name => `export const ${name}=(...args)=>globalThis.__DAEMON_READ_FIXTURE__.react.${name}(...args);`).join('\n'),
  '../api': 'export const api=globalThis.__DAEMON_READ_FIXTURE__.api; export const hasIpc=true;',
  '../store': 'export const useApp={getState:()=>globalThis.__DAEMON_READ_FIXTURE__.state};',
  '../my/navigation': 'export const projectRootKey=value=>value.toLowerCase().replaceAll("\\\\","/");',
  '../utils/interaction-scope': 'const active=()=>true; export const useInteractionActive=active; export const useInteractionGuard=()=>active; export const useInteractionSignal=()=>undefined;'
}
let server, hook, stop
try {
  const file = join(temporary, 'binding.mjs')
  await build({
    stdin: { contents: `export {DaemonClient} from './src/main/services/daemon-client/client'; export * from './src/main/services/daemon-client/pool'; export * from './src/main/services/daemon-client/runtime'; export * as facade from './src/main/services/daemon-client/acp'; export {startDaemonServer} from './src/main/daemon/server'; export {FrameDecoder,encodeFrame} from './src/main/daemon/framing'; export {ipcEvent} from './src/shared/ipc-channels'; export {DAEMON_LIMITS} from './src/shared/daemon'; export {DaemonError} from './src/main/daemon/errors'; export {useConversationHistory} from './src/renderer/src/acp/useConversationHistory';`, resolveDir: resolve('.') },
    outfile: file, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    plugins: [{ name: 'fixture-native-boundaries', setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
    } }]
  })
  binding = await import(pathToFileURL(file).href)
  const request = binding.DaemonClient.prototype.request
  binding.DaemonClient.prototype.request = async function (method, payload, options) {
    attempts.push(method)
    const result = await request.call(this, method, payload, options)
    if (!result.ok) failures.push({ method, code: result.code, commandId: result.commandId })
    return result
  }
  const status = { protocol: 1, epoch, identity, owner, state: 'running', runtimeAuthority: 'daemon', settingsAuthority: 'daemon', preferences: { revision: 1, keepRunning: true, startup: 'manual' }, eventCursor: { epoch, sequence: 0 }, activeJobs: 0, unknownJobs: 0, capabilities: ['foundation', 'runtime-control', 'push-events'] }
  server = await binding.startDaemonServer(context, lease, {
    observeInvalidations: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    currentWorkspace: workspace => JSON.stringify(workspace) === JSON.stringify(grant),
    authorizedWorkspace: request => { assert.deepEqual(request.workspace, grant); return grant },
    async dispatch(request) {
      calls.push({ method: request.method, commandId: request.commandId, workspace: request.workspace, body: request.payload })
      await gates.get(request.method)?.promise
      const method = request.method
      if (method === 'daemon.status') return status
      if (method === 'workspace.get') return grant
      assert.deepEqual(request.workspace, grant)
      if (method === 'events.subscribe') return { subscribed: true }
      if (method === 'events.unsubscribe') return null
      if (method === 'runtime.events') {
        if (busyReplay) throw new binding.DaemonError('E_BUSY', 'Fixture replay admission is busy.')
        const page = { cursor: { epoch, sequence: replaySequence }, events: [], resetRequired: reset, hasMore: false, sessions: reset ? { ok: true, sessions: [summary('session-a')] } : null }
        reset = false
        return { inline: page }
      }
      if (method === 'runtime.historyList') {
        if (busyList) throw new binding.DaemonError('E_BUSY', 'Fixture history read is busy.')
        return { inline: { ok: true, sessions: [{ ...summary('session-a'), title: request.payload.inline.input?.query ?? '' }], hasMore: false, nextCursor: null, diagnostics: [] } }
      }
      if (method === 'runtime.historySession') return { inline: { ok: true, version: 1, session: summary(request.payload.inline.sessionId) } }
      if (method === 'runtime.historyEvents') return { inline: { ok: true, version: 1, session: summary(request.payload.inline.sessionId), events: [], beforeCursor: null, afterCursor: null, hasEarlier: false, hasLater: false, coverage: { state: 'complete' }, startsMidTurn: false } }
      if (method === 'runtime.cancel' || method === 'runtime.permission') return { inline: { ok: true } }
      if (method === 'runtime.profiles') return { inline: { ok: true, profiles: [] } }
      if (method === 'runtime.watcher') return { inline: null }
      if (method === 'runtime.prompt') throw new binding.DaemonError('E_BUSY', 'Fixture mutation was not admitted.')
      throw new Error(`Unexpected fixture method: ${method}`)
    }
  }, () => { throw new Error('fixture transport failure') })
  // Warm the real connection/grant and subscribe before placing history under load.
  const pool = binding.daemonConnectionPool(context)
  const client = await pool.get()
  await pool.status(client)
  await binding.facade.listAcpHistorySessions(root)
  stop = binding.observeRuntime(root)
  await wait(() => broadcasts.some(item => item.channel === binding.ipcEvent.daemonRuntimeReset), 'runtime snapshot')
  const hold = deferred(); gates.set('runtime.historyList', hold)
  const selectedHold = deferred(); gates.set('runtime.historySession', selectedHold)
  hook = new Hook(); hook.render()
  await wait(() => calls.some(item => item.method === 'runtime.historySession'), 'active history selection')
  const before = calls.filter(item => item.method === 'runtime.historyList').length
  const refreshes = Array.from({ length: 40 }, () => hook.value.refresh())
  for (let index = 0; index < 40; index++) { for (const listener of resets) listener({ projectRoot: root }); hook.render() }
  // Actual status notifications also request a refresh while the replies are held.
  for (const listener of states) listener({ projectRoot: root, sessionId: selection, status: 'busy' })
  for (const listener of listeners) listener({ source: 'runtime', root: root.toLowerCase().replaceAll('\\', '/') })
  await new Promise(done => setTimeout(done, 260))
  const heldLists = calls.filter(item => item.method === 'runtime.historyList').length - before
  const heldSelections = calls.filter(item => item.method === 'runtime.historySession').length
  console.log(JSON.stringify({ stage: 'held-replies', heldLists, heldSelections, attempts: Object.fromEntries([...new Set(attempts)].map(method => [method, attempts.filter(item => item === method).length])), failures: failures.length, clientConnected: client.connected, unavailable: broadcasts.filter(item => item.channel === binding.ipcEvent.daemonRuntimeUnavailable).length }))
  hold.resolve(); selectedHold.resolve(); gates.clear()
  await Promise.all(refreshes)
  await new Promise(done => setTimeout(done, 60)); hook.render()
  assert.ok(heldLists <= 1, 'overlapping list refreshes must share one read')
  assert.equal(heldSelections, 1, 'selection metadata and transcript must share the existing serialized read lane')
  assert.equal(hook.value.error, '', 'a valid delayed read must not create a queue-full history error')
  assert.equal(client.connected, true, 'ordinary read pressure must retain the authenticated connection')
  assert.equal(broadcasts.filter(item => item.channel === binding.ipcEvent.daemonRuntimeUnavailable).length, 0, 'read pressure is not transport loss')
  await wait(() => calls.some(item => item.method === 'runtime.historyEvents'), 'selected transcript read')
  await new Promise(done => setTimeout(done, 30)); hook.render()
  assert.equal(hook.value.selectedSession?.status, 'disconnected', 'archived native status must stay unchanged')
  assert.ok(calls.filter(item => ['runtime.historyList', 'runtime.historySession', 'runtime.historyEvents'].includes(item.method)).every(item => item.commandId === undefined), 'ordinary reads do not invent mutation receipts')
  for (let index = 0; index < 200; index++) binding.facade.routeWatcherEvent(root, join(root, 'out', `build-${index}.js`), 'change')
  await new Promise(done => setTimeout(done, 20))
  assert.equal(attempts.filter(method => method === 'runtime.watcher').length, 0, 'non-Trellis filesystem noise is filtered before transport admission')
  binding.facade.routeWatcherEvent(root, join(root, '.trellis', 'spec', 'backend', 'fixture.md'), 'change')
  await wait(() => calls.some(item => item.method === 'runtime.watcher'), 'relevant watcher hint retained')
  console.log('PASS coalesced history refresh/active selection/event burst over authenticated isolated pipe')

  const filters = deferred(); gates.set('runtime.historyList', filters)
  hook.value.setQuery('old query'); hook.render()
  await wait(() => calls.some(item => item.method === 'runtime.historyList' && item.body.inline.input?.query === 'old query'), 'old query read')
  hook.value.setQuery('latest query'); hook.value.setArchive('archived'); hook.render()
  const latestRefresh = hook.value.refresh()
  filters.resolve(); gates.delete('runtime.historyList')
  await latestRefresh; hook.render()
  assert.equal(hook.value.sessions[0]?.title, 'latest query', 'only the latest query result is installed')
  assert.deepEqual(calls.filter(item => item.method === 'runtime.historyList').at(-1).body.inline.input, { query: 'latest query', archive: 'archived' })
  busyList = true
  await hook.value.refresh(); hook.render()
  assert.ok(hook.value.error.includes('busy') && !hook.value.error.includes('原命令'), 'operational read failure remains visible without a fictional receipt')
  assert.equal(client.connected, true)
  busyList = false
  await hook.value.refresh(); hook.render()
  assert.equal(hook.value.error, '')
  console.log('PASS latest query/archive coalescing and visible read failure/recovery')

  const hint = () => { for (const listener of listeners) listener({ source: 'runtime', root: root.toLowerCase().replaceAll('\\', '/') }) }
  const previousReplay = attempts.filter(method => method === 'runtime.events').length
  const previousUnsubscribe = calls.filter(item => item.method === 'events.unsubscribe').length
  busyReplay = true; replaySequence++
  hint()
  await wait(() => failures.some(item => item.method === 'runtime.events' && item.code === 'E_BUSY'), 'known server read backpressure')
  assert.equal(client.connected, true)
  assert.equal(calls.filter(item => item.method === 'events.unsubscribe').length, previousUnsubscribe, 'busy replay retains its subscription')
  assert.equal(broadcasts.filter(item => item.channel === binding.ipcEvent.daemonRuntimeUnavailable).length, 0)
  const retryCursor = calls.filter(item => item.method === 'runtime.events').at(-1).body.inline.after
  for (let index = 0; index < 100; index++) hint()
  await new Promise(done => setTimeout(done, 100))
  assert.equal(attempts.filter(method => method === 'runtime.events').length, previousReplay + 1, 'hints cannot bypass busy replay backoff')
  busyReplay = false
  await wait(() => calls.filter(item => item.method === 'runtime.events').length >= previousReplay + 2, 'read-only replay recovery')
  assert.deepEqual(calls.filter(item => item.method === 'runtime.events').at(-1).body.inline.after, retryCursor, 'busy response does not consume the replay cursor')
  console.log('PASS server E_BUSY keeps exact cursor/grant/socket and coalesces hints during backoff')

  // Exercise the unchanged real local/server 16-call budget and reserved controls.
  const saturation = deferred(); gates.set('runtime.profiles', saturation)
  const profileReads = Array.from({ length: binding.DAEMON_LIMITS.pendingCalls }, () => client.request('runtime.profiles', { inline: {} }, { workspace: grant }))
  await wait(() => calls.filter(item => item.method === 'runtime.profiles').length === binding.DAEMON_LIMITS.pendingCalls, 'ordinary budget filled')
  const rejectedRead = await binding.facade.listAcpHistorySessions(root)
  assert.equal(rejectedRead.code, 'E_BUSY')
  assert.ok(!('commandId' in rejectedRead) && !rejectedRead.error.includes('原命令'), 'non-admitted read keeps its error without a fictional command receipt')
  const control = await pool.getControl()
  assert.equal((await control.request('daemon.status', {})).ok, true, 'status remains independently admissible')
  assert.equal((await binding.facade.cancelAcpSession(root, selection)).ok, true, 'cancel remains independently admissible')
  assert.equal((await binding.facade.respondAcpPermission(root, 'original-permission', 'original-option')).ok, true, 'permission remains independently admissible')
  stop(); stop = undefined
  await new Promise(done => setTimeout(done, 30))
  assert.equal(client.connected, true, 'unsubscribe non-admission must not close the shared socket')
  saturation.resolve(); gates.delete('runtime.profiles')
  assert.ok((await Promise.all(profileReads)).every(item => item.ok))
  await wait(() => calls.filter(item => item.method === 'events.unsubscribe').length === previousUnsubscribe + 1, 'original subscription eventually released')
  const controls = calls.filter(item => ['runtime.cancel', 'runtime.permission'].includes(item.method))
  assert.equal(controls.length, 2)
  assert.ok(controls.every(item => typeof item.commandId === 'string'))
  assert.deepEqual(controls.find(item => item.method === 'runtime.permission').body.inline, { requestId: 'original-permission', optionId: 'original-option' })
  const originalCommand = randomUUID()
  await assert.rejects(binding.runtimeCall(root, 'runtime.prompt', { sessionId: selection, text: 'fixture command' }, originalCommand), error => error.code === 'E_BUSY' && error.outcome === 'not-admitted' && error.commandId === originalCommand && error.message.includes(originalCommand))
  assert.equal(calls.filter(item => item.method === 'runtime.prompt' && item.commandId === originalCommand).length, 1, 'mutations never replay automatically')
  const facadeRejection = await binding.facade.promptAcpSession(root, selection, 'fixture command')
  assert.equal(facadeRejection.code, 'E_BUSY')
  assert.equal(facadeRejection.outcome, 'not-admitted')
  assert.ok(typeof facadeRejection.commandId === 'string' && facadeRejection.error.includes(facadeRejection.commandId))
  console.log('PASS exact admission bound, independent status/cancel/permission, subscription release and original mutation receipt')

  // A changed pinned epoch must still fail closed without a replacement grant.
  const beforeAttach = calls.filter(item => item.method === 'runtime.events').length
  stop = binding.observeRuntime(root)
  await wait(() => calls.filter(item => item.method === 'runtime.events').length > beforeAttach, 'reattach original observer')
  fixture.lease = { ...lease, epoch: randomUUID() }
  hint()
  await wait(() => broadcasts.some(item => item.channel === binding.ipcEvent.daemonRuntimeUnavailable), 'changed epoch outage')
  assert.equal(client.connected, false)
  assert.equal(calls.filter(item => item.method === 'workspace.grant').length, 0, 'epoch recovery does not mint a replacement grant')
  fixture.lease = lease
  await wait(() => calls.filter(item => item.method === 'runtime.events').length > beforeAttach + 1, 'original epoch read-only reattachment')
  console.log('PASS epoch mismatch fails closed and restores only the original read/subscription state')

  // A real socket loss still emits outage and cannot alter archived native state.
  const outages = broadcasts.filter(item => item.channel === binding.ipcEvent.daemonRuntimeUnavailable).length
  await server.close(); server = undefined
  await wait(() => broadcasts.filter(item => item.channel === binding.ipcEvent.daemonRuntimeUnavailable).length > outages, 'real disconnected transport outage')
  assert.equal(client.connected, false)
  hook.render()
  assert.equal(hook.value.selectedSession?.status, 'disconnected')
  console.log('PASS genuine transport loss remains observable; stored native disconnected status is preserved')
} finally {
  hook?.dispose(); stop?.(); binding?.detachRuntimeObservers()
  for (const gate of gates.values()) gate.resolve()
  await server?.close()
  delete globalThis.__DAEMON_READ_FIXTURE__
  rmSync(temporary, { recursive: true, force: true })
}
