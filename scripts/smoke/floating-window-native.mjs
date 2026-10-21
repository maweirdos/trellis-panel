/** Real window IPC and preload contracts with isolated state and native boundaries. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-floating-native-'))
const projectRoot = join(temporary, 'project')
const runtime = globalThis.__FLOATING_NATIVE_SMOKE__ = {
  handlers: new Map(), listeners: new Map(), exposed: {}, root: projectRoot,
  snapshotRoot: projectRoot, generation: 1,
  tasks: [{ dirName: 'task-a' }], archived: [{ dirName: 'archived-a' }],
  focused: [], mainShown: 0, quickShown: 0, quickHidden: 0, onShowMain: null,
  failMain: false, failQuick: false, shape: 'pill',
  bounds: { x: 40, y: 40, width: 440, height: 64 }, minimum: null
}
const electron = `
  const runtime = globalThis.__FLOATING_NATIVE_SMOKE__;
  export const ipcMain = {
    handle(channel, listener) { runtime.handlers.set(channel, listener) },
    on(channel, listener) { runtime.listeners.set(channel, listener) }
  };
  export const ipcRenderer = {
    async invoke(channel, ...args) {
      const handler = runtime.handlers.get(channel);
      if (!handler) throw Error('Missing handler: ' + channel);
      return handler({}, ...args);
    },
    send(channel, ...args) { runtime.listeners.get(channel)?.({}, ...args) },
    on() {}, removeListener() {}
  };
  export const contextBridge = { exposeInMainWorld(name, value) { runtime.exposed[name] = value } };
  export class BrowserWindow { static getFocusedWindow() { return null } }
  export const screen = { getDisplayMatching() { return { workArea: { x: 0, y: 0, width: 1920, height: 1080 } } } };
`
const state = `
  const runtime = globalThis.__FLOATING_NATIVE_SMOKE__;
  export const getProjectRoot = () => runtime.root;
  export const getProjectGeneration = () => runtime.generation;
  export const getSnapshot = () => ({ meta: { root: runtime.snapshotRoot }, tasks: runtime.tasks, archived: runtime.archived });
  export const pushFocusTask = dir => runtime.focused.push({ dir, root: runtime.root, generation: runtime.generation });
`
const boundary = {
  name: 'floating-native-boundaries',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'floating-native' }))
    builder.onResolve({ filter: /^\.\.\/state$/ }, args => args.importer.replace(/\\/g, '/').endsWith('/src/main/ipc/window.ts')
      ? { path: 'state', namespace: 'floating-native' } : null)
    builder.onLoad({ filter: /.*/, namespace: 'floating-native' }, args => ({ contents: args.path === 'electron' ? electron : state, loader: 'js' }))
  }
}

