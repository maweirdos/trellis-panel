/** Main-process delivery with mocked OS notifications; no real notifications/profile writes. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-native-notifications-'))
const runtime = globalThis.__NATIVE_NOTIFICATION_SMOKE__ = {
  native: [], sent: [], broadcasts: [], materialChanges: [], timers: new Map(), warnings: [],
  supported: true, failSupport: false, failCreate: false, failShow: false, failScan: false,
  shown: 0, nextTimer: 0
}
const dependencies = {
  './services/scan': `export const TEXT_EXTS = new Set(); export function scanProject(root) {
    if (globalThis.__NATIVE_NOTIFICATION_SMOKE__.failScan) throw Error('synthetic scan failure');
    return {meta:{root,trellisExists:true,name:'Fixture'},tasks:[{dirName:'task-a',record:{title:'A full material task title'}}],archived:[]};
  }`,
  './services/watcher': 'export class TrellisWatcher {start(){} stop(){}}',
  './services/documents': 'export function clearDocumentCache(){} export function clearReaderDocuments(){} export function routeReaderDocumentChange(){} export function resolveAuthorizedDocumentPath(){return {ok:false}}',
  './services/store': 'export function getSettings(){return {weknora:{}}} export function pushRecentProject(){}',
  './services/git': 'export function clearGitCache(){}',
  './services/activity': 'export function recordActivity(){}',
  './services/bridge': 'export function broadcastToWindows(channel,payload){globalThis.__NATIVE_NOTIFICATION_SMOKE__.broadcasts.push({channel,payload})}',
  './services/acp': 'export function routeWatcherEvent(){} export function emitAcpMaterialChange(change){globalThis.__NATIVE_NOTIFICATION_SMOKE__.materialChanges.push(change)}',
  './services/acp/materials': `export function eventTaskMaterial(root,path){return {taskDir:'task-a',relativePath:'.trellis/tasks/task-a/'+path.split(/[\\\\/]/).pop()}}
    export async function verifyMaterialChange(root,generation,path,kind){return {projectRoot:root,projectGeneration:generation,relativePath:'.trellis/tasks/task-a/'+path.split(/[\\\\/]/).pop(),kind}}`,
  './services/observability': 'export function closeObservationForProject(){} export async function initObservationForRoot(){}',
  './services/httpapi': 'export function startHttpApi(){} export function stopHttpApi(){}',
  './services/weknora': 'export class WeknoraSpecSyncer {constructor(options){globalThis.__NATIVE_NOTIFICATION_SMOKE__.onReport=options.onReport} configure(){} enqueue(){} stop(){}}',
  './services/access/event-log': 'export const accessEventLog={append(){}}'
}
const electron = `import {EventEmitter} from 'node:events';
  export const app={setLoginItemSettings(){}};
  export class BrowserWindow {}
  export class Notification extends EventEmitter {
    static isSupported(){const r=globalThis.__NATIVE_NOTIFICATION_SMOKE__; if(r.failSupport)throw Error('support unavailable'); return r.supported}
    constructor(options){super(); const r=globalThis.__NATIVE_NOTIFICATION_SMOKE__; if(r.failCreate)throw Error('constructor rejected'); this.options=options; r.native.push(this)}
    show(){if(globalThis.__NATIVE_NOTIFICATION_SMOKE__.failShow)throw Error('show rejected'); this.shown=true}
  }`
const fakeTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
const originalWarn = console.warn
try {
  await build({
    stdin: { contents: "export * from './src/main/state'; export {ipcEvent} from './src/shared/ipc-channels'", loader: 'ts', resolveDir: process.cwd() },
    outfile: join(temporary, 'state.mjs'), bundle: true,
    format: 'esm', platform: 'node', define: { __dirname: JSON.stringify(resolve('out/main')) },
    plugins: [{ name: 'notification-boundaries', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'notification-smoke' }))
      builder.onResolve({ filter: /^\.\/services\// }, args => dependencies[args.path] && args.importer.endsWith('state.ts')
        ? { path: args.path, namespace: 'notification-smoke' } : null)
      builder.onLoad({ filter: /.*/, namespace: 'notification-smoke' }, args => ({ contents: args.path === 'electron' ? electron : dependencies[args.path], loader: 'js' }))
    } }]
  })
  console.warn = (...args) => runtime.warnings.push(args)
  globalThis.setTimeout = (callback, delay) => {
    const id = ++runtime.nextTimer
    runtime.timers.set(id, { callback, delay })
    return id
  }
  globalThis.clearTimeout = id => runtime.timers.delete(id)
  const state = await import(pathToFileURL(join(temporary, 'state.mjs')).href)
  const { ipcEvent } = state
  const window = {
    visible: true, focused: true, minimized: false, destroyed: false, loading: false, failSend: false,
    isVisible() { return this.visible }, isFocused() { return this.focused },
    isMinimized() { return this.minimized }, isDestroyed() { return this.destroyed },
    webContents: {
      isLoading: () => window.loading,
      send(channel, payload) { if (window.failSend) throw Error('renderer unavailable'); runtime.sent.push({ channel, payload }) }
    }
  }
  state.setMainWindow(window)
  state.setUiHooks({ showMain: () => { runtime.shown++ }, rebuildTray() {} })
  const toast = { kind: 'info', title: 'Notification title', body: 'Concise body' }
  const clear = () => { runtime.native.length = 0; runtime.sent.length = 0; runtime.broadcasts.length = 0; runtime.materialChanges.length = 0 }
  const foreground = () => Object.assign(window, { visible: true, focused: true, minimized: false, destroyed: false, failSend: false })
  const noToastBroadcast = () => assert.equal(runtime.broadcasts.filter(event => event.channel === ipcEvent.toast).length, 0)
  state.toast(toast)
  assert.deepEqual(runtime.sent, [{ channel: ipcEvent.toast, payload: toast }], 'focused main receives exactly one toast')
  assert.equal(runtime.native.length, 0, 'foreground skips OS delivery')

  for (const [name, patch] of [['unfocused', { focused: false }], ['minimized', { minimized: true }], ['hidden', { visible: false }], ['destroyed', { destroyed: true }]]) {
    clear(); foreground(); Object.assign(window, patch)
    state.toast(toast)
    assert.equal(runtime.native.length, 1, `${name} sends one native notification`)
    assert.equal(runtime.sent.length, 0, `${name} does not queue a renderer toast`)
    const notification = runtime.native[0]
    assert.equal(notification.options.icon, resolve('resources/brand/icon-256.png'))
    assert.equal(readFileSync(notification.options.icon).readUInt32BE(16), 256, 'canonical committed PNG icon')
    assert.equal(notification.options.silent, true)
    assert.equal(notification.options.urgency, 'low')
    assert.equal(notification.options.title, toast.title)
    assert.equal(notification.options.body, toast.body)
    notification.emit('click')
    notification.emit('click')
    notification.emit('close')
    noToastBroadcast()
  }
  assert.equal(runtime.shown, 4, 'one activation per clicked notification')
  clear(); state.setMainWindow(null); state.toast(toast)
  assert.equal(runtime.native.length, 1, 'missing main window uses native delivery')
  state.setMainWindow(window); foreground(); window.visible = false
  for (const [kind, urgency] of [['warn', 'normal'], ['error', 'critical'], ['success', 'low']]) {
    clear(); state.toast({ kind, title: kind })
    assert.equal(runtime.native[0].options.urgency, urgency)
    assert.equal(runtime.native[0].options.body, '')
    assert.equal(runtime.native[0].options.silent, true)
  }
  clear(); runtime.supported = false; state.toast(toast)
  assert.equal(runtime.native.length, 0); assert.equal(runtime.sent.length, 0)
  foreground(); state.toast(toast)
  assert.equal(runtime.sent.length, 1, 'unsupported native notifications do not disable foreground toasts')
  runtime.supported = true; window.visible = false
  for (const flag of ['failSupport', 'failCreate', 'failShow']) {
    clear(); runtime[flag] = true
    const before = runtime.warnings.length
    assert.doesNotThrow(() => state.toast(toast), flag)
    assert.equal(runtime.warnings.length, before + 1)
    assert.equal(runtime.sent.length, 0)
    runtime[flag] = false
  }
  clear(); state.toast(toast)
  const beforeFailed = runtime.warnings.length
  assert.doesNotThrow(() => runtime.native[0].emit('failed', {}, 'OS rejected'))
  assert.equal(runtime.warnings.length, beforeFailed + 1)
  clear(); foreground(); window.failSend = true; state.toast(toast)
  assert.equal(runtime.native.length, 1, 'failed foreground delivery falls back to native once')
  assert.equal(runtime.sent.length, 0)
  foreground(); window.visible = false

  const rootA = resolve(temporary, 'project-a'), rootB = resolve(temporary, 'project-b')
  const flushMaterial = async () => {
    const pending = [...runtime.timers.entries()].filter(([, timer]) => timer.delay === 8000)
    assert.equal(pending.length, 1, 'material changes debounce into one batch')
    for (const [id, timer] of pending) { runtime.timers.delete(id); timer.callback() }
    await new Promise(done => setImmediate(done))
  }
  const material = async () => {
    clear()
    state.routeMaterialNotice(join(rootA, '.trellis/tasks/task-a/subdirectory/prd.md'))
    state.routeMaterialNotice(join(rootA, '.trellis/tasks/task-a/design.md'))
    await flushMaterial()
    assert.equal(runtime.broadcasts.filter(event => event.channel === ipcEvent.materialUpdated).length, 1, 'material domain broadcast remains')
    assert.equal(runtime.materialChanges.length, 2, 'ACP receives both material changes')
    noToastBroadcast()
  }
  assert.equal(state.openProjectAt(rootA).ok, true)
  foreground(); await material()
  assert.equal(runtime.sent.length, 1, 'material foreground notification goes through common delivery')
  assert.equal(runtime.native.length, 0)
  assert.deepEqual(runtime.sent[0].payload.task, { projectRoot: rootA, dirName: 'task-a' })
  const formatted = { title: runtime.sent[0].payload.title, body: runtime.sent[0].payload.body }
  window.minimized = true; await material()
  assert.equal(runtime.sent.length, 0)
  assert.equal(runtime.native.length, 1)
  assert.deepEqual({ title: runtime.native[0].options.title, body: runtime.native[0].options.body }, formatted, 'native and renderer share material content')
  runtime.native[0].emit('click')
  assert.deepEqual(runtime.sent, [{ channel: ipcEvent.bridgeTaskFocus, payload: 'task-a' }])

  for (const change of [() => state.openProjectAt(rootB), () => state.openProjectAt(rootA), () => state.closeProjectAt()]) {
    state.openProjectAt(rootA); await material()
    const notification = runtime.native[0], shown = runtime.shown
    change(); notification.emit('click')
    assert.equal(runtime.shown, shown + 1, 'stale notification can still open main')
    assert.equal(runtime.sent.length, 0, 'stale project/root/generation cannot open same-named task')
  }
  state.openProjectAt(rootA); await material(); window.loading = true
  runtime.native[0].emit('click')
  state.openProjectAt(rootB); window.loading = false
  for (const [id, timer] of runtime.timers) { runtime.timers.delete(id); timer.callback() }
  assert.equal(runtime.sent.length, 0, 'deferred task focus rejects project switch while loading')
  assert.equal(state.pullPendingFocus(), null, 'bootstrap pull also rejects stale pending task focus')

  clear(); state.setUiHooks({ showMain() { throw Error('window unavailable') }, rebuildTray() {} })
  state.toast(toast)
  const beforeClick = runtime.warnings.length
  assert.doesNotThrow(() => runtime.native[0].emit('click'))
  assert.equal(runtime.warnings.length, beforeClick + 1, 'native activation failures remain best-effort')
  state.setUiHooks({ showMain: () => { runtime.shown++ }, rebuildTray() {} })

  clear(); runtime.onReport({ pushed: 1, duplicates: 0, failed: [] })
  assert.equal(runtime.native.length, 1, 'background spec sync uses native delivery')
  assert.equal(runtime.sent.length, 0); noToastBroadcast()
  clear(); foreground(); runtime.onReport({ pushed: 0, duplicates: 0, failed: [{ file: 'spec.md', error: 'rejected' }] })
  assert.equal(runtime.sent.length, 1, 'foreground spec sync uses renderer delivery')
  assert.equal(runtime.sent[0].payload.kind, 'warn'); assert.equal(runtime.native.length, 0)
  clear(); runtime.failScan = true; window.minimized = true
  const originalError = console.error
  try { console.error = () => {}; state.sendSnapshot() } finally { console.error = originalError }
  runtime.failScan = false
  assert.equal(runtime.native.length, 1, 'rescan failures use native delivery in background')
  assert.equal(runtime.native[0].options.urgency, 'normal'); noToastBroadcast()

  const index = readFileSync('src/main/index.ts', 'utf8')
  assert.doesNotMatch(index, /broadcastToWindows\(ipcEvent\.toast/, 'updater and bridge cannot broadcast duplicate/child-window toasts')
  assert.doesNotMatch(readFileSync('src/main/state.ts', 'utf8'), /new Notification/, 'native construction is centralized')
  console.log('PASS notifications-native: focus/minimize/hide/liveness, icon, urgency, unsupported/errors, material parity, stale clicks, spec sync and rescan')
} finally {
  globalThis.setTimeout = fakeTimers.setTimeout
  globalThis.clearTimeout = fakeTimers.clearTimeout
  console.warn = originalWarn
  delete globalThis.__NATIVE_NOTIFICATION_SMOKE__
  // Only remove this test-created, absolute temporary directory.
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')))
  rmSync(temporary, { recursive: true, force: true })
}
