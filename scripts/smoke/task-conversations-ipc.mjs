/** Real registry/handler/preload boundaries; native launch and project state are isolated. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-task-conversations-ipc-'))
const root = join(temporary, 'workspace')
const state = { root, generation: 1, handlers: new Map(), api: null, invokes: [], nativePort: null, constructed: 0, closed: 0 }
globalThis.__TASK_CONVERSATIONS_IPC_SMOKE__ = state

const electron = `
const state=globalThis.__TASK_CONVERSATIONS_IPC_SMOKE__;
export const ipcMain={handle:(channel,fn)=>state.handlers.set(channel,fn)};
export const ipcRenderer={invoke:async(channel,...args)=>{state.invokes.push({channel,args});return {ok:true,value:'forwarded'}},on(){},removeListener(){},send(){}};
export const contextBridge={exposeInMainWorld:(key,value)=>{if(key==='trellis')state.api=value}};
`
const plugin = {
  name: 'isolated-task-conversations-ipc',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'task-conversations-smoke' }))
    builder.onResolve({ filter: /^\.\.\/state$/ }, () => ({ path: 'state', namespace: 'task-conversations-smoke' }))
    builder.onResolve({ filter: /\/services\/task-conversations$/ }, () => ({ path: 'service', namespace: 'task-conversations-smoke' }))
    builder.onLoad({ filter: /.*/, namespace: 'task-conversations-smoke' }, ({ path }) => ({ contents: path === 'electron' ? electron
      : path === 'state' ? 'export const getProjectRoot=()=>globalThis.__TASK_CONVERSATIONS_IPC_SMOKE__.root;export const getProjectGeneration=()=>globalThis.__TASK_CONVERSATIONS_IPC_SMOKE__.generation;'
        : `export class TaskConversationsService {
            constructor(){const state=globalThis.__TASK_CONVERSATIONS_IPC_SMOKE__;state.constructed+=1;Object.assign(this,state.nativePort)}
            close(){globalThis.__TASK_CONVERSATIONS_IPC_SMOKE__.closed+=1}
          }` }))
  }
}

