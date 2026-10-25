import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// Real registry, window handler, preload and quit gate with only native/state
// boundaries mocked. Never opens an app, native profile, daemon or transport.
const temporary = mkdtempSync(join(tmpdir(), 'trellis-app-quit-'))
const key = '__appQuit' + randomUUID().replaceAll('-', '')
const frame = {}
const contents = { id: 1, mainFrame: frame, isDestroyed: () => false }
const main = { webContents: contents, isDestroyed: () => false }
const state = {
  handlers: new Map(), exposed: null, main, event: { sender: contents, senderFrame: frame },
  calls: [], channels: [], dialogs: 0, quits: 0, finals: 0,
  status: { epoch: randomUUID(), owner: { pid: 123, startedAt: 'fixture-only' }, state: 'running', preferences: { revision: 9, keepRunning: true, startup: 'manual' } },
  selection: { action: 'cancel', keepRunning: true }
}
state.showQuit = async () => { state.dialogs++; return { status: state.status, decision: state.selection } }
globalThis[key] = state
const prelude = 'const s=globalThis[' + JSON.stringify(key) + '];'
const mocks = {
  electron: 'export const ipcMain={handle:(id,fn)=>s.handlers.set(id,fn),on:()=>{}};export const ipcRenderer={invoke:async(id,...args)=>{s.channels.push(id);const fn=s.handlers.get(id);if(!fn)throw Error("Unexpected channel "+id);return fn(s.event,...args)},on:()=>{},removeListener:()=>{},send:()=>{throw Error("Unexpected send")}};export const contextBridge={exposeInMainWorld:(_name,api)=>{s.exposed=api}};export const BrowserWindow={};export const screen={};',
  '../state': 'export const getProjectRoot=()=>null;export const getProjectGeneration=()=>0;export const getSnapshot=()=>null;export const pushFocusTask=()=>{throw Error("Unexpected focus")};',
  './daemon-client/manager': 'export const daemonIsAbsent=async()=>false;export const daemonManager={status:async()=>({ok:true,data:s.status}),setPreferences:async input=>{s.calls.push(["preferences",input]);return{ok:true,data:input}},stop:async()=>{s.calls.push(["stop"]);return{ok:true,data:null}}};',
  '../daemon/native': 'export const sameOwner=(a,b)=>JSON.stringify(a)===JSON.stringify(b);',
  './daemon-quit-dialog': 'export const showDaemonQuitDialog=()=>s.showQuit();',
  './daemon-client/runtime': 'export const setRuntimeClientAdmissionClosed=closed=>s.calls.push(["runtimeAdmission",closed]);'
}
const boundary = { name: 'gui-only-quit', setup(builder) {
  builder.onResolve({ filter: /^electron$|^\.\.\/state$|^\.\.\/daemon\/native$|^\.\/daemon-client\/manager$|^\.\/daemon-client\/runtime$|^\.\/daemon-quit-dialog$/ }, args => ({ path: args.path, namespace: 'fixture' }))
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: prelude + mocks[args.path] }))
} }
try {
  await build({
    stdin: { contents: "export {registerWindowIpc} from './src/main/ipc/window';export {createDaemonQuitGate} from './src/main/services/daemon-quit-gate';export {ipcInvoke} from './src/shared/ipc-channels';", resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'esm', outfile: join(temporary, 'main.mjs'), plugins: [boundary]
  })
  await build({ entryPoints: ['src/preload/index.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(temporary, 'preload.mjs'), plugins: [boundary] })
  const { registerWindowIpc, createDaemonQuitGate, ipcInvoke } = await import(pathToFileURL(join(temporary, 'main.mjs')).href)
  function freshGate() {
    return createDaemonQuitGate({
      closeGuiAdmission: closed => state.calls.push(['guiAdmission', closed]),
      stopGuiWork: async () => { state.calls.push(['stopGuiWork']) },
      detach: async () => { state.calls.push(['detach']) },
      finalize: () => state.calls.push(['finalize']),
      quit: () => state.requestQuit(),
      reportError: error => { throw error }
    })
  }
  let gate = freshGate()
  state.requestQuit = () => {
    state.quits++
    let prevented = false
    gate.beforeQuit({ preventDefault() { prevented = true } })
    if (!prevented) state.finals++
  }
  registerWindowIpc({ getMain: () => state.main, quitApp: () => state.requestQuit() })
  await import(pathToFileURL(join(temporary, 'preload.mjs')).href)
  assert.equal(typeof state.exposed.appQuit, 'function')
  const request = () => state.exposed.appQuit()
  for (const event of [
    { sender: { id: 2, mainFrame: {} }, senderFrame: {} },
    { sender: contents, senderFrame: {} },
    { sender: contents, senderFrame: null },
    { sender: { ...contents }, senderFrame: frame }
  ]) {
    state.event = event
    assert.equal((await request()).code, 'E_DENIED')
  }
  state.event = { sender: contents, senderFrame: frame }
  for (const unavailable of [null, { ...main, isDestroyed: () => true }, { webContents: { ...contents, isDestroyed: () => true }, isDestroyed: () => false }]) {
    state.main = unavailable
    assert.equal((await request()).code, 'E_DENIED')
  }
  assert.equal(state.quits, 0); assert.equal(state.dialogs, 0)
  console.log('PASS appQuit rejects auxiliary, subframe, absent/destroyed and impostor main senders')

  state.main = main
  let choose
  state.showQuit = () => { state.dialogs++; return new Promise(resolve => { choose = resolve }) }
  assert.deepEqual(await request(), { ok: true })
  assert.deepEqual(await request(), { ok: true })
  assert.equal(state.dialogs, 1)
  assert.deepEqual(state.calls, [])
  assert.equal(state.finals, 0)
  choose({ status: state.status, decision: { action: 'cancel', keepRunning: true } })
  await gate.whenIdle()
  assert.deepEqual(state.calls, []); assert.equal(state.finals, 0)
  console.log('PASS accepted GUI quit enters one existing choice dialog; cancel preserves daemon/preferences')

  state.showQuit = async () => { state.dialogs++; return { status: state.status, decision: state.selection } }
  state.selection = { action: 'exit', keepRunning: true }
  await request(); await gate.whenIdle()
  assert.equal(state.calls.some(([kind]) => kind === 'stop'), false)
  assert.equal(state.finals, 1)
  assert.equal(state.calls.find(([kind]) => kind === 'preferences')[1].startup, 'manual')
  console.log('PASS keep-running exit uses GUI cleanup and normal quit without stopping daemon')

  gate = freshGate(); state.calls = []
  state.selection = { action: 'exit', keepRunning: false }
  await request(); await gate.whenIdle()
  assert.equal(state.finals, 2)
  assert.deepEqual(state.calls.filter(([kind]) => kind === 'stop'), [['stop']])
  assert.ok(state.calls.findIndex(([kind]) => kind === 'stopGuiWork') < state.calls.findIndex(([kind]) => kind === 'stop'))
  assert.equal(state.calls.find(([kind]) => kind === 'preferences')[1].startup, 'manual')
  assert.equal(state.channels.every(channel => channel === ipcInvoke.win.quit), true)
  console.log('PASS stop-and-exit reaches the canonical daemon stop only after explicit existing quit choice')
} finally {
  delete globalThis[key]
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep))
  rmSync(temporary, { recursive: true, force: true })
}
