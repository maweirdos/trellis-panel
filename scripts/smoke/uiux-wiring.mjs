/** Real component hook/event wiring; this does not mount DOM or prove native/visual acceptance. */
import assert from 'node:assert/strict'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { lucideMockSource } from './icon-mocks.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'tpanel-uiux-wiring-'))
let nextId = 0
class Harness {
  hooks = []; index = 0; effects = []; dirty = false; tree = null
  constructor(component, props = {}) { this.component = component; this.props = props; this.id = ++nextId }
  same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  useState = (initial) => {
    const index = this.index++
    const slot = this.hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial }
    return [slot.value, (value) => { const next = typeof value === 'function' ? value(slot.value) : value; if (!Object.is(next, slot.value)) { slot.value = next; this.dirty = true } }]
  }
  useRef = (initial) => this.hooks[this.index++] ??= { current: initial }
  useId = () => { const index = this.index++; return this.hooks[index] ??= `h${this.id}-${index}` }
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
    let turns = 0
    do {
      assert.ok(++turns < 30, 'bounded hook updates')
      runtime.current = this; this.index = 0; this.effects = []; this.dirty = false
      this.tree = this.component(this.props)
      for (const effect of this.effects) effect()
    } while (this.dirty)
    return this.tree
  }
  dispose = () => { for (const slot of this.hooks) slot?.cleanup?.() }
}
const listeners = new Map()
globalThis.window = {
  innerWidth: 1440,
  location: { search: '' },
  addEventListener: (type, listener) => { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set) },
  removeEventListener: (type, listener) => listeners.get(type)?.delete(listener)
}
globalThis.document = { activeElement: null, querySelector: () => null }
globalThis.localStorage = { getItem: () => null, setItem() {} }
globalThis.HTMLElement = class {}
globalThis.requestAnimationFrame = (callback) => callback()
const root = 'D:/project'
const runtime = {
  current: null, toasts: [], reads: [],
  state: {
    snapshot: { meta: { root }, tasks: [{ dirName: 'task-a', path: `${root}/.trellis/tasks/task-a`, artifacts: [], record: null }], archived: [] },
    settings: { ai: { enabled: false }, weknora: { enabled: false } }, openTaskDir: 'task-a', openTaskArchived: false,
    taskMaterialTarget: null, readingSessions: {}, viewerTabs: [],
    setTaskMaterialTarget() {}, pushToast: (toast) => runtime.toasts.push(toast), openArtifact() {}, setPage() {}, openSpecDocument() {}, inboxRemove() {}
  },
  api: {
    gitTaskInfo: async () => null, kbQaHistory: async () => ({ ok: true, entries: [] }),
    readTextFile: (path) => new Promise((resolveRead) => runtime.reads.push({ path, resolve: resolveRead })),
    kbSearch: async (_library, query) => ({ ok: true, docs: runtime.docs, hits: query ? runtime.docs.map((doc) => ({ doc, snippet: 'local result', score: 1 })) : [], totalDocs: runtime.docs.length, elapsedMs: 1 }),
    weknoraSearch: async () => { throw new Error('Unexpected legacy global knowledge fallback') },
    knowledgeAccess: {
      context: async ({ expectedRoot }) => ({ ok: true, data: { scope: { root: expectedRoot, connectionId: runtime.projectKnowledgeBound ? 'project-connection' : null, collectionIds: runtime.projectKnowledgeBound ? ['company'] : [], status: runtime.projectKnowledgeBound ? 'ok' : 'not_configured' }, legacyImportAvailable: false } }),
      search: async ({ expectedRoot }) => {
        assert.equal(expectedRoot, root, 'federated lookup retains its project owner')
        return { ok: true, data: { status: 'unavailable', detail: 'company unavailable', sources: [], elapsedMs: 1, persistence: 'durable' } }
      }
    },
    specBacklinks: async () => ({ ok: true, counts: {} }),
    docsSearch: async () => ({ ok: true, hits: [] })
  },
  docs: ['a', 'b'].map((id) => ({ id, name: `${id}.md`, title: `Note ${id}`, path: `${root}/.trellis/notes/${id}.md`, library: 'notes', group: 'notes', size: 10, mtime: 1, synthetic: false }))
}
globalThis.__UIUX_WIRING__ = runtime
const nodes = (tree) => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
const find = (h, predicate) => { const result = nodes(h.tree).find(predicate); assert.ok(result, 'expected interactive element'); return result }
const settle = async (h) => { await Promise.resolve(); await Promise.resolve(); h.render() }

