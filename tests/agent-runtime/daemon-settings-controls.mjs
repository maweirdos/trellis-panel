import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { build } from 'esbuild'

// Actual handlers with deterministic hook slots and deferred dialogs. This is
// not DOM/native-window acceptance and never connects to a real daemon.
const temporary = mkdtempSync(join(tmpdir(), 'trellis-daemon-settings-'))
const key = '__daemonSettings' + randomUUID().replaceAll('-', '')
const state = { slots: [], cursor: 0, effects: [], cleanups: [], dialogs: [], calls: [], signal: new AbortController().signal }
const require = createRequire(import.meta.url)
const status = { state: 'running', runtimeAuthority: 'daemon', activeJobs: 0, unknownJobs: 0, preferences: { revision: 4, keepRunning: true, startup: 'manual' } }
let releaseConfirm
state.confirm = options => { state.dialogs.push(options); return new Promise(resolve => { releaseConfirm = resolve }) }
state.api = { daemon: {
  protocolVersion: 1, status: async () => ({ ok: true, data: status }),
  start: async () => { state.calls.push('start'); return { ok: true, data: status } },
  stop: async () => { state.calls.push('stop'); return state.stopResult ?? { ok: true, data: null } },
  restart: async () => { state.calls.push('restart'); return { ok: true, data: status } },
  preferences: async () => ({ ok: true, data: status.preferences }), setPreferences: async () => { throw Error('unexpected preference write') }, logs: async () => ({ ok: true, data: { entries: [] } })
} }
globalThis[key] = state
const flush = () => new Promise(resolve => setImmediate(resolve))
function find(root, label) {
  if (!root || typeof root !== 'object') return null
  if (root.type === 'button' && root.props.children === label) return root
  for (const child of [root.props?.children].flat(Infinity)) { const result = find(child, label); if (result) return result }
  return null
}
function text(root) {
  if (root == null || typeof root === 'boolean') return ''
  if (typeof root !== 'object') return String(root)
  return [root.props?.children].flat(Infinity).map(text).join(' ')
}
try {
  const file = join(temporary, 'settings.cjs')
  await build({ entryPoints: ['src/renderer/src/daemon/DaemonSettings.tsx'], outfile: file, bundle: true, format: 'cjs', platform: 'node', jsx: 'automatic', plugins: [{ name: 'settings-hooks', setup(builder) {
    builder.onResolve({ filter: /^react$|^react\/jsx-runtime$|^\.\.\/api$|^\.\.\/components\/Dialogs$|^\.\.\/utils\/interaction-scope$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
      const prelude = 'const s=globalThis[' + JSON.stringify(key) + '];'
      let contents
      if (args.path === 'react/jsx-runtime') return { contents: 'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;export const Fragment="fragment";' }
      if (args.path === 'react') contents = 'export function useState(initial){const i=s.cursor++;if(!(i in s.slots))s.slots[i]=initial;return[s.slots[i],value=>{s.slots[i]=typeof value==="function"?value(s.slots[i]):value}]};export function useRef(initial){const i=s.cursor++;return s.slots[i]??=({current:initial})};export function useCallback(fn){const i=s.cursor++;return s.slots[i]??=fn};export function useEffect(fn){const i=s.cursor++;if(!(i in s.slots)){s.slots[i]=true;s.effects.push(fn)}}'
      else if (args.path === '../api') contents = 'export const api=s.api'
      else if (args.path.includes('Dialogs')) contents = 'export const confirmDialog=options=>s.confirm(options)'
      else contents = 'export const useInteractionSignal=()=>s.signal'
      return { contents: prelude + contents }
    })
  } }] })
  const { DaemonSettings } = require(file)
  function render() { state.cursor = 0; const view = DaemonSettings(); for (const effect of state.effects.splice(0)) { const cleanup = effect(); if (cleanup) state.cleanups.push(cleanup) }; return view }
  render(); await flush()
  const view = render()
  assert.equal(find(view, '停止').props.disabled, false)
  const stop = find(view, '停止').props.onClick
  stop(); stop()
  assert.equal(state.dialogs.length, 1, 'a stale handler must not open a second confirmation')
  assert.equal(find(render(), '重启').props.disabled, true)
  assert.match(state.dialogs[0].message, /所有 Agent 与集成任务/)
  assert.deepEqual(state.calls, [])
  releaseConfirm(false); await flush()
  assert.deepEqual(state.calls, [])
  console.log('PASS settings lock includes confirmation and cancellation preserves tasks/preferences')

  const daemon = state.api.daemon
  state.api.daemon = undefined
  let quitRequests = 0, replyQuit
  state.api.appQuit = () => { quitRequests++; return new Promise(resolve => { replyQuit = resolve }) }
  const quit = find(render(), '退出应用')
  assert.equal(quit.props.disabled, false)
  quit.props.onClick(); quit.props.onClick()
  assert.equal(quitRequests, 1)
  assert.equal(state.dialogs.length, 1, 'quit must use the native quit gate, without another renderer confirmation')
  assert.deepEqual(state.calls, [], 'GUI quit must not call any daemon management method')
  replyQuit({ ok: false, code: 'E_DENIED', error: 'fixture quit denied' }); await flush()
  assert.match(text(render()), /fixture quit denied/)
  assert.equal(find(render(), '退出应用').props.disabled, false)
  delete state.api.appQuit
  assert.equal(find(render(), '退出应用').props.disabled, true)
  state.api.daemon = daemon
  console.log('PASS GUI quit works without daemon API, deduplicates, shows rejection and tolerates older preload')

  find(render(), '停止').props.onClick()
  releaseConfirm(true); await flush()
  assert.match(text(render()), /后台已停止/)
  assert.equal(find(render(), '重启').props.disabled, true)
  find(render(), '启动').props.onClick(); await flush()
  assert.doesNotMatch(text(render()), /后台已停止/)
  assert.match(text(render()), /运行中/)
  state.calls.length = 0
  console.log('PASS confirmed stop and subsequent start show distinct verified states')

  const original = randomUUID()
  state.stopResult = { ok: false, code: 'E_UNKNOWN', outcome: 'unknown', error: 'fixture original stop unknown', commandId: original }
  find(render(), '停止').props.onClick()
  releaseConfirm(true); await flush()
  assert.deepEqual(state.calls, ['stop'])
  assert.match(text(render()), new RegExp(original))
  assert.doesNotMatch(text(render()), /后台已停止/)
  assert.deepEqual(status.preferences, { revision: 4, keepRunning: true, startup: 'manual' })
  console.log('PASS settings retains original unknown command in the actionable error')

  const abort = new AbortController(); state.signal = abort.signal
  find(render(), '重启').props.onClick()
  abort.abort(); releaseConfirm(true); await flush()
  assert.deepEqual(state.calls, ['stop'])
  assert.equal(find(render(), '重启').props.disabled, false)
  console.log('PASS suspended interaction cannot submit a late confirmed restart')

  state.signal = undefined
  find(render(), '重启').props.onClick()
  state.cleanups.forEach(cleanup => cleanup())
  releaseConfirm(true); await flush()
  assert.deepEqual(state.calls, ['stop'])
  console.log('PASS unmounted settings cannot submit a late confirmation even without an interaction signal')
} finally {
  state.cleanups.forEach(cleanup => cleanup())
  delete globalThis[key]
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep))
  rmSync(temporary, { recursive: true, force: true })
}
