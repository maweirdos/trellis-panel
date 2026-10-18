/** Actual document-pane controls/handlers with a controlled reader; no native DOM claims. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-document-pane-'))
const root = 'D:/pane-fixture', taskDir = 'review-task', relativePath = `.trellis/tasks/${taskDir}/prd.md`
const runtime = { current: null, reader: {}, state: { snapshot: { meta: { root } } } }
globalThis.__documentPane = runtime
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
class Harness {
  slots = []; cursor = 0; effects = []; tree = null
  constructor(component, props) { this.component = component; this.props = props }
  ref(value) { const index = this.cursor++; return this.slots[index] ??= { current: value } }
  state(value) { const index = this.cursor++; const slot = this.slots[index] ??= { value }; return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }] }
  memo(compute, deps) { const index = this.cursor++; if (!this.slots[index] || !sameDeps(this.slots[index].deps, deps)) this.slots[index] = { deps, value: compute() }; return this.slots[index].value }
  effect(effect, deps) { const index = this.cursor++; const old = this.slots[index]; if (!old || !sameDeps(old.deps, deps)) { this.slots[index] = { deps }; this.effects.push(() => { old?.cleanup?.(); this.slots[index].cleanup = effect() }) } }
  render() { this.cursor = 0; this.effects = []; runtime.current = this; this.tree = this.component(this.props); for (const effect of this.effects) effect(); return this.tree }
  dispose() { for (const slot of this.slots) slot?.cleanup?.() }
}
const nodes = (tree) => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
const find = (pane, predicate) => { const value = nodes(pane.tree).find(predicate); assert.ok(value, 'expected actual pane control'); return value }
const text = (value) => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '')
let count = 0
const check = (name, condition) => { assert.ok(condition, name); count++; console.log(`PASS ${name}`) }

try {
  const mocks = {
    react: `const r = globalThis.__documentPane; export const useRef = (...a) => r.current.ref(...a); export const useState = (...a) => r.current.state(...a); export const useMemo = (...a) => r.current.memo(...a); export const useEffect = (...a) => r.current.effect(...a);`,
    'react/jsx-runtime': 'export const jsx = (type, props, key) => ({ type, props, key }); export const jsxs = jsx; export const Fragment = "fragment";',
    'lucide-react': ['Copy', 'ExternalLink', 'FileText', 'List', 'Maximize2', 'Minimize2', 'Quote', 'X'].map((name) => `export function ${name}() {}`).join('\n'),
    '../api': 'export const api = {};',
    '../store': 'const r = globalThis.__documentPane; export const useApp = (select) => select(r.state); useApp.getState = () => r.state;',
    '../my/ui': 'export function Button() {}',
    '../utils/interaction-scope': 'export const useInteractionGuard = () => () => true;',
    '../reader/DocumentReader': 'export function DocumentReaderSurface() {}',
    '../reader/use-document-reader': 'export const useDocumentReader = () => globalThis.__documentPane.reader;'
  }
  const bundle = join(directory, 'pane.mjs')
  await build({ entryPoints: ['src/renderer/src/acp/ConversationDocumentPane.tsx'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'silent', plugins: [{ name: 'pane-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({ contents: mocks[args.path], loader: 'js' }))
  } }] })
  const { ConversationDocumentPane } = await import(pathToFileURL(bundle).href)
  const references = []
  const pane = new Harness(ConversationDocumentPane, { projectRoot: root, taskDir, relativePath, sessionId: 'session', connectionGeneration: 'generation', expanded: false, onToggleExpanded() {}, onClose() {}, onReference(reference) { references.push(reference) } })
  const directoryButton = () => find(pane, (node) => node.type?.name === 'Button' && text(node.props.children).trim() === '目录')
  runtime.reader = { displayedText: null, session: undefined, doc: null, pendingUpdate: false, requestError: null, unreadableNotice: null }
  pane.render()
  check('outline remains disabled while the displayed document is unavailable', directoryButton().props.disabled === true)
  const markdown = '# Review\r\n\r\n## Goals\r\n\r\n| Item | Result |\r\n| --- | --- |\r\n| One | Yes |\r\n\r\n## Acceptance\r\n\r\nExact source paragraph.\r\n'
  runtime.reader = { ...runtime.reader, displayedText: markdown, session: { displayed: { revision: 'raw-crlf-revision', text: markdown } }, doc: { source: { canonicalPath: `${root}/${relativePath}` } } }
  pane.render()
  check('a loaded CRLF PRD enables the actual Directory control', directoryButton().props.disabled === false)
  directoryButton().props.onClick(); pane.render()
  const outline = find(pane, (node) => node.type === 'nav' && node.props['aria-label'] === '文档目录')
  const links = nodes(outline).filter((node) => node.type === 'button')
  check('the actual outline contains all displayed sections without table rows', links.map((node) => node.props.children).join('|') === 'Review|Goals|Acceptance')
  const located = { id: 'acceptance', tabIndex: undefined, scrollIntoView(options) { this.scroll = options.block }, focus(options) { this.focused = options.preventScroll } }
  find(pane, (node) => node.props?.className?.includes('acp-document__body')).props.ref.current = { querySelectorAll() { return [located] } }
  links.find((node) => node.props.children === 'Acceptance').props.onClick()
  check('section navigation scrolls and focuses the rendered stable heading', located.scroll === 'start' && located.tabIndex === -1 && located.focused === true)
  find(pane, (node) => node.props?.title === '引用章节：Acceptance').props.onClick(); pane.render()
  check('section quotation uses its real anchor and unchanged displayed byte revision without sending', references.length === 1 && references[0].sectionAnchor === 'acceptance' && references[0].displayedRevision === 'raw-crlf-revision' && references[0].targetSessionId === 'session' && runtime.reader.displayedText === markdown)
  pane.dispose()
  console.log(`ACP document pane: ${count} checks passed`)
} finally { delete globalThis.__documentPane; rmSync(directory, { recursive: true, force: true }) }
