/** Actual Console/history callbacks with controlled hooks and IPC; no DOM, native runtime or production profile. */
import assert from 'node:assert/strict'
import { globSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { lucideMockSource } from './icon-mocks.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-resume-producer-'))
const storage = new Map()
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
globalThis.window = { innerWidth: 1400, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {}, removeEventListener() {} }
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} }
globalThis.HTMLElement = class {}
globalThis.requestAnimationFrame = () => 0
globalThis.cancelAnimationFrame = () => {}
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const calls = [], records = new Map(), listeners = { state: new Set(), done: new Set(), output: new Set(), reset: new Set() }
const rootA = 'D:/resume-producer-a', rootB = 'D:/resume-producer-b'
const conflict = { ok: false, code: 'E_CONFLICT', error: 'fixture workspace admission conflict' }
const runtime = {
  current: null, interaction: { active: true }, toasts: [],
  state: { snapshot: { meta: { root: rootA }, tasks: [] }, pushToast: toast => runtime.toasts.push(toast), setPage() {}, showTask() {}, openArtifact() {} },
  my: { sidebarWidth: 275, sidebarCollapsed: false, requestAgentView: agentTarget => { runtime.my.agentTarget = agentTarget }, setAgentSessionTarget: id => { runtime.my.agentSessionTarget = id } }
}
globalThis.__RESUME_PRODUCER__ = runtime
const on = name => callback => { listeners[name].add(callback); return () => listeners[name].delete(callback) }
const emit = (name, payload) => { for (const callback of [...listeners[name]]) callback(payload) }
const mutate = (kind, id, input) => { const request = { ...deferred(), kind, id, input, root: runtime.state.snapshot.meta.root }; calls.push(request); return request.promise }
const currentRecords = () => records.get(runtime.state.snapshot.meta.root) ?? []
const findRecord = id => currentRecords().find(record => record.sessionId === id)
const api = {
  acpAgents: async () => ({ ok: true, agents: [{ id: 'codex', name: 'Codex', enabled: true, available: true }] }),
  acpProfiles: async () => ({ ok: true, profiles: [{ id: 'developer', name: 'Developer', runtimeId: 'codex', instructions: '', maxTurnMinutes: 30 }] }),
  acpSessions: () => { throw Error('Modern history must not call legacy snapshots') },
  acpHistoryList: async () => ({ ok: true, version: 1, sessions: structuredClone(currentRecords()), nextCursor: null, hasMore: false, diagnostics: [] }),
  acpHistorySession: async id => ({ ok: true, version: 1, session: structuredClone(findRecord(id)) }),
  acpHistoryEvents: async id => { const session = structuredClone(findRecord(id)); return { ok: true, version: 1, session, events: [{ id: `question-${id}`, projectRoot: session.projectRoot, sessionId: id, source: 'acp', kind: 'message', ts: 1, text: 'saved question', payload: { role: 'user' } }], beforeCursor: null, afterCursor: null, hasEarlier: false, hasLater: false, startsMidTurn: false, coverage: session.historyCoverage } },
  acpSessionResume: id => mutate('resume', id), acpSessionKill: id => mutate('kill', id),
  acpSessionPrompt: (id, text, options) => mutate('prompt', id, { text, options }), acpSessionNew: input => mutate('new', undefined, input),
  acpSessionConfigure: (id, input) => mutate('configure', id, input), acpSessionRecoverModel: (id, input) => mutate('recover-model', id, input),
  onAcpState: on('state'), onAcpDone: on('done'), onAcpOutput: on('output'), onDaemonRuntimeReset: on('reset'), onMaterialUpdated: () => () => {}
}
runtime.api = api

