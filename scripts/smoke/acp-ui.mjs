/** Actual ACP component hook/event handlers, without mounting DOM or claiming native acceptance. */
import assert from 'node:assert/strict'
import { globSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { lucideMockSource } from './icon-mocks.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-acp-ui-'))
const storage = new Map()
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
const windowListeners = new Map()
globalThis.window = { innerWidth: 1440, innerHeight: 900, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener(name, callback) { windowListeners.set(name, callback) }, removeEventListener(name) { windowListeners.delete(name) } }
globalThis.document = { activeElement: null, body: {}, addEventListener() {}, removeEventListener() {} }
globalThis.HTMLElement = class {}
globalThis.requestAnimationFrame = (callback) => callback()
class Harness {
  hooks = []; index = 0; effects = []; dirty = false; tree = null
  constructor(component, props = {}) { this.component = component; this.props = props }
  same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  useState = (initial) => {
    const index = this.index++, slot = this.hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial }
    return [slot.value, (value) => { const next = typeof value === 'function' ? value(slot.value) : value; if (!Object.is(next, slot.value)) { slot.value = next; this.dirty = true } }]
  }
  useRef = (initial) => this.hooks[this.index++] ??= { current: initial }
  useMemo = (compute, deps) => {
    const index = this.index++, slot = this.hooks[index]
    if (!slot || !this.same(slot.deps, deps)) this.hooks[index] = { deps, value: compute() }
    return this.hooks[index].value
  }
  useCallback = (callback, deps) => this.useMemo(() => callback, deps)
  useEffect = (effect, deps) => {
    const index = this.index++, slot = this.hooks[index]
    if (!slot || !this.same(slot.deps, deps)) this.effects.push(() => { slot?.cleanup?.(); this.hooks[index] = { deps, cleanup: effect() } })
  }
  render = () => {
    let iterations = 0
    do {
      assert.ok(++iterations < 30, 'bounded render updates')
      runtime.current = this; this.index = 0; this.effects = []; this.dirty = false; this.tree = this.component(this.props)
      for (const effect of this.effects) effect()
    } while (this.dirty)
  }
  dispose = () => { for (const slot of this.hooks) slot?.cleanup?.() }
}
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const lists = [], creates = [], sends = [], approvals = [], configures = [], cancels = [], recoveries = []
const outputs = new Set(), states = new Set(), dones = new Set(), materials = new Set()
const rootA = 'D:/fixture-a', rootB = 'D:/fixture-b'
const runtime = {
  current: null, toasts: [], confirm: false, escClose: null,
  state: { snapshot: { meta: { root: rootA }, tasks: [] }, pushToast: (toast) => runtime.toasts.push(toast), setPage() {}, showTask() {}, openArtifact() {} },
  api: {
    acpAgents: async () => ({ ok: true, agents: [{ id: 'codex', name: 'Codex', enabled: true, available: true, health: 'not_checked', command: 'fixed' }] }),
    acpProfiles: async () => ({ ok: true, profiles: [{ id: 'developer', name: 'Developer', runtimeId: 'codex', description: 'Local role', instructions: 'Test', maxTurnMinutes: 30 }] }),
    acpSessions: () => { const request = deferred(); lists.push({ ...request, root: runtime.state.snapshot?.meta.root }); return request.promise },
    acpSessionNew: (input) => { const request = deferred(); creates.push({ ...request, input }); return request.promise },
    acpSessionPrompt: (id, text, options) => { const request = deferred(); sends.push({ ...request, id, text, options }); return request.promise },
    acpPermissionRespond: (requestId, optionId) => { const request = deferred(); approvals.push({ ...request, requestId, optionId }); return request.promise },
    acpSessionConfigure: (sessionId, input) => { const request = deferred(); configures.push({ ...request, sessionId, input }); return request.promise },
    acpSessionRecoverModel: (sessionId, input) => { const request = deferred(); recoveries.push({ ...request, sessionId, input }); return request.promise },
    acpSessionCancel: (sessionId) => { const request = deferred(); cancels.push({ ...request, sessionId }); return request.promise },
    acpSessionKill: async () => ({ ok: false, error: 'kill failed' }),
    acpSessionResume: async () => ({ ok: true }),
    onAcpOutput: (callback) => { outputs.add(callback); return () => outputs.delete(callback) },
    onAcpState: (callback) => { states.add(callback); return () => states.delete(callback) },
    onAcpDone: (callback) => { dones.add(callback); return () => dones.delete(callback) },
    onMaterialUpdated: (callback) => { materials.add(callback); return () => materials.delete(callback) }
  }
}
globalThis.__ACP_UI__ = runtime
const nodes = (tree) => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children), ...nodes(tree.props?.sendAction), ...nodes(tree.props?.usage)]
const find = (harness, predicate) => { const result = nodes(harness.tree).find(predicate); assert.ok(result, 'expected ACP interactive element'); return result }
const findAll = (harness, predicate) => nodes(harness.tree).filter(predicate)
const settle = async (harness) => { for (let index = 0; index < 7; index++) await Promise.resolve(); harness.render() }
const emit = (listeners, payload) => { for (const callback of [...listeners]) callback(payload) }
const record = (id, root = rootA, events = []) => ({ sessionId: id, title: id, projectRoot: root, agentId: 'codex', agentName: 'Codex', status: 'ready', startedAt: 10, events, connectionGeneration: `conn-${id}`, pendingPermissions: events.flatMap((event) => event.payload?.pending === true && event.payload?.permission ? [event.payload.permission] : []) })
const permission = (id, sessionId, root = rootA) => ({ id, ts: 10, source: 'acp', kind: 'permission', projectRoot: root, sessionId, payload: { requestId: id, pending: true, permission: { requestId: id, sessionId, agentName: 'Codex', connectionGeneration: `conn-${sessionId}`, options: [{ optionId: 'allow-first', kind: 'allow_once', name: 'Allow first' }, { optionId: 'allow-second', kind: 'allow_once', name: 'Allow second' }, { optionId: 'deny-always', kind: 'reject_always', name: 'Deny always' }] } } })
const check = (name, condition) => { assert.ok(condition, name); console.log(`PASS ${name}`) }

