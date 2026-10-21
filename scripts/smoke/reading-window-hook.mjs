/** Actual useDocumentReader with seed/transport; controlled React scheduling, not DOM QA. */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const directory = mkdtempSync(join(tmpdir(), 'tpanel-native-reader-hook-'))
const absolute = (path) => resolve(path).replace(/\\/g, '/')
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
const pending = { read: [], watch: [], unwatch: [], diff: [] }
const request = (kind, args) => new Promise((resolve, reject) => pending[kind].push({ args, resolve, reject }))
const transport = { documentRead: (...a) => request('read', a), documentWatch: (...a) => request('watch', a), documentDiff: (...a) => request('diff', a), documentUnwatch: (...a) => { pending.unwatch.push(a); return Promise.resolve() } }
const root = 'D:/original-project', relativePath = '.trellis/tasks/demo/prd.md'
const doc = (revision) => ({ ok: true, requestId: revision, revision, rawText: `# ${revision}\nSelected ${revision}.`, parsed: null, diagnostics: [], fixedVersion: { token: `rd-${revision}`, revision }, source: { workspaceId: 'native-owned', taskRef: null, relativePath, canonicalPath: `${root}/${relativePath}`, sizeBytes: 10, mtimeMs: 1 } })
const take = (kind) => { const entry = pending[kind].shift(); assert.ok(entry, `expected ${kind} request`); return entry }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
let count = 0
const check = (name, value) => { assert.ok(value, name); console.log(`PASS ${name}`); count++ }
function host(id, hook) {
  const slots = []; let cursor = 0, effects = []
  return {
    id,
    ref(value) { const index = cursor++; return slots[index] ??= { current: value } },
    state(value) { const index = cursor++; const slot = slots[index] ??= { value: typeof value === 'function' ? value() : value }; return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }] },
    callback(callback, deps) { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { callback, deps }; return slots[index].callback },
    effect(effect, deps) { const index = cursor++, old = slots[index]; if (!old || !sameDeps(old.deps, deps)) { slots[index] = { deps }; effects.push(() => { old?.cleanup?.(); slots[index].cleanup = effect() }) } },
    render(params) { cursor = 0; effects = []; globalThis.__nativeReaderHook = this; const result = hook(params); effects.forEach((f) => f()); return result },
    close() { slots.forEach((slot) => slot?.cleanup?.()) }
  }
}
try {
  const mocks = {
    react: `const h=()=>globalThis.__nativeReaderHook; export const useRef=(v)=>h().ref(v),useState=(v)=>h().state(v),useEffect=(f,d)=>h().effect(f,d),useCallback=(f,d)=>h().callback(f,d),useId=()=>h().id;`,
    '../api': 'export const api={documentRead(){throw Error("ordinary reader transport must not run")}};',
    '../store': 'export const useApp=(s)=>s(globalThis.__nativeReaderStore); useApp.getState=()=>globalThis.__nativeReaderStore;'
  }
  const entry = join(directory, 'entry.ts'), bundle = join(directory, 'bundle.mjs')
  writeFileSync(entry, `export * from '${absolute('src/renderer/src/reader/use-document-reader.ts')}'; export {readerSlice} from '${absolute('src/renderer/src/store/slices/reader.ts')}';`)
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'hook-boundaries', setup(b) { b.onResolve({ filter: /.*/ }, (a) => Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'mock' } : undefined); b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({ contents: mocks[a.path], loader: 'js' })) } }] })
  const m = await import(pathToFileURL(bundle).href)
  globalThis.__nativeReaderStore = { snapshot: null }
  const set = (update) => { const next = typeof update === 'function' ? update(globalThis.__nativeReaderStore) : update; Object.assign(globalThis.__nativeReaderStore, next) }
  Object.assign(globalThis.__nativeReaderStore, m.readerSlice(set))
  const seed = doc('A'), params = { workspaceId: 'native-owned', relativePath, initialDocument: seed, transport }
  const one = host('native-one', m.useDocumentReader), two = host('native-two', m.useDocumentReader)
  one.render(params)
  const firstRead = take('read'), firstWatch = take('watch')
  let reader = one.render(params)
  check('native seeded exact A is readable before any current read completes', reader.displayedText === seed.rawText && reader.doc.fixedVersion.token === seed.fixedVersion.token && !reader.loading)
  firstWatch.resolve({ ok: true, canonicalPath: `${root}/${relativePath}`, watchId: 'lease-one' })
  firstRead.resolve(doc('B')); await tick(); reader = one.render(params)
  check('initial current B becomes a candidate without replacing displayed A or descriptor', reader.pendingUpdate && reader.session.latest.revision === 'B' && reader.session.displayed.revision === 'A' && reader.doc.fixedVersion.token === seed.fixedVersion.token)
  two.render(params); take('read').reject(new Error('project switched')); take('watch').resolve({ ok: false, error: 'source inactive' }); await tick()
  const other = two.render(params)
  check('independent native view survives source switch/read failure with exact A', other.displayedText === seed.rawText && other.key !== reader.key && other.requestError === 'project switched')
  reader.reload(); take('read').resolve(doc('C')); await tick(); reader = one.render(params)
  check('repeated AI saves retain displayed A while latest advances to C', reader.displayedText === seed.rawText && reader.session.latest.revision === 'C')
  reader.openDiff('pending'); const diff = take('diff')
  check('native diff uses sender-bound transport with explicit displayed and candidate sides', diff.args[1].baseline.side.revision === 'A' && diff.args[1].current.revision === 'C')
  diff.resolve({ ok: true, diff: null, diagnostics: [] }); await tick()
  const apply = reader.applyNewVersion(); take('read').resolve(doc('C')); check('explicit native update succeeds', await apply)
  reader = one.render(params)
  check('adopting native C updates descriptor/body while preserving original base A', reader.displayedText === doc('C').rawText && reader.doc.fixedVersion.token === doc('C').fixedVersion.token && reader.session.base.revision === 'A' && two.render(params).displayedText === seed.rawText)
  one.close(); await tick()
  check('one view releases its exact lease while the other view state remains intact', pending.unwatch.length === 1 && pending.unwatch[0][1] === 'lease-one' && two.render(params).session.displayed.revision === 'A')
  two.close()
  check('last view close cleans only its own retained reading state', Object.keys(globalThis.__nativeReaderStore.readingSessions).length === 0)
  const absent = host('absent-source', m.useDocumentReader); absent.render(params)
  take('read').resolve({ ...doc(null), revision: null, rawText: null, diagnostics: [{ code: 'file_missing', severity: 'neutral', message: 'source deleted' }] }); take('watch').resolve({ ok: false, error: 'unavailable' }); await tick()
  check('missing initial live source retains seed and explicit unavailable notice', absent.render(params).displayedText === seed.rawText && absent.render(params).unreadableNotice === 'source deleted')
  absent.close()
  console.log(`Native reading hook: ${count} checks passed; DOM/native gates not exercised`)
} finally { delete globalThis.__nativeReaderHook; delete globalThis.__nativeReaderStore; rmSync(directory, { recursive: true, force: true }) }