// Same hook-controller approach as acp-ui.mjs. Children remain element records;
// test the actual source's effects and callbacks, not DOM or React scheduling.
class Harness {
  hooks = []; index = 0; effects = []; dirty = false; tree = null
  constructor(component, props = {}) { this.component = component; this.props = props }
  same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  useState = initial => {
    const slot = this.hooks[this.index++] ??= { value: typeof initial === 'function' ? initial() : initial }
    return [slot.value, value => { const next = typeof value === 'function' ? value(slot.value) : value; if (!Object.is(next, slot.value)) { slot.value = next; this.dirty = true } }]
  }
  useRef = initial => this.hooks[this.index++] ??= { current: initial }
  useMemo = (compute, deps) => { const index = this.index++, slot = this.hooks[index]; if (!slot || !this.same(slot.deps, deps)) this.hooks[index] = { deps, value: compute() }; return this.hooks[index].value }
  useCallback = (callback, deps) => this.useMemo(() => callback, deps)
  useEffect = (effect, deps) => { const index = this.index++, slot = this.hooks[index]; if (!slot || !this.same(slot.deps, deps)) this.effects.push(() => { slot?.cleanup?.(); this.hooks[index] = { deps, effect, cleanup: effect() } }) }
  render = () => {
    let iterations = 0
    do { assert.ok(++iterations < 40, 'bounded render updates'); runtime.current = this; this.index = 0; this.effects = []; this.dirty = false; this.tree = this.component(this.props); for (const effect of this.effects) effect() } while (this.dirty)
  }
  dispose = () => { for (const slot of this.hooks) slot?.cleanup?.() }
}
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children), ...nodes(tree.props?.sendAction)]
const all = (page, predicate) => nodes(page.tree).filter(predicate)
const find = (page, predicate) => { const node = all(page, predicate)[0]; assert.ok(node, 'expected fixture element'); return node }
const component = (page, name) => find(page, node => node.type?.name === name)
const pump = async page => { for (let index = 0; index < 12; index++) { await new Promise(resolve => setImmediate(resolve)); page.render() } }
const check = name => console.log(`PASS ${name}`)
const summary = (sessionId, projectRoot = rootA, extra = {}) => ({ sessionId, projectRoot, title: sessionId, agentId: 'codex', agentName: 'Codex', status: 'disconnected', canResume: true, connectionOwned: false, cleanupRequired: false, connectionGeneration: `generation-${sessionId}`, startedAt: 1, lastActivityAt: 1, hasConversation: true, eventCount: 1, stateRevision: 1, pendingPermissions: [], historyCoverage: { state: 'complete', capturedFrom: 1 }, ...extra })
const headerMenu = page => ({ tree: find(page, node => node.type?.name === 'Dropdown' && node.props.trigger({ open: false, toggle() {} }).props['aria-label'] === '更多会话操作').props.children(() => {}) })
const endItems = page => all(headerMenu(page), node => node.props?.children === '结束当前会话')
const select = (page, id) => { component(page, 'ConversationNavigation').props.onSelect(id); page.render() }
const refresh = async page => { find(headerMenu(page), node => node.props?.children === '刷新').props.onClick(); await pump(page) }
const patchState = async (page, id, patch) => { const record = findRecord(id); Object.assign(record, patch, { stateRevision: record.stateRevision + 1 }); emit('state', { ...record, session: structuredClone(record) }); await pump(page) }
let page
try {
  const source = resolve('src/renderer/src/acp/ConsoleWorkspace.tsx').replaceAll('\\', '/')
  const pickerSource = resolve('src/renderer/src/acp/ComposerModelPicker.tsx').replaceAll('\\', '/')
  const entry = join(temporary, 'entry.ts')
  writeFileSync(entry, `export { AcpConsolePage } from ${JSON.stringify(source)}; export { ComposerModelPicker } from ${JSON.stringify(pickerSource)};`)
  const mocks = {
    react: `const r=globalThis.__RESUME_PRODUCER__;${['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect'].map(name => `export const ${name}=(...args)=>r.current.${name}(...args);`).join('')} export const useLayoutEffect=useEffect;export const useId=()=>'fixture';export const createContext=value=>({_value:value});export const useContext=context=>context._value?.active===true?r.interaction:context._value;export const useSyncExternalStore=(_s,get)=>get();export const useDebugValue=()=>{};export default {memo:c=>c,useSyncExternalStore,useDebugValue};`,
    'react/jsx-runtime': 'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;export const Fragment="fragment";',
    'lucide-react': lucideMockSource([...globSync('src/renderer/src/**/*.tsx')]),
    '../api': 'export const api=globalThis.__RESUME_PRODUCER__.api;export const hasIpc=true;',
    '../store': 'const r=globalThis.__RESUME_PRODUCER__;export const useApp=selector=>selector(r.state);useApp.getState=()=>r.state;export const useMy=selector=>selector(r.my);',
    '../my/store': 'const r=globalThis.__RESUME_PRODUCER__;export const useMy=selector=>selector(r.my);useMy.getState=()=>r.my;',
    '../my/ui': 'export function Button(){} export function Modal(){} export function Dropdown(){} export function DropdownHeader(){} export function DropdownItem(){} export function Tooltip(){}',
    '../components/Dialogs': 'export const confirmDialog=async()=>false;',
    '../components/Select': 'export function Select(){}',
    '../components/ToolBrandIcon': 'export function ToolBrandIcon(){}',
    '../knowledge/request-intake': 'export const useKnowledgeRequest=selector=>selector({});useKnowledgeRequest.getState=()=>({});export const requirementsDraftText=()=>"";',
    './workflow/use-managed-workflow': 'export const useManagedWorkflow=()=>({available:false,loading:false});',
    './useComposerImages': 'export const useComposerImages=()=>({images:[],pending:false,consume(){},choose(){}});',
    './workspace.css': ''
  }
  for (const name of ['ConversationNavigation', 'WorkspaceInspector', 'ConversationArtifactCard', 'ConversationDocumentPane', 'ProfileEditor', 'RuntimePanel', 'AgentRoleDetails', 'NewConversationPicker', 'TranscriptRow', 'CurrentTurnStatus', 'ComposerUsageIndicator', 'ImageAttachments', 'JiraPicker', 'ConversationKnowledgePanel', 'workflow/WorkflowPanel', 'workflow/WorkflowRecovery']) {
    const exports = ({ TranscriptRow: ['EventRow'], JiraPicker: ['JiraPickerModal'], RuntimePanel: ['RuntimePanel', 'runtimeHealthLabel'] })[name] ?? [name.split('/').at(-1)]
    mocks[`./${name}`] = exports.map(name => `export function ${name}(){}`).join('')
  }
  await build({ entryPoints: [entry], outfile: join(temporary, 'fixture.mjs'), bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', nodePaths: [resolve('node_modules')], plugins: [{ name: 'producer-fixture', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }] })
  const { AcpConsolePage, ComposerModelPicker } = await import(pathToFileURL(join(temporary, 'fixture.mjs')).href)
  records.set(rootA, [summary('owned-offline', rootA, { connectionOwned: true }), summary('other-offline'), summary('failed', rootA, { status: 'error' })])
  records.set(rootB, [summary('project-b', rootB)])
  const key = root => `tpanel.acp.view.${encodeURIComponent(root.toLowerCase())}`
  storage.set(key(rootA), JSON.stringify({ activeId: 'owned-offline', view: 'conversation', sessions: [{ id: 'owned-offline', draft: 'keep this unsent draft', follow: true, updatedAt: 1 }] }))
  page = new Harness(AcpConsolePage); page.render(); await pump(page)
  assert.deepEqual(calls.map(call => [call.kind, call.id]), [['resume', 'owned-offline']])
  const automatic = calls.at(-1)
  for (let index = 0; index < 25; index++) { await patchState(page, 'owned-offline', { status: 'disconnected' }); await refresh(page); select(page, 'owned-offline') }
  assert.equal(calls.length, 1, 'refresh/status/selection cannot add in-flight resume requests')
  automatic.resolve(conflict); await pump(page)
  assert.equal(component(page, 'ConnectionRecovery').props.message, conflict.error)
  assert.equal(find(page, node => node.type === 'textarea').props.value, 'keep this unsent draft')
  for (let index = 0; index < 5; index++) { runtime.interaction = { active: false }; page.render(); runtime.interaction = { active: true, signal: new AbortController().signal }; page.render(); await refresh(page) }
  select(page, 'failed'); await pump(page); select(page, 'owned-offline'); await pump(page)
  assert.equal(calls.length, 1, 'settled failure and Settings/selection return do not authorize retry')
  check('one automatic resume survives 25 status/refresh/selection cycles, five Settings cycles and a truthful conflict without replay')

  const recovery = () => component(page, 'ConnectionRecovery')
  recovery().props.onRetry(); recovery().props.onRetry(); page.render()
  assert.equal(calls.length, 2, 'explicit duplicate retry is locked while pending')
  assert.equal(calls.at(-1).kind, 'resume')
  calls.at(-1).resolve(conflict); await pump(page)
  recovery().props.onRetry(); page.render(); calls.at(-1).resolve(conflict); await pump(page)
  assert.equal(calls.length, 3, 'a later explicit retry remains available')
  check('explicit retries produce distinct requests; pending duplicate callbacks stay locked')

  // This assertion fails against the unmodified production condition: the
  // real backend facts can hold a workspace while the only End entry is hidden.
  assert.equal(endItems(page).length, 1, 'owned disconnected connection must expose End even without cleanupRequired/restorePending')
  recovery().props.onRetry(); page.render()
  const olderResume = calls.at(-1)
  endItems(page)[0].props.onClick(); endItems(page)[0].props.onClick(); page.render()
  const stop = calls.at(-1)
  assert.equal(stop.kind, 'kill'); assert.equal(stop.id, 'owned-offline')
  assert.equal(calls.filter(call => call.kind === 'kill').length, 1)
  olderResume.resolve(conflict); await pump(page)
  assert.equal(recovery().props.pending, 'kill', 'older resume result cannot clear superseding canonical stop')
  stop.resolve({ ok: false, error: 'fixture shutdown failed' }); await pump(page)
  assert.equal(recovery().props.message, 'fixture shutdown failed')
  assert.equal(endItems(page).length, 1, 'failed canonical cleanup remains explicitly retryable')
  const beforeStop = calls.length
  const savedRows = all(page, node => node.type?.name === 'EventRow').map(node => node.props.item)
  assert.ok(savedRows.length > 0, 'fixture contains actual saved transcript rows')
  endItems(page)[0].props.onClick(); page.render()
  await patchState(page, 'owned-offline', { status: 'closed', connectionOwned: false, cleanupRequired: false, canResume: true })
  calls.at(-1).resolve({ ok: true }); await pump(page)
  assert.equal(calls.length, beforeStop + 1, 'Stop and its status/refresh must not auto-resume')
  assert.equal(endItems(page).length, 0, 'unowned offline history has no process End action')
  assert.deepEqual(all(page, node => node.type?.name === 'EventRow').map(node => node.props.item), savedRows)
  assert.equal(find(page, node => node.type === 'textarea').props.value, 'keep this unsent draft')
  check('owned disconnected End uses exact canonical kill; stop supersedes resume, failed cleanup retries and success preserves draft/history without reconnect')
  await patchState(page, 'owned-offline', { cleanupRequired: true })
  assert.equal(endItems(page).length, 1, 'explicit cleanup fact also retains End')
  await patchState(page, 'owned-offline', { cleanupRequired: false })

  select(page, 'other-offline'); await pump(page)
  assert.equal(calls.at(-1).kind, 'resume'); assert.equal(calls.at(-1).id, 'other-offline')
  calls.at(-1).resolve(conflict); await pump(page)
  const beforeRemount = calls.length
  page.dispose(); page = new Harness(AcpConsolePage); page.render(); await pump(page)
  assert.equal(calls.length, beforeRemount + 1, 'a real new source lifetime may try a disconnected history once')
  calls.at(-1).resolve(conflict); await pump(page)
  select(page, 'failed'); await pump(page); page.dispose(); page = new Harness(AcpConsolePage); page.render(); await pump(page)
  assert.equal(calls.length, beforeRemount + 1, 'error history never auto-retries, even after remount')
  runtime.state.snapshot = { meta: { root: rootB }, tasks: [] }; page.render(); await pump(page); select(page, 'project-b'); await pump(page)
  assert.equal(calls.at(-1).id, 'project-b')
  const staleResumeB = calls.at(-1)
  runtime.state.snapshot = { meta: { root: rootA }, tasks: [] }; page.render(); await pump(page)
  staleResumeB.resolve({ ok: true }); await pump(page)
  assert.equal(component(page, 'ConnectionRecovery').props.session.sessionId, 'failed')
  check('true source remount permits one disconnected attempt; error records and foreign root callbacks retain their fences')

  await patchState(page, 'failed', { status: 'ready', connectionOwned: true })
  find(page, node => node.type === 'textarea').props.onChange({ target: { value: 'explicit send' } }); page.render()
  const send = find(page, node => node.props?.title === '发送指令').props.onClick
  const beforeSend = calls.length; send(); send(); page.render()
  assert.equal(calls.length, beforeSend + 1); assert.equal(calls.at(-1).kind, 'prompt')
  calls.at(-1).resolve(conflict); await pump(page)
  assert.equal(find(page, node => node.type === 'textarea').props.value, 'explicit send')
  component(page, 'ConversationNavigation').props.onNew(); page.render()
  const chooser = component(page, 'NewConversationPicker')
  const beforeNew = calls.length; chooser.props.onStart(chooser.props.profiles[0]); chooser.props.onStart(chooser.props.profiles[0]); page.render()
  assert.equal(calls.length, beforeNew + 1); assert.equal(calls.at(-1).kind, 'new')
  calls.at(-1).resolve(conflict); await pump(page)
  assert.equal(component(page, 'NewConversationPicker').props.error, conflict.error)
  component(page, 'NewConversationPicker').props.onClose(); page.render()
  const pickerProps = component(page, 'ComposerModelPicker').props
  const picker = new Harness(ComposerModelPicker, { ...pickerProps, session: { ...pickerProps.session, currentModelId: 'model-a', models: [{ modelId: 'model-a', name: 'Model A' }, { modelId: 'model-b', name: 'Model B' }], capabilities: { controls: ['session/set_model'] } } })
  picker.render()
  const menu = { tree: find(picker, node => node.type?.name === 'Dropdown' && node.props.align === 'right').props.children(() => {}) }
  const choose = find(menu, node => node.props?.children === 'Model B').props.onClick
  const beforeModel = calls.length; choose(); choose(); picker.render()
  assert.equal(calls.length, beforeModel + 1); assert.equal(calls.at(-1).kind, 'configure')
  calls.at(-1).resolve(conflict); await pump(picker)
  assert.equal(component(picker, 'ConnectionNotice').props.message, conflict.error)
  assert.equal(picker.props.session.currentModelId, 'model-a'); picker.dispose()
  check('send, new and model selection each dispatch only their own mutation once, expose rejection and retain unsent/acknowledged state')
  console.log('ACP resume producer regression passed (controlled source callbacks; no DOM/native/production acceptance claimed)')
} finally {
  page?.dispose()
  const path = resolve(temporary)
  assert.ok(path.startsWith(resolve(tmpdir()) + '\\') || path.startsWith(resolve(tmpdir()) + '/'), 'owned temporary fixture only')
  rmSync(path, { recursive: true, force: true })
  delete globalThis.__RESUME_PRODUCER__
}
