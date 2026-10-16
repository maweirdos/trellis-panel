/** Actual ACP component hook/event handlers, without mounting DOM or claiming native acceptance. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-acp-ui-'))
const storage = new Map()
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
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
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
const lists = [], creates = [], sends = [], approvals = [], configures = [], cancels = []
const outputs = new Set(), states = new Set(), dones = new Set()
const rootA = 'D:/fixture-a', rootB = 'D:/fixture-b'
const runtime = {
  current: null, toasts: [],
  state: { snapshot: { meta: { root: rootA }, tasks: [] }, pushToast: (toast) => runtime.toasts.push(toast), setPage() {}, showTask() {}, openArtifact() {} },
  api: {
    acpAgents: async () => ({ ok: true, agents: [{ id: 'codex', name: 'Codex', enabled: true, available: true, health: 'not_checked', command: 'fixed' }] }),
    acpProfiles: async () => ({ ok: true, profiles: [{ id: 'developer', name: 'Developer', runtimeId: 'codex', description: 'Local role', instructions: 'Test', maxTurnMinutes: 30 }] }),
    acpSessions: () => { const request = deferred(); lists.push({ ...request, root: runtime.state.snapshot?.meta.root }); return request.promise },
    acpSessionNew: (input) => { const request = deferred(); creates.push({ ...request, input }); return request.promise },
    acpSessionPrompt: (id, text) => { const request = deferred(); sends.push({ ...request, id, text }); return request.promise },
    acpPermissionRespond: (requestId, optionId) => { const request = deferred(); approvals.push({ ...request, requestId, optionId }); return request.promise },
    acpSessionConfigure: (sessionId, input) => { const request = deferred(); configures.push({ ...request, sessionId, input }); return request.promise },
    acpSessionCancel: (sessionId) => { const request = deferred(); cancels.push({ ...request, sessionId }); return request.promise },
    acpSessionKill: async () => ({ ok: false, error: 'kill failed' }),
    acpSessionResume: async () => ({ ok: true }),
    onAcpOutput: (callback) => { outputs.add(callback); return () => outputs.delete(callback) },
    onAcpState: (callback) => { states.add(callback); return () => states.delete(callback) },
    onAcpDone: (callback) => { dones.add(callback); return () => dones.delete(callback) }
  }
}
globalThis.__ACP_UI__ = runtime
const nodes = (tree) => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
const find = (harness, predicate) => { const result = nodes(harness.tree).find(predicate); assert.ok(result, 'expected ACP interactive element'); return result }
const findAll = (harness, predicate) => nodes(harness.tree).filter(predicate)
const settle = async (harness) => { for (let index = 0; index < 7; index++) await Promise.resolve(); harness.render() }
const emit = (listeners, payload) => { for (const callback of [...listeners]) callback(payload) }
const record = (id, root = rootA, events = []) => ({ sessionId: id, title: id, projectRoot: root, agentId: 'codex', agentName: 'Codex', status: 'ready', startedAt: 10, events, connectionGeneration: `conn-${id}` })
const permission = (id, sessionId, root = rootA) => ({ id, ts: 10, source: 'acp', kind: 'permission', projectRoot: root, sessionId, payload: { requestId: id, pending: true, permission: { requestId: id, sessionId, options: [{ optionId: 'allow-first', kind: 'allow_once', name: 'Allow first' }, { optionId: 'allow-second', kind: 'allow_once', name: 'Allow second' }, { optionId: 'deny-always', kind: 'reject_always', name: 'Deny always' }] } } })
const check = (name, condition) => { assert.ok(condition, name); console.log(`PASS ${name}`) }

try {
  const files = ['ConsoleWorkspace', 'ProfileEditor', 'RuntimePanel', 'SessionDetails', 'TranscriptRow', 'JiraPicker'].map((name) => `src/renderer/src/acp/${name}.tsx`)
  const icons = new Set(files.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/import\s*\{([^}]+)\}\s*from 'lucide-react'/gs)].flatMap((match) => match[1].split(',').map((name) => name.trim()))))
  const mocks = {
    react: `const r = globalThis.__ACP_UI__; ${['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect'].map((name) => `export const ${name} = (...args) => r.current.${name}(...args);`).join('\n')} export const useLayoutEffect = useEffect; export default { memo: (component) => component };`,
    'react/jsx-runtime': 'export const jsx = (type, props, key) => ({ type, props, key }); export const jsxs = jsx; export const Fragment = "fragment";',
    'lucide-react': [...icons].map((name) => `export const ${name} = () => null;`).join('\n'),
    '../api': 'export const api = globalThis.__ACP_UI__.api; export const hasIpc = true;',
    '../store': 'const r = globalThis.__ACP_UI__; export const useApp = (selector) => selector(r.state); useApp.getState = () => r.state;',
    '../my/ui': 'export function Button() {} export function Modal() {}',
    '../components/MarkdownView': 'export function MarkdownView() {}',
    '../components/Dialogs': 'export const confirmDialog = async () => false;',
    '../observation/ObservationPanel': 'export function ObservationPanel() {}'
  }
  const plugin = { name: 'hook-mocks', setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined)
    plugin.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({ contents: mocks[args.path], loader: 'js' }))
  } }
  await build({ entryPoints: ['src/renderer/src/pages/AcpConsole.tsx', 'src/renderer/src/acp/timeline.ts', 'src/renderer/src/acp/SessionDetails.tsx', 'src/renderer/src/acp/TranscriptRow.tsx', 'src/renderer/src/acp/view-state.ts'], outdir: temporary, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [plugin] })
  const { AcpConsolePage } = await import(pathToFileURL(join(temporary, 'pages/AcpConsole.js')).href)
  const { compileItems, mergeEvents } = await import(pathToFileURL(join(temporary, 'acp/timeline.js')).href)
  const { SessionDetails } = await import(pathToFileURL(join(temporary, 'acp/SessionDetails.js')).href)
  const { EventRow } = await import(pathToFileURL(join(temporary, 'acp/TranscriptRow.js')).href)
  const views = await import(pathToFileURL(join(temporary, 'acp/view-state.js')).href)
  const longDraft = '长草稿'.repeat(18000)
  views.writeSessionView('D:/draft-roundtrip', 'draft', { draft: longDraft })
  const restoredViews = await import(`${pathToFileURL(join(temporary, 'acp/view-state.js')).href}?restart`)
  check('persisted accepted long draft survives a fresh view-state module without truncation', restoredViews.readSessionView('D:/draft-roundtrip', 'draft').draft === longDraft)
  const page = new Harness(AcpConsolePage)
  const rows = () => findAll(page, (node) => node.type?.name === 'EventRow')
  const select = (id) => { find(page, (node) => node.props?.['data-acp-session'] === id).props.onClick(); page.render() }
  const textarea = () => find(page, (node) => node.type === 'textarea')
  const draft = (text) => { textarea().props.onChange({ target: { value: text } }); page.render() }
  const refresh = () => find(page, (node) => node.props?.title === '刷新').props.onClick()
  const newRuntime = () => find(page, (node) => node.props?.['aria-label'] === '新会话 Runtime')
  const sendButton = () => find(page, (node) => node.props?.title === '发送指令')
  page.render()
  const early = permission('early', 'a1')
  emit(outputs, early)
  lists.shift().resolve({ ok: true, sessions: [record('a1'), record('a2'), record('foreign', rootB)] })
  await settle(page)
  select('a1')
  check('foreign project list records are excluded', !findAll(page, (node) => node.props?.['data-acp-session'] === 'foreign').length)
  check('early permission before list remains actionable', rows().some((node) => node.props.pendingPerm.early))
  emit(outputs, { id: 'foreign-text', source: 'acp', kind: 'message', sessionId: 'foreign', projectRoot: rootB, ts: 11, text: 'FOREIGN' })
  emit(dones, { sessionId: 'foreign', status: 'closed' })
  page.render()
  check('foreign output and terminal status do not reach current session', rows().every((node) => node.props.item.text !== 'FOREIGN') && textarea().props.disabled === false)

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
  check('busy permits drafting but blocks send', textarea().props.disabled === false && sendButton().props.disabled === true)
  sends.shift().resolve({ ok: true }); await settle(page)
  check('late successful acknowledgement preserves a newer draft', textarea().props.value === '运行时准备下一条')
  emit(states, { sessionId: 'a1', projectRoot: rootA, status: 'error', connectionGeneration: 'conn-a1', session: { ...record('a1'), status: 'error', historyKind: 'live' } }); page.render()
  check('failed live runtime still offers explicit process stop for cleanup retry', Boolean(find(page, node => node.props?.title === '停止当前会话及其拥有的进程')))
  emit(states, { sessionId: 'a1', projectRoot: rootA, status: 'ready', connectionGeneration: 'conn-a1' }); page.render()

  const earlyRow = rows()[0]
  await earlyRow.props.onRespond('early', 'not-a-choice')
  check('invalid GUI permission choice never consumes request', approvals.length === 0)
  void earlyRow.props.onRespond('early', 'allow-second'); void earlyRow.props.onRespond('early', 'allow-first')
  check('same-kind second permission ID and duplicate lock are exact', approvals.length === 1 && approvals[0].optionId === 'allow-second')
  approvals.shift().resolve({ ok: false, error: 'stale option' }); await settle(page)
  check('failed approval keeps choices actionable with failure feedback', rows()[0].props.pendingPerm.early && rows()[0].props.permissionErrors.early === 'stale option')
  void rows()[0].props.onRespond('early', 'deny-always'); approvals.shift().resolve({ ok: true }); await settle(page)
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
  find(page, (node) => node.type?.name === 'Button' && node.props.children === '全部 Agent').props.onClick(); page.render()
  newRuntime().props.onChange({ target: { value: 'codex' } }); const oldCreate = creates.shift()
  runtime.state.snapshot = { meta: { root: rootA }, tasks: [] }; page.render()
  oldCreate.resolve({ ok: true, sessionId: 'foreign-created' })
  lists.shift().resolve({ ok: true, sessions: [record('a1'), record('a2')] }); await settle(page)
  staleReturningA.resolve({ ok: true, sessions: [record('stale-return-a')] }); await settle(page)
  check('A to B to A rejects original list/create/output closures', !findAll(page, (node) => ['stale-return-a', 'foreign-created', 'stale-a'].includes(node.props?.['data-acp-session'])).length && lists.length === 0)

  find(page, (node) => node.type?.name === 'Button' && node.props.children === '全部 Agent').props.onClick(); page.render()
  newRuntime().props.onChange({ target: { value: 'codex' } }); const currentCreate = creates.shift()
  const createdPermission = permission('created-permission', 'created-a')
  emit(outputs, createdPermission); emit(states, { sessionId: 'created-a', projectRoot: rootA, status: 'awaiting_permission' })
  currentCreate.resolve({ ok: true, sessionId: 'created-a' }); await settle(page)
  lists.shift().resolve({ ok: true, sessions: [record('created-a'), record('a1')] }); await settle(page)
  check('creation reply preserves early output/state/live permission', rows().some((node) => node.props.pendingPerm['created-permission']))
  emit(outputs, { ...createdPermission, id: 'resolved', ts: 12, payload: { requestId: 'created-permission', pending: false } }); page.render()
  check('live resolution removes all actionable approval buttons', rows().every((node) => !node.props.pendingPerm['created-permission']))
  runtime.state.snapshot = null; page.render()
  check('no project gives honest empty state and no new IPC list request', JSON.stringify(page.tree).includes('请先打开项目') && lists.length === 0)
  page.dispose()

  const typedEvents = [{ id: 'tool', ts: 1, source: 'acp', kind: 'tool-call', turnId: 't1', payload: { toolCallId: 'x', status: 'pending', rawInput: { path: 'sample' }, content: [{ type: 'content', content: { type: 'text', text: 'output' } }] }, text: 'Read sample' }, { id: 'patch', ts: 2, source: 'acp', kind: 'tool-call', turnId: 't1', payload: { toolCallId: 'x', status: 'completed', rawOutput: null } }]
  const compiled = compileItems(typedEvents)
  check('tool patch keeps original input/title/content and explicit null output', compiled.length === 1 && compiled[0].tool.title === 'Read sample' && compiled[0].tool.payload.rawInput.path === 'sample' && compiled[0].tool.payload.rawOutput === null)
  check('same tool ID in another turn cannot rewrite earlier tool', compileItems([...typedEvents, { ...typedEvents[0], id: 'new', turnId: 't2' }]).length === 2)
  const normalizedPatch = { ...typedEvents[1], text: 'tool call', payload: { ...typedEvents[1].payload, tag: 'tool_call_update', title: 'tool call' } }
  const retainedTitle = compileItems([typedEvents[0], normalizedPatch])[0].tool
  check('normalized partial tool placeholder preserves meaningful title and updated result', retainedTitle.title === 'Read sample' && retainedTitle.status === 'completed' && retainedTitle.payload.rawOutput === null)
  check('explicit changed tool title still replaces prior label', compileItems([typedEvents[0], { ...normalizedPatch, text: 'Read updated file', payload: { ...normalizedPatch.payload, title: 'Read updated file' } }])[0].tool.title === 'Read updated file')
  check('event merge deduplicates and authoritative snapshots replace pending flags', mergeEvents([{ ...early, payload: { pending: false } }], [early]).length === 1 && mergeEvents([{ ...early, payload: { pending: false } }], [early])[0].payload.pending === false)

  const metadata = (id, kind, payload, text) => ({ id, kind, payload, text, source: 'acp', ts: 1, turnId: 'metadata-turn' })
  const routine = [
    metadata('info1', 'session-status', { type: 'status', tag: 'session_info_update' }, 'session updated'),
    metadata('usage', 'session-status', { type: 'status', tag: 'usage_update', used: 20321, size: 828400 }, 'usage updated: 20321/828400'),
    metadata('config', 'config', { type: 'status', tag: 'current_mode_update' }, 'mode updated'),
    metadata('info2', 'session-status', { type: 'status', tag: 'session_info_update' }, 'session updated'),
    metadata('routine-diag', 'diagnostic', { type: 'done', data: 'retained' }, 'Runtime 更新')
  ]
  const reportedError = metadata('runtime-error', 'diagnostic', { type: 'error', code: 'E_RUNTIME' }, '运行连接失败')
  const grouped = compileItems([routine[0], { ...typedEvents[0], id: 'visible-tool' }, routine[1], { ...early, turnId: 'metadata-turn' }, reportedError, ...routine.slice(2)])
  const activity = grouped.filter((item) => item.type === 'activity')
  check('routine runtime metadata groups once per turn without losing original payloads', activity.length === 1 && activity[0].events.length === 5 && activity[0].events.find((event) => event.id === 'usage').payload.used === 20321 && activity[0].events.some((event) => event.id === 'routine-diag'))
  check('activity grouping preserves visible tool, approval and runtime error rows', grouped.some((item) => item.type === 'tool') && grouped.some((item) => item.type === 'perm') && grouped.some((item) => item.type === 'detail' && item.ev.id === 'runtime-error'))
  const activityView = new Harness(EventRow, { item: activity[0], pendingPerm: {}, permissionPending: {}, permissionErrors: {} })
  activityView.render()
  check('runtime activity is collapsed by default with Chinese count and raw detail access', activityView.tree.type === 'details' && activityView.tree.props.open !== true && JSON.stringify(activityView.tree.props.children[0]).includes('运行活动') && findAll(activityView, (node) => node.type?.name === 'RawData').length === 5)
  const errorView = new Harness(EventRow, { item: grouped.find((item) => item.type === 'detail' && item.ev.id === 'runtime-error'), pendingPerm: {}, permissionPending: {}, permissionErrors: {} })
  errorView.render()
  check('runtime error stays visible outside collapsed activity with expandable raw data', errorView.tree.props.role === 'alert' && JSON.stringify(errorView.tree).includes('运行连接失败') && findAll(errorView, (node) => node.type?.name === 'RawData').length === 1)

  let updated
  const session = { ...record('config'), currentModelId: 'model-a', models: [{ modelId: 'model-a', name: 'A' }, { modelId: 'model-b', name: 'B' }], capabilities: { controls: ['session/set_model'] } }
  const details = new Harness(SessionDetails, { session, isCurrent: () => true, onUpdated: (value) => { updated = value } })
  details.render()
  find(details, (node) => node.props?.['aria-label'] === '会话模型').props.onChange({ target: { value: 'model-b' } }); details.render()
  check('model selector retains acknowledged value while request pending', find(details, (node) => node.props?.['aria-label'] === '会话模型').props.value === 'model-a')
  configures.shift().resolve({ ok: false, error: 'unsupported' }); await settle(details)
  check('failed configuration retains effective value and error', !updated && JSON.stringify(details.tree).includes('unsupported'))
  find(details, (node) => node.props?.['aria-label'] === '会话模型').props.onChange({ target: { value: 'model-b' } })
  configures.shift().resolve({ ok: true, session: { ...session, currentModelId: 'model-b' } }); await settle(details)
  check('configuration updates only from acknowledged session result', updated.currentModelId === 'model-b')
  details.dispose()

  const categorizedDetails = new Harness(SessionDetails, { session: { ...session, currentModeId: 'read-only', modes: [{ id: 'read-only', name: 'Read only' }], capabilities: { controls: ['session/set_model', 'session/set_mode', 'session/set_config_option'] }, configOptions: [
    { id: 'choice-a', category: 'mode', name: 'Categorized mode', currentValue: 'read-only', options: [{ value: 'read-only', name: 'Read only' }] },
    { id: 'choice-b', category: 'model', name: 'Categorized model', currentValue: 'model-a', options: [{ value: 'model-a', name: 'Model A' }] },
    { id: 'mode', name: 'Uncategorized setting', currentValue: 'x', options: [{ value: 'x', name: 'Other' }] }
  ] }, isCurrent: () => true, onUpdated() {} })
  categorizedDetails.render()
  check('categorized model/mode each render once while unrelated config with arbitrary mode ID remains', findAll(categorizedDetails, node => node.type === 'select').length === 3 && find(categorizedDetails, node => node.props?.['aria-label'] === '会话模式').props.value === 'read-only' && Boolean(find(categorizedDetails, node => node.props?.['aria-label'] === 'Uncategorized setting')))
  categorizedDetails.dispose()

  const permView = new Harness(EventRow, { item: { type: 'perm', key: early.id, ev: early }, pendingPerm: { early: early.payload.permission }, permissionPending: {}, permissionErrors: {}, onRespond() {} })
  permView.render()
  check('reject_always is displayed as rejection with original label and ID', findAll(permView, (node) => node.props?.title === '原始选项：deny-always · reject_always').some((node) => node.props.children[1].props.children === 'Deny always' && node.props.className.includes('danger')))
  console.log('\nACP UI hook and projection regression: passed (native layout/IME/scroll acceptance remains separate)')
} finally { rmSync(temporary, { recursive: true, force: true }) }
