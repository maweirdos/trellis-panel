import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-app-races-'))
const project = join(temporary, 'project')
mkdirSync(project)
const state = {
  rows: [], children: new Map(), spawns: 0, failSnapshots: false, failWrites: false,
  orphanOnSpawn: false, holdNext: false, pendingObservation: false, releaseObservation: null,
  snapshot() {
    if (this.failSnapshots) return Promise.reject(Error('fixture observation unavailable'))
    const snapshot = this.rows.map(row => ({ ...row }))
    if (this.holdNext) {
      this.holdNext = false
      this.pendingObservation = true
      return new Promise(done => { this.releaseObservation = () => { this.pendingObservation = false; done(snapshot) } })
    }
    return Promise.resolve(snapshot)
  },
  spawn(executable) {
    this.spawns += 1
    const pid = 10000 + this.spawns
    const row = { pid, parentPid: process.pid, createdAt: String(BigInt(Date.now()) * 10000n + 621355968000000000n), executable, commandHash: 'owned-' + pid }
    const child = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() })
    this.rows.push(row)
    this.children.set(pid, child)
    const orphan = this.orphanOnSpawn
    this.orphanOnSpawn = false
    queueMicrotask(() => {
      child.emit('spawn')
      if (orphan) {
        this.close(child)
        this.rows.push({ ...row, pid: pid + 100000, parentPid: pid, commandHash: 'unverified-child' })
      }
    })
    return child
  },
  close(child) {
    this.rows = this.rows.filter(row => row.pid !== child.pid)
    child.exitCode = 0
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
  },
  terminate(identities) {
    for (const identity of identities) {
      const child = this.children.get(identity.pid)
      if (child && child.exitCode === null) this.close(child)
    }
    return Promise.resolve()
  }
}
globalThis.__APP_RUNTIME_REVIEW_FIXTURE__ = state
let runtime
let recovered
const wait = ms => new Promise(done => setTimeout(done, ms))
async function until(condition, limit = 6000) {
  const end = Date.now() + limit
  while (Date.now() < end) { if (await condition()) return; await wait(25) }
  throw Error('fixture state was not reached')
}
try {
  const persistence = resolve('src/main/services/app-runtime/lib/persistence.ts')
  const processTree = resolve('src/main/services/app-runtime/lib/process-tree.ts')
  const mocks = {
    electron: `export const app={isPackaged:false,getPath:()=>${JSON.stringify(temporary)}};export const safeStorage={isEncryptionAvailable:()=>false};`,
    './process-tree': `export {ownedTree,sameProcess} from ${JSON.stringify(processTree)};const fixture=globalThis.__APP_RUNTIME_REVIEW_FIXTURE__;export const processSnapshot=()=>fixture.snapshot();export const spawnOwned=(...args)=>fixture.spawn(...args);export const terminateOwned=(...args)=>fixture.terminate(...args);`,
    './persistence': `export * from ${JSON.stringify(persistence)};import {writeProject as actualWrite} from ${JSON.stringify(persistence)};export function writeProject(store){if(globalThis.__APP_RUNTIME_REVIEW_FIXTURE__.failWrites)throw Error('fixture write denied');return actualWrite(store);}`
  }
  const entry = join(temporary, 'entry.ts')
  writeFileSync(entry, `export {ApplicationRuntime} from ${JSON.stringify(resolve('src/main/services/app-runtime/index.ts'))};export {readProject,writeProject} from ${JSON.stringify(persistence)};`)
  await build({ entryPoints: [entry], outfile: join(temporary, 'runtime.cjs'), bundle: true, platform: 'node', format: 'cjs', nodePaths: [resolve('node_modules')], plugins: [{ name: 'controlled-owned-runtime', setup(builder) {
    builder.onResolve({ filter: /^(electron|\.\/(process-tree|persistence))$/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js', resolveDir: process.cwd() }))
  } }] })
  const require = createRequire(import.meta.url)
  const api = require(join(temporary, 'runtime.cjs'))
  runtime = new api.ApplicationRuntime()
  const config = id => ({ id, name: id, cwd: '.', launch: { kind: 'argv', executable: process.execPath, args: [] }, stopTimeoutMs: 1000 })
  const save = async id => { const result = await runtime.save(project, { config: config(id) }); assert.equal(result.ok, true, result.error); return result.app }
  const start = id => runtime.start(project, id, { confirm: async () => true })

  let application = await save('deleted-before-start')
  const before = state.spawns
  const deletedStart = await Promise.all([runtime.remove(project, application.definition.id, application.definition.revision), start(application.definition.id)])
  assert.equal(deletedStart[0].ok, true)
  assert.equal(deletedStart[1].ok, false, 'queued start cannot execute an entry deleted before it runs')
  assert.equal(state.spawns, before, 'a deleted entry never creates an unregistered process')
  assert.equal((await runtime.get(project, application.definition.id)).code, 'E_NOT_FOUND')
  application = await save('deleted-before-save')
  const deletedSave = await Promise.all([runtime.remove(project, application.definition.id, application.definition.revision), runtime.save(project, { config: config(application.definition.id), expectedRevision: application.definition.revision })])
  assert.equal(deletedSave[0].ok, true)
  assert.equal(deletedSave[1].code, 'E_CONFLICT', 'stale save cannot resurrect a removed definition')
  assert.equal((await runtime.get(project, application.definition.id)).code, 'E_NOT_FOUND')
  console.log('PASS deletion races cannot launch an unregistered process or resurrect stale configuration')

  await save('close-observation-failure')
  const running = await start('close-observation-failure')
  state.failSnapshots = true
  state.close(state.children.get(running.app.run.pid))
  await until(async () => (await runtime.get(project, 'close-observation-failure')).app.processState !== 'running')
  assert.equal((await runtime.get(project, 'close-observation-failure')).app.processState, 'cleanup-required', 'natural close cannot overwrite failed tree verification with exited')
  state.failSnapshots = false
  assert.equal((await runtime.stop(project, 'close-observation-failure')).ok, true)

  await save('early-orphan')
  state.orphanOnSpawn = true
  const orphanStart = await start('early-orphan')
  await wait(25)
  const orphan = await runtime.get(project, 'early-orphan')
  assert.equal(orphan.app.processState, 'cleanup-required', 'unverified descendants cannot be hidden by close handling')
  assert.equal(orphan.app.canStart, false)
  assert.equal((await runtime.stop(project, 'early-orphan')).ok, false, 'unknown child ownership is not silently declared stopped')
  state.rows = []
  assert.equal((await runtime.stop(project, 'early-orphan')).ok, true)

  const store = api.readProject(project)
  const stored = store.applications.find(item => item.config.id === 'early-orphan')
  stored.lastRun = { ...stored.lastRun, state: 'running', pid: orphanStart.app.run.pid, identities: [] }
  api.writeProject(store)
  state.rows = [{ pid: orphanStart.app.run.pid + 100000, parentPid: orphanStart.app.run.pid, createdAt: '1', executable: process.execPath, commandHash: 'unverified' }]
  recovered = new api.ApplicationRuntime()
  assert.equal((await recovered.get(project, 'early-orphan')).app.processState, 'unknown', 'missing root with no saved identity cannot establish complete tree exit')
  assert.equal((await recovered.stop(project, 'early-orphan')).ok, false, 'recovery cannot forget an unverified direct descendant')
  state.rows = []
  assert.equal((await recovered.stop(project, 'early-orphan')).ok, false, 'absence of a PID is not complete ownership evidence when no creation identity was saved')
  assert.equal(await recovered.hasOwnedApplications(), true)
  await assert.rejects(recovered.shutdown(), /清理/)
  recovered = undefined
  console.log('PASS failed exit observation and unverified live/recovered descendants preserve unresolved ownership')

  await save('monitor-race')
  const first = await start('monitor-race')
  state.holdNext = true
  await until(() => state.pendingObservation)
  const replacement = await runtime.restart(project, 'monitor-race')
  assert.equal(replacement.ok, true, replacement.error)
  assert.notEqual(replacement.app.run.id, first.app.run.id)
  state.releaseObservation()
  await wait(25)
  assert.equal((await runtime.stop(project, 'monitor-race')).ok, true, 'late old observation must not corrupt replacement ownership')
  console.log('PASS delayed monitor from an old run cannot overwrite replacement process identity')

  await save('persist-failure')
  assert.equal((await start('persist-failure')).ok, true)
  assert.equal((await runtime.stop(project, 'persist-failure')).ok, true)
  const beforeFailedStart = state.spawns
  state.failWrites = true
  assert.equal((await start('persist-failure')).ok, false)
  const failed = await runtime.get(project, 'persist-failure')
  assert.equal(failed.app.processState, 'failed', 'pre-spawn persistence failure is not a stranded starting application')
  assert.equal(state.spawns, beforeFailedStart)
  assert.equal(failed.app.canStart, true)
  state.failWrites = false
  assert.equal((await start('persist-failure')).ok, true, 'failed pre-spawn attempt can be retried after persistence recovers')
  assert.equal((await runtime.stop(project, 'persist-failure')).ok, true)
  console.log('PASS failed pre-spawn persistence creates no process and remains safely retryable')
} finally {
  state.failWrites = false
  state.failSnapshots = false
  state.releaseObservation?.()
  for (const child of state.children.values()) if (child.exitCode === null) state.close(child)
  state.rows = []
  if (runtime) await runtime.shutdown()
  delete globalThis.__APP_RUNTIME_REVIEW_FIXTURE__
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('tpanel-app-races-'))
  rmSync(temporary, { recursive: true, force: true })
}
