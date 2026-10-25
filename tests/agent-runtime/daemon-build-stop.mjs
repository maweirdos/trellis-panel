import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-daemon-build-stop-'))
const key = `__daemonStop${randomUUID().replaceAll('-', '')}`
const signal = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
let sequence = 0
try {
  globalThis[key] = { owner: null, pause: null }
  const file = join(temporary, 'stop.cjs')
  await build({ stdin: { contents: `export {DaemonDispatcher} from './src/main/daemon/dispatcher';export {DaemonRepository} from './src/main/daemon/repository';export {DaemonError} from './src/main/daemon/errors';export {daemonPayloads} from './src/shared/daemon'`, resolveDir: process.cwd(), loader: 'ts' }, outfile: file, bundle: true, platform: 'node', format: 'cjs', plugins: [{ name: 'owned-native', setup(builder) {
    builder.onResolve({ filter: /^electron$|(^|\/)native$|(^|\/)acp\/metadata$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'electron' ? 'export const app={isPackaged:false}' : args.path.endsWith('native')
      ? `const s=globalThis[${JSON.stringify(key)}];export const sameOwner=(a,b)=>a.pid===b.pid&&a.startedAt===b.startedAt&&a.userId===b.userId&&a.executable===b.executable;export const processIdentity=async()=>{await s.pause?.promise;return s.owner};export const powershellPath=()=>{throw Error('No real native commands')};export const nativeResource=()=>{throw Error('No real native commands')}`
      : 'export const canonicalDirectory=value=>value' }))
  } }] })
  const { DaemonDispatcher, DaemonRepository, DaemonError, daemonPayloads } = createRequire(import.meta.url)(file)
  function fixture({ nativeIdle = true, guard = true } = {}) {
    const directory = join(temporary, `case-${sequence++}`); mkdirSync(join(directory, 'owner'), { recursive: true })
    const owner = { pid: 100, startedAt: '639283392000000000', userId: 'fixture-user', executable: 'C:\\fixture\\electron.exe' }
    const identity = { profileId: 'a'.repeat(64), userId: owner.userId, mode: 'development', appVersion: '0.1.0', installationId: 'b'.repeat(64) }
    const context = { directory, owner, identity }, lease = { version: 1, epoch: randomUUID(), nonce: randomUUID(), identity, owner, acquiredAt: Date.now() }
    const leaseFile = join(directory, 'owner', 'lease.json'); writeFileSync(leaseFile, JSON.stringify(lease))
    globalThis[key].owner = owner; globalThis[key].pause = null
    const repository = new DaemonRepository(directory, lease.epoch, () => {}, owner)
    const scheduler = { closed: false, running: false, stops: 0, hasRunning() { return this.running }, closeAdmission() { this.closed = true }, async shutdown() { this.stops++ } }
    const domains = { ready: () => true, handles: method => method === 'runtime.status', dispatch: async () => ({ fixture: true }), observeRuntime: () => () => {}, async poll() {}, async withWorkspaceChange() {}, forced: 0, guarded: 0, async shutdown() { this.forced++ } }
    if (guard) domains.shutdownIfIdle = async () => { domains.guarded++; if (!nativeIdle) throw new DaemonError('E_BUSY', 'Native sessions/workflows/provider work remain active.') }
    let exits = 0
    const dispatcher = new DaemonDispatcher(context, lease, repository, { authority: () => 'daemon' }, scheduler, { append() {}, page() { return {} } }, () => { exits++ }, domains)
    const request = (method = 'daemon.stop', payload = { expectedOwner: owner, idleOnly: true }, commandId = randomUUID()) => ({ type: 'request', version: 1, requestId: randomUUID(), expectedEpoch: lease.epoch, method, payload, commandId })
    const stop = () => dispatcher.dispatch(request(), owner)
    return { context, lease, leaseFile, owner, repository, scheduler, domains, dispatcher, request, stop, exits: () => exits }
  }
  for (const state of ['queued', 'running', 'paused', 'cancel-requested', 'unknown']) {
    const f = fixture(); f.repository.allJobs = () => [{ state }]
    await assert.rejects(f.stop(), error => error.code === 'E_BUSY')
    assert.equal(f.scheduler.closed, false); assert.equal(f.domains.guarded, 0); assert.equal(f.domains.forced, 0); assert.equal(f.exits(), 0)
    assert.deepEqual(await f.dispatcher.dispatch(f.request('runtime.status', {}), f.owner), { fixture: true }, 'known busy refusal reopens RPC admission')
  }
  for (const options of [{ nativeIdle: false }, { guard: false }]) {
    const f = fixture(options)
    await assert.rejects(f.stop(), error => error.code === 'E_BUSY')
    assert.equal(f.scheduler.closed, false); assert.equal(f.domains.forced, 0); assert.equal(f.exits(), 0)
  }
  {
    const f = fixture(); f.scheduler.running = true
    await assert.rejects(f.stop(), error => error.code === 'E_BUSY')
    assert.equal(f.scheduler.closed, false)
  }
  for (const operation of ['rpc', 'poll']) {
    const f = fixture(), pause = signal()
    f.domains.dispatch = () => pause.promise
    const running = operation === 'rpc' ? f.dispatcher.dispatch(f.request('runtime.status', {}), f.owner) : f.dispatcher.backgroundPoll(() => pause.promise)
    await assert.rejects(f.stop(), error => error.code === 'E_BUSY')
    assert.equal(f.domains.guarded, 0); assert.equal(f.scheduler.closed, false)
    pause.resolve(); await running
  }
  {
    const f = fixture(), pause = signal(); globalThis[key].pause = pause
    const request = f.request()
    const first = f.dispatcher.dispatch(request, f.owner)
    await Promise.resolve(); await Promise.resolve()
    await assert.rejects(f.dispatcher.dispatch(f.request('runtime.status', {}), f.owner), error => error.code === 'E_BUSY', 'admission closes before awaited native identity check')
    let polls = 0; await f.dispatcher.backgroundPoll(async () => { polls++ }); assert.equal(polls, 0)
    assert.equal((await f.dispatcher.dispatch(f.request('daemon.status', {}), f.owner)).state, 'running', 'management status remains readable')
    const duplicate = f.dispatcher.dispatch({ ...request, requestId: randomUUID() }, f.owner)
    await assert.rejects(f.dispatcher.dispatch({ ...request, payload: { expectedOwner: f.owner } }, f.owner), error => error.code === 'E_CONFLICT', 'same original command cannot switch from idle-only to force')
    pause.resolve(); await first; await duplicate
    assert.equal(f.domains.guarded, 1); assert.equal(f.domains.forced, 0); assert.equal(f.scheduler.stops, 1); assert.equal(f.exits(), 1)
    assert.deepEqual(await f.dispatcher.dispatch(request, f.owner), { state: 'stopping' })
    assert.equal(f.exits(), 1, 'committed original stop deduplicates without another exit/effect')
    await assert.rejects(f.dispatcher.dispatch({ ...request, payload: { expectedOwner: f.owner } }, f.owner), error => error.code === 'E_CONFLICT')
  }
  {
    const f = fixture(), pause = signal(); globalThis[key].pause = pause
    const stopping = f.stop(); await Promise.resolve(); await Promise.resolve()
    writeFileSync(f.leaseFile, JSON.stringify({ ...f.lease, epoch: randomUUID(), nonce: randomUUID() }))
    pause.resolve()
    await assert.rejects(stopping, error => error.code === 'E_CONFLICT')
    assert.equal(f.domains.guarded, 0); assert.equal(f.domains.forced, 0); assert.equal(f.scheduler.closed, false); assert.equal(f.exits(), 0)
  }
  {
    const f = fixture(); globalThis[key].owner = { ...f.owner, startedAt: '639283392000000001' }
    await assert.rejects(f.stop(), error => error.code === 'E_CONFLICT')
    assert.equal(f.exits(), 0)
  }
  {
    const f = fixture({ nativeIdle: false })
    const request = f.request('daemon.stop', { expectedOwner: f.owner })
    await f.dispatcher.dispatch(request, f.owner)
    assert.equal(f.domains.forced, 1); assert.equal(f.domains.guarded, 0); assert.equal(f.exits(), 1)
  }
  {
    const f = fixture()
    await assert.rejects(f.dispatcher.dispatch(f.request('daemon.stop', { expectedOwner: { ...f.owner, pid: 999 }, idleOnly: true }), f.owner), error => error.code === 'E_CONFLICT')
    await assert.rejects(f.dispatcher.dispatch({ ...f.request(), expectedEpoch: randomUUID() }, f.owner), error => error.code === 'E_CONFLICT')
    assert.equal(daemonPayloads['daemon.stop'].safeParse({ expectedOwner: f.owner, idleOnly: false }).success, false)
    assert.equal(daemonPayloads['daemon.stop'].safeParse({ expectedOwner: f.owner, idleOnly: true, arbitraryAction: 'stop' }).success, false)
    assert.equal(f.exits(), 0)
  }
  console.log('PASS daemon guarded stop: jobs/native busy, in-flight RPC/polls, atomic admission, exact stop dedup, owner races, explicit force and strict payloads')
} finally {
  delete globalThis[key]
  assert.ok(temporary.startsWith(join(tmpdir(), 'trellis-daemon-build-stop-')))
  rmSync(temporary, { recursive: true, force: true })
}