try {
  await build({
    stdin: { contents: "export { registerWindowIpc } from './src/main/ipc/window'; export { ipcInvoke } from './src/shared/ipc-channels'", resolveDir: process.cwd(), loader: 'ts' },
    outfile: join(temporary, 'window.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [boundary]
  })
  await build({ entryPoints: ['src/preload/index.ts'], outfile: join(temporary, 'preload.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [boundary] })
  const { registerWindowIpc, ipcInvoke } = await import(pathToFileURL(join(temporary, 'window.mjs')).href)
  const capsule = {
    getBounds: () => runtime.bounds,
    setBounds: value => { runtime.bounds = value },
    setMinimumSize: (width, height) => { runtime.minimum = [width, height] },
    setMaximumSize() {}, setTitle() {}, hide() {}, show() {}, focus() {},
    setSize(width, height) { runtime.bounds = { ...runtime.bounds, width, height } }
  }
  registerWindowIpc({
    getMain: () => null, getCapsule: () => capsule,
    getQuickTodo: () => ({ hide() { runtime.quickHidden++ } }),
    showQuickTodo() { if (runtime.failQuick) throw Error('Quick-note unavailable'); runtime.quickShown++ },
    showMain() {
      if (runtime.failMain) throw Error('Main window unavailable')
      runtime.mainShown++
      runtime.onShowMain?.()
    },
    createMain() {}, captureMain: async () => null, openDocWindow: () => ({ ok: true }),
    capsule: { onTop: () => true, setOnTop() {}, shape: () => runtime.shape, setShape: shape => { runtime.shape = shape }, create() {} }
  })
  await import(pathToFileURL(join(temporary, 'preload.mjs')).href)
  const api = runtime.exposed.trellis
  assert.equal(typeof api.openMainTask, 'function')
  assert.equal(typeof api.showQuickTodo, 'function')
  assert.ok(runtime.handlers.has(ipcInvoke.win.openTask))
  assert.ok(runtime.handlers.has(ipcInvoke.quicktodo.show))

  assert.deepEqual(await api.openMainTask(projectRoot, 'task-a'), { ok: true })
  assert.equal(runtime.mainShown, 1)
  assert.deepEqual(runtime.focused.at(-1), { dir: 'task-a', root: projectRoot, generation: 1 })
  if (process.platform === 'win32') assert.deepEqual(await api.openMainTask(projectRoot.toUpperCase(), 'task-a'), { ok: true })
  console.log('PASS registered preload actions use exact current-project task identity')

  const expectRejected = async (root, task, code) => {
    const shown = runtime.mainShown, focused = runtime.focused.length
    const outcome = await api.openMainTask(root, task)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, code)
    assert.equal(typeof outcome.error, 'string')
    assert.equal(runtime.mainShown, shown)
    assert.equal(runtime.focused.length, focused)
  }
  for (const [root, task] of [[null, 'task-a'], ['', 'task-a'], [projectRoot, null], [projectRoot, 5], [projectRoot, ''], [projectRoot, '../task-a'], [projectRoot, '..'], [projectRoot, 'tasks/task-a'], [projectRoot, 'tasks\\task-a']]) {
    await expectRejected(root, task, 'E_INVALID_ARG')
  }
  await expectRejected(join(temporary, 'foreign'), 'task-a', 'E_CONFLICT')
  await expectRejected(projectRoot, 'missing', 'E_NOT_FOUND')
  await expectRejected(projectRoot, 'archived-a', 'E_NOT_FOUND')
  await expectRejected(projectRoot, 'a', 'E_NOT_FOUND')
  runtime.snapshotRoot = join(temporary, 'foreign')
  await expectRejected(projectRoot, 'task-a', 'E_CONFLICT')
  runtime.snapshotRoot = projectRoot
  runtime.root = null
  await expectRejected(projectRoot, 'task-a', 'E_NO_PROJECT')
  runtime.root = projectRoot
  console.log('PASS malformed, foreign, missing, archived and stale-snapshot targets never focus a task')

  const focused = runtime.focused.length
  runtime.onShowMain = () => { runtime.generation += 2 }
  assert.equal((await api.openMainTask(projectRoot, 'task-a')).code, 'E_CONFLICT')
  assert.equal(runtime.focused.length, focused)
  runtime.onShowMain = () => { runtime.root = join(temporary, 'foreign') }
  assert.equal((await api.openMainTask(projectRoot, 'task-a')).code, 'E_CONFLICT')
  assert.equal(runtime.focused.length, focused)
  runtime.onShowMain = null
  runtime.root = projectRoot
  runtime.failMain = true
  assert.equal((await api.openMainTask(projectRoot, 'task-a')).code, 'E_UNKNOWN')
  assert.equal(runtime.focused.length, focused)
  runtime.failMain = false
  console.log('PASS project-generation changes and native show failures retain structured failure')

  await api.showQuickTodo()
  await api.showQuickTodo()
  assert.equal(runtime.quickShown, 2)
  assert.equal(runtime.quickHidden, 0)
  runtime.failQuick = true
  await assert.rejects(api.showQuickTodo(), /Quick-note unavailable/)
  runtime.failQuick = false
  await api.closeQuickTodo()
  assert.equal(runtime.quickHidden, 1)
  console.log('PASS quick-note show is idempotent with respect to visibility; close remains separate')

  await api.setCapsuleShape('card')
  assert.equal(runtime.bounds.width, 400)
  assert.equal(runtime.bounds.height, 380)
  assert.deepEqual(runtime.minimum, [360, 320])
  await api.setCapsuleShape('pill')
  assert.equal(runtime.bounds.width, 440)
  assert.equal(runtime.bounds.height, 64)
  assert.deepEqual(runtime.minimum, [360, 64])
  console.log('PASS actual shape handler uses shared 400x380 card and unchanged pill bounds')
} finally {
  delete globalThis.__FLOATING_NATIVE_SMOKE__
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('tpanel-floating-native-'))
  rmSync(temporary, { recursive: true, force: true })
}