try {
  const targets = ['src/renderer/src/my/ui.tsx', 'src/renderer/src/pages/TaskDetail.tsx', 'src/renderer/src/pages/Knowledge.tsx', 'src/renderer/src/pages/Spec.tsx']
  const iconMock = lucideMockSource([...globSync('src/renderer/src/**/*.tsx')])
  const mocks = {
    react: `const r = globalThis.__UIUX_WIRING__; ${['useState', 'useRef', 'useId', 'useMemo', 'useCallback', 'useEffect'].map((name) => `export const ${name} = (...args) => r.current.${name}(...args);`).join('\n')} export const useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot(); export const createContext = (value) => ({ _value:value, Provider:() => null }); export const useContext = (context) => context._value; export const useLayoutEffect = useEffect; export default { memo: (component) => component };`,
    'react/jsx-runtime': 'export const jsx = (type, props, key) => ({ type, props, key }); export const jsxs = jsx; export const Fragment = "fragment";',
    'react-dom': 'export const createPortal = (children) => children;',
    'lucide-react': iconMock,
    '../store': 'const r = globalThis.__UIUX_WIRING__; export const useApp = (selector) => selector(r.state); useApp.getState = () => r.state; useApp.subscribe = () => () => {}; export const useMy = (selector) => selector({ sidebarWidth:275, setSidebarWidth(){} });',
    '../../store': 'const r = globalThis.__UIUX_WIRING__; export const useApp = (selector) => selector(r.state); useApp.getState = () => r.state; useApp.subscribe = () => () => {};',
    '../my/store': 'const state = {sidebarWidth:275,sidebarCollapsed:false,setSidebarWidth(){},toggleSidebar(){}}; export const useMy = (selector) => selector(state); useMy.getState=()=>state;',
    '../api': 'export const api = globalThis.__UIUX_WIRING__.api; export const hasIpc = true;',
    '../components/MarkdownView': 'export function MarkdownView() {}',
    '../reader/DocumentReader': 'export function DocumentReader() {}',
    '../observation/ObservationPanel': 'export function ObservationPanel() {}',
    '../components/Dialogs': 'export const confirmDialog = async () => false;',
    '../components/badges': 'export function PriorityBadge() {} export function StatusBadge() {} export function JiraChip() {}',
    './DiffModal': 'export function DiffModal() {}'
  }
  const entry = join(temporary, 'entry.ts')
  writeFileSync(entry, [
    `export { Dropdown, Modal } from '${resolve(targets[0]).replace(/\\/g, '/')}'`,
    `export { TaskDetail } from '${resolve(targets[1]).replace(/\\/g, '/')}'`,
    `export { KnowledgePage } from '${resolve(targets[2]).replace(/\\/g, '/')}'`,
    `export { SpecPage } from '${resolve(targets[3]).replace(/\\/g, '/')}'`,
    `export { dispatchEscKey, escLayerCount } from '${resolve('src/renderer/src/utils/esc-layer.ts').replace(/\\/g, '/')}'`
  ].join('\n'))
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', outfile: join(temporary, 'bundle.mjs'), plugins: [{ name: 'hook-only-mocks', setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'hook-mock' } : undefined)
    plugin.onLoad({ filter: /.*/, namespace: 'hook-mock' }, (args) => ({ contents: mocks[args.path], loader: 'js' }))
  } }] })
  const { Dropdown, Modal, TaskDetail, KnowledgePage, SpecPage, dispatchEscKey, escLayerCount } = await import(pathToFileURL(join(temporary, 'bundle.mjs')).href)

  const task = new Harness(TaskDetail, { presentation: 'workspace' })
  runtime.state.returnFromWorkspace = () => { task.props.presentation = 'preview' }
  runtime.state.showTask = (path) => { runtime.state.openTaskDir = path }
  task.render()
  assert.equal(escLayerCount(), 1)
  const menu = new Harness(Dropdown, { trigger: ({ toggle }) => ({ type: 'button', props: { onClick: toggle } }), children: () => 'menu' })
  menu.render(); find(menu, (node) => node.type === 'button').props.onClick(); menu.render()
  assert.equal(escLayerCount(), 2)
  dispatchEscKey(); menu.render(); task.render()
  assert.equal(task.props.presentation, 'workspace', 'Escape in a project/menu dropdown never returns the task behind it')
  assert.equal(escLayerCount(), 1)
  find(task, (node) => node.props?.['aria-controls'] === 'task-context-panel').props.onClick(); task.render()
  assert.equal(escLayerCount(), 2)
  dispatchEscKey(); task.render()
  assert.equal(task.props.presentation, 'workspace', 'context closes before the task workspace')
  assert.equal(escLayerCount(), 1)
  dispatchEscKey(); task.render()
  assert.equal(task.props.presentation, 'preview')
  assert.equal(runtime.state.openTaskDir, 'task-a')
  assert.equal(escLayerCount(), 1, 'return re-registers a preview layer even though task identity is unchanged')

  const modal = new Harness(Modal, { open: true, onClose: () => { modal.props.open = false }, children: 'modal' })
  modal.render(); find(menu, (node) => node.type === 'button').props.onClick(); menu.render()
  dispatchEscKey(); menu.render(); modal.render(); task.render()
  assert.equal(modal.props.open, true, 'nested menu closes without closing its modal')
  assert.equal(runtime.state.openTaskDir, 'task-a')
  dispatchEscKey(); modal.render(); task.render()
  assert.equal(modal.props.open, false)
  assert.equal(runtime.state.openTaskDir, 'task-a', 'modal Escape does not also close the underlying preview')
  dispatchEscKey(); task.render()
  assert.equal(runtime.state.openTaskDir, null)
  assert.equal(escLayerCount(), 0)
  menu.dispose(); modal.dispose(); task.dispose()

  const knowledge = new Harness(KnowledgePage)
  knowledge.render(); await settle(knowledge)
  find(knowledge, (node) => node.type === 'button' && node.props?.title?.includes('当前项目 .trellis/notes')).props.onClick()
  knowledge.render(); await settle(knowledge)
  find(knowledge, (node) => node.key === 'a').props.onClick(); knowledge.render()
  find(knowledge, (node) => node.props?.title === '编辑这篇笔记').props.onClick()
  const oldRead = runtime.reads.shift()
  find(knowledge, (node) => node.key === 'b').props.onClick(); knowledge.render()
  oldRead.resolve({ ok: true, content: 'OLD A' }); await settle(knowledge)
  assert.equal(nodes(knowledge.tree).some((node) => node.type === 'textarea'), false, 'late edit read cannot replace a newer file selection')
  find(knowledge, (node) => node.props?.title === '编辑这篇笔记').props.onClick()
  runtime.reads.shift().resolve({ ok: false, error: 'unreadable' }); await settle(knowledge)
  assert.equal(nodes(knowledge.tree).some((node) => node.type === 'textarea'), false, 'failed read cannot open an empty editable draft')
  assert.equal(runtime.toasts.at(-1).title, '无法编辑笔记')
  find(knowledge, (node) => node.props?.title === '编辑这篇笔记').props.onClick()
  const supersededRead = runtime.reads.shift()
  find(knowledge, (node) => node.props?.title?.startsWith('新建项目笔记')).props.onClick(); knowledge.render()
  supersededRead.resolve({ ok: true, content: 'OLD B' }); await settle(knowledge)
  assert.equal(find(knowledge, (node) => node.type === 'textarea').props.value, '# 新笔记\n\n', 'new note survives a superseded edit response')
  knowledge.dispose()

  runtime.projectKnowledgeBound = true
  const federated = new Harness(KnowledgePage)
  federated.render(); await settle(federated)
  find(federated, (node) => node.type === 'button' && node.props?.title?.startsWith('跨库联合检索')).props.onClick(); federated.render()
  find(federated, (node) => node.props?.placeholder === '全文检索：中文/英文关键词混排…').props.onChange('local')
  federated.render(); await new Promise((resolveTimer) => setTimeout(resolveTimer, 320)); await settle(federated); await settle(federated)
  assert.ok(nodes(federated.tree).some((node) => node.key === 'a'), 'company failure leaves local search hits visible')
  assert.ok(JSON.stringify(federated.tree).includes('company unavailable'), 'company failure remains explicit')
  federated.dispose()

  const journal = { path: `${root}/.trellis/workspace/dev/journal.md`, name: 'journal.md', size: 12, mtime: 1 }
  runtime.state.snapshot.spec = []
  runtime.state.snapshot.developers = [{ name: 'dev', journals: [journal], otherFiles: [], lastActive: 1 }]
  runtime.state.snapshot.sharedWorkspaceFiles = []
  runtime.state.consumeSpecDocumentTarget = () => { const target = runtime.specTarget ?? null; runtime.specTarget = null; return target }
  const spec = new Harness(SpecPage)
  spec.render()
  find(spec, (node) => node.key === journal.path).props.onClick(); spec.render()
  runtime.reads.shift().resolve({ ok: true, content: '# WORKSPACE LOG', mtime: 1 }); await settle(spec)
  assert.ok(nodes(spec.tree).some((node) => node.type?.name === 'DocumentReader' && node.props.relativePath === '.trellis/workspace/dev/journal.md'), 'workspace/log selection renders the reader with no Spec tree selection')
  assert.equal(nodes(spec.tree).some((node) => node.props?.children?.some?.((child) => child === ' 编辑')), false, 'non-Spec log remains read-only')
  spec.dispose()

  runtime.specTarget = { projectRoot: 'D:/foreign', path: `${root}/.trellis/spec/requested.md` }
  const foreign = new Harness(SpecPage)
  foreign.render()
  assert.equal(runtime.reads.length, 0, 'a mismatched root target never starts a document read')
  foreign.dispose()
  runtime.specTarget = { projectRoot: root, path: `${root}/../outside.md` }
  const escaped = new Harness(SpecPage)
  escaped.render()
  assert.equal(runtime.reads.length, 0, 'a parent traversal target never reaches the legacy absolute reader')
  escaped.dispose()
  runtime.specTarget = { projectRoot: root, path: `${root}/.trellis/spec/requested.md` }
  const targeted = new Harness(SpecPage)
  targeted.render()
  assert.equal(runtime.reads[0].path, runtime.specTarget?.path ?? `${root}/.trellis/spec/requested.md`)
  runtime.reads.shift().resolve({ ok: true, content: '# TARGET', mtime: 1 }); await settle(targeted)
  assert.ok(nodes(targeted.tree).some((node) => node.type?.name === 'DocumentReader' && node.props.relativePath === '.trellis/spec/requested.md'), 'a root-owned one-shot target locates the original document')
  targeted.dispose()
  console.log('PASS UIUX component wiring: Escape precedence and task return, Knowledge edit races/local-first company failure, Spec log rendering and root-scoped targeting')
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(temporary.includes('tpanel-uiux-wiring-'))
  rmSync(temporary, { recursive: true, force: true })
  delete globalThis.__UIUX_WIRING__
}
