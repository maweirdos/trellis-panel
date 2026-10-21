import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-git-ipc-'))
const rootA = join(temporary, 'a')
const rootB = join(temporary, 'b')
mkdirSync(rootA)
mkdirSync(rootB)
const revision = 'a'.repeat(64)
const fixture = {
  root: rootA, generation: 0, response: 0, switchDuringReview: false, reviewRoot: null,
  handlers: new Map(), effects: [], reviews: [], events: [], delay: null, reads: [], readDelay: null,
  async nativeReview(options) {
    this.reviews.push(options)
    if (this.switchDuringReview) this.generation += 2
    return { response: this.response }
  }
}
const denied = () => ({ ok: false, code: 'E_CONFLICT', error: 'stale scope' })
fixture.service = {
  async status(root) { return { ok: true, root, snapshot: { root, repoRoot: root, revision } } },
  async stage(root, input, context) {
    if (fixture.delay) await fixture.delay
    if (!context.guard()) return denied()
    fixture.effects.push({ root, operation: 'stage', paths: input.paths })
    return { ok: true, root, snapshot: { revision }, message: 'staged' }
  },
  async unstage(root, input, context) { return this.stage(root, input, context) },
  async createBranch(root, input, context) { return this.stage(root, { paths: [input.name] }, context) },
  async switchBranch(root, input, context) { return this.stage(root, { paths: [input.name] }, context) },
  async commit(root, input, context) {
    if (!context.guard()) return denied()
    if (!await context.review({ kind: 'commit', root: fixture.reviewRoot ?? root, revision, branch: 'main', paths: ['one.txt', 'two.txt'], message: input.message })) return { ok: false, code: 'E_DENIED', error: 'cancelled' }
    fixture.effects.push({ root, operation: 'commit' })
    return { ok: true, root, snapshot: { revision }, message: 'committed' }
  },
  async push(root, input, context) {
    if (!context.guard()) return denied()
    if (!await context.review({ kind: 'push', root, revision, branch: 'main', paths: [], remote: input.remote, remoteBranch: input.remoteBranch, remoteUrl: 'https://example.invalid/repository.git' })) return { ok: false, code: 'E_DENIED', error: 'cancelled' }
    fixture.effects.push({ root, operation: 'push' })
    return { ok: true, root, snapshot: { revision }, message: 'pushed' }
  }
}
globalThis.__GIT_WORKSPACE_IPC__ = fixture
try {
  const mocks = {
    electron: 'export const dialog={showMessageBox:(_window,options)=>globalThis.__GIT_WORKSPACE_IPC__.nativeReview(options)};export const ipcMain={handle:(name,fn)=>globalThis.__GIT_WORKSPACE_IPC__.handlers.set(name,fn)};export const app={getPath:()=>""};',
    '../state': 'export const getProjectRoot=()=>globalThis.__GIT_WORKSPACE_IPC__.root;export const getProjectGeneration=()=>globalThis.__GIT_WORKSPACE_IPC__.generation;',
    '../services/git-workspace': 'export const gitWorkspace=globalThis.__GIT_WORKSPACE_IPC__.service;',
    '../services/git': 'export const clearGitCache=()=>{};',
    '../services/devtools-git': 'export const gitReadonlyFileDiff=async(root,path,staged)=>{const f=globalThis.__GIT_WORKSPACE_IPC__;f.reads.push({root,path,staged});if(f.readDelay)await f.readDelay;return{ok:true,path,staged,diff:"",added:0,removed:0,binary:false,truncated:false}};',
    '../services/access/event-log': 'export const accessEventLog={append:(type,payload)=>globalThis.__GIT_WORKSPACE_IPC__.events.push({type,payload})};'
  }
  await build({ entryPoints: ['src/main/ipc/git-workspace.ts'], outfile: join(temporary, 'ipc.cjs'), bundle: true, platform: 'node', format: 'cjs', plugins: [{ name: 'git-ipc-fixture', setup(builder) {
    builder.onResolve({ filter: /^(electron|\.\.\/(state|services\/(git-workspace|git|devtools-git|access\/event-log)))$/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js', resolveDir: process.cwd() }))
  } }] })
  createRequire(import.meta.url)(join(temporary, 'ipc.cjs')).registerGitWorkspaceIpc({ getMain: () => ({ webContents: { id: 42 } }) })
  assert.equal(fixture.handlers.size, 8)
  const call = (operation, input, sender = 42) => fixture.handlers.get(`gitWorkspace:${operation}`)({ sender: { id: sender } }, input)
  const paths = { expectedRoot: rootA, revision, confirm: true, paths: ['one.txt'] }
  fixture.root = null
  assert.equal((await call('status', { expectedRoot: rootA })).code, 'E_NO_PROJECT')
  fixture.root = rootB
  assert.equal((await call('stage', paths)).code, 'E_CONFLICT')
  fixture.root = rootA
  assert.equal((await call('stage', paths, 99)).code, 'E_DENIED')
  assert.equal((await call('stage', { ...paths, confirm: false })).code, 'E_INVALID_ARG')
  assert.equal((await call('stage', { ...paths, command: 'git reset --hard' })).code, 'E_INVALID_ARG')
  assert.equal((await call('stage', { ...paths, paths: [] })).code, 'E_INVALID_ARG')
  assert.equal(fixture.effects.length, 0)
  assert.equal((await call('status', { expectedRoot: rootA })).root, rootA)
  assert.equal((await call('diff', { expectedRoot: rootA, path: 'one.txt', staged: false })).root, rootA)
  assert.deepEqual(fixture.reads.pop(), { root: rootA, path: 'one.txt', staged: false })
  let finishRead
  fixture.readDelay = new Promise(done => { finishRead = done })
  const oldRead = call('diff', { expectedRoot: rootA, path: 'one.txt', staged: false })
  await new Promise(done => setImmediate(done))
  fixture.generation += 2
  finishRead()
  assert.equal((await oldRead).code, 'E_CONFLICT', 'old project-generation diff is not returned as current data')
  fixture.readDelay = null
  assert.equal((await call('stage', paths)).ok, true)
  assert.deepEqual(fixture.effects.pop(), { root: rootA, operation: 'stage', paths: ['one.txt'] })

  let release
  fixture.delay = new Promise(done => { release = done })
  const queued = call('stage', paths)
  await new Promise(done => setImmediate(done))
  fixture.generation += 2
  release()
  assert.equal((await queued).ok, false, 'queued A to B to A action is rejected inside the mutation guard')
  assert.equal(fixture.effects.length, 0)
  fixture.delay = null

  const commit = { expectedRoot: rootA, revision, confirm: true, message: 'private test message' }
  assert.equal((await call('commit', commit)).code, 'E_DENIED')
  assert.equal(fixture.effects.length, 0, 'native cancellation performs no mutation')
  assert.ok(fixture.reviews.at(-1).detail.includes('one.txt'))
  assert.ok(fixture.reviews.at(-1).detail.includes(rootA), 'native review identifies the captured project')
  fixture.response = 1
  fixture.switchDuringReview = true
  assert.equal((await call('commit', commit)).code, 'E_DENIED')
  assert.equal(fixture.effects.length, 0, 'generation changes revoke a pending native review')
  fixture.switchDuringReview = false
  fixture.reviewRoot = rootB
  const reviewCount = fixture.reviews.length
  assert.equal((await call('commit', commit)).code, 'E_DENIED')
  assert.equal(fixture.reviews.length, reviewCount, 'foreign preview cannot open a confirmation')
  fixture.reviewRoot = null
  assert.equal((await call('commit', commit)).ok, true)
  assert.deepEqual(fixture.effects.pop(), { root: rootA, operation: 'commit' })
  assert.equal((await call('push', { expectedRoot: rootA, revision, confirm: true, remote: 'origin', branch: 'main', remoteBranch: 'main' })).ok, true)
  assert.deepEqual(fixture.effects.pop(), { root: rootA, operation: 'push' })
  assert.ok(!JSON.stringify(fixture.events).includes('private test message'), 'event log contains operation summaries only')
  console.log('PASS actual Git IPC handlers: eight registered routes, main-window/root/schema guards, queued stale generations, native commit/push review and cancellation, summary-only events')
} finally {
  delete globalThis.__GIT_WORKSPACE_IPC__
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('tpanel-git-ipc-'))
  rmSync(temporary, { recursive: true, force: true })
}