try {
  const output = join(temporary, 'ipc.mjs')
  await build({ entryPoints: ['src/main/ipc/task-conversations.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output, plugins: [plugin], logLevel: 'silent' })
  const { registerTaskConversationsIpc, closeTaskConversations } = await import(pathToFileURL(output).href)
  const frame = { routingId: 1 }
  let destroyed = false
  const sender = { id: 11, mainFrame: frame, isDestroyed: () => destroyed }
  const originalMain = { webContents: sender }
  let main = originalMain
  const deps = { getMain: () => main }
  const event = { sender, senderFrame: frame }
  const snapshot = { projectRoot: root, bindings: [], sources: [], refreshedAt: 42 }
  const candidates = { projectRoot: root, items: [], sources: [], truncated: false }
  const calls = [], launches = [], copies = [], inspections = []
  let pause = null, serviceError = null
  const packet = { projectRoot: root, taskDir: '10-21-example', taskTitle: 'Selected task', status: 'planning', mode: 'continue', text: 'Read selected task; preserve review barriers', issues: [], files: [] }
  const guarded = async (name, args, isCurrent) => {
    calls.push([name, ...args]); if (pause) await pause.promise
    if (!isCurrent()) throw Object.assign(new Error('来源已变化'), { code: 'SCOPE_CHANGED' })
  }
  const port = {
    async list(projectRoot) { calls.push(['list', projectRoot]); if (pause) await pause.promise; if (serviceError) throw serviceError; return snapshot },
    async discover(projectRoot) { calls.push(['discover', projectRoot]); return candidates },
    async bind(...args) { calls.push(['bind', ...args]); return snapshot },
    async setPrimary(...args) { calls.push(['setPrimary', ...args]); return snapshot },
    async unbind(...args) { calls.push(['unbind', ...args]); return snapshot },
    async prepare(projectRoot, taskDir, current) { await guarded('prepare', [projectRoot, taskDir], current); return packet },
    async continue(projectRoot, taskDir, bindingId, current) { await guarded('continue', [projectRoot, taskDir, bindingId], current); copies.push(taskDir); return { packet, copied: true } },
    async preview(projectRoot, taskDir, conversationId, current) { await guarded('preview', [projectRoot, taskDir, conversationId], current); return { projectRoot, conversationId, messages: [], truncated: false, unavailableReason: 'fixture' } },
    async inspect(projectRoot, taskDir, conversationId, current) { await guarded('inspect', [projectRoot, taskDir, conversationId], current); inspections.push(conversationId); return { source: 'codex', sessionId: 'native-1', capability: 'session' } },
    async open(projectRoot, taskDir, bindingId, isCurrent) {
      calls.push(['open', projectRoot, taskDir, bindingId])
      if (pause) await pause.promise
      if (!isCurrent()) throw Object.assign(new Error('来源已变化'), { code: 'SCOPE_CHANGED' })
      launches.push({ projectRoot, taskDir, bindingId })
      return { source: 'codex', sessionId: 'native-1', capability: 'session' }
    }
  }
  registerTaskConversationsIpc(deps, port)
  const invoke = (action, input, owner = event) => state.handlers.get(`taskConversations:${action}`)(owner, input)
  const project = { expectedRoot: root }
  const binding = { ...project, taskDir: '10-21-example', bindingId: 'binding-1' }
  const inputs = {
    list: project,
    discover: project,
    bind: { ...project, taskDir: binding.taskDir, conversationId: 'candidate-1' },
    setPrimary: binding,
    unbind: binding,
    open: binding,
    prepare: { ...project, taskDir: binding.taskDir },
    continue: binding,
    preview: { ...project, taskDir: binding.taskDir, conversationId: 'candidate-1' },
    inspect: { ...project, taskDir: binding.taskDir, conversationId: 'candidate-1' }
  }
  assert.equal(state.handlers.size, 10)
  assert.deepEqual(await invoke('list', project), { ok: true, value: snapshot })
  assert.deepEqual(await invoke('discover', project), { ok: true, value: candidates })
  assert.equal((await invoke('bind', { ...project, taskDir: binding.taskDir, conversationId: 'candidate-1' })).ok, true)
  assert.deepEqual(calls.at(-1), ['bind', root, binding.taskDir, 'candidate-1'])
  for (const action of ['setPrimary', 'unbind', 'open']) assert.equal((await invoke(action, binding)).ok, true)
  assert.deepEqual(launches, [{ projectRoot: root, taskDir: binding.taskDir, bindingId: binding.bindingId }])
  for (const action of ['prepare', 'continue', 'preview', 'inspect']) assert.equal((await invoke(action, inputs[action])).ok, true)
  assert.equal(copies.length, 1); assert.equal(inspections.length, 1)

  const before = calls.length
  for (const [action, input] of Object.entries(inputs)) {
    for (const [key, value] of Object.entries({ url: 'arbitrary://target', command: 'arbitrary-executable', args: ['--unsafe'], home: temporary, dbPath: join(temporary, 'foreign.sqlite'), source: 'codex' })) {
      assert.equal((await invoke(action, { ...input, [key]: value })).code, 'E_INVALID_ARG', `${action} must not accept renderer-owned ${key}`)
    }
    for (const malformed of [undefined, null, [], {}, { ...input, expectedRoot: 1 }]) {
      assert.equal((await invoke(action, malformed)).code, 'E_INVALID_ARG', `${action} must reject malformed payloads`)
    }
    assert.equal((await invoke(action, input, { sender, senderFrame: null })).code, 'E_DENIED', `${action} requires a live main frame`)
  }
  assert.equal((await invoke('list', { expectedRoot: '' })).code, 'E_INVALID_ARG')
  assert.equal((await invoke('open', { ...binding, url: 'arbitrary://target' })).code, 'E_INVALID_ARG')
  assert.equal((await invoke('list', { expectedRoot: join(root, 'other') })).code, 'E_CONFLICT')
  assert.equal((await invoke('list', project, { sender: { ...sender, id: 12 }, senderFrame: frame })).code, 'E_DENIED')
  assert.equal((await invoke('list', project, { sender, senderFrame: { routingId: 2 } })).code, 'E_DENIED')
  destroyed = true
  assert.equal((await invoke('list', project)).code, 'E_DENIED')
  destroyed = false
  state.root = null
  assert.equal((await invoke('list', project)).code, 'E_NO_PROJECT')
  state.root = root
  assert.equal(calls.length, before, 'invalid owners/payloads must not touch native metadata or association storage')

  for (const [code, expected] of [['NOT_FOUND', 'E_NOT_FOUND'], ['INVALID_INPUT', 'E_INVALID_ARG'], ['SCOPE_CHANGED', 'E_CONFLICT'], ['AMBIGUOUS_TASK', 'E_CONFLICT'], ['CAPABILITY_UNAVAILABLE', 'E_DENIED'], ['E_UNAVAILABLE', 'E_DENIED'], ['E_CONFLICT', 'E_CONFLICT'], ['E_INVALID_ARG', 'E_INVALID_ARG'], ['E_IO', 'E_IO'], ['unexpected', 'E_IO']]) {
    serviceError = Object.assign(new Error('source failure'), { code })
    const result = await invoke('list', project)
    assert.equal(result.code, expected)
    assert.equal(result.error, 'source failure')
  }
  serviceError = null
  const deferred = () => { let release; const promise = new Promise((done) => { release = done }); return { promise, release } }
  const ownerChanges = [
    ['project root changes', () => { state.root = join(temporary, 'another-workspace') }, () => { state.root = root }],
    ['project returns to the same root with a new generation', () => { state.generation += 2 }, () => {}],
    ['sender is destroyed', () => { destroyed = true }, () => { destroyed = false }],
    ['main window is replaced', () => { main = { webContents: { ...sender, id: 12 } } }, () => { main = originalMain }],
    ['main window is removed', () => { main = null }, () => { main = originalMain }],
    ['main frame is replaced', () => { sender.mainFrame = { routingId: 2 } }, () => { sender.mainFrame = frame }]
  ]
  for (const [reason, change, restore] of ownerChanges) {
    pause = deferred()
    const oldList = invoke('list', project)
    const oldOpen = invoke('open', binding)
    const oldNew = ['prepare', 'continue', 'preview', 'inspect'].map(action => invoke(action, inputs[action]))
    change()
    pause.release()
    assert.equal((await oldList).code, 'E_CONFLICT', `stale snapshot is fenced when ${reason}`)
    assert.equal((await oldOpen).code, 'E_CONFLICT', `native launch is fenced when ${reason}`)
    for (const pending of oldNew) assert.equal((await pending).code, 'E_CONFLICT', `new continuation/inspection action is fenced when ${reason}`)
    assert.equal(copies.length, 1); assert.equal(inspections.length, 1)
    assert.equal(launches.length, 1, `no native launch when ${reason}`)
    restore()
    pause = null
  }
  pause = deferred()
  const staleFailure = invoke('list', project)
  state.generation += 1
  serviceError = Object.assign(new Error('old project metadata failed'), { code: 'E_IO' })
  pause.release()
  assert.equal((await staleFailure).code, 'E_CONFLICT', 'failed asynchronous results retain the project generation fence')
  serviceError = null
  pause = null
  assert.equal(state.constructed, 0, 'injected service must not construct the production native service')

  const preloadFile = join(temporary, 'preload.mjs')
  await build({ entryPoints: ['src/preload/index.ts'], bundle: true, platform: 'node', format: 'esm', outfile: preloadFile, plugins: [plugin], logLevel: 'silent' })
  await import(pathToFileURL(preloadFile).href)
  const methods = { List: 'list', Discover: 'discover', Bind: 'bind', SetPrimary: 'setPrimary', Unbind: 'unbind', Open: 'open', Prepare: 'prepare', Continue: 'continue', Preview: 'preview', Inspect: 'inspect' }
  for (const [method, channel] of Object.entries(methods)) {
    const input = inputs[channel]
    assert.deepEqual(await state.api[`taskConversations${method}`](input), { ok: true, value: 'forwarded' })
    assert.deepEqual(state.invokes.at(-1), { channel: `taskConversations:${channel}`, args: [input] })
  }

  state.nativePort = port
  registerTaskConversationsIpc(deps)
  assert.equal(state.constructed, 0, 'handler registration must keep the native service lazy')
  assert.equal((await invoke('list', { expectedRoot: join(root, 'other') })).code, 'E_CONFLICT')
  assert.equal((await invoke('list', project, { sender, senderFrame: null })).code, 'E_DENIED')
  assert.equal((await invoke('open', { ...binding, command: 'arbitrary-executable' })).code, 'E_INVALID_ARG')
  assert.equal(state.constructed, 0, 'rejected requests must not construct the native service')
  assert.equal((await invoke('list', project)).ok, true)
  assert.equal((await invoke('discover', project)).ok, true)
  assert.equal(state.constructed, 1, 'accepted requests reuse one lazy native service')
  pause = deferred()
  const quittingList = invoke('list', project)
  const quittingOpen = invoke('open', binding)
  const quittingContinue = invoke('continue', inputs.continue)
  const quittingInspect = invoke('inspect', inputs.inspect)
  closeTaskConversations()
  pause.release()
  assert.equal((await quittingList).code, 'E_CONFLICT')
  assert.equal((await quittingOpen).code, 'E_CONFLICT')
  assert.equal((await quittingContinue).code, 'E_CONFLICT'); assert.equal((await quittingInspect).code, 'E_CONFLICT')
  assert.equal(copies.length, 1); assert.equal(inspections.length, 1)
  assert.equal(launches.length, 1, 'quit cancels a pending native launch')
  assert.equal(state.closed, 1, 'quit closes the lazy native service')
  for (const [action, input] of Object.entries(inputs)) {
    assert.equal((await invoke(action, input)).code, 'E_CONFLICT', `${action} must stop admitting requests after quit`)
  }
  closeTaskConversations()
  assert.equal(state.closed, 1, 'repeated cleanup must not close the native service twice')
  assert.equal(state.constructed, 1, 'closed admission must not recreate the native service')
  console.log('Task conversations IPC/preload: strict payloads, ownership changes, stale responses, clipboard/launch fences, lazy lifecycle and ten method routes passed')
} finally {
  delete globalThis.__TASK_CONVERSATIONS_IPC_SMOKE__
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('tpanel-task-conversations-ipc-'))
  rmSync(temporary, { recursive: true, force: true })
}