try {
  const files = [...globSync('src/renderer/src/**/*.tsx')]
  const iconMock = lucideMockSource(files)
  const mocks = {
    react: `const r = globalThis.__ACP_UI__; ${['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect'].map((name) => `export const ${name} = (...args) => r.current.${name}(...args);`).join('\n')} export const useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot(); export const useDebugValue = () => {}; export const useId = () => 'acp-test'; export const createContext = (value) => ({ _value:value, Provider:() => null }); export const useContext = (context) => context._value; export const useLayoutEffect = useEffect; export default { memo: (component) => component, useDebugValue, useSyncExternalStore };`,
    'react/jsx-runtime': 'export const jsx = (type, props, key) => ({ type, props, key }); export const jsxs = jsx; export const Fragment = "fragment";',
    'lucide-react': iconMock,
    '../my/store': 'const state = {sidebarWidth:275,sidebarCollapsed:false,setSidebarWidth(){},toggleSidebar(){},requestAgentView(){},setAgentSessionTarget(){}}; export const useMy = (selector) => selector(state); useMy.getState=()=>state;',
    '../api': 'export const api = globalThis.__ACP_UI__.api; export const hasIpc = true;',
    '../store': 'const r = globalThis.__ACP_UI__; export const useApp = (selector) => selector(r.state); useApp.getState = () => r.state; export const useMy = (selector) => selector({sidebarWidth:275,sidebarCollapsed:false,setSidebarWidth(){},toggleSidebar(){}});',
    '../../store': 'const r = globalThis.__ACP_UI__; export const useApp = (selector) => selector(r.state); useApp.getState = () => r.state;',
    '../my/ui': 'export function Button() {} export function Modal({open,children}) { return open ? children : null } export function Dropdown() {} export function DropdownHeader() {} export function DropdownItem() {} export function Tooltip() {}',
    '../components/MarkdownView': 'export function MarkdownView() {}',
    '../components/Dialogs': 'export const confirmDialog = async () => globalThis.__ACP_UI__.confirm;',
    '../observation/ObservationPanel': 'export function ObservationPanel() {}'
    ,'./ConversationNavigation': 'export function ConversationNavigation() {}'
    ,'./WorkspaceInspector': 'export function WorkspaceInspector() {}'
    ,'./ConversationDocumentPane': 'export function ConversationDocumentPane() {}'
    // This legacy hook fixture does not render React Flow; the actual graph has its own Chromium suite.
    ,'./workflow/WorkflowRecovery': 'export function WorkflowRecovery() { return null }'
    ,'./workflow/WorkflowPanel': 'export function WorkflowPanel() { return null }'
    ,'./workflow/use-managed-workflow': 'export function useManagedWorkflow() { return {available:false,loading:false,snapshot:null,events:[],operation:"",error:"",notice:"",preview:null,stop:async()=>false,refresh:async()=>{}} }'
    ,'./workspace.css': ''
    ,'react-dom': 'export const createPortal = (children) => children;'
    ,'../utils/use-esc-layer': 'export const useEscLayer = (active, input) => { if (active) globalThis.__ACP_UI__.escClose = input.onClose };'
  }
  const plugin = { name: 'hook-mocks', setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined)
    plugin.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({ contents: mocks[args.path], loader: 'js' }))
  } }
  await build({ entryPoints: ['src/renderer/src/pages/AcpConsole.tsx', 'src/renderer/src/acp/timeline.ts', 'src/renderer/src/acp/SessionDetails.tsx', 'src/renderer/src/acp/TranscriptRow.tsx', 'src/renderer/src/acp/view-state.ts', 'src/renderer/src/acp/conversation-selection.ts', 'src/renderer/src/acp/ConversationNavigation.tsx', 'src/renderer/src/acp/ConnectionNotice.tsx', 'src/renderer/src/acp/ComposerModelPicker.tsx', 'src/renderer/src/acp/model-recovery.ts', 'src/renderer/src/acp/CurrentTurnStatus.tsx', 'src/renderer/src/acp/current-turn-activity.ts'], outdir: temporary, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [plugin] })
  const { AcpConsolePage } = await import(pathToFileURL(join(temporary, 'pages/AcpConsole.js')).href)
  const { compileItems, mergeEvents } = await import(pathToFileURL(join(temporary, 'acp/timeline.js')).href)
  const { SessionDetails, StartupGroup } = await import(pathToFileURL(join(temporary, 'acp/SessionDetails.js')).href)
  const { EventRow } = await import(pathToFileURL(join(temporary, 'acp/TranscriptRow.js')).href)
  const { ConnectionRecovery } = await import(pathToFileURL(join(temporary, 'acp/ConnectionNotice.js')).href)
  const { ComposerModelPicker } = await import(pathToFileURL(join(temporary, 'acp/ComposerModelPicker.js')).href)
  const { getModelRecovery } = await import(pathToFileURL(join(temporary, 'acp/model-recovery.js')).href)
  const { CurrentTurnStatus } = await import(pathToFileURL(join(temporary, 'acp/CurrentTurnStatus.js')).href)
  const { projectCurrentTurnActivity } = await import(pathToFileURL(join(temporary, 'acp/current-turn-activity.js')).href)
  const modelDropdown = (picker) => find(picker, (node) => node.type?.name === 'Dropdown' && node.props.align === 'right')
  const modelPopup = (picker, close = () => {}) => ({ tree: modelDropdown(picker).props.children(close) })
  const openModels = (picker, close) => {
    modelDropdown(picker).props.trigger({ open: false, toggle() {} }).props.onClick(); picker.render()
    const caption = findAll(modelPopup(picker), (node) => node.props?.['aria-label'] === '进入模型选择')[0]
    if (caption) { caption.props.onClick(); picker.render() }
    return modelPopup(picker, close)
  }
  const modelItems = (popup) => findAll(popup, (node) => node.type?.name === 'DropdownItem')
  const views = await import(pathToFileURL(join(temporary, 'acp/view-state.js')).href)
  const longDraft = '长草稿'.repeat(18000)
  views.writeSessionView('D:/draft-roundtrip', 'draft', { draft: longDraft })
  const restoredViews = await import(`${pathToFileURL(join(temporary, 'acp/view-state.js')).href}?restart`)
  check('persisted accepted long draft survives a fresh view-state module without truncation', restoredViews.readSessionView('D:/draft-roundtrip', 'draft').draft === longDraft)
  const page = new Harness(AcpConsolePage)
  const rows = () => findAll(page, (node) => node.type?.name === 'EventRow')
  const navigation = () => find(page, (node) => node.type?.name === 'ConversationNavigation')
  const select = (id) => { navigation().props.onSelect(id); page.render() }
  const library = () => { navigation().props.onView('agents'); page.render() }
  const textarea = () => find(page, (node) => node.type === 'textarea')
  const draft = (text) => { textarea().props.onChange({ target: { value: text } }); page.render() }
  const refresh = () => {
    const direct = findAll(page, (node) => node.props?.title === '刷新会话')[0]
    if (direct) return direct.props.onClick()
    const menu = find(page, (node) => node.type?.name === 'Dropdown' && node.props.align === 'right')
    return find({ tree: menu.props.children(() => {}) }, (node) => node.props?.children === '刷新').props.onClick()
  }
  const startNew = () => { navigation().props.onNew(); page.render(); const picker=find(page,node=>node.type?.name==='NewConversationPicker'); picker.props.onStart(picker.props.profiles[0], undefined, false) }
  const sendButton = () => find(page, (node) => node.props?.title === '发送指令')
  page.render()
  const early = permission('early', 'a1')
  emit(outputs, early)
  lists.shift().resolve({ ok: true, sessions: [record('a1', rootA, [early]), record('a2'), record('foreign', rootB)] })
  await settle(page)
  select('a1')
  check('ready composer keeps the neutral placeholder', textarea().props.placeholder === '说说你的想法…')
  const composerContext = { tree: find(page, (node) => node.type?.name === 'ComposerModelPicker').props.contextActions(() => {}) }
  const composerContextButtons = findAll(composerContext, (node) => node.type === 'button')
  check('actual composer plus actions adopt shared menu options alongside their local class', composerContextButtons.length === 4 && composerContextButtons.every((node) => node.props.className.includes('acp-add-action') && node.props.className.includes('my-menu-item')))
  assert.deepEqual(composerContextButtons.map((node) => node.props.children[1].props.children), ['添加图片', '关联任务', '项目知识与来源', '项目活动'])
  check('ordinary transcript has no knowledge setup or material editor', !findAll(page, (node) => node.props?.className === 'acp-knowledge-context' || node.type?.name === 'ConversationKnowledgePanel').length)
  composerContextButtons[2].props.onClick(); page.render()
  const knowledgePanel = find(page, (node) => node.type?.name === 'ConversationKnowledgePanel')
  check('knowledge opens explicitly for the selected owner without changing the draft', knowledgePanel.props.root === rootA && knowledgePanel.props.session.sessionId === 'a1' && textarea().props.value === '')
  knowledgePanel.props.onClose(); page.render()
  check('foreign project list records are excluded', navigation().props.sessions.every((session) => session.sessionId !== 'foreign'))
  check('early permission before list remains actionable', rows().some((node) => node.props.pendingPerm.early))
  emit(outputs, { id: 'foreign-text', source: 'acp', kind: 'message', sessionId: 'foreign', projectRoot: rootB, ts: 11, text: 'FOREIGN' })
  emit(dones, { sessionId: 'foreign', status: 'closed' })
  page.render()
  check('foreign output and terminal status do not reach current session', rows().every((node) => node.props.item.text !== 'FOREIGN') && textarea().props.disabled !== true)

  draft('会话 A 草稿')
  select('a2'); check('each session starts with its own draft', textarea().props.value === '')
  draft('会话 B 草稿'); select('a1'); check('switching back restores the correct session draft', textarea().props.value === '会话 A 草稿')
  const event = { key: 'Enter', shiftKey: false, keyCode: 13, nativeEvent: { isComposing: false }, preventDefault() {} }
  textarea().props.onCompositionStart(); textarea().props.onKeyDown(event)
  textarea().props.onCompositionEnd(); textarea().props.onKeyDown({ ...event, keyCode: 229 })
  textarea().props.onKeyDown({ ...event, nativeEvent: { isComposing: true } })
  check('Chinese IME confirmation and legacy keyCode229 do not send', sends.length === 0)
  sendButton().props.onClick(); sendButton().props.onClick()
  check('duplicate submit handlers are locked before rerender', sends.length === 1)
  sends.shift().resolve({ ok: false, error: 'directory occupied' }); await settle(page)
  check('rejected prompt preserves original draft and reports error', textarea().props.value === '会话 A 草稿' && JSON.stringify(page.tree).includes('directory occupied'))
  sendButton().props.onClick(); page.render(); draft('运行时准备下一条')
  emit(states, { sessionId: 'a1', projectRoot: rootA, status: 'busy', connectionGeneration: 'conn-a1' }); page.render()
  check('busy composer keeps the same neutral placeholder', textarea().props.placeholder === '说说你的想法…')
  check('busy permits drafting and replaces send with the current-turn stop action', textarea().props.disabled !== true && !findAll(page, (node) => node.props?.title === '发送指令').length && Boolean(find(page, (node) => node.props?.title === '停止当前回合')))
  sends.shift().resolve({ ok: true }); await settle(page)
  check('late successful acknowledgement preserves a newer draft', textarea().props.value === '运行时准备下一条')
  emit(states, { sessionId: 'a1', projectRoot: rootA, status: 'error', connectionGeneration: 'conn-a1', session: { ...record('a1'), status: 'error', historyKind: 'live' } }); page.render()
  check('a failed status alone never invents a process-stop affordance', !findAll(page, node => node.props?.title === '停止当前会话及其拥有的进程').length)
  emit(states, { sessionId: 'a1', projectRoot: rootA, status: 'error', connectionGeneration: 'conn-a1', session: { ...record('a1'), status: 'error', canResume: true, recovery: { kind: 'model-unavailable' }, currentModelId: 'exact/Model:old', models: [{ modelId: 'exact/Model:old', name: 'Saved original' }] } }); page.render()
  check('error composer keeps the same neutral placeholder', textarea().props.placeholder === '说说你的想法…')
  const connectedPicker = new Harness(ComposerModelPicker, find(page, (node) => node.type?.name === 'ComposerModelPicker').props)
  connectedPicker.render()
  const connectedChoice = modelItems(openModels(connectedPicker))[0]
  connectedChoice.props.onClick(); connectedChoice.props.onClick(); page.render()
  check('bottom composer routes exact saved model and original generation through workspace recovery with a synchronous duplicate lock', recoveries.length === 1 && recoveries[0].sessionId === 'a1' && recoveries[0].input.modelId === 'exact/Model:old' && recoveries[0].input.expectedConnectionGeneration === 'conn-a1' && find(page, (node) => node.type?.name === 'ComposerModelPicker').props.operationPending === true && !Object.hasOwn(find(page, (node) => node.type?.name === 'ConnectionRecovery').props, 'onRecoverModel'))
  recoveries.shift().resolve({ ok: true, modelConfirmed: true, session: record('a1') }); await settle(page)
  lists.shift().resolve({ ok: true, sessions: [record('a1'), record('a2')] }); await settle(page); await settle(connectedPicker)
  check('successful explicit model recovery preserves the composer draft and never submits it', textarea().props.value === '运行时准备下一条' && sends.length === 0 && !find(page, (node) => node.type?.name === 'ComposerModelPicker').props.operationPending)
  connectedPicker.dispose()
  emit(states, { sessionId: 'a1', projectRoot: rootA, status: 'ready', connectionGeneration: 'conn-a1', pendingPermissions: [early.payload.permission] }); page.render()

  const earlyRow = rows()[0]
  await earlyRow.props.onRespond('early', 'not-a-choice')
  check('invalid GUI permission choice never consumes request', approvals.length === 0)
  void earlyRow.props.onRespond('early', 'allow-second'); void earlyRow.props.onRespond('early', 'allow-first')
  check('same-kind second permission ID and duplicate lock are exact', approvals.length === 1 && approvals[0].optionId === 'allow-second')
  approvals.shift().resolve({ ok: false, error: 'stale option' }); await settle(page)
  check('failed approval keeps choices actionable with failure feedback', rows()[0].props.pendingPerm.early && rows()[0].props.permissionErrors.early === 'stale option')
  void rows()[0].props.onRespond('early', 'deny-always'); approvals.shift().resolve({ ok: true }); await settle(page)
  emit(states, { sessionId: 'a1', projectRoot: rootA, status: 'ready', connectionGeneration: 'conn-a1', pendingPermissions: [] })
  lists.shift().resolve({ ok: true, sessions: [record('a1', rootA, [{ ...early, payload: { ...early.payload, pending: false } }]), record('a2')] }); await settle(page)
  check('authoritative expired permission cannot resurrect from early live event', rows().every((node) => !node.props.pendingPerm.early))

  const stream = find(page, (node) => node.type === 'div' && typeof node.props?.onScroll === 'function')
  const element = { scrollHeight: 1000, clientHeight: 200, scrollTop: 100 }
  stream.props.ref.current = element; stream.props.onScroll({ currentTarget: element }); page.render()
  emit(outputs, { id: 'chunk1', ts: 20, projectRoot: rootA, sessionId: 'a1', source: 'acp', kind: 'message', text: 'first' }); page.render()
  check('stream chunks do not pull a reader who scrolled up', element.scrollTop === 100)
  const latest = find(page, (node) => node.type?.name === 'Button' && JSON.stringify(node.props.children).includes('回到最新'))
  latest.props.onClick(); page.render(); element.scrollHeight = 1200
  emit(outputs, { id: 'chunk2', ts: 21, projectRoot: rootA, sessionId: 'a1', source: 'acp', kind: 'message', text: 'second' }); page.render()
  check('content growth follows even when message item count stays unchanged', element.scrollTop === 1200)
  element.scrollTop = 150; stream.props.onScroll({ currentTarget: element }); page.render(); select('a2'); select('a1')
  check('session scroll/follow position restores independently', element.scrollTop === 150)

  refresh(); const staleListA = lists.shift(); refresh(); const staleReturningA = lists.shift()
  const staleOutput = [...outputs][0]
  runtime.state.snapshot = { meta: { root: rootB }, tasks: [] }; page.render()
  staleOutput({ ...early, id: 'stale-output' }); staleListA.resolve({ ok: true, sessions: [record('stale-a')] })
  lists.shift().resolve({ ok: true, sessions: [record('b1', rootB)] }); await settle(page)
  select('b1'); check('project switch has no foreign draft/events/approval', textarea().props.value === '' && rows().length === 0)
  library()
  startNew(); const oldCreate = creates.shift()
  runtime.state.snapshot = { meta: { root: rootA }, tasks: [] }; page.render()
  oldCreate.resolve({ ok: true, sessionId: 'foreign-created' })
  lists.shift().resolve({ ok: true, sessions: [record('a1'), record('a2')] }); await settle(page)
  staleReturningA.resolve({ ok: true, sessions: [record('stale-return-a')] }); await settle(page)
  check('A to B to A rejects original list/create/output closures', navigation().props.sessions.every((session) => !['stale-return-a', 'foreign-created', 'stale-a'].includes(session.sessionId)) && lists.length === 0)

  library()
  startNew(); const currentCreate = creates.shift()
  const createdPermission = permission('created-permission', 'created-a')
  emit(outputs, createdPermission); emit(states, { sessionId: 'created-a', projectRoot: rootA, status: 'awaiting_permission', pendingPermissions: [createdPermission.payload.permission] })
  currentCreate.resolve({ ok: true, sessionId: 'created-a' }); await settle(page)
  lists.shift().resolve({ ok: true, sessions: [record('created-a'), record('a1')] }); await settle(page)
  check('creation reply preserves early output/state/live permission', rows().some((node) => node.props.pendingPerm['created-permission']))
  emit(outputs, { ...createdPermission, id: 'resolved', ts: 12, payload: { requestId: 'created-permission', pending: false } }); emit(states, { sessionId: 'created-a', projectRoot: rootA, status: 'busy', pendingPermissions: [] }); page.render()
  check('live resolution removes all actionable approval buttons', rows().every((node) => !node.props.pendingPerm['created-permission']))
  runtime.state.snapshot = null; page.render()
  check('no project gives honest empty state and no new IPC list request', JSON.stringify(page.tree).includes('请先打开项目') && lists.length === 0)
  page.dispose()

  // Admission and completion races must exercise Console's real callbacks, not
  // just the pure projection. The DOM companion covers actual child rendering.
  {
    const turnRoot = 'D:/current-turn-fixture'
    const owner = { ...record('turn-a', turnRoot), turnId: 'previous-turn' }
    const fact = (id, kind, turnId, extra = {}) => ({ id, ts: 100, source: 'acp', projectRoot: turnRoot, sessionId: owner.sessionId, connectionGeneration: owner.connectionGeneration, turnId, kind, ...extra })
    const completed = fact('previous-done', 'turn-done', owner.turnId, { payload: { result: { status: 'completed' } } })
    const request = { requestId: 'local-request', projectRoot: turnRoot, sessionId: owner.sessionId, connectionGeneration: owner.connectionGeneration, previousTurnId: owner.turnId, phase: 'submitting' }
    const project = (patch = {}) => projectCurrentTurnActivity({ root: turnRoot, session: owner, events: [completed], request, ...patch })
    assert.equal(project().phase, 'submitting', 'old terminal facts cannot close a fresh request')
    assert.equal(project({ interactive: false }), null, 'hidden retained sources render no status')
    for (const changed of [{ sessionId: 'other' }, { connectionGeneration: 'old-generation' }, { projectRoot: rootB }]) {
      assert.equal(project({ request: { ...request, ...changed } }), null, 'foreign request cannot mark an idle owner active')
    }
    const busyOwner = { ...owner, status: 'busy', turnId: 'current-turn' }
    const busyProject = (events, patch = {}) => projectCurrentTurnActivity({ root: turnRoot, session: busyOwner, events, ...patch })
    assert.equal(busyProject([]).phase, 'waiting', 'actual busy needs no first token')
    const tool = fact('tool-start', 'tool-call', busyOwner.turnId, { payload: { toolCallId: 'tool-1', status: 'in_progress' } })
    const toolDone = fact('tool-done', 'tool-call', busyOwner.turnId, { payload: { toolCallId: 'tool-1', status: 'completed' } })
    const toolOutput = fact('tool-output', 'tool-call', busyOwner.turnId, { payload: { toolCallId: 'tool-1', content: [{ type: 'text', text: 'recorded output' }] } })
    assert.equal(busyProject([tool, toolDone, toolOutput]).phase, 'processing', 'a partial tool output patch retains the recorded completed status')
    for (const status of ['completed', 'failed', 'cancelled']) {
      assert.equal(busyProject([{ ...toolDone, payload: { ...toolDone.payload, status } }]).phase, 'processing', `${status} tool leaves a continuous generic wait`)
    }
    for (const changed of [{ sessionId: 'other' }, { connectionGeneration: 'old-generation' }, { projectRoot: rootB }, { turnId: 'old-turn' }]) {
      const foreign = { ...fact('foreign-thought', 'thought', busyOwner.turnId, { text: 'foreign' }), ...changed }
      assert.equal(busyProject([foreign]).phase, 'waiting', 'foreign output cannot choose the current activity label')
      assert.ok(busyProject([{ ...foreign, kind: 'turn-done' }]), 'foreign completion cannot stop current busy')
    }
    assert.equal(busyProject([fact('exact-done', 'turn-done', busyOwner.turnId)]), null, 'exact terminal output stops even stale busy metadata')
    for (const status of ['ready', 'error', 'closed', 'disconnected']) assert.equal(busyProject([], { session: { ...busyOwner, status } }), null)
    assert.equal(busyProject([], { session: { ...busyOwner, historyKind: 'transcript' } }), null)
    const permissionActivity = busyProject([], { session: { ...busyOwner, status: 'awaiting_permission' } })
    assert.equal(permissionActivity.phase, 'permission'); assert.equal(permissionActivity.spinning, false)
    const permissionStatus = CurrentTurnStatus({ activity: permissionActivity })
    assert.equal(permissionStatus.props.role, 'status'); assert.equal(permissionStatus.props['aria-label'], '当前回合状态')
    assert.equal(permissionStatus.props['data-phase'], 'permission')
    check('current-turn projection uses exact ownership, recorded tool state and static authorization without fabricated history', true)

    runtime.state.snapshot = { meta: { root: turnRoot }, tasks: [] }
    const turnPage = new Harness(AcpConsolePage)
    const turnRows = () => findAll(turnPage, (node) => node.type?.name === 'EventRow')
    const turnNavigation = () => find(turnPage, (node) => node.type?.name === 'ConversationNavigation')
    const turnSelect = (id) => { turnNavigation().props.onSelect(id); turnPage.render() }
    const turnDraft = (text) => { find(turnPage, (node) => node.type === 'textarea').props.onChange({ target: { value: text } }); turnPage.render() }
    const turnSend = () => find(turnPage, (node) => node.props?.title === '发送指令')
    const turnActivity = () => findAll(turnPage, (node) => node.type?.name === 'CurrentTurnStatus')[0]?.props.activity ?? null
    const currentSession = () => turnNavigation().props.sessions.find((session) => session.sessionId === owner.sessionId)
    turnPage.render()
    lists.shift().resolve({ ok: true, sessions: [{ ...owner, events: [completed] }, record('turn-empty', turnRoot)] }); await settle(turnPage)
    turnSelect(owner.sessionId)
    for (const rejection of ['reply', 'throw']) {
      const text = `retain ${rejection}`
      turnDraft(text); turnSend().props.onClick(); turnPage.render()
      assert.equal(turnActivity()?.phase, 'submitting', 'local send appears before state or output')
      const pending = sends.shift()
      if (rejection === 'reply') pending.resolve({ ok: false, error: 'fixture refused' })
      else pending.reject(new Error('fixture IPC failure'))
      await settle(turnPage)
      assert.equal(turnActivity(), null, 'rejected and thrown prompt clears only its local marker')
      assert.equal(find(turnPage, (node) => node.type === 'textarea').props.value, text)
    }
    check('real Console local pending starts immediately and both rejection paths stop it while preserving the draft', true)
    turnDraft('accepted first'); turnSend().props.onClick(); turnPage.render()
    assert.ok(turnActivity())
    sends.shift().resolve({ ok: true, turnId: busyOwner.turnId }); await settle(turnPage)
    assert.equal(turnActivity()?.phase, 'waiting', 'accepted ACK bridges ready metadata before onState')
    turnDraft('next draft remains unsent')
    find(turnPage, (node) => node.type === 'textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, keyCode: 13, nativeEvent: { isComposing: false }, preventDefault() {} })
    turnPage.render(); assert.equal(sends.length, 0, 'ACK handoff locks keyboard submission too')
    const flattened = nodes(turnPage.tree)
    assert.ok(flattened.findIndex((node) => node.type?.name === 'CurrentTurnStatus') > flattened.findLastIndex((node) => node.type?.name === 'EventRow'), 'status follows recorded transcript rows')
    assert.deepEqual(turnRows().flatMap((node) => node.props.events.map((event) => event.id)), turnRows().flatMap(() => [completed.id]), 'submission does not fabricate saved events')
    check('accepted ACK retains the body-tail status and duplicate-submit lock without synthetic saved rows', true)
    const stateFor = (session, revision) => ({ sessionId: session.sessionId, projectRoot: session.projectRoot, connectionGeneration: session.connectionGeneration, status: session.status, stateRevision: revision, session: { ...session, stateRevision: revision } })
    emit(states, stateFor(busyOwner, 10)); turnPage.render()
    assert.equal(turnActivity()?.phase, 'waiting')
    for (const status of ['ready', 'error']) {
      emit(dones, { sessionId: owner.sessionId, projectRoot: turnRoot, connectionGeneration: owner.connectionGeneration, turnId: owner.turnId, status, session: { ...owner, status } }); turnPage.render()
      assert.equal(currentSession().turnId, busyOwner.turnId, 'late same-generation previous-turn done cannot replace new turn metadata')
      assert.equal(turnActivity()?.phase, 'waiting')
    }
    for (const changed of [{ sessionId: 'other' }, { connectionGeneration: 'stale-generation' }, { projectRoot: rootB }]) {
      emit(outputs, { ...fact('stale-terminal', 'turn-done', busyOwner.turnId), ...changed }); turnPage.render()
      assert.ok(turnActivity(), 'stale output cannot stop active owner')
    }
    emit(outputs, fact('current-done', 'turn-done', busyOwner.turnId)); turnPage.render()
    assert.equal(currentSession().status, 'busy', 'test really retains stale busy metadata')
    assert.equal(turnActivity(), null, 'exact turn-done stops the real Console marker before ready metadata')
    check('real Console correlates terminal events to the exact turn while preserving new-turn metadata', true)

    // An unseen previous turn ID can arrive after a fresh submission. Ready is
    // not evidence that this new request acquired that preceding turn ID.
    turnSelect('turn-empty'); turnDraft('empty local submission'); turnSend().props.onClick(); turnPage.render()
    assert.ok(turnActivity()); assert.ok(!JSON.stringify(turnPage.tree).includes('从一条清晰的指令开始'))
    const emptyOwner = { ...record('turn-empty', turnRoot), turnId: 'late-old-turn' }
    emit(outputs, { ...completed, id: 'late-old-completion', sessionId: emptyOwner.sessionId, connectionGeneration: emptyOwner.connectionGeneration, turnId: emptyOwner.turnId })
    emit(states, stateFor(emptyOwner, 2)); turnPage.render()
    assert.equal(turnActivity()?.phase, 'submitting', 'late previous ready/terminal with a formerly unseen ID cannot close a new submitting request')
    sends.shift().resolve({ ok: false, error: 'finish fixture' }); await settle(turnPage)
    assert.equal(turnActivity(), null)
    check('empty Console hides its invitation immediately and cannot adopt a late completed preceding turn during admission', true)

    turnDraft('fast completion'); turnSend().props.onClick(); turnPage.render()
    const fast = { ...emptyOwner, status: 'busy', turnId: 'fast-turn' }
    emit(states, stateFor(fast, 3)); emit(outputs, { ...completed, id: 'fast-terminal', sessionId: fast.sessionId, connectionGeneration: fast.connectionGeneration, turnId: fast.turnId }); turnPage.render()
    assert.equal(turnActivity(), null)
    sends.shift().resolve({ ok: true, turnId: fast.turnId }); await settle(turnPage)
    assert.equal(turnActivity(), null, 'a delayed ACK must not resurrect a turn already completed')
    assert.equal(sends.length, 0)
    check('fast terminal before ACK stays complete after the delayed acknowledgement', true)
    turnPage.dispose()
  }

  const { resolveWorkspaceEntry, conversationSummary } = await import(pathToFileURL(join(temporary, 'acp/conversation-selection.js')).href)
  const meaningful = record('real', rootA, [{ id: 'message', kind: 'message', source: 'acp', text: 'Actual conversation' }])
  const diagnostic = { ...meaningful, sessionId: 'mock', agentId: 'mock' }
  check('fresh and stale selections default to library, but an explicitly selected empty conversation remains open', resolveWorkspaceEntry(undefined, null, [meaningful]).view === 'agents' && resolveWorkspaceEntry('conversation', 'stale', [meaningful]).view === 'agents' && resolveWorkspaceEntry('conversation', 'empty', [record('empty')]).view === 'conversation' && resolveWorkspaceEntry('conversation', 'mock', [diagnostic]).view === 'agents')
  const archivedDiagnostic = { ...record('archive-diagnostic'), eventCount: 45, hasConversation: false }
  const archivedConversation = { ...record('archive-conversation'), eventCount: 45, hasConversation: true }
  check('summary-only event counts do not turn startup diagnostics into default conversations', resolveWorkspaceEntry(undefined, archivedDiagnostic.sessionId, [archivedDiagnostic]).view === 'agents' && resolveWorkspaceEntry('conversation', archivedConversation.sessionId, [archivedConversation]).view === 'conversation')
  check('explicit library remains independent while old history route migrates to the unified list', resolveWorkspaceEntry('agents', 'real', [meaningful]).view === 'agents' && resolveWorkspaceEntry('history', 'real', [meaningful]).view === 'conversation' && resolveWorkspaceEntry(undefined, 'real', [meaningful]).view === 'conversation')
  const summaryEvent = (id, kind, text, overrides = {}) => ({ id, kind, text, source: 'acp', projectRoot: rootA, sessionId: 'summary', turnId: 'turn-current', connectionGeneration: 'connection-current', ...overrides })
  const summarySession = (events) => ({ ...record('summary'), events })
  const summaryChunks = [
    summaryEvent('old-answer', 'message', '上一轮回答不得混入', { turnId: 'turn-old' }),
    summaryEvent('request', 'message', '用户要求仅给出完成说明', { payload: { role: 'user' } }),
    summaryEvent('part-1', 'message', '界面'),
    summaryEvent('diagnostic', 'diagnostic', '诊断内容不得混入'),
    summaryEvent('part-2', 'message', '与文档'),
    summaryEvent('thought', 'thought', '思考内容不得混入'),
    summaryEvent('tool', 'tool-call', '工具内容不得混入'),
    summaryEvent('part-3', 'message', '流程验收'),
    summaryEvent('part-4', 'message', '完成'),
    summaryEvent('done', 'turn-done', '回合结束')
  ]
  check('hover description assembles the latest fragmented response without thought/tool/diagnostic or earlier-turn text', conversationSummary(summarySession(summaryChunks)) === '界面与文档流程验收完成')
  check('latest user message remains its own description rather than merging the preceding assistant response', conversationSummary(summarySession([...summaryChunks, summaryEvent('next-user', 'message', '下一条用户指令', { turnId: 'turn-next', payload: { role: 'user' } })])) === '下一条用户指令')
  check('producer message IDs delimit separate assistant messages inside one turn', conversationSummary(summarySession([
    summaryEvent('message-before', 'message', '前一条消息', { payload: { messageId: 'before' } }),
    summaryEvent('message-now-1', 'message', '本条', { payload: { messageId: 'now' } }),
    summaryEvent('message-now-2', 'message', '消息', { payload: { messageId: 'now' } })
  ])) === '本条消息')
  check('a previous turn cannot join the latest response even without an intervening user message', conversationSummary(summarySession([
    summaryEvent('previous-turn-only', 'message', '上一轮', { turnId: 'turn-old' }),
    summaryEvent('current-turn-only', 'message', '当前回答')
  ])) === '当前回答')
  check('summary ignores foreign roots/sessions and cannot join a previous connection with reused turn IDs', conversationSummary(summarySession([
    summaryEvent('old-connection', 'message', '旧连接内容', { connectionGeneration: 'connection-old' }),
    summaryEvent('scoped-1', 'message', '本会话'),
    summaryEvent('foreign-root', 'message', '别的项目', { projectRoot: rootB }),
    summaryEvent('foreign-session', 'message', '别的会话', { sessionId: 'foreign' }),
    summaryEvent('scoped-2', 'message', '回答')
  ])) === '本会话回答')
  check('legacy turn boundaries stop response assembly even when message/turn IDs are absent', conversationSummary(summarySession([
    summaryEvent('legacy-old', 'message', '旧轮内容', { turnId: undefined, connectionGeneration: undefined }),
    summaryEvent('legacy-done', 'turn-done', '回合结束', { turnId: undefined, connectionGeneration: undefined }),
    summaryEvent('legacy-1', 'message', '历史', { turnId: undefined, connectionGeneration: undefined }),
    summaryEvent('legacy-2', 'message', '回答', { turnId: undefined, connectionGeneration: undefined })
  ])) === '历史回答')
  check('summary retains whitespace normalization, the 180-character bound and an honest empty fallback', conversationSummary(summarySession([
    summaryEvent('space-1', 'message', '  第一行\n'), summaryEvent('space-2', 'message', `\t第二行 ${'长'.repeat(200)}`)
  ])) === `第一行 第二行 ${'长'.repeat(200)}`.slice(0, 180) && conversationSummary(summarySession([summaryEvent('no-message', 'diagnostic', '未开始')])) === '暂无对话内容')

  const materialRoot = 'D:/material-fixture', taskDir = 'review-task'
  const taskFiles = ['prd.md', 'design.md', 'implement.md', 'research/reference/prd.md', 'research/reference/design.md', 'research/reference/implement.md'].map((name) => ({ name: name.split('/').at(-1), path: `${materialRoot}/.trellis/tasks/${taskDir}/${name}`, kind: 'file', mtime: 1, size: 10, ext: 'md' }))
  runtime.state.snapshot = { meta: { root: materialRoot }, tasks: [{ dirName: taskDir, record: { title: 'Review task', status: 'planning' }, phase: 'planning', artifacts: taskFiles }], archived: [] }
  const materialSession = { ...record('material', materialRoot), taskDir }
  const workspace = new Harness(AcpConsolePage); workspace.render()
  lists.shift().resolve({ ok: true, sessions: [materialSession] }); await settle(workspace)
  const workspaceNav = () => find(workspace, (node) => node.type?.name === 'ConversationNavigation')
  const inspector = () => find(workspace, (node) => node.type?.name === 'WorkspaceInspector')
  workspaceNav().props.onSelect('material'); workspace.render()
  const cards = () => findAll(workspace, (node) => node.type?.name === 'ConversationArtifactCard')
  const pane = () => find(workspace, (node) => node.type?.name === 'ConversationDocumentPane')
  const implementationButton = () => find(workspace, (node) => node.type?.name === 'Button' && JSON.stringify(node.props.children).includes('确认计划并进入实施'))
  for (const name of ['prd.md', 'design.md', 'implement.md']) {
    const nestedPath = `.trellis/tasks/${taskDir}/research/reference/${name}`
    const card = cards().find((node) => node.props.artifact.relativePath === nestedPath)
    assert.ok(card, `nested ${name} is a real inventory material`)
    card.props.onOpen(card.props.artifact); workspace.render()
    pane().props.onDisplayedReference({ projectRoot: materialRoot, taskDir, relativePath: nestedPath, displayedRevision: `nested-${name}`, targetSessionId: 'material', targetConnectionGeneration: 'conn-material' }); workspace.render()
  }
  inspector().props.onTab('task'); workspace.render()
  const beforeInvalidAuthorization = find(workspace, (node) => node.type === 'textarea').props.value
  implementationButton().props.onClick(); await settle(workspace)
  check('same-named nested research documents cannot satisfy principal planning review or prepare authorization', implementationButton().props.disabled === true && find(workspace, (node) => node.type === 'textarea').props.value === beforeInvalidAuthorization && sends.length === 0)
  cards().find((node) => node.props.artifact.label === 'prd.md').props.onOpen(cards()[0].props.artifact); workspace.render()
  const captured = { projectRoot: materialRoot, taskDir, relativePath: `.trellis/tasks/${taskDir}/prd.md`, displayedRevision: 'revision-a', targetSessionId: 'material', targetConnectionGeneration: 'conn-material', quote: 'Reviewed paragraph' }
  pane().props.onDisplayedReference(captured); pane().props.onReference(captured); await settle(workspace)
  check('verified PRD card opens one scoped reader and quote remains editable unsent draft', inspector().props.open && inspector().props.tab === 'document' && findAll(workspace, (node) => node.type?.name === 'ConversationDocumentPane').length === 1 && find(workspace, (node) => node.type === 'textarea').props.value.includes('Reviewed paragraph') && sends.length === 0)
  pane().props.onToggleExpanded(); workspace.render(); inspector().props.onTab('agent'); workspace.render()
  check('inspector tabs and expansion keep the same document target mounted', pane().props.relativePath === captured.relativePath && pane().props.expanded === true && inspector().props.tab === 'agent')
  find(workspace, (node) => node.props?.title === '发送指令').props.onClick()
  const referencedSend = sends.shift()
  check('document feedback sends captured exact source and expected session generation only on manual send', referencedSend.options.sourceReferences[0].displayedRevision === 'revision-a' && referencedSend.options.expectedConnectionGeneration === 'conn-material')
  referencedSend.resolve({ ok: false, code: 'E_CONFLICT', reason: 'SOURCE_CHANGED', sources: [{ relativePath: captured.relativePath, expectedRevision: 'revision-a', actualRevision: 'revision-b', available: true }] }); await settle(workspace)
  check('source drift retains editable draft and old source chip with no fabricated new revision', find(workspace, (node) => node.type === 'textarea').props.value.includes('Reviewed paragraph') && JSON.stringify(workspace.tree).includes('revision-a') && JSON.stringify(workspace.tree).includes('引用文件已变化'))
  runtime.confirm = true
  find(workspace, (node) => node.type?.name === 'Button' && node.props.children === '继续完善方案').props.onClick(); await settle(workspace)
  check('planning intent replaces authorization text separately and preserves original feedback for restore', find(workspace, (node) => node.type === 'textarea').props.value.includes('暂不开始实现') && JSON.stringify(workspace.tree).includes('原草稿已保留') && sends.length === 0)
  find(workspace, (node) => node.type === 'button' && node.props.children === '恢复原稿').props.onClick(); workspace.render()
  check('restoring a replaced draft also restores its original source reference', find(workspace, (node) => node.type === 'textarea').props.value.includes('Reviewed paragraph') && JSON.stringify(workspace.tree).includes('revision-a'))
  for (const name of ['design.md', 'implement.md']) {
    const principalPath = `.trellis/tasks/${taskDir}/${name}`
    const card = cards().find((node) => node.props.artifact.relativePath === principalPath)
    assert.ok(card, `principal ${name} is a real inventory material`)
    card.props.onOpen(card.props.artifact); workspace.render()
    pane().props.onDisplayedReference({ ...captured, relativePath: principalPath, displayedRevision: `principal-${name}`, quote: undefined }); workspace.render()
  }
  inspector().props.onTab('task'); workspace.render()
  check('reviewing all exact principal paths enables the separate implementation draft', implementationButton().props.disabled === false)
  const upperCasePath = `.trellis/tasks/${taskDir}/IMPLEMENT.md`.replace(/\//g, '\\')
  pane().props.onDisplayedReference({ ...captured, relativePath: upperCasePath, displayedRevision: 'principal-implement.md', quote: undefined }); workspace.render()
  check('Windows principal material retains exact hierarchy while accepting canonical case and separators', implementationButton().props.disabled === false)
  pane().props.onDisplayedReference({ ...captured, relativePath: `.trellis/tasks/${taskDir}/implement.md`, displayedRevision: 'principal-implement.md', quote: undefined }); workspace.render()
  implementationButton().props.onClick(); await settle(workspace)
  const authorization = find(workspace, (node) => node.type === 'textarea').props.value
  check('implementation draft cites only reviewed principal materials and never auto-sends', ['prd.md', 'design.md', 'implement.md'].every((name) => authorization.includes(`.trellis/tasks/${taskDir}/${name}`)) && !authorization.includes('/research/') && sends.length === 0)
  emit(states, { sessionId: 'material', projectRoot: materialRoot, status: 'disconnected', connectionGeneration: 'conn-restored', session: { ...materialSession, historyKind: 'live', status: 'disconnected', canResume: true, connectionGeneration: 'conn-restored', restorePending: true } }); workspace.render()
  find(workspace, (node) => node.props?.title === '发送指令').props.onClick(); await settle(workspace)
  check('restored connection never silently retargets or sends an existing source-bound draft', find(workspace, (node) => node.type === 'textarea').props.value === authorization && views.readSessionView(materialRoot, 'material').sourceReferences.every((source) => source.targetConnectionGeneration === 'conn-material') && sends.length === 0)
  emit(states, { sessionId:'material', projectRoot:materialRoot, status:'ready', connectionGeneration:'conn-restored', session:{...materialSession,historyKind:'live',status:'ready',canResume:true,connectionGeneration:'conn-restored'} }); workspace.render()
  find(workspace, (node) => node.type?.name === 'Button' && node.props.children === '继续完善方案').props.onClick(); await settle(workspace)
  find(workspace, (node) => node.props?.title === '发送指令').props.onClick()
  const restoredPlanningSend = sends.shift()
  check('a new planning intent excludes known-old reviewed targets after restore', restoredPlanningSend?.options.expectedConnectionGeneration === 'conn-restored' && restoredPlanningSend.options.sourceReferences.length === 0)
  restoredPlanningSend.resolve({ ok: false, error: 'controlled planning rejection' }); await settle(workspace)
  find(workspace, (node) => node.type === 'button' && node.props.children === '恢复原稿').props.onClick(); workspace.render()
  check('planning after restore still preserves the original authorization draft and original targets for recovery', find(workspace, (node) => node.type === 'textarea').props.value === authorization && views.readSessionView(materialRoot, 'material').sourceReferences.every((source) => source.targetConnectionGeneration === 'conn-material'))
  const oldConnectionSource = { ...captured, relativePath: `.trellis/tasks/${taskDir}/implement.md`, displayedRevision: 'principal-implement.md', quote: undefined }
  pane().props.onReference(oldConnectionSource); await settle(workspace)
  check('quoting a still-open historical reader explains the connection change and exposes recovery in the document pane', inspector().props.tab === 'document' && JSON.stringify(workspace.tree).includes('更新文档引用目标') && find(workspace, (node) => node.type === 'textarea').props.value === authorization)
  find(workspace, (node) => node.type?.name === 'Button' && node.props.children === '更新文档引用目标').props.onClick(); workspace.render()
  check('explicit document-target refresh leaves the old draft/reference untouched', pane().props.connectionGeneration === 'conn-restored' && find(workspace, (node) => node.type === 'textarea').props.value === authorization && views.readSessionView(materialRoot, 'material').sourceReferences.every((source) => source.targetConnectionGeneration === 'conn-material'))
  pane().props.onReference({ ...oldConnectionSource, targetConnectionGeneration: 'conn-restored' }); await settle(workspace)
  find(workspace, (node) => node.props?.title === '发送指令').props.onClick()
  const resumedReferenceSend = sends.shift()
  check('only deliberate re-quote and manual send use the restored target generation', resumedReferenceSend?.options.expectedConnectionGeneration === 'conn-restored' && resumedReferenceSend.options.sourceReferences.length === 1 && resumedReferenceSend.options.sourceReferences[0].targetConnectionGeneration === 'conn-restored')
  resumedReferenceSend.resolve({ ok: false, error: 'controlled rejection' }); await settle(workspace)
  workspace.dispose(); runtime.confirm = false

  const { ConversationNavigation } = await import(pathToFileURL(join(temporary, 'acp/ConversationNavigation.js')).href)
  let selectedCount = 0
  const sidebar = new Harness(ConversationNavigation, { sessions: [meaningful], activeId: null, view: 'agents', onView() {}, onSelect() { selectedCount++ }, onNew() {}, open: false, onClose() {} })
  sidebar.render()
  const recentRow = () => find(sidebar, (node) => node.props?.['data-acp-session'] === 'real')
  const anchor = { isConnected: true, getBoundingClientRect: () => ({ right: 1420, left: 1290, top: 860 }), closest: () => ({}) }
  recentRow().props.onMouseEnter({ currentTarget: anchor })
  check('hover preview is delayed and does not select conversation', !findAll(sidebar, (node) => node.props?.role === 'tooltip').length && selectedCount === 0)
  await new Promise((resolve) => setTimeout(resolve, 365)); sidebar.render()
  const tooltip = find(sidebar, (node) => node.props?.role === 'tooltip')
  check('visible hover description is row-bound, viewport-clamped and accessibility-linked', tooltip.props.style.left + 260 <= window.innerWidth && tooltip.props.style.top + 110 <= window.innerHeight && recentRow().props['aria-describedby'] === tooltip.props.id && selectedCount === 0)
  windowListeners.get('scroll')(); sidebar.render()
  check('scroll dismisses a pending or visible description', !findAll(sidebar, (node) => node.props?.role === 'tooltip').length)
  recentRow().props.onFocus({ currentTarget: anchor }); await new Promise((resolve) => setTimeout(resolve, 365)); sidebar.render(); runtime.escClose(); sidebar.render()
  check('keyboard focus shows equivalent preview without opening and Escape dismisses only it', selectedCount === 0 && !findAll(sidebar, (node) => node.props?.role === 'tooltip').length)
  recentRow().props.onMouseEnter({ currentTarget: anchor }); sidebar.props = { ...sidebar.props, activeId: 'real', view: 'conversation' }; sidebar.render(); await new Promise((resolve) => setTimeout(resolve, 365)); sidebar.render()
  check('navigation cancels delayed tooltip before it can reopen', !findAll(sidebar, (node) => node.props?.role === 'tooltip').length)
  sidebar.props = { ...sidebar.props, sessions: [{ ...meaningful, profileSnapshot: { name: '产品助手' } }, { ...record('old-real'), historyKind: 'legacy' }], query: '  CODEX  ' }; sidebar.render()
  check('metadata search trims query and preserves engine matches behind a named role and legacy conversation rows', findAll(sidebar, (node) => node.props?.['data-acp-session']).length === 2 && !findAll(sidebar, (node) => node.props?.children === '历史').length)
  const previewOnly = { ...record('preview-only'), conversationPreview: '持久化的完整会话摘要，来自历史索引。', conversationPreviewAt: 120 }
  const previewSidebar = new Harness(ConversationNavigation, { sessions: [previewOnly], activeId: null, view: 'conversation', onView() {}, onSelect() {}, onNew() {}, open: false, onClose() {} })
  previewSidebar.render(); const previewRow = find(previewSidebar, (node) => node.props?.['data-acp-session'] === 'preview-only'); previewRow.props.onMouseEnter({ currentTarget: anchor }); await new Promise((resolve) => setTimeout(resolve, 365)); previewSidebar.render()
  check('paged history rows use the persisted conversation preview when event pages are not loaded', JSON.stringify(find(previewSidebar, (node) => node.props?.role === 'tooltip')).includes('持久化的完整会话摘要'))
  previewSidebar.dispose()
  sidebar.dispose()

  const searchSidebar = new Harness(ConversationNavigation, { sessions: [meaningful, record('second')], activeId: null, view: 'conversation', onView() {}, onSelect: (id) => { selectedCount++; runtime.selectedSearch = id }, onNew() {}, open: false, onClose() {} })
  searchSidebar.render()
  find(searchSidebar, (node) => node.props?.['aria-label'] === '搜索全部会话').props.onClick(); searchSidebar.render()
  const searchNode = find(searchSidebar, (node) => node.type?.name === 'ConversationSearch')
  const searchView = new Harness(searchNode.type, searchNode.props); searchView.render()
  const searchInput = find(searchView, (node) => node.props?.role === 'combobox')
  searchInput.props.onChange({ target: { value: 'second' } }); await settle(searchView)
  check('centered search palette clears stale results immediately while the replacement query debounces', findAll(searchView, (node) => node.props?.role === 'option').length === 0)
  await new Promise((resolve) => setTimeout(resolve, 140)); await settle(searchView)
  check('search palette resolves only matching local fallback results', find(searchView, (node) => node.props?.role === 'combobox').props.value === 'second' && findAll(searchView, (node) => node.props?.role === 'option').length === 1)
  const searchOption = find(searchView, (node) => node.props?.role === 'option'); searchOption.props.onFocus(); searchOption.props.onClick(); searchSidebar.render()
  check('search Enter/click selection returns to the matching conversation and closes the palette', runtime.selectedSearch === 'second' && find(searchSidebar, (node) => node.type?.name === 'Modal').props.open === false)
  searchView.dispose(); searchSidebar.dispose()

  const typedEvents = [{ id: 'tool', ts: 1, source: 'acp', kind: 'tool-call', turnId: 't1', payload: { toolCallId: 'x', status: 'pending', rawInput: { path: 'sample' }, content: [{ type: 'content', content: { type: 'text', text: 'output' } }] }, text: 'Read sample' }, { id: 'patch', ts: 2, source: 'acp', kind: 'tool-call', turnId: 't1', payload: { toolCallId: 'x', status: 'completed', rawOutput: null } }]
  const compiled = compileItems(typedEvents)
  check('tool patch keeps original input/title/content and explicit null output', compiled.length === 1 && compiled[0].tool.title === 'Read sample' && compiled[0].tool.payload.rawInput.path === 'sample' && compiled[0].tool.payload.rawOutput === null)
  check('same tool ID in another turn cannot rewrite earlier tool', compileItems([...typedEvents, { ...typedEvents[0], id: 'new', turnId: 't2' }]).length === 2)
  const normalizedPatch = { ...typedEvents[1], text: 'tool call', payload: { ...typedEvents[1].payload, tag: 'tool_call_update', title: 'tool call' } }
  const retainedTitle = compileItems([typedEvents[0], normalizedPatch])[0].tool
  check('normalized partial tool placeholder preserves meaningful title and updated result', retainedTitle.title === 'Read sample' && retainedTitle.status === 'completed' && retainedTitle.payload.rawOutput === null)
  check('explicit changed tool title still replaces prior label', compileItems([typedEvents[0], { ...normalizedPatch, text: 'Read updated file', payload: { ...normalizedPatch.payload, title: 'Read updated file' } }])[0].tool.title === 'Read updated file')
  check('event merge deduplicates and authoritative snapshots replace pending flags', mergeEvents([{ ...early, payload: { pending: false } }], [early]).length === 1 && mergeEvents([{ ...early, payload: { pending: false } }], [early])[0].payload.pending === false)
  const sequenced = mergeEvents([{ ...early, id: 'later', ts: 2 }, { ...early, id: 'earlier', ts: 3 }], [{ ...early, id: 'later', ts: 2, historySeq: 2 }, { ...early, id: 'earlier', ts: 3, historySeq: 1 }])
  check('live overlap gains archive sequence while keeping live payload precedence and archive order', sequenced[0].id === 'earlier' && sequenced[1].historySeq === 2 && sequenced[0].payload.pending === true)

  const fileFact = (id, path, overrides = {}) => ({ id, ts: 10, source: 'trellis', kind: 'spec-updated', projectRoot: rootA, sessionId: 'a1', connectionGeneration: 'change-connection', turnId: 'change-turn', text: '规范变更', payload: { path }, ...overrides })
  const changeFacts = [fileFact('change-a1', `${rootA}/.trellis/spec/a.md`), fileFact('change-b1', `${rootA}/.trellis/spec/b.md`), fileFact('change-a2', `${rootA}/.trellis/spec/a.md`), fileFact('change-b2', `${rootA}/.trellis/spec/b.md`)]
  const originalChangeFacts = structuredClone(changeFacts)
  for (const event of changeFacts) { Object.freeze(event.payload); Object.freeze(event) }
  Object.freeze(changeFacts)
  const changeItems = compileItems(changeFacts)
  assert.equal(changeItems.length, 1)
  assert.equal(changeItems[0].type, 'change-group')
  assert.deepEqual(changeItems[0].files.map((file) => [file.path, file.events.length]), [[changeFacts[0].payload.path, 2], [changeFacts[1].payload.path, 2]])
  assert.deepEqual(changeItems[0].events, changeFacts)
  assert.ok(changeItems[0].events.every((event, index) => event === changeFacts[index]))
  assert.deepEqual(changeFacts, originalChangeFacts)
  check('four consecutive Trellis file facts project to one two-file group, retaining every original update without mutating stored events', true)
  const firstChange = compileItems(changeFacts.slice(0, 1))[0]
  const appendedChanges = compileItems([...changeFacts, fileFact('change-a3', changeFacts[0].payload.path)])[0]
  check('single changes share the folded group and appends preserve the first-event key and exact update counts', firstChange.type === 'change-group' && firstChange.key === changeFacts[0].id && appendedChanges.key === firstChange.key && appendedChanges.events.length === 5 && appendedChanges.files[0].events.length === 3)
  for (const [field, value] of [['projectRoot', rootB], ['sessionId', 'a2'], ['connectionGeneration', 'other-connection'], ['turnId', 'other-turn'], ['taskDir', 'other-task'], ['sessionId', undefined], ['connectionGeneration', undefined], ['turnId', undefined]]) {
    const boundaryItems = compileItems([changeFacts[0], { ...changeFacts[1], [field]: value }, changeFacts[2]])
    check(`file facts do not merge across a changed or absent ${field} scope (${value ?? 'absent'})`, boundaryItems.length === 3 && boundaryItems.every((item) => item.type === 'change-group' && item.events.length === 1))
  }
  const projectChanges = compileItems(changeFacts.map(({ sessionId, connectionGeneration, turnId, ...event }) => event))
  check('project-wide watcher facts group locally without inventing session, connection or turn ownership', projectChanges.length === 1 && projectChanges[0].events.every((event) => !event.sessionId && !event.turnId && !event.connectionGeneration))
  const changeBoundaries = [
    { source: 'acp', kind: 'message', text: 'intervening answer' },
    { source: 'acp', kind: 'permission', payload: { requestId: 'change-permission' } },
    { source: 'acp', kind: 'diagnostic', payload: { type: 'error' }, text: 'actual error' },
    { source: 'trellis', kind: 'task-status' },
    { source: 'trellis', kind: 'spec-injected' },
    { source: 'acp', kind: 'tool-call', payload: { status: 'failed' } },
    { source: 'acp', kind: 'session-status', payload: { tag: 'usage_update' } },
    { source: 'acp', kind: 'session-status', payload: { activityScope: 'connection' } }
  ]
  for (const [index, boundary] of changeBoundaries.entries()) {
    const event = { ...fileFact(`change-boundary-${index}`), ...boundary }
    const result = compileItems([changeFacts[0], event, changeFacts[2]])
    assert.equal(result.filter((item) => item.type === 'change-group').length, 2)
    if (index < 6) assert.ok(result.some((item) => item.key === event.id))
  }
  check('chat, permission, errors, other Trellis facts, tools and even hidden runtime facts end consecutive change groups', true)
  for (const payload of [undefined, {}, { path: ' ', file: '' }, { file: 42 }, { via: 'tpanel-notify' }]) {
    const unknown = fileFact('unkeyed-change', undefined, { text: '规范变更：do-not-guess.md', payload })
    const result = compileItems([changeFacts[0], unknown, changeFacts[2]])
    assert.equal(result.length, 3)
    assert.ok(result.some((item) => item.type === 'trellis' && item.ev === unknown))
  }
  check('unkeyed change notices remain separate and readable without deriving file IDs or unique counts from prose', true)
  for (const problem of [{ status: 'failed' }, { type: 'error' }, { severity: 'warning' }, { level: 'warn' }, { status: 'ERROR' }, { error: 'write failed' }, { success: false }, { ok: false }, { result: { status: 'failed' } }, { materialChange: { status: 'failed' } }]) {
    const failed = fileFact('failed-change', changeFacts[0].payload.path, { text: '实际文件变更警告', payload: { path: changeFacts[0].payload.path, ...problem } })
    const result = compileItems([changeFacts[0], failed, changeFacts[2]])
    assert.equal(result.length, 3)
    assert.ok(result.some((item) => item.type === 'trellis' && item.ev === failed))
  }
  check('explicit failed/error/warning file facts stay independently visible and split surrounding groups', true)
  const relativeMaterial = '.trellis/tasks/task-a/design.md'
  const documentChanges = [
    fileFact('created-document', `${rootA}/.trellis/tasks/task-a/prd.md`, { kind: 'doc-created', taskDir: 'task-a' }),
    fileFact('changed-material', undefined, { kind: 'material-change', payload: { materialChange: { projectRoot: rootA, taskDir: 'task-a', relativePath: relativeMaterial, kind: 'change', availability: 'readable' } } }),
    fileFact('named-file', undefined, { payload: { file: 'frontend/file-only.md', taskDir: 'task-a' } })
  ]
  const documentGroup = compileItems(documentChanges)[0]
  check('document, spec and material facts use structured path/file/relativePath and the same effective task scope', documentGroup.type === 'change-group' && documentGroup.events.length === 3 && documentGroup.files[1].path === relativeMaterial && documentGroup.files[2].path === 'frontend/file-only.md')
  const canonicalChanges = compileItems([documentChanges[1], { ...documentChanges[0], payload: { path: `${rootA}/${relativeMaterial}`.toUpperCase().replaceAll('/', '\\') } }])[0]
  check('real absolute and project-relative paths deduplicate with Windows case/separator rules while retaining both updates', canonicalChanges.files.length === 1 && canonicalChanges.files[0].events.length === 2 && canonicalChanges.files[0].path === relativeMaterial)
  const posixChanges = compileItems([fileFact('posix-a', '/project/A.md', { projectRoot: '/project' }), fileFact('posix-b', '/project/a.md', { projectRoot: '/project' })])[0]
  check('file deduplication preserves case-sensitive paths outside Windows roots', posixChanges.files.length === 2)
  for (const event of [fileFact('no-project', 'a.md', { projectRoot: undefined }), fileFact('', 'a.md'), fileFact('conflicting-task', 'a.md', { taskDir: 'task-a', payload: { path: 'a.md', taskDir: 'task-b' } }), fileFact('conflicting-project', 'a.md', { payload: { path: 'a.md', materialChange: { projectRoot: rootB } } })]) {
    assert.equal(compileItems([event])[0].type, 'trellis')
  }
  check('missing event/project identity or contradictory structured scopes remain independently visible', true)

  const metadata = (id, kind, payload, text) => ({ id, kind, payload, text, source: 'acp', ts: 1, turnId: 'metadata-turn' })
  const routine = [
    metadata('info1', 'session-status', { type: 'status', tag: 'session_info_update' }, 'session updated'),
    metadata('usage', 'session-status', { type: 'status', tag: 'usage_update', used: 20321, size: 828400 }, 'usage updated: 20321/828400'),
    metadata('config', 'config', { type: 'status', tag: 'current_mode_update' }, 'mode updated'),
    metadata('info2', 'session-status', { type: 'status', tag: 'session_info_update' }, 'session updated'),
    metadata('routine-diag', 'diagnostic', { type: 'done', data: 'retained' }, 'Runtime 更新')
  ]
  const reportedError = metadata('runtime-error', 'diagnostic', { type: 'error', code: 'E_RUNTIME' }, '运行连接失败')
  const observations = ['开始处理', '正在查询项目', '收到首次模型响应'].map((label, index) => metadata(`observation-${index}`, 'session-status', { observation: { label, atMs: index + 1 }, activityScope: 'turn' }, label))
  const grouped = compileItems([observations[0], routine[0], { ...typedEvents[0], id: 'visible-tool' }, observations[1], routine[1], { ...early, turnId: 'metadata-turn' }, reportedError, observations[2], ...routine.slice(2)])
  const activity = grouped.filter((item) => item.type === 'activity')
  check('real work observations retain chronology while successful transport milestones stay detail-only', activity.length === 1 && activity[0].events.length === 1 && activity[0].events[0] === observations[1] && !grouped.some((item) => routine.some((event) => item.key === event.id)) && routine[1].payload.used === 20321 && routine[4].payload.data === 'retained')
  check('activity grouping preserves visible tool, approval and runtime error rows', grouped.some((item) => item.type === 'tool') && grouped.some((item) => item.type === 'perm') && grouped.some((item) => item.type === 'detail' && item.ev.id === 'runtime-error'))
  const activityView = new Harness(EventRow, { item: activity[0], pendingPerm: {}, permissionPending: {}, permissionErrors: {} })
  activityView.render()
  check('sessionless activity fallback stays collapsed with readable facts and no raw JSON affordance', activityView.tree.type === 'details' && activityView.tree.props.open !== true && JSON.stringify(activityView.tree).includes('处理记录') && findAll(activityView,node=>node.type?.name==='RawData').length===0 && findAll(activityView,node=>node.type==='p').length===activity[0].events.length)
  const errorView = new Harness(EventRow, { item: grouped.find((item) => item.type === 'detail' && item.ev.id === 'runtime-error'), pendingPerm: {}, permissionPending: {}, permissionErrors: {} })
  errorView.render()
  check('runtime error stays visible with readable expandable source text and no raw JSON entry', find(errorView,node=>node.type?.name==='ConnectionNotice').type(find(errorView,node=>node.type?.name==='ConnectionNotice').props).props.role==='alert' && JSON.stringify(errorView.tree).includes('运行连接失败') && findAll(errorView, (node) => node.type?.name === 'RawData').length === 0)

  const nativeToolPayload = { toolExecution: 'adapter-native', clientServices: { fs: false, terminal: false } }
  const nativeToolsInfo = metadata('native-tools-info', 'diagnostic', nativeToolPayload, '工具由适配器原生能力提供；ACP 客户端文件和终端回调未启用，实际工具以该适配器报告和运行结果为准。')
  const nativeToolItems = compileItems([nativeToolsInfo])
  check('known native-tool capability facts stay in connection records rather than occupying the transcript', nativeToolItems.length===0 && nativeToolsInfo.payload===nativeToolPayload && nativeToolsInfo.text.includes('适配器原生能力'))
  const protectedDiagnostics = [
    metadata('native-tools-warning', 'diagnostic', { ...nativeToolPayload, severity: 'warning' }, '工具能力存在警告'),
    metadata('native-tools-level-warning', 'diagnostic', { ...nativeToolPayload, level: 'warning' }, '工具配置存在警告'),
    metadata('native-tools-type-warning', 'diagnostic', { ...nativeToolPayload, type: 'warning' }, '工具运行存在警告'),
    metadata('native-tools-auth', 'diagnostic', { ...nativeToolPayload, code: 'E_AUTH_REQUIRED' }, '需要登录'),
    metadata('native-tools-auth-generic-label', 'diagnostic', { ...nativeToolPayload, code: 'E_AUTH_REQUIRED' }, 'Runtime 更新'),
    metadata('native-tools-error', 'diagnostic', { ...nativeToolPayload, type: 'error', error: 'launch failed' }, '启动失败'),
    metadata('unknown-diagnostic', 'diagnostic', {}, '未识别的实际诊断')
  ]
  const protectedItems = compileItems([...protectedDiagnostics, { ...typedEvents[0], id: 'failed-native-tool', payload: { ...typedEvents[0].payload, status: 'failed' } }])
  check('capability-shaped warnings, authentication failures and unknown diagnostics remain visible outside activity', protectedDiagnostics.every((event) => protectedItems.some((item) => item.type === 'detail' && item.ev === event)) && protectedItems.some((item) => item.type === 'tool' && item.tool.status === 'failed'))
  for (const event of protectedDiagnostics) {
    const view = new Harness(EventRow, { item: protectedItems.find((item) => item.type === 'detail' && item.ev === event), pendingPerm: {}, permissionPending: {}, permissionErrors: {} }); view.render()
    const notice=find(view,node=>node.type?.name==='ConnectionNotice'); assert.equal(notice.type(notice.props).props.role, 'alert', `actual warning/error remains prominent: ${event.id}`)
    assert.equal(notice.props.message, event.text)
    assert.equal(findAll(view, (node) => node.type?.name === 'RawData').length, 0)
  }
  check('actual warning/error/auth diagnostics retain prominent alerts and original readable text', true)

  const completeTurn = [
    { id: 'turn-user', ts: 100, source: 'acp', kind: 'message', turnId: 'actual-turn', connectionGeneration: 'g1', payload: { role: 'user' }, text: 'question' },
    { id: 'commentary', ts: 200, source: 'acp', kind: 'message', turnId: 'actual-turn', connectionGeneration: 'g1', payload: { role: 'assistant', messageId: 'commentary-id' }, text: 'checking' },
    { id: 'final-1', ts: 300, source: 'acp', kind: 'message', turnId: 'actual-turn', connectionGeneration: 'g1', payload: { role: 'assistant', messageId: 'final-id' }, text: 'final ' },
    { id: 'final-2', ts: 400, source: 'acp', kind: 'message', turnId: 'actual-turn', connectionGeneration: 'g1', payload: { role: 'assistant', messageId: 'final-id' }, text: 'answer' },
    { id: 'done', ts: 500, source: 'acp', kind: 'turn-done', turnId: 'actual-turn', connectionGeneration: 'g1', payload: { result: { status: 'completed' } }, text: '回合已结束' }
  ]
  const completed = compileItems(completeTurn)
  const terminalIndex = completed.findIndex((item) => item.type === 'activity')
  check('terminal outcome occupies its own recorded boundary without relocating earlier records or merging distinct native messages', completed[terminalIndex].key === 'activity:done' && completed[terminalIndex].outcome === 'completed' && completed[terminalIndex - 1].text === 'final answer' && completed.filter((item) => item.type === 'agent').length === 2 && completed[terminalIndex].startedAt === 100)
  const suffix = compileItems([{ id: 'partial-observation', ts: 299, source: 'acp', kind: 'session-status', turnId: 'actual-turn', connectionGeneration: 'g1', payload: { observation: { label: '收到首次模型响应', atMs: 299 } } }, ...completeTurn.slice(2)])
  check('a loaded turn suffix never fabricates elapsed time from its first token', suffix.find((item) => item.type === 'activity').startedAt === undefined)
  const failedTurn = compileItems([...completeTurn.slice(0, -1), { ...completeTurn.at(-1), payload: { result: { status: 'failed' } } }])
  check('failed processing retains the actual failure at its recorded terminal boundary', failedTurn.find((item) => item.type === 'activity').key === 'activity:done' && failedTurn.find((item) => item.type === 'activity').outcome === 'failed')
  const recovered = compileItems(completeTurn.slice(1, 4).map((event) => ({ ...event, turnId: undefined, connectionGeneration: undefined })))
  check('recovered native commentary/final messages without panel turn mapping retain their original message boundaries', recovered.filter((item) => item.type === 'agent').map((item) => item.text).join('|') === 'checking|final answer')
  const reusedTool = compileItems([
    { id: 'tool-old', ts: 10, source: 'acp', kind: 'tool-call', turnId: 'reused-turn', connectionGeneration: 'old-generation', payload: { toolCallId: 'same-tool', status: 'pending' }, text: 'old command' },
    { id: 'tool-new', ts: 20, source: 'acp', kind: 'tool-call', turnId: 'reused-turn', connectionGeneration: 'new-generation', payload: { toolCallId: 'same-tool', status: 'completed' }, text: 'new command' }
  ]).filter((item) => item.type === 'tool')
  check('a reused tool ID from a new connection cannot patch the prior connection', reusedTool.length === 2 && reusedTool[0].tool.status === 'pending' && reusedTool[1].tool.status === 'completed')

  const chronEvent = (id, kind, text, payload = {}) => ({ id, ts: 100 + Number(id.split('-').at(-1)) * 10, source: 'acp', projectRoot: rootA, sessionId: 'chronology', turnId: 'chronology-turn', connectionGeneration: 'chronology-connection', kind, text, payload })
  const chronological = [
    chronEvent('user-0', 'message', 'question', { role: 'user' }),
    chronEvent('start-1', 'session-status', '', { observation: { label: '开始处理', atMs: 110 }, activityScope: 'turn' }),
    chronEvent('sent-2', 'session-status', '', { observation: { label: '指令已发送至引擎', atMs: 120 }, activityScope: 'turn' }),
    chronEvent('commentary-3', 'message', '**A**\n\n先搜索。\n', { role: 'assistant', messageId: 'one-native-message' }),
    chronEvent('search-4', 'tool-call', 'Search one', { toolCallId: 'search-1', kind: 'search', status: 'in_progress' }),
    chronEvent('search-status-5', 'session-status', '', { observation: { label: '正在检索资料', atMs: 150 }, activityScope: 'turn' }),
    chronEvent('commentary-6', 'message', 'B：找到后读取。\n', { role: 'assistant', messageId: 'one-native-message' }),
    chronEvent('read-7', 'tool-call', 'Read file', { toolCallId: 'read-1', kind: 'read', status: 'in_progress', locations: [{ path: 'D:/fixture-a/README.md' }] }),
    chronEvent('thought-8', 'thought', '对照原文。'),
    chronEvent('final-9', 'message', '## C\n\n最终 ', { role: 'assistant', messageId: 'one-native-message' }),
    chronEvent('final-10', 'message', '`answer`\n', { role: 'assistant', messageId: 'one-native-message' }),
    chronEvent('search-patch-11', 'tool-call', '', { toolCallId: 'search-1', status: 'completed' }),
    chronEvent('read-patch-12', 'tool-call', '', { toolCallId: 'read-1', status: 'completed' }),
    chronEvent('done-13', 'turn-done', '回合已结束', { result: { status: 'completed' } })
  ].map((event, index) => ({ ...event, historySeq: index + 1 }))
  const originalChronological = structuredClone(chronological)
  const anchors = (items) => items.map((item) => [item.type, item.key])
  const finishedChronology = compileItems(mergeEvents([], chronological))
  assert.deepEqual(anchors(finishedChronology), [['user', 'user-0'], ['agent', 'commentary-3'], ['tool', 'search-4'], ['activity', 'activity:search-status-5'], ['agent', 'commentary-6'], ['tool', 'read-7'], ['thought', 'thought-8'], ['agent', 'final-9'], ['activity', 'activity:done-13'], ['turn', 'done-13']])
  for (let end = 1; end <= chronological.length; end++) {
    const prefix = chronological.slice(0, end)
    const live = compileItems(mergeEvents([], prefix))
    const reopenedPrefix = compileItems(mergeEvents(structuredClone(prefix), []))
    assert.deepEqual(live, reopenedPrefix)
    assert.deepEqual(anchors(live), anchors(finishedChronology).slice(0, live.length))
  }
  assert.deepEqual(finishedChronology.filter((item) => item.type === 'agent').map((item) => item.text), ['**A**\n\n先搜索。\n', 'B：找到后读取。\n', '## C\n\n最终 `answer`\n'])
  const beforePatches = compileItems(chronological.slice(0, 11))
  const afterPatches = compileItems(chronological.slice(0, 13))
  assert.deepEqual(anchors(beforePatches), anchors(afterPatches))
  assert.deepEqual(afterPatches.filter((item) => item.type === 'tool').map((item) => [item.key, item.tool.status]), [['search-4', 'completed'], ['read-7', 'completed']])
  const skewedArchive = structuredClone(chronological).reverse().map((event, index) => ({ ...event, ts: index }))
  assert.deepEqual(anchors(compileItems(mergeEvents(skewedArchive, []))), anchors(finishedChronology))
  assert.deepEqual(mergeEvents(chronological.slice(0, 2), [{ ...chronological[2], historySeq: undefined, ts: 0 }]).map((event) => event.id), ['user-0', 'start-1', 'sent-2'])
  const delivery = chronological.map(({ historySeq, ...event }) => event)
  assert.deepEqual(mergeEvents(delivery, chronological.slice(-3)).map((event) => event.id), chronological.map((event) => event.id), 'refreshing only a saved suffix must not move older live messages below it')
  assert.deepEqual(mergeEvents(delivery.slice(5), delivery).map((event) => event.id), chronological.map((event) => event.id), 'overlap IDs also preserve older live prefixes without archive sequence metadata')
  assert.deepEqual(mergeEvents(delivery.slice(0, 5), delivery.slice(5)).map((event) => event.id), chronological.map((event) => event.id), 'unsequenced snapshot history remains before an independent newly delivered tail')
  const deliveredPrefix = delivery.slice(0, 10)
  const upgradedSuffix = mergeEvents(deliveredPrefix, chronological.slice(7, 10))
  const appended = mergeEvents(upgradedSuffix, [{ ...delivery[10], ts: 0 }])
  assert.deepEqual(appended.map((event) => event.id), chronological.slice(0, 11).map((event) => event.id), 'clock regression cannot move new delivery ahead of existing live prefix or saved overlap')
  assert.deepEqual(mergeEvents(appended, chronological.slice(0, 11)).map((event) => event.id), chronological.slice(0, 11).map((event) => event.id), 'later full sequence assignment preserves prior causal order')
  const fenced = compileItems([chronological[4], { ...chronological[9], text: '```js\nconst value' }, chronological[11], { ...chronological[10], text: ' = 1;\n```\n' }]).filter((item) => item.type === 'agent')
  assert.deepEqual(fenced.map((item) => item.text), ['```js\nconst value = 1;\n```\n'], 'an in-place tool patch must not split the same native Markdown message')
  assert.deepEqual(chronological, originalChronological)
  assert.deepEqual(compileItems([chronological[9], { ...routine[1], ...{ projectRoot: rootA, sessionId: 'chronology', turnId: 'chronology-turn', connectionGeneration: 'chronology-connection' } }, chronological[10]]).filter((item) => item.type === 'agent').map((item) => item.text), ['## C\n\n最终 `answer`\n'])
  assert.equal(afterPatches.find((item) => item.key === 'search-4').tool.title, 'Search one')
  const runtimeOrder = [chronological[1], chronological[2], { ...chronological[0], ts: 125 }]
  assert.deepEqual(compileItems(runtimeOrder.slice(0, 1)), [])
  assert.equal(compileItems(runtimeOrder)[0].type, 'user')
  assert.equal(compileItems([...runtimeOrder, chronological.at(-1)]).find(item => item.type === 'activity').startedAt, 110)
  const failedObservation = { ...chronological[5], id: 'failed-observation', payload: { observation: { label: '查询失败', status: 'failed' }, activityScope: 'turn' } }
  const failedObservationRow = new Harness(EventRow, { item: compileItems([failedObservation])[0] }); failedObservationRow.render()
  assert.equal(find(failedObservationRow, (node) => node.type?.name === 'ConnectionNotice').props.message, '查询失败')
  check('live prefixes and reopen preserve commentary/search/status/read/thought/final byte order and event anchors; completion patches never move rows and sequence beats wall clock', true)
  for (const [field, value] of [['projectRoot', rootB], ['sessionId', 'other-session'], ['turnId', 'other-turn'], ['connectionGeneration', 'other-generation']]) {
    const isolated = compileItems([chronological[4], { ...chronological[11], id: `foreign-${field}`, [field]: value }]).filter((item) => item.type === 'tool')
    assert.equal(isolated.length, 2)
    assert.equal(isolated[0].tool.status, 'in_progress')
  }
  const foreignSource = compileItems([chronological[4], { ...chronological[11], id: 'foreign-source', source: 'trellis' }])
  assert.equal(foreignSource[0].tool.status, 'in_progress')
  assert.equal(foreignSource[1].type, 'trellis')
  check('tool patches cannot cross root/session/turn/generation/source boundaries', true)

  const chronologicalSession = { ...record('chronology'), turnId: 'chronology-turn', connectionGeneration: 'chronology-connection', status: 'busy' }
  const activityProps = (item, session = chronologicalSession) => {
    const row = new Harness(EventRow, { item, session, events: chronological, pendingPerm: {}, permissionPending: {}, permissionErrors: {} }); row.render()
    return row.tree
  }
  const pastActivity = activityProps(finishedChronology.find(item => item.key === 'activity:search-status-5'))
  const pastActivityView = new Harness(pastActivity.type, pastActivity.props); pastActivityView.render()
  check('an earlier process segment never spins or acquires future tool/answer/completion content', !JSON.stringify(pastActivityView.tree).includes('is-running') && !JSON.stringify(pastActivityView.tree).includes('回复已完成') && !JSON.stringify(pastActivityView.tree).includes('最终') && findAll(pastActivityView, (node) => node.props?.className === 'acp-run-duration').length === 0)
  find(pastActivityView, (node) => node.type === 'button').props.onClick(); pastActivityView.render()
  check('native activity disclosure opens directly to only its real segment observations', find(pastActivityView, (node) => node.props?.className === 'acp-run-body').props.hidden === false && findAll(pastActivityView, (node) => node.type === 'li').length === 1)
  const tailActivity = activityProps(compileItems(chronological.slice(0, 6)).at(-1))
  const tailActivityView = new Harness(tailActivity.type, tailActivity.props); tailActivityView.render()
  check('only the current tail shows current processing and real elapsed time', tailActivityView.tree.props.className.includes('is-running') && JSON.stringify(tailActivityView.tree).includes('正在检索资料') && findAll(tailActivityView, (node) => node.props?.className === 'acp-run-duration').length === 1)
  const terminalActivity = activityProps(finishedChronology.at(-2), { ...chronologicalSession, status: 'ready' })
  const terminalActivityView = new Harness(terminalActivity.type, terminalActivity.props); terminalActivityView.render()
  check('terminal duration uses actual user and done facts and preserves transport facts only in its disclosure', JSON.stringify(terminalActivityView.tree).includes('回复已完成') && find(terminalActivityView, (node) => node.props?.className === 'acp-run-duration').props.children === '130 毫秒' && find(terminalActivityView, (node) => node.type === 'button').props.disabled === false && findAll(terminalActivityView, (node) => node.type === 'li').length === 2)
  for (const view of [pastActivityView, tailActivityView, terminalActivityView]) view.dispose()
  const prepFact = (id, ts, label, extra = {}) => ({ ...chronological[1], id, ts, turnId: undefined, payload: { activityScope: 'connection', observation: { label, atMs: ts } }, ...extra })
  const prepStart = prepFact('prep-start', 500, '开始准备会话')
  const prepReady = prepFact('prep-ready', 900, 'ACP 会话已就绪')
  const preparationView = new Harness(StartupGroup, { session: { ...chronologicalSession, status: 'ready', startedAt: 10, events: [prepStart, chronological[1], prepFact('foreign-prep', 1, '开始准备会话', { connectionGeneration: 'foreign' }), prepReady] } }); preparationView.render()
  assert.deepEqual(preparationView.tree.props.item.events.map((event) => event.id), ['prep-start', 'prep-ready'])
  assert.equal(preparationView.tree.props.item.startedAt, 500)
  assert.equal(preparationView.tree.props.item.endedAt, 900)
  assert.equal(preparationView.tree.props.item.outcome, 'completed')
  const prepDisplay = new Harness(preparationView.tree.type, preparationView.tree.props); prepDisplay.render()
  assert.ok(JSON.stringify(prepDisplay.tree).includes('连接已就绪'))
  assert.equal(findAll(prepDisplay, (node) => node.type === 'li').length, 2)
  preparationView.props = { session: { ...chronologicalSession, status: 'starting', events: [prepStart] } }; preparationView.render()
  assert.equal(preparationView.tree.props.item.outcome, undefined)
  const connectingView = new Harness(preparationView.tree.type, preparationView.tree.props); connectingView.render()
  assert.ok(connectingView.tree.props.className.includes('is-running'))
  assert.ok(JSON.stringify(connectingView.tree).includes('正在连接执行引擎'))
  assert.equal(compileItems([prepStart, prepReady]).length, 0)
  for (const view of [preparationView, prepDisplay, connectingView]) view.dispose()
  check('StartupGroup retains honest connection-only preparation, actual connection timing and ready facts without duplicating transcript output', true)

  const recoveryProps = { session: { ...record('recover'), status: 'error', canResume: true, models: [{ modelId: 'exact/provider-model', name: 'Saved model' }], recovery: { kind: 'model-unavailable' } }, message: 'Cannot replay saved model. Available models: invented-model', onRetry() {}, onCleanup() {}, onRetryHistory() {}, onNew() {}, onEnvironment() {} }
  const recovery = new Harness(ConnectionRecovery, recoveryProps); recovery.render()
  const recoveryHeader = { tree: find(recovery, (node) => node.props?.className === 'acp-recovery-line') }
  assert.equal(findAll(recoveryHeader, (node) => node.type?.name === 'Dropdown' || ['更换模型', '重试连接'].includes(node.props?.children)).length, 0)
  const errorRegion = () => find(recovery, (node) => node.props?.['aria-label'] === '连接错误详情' && node.props.role === 'region')
  const statusTrigger = () => find(recovery, (node) => node.props?.className === 'acp-recovery-status-trigger')
  assert.equal(errorRegion().props.hidden, true)
  assert.equal(findAll(recovery, (node) => node.type?.name === 'DropdownItem').length, 0)
  assert.equal(statusTrigger().props['aria-expanded'], false)
  assert.equal(statusTrigger().props['aria-controls'], errorRegion().props.id)
  statusTrigger().props.onClick(); recovery.render()
  check('status title toggles the error-only disclosure with matching accessible ownership and no model picker', statusTrigger().props['aria-expanded'] === true && !errorRegion().props.hidden && findAll(recovery, (node) => node.type?.name === 'DropdownItem' || node.props?.className === 'acp-recovery-detail-trigger').length === 0 && findAll({ tree: errorRegion() }, (node) => node.type === 'pre').some((node) => node.props.children === recoveryProps.message))
  check('compact status line contains no model choices or raw engine error text', !JSON.stringify(recoveryHeader.tree).includes('invented-model') && !JSON.stringify(recoveryHeader.tree).includes('exact/provider-model'))
  statusTrigger().props.onClick(); recovery.render()
  check('status title also collapses the error region', !statusTrigger().props['aria-expanded'] && errorRegion().props.hidden)
  check('normal recovery shows no redundant history/new-conversation action', !findAll(recovery, (node) => ['仅阅读历史', '新建对话'].includes(node.props?.children)).length)
  find(recovery, (node) => node.props?.['aria-label'] === '收起连接提示').props.onClick(); recovery.render()
  check('dismissing the connection hint hides the entire strip without a redundant offline note', recovery.tree === null)
  recovery.props = { ...recoveryProps, message: 'second native load failed', session: { ...recoveryProps.session, recovery: { kind: 'connection-failed', modelConfirmed: true, confirmedModelId: 'exact/provider-model' } } }; recovery.render()
  check('acknowledged model and failed second connection remain separate visible outcomes', JSON.stringify(recovery.tree).includes('模型已确认，连接仍失败') && JSON.stringify(recovery.tree).includes('exact/provider-model'))
  recovery.props = { ...recoveryProps, session: { ...recoveryProps.session, recovery: undefined, cleanupRequired: true } }; recovery.render()
  check('real incomplete cleanup exposes retry and cannot be dismissed', findAll(recovery, (node) => node.props?.children === '重试结束会话').length === 1 && !findAll(recovery, (node) => node.props?.['aria-label'] === '收起连接提示').length)
  recovery.props = { ...recoveryProps, message: 'AUTH_REQUIRED', session: { ...recoveryProps.session, recovery: undefined } }; recovery.render()
  check('authentication routes to engine repair without presenting an ineffective generic retry', !findAll(recovery, (node) => node.props?.children === '重试连接').length && findAll(recovery, (node) => node.props?.children === '检查执行引擎').length === 1)
  recovery.props = { ...recoveryProps, message: 'Cannot replay saved session model old/vendor; Available models: invented-model', session: { ...recoveryProps.session, recovery: undefined } }; recovery.render()
  assert.equal(findAll(recovery, (node) => node.type?.name === 'Dropdown' || ['更换模型', '重试连接'].includes(node.props?.children)).length, 0)
  assert.equal(findAll(recovery, (node) => node.type?.name === 'DropdownItem').length, 0)
  statusTrigger().props.onClick(); recovery.render()
  check('legacy model errors keep details as errors only and direct recovery to the composer', !errorRegion().props.hidden && findAll(recovery, (node) => node.type?.name === 'DropdownItem').length === 0 && JSON.stringify(errorRegion()).includes('输入框右下角') && JSON.stringify(errorRegion()).includes(recovery.props.message))
  recovery.props = { ...recoveryProps, session: { ...recoveryProps.session, historyPersistence: { state: 'degraded', pendingCount: 3, committedThroughEventId: null, committedThroughSeq: null } } }; recovery.render()
  check('storage degradation keeps unsaved count and retry visible without a dismiss affordance', JSON.stringify(recovery.tree).includes('3 条事件') && findAll(recovery, (node) => node.props?.children === '重试保存').length === 1 && !findAll(recovery, (node) => node.props?.['aria-label'] === '收起连接提示').length)
  recovery.props = { ...recoveryProps, session: { ...recoveryProps.session, historyPersistence: { state: 'degraded', pendingCount: 3, unarchivedCount: 3, committedThroughEventId: null, committedThroughSeq: null } } }; recovery.render()
  check('overflow-only history loss is explicit, may be incomplete and never offers a fake save retry', JSON.stringify(recovery.tree).includes('历史可能不完整') && !findAll(recovery, (node) => node.props?.children === '重试保存').length && !findAll(recovery, (node) => node.props?.['aria-label'] === '收起连接提示').length)
  recovery.props = { ...recoveryProps, session: { ...recoveryProps.session, historyPersistence: { state: 'degraded', pendingCount: 0, error: 'archive unavailable', committedThroughEventId: null, committedThroughSeq: null } } }; recovery.render()
  check('an unavailable archive still offers a real retry/recheck without claiming queued events', findAll(recovery, (node) => node.props?.children === '重试保存').length === 1 && !JSON.stringify(recovery.tree).includes('条事件待写入'))
  recovery.dispose()

  const savedModels = [{ modelId: 'Vendor/Model-A:old', name: 'Saved A' }, { modelId: 'vendor/Model-B@2026:latest', name: 'Saved B' }]
  const modelOption = { id: 'engine-model', category: 'model', name: 'Native model', currentValue: savedModels[0].modelId, options: savedModels.map((model) => ({ value: model.modelId, name: model.name })) }
  const recoverySession = { ...record('picker-recovery'), status: 'error', canResume: true, recovery: { kind: 'model-unavailable' }, currentModelId: 'legacy/stale', models: [{ modelId: 'legacy/fallback', name: 'Legacy fallback' }], currentModeId: 'default', modes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }], capabilities: { controls: [] }, configOptions: [
    modelOption,
    { id: 'effort', name: 'Reasoning effort', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
    { id: 'extra', name: 'Extra parameter', currentValue: 'one', options: [{ value: 'one', name: 'One' }, { value: 'two', name: 'Two' }] }
  ] }
  const nativeMenus = (picker) => ({ tree: findAll(picker, (node) => node.type?.name === 'Dropdown').map((node) => node.props.children(() => {})) })
  const planToggle = (picker) => find(nativeMenus(picker), (node) => node.props?.className?.includes('acp-plan-toggle'))
  const attempts = []
  let pickerCurrent = true, recoveryCloses = 0, pickerUpdate
  const pickerProps = { session: recoverySession, message: recoveryProps.message, isCurrent: () => pickerCurrent, onUpdated(value) { pickerUpdate = value }, onRecoverModel(id) { const request = deferred(); attempts.push({ ...request, id }); return request.promise } }
  const picker = new Harness(ComposerModelPicker, pickerProps); picker.render()
  const recoveryPopup = openModels(picker, () => recoveryCloses++)
  check('recovery model popup shares the 256px group anchor, preferred top placement and 8px gap', modelDropdown(picker).props.width === 256 && modelDropdown(picker).props.positionAnchorRef === find(picker, (node) => node.props?.className === 'acp-composer-controls-right').props.ref && modelDropdown(picker).props.placement === 'top' && modelDropdown(picker).props.gap === 8)
  check('recovery model choices reserve scrollbar space only on the outer menu', recoveryPopup.tree.props.className === 'acp-model-menu my-scrollbar acp-model-choices' && find(recoveryPopup, (node) => node.props?.className === 'acp-model-list').props.children.length === savedModels.length && findAll(recoveryPopup, (node) => node.props?.className?.includes('my-scrollbar')).length === 1)
  assert.deepEqual(modelItems(recoveryPopup).map((node) => node.key), savedModels.map((model) => model.modelId))
  check('eligible offline composer opens exact native category models directly without configure capability or reasoning navigation', modelItems(recoveryPopup).every((node) => !node.props.disabled) && modelItems(recoveryPopup)[0].props.selected && !JSON.stringify(recoveryPopup.tree).includes('invented-model') && !findAll(recoveryPopup, (node) => ['进入模型选择', '返回推理强度'].includes(node.props?.['aria-label'])).length)
  const recoveryHelp = find(recoveryPopup, (node) => node.type?.name === 'Tooltip')
  const recoveryModelHeader = find(recoveryPopup, (node) => node.props?.className?.includes('acp-model-view-header'))
  check('recovery header adopts the shared noninteractive menu heading with no default explanation prose', recoveryModelHeader.type === 'div' && recoveryModelHeader.props.className.includes('my-menu-header') && !recoveryModelHeader.props.onClick && find({ tree: recoveryModelHeader }, (node) => node.type === 'span').props.children === '选择模型' && !findAll(recoveryPopup, (node) => node.type === 'p').length && !JSON.stringify(recoveryPopup.tree).includes('选择模型并重新连接'))
  check('saved candidate and engine verification help is available through the shared hover and focus tooltip', ['历史候选', '选择后重连', '执行引擎', '验证可用性'].every((text) => recoveryHelp.props.label.includes(text)) && recoveryHelp.props.children.type === 'button' && recoveryHelp.props.children.props.type === 'button' && recoveryHelp.props.children.props.className === 'my-icon-control my-composer-control' && recoveryHelp.props.children.props['aria-label'] === '模型恢复说明' && recoveryHelp.props.children.props.children.type.name === 'Info')
  check('offline mode and other native parameters stay disabled and model options exist only in the model popup', findAll(nativeMenus(picker), (node) => node.type?.name === 'Select').every((node) => node.props.disabled && node.props.ariaLabel !== 'Native model') && planToggle(picker).props.disabled && findAll(picker, (node) => node.type?.name === 'DropdownItem').length === 0)
  const previousConfigureCount = configures.length
  modelItems(recoveryPopup)[0].props.onClick(); modelItems(recoveryPopup)[0].props.onClick(); picker.render()
  check('selecting the saved current model explicitly recovers its exact ID once before rerender rather than configuring', attempts.length === 1 && attempts[0].id === savedModels[0].modelId && configures.length === previousConfigureCount && !pickerUpdate && !recoveryCloses)
  check('local recovery pending disables every model, mode, plan and native parameter choice', findAll(nativeMenus(picker), (node) => ['DropdownItem', 'Select'].includes(node.type?.name)).every((node) => node.props.disabled) && planToggle(picker).props.disabled)
  const recoveryPending = findAll(nativeMenus(picker), (node) => node.props?.role === 'status')
  check('real recovery pending uses only a compact spinner and connecting label', recoveryPending.length === 2 && recoveryPending.every((node) => node.props.children.length === 2 && node.props.children[0].type.name === 'Loader2' && node.props.children[1].props.children === '连接中…'))
  pickerCurrent = false; attempts.shift().resolve(); await settle(picker)
  check('stale recovery completion cannot close or update the current picker', !recoveryCloses && !pickerUpdate)
  modelItems(modelPopup(picker))[1].props.onClick()
  check('stale source rejects explicit recovery callbacks', attempts.length === 0)
  pickerCurrent = true
  modelItems(modelPopup(picker, () => recoveryCloses++))[1].props.onClick()
  assert.equal(attempts[0].id, savedModels[1].modelId)
  attempts.shift().resolve(); await settle(picker)
  check('a current explicit recovery acknowledgement closes the popup without optimistic model updates', recoveryCloses === 1 && !pickerUpdate)
  picker.props = { ...pickerProps, operationPending: true }; picker.render()
  modelItems(openModels(picker))[0].props.onClick()
  check('workspace operation pending blocks recovery even if a disabled choice callback is invoked', attempts.length === 0 && modelItems(modelPopup(picker)).every((node) => node.props.disabled))
  picker.dispose()

  for (const [name, overrides, message] of [
    ['missing generation', { connectionGeneration: undefined }],
    ['cannot resume', { canResume: false }],
    ['cleanup ownership', { cleanupRequired: true }],
    ['authentication', {}, 'AUTH_REQUIRED'],
    ['provider restriction', {}, '403 Forbidden'],
    ['no candidates', { configOptions: [{ ...modelOption, options: [] }] }],
    ['blank candidates', { configOptions: [{ ...modelOption, options: [{ value: ' ', name: 'Invalid saved choice' }] }] }],
    ['generic model error', { recovery: undefined, error: 'model request failed; Available models: invented-model' }, 'model request failed; Available models: invented-model'],
    ['confirmed model with connection failure', { recovery: { kind: 'connection-failed', modelConfirmed: true } }],
    ...['starting', 'busy', 'awaiting_permission', 'cancelling'].map((status) => [status, { status }])
  ]) {
    const gatedSession = { ...recoverySession, ...overrides }
    const gated = new Harness(ComposerModelPicker, { ...pickerProps, session: gatedSession, message }); gated.render()
    const initialMenu = modelPopup(gated)
    for (const radio of findAll(initialMenu, (node) => node.props?.role === 'radio')) { assert.equal(radio.props.disabled, true); radio.props.onClick() }
    const menu = openModels(gated)
    for (const choice of modelItems(menu)) { assert.equal(choice.props.disabled, true); choice.props.onClick() }
    check(`${name} prevents offline recovery and native configuration`, !getModelRecovery(gatedSession, message).canRecoverModel && attempts.length === 0 && configures.length === previousConfigureCount)
    gated.dispose()
  }
  for (const [name, sessionError, message] of [
    ['session error fallback', 'Cannot replay saved session model old/vendor; Available models: invented-model', undefined],
    ['current feedback error', 'network timeout', 'ACP_MODEL_UNSUPPORTED'],
    ['bounded saved model error', 'saved model old/vendor is not advertised', undefined]
  ]) {
    const legacy = new Harness(ComposerModelPicker, { ...pickerProps, session: { ...recoverySession, recovery: undefined, configOptions: [], currentModelId: savedModels[0].modelId, models: savedModels, error: sessionError }, message }); legacy.render()
    const menu = openModels(legacy)
    assert.deepEqual(modelItems(menu).map((node) => node.key), savedModels.map((model) => model.modelId))
    modelItems(menu)[0].props.onClick()
    assert.equal(attempts.length, 1); assert.equal(attempts[0].id, savedModels[0].modelId)
    attempts.shift().resolve(); await settle(legacy)
    check(`legacy ${name} recovers saved exact IDs without parsing error-listed models or requiring advertised controls`, !JSON.stringify(menu.tree).includes('invented-model') && configures.length === previousConfigureCount)
    legacy.dispose()
  }
  const exactCandidates = getModelRecovery({ ...recoverySession, configOptions: [], models: [...savedModels, savedModels[0], { modelId: ' ', name: 'Invalid' }, { modelId: ' Vendor/Model-A:old ', name: 'Exact whitespace ID' }] })
  assert.deepEqual(exactCandidates.models.map((model) => model.modelId), [...savedModels.map((model) => model.modelId), ' Vendor/Model-A:old '])
  check('shared recovery deduplicates exact IDs, rejects blank choices, preserves opaque ID bytes and reports authentication', exactCandidates.canRecoverModel && getModelRecovery(recoverySession, '401 AUTH_REQUIRED').environmentRequired)

  const readySession = { ...recoverySession, status: 'ready', recovery: undefined, capabilities: { controls: ['session/set_model', 'session/set_mode', 'session/set_config_option'] } }
  const readyPicker = new Harness(ComposerModelPicker, { ...pickerProps, session: readySession, usage: 'usage control', sendAction: 'send control' }); readyPicker.render()
  assert.deepEqual(findAll(nativeMenus(readyPicker), (node) => node.type?.name === 'DropdownHeader').map((node) => node.props.children), ['添加', '会话模式'])
  const advancedParameters = find(nativeMenus(readyPicker), (node) => node.type === 'details' && node.props?.className === 'acp-add-advanced')
  const advancedSummary = find({ tree: advancedParameters }, (node) => node.type === 'summary')
  check('plain captions keep DropdownHeader while other native parameters retain a closed native disclosure with shared option styling', !advancedParameters.props.open && advancedSummary.props.className.includes('my-menu-item') && advancedSummary.props.children.includes('其他会话参数') && find({ tree: advancedParameters }, (node) => node.type?.name === 'Select' && node.props.ariaLabel === 'Extra parameter').props.disabled === false)
  const readyDropdown = modelDropdown(readyPicker).props
  const rightControls = find(readyPicker, (node) => node.props?.className === 'acp-composer-controls-right')
  check('reasoning popup aligns to the group containing usage, model and Send at the same fixed width', readyDropdown.width === 256 && readyDropdown.placement === 'top' && readyDropdown.gap === 8 && readyDropdown.positionAnchorRef === rightControls.props.ref && rightControls.props.children[0] === 'usage control' && rightControls.props.children.at(-1) === 'send control' && modelPopup(readyPicker).tree.props.className === 'acp-model-menu' && findAll(modelPopup(readyPicker), (node) => node.props?.className?.includes('my-scrollbar')).length === 0)
  check('ready model popup retains its normal reasoning settings view', findAll(modelPopup(readyPicker), (node) => node.props?.role === 'radio').length === 2 && modelItems(modelPopup(readyPicker)).length === 0)
  openModels(readyPicker)
  check('switching to models keeps width and anchor while enabling only the outer scrollbar owner', modelDropdown(readyPicker).props.width === readyDropdown.width && modelDropdown(readyPicker).props.positionAnchorRef === readyDropdown.positionAnchorRef && modelPopup(readyPicker).tree.props.className === 'acp-model-menu my-scrollbar acp-model-choices' && findAll(modelPopup(readyPicker), (node) => node.props?.className?.includes('my-scrollbar')).length === 1 && Boolean(find(modelPopup(readyPicker), (node) => node.props?.className === 'acp-model-list')))
  const readyHeader = find(modelPopup(readyPicker), (node) => node.props?.className?.includes('acp-model-view-header'))
  check('ready model list shares the noninteractive menu heading without recovery help', readyHeader.type === 'div' && readyHeader.props.className.includes('my-menu-header') && !readyHeader.props.onClick && find({ tree: readyHeader }, (node) => node.type === 'span').props.children === '选择模型' && !findAll(modelPopup(readyPicker), (node) => node.type?.name === 'Tooltip').length)
  const backToReasoning = find({ tree: readyHeader }, (node) => node.props?.['aria-label'] === '返回推理强度')
  assert.equal(backToReasoning.type, 'button'); assert.equal(backToReasoning.props.type, 'button')
  backToReasoning.props.onClick(); readyPicker.render()
  check('shared model heading preserves the real native return-to-reasoning button callback', findAll(modelPopup(readyPicker), (node) => node.props?.role === 'radio').length === 2 && modelItems(modelPopup(readyPicker)).length === 0)
  const readyChoices = modelItems(openModels(readyPicker))
  readyChoices[0].props.onClick(); readyPicker.render()
  assert.equal(configures.length, previousConfigureCount)
  const nativeChoice = modelItems(openModels(readyPicker))[1]
  nativeChoice.props.onClick(); nativeChoice.props.onClick(); readyPicker.render()
  const nativeConfigure = configures.shift()
  assert.deepEqual(nativeConfigure.input, { kind: 'config', id: 'engine-model', value: savedModels[1].modelId })
  check('ready category models still configure under the shared local lock and wait for acknowledgement', !pickerUpdate && attempts.length === 0 && findAll(nativeMenus(readyPicker), (node) => ['DropdownItem', 'Select'].includes(node.type?.name)).every((node) => node.props.disabled))
  const configurePending = findAll(nativeMenus(readyPicker), (node) => node.props?.role === 'status')
  check('real native configure pending uses only a compact spinner and updating label', configurePending.length === 2 && configurePending.every((node) => node.props.children.length === 2 && node.props.children[0].type.name === 'Loader2' && node.props.children[1].props.children === '更新中…') && !JSON.stringify(nativeMenus(readyPicker).tree).includes('连接就绪且当前回复结束后可以修改'))
  nativeConfigure.resolve({ ok: true, session: { ...readySession, configOptions: [{ ...modelOption, currentValue: savedModels[1].modelId }] } }); await settle(readyPicker)
  check('ready configuration updates only the acknowledged session and returns to reasoning settings', pickerUpdate.configOptions[0].currentValue === savedModels[1].modelId && findAll(modelPopup(readyPicker), (node) => node.props?.role === 'radio').length === 2 && attempts.length === 0)
  const nativeModes = [{ id: 'mode/read:opaque', name: 'read-only' }, { id: 'mode/workspace:opaque', name: 'workspace access' }, { id: 'mode/full:opaque', name: 'full access' }]
  readyPicker.props = { ...readyPicker.props, session: { ...readySession, modes: nativeModes } }; readyPicker.render()
  const modePopup = () => ({ tree: find(readyPicker, (node) => node.type?.name === 'Dropdown' && node.props.trigger({ open: false, toggle() {} }).props['aria-label'] === '选择会话模式').props.children(() => {}) })
  assert.deepEqual(modelItems(modePopup()).map((node) => node.props.children), ['只读', '工作区访问', '完全访问'])
  for (const mode of nativeModes) {
    modelItems(modePopup()).find((node) => node.key === mode.id).props.onClick()
    const request = configures.shift()
    assert.deepEqual(request.input, { kind: 'mode', id: mode.id })
    request.resolve({ ok: true, session: readySession }); await settle(readyPicker)
  }
  check('actual native mode popup translates known labels while every callback retains its exact opaque mode ID', true)
  readyPicker.props = { ...pickerProps, session: readySession, operationPending: true }; readyPicker.render()
  const readyPendingMenu = modelPopup(readyPicker)
  for (const radio of findAll(readyPendingMenu, (node) => node.props?.role === 'radio')) { assert.equal(radio.props.disabled, true); radio.props.onClick() }
  for (const choice of modelItems(openModels(readyPicker))) { assert.equal(choice.props.disabled, true); choice.props.onClick() }
  check('pending workspace operations disable ready model, reasoning, mode, plan and extra parameters', configures.length === previousConfigureCount && attempts.length === 0 && findAll(nativeMenus(readyPicker), (node) => ['DropdownItem', 'Select'].includes(node.type?.name)).every((node) => node.props.disabled) && planToggle(readyPicker).props.disabled)
  readyPicker.dispose()
  const regularPlanId = 'mode/read:opaque', activePlanId = 'mode/plan:opaque'
  const nativePlanSession = { ...readySession, currentModeId: regularPlanId, modes: [{ id: regularPlanId, name: 'Read only' }, { id: activePlanId, name: 'Plan' }] }
  const modeConfigOption = { id: 'mode-config/opaque', category: 'mode', name: 'Native mode', currentValue: regularPlanId, options: nativePlanSession.modes.map((mode) => ({ value: mode.id, name: mode.name })) }
  const collaborationOption = { id: 'collaboration/opaque', name: 'Collaboration mode', currentValue: 'collab/default:opaque', options: [{ value: 'collab/default:opaque', name: 'Default' }, { value: 'collab/plan:opaque', name: 'Plan' }] }
  for (const [name, session, inputs] of [
    ['native mode', nativePlanSession, [{ kind: 'mode', id: activePlanId }, { kind: 'mode', id: regularPlanId }]],
    ['category mode', { ...nativePlanSession, configOptions: [...readySession.configOptions, modeConfigOption] }, [{ kind: 'config', id: modeConfigOption.id, value: activePlanId }, { kind: 'config', id: modeConfigOption.id, value: regularPlanId }]],
    ['collaboration', { ...readySession, configOptions: [...readySession.configOptions, collaborationOption] }, [{ kind: 'config', id: collaborationOption.id, value: 'collab/plan:opaque' }, { kind: 'config', id: collaborationOption.id, value: 'collab/default:opaque' }]]
  ]) {
    const planPicker = new Harness(ComposerModelPicker, { ...pickerProps, session, onUpdated(updated) { planPicker.props = { ...planPicker.props, session: updated } } }); planPicker.render()
    for (const [index, input] of inputs.entries()) {
      const toggle = planToggle(planPicker)
      const labels = findAll({ tree: toggle }, (node) => node.type === 'span')
      assert.equal(toggle.type, 'button'); assert.equal(toggle.props.type, 'button')
      assert.ok(toggle.props.className.includes('my-menu-item'))
      assert.equal(toggle.props['aria-pressed'], index === 1); assert.equal(toggle.props.disabled, false)
      assert.equal(labels.length, 1); assert.equal(labels[0].props.children, '计划模式'); assert.equal(labels[0].props.className, 'flex-1')
      assert.equal(findAll({ tree: toggle }, (node) => node.type === 'small').length, 0)
      assert.equal(toggle.props.children.at(-1)?.type?.name, index === 1 ? 'Check' : undefined)
      toggle.props.onClick(); toggle.props.onClick(); planPicker.render()
      assert.equal(configures.length, previousConfigureCount + 1); assert.equal(planToggle(planPicker).props.disabled, true)
      const request = configures.shift()
      assert.equal(request.sessionId, session.sessionId); assert.deepEqual(request.input, input)
      const updated = input.kind === 'mode' ? { ...session, currentModeId: input.id } : { ...session, configOptions: session.configOptions.map((option) => option.id === input.id ? { ...option, currentValue: input.value } : option) }
      request.resolve({ ok: true, session: updated }); await settle(planPicker)
      assert.equal(planToggle(planPicker).props['aria-pressed'], index === 0)
    }
    planPicker.props = { ...planPicker.props, operationPending: true }; planPicker.render()
    assert.equal(planToggle(planPicker).props.disabled, true); planToggle(planPicker).props.onClick()
    check(`${name} plan option keeps one label, a trailing selected check, exact enable/disable callbacks and pending locks`, configures.length === previousConfigureCount && attempts.length === 0)
    planPicker.dispose()
  }
  const legacyReady = new Harness(ComposerModelPicker, { ...pickerProps, session: { ...readySession, configOptions: [], models: savedModels, currentModelId: savedModels[0].modelId, capabilities: { controls: ['session/set_model'] } } }); legacyReady.render()
  check('unsupported reasoning has no subsection, navigation or explanatory prose', modelItems(modelPopup(legacyReady)).length === savedModels.length && !findAll(modelPopup(legacyReady), (node) => node.props?.role === 'radiogroup' || node.props?.className === 'acp-reasoning-menu acp-model-settings' || ['进入模型选择', '返回推理强度'].includes(node.props?.['aria-label'])).length && !JSON.stringify(nativeMenus(legacyReady).tree).includes('此引擎未提供推理强度选项'))
  modelItems(openModels(legacyReady))[1].props.onClick()
  const legacyConfigure = configures.shift()
  assert.deepEqual(legacyConfigure.input, { kind: 'model', id: savedModels[1].modelId })
  pickerCurrent = false; pickerUpdate = undefined
  legacyConfigure.resolve({ ok: true, session: readySession }); await settle(legacyReady)
  modelItems(openModels(legacyReady))[1].props.onClick()
  check('legacy ready model configuration remains exact and rejects stale callbacks and acknowledgements', !pickerUpdate && configures.length === previousConfigureCount && attempts.length === 0)
  legacyReady.dispose(); pickerCurrent = true
  for (const status of ['ready', 'starting']) {
    const emptyPicker = new Harness(ComposerModelPicker, { ...pickerProps, operationPending: status === 'starting', session: { ...record('empty-models'), status, models: [], configOptions: [{ id: 'effort', name: 'Reasoning effort', currentValue: '', options: [] }] } }); emptyPicker.render()
    const emptyStatus = find(modelPopup(emptyPicker), (node) => node.props?.role === 'status')
    check(`${status} empty model list keeps one truthful compact icon and text without unsupported reasoning prose`, modelItems(modelPopup(emptyPicker)).length === 0 && findAll(modelPopup(emptyPicker), (node) => node.props?.role === 'status').length === 1 && emptyStatus.props.children.length === 2 && emptyStatus.props.children[0].type.name === (status === 'starting' ? 'Loader2' : 'Info') && emptyStatus.props.children[1].props.children === (status === 'starting' ? '加载中…' : '暂无可用模型') && !findAll(modelPopup(emptyPicker), (node) => node.props?.role === 'radiogroup' || node.type === 'p').length)
    emptyPicker.dispose()
  }

  let openedChangeSpecs = 0
  const openedChangeFiles = []
  const changeRow = new Harness(EventRow, { item: changeItems[0], onOpenSpec: () => openedChangeSpecs++, onOpenArtifact: (file) => openedChangeFiles.push(file) })
  changeRow.render()
  const changeHeader = find(changeRow, (node) => node.type?.name === 'ActivityResult')
  const changeSummary = { tree: find(changeRow, (node) => node.type === 'summary') }
  check('aggregated EventRow defaults closed with a neutral two-file/four-update header and only disclosure in summary', changeRow.tree.type === 'details' && !Object.hasOwn(changeRow.tree.props, 'open') && changeRow.tree.props['data-acp-item'] === changeFacts[0].id && changeHeader.props.title === '2 个文件变更' && changeHeader.props.description.props.children.join('') === '4 次更新' && !changeHeader.props.tone && changeHeader.props.action.type === 'span' && !changeHeader.props.action.props.onClick && findAll(changeSummary, (node) => node.type?.name === 'Button' || node.type === 'button').length === 0)
  const changeFileRows = findAll(changeRow, (node) => node.props?.className === 'acp-change-row')
  assert.deepEqual(changeFileRows.map((row) => find({ tree: row }, (node) => node.props?.className === 'acp-change-file').props.children), [changeFacts[0].payload.path, changeFacts[1].payload.path])
  assert.deepEqual(changeFileRows.map((row) => find({ tree: row }, (node) => node.props?.className === 'acp-change-file').props.title), [changeFacts[0].payload.path, changeFacts[1].payload.path])
  const changeActions = findAll(changeRow, (node) => node.type?.name === 'Button')
  for (const action of changeActions) { assert.equal(action.props.children, '查看规范'); action.props.onClick() }
  check('expanded per-file rows expose actual paths, repeat counts and only real spec actions', changeActions.length === 2 && openedChangeSpecs === 2 && findAll(changeRow, (node) => node.props?.className === 'acp-change-count').length === 2 && !/撤销|Undo|View Diff|查看变更|\+\d+/.test(JSON.stringify(changeRow.tree)))
  changeRow.props = { ...changeRow.props, item: appendedChanges }; changeRow.render()
  check('appending a change retains the disclosure identity without controlling or resetting native open state', changeRow.tree.props['data-acp-item'] === firstChange.key && !Object.hasOwn(changeRow.tree.props, 'open') && findAll(changeRow, (node) => node.props?.className === 'acp-change-row').length === 2)
  const displayFacts = changeFacts.map((event, index) => ({ ...event, payload: { ...event.payload, file: index < 2 ? 'old-label.md' : index === 2 ? 'frontend/css-design.md' : 'frontend/components.md' } }))
  const originalDisplayFacts = structuredClone(displayFacts)
  changeRow.props = { ...changeRow.props, item: compileItems(displayFacts)[0] }; changeRow.render()
  const displayFiles = findAll(changeRow, (node) => node.props?.className === 'acp-change-file')
  assert.deepEqual(displayFiles.map((node) => [node.props.children, node.props.title]), [['frontend/css-design.md', changeFacts[0].payload.path], ['frontend/components.md', changeFacts[1].payload.path]])
  assert.deepEqual(displayFacts, originalDisplayFacts)
  check('file rows display the latest recorded file label while retaining full path titles, identity, source facts and spec callbacks', changeRow.props.item.files.length === 2 && changeRow.props.item.events.length === 4 && findAll(changeRow, (node) => node.type?.name === 'Button').every((node) => node.props.onClick === changeRow.props.onOpenSpec))
  changeRow.props = { ...changeRow.props, item: documentGroup }; changeRow.render()
  const documentActions = findAll(changeRow, (node) => node.type?.name === 'Button')
  for (const action of documentActions) action.props.onClick()
  assert.deepEqual(openedChangeFiles.map((file) => file.path), [documentChanges[0].payload.path, `${rootA}/${relativeMaterial}`])
  check('expanded document and readable material actions target real recorded paths, including project-relative material paths', documentActions.filter((node) => node.props.children === '阅读文件').length === 2 && openedChangeSpecs === 3)
  const absoluteMaterial = { ...documentChanges[1], payload: { ...documentChanges[1].payload, path: `${rootA}/${relativeMaterial}`, file: ' ' } }
  changeRow.props = { ...changeRow.props, item: compileItems([absoluteMaterial])[0] }; changeRow.render()
  const materialFile = find(changeRow, (node) => node.props?.className === 'acp-change-file')
  find(changeRow, (node) => node.type?.name === 'Button').props.onClick()
  check('material relativePath supplies the compact label when file is blank, preserving full identity title and the safe read target', materialFile.props.children === relativeMaterial && materialFile.props.title === absoluteMaterial.payload.path && openedChangeFiles.at(-1).path === `${rootA}/${relativeMaterial}`)
  for (const material of [{ kind: 'unlink', availability: 'missing' }, { kind: 'change', availability: 'unreadable' }]) {
    changeRow.props = { ...changeRow.props, item: compileItems([{ ...documentChanges[1], payload: { materialChange: { ...documentChanges[1].payload.materialChange, ...material } } }])[0] }; changeRow.render()
    assert.equal(findAll(changeRow, (node) => node.type?.name === 'Button').length, 0)
    assert.equal(find(changeRow, (node) => node.props?.className === 'acp-change-file').props.children, relativeMaterial)
  }
  check('removed or unreadable materials retain their file row without an unsupported read action', true)
  changeRow.dispose()

  const editRow = new Harness(EventRow, { item: { type: 'tool', key: 'edit-card', tool: { title: 'Apply file change', status: 'completed', payload: { kind: 'edit', content: [{ type: 'diff', path: 'D:/project/src/workspace.tsx', oldText: 'before', newText: 'after' }] } } } })
  editRow.render()
  const editCard = () => find(editRow, (node) => node.type?.name === 'ActivityResult')
  check('recorded edit card uses its actual diff path and expands real change content without inventing undo or line counts', editCard().props.title === '已编辑 workspace.tsx' && editCard().props.description === 'D:/project/src/workspace.tsx' && JSON.stringify(editCard().props.action).includes('查看变更') && !JSON.stringify(editRow.tree).includes('撤销'))
  editRow.props = { ...editRow.props, item: { ...editRow.props.item, tool: { ...editRow.props.item.tool, status: 'in_progress' } } }; editRow.render()
  check('unowned pending file edit stays incomplete instead of claiming live execution', editCard().props.title === '编辑未完成 workspace.tsx')
  const liveEdit = { id: 'edit-card', source: 'acp', projectRoot: 'D:/project', sessionId: 'edit-session', turnId: 'edit-turn', connectionGeneration: 'edit-generation', kind: 'tool-call', ts: 1 }
  editRow.props = { ...editRow.props, events: [liveEdit], session: { projectRoot: liveEdit.projectRoot, sessionId: liveEdit.sessionId, turnId: liveEdit.turnId, connectionGeneration: liveEdit.connectionGeneration, status: 'busy' } }; editRow.render()
  check('only the exact current nonterminal file edit claims active execution', editCard().props.title === '正在编辑 workspace.tsx')
  editRow.props = { ...editRow.props, events: [liveEdit, { ...liveEdit, id: 'edit-done', kind: 'turn-done' }] }; editRow.render()
  check('terminal output stops a pending tool before busy metadata catches up', editCard().props.title === '编辑未完成 workspace.tsx')
  editRow.props = { ...editRow.props, item: { ...editRow.props.item, tool: { ...editRow.props.item.tool, status: 'failed' } } }; editRow.render()
  check('failed file edit keeps its real failure outcome', editCard().props.title === '编辑失败 workspace.tsx' && editCard().props.tone === 'danger')
  editRow.dispose()
  let openedSpec = 0
  const hookRow = new Harness(EventRow, { item: { type: 'trellis', key: 'hook-card', ev: { id: 'hook-card', kind: 'spec-injected', source: 'trellis', ts: 1, text: '已注入本次上下文', taskDir: 'task-a' } }, onOpenSpec: () => { openedSpec++ } })
  hookRow.render()
  const hookCard = find(hookRow, (node) => node.type?.name === 'ActivityResult')
  hookCard.props.action.props.onClick()
  check('hook result card preserves recorded wording and real supported action without implying approval', hookCard.props.title === '已注入本次上下文' && hookCard.props.description === '任务：task-a' && openedSpec === 1 && !JSON.stringify(hookRow.tree).includes('已通过'))
  hookRow.dispose()

  let updated
  const session = { ...record('config'), currentModelId: 'model-a', models: [{ modelId: 'model-a', name: 'A' }, { modelId: 'model-b', name: 'B' }], capabilities: { controls: ['session/set_model'] } }
  const details = new Harness(SessionDetails, { session, isCurrent: () => true, onUpdated: (value) => { updated = value } })
  details.render()
  find(details, (node) => node.props?.ariaLabel === '会话模型').props.onChange('model-b'); details.render()
  check('model selector retains acknowledged value while request pending', find(details, (node) => node.props?.ariaLabel === '会话模型').props.value === 'model-a')
  configures.shift().resolve({ ok: false, error: 'unsupported' }); await settle(details)
  check('failed configuration retains effective value and error', !updated && JSON.stringify(details.tree).includes('unsupported'))
  find(details, (node) => node.props?.ariaLabel === '会话模型').props.onChange('model-b')
  configures.shift().resolve({ ok: true, session: { ...session, currentModelId: 'model-b' } }); await settle(details)
  check('configuration updates only from acknowledged session result', updated.currentModelId === 'model-b')
  details.dispose()

  const categorizedDetails = new Harness(SessionDetails, { session: { ...session, currentModeId: 'read-only', modes: [{ id: 'read-only', name: 'Read only' }], capabilities: { controls: ['session/set_model', 'session/set_mode', 'session/set_config_option'] }, configOptions: [
    { id: 'choice-a', category: 'mode', name: 'Categorized mode', currentValue: 'read-only', options: [{ value: 'read-only', name: 'Read only' }] },
    { id: 'choice-b', category: 'model', name: 'Categorized model', currentValue: 'model-a', options: [{ value: 'model-a', name: 'Model A' }] },
    { id: 'mode', name: 'Uncategorized setting', currentValue: 'x', options: [{ value: 'x', name: 'Other' }] }
  ] }, isCurrent: () => true, onUpdated() {} })
  categorizedDetails.render()
  check('categorized model/mode each render once while unrelated config with arbitrary mode ID remains', findAll(categorizedDetails, node => node.type?.name === 'Select').length === 3 && find(categorizedDetails, node => node.props?.ariaLabel === '会话模式').props.value === 'read-only' && Boolean(find(categorizedDetails, node => node.props?.ariaLabel === 'Uncategorized setting')))
  categorizedDetails.dispose()

  const permView = new Harness(EventRow, { item: { type: 'perm', key: early.id, ev: early }, pendingPerm: { early: early.payload.permission }, permissionPending: {}, permissionErrors: {}, onRespond() {} })
  permView.render()
  check('reject_always is displayed as rejection with original label and ID', findAll(permView, (node) => node.props?.title === '原始选项：deny-always · reject_always').some((node) => node.props.children[1].props.children === 'Deny always' && node.props.className.includes('danger')))
  console.log('\nACP UI hook and projection regression: passed (native layout/IME/scroll acceptance remains separate)')
} finally { rmSync(temporary, { recursive: true, force: true }) }
