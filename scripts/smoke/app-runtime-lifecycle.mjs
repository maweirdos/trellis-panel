import assert from 'node:assert/strict'
import { build, transform } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-app-quit-'))
const creationHost = globalThis.__CREATION_QUIT_SMOKE__ = { app: new EventEmitter(), handlers: new Map(), service: null }
try {
  await build({ entryPoints: ['src/main/services/quit-gate.ts'], outfile: join(temporary, 'quit-gate.cjs'), bundle: true, platform: 'node', format: 'cjs' })
  const require = createRequire(import.meta.url)
  const { createQuitGate } = require(join(temporary, 'quit-gate.cjs'))
  const calls = []
  let confirm = false
  let failed = false
  let pendingStop
  const gate = createQuitGate({
    hasApplications: async () => true,
    confirmApplications: async () => { calls.push('confirm'); return confirm },
    setAdmissionClosed: closed => calls.push(closed ? 'close-admission' : 'open-admission'),
    stopApplications: async () => { calls.push('stop-applications'); if (pendingStop) await pendingStop; if (failed) throw Error('owned cleanup incomplete') },
    stopSessions: async () => calls.push('stop-sessions'),
    finalize: () => calls.push('finalize'),
    quit: () => calls.push('quit'),
    reportError: error => calls.push(error.message)
  })
  let prevented = 0
  const event = { preventDefault: () => { prevented += 1 } }
  gate.beforeQuit(event)
  await gate.whenIdle()
  assert.deepEqual(calls, ['confirm'], 'cancellation leaves every subsystem and admission intact')
  calls.length = 0
  confirm = true
  failed = true
  gate.beforeQuit(event)
  await gate.whenIdle()
  assert.deepEqual(calls, ['confirm', 'close-admission', 'stop-applications', 'open-admission', 'owned cleanup incomplete'], 'failed application cleanup preserves sessions and permits retry')
  calls.length = 0
  failed = false
  let release
  pendingStop = new Promise(done => { release = done })
  gate.beforeQuit(event)
  gate.beforeQuit(event)
  await new Promise(done => setImmediate(done))
  assert.deepEqual(calls, ['confirm', 'close-admission', 'stop-applications'], 'concurrent quit cannot duplicate cleanup or finalize early')
  release()
  await gate.whenIdle()
  assert.deepEqual(calls, ['confirm', 'close-admission', 'stop-applications', 'stop-sessions', 'finalize', 'quit'])
  assert.equal(prevented, 4)
  gate.beforeQuit(event)
  assert.equal(prevented, 4, 'settled reentrant quit is allowed')
  console.log('PASS quit cancellation, cleanup failure/retry, admission, serialization, session drain and reentrant final quit')

  await build({ stdin: { contents: "export {CreationMainService} from './src/main/services/creations/service';export {registerCreationsIpc} from './src/main/ipc/creations';", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(temporary, 'creations.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'owned-creation-quit', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'quit-owned' }))
    builder.onResolve({ filter: /^\.\.\/services\/creations$/ }, (args) => args.importer.replaceAll('\\', '/').endsWith('/ipc/creations.ts') ? { path: 'creation-index', namespace: 'quit-owned' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'quit-owned' }, ({ path }) => ({ loader: 'js', contents: 'const host=globalThis.__CREATION_QUIT_SMOKE__;' + (path === 'electron'
      ? 'export const app=host.app;export const ipcMain={handle:(name,fn)=>host.handlers.set(name,fn),on(){}};'
      : 'export const creationService=()=>host.service;export const closeCreationService=()=>host.service?.close();') }))
  } }] })
  const { CreationMainService, registerCreationsIpc } = require(join(temporary, 'creations.cjs'))
  const context = { key: 'local', state: 'local', connectionId: null, projectId: null, actorId: 'owned-person', revision: 0, canManage: true, pendingCount: 0, projectName: null }
  creationHost.service = new CreationMainService({ dataDir: join(temporary, 'creation-data'), workspace: async () => ({ context, snapshot: { members: [{ id: context.actorId }], spaces: [], tasks: [] } }), status: async () => ({ ...context }), remote: async () => { throw Error('Quit fixture cannot call a team service') }, model: () => ({ enabled: false, model: '', baseUrl: '', apiKey: '' }), chat: async () => { throw Error('Quit fixture cannot call a model') }, changed() {} })
  registerCreationsIpc()
  assert.equal(creationHost.app.listenerCount('before-quit'), 0, 'creation IPC must not own reversible quit admission')
  const creationList = () => creationHost.handlers.get('creations:list')({}, { workspaceKey: 'local' })
  assert.equal((await creationList()).ok, true)

  // Execute the actual main stopSessions callback against owned async boundaries.
  // Extracting only this callback avoids starting the real desktop host or copying its shutdown order.
  const mainSource = ts.createSourceFile('main/index.ts', readFileSync(resolve('src/main/index.ts'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const stopCallbacks = []
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createQuitGate' && ts.isObjectLiteralExpression(node.arguments[0])) {
      for (const property of node.arguments[0].properties) if (ts.isPropertyAssignment(property) && property.name.getText(mainSource) === 'stopSessions') stopCallbacks.push(property.initializer.getText(mainSource))
    }
    ts.forEachChild(node, visit)
  }
  visit(mainSource); assert.equal(stopCallbacks.length, 1, 'main must provide one explicit session cleanup callback')
  const shutdownNames = ['shutdownWorkflowApplications', 'shutdownAcp', 'closeHifoxWorkspace', 'closeDesktopTeamService']
  const shutdowns = [], errors = []
  let failShutdown = null, holdLast = null, lastEntered = null, allowCreationQuit = false, finalizedCreations = false
  const sandbox = { module: { exports: null }, closeCreationService: () => { shutdowns.push('closeCreationService'); creationHost.service.close() } }
  for (const name of shutdownNames) sandbox[name] = async () => { shutdowns.push(name); if (name === failShutdown) throw Error('owned failure: ' + name); if (name === shutdownNames.at(-1) && holdLast) { lastEntered(); await holdLast } }
  const callback = await transform(`module.exports = ${stopCallbacks[0]}`, { loader: 'ts', format: 'cjs', target: 'es2022' })
  runInNewContext(callback.code, sandbox)
  const creationGate = createQuitGate({ hasApplications: async () => true, confirmApplications: async () => allowCreationQuit, setAdmissionClosed() {}, stopApplications: async () => {}, stopSessions: sandbox.module.exports, finalize: () => { finalizedCreations = true }, quit() {}, reportError: (error) => errors.push(error.message) })
  creationHost.app.on('before-quit', creationGate.beforeQuit)
  const creationQuit = () => creationHost.app.emit('before-quit', { preventDefault() {} })
  creationQuit(); await creationGate.whenIdle()
  assert.deepEqual(shutdowns, []); assert.equal((await creationList()).ok, true, 'cancelled quit disabled the real creation API')
  allowCreationQuit = true
  for (const name of shutdownNames) {
    shutdowns.length = 0; failShutdown = name
    creationQuit(); await creationGate.whenIdle()
    assert.deepEqual(shutdowns, shutdownNames.slice(0, shutdownNames.indexOf(name) + 1))
    assert.equal((await creationList()).ok, true, name + ' failure disabled creations before cleanup succeeded')
    assert.equal(finalizedCreations, false)
  }
  assert.equal(errors.length, shutdownNames.length)
  shutdowns.length = 0; failShutdown = null
  let finishShutdown
  holdLast = new Promise((done) => { finishShutdown = done })
  const finalShutdownEntered = new Promise((done) => { lastEntered = done })
  creationQuit(); await finalShutdownEntered
  assert.equal((await creationList()).ok, true, 'creations closed before asynchronous shutdown completed')
  finishShutdown(); await creationGate.whenIdle()
  assert.deepEqual(shutdowns, [...shutdownNames, 'closeCreationService']); assert.equal(finalizedCreations, true)
  assert.equal((await creationList()).code, 'SERVICE_CLOSED')
  console.log('PASS actual creation IPC survives quit cancellation and every async cleanup failure; main closes it only after confirmed successful drain')

  writeFileSync(join(temporary, 'electron.cjs'), `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { createQuitGate } = require('./quit-gate.cjs');
app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))});
app.disableHardwareAcceleration();
const order = []; let confirm = false; let final = false;
const gate = createQuitGate({
  hasApplications: async () => true,
  confirmApplications: async () => { order.push('confirm'); return confirm; },
  setAdmissionClosed: closed => order.push(closed ? 'admission-closed' : 'admission-open'),
  stopApplications: async () => order.push('apps-verified'),
  stopSessions: async () => order.push('sessions-drained'),
  finalize: () => { order.push('finalize'); final = true; },
  quit: () => app.quit(),
  reportError: error => { console.error(error); app.exit(1); }
});
app.on('before-quit', gate.beforeQuit);
app.on('will-quit', () => {
  assert.equal(final, true);
  assert.deepEqual(order, ['confirm', 'confirm', 'admission-closed', 'apps-verified', 'sessions-drained', 'finalize']);
  console.log('PASS actual Electron before-quit cancellation, owned cleanup ordering and final quit');
});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  window.on('close', event => { if (!final) { event.preventDefault(); window.hide(); } });
  window.close();
  assert.equal(window.isDestroyed(), false, 'close-to-tray keeps the application host alive');
  assert.deepEqual(order, []);
  app.quit(); await gate.whenIdle();
  assert.equal(window.isDestroyed(), false, 'cancelled complete exit preserves host');
  assert.equal(final, false);
  confirm = true; app.quit();
}).catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('quit fixture timed out'); app.exit(1); }, 12000).unref();
`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(require('electron'), [join(temporary, 'electron.cjs'), '--no-sandbox'], { env, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 })
  process.stdout.write(result.stdout)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  creationHost.service?.close()
  delete globalThis.__CREATION_QUIT_SMOKE__
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('tpanel-app-quit-'))
  rmSync(temporary, { recursive: true, force: true })
}
