import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-app-ipc-'))
const rootA = join(temporary, 'project-a')
const rootB = join(temporary, 'project-b')
mkdirSync(rootA)
mkdirSync(rootB)
const handlers = new Map()
const calls = []
let root = rootA
let listener
let response = 0
let switchWhileConfirming = false
let generation = 0
let roundTripWhileConfirming = false
const fixture = {
  get root() { return root },
  handlers,
  broadcasts: [],
  get generation() { return generation },
  async confirm() { if (switchWhileConfirming) { root = rootB; generation += 1 }; if (roundTripWhileConfirming) { generation += 2 }; return { response } },
  runtime: {
    subscribe(callback) { listener = callback; return () => {} },
    async list(project) { calls.push(['list', project]); return { ok: true, root: project, apps: [] } },
    async save(project, input) { calls.push(['save', project, input]); return { ok: true, root: project } },
    async remove(project, id, revision) { calls.push(['remove', project, id, revision]); return { ok: true, root: project } },
    async importNpm(project, dir, script, name) { calls.push(['import', project, dir, script, name]); return { ok: true, root: project } },
    async start(project, id, options) {
      const accepted = await options.confirm({ root: project, appId: id, revision: 'rev', name: 'Fixture', cwd: project, command: 'node app.cjs', envFiles: ['.env'], overrideKeys: ['TOKEN'], ports: [], action: 'start' })
      calls.push(['start', project, id, accepted])
      return accepted ? { ok: true, root: project } : { ok: false, code: 'E_DENIED', error: 'cancelled' }
    },
    async restart(project, id, options) { return this.start(project, id, options) },
    async stop(project, id) { calls.push(['stop', project, id]); return { ok: true, root: project } },
    async logs(project, id, after) { calls.push(['logs', project, id, after]); return { ok: true, root: project, output: '' } }
  }
}
globalThis.__APP_IPC_FIXTURE__ = fixture
try {
  const mocks = {
    electron: `export const dialog={showMessageBox:()=>globalThis.__APP_IPC_FIXTURE__.confirm()};export const ipcMain={handle:(name,fn)=>globalThis.__APP_IPC_FIXTURE__.handlers.set(name,fn)};export const app={getPath:()=>${JSON.stringify(temporary)}};`,
    '../state': 'export const getProjectRoot=()=>globalThis.__APP_IPC_FIXTURE__.root;export const getProjectGeneration=()=>globalThis.__APP_IPC_FIXTURE__.generation;',
    '../services/app-runtime': 'export const appRuntime=globalThis.__APP_IPC_FIXTURE__.runtime;',
    '../services/bridge': 'export const broadcastToWindows=(channel,event)=>globalThis.__APP_IPC_FIXTURE__.broadcasts.push({channel,event});'
  }
  await build({
    entryPoints: ['src/main/ipc/app-runtime.ts'], outfile: join(temporary, 'ipc.cjs'), bundle: true, platform: 'node', format: 'cjs',
    plugins: [{ name: 'owned-ipc-fixture', setup(builder) {
      builder.onResolve({ filter: /^(electron|\.\.\/(state|services\/(app-runtime|bridge)))$/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js', resolveDir: process.cwd() }))
    } }]
  })
  const require = createRequire(import.meta.url)
  require(join(temporary, 'ipc.cjs')).registerAppRuntimeIpc({ getMain: () => ({ webContents: { id: 7 } }) })
  assert.equal(handlers.size, 8)
  const invoke = (name, args, sender = 7) => handlers.get(`appRuntime:${name}`)({ sender: { id: sender } }, ...args)
  root = null
  assert.equal((await invoke('list', [rootA])).code, 'E_NO_PROJECT')
  root = rootB
  assert.equal((await invoke('stop', [rootA, 'fixture'])).code, 'E_CONFLICT')
  assert.equal(calls.length, 0, 'foreign/missing project performs no runtime operation')
  root = rootA
  assert.equal((await invoke('list', [rootA])).ok, true)
  assert.deepEqual(calls.pop(), ['list', rootA])
  assert.equal((await invoke('save', [rootA, { config: { id: '../bad' } }])).code, 'E_INVALID_ARG')
  assert.equal((await invoke('logs', [rootA, 'fixture', -1])).code, 'E_INVALID_ARG')
  assert.equal((await invoke('remove', [rootA, 'fixture', ''])).code, 'E_INVALID_ARG')
  assert.equal(calls.length, 0, 'invalid config/cursor/revision never reaches service')
  assert.equal((await invoke('start', [rootA, 'fixture', 'rev'])).code, 'E_DENIED')
  assert.deepEqual(calls.pop(), ['start', rootA, 'fixture', false])
  response = 1
  assert.equal((await invoke('start', [rootA, 'fixture', 'rev'], 8)).code, 'E_DENIED', 'utility/non-main sender cannot authorize execution')
  assert.equal(calls.pop()[3], false)
  switchWhileConfirming = true
  assert.equal((await invoke('start', [rootA, 'fixture', 'rev'])).code, 'E_DENIED', 'project switch during human dialog revokes the pending decision')
  assert.equal(calls.pop()[3], false)
  root = rootA
  switchWhileConfirming = false
  roundTripWhileConfirming = true
  assert.equal((await invoke('start', [rootA, 'fixture', 'rev'])).code, 'E_DENIED', 'A to B to A cannot revive an old confirmation')
  assert.equal(calls.pop()[3], false)
  roundTripWhileConfirming = false
  assert.equal((await invoke('start', [rootA, 'fixture', 'rev'])).ok, true)
  assert.deepEqual(calls.pop(), ['start', rootA, 'fixture', true])
  await invoke('stop', [rootA, 'fixture'])
  assert.deepEqual(calls.pop(), ['stop', rootA, 'fixture'])
  for (const kind of ['state', 'attention', 'output', 'done']) listener({ kind, root: rootA, appId: 'fixture', runId: 'run', app: {} })
  assert.deepEqual(fixture.broadcasts.map(event => event.channel), ['appRuntime:changed', 'appRuntime:changed', 'appRuntime:output', 'appRuntime:done'])
  console.log('PASS actual IPC handlers: project root guards, validation, main-only native approval/cancellation, stale dialog rejection, lifecycle delegation and registered event channels')
} finally {
  delete globalThis.__APP_IPC_FIXTURE__
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('tpanel-app-ipc-'))
  rmSync(temporary, { recursive: true, force: true })
}
