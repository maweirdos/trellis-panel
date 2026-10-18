/** Actual hook with deferred IPC + real reader slice; no native/model success is inferred. */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-document-reader-'))
const absolute = (path) => resolve(path).replace(/\\/g, '/')
const reactFile = join(directory, 'react.mjs')
const apiFile = join(directory, 'api.mjs')
const storeFile = join(directory, 'store.mjs')
writeFileSync(reactFile, `
const h = () => globalThis.__readerHooks;
export const useRef = (value) => h().ref(value);
export const useState = (value) => h().state(value);
export const useEffect = (effect, deps) => h().effect(effect, deps);
export const useCallback = (callback, deps) => h().callback(callback, deps);
export const useId = () => h().id;
`)
writeFileSync(apiFile, 'export const api = globalThis.__readerApi;')
writeFileSync(storeFile, `export const useApp = (selector) => selector(globalThis.__readerStore); useApp.getState = () => globalThis.__readerStore;`)
const entry = join(directory, 'entry.ts')
writeFileSync(entry, [
  `export { useDocumentReader } from '${absolute('src/renderer/src/reader/use-document-reader.ts')}'`,
  `export { readerSlice } from '${absolute('src/renderer/src/store/slices/reader.ts')}'`,
  `export * from '${absolute('src/renderer/src/reader/document-session-hub.ts')}'`,
  `export * from '${absolute('src/renderer/src/reader/reader-owner.ts')}'`,
  `export * from '${absolute('src/renderer/src/reader/reader-paths.ts')}'`,
  `export * from '${absolute('src/renderer/src/acp/artifacts.ts')}'`
].join('\n'))

let checks = 0
function check(name, value) { assert.ok(value, name); checks++; console.log(`  ✓ ${name}`) }
const pending = { read: [], watch: [], diff: [], unwatch: [] }
let watchSequence = 0
let mainWatchGeneration = 0
const mainWatches = new Map()
const clearMainWatches = () => { mainWatchGeneration++; mainWatches.clear() }
function request(kind, args) {
  return new Promise((resolvePromise, reject) => pending[kind].push({ args, resolve: resolvePromise, reject }))
}
globalThis.__readerApi = {
  documentRead: (...args) => request('read', args),
  documentWatch: (...args) => {
    const watchId = `watch-${mainWatchGeneration}-${++watchSequence}`
    const canonicalPath = `${root}/${args[1].relativePath}`
    mainWatches.set(watchId, { canonicalPath, generation: mainWatchGeneration })
    return new Promise((resolvePromise, reject) => pending.watch.push({ args, watchId, canonicalPath,
      resolve: (result) => resolvePromise(result.ok ? { ...result, watchId } : result),
      resolveWithoutLease: resolvePromise, reject
    }))
  },
  documentDiff: (...args) => request('diff', args),
  documentUnwatch: (path, watchId) => {
    pending.unwatch.push({ canonicalPath: path, watchId })
    const lease = mainWatches.get(watchId)
    if (lease?.canonicalPath === path && lease.generation === mainWatchGeneration) mainWatches.delete(watchId)
    return Promise.resolve()
  },
  readTextFile: () => Promise.resolve({ ok: true, content: 'legacy' })
}
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const sameDeps = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
function makeHooks(id, hook) {
  const slots = []; let cursor = 0; let effects = []; let result
  const harness = {
    id,
    ref(value) { const index = cursor++; slots[index] ??= { current: value }; return slots[index] },
    state(value) { const index = cursor++; slots[index] ??= { value: typeof value === 'function' ? value() : value }; return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }] },
    callback(callback, deps) { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { callback, deps }; return slots[index].callback },
    effect(effect, deps) { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) { const old = slots[index]; slots[index] = { deps }; effects.push(() => { old?.cleanup?.(); slots[index].cleanup = effect() }) } },
    render(params) { cursor = 0; effects = []; globalThis.__readerHooks = harness; result = hook(params); for (const effect of effects) effect(); return result },
    unmount() { for (const slot of slots) slot?.cleanup?.() }
  }
  return harness
}
const root = 'D:/reader-fixture'
const path = '.trellis/tasks/demo/prd.md'
const scope = { workspaceId: root, projectRoot: root, taskRef: 'demo', relativePath: path }
function document(revision, rawText = `# ${revision}\n`, relativePath = path) {
  return { ok: true, requestId: 'test', revision, rawText, diagnostics: [], parsed: null,
    source: { canonicalPath: `${root}/${relativePath}`, relativePath, workspaceId: root, taskRef: 'demo', sizeBytes: rawText?.length ?? null, mtimeMs: 1 } }
}
function shifted(kind) { const value = pending[kind].shift(); assert.ok(value, `${kind} request exists`); return value }

try {
  const bundle = join(directory, 'bundle.mjs')
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{
    name: 'hook-boundaries', setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: reactFile }))
      builder.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: apiFile }))
      builder.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: storeFile }))
    }
  }] })
  const m = await import(pathToFileURL(bundle).href)
  globalThis.__readerStore = { snapshot: { meta: { root } } }
  const set = (update) => { const next = typeof update === 'function' ? update(globalThis.__readerStore) : update; globalThis.__readerStore = { ...globalThis.__readerStore, ...next } }
  Object.assign(globalThis.__readerStore, m.readerSlice(set))

  const host = makeHooks('owner-a', m.useDocumentReader)
  host.render(scope)
  shifted('read').resolve(document('A'))
  await tick()
  shifted('watch').resolve({ ok: true, canonicalPath: `${root}/${path}` })
  await tick()
  let current = host.render(scope)
  check('actual hook establishes displayed A and a first-open baseline', current.displayedText === '# A\n' && current.session.base.revision === 'A')
  const other = makeHooks('owner-b', m.useDocumentReader)
  other.render(scope)
  shifted('read').resolve(document('B'))
  await tick()
  shifted('watch').resolve({ ok: true, canonicalPath: `${root}/${path}` })
  await tick()
  const second = other.render(scope)
  current = host.render(scope)
  check('same task/file in another host has independent baseline without resetting A', current.key !== second.key && current.session.base.revision === 'A' && second.session.base.revision === 'B')
  other.unmount()
  current = host.render(scope)
  check('closing another host cannot delete this host baseline', current.session.base.revision === 'A' && Object.keys(globalThis.__readerStore.readingSessions).length === 1)

  current.reload(); const firstChange = shifted('read')
  current.reload(); const lastChange = shifted('read')
  lastChange.resolve(document('C')); await tick(); firstChange.resolve(document('B')); await tick()
  current = host.render(scope)
  check('overlapping external reads keep displayed A and only newest candidate C', current.session.displayed.revision === 'A' && current.session.latest.revision === 'C')
  current.openDiff('pending'); const diff1 = shifted('diff')
  current.openDiff('git-latest-commit'); const diff2 = shifted('diff')
  diff2.resolve({ ok: true, marker: 'new' }); await tick(); diff1.resolve({ ok: true, marker: 'old' }); await tick()
  current = host.render(scope)
  check('older diff completion cannot overwrite a newer comparison', current.diff.mode === 'git-latest-commit' && current.diff.outcome.marker === 'new')
  current.closeDiff()
  const apply = current.applyNewVersion(); const applyRead = shifted('read')
  current.reload(); const newerObservation = shifted('read')
  newerObservation.resolve(document('D')); await tick(); applyRead.resolve(document('C')); await apply
  current = host.render(scope)
  check('an old apply cannot erase a newer observed candidate', current.session.displayed.revision === 'A' && current.session.latest.revision === 'D')
  const applyLatest = current.applyNewVersion(); shifted('read').resolve(document('D')); check('explicit current apply succeeds', await applyLatest)
  current = host.render(scope)
  check('explicit read-new updates displayed while preserving original baseline', current.session.displayed.revision === 'D' && current.session.base.revision === 'A' && current.session.latest === null)

  current.reload(); shifted('read').resolve({ ...document(null, null), diagnostics: [{ code: 'file_missing', severity: 'neutral', message: '文件已移除' }] }); await tick()
  current = host.render(scope)
  check('deleted/unreadable file preserves displayed bytes and reports facts', current.displayedText === '# D\n' && current.unreadableNotice === '文件已移除')
  current.reload(); shifted('read').reject(new Error('read failed')); await tick()
  current = host.render(scope)
  check('reload failure retains the first-open baseline and displayed version', current.session.base.revision === 'A' && current.session.displayed.revision === 'D' && current.requestError === 'read failed')

  const oldApply = current.applyNewVersion(); const oldRead = shifted('read')
  const pathB = '.trellis/tasks/demo/design.md'
  host.render({ ...scope, relativePath: pathB }); const readB = shifted('read')
  host.render(scope); const reopenedA = shifted('read')
  reopenedA.resolve(document('E')); await tick(); shifted('watch').resolve({ ok: true, canonicalPath: `${root}/${path}` }); await tick()
  oldRead.resolve(document('OLD')); readB.resolve(document('B', '# B', pathB)); await tick(); await oldApply
  current = host.render(scope)
  check('A -> B -> A rejects old apply and old B read even after returning to A', current.session.displayed.revision === 'E' && current.session.base.revision === 'E')
  current.openDiff('git-latest-commit'); const closedDiff = shifted('diff'); current.closeDiff(); closedDiff.resolve({ ok: true, marker: 'late' }); await tick()
  check('closing comparison invalidates its pending response', host.render(scope).diff === null)
  current = host.render(scope)
  current.reload(); const rootRead = shifted('read')
  globalThis.__readerStore.snapshot.meta.root = 'D:/other-project'
  rootRead.resolve(document('FOREIGN')); await tick()
  check('root switch rejects a pending read', host.render(scope).session.displayed.revision === 'E')
  host.unmount()
  check('host close discards only its own snapshots', Object.keys(globalThis.__readerStore.readingSessions).length === 0)

  globalThis.__readerStore.snapshot.meta.root = root
  const recovery = makeHooks('recovery', m.useDocumentReader)
  recovery.render(scope); shifted('read').reject(new Error('initial unavailable')); await tick()
  let recovered = recovery.render(scope)
  check('initial IPC failure is surfaced rather than an unhandled rejection', recovered.requestError === 'initial unavailable' && !recovered.loading)
  recovered.reload(); shifted('read').resolve(document('RECOVERED')); await tick()
  shifted('watch').resolve({ ok: true, canonicalPath: `${root}/${path}` }); await tick()
  recovered = recovery.render(scope)
  check('retry after initial failure establishes a baseline and a real watch', recovered.session.displayed.revision === 'RECOVERED' && recovered.requestError === null)
  recovery.unmount()

  const lateWatch = makeHooks('late-watch', m.useDocumentReader)
  lateWatch.render(scope); shifted('read').resolve(document('LATE')); await tick()
  const watchCompletion = shifted('watch')
  const previousUnwatches = pending.unwatch.length
  lateWatch.unmount(); watchCompletion.resolve({ ok: true, canonicalPath: `${root}/${path}` }); await tick()
  check('a watch acknowledged after host close is immediately released by its exact lease', pending.unwatch.length === previousUnwatches + 1 && pending.unwatch.at(-1).watchId === watchCompletion.watchId && !mainWatches.has(watchCompletion.watchId) && Object.keys(globalThis.__readerStore.readingSessions).length === 0)

  const oldProject = makeHooks('old-project-a', m.useDocumentReader)
  oldProject.render(scope); shifted('read').resolve(document('OLD-A')); await tick()
  const oldProjectAck = shifted('watch')
  oldProject.unmount()
  globalThis.__readerStore.snapshot.meta.root = 'D:/project-b'
  clearMainWatches()
  globalThis.__readerStore.snapshot.meta.root = root
  const newProject = makeHooks('new-project-a', m.useDocumentReader)
  newProject.render(scope); shifted('read').resolve(document('NEW-A')); await tick()
  const newProjectAck = shifted('watch')
  newProjectAck.resolve({ ok: true, canonicalPath: `${root}/${path}` }); await tick()
  oldProjectAck.resolve({ ok: true, canonicalPath: `${root}/${path}` }); await tick()
  check('project clear then delayed old A acknowledgement cannot release new A watch', mainWatches.has(newProjectAck.watchId) && !mainWatches.has(oldProjectAck.watchId) && pending.unwatch.at(-1).watchId === oldProjectAck.watchId)
  if (mainWatches.has(newProjectAck.watchId)) m.receiveDocumentChanged({ canonicalPath: `${root}/${path}`, relativePath: path, revision: 'NEW-A-2' })
  shifted('read').resolve(document('NEW-A-2')); await tick()
  check('new A owner continues receiving updates after stale acknowledgement cleanup', newProject.render(scope).session.latest.revision === 'NEW-A-2')
  const samePathOwner = makeHooks('same-path-owner', m.useDocumentReader)
  samePathOwner.render(scope); shifted('read').resolve(document('OTHER-A')); await tick()
  const samePathAck = shifted('watch')
  samePathAck.resolve({ ok: true, canonicalPath: `${root}/${path}` }); await tick()
  const releaseCount = pending.unwatch.length
  newProject.unmount(); newProject.unmount(); await tick()
  check('duplicate cleanup releases its lease once and preserves another same-path owner', pending.unwatch.length === releaseCount + 1 && !mainWatches.has(newProjectAck.watchId) && mainWatches.has(samePathAck.watchId))
  samePathOwner.unmount()
  check('each owner releases only its own registration', !mainWatches.has(samePathAck.watchId) && mainWatches.size === 0)

  const missingToken = makeHooks('missing-token', m.useDocumentReader)
  missingToken.render(scope); shifted('read').resolve(document('TOKENLESS')); await tick()
  const missingTokenAck = shifted('watch')
  missingTokenAck.resolveWithoutLease({ ok: true, canonicalPath: `${root}/${path}` }); await tick()
  const tokenlessReleaseCount = pending.unwatch.length
  check('a malformed watch acknowledgement is reported without a path-only release', missingToken.render(scope).requestError.includes('注册标识'))
  missingToken.unmount(); await tick()
  check('cleanup cannot substitute an unowned canonical-path release', pending.unwatch.length === tokenlessReleaseCount)
  clearMainWatches()

  const foreign = makeHooks('foreign-source', m.useDocumentReader)
  foreign.render(scope); shifted('read').resolve({ ...document('FOREIGN'), source: { ...document('FOREIGN').source, canonicalPath: 'D:/other-project/prd.md' } }); await tick()
  const rejected = foreign.render(scope)
  check('modern read from a different canonical root cannot establish a document or watch', rejected.doc === null && rejected.session === undefined && rejected.requestError.includes('不一致') && pending.watch.length === 0)
  foreign.unmount()

  const mixedCase = makeHooks('mixed-case-root', m.useDocumentReader)
  const mixedCaseScope = { ...scope, projectRoot: 'd:/READER-FIXTURE' }
  mixedCase.render(mixedCaseScope); shifted('read').resolve(document('WINDOWS-CASE')); await tick()
  check('actual reader accepts canonical Windows root case without accepting a foreign project', mixedCase.render(mixedCaseScope).session?.displayed?.revision === 'WINDOWS-CASE')
  shifted('watch').resolve({ ok: true, canonicalPath: `${root}/${path}` }); await tick(); mixedCase.unmount()
  check('Windows drive and UNC path boundaries preserve relative spelling and reject sibling roots', m.relativePathUnderRoot('d:/WORK/PROJ', 'D:\\work\\proj\\PRD.md') === 'PRD.md' && m.relativePathUnderRoot('\\\\SERVER\\SHARE\\Project', '//server/share/project/PRD.md') === 'PRD.md' && m.relativePathUnderRoot('D:/work/proj', 'd:/WORK/PROJECT/file.md') === null)
  check('principal full-path comparison accepts Windows case/separators while retaining POSIX case and exact hierarchy', m.sameRelativeDocumentPath(root, '.trellis\\tasks\\demo\\PRD.md', '.trellis/tasks/demo/prd.md') && !m.sameRelativeDocumentPath('/work/proj', '.trellis/tasks/demo/PRD.md', '.trellis/tasks/demo/prd.md') && !m.sameRelativeDocumentPath(root, '.trellis/tasks/demo/research/prd.md', '.trellis/tasks/demo/prd.md'))

  const descriptor = { projectRoot: root, taskDir: 'demo', relativePath: path, sessionId: 'panel-session', connectionGeneration: 'generation-1', displayed: { revision: 'actual-sha', text: '# Scope\n\nReal quoted text.\n' } }
  const source = m.captureDocumentReference({ ...descriptor, quote: 'Real quoted text.', sectionAnchor: 'scope' })
  check('source references capture exact displayed revision/session/generation/quote', source.displayedRevision === 'actual-sha' && source.targetSessionId === 'panel-session' && source.targetConnectionGeneration === 'generation-1' && source.sectionAnchor === 'scope')
  check('invented quotation or nonexistent section is rejected', m.captureDocumentReference({ ...descriptor, quote: 'made-up' }) === null && m.captureDocumentReference({ ...descriptor, sectionAnchor: 'wrong' }) === null)
  check('task path traversal and unrelated material are rejected', !m.isTaskMaterialPath('demo', '.trellis/tasks/demo/../../outside.md') && !m.isTaskMaterialPath('demo', '.trellis/tasks/other/prd.md'))
  const file = { kind: 'file', path: `${root}/${path}`, name: 'prd.md', mtime: 10, size: 10, ext: '.md' }
  const change = { projectRoot: root, taskDir: 'demo', projectGeneration: 1, relativePath: path, observedAt: 11, kind: 'change', revision: 'B', source: 'filesystem-event', availability: 'readable' }
  const artifacts = m.projectConversationArtifacts({ projectRoot: root, taskDir: 'demo', artifacts: [file], changes: [change, { ...change, observedAt: 12, revision: 'C' }, { ...change, projectRoot: 'D:/foreign', observedAt: 13 }] })
  check('actual saves deduplicate by exact material and reject foreign roots', artifacts.length === 1 && artifacts[0].observedRevision === 'C')
  const deleted = m.projectConversationArtifacts({ projectRoot: root, taskDir: 'demo', artifacts: [file], changes: [{ ...change, kind: 'unlink', availability: 'missing', revision: null }] })
  check('deletion remains an honest missing artifact rather than a success', deleted.length === 1 && deleted[0].availability === 'missing' && deleted[0].observedRevision === undefined)
  const prose = m.projectConversationArtifacts({ projectRoot: root, taskDir: 'demo', artifacts: [], events: [{ id: 'agent', ts: 10, projectRoot: root, taskDir: 'demo', source: 'acp', kind: 'message', text: 'I wrote prd.md' }] })
  check('assistant prose never creates an artifact', prose.length === 0)
  const forged = m.projectConversationArtifacts({ projectRoot: root, taskDir: 'demo', artifacts: [], events: [{ id: 'agent', ts: 10, projectRoot: root, taskDir: 'demo', source: 'acp', kind: 'message', payload: { materialChange: change } }] })
  const observed = m.projectConversationArtifacts({ projectRoot: root, taskDir: 'demo', artifacts: [], events: [{ id: 'watcher', ts: 10, projectRoot: root, taskDir: 'demo', source: 'trellis', kind: 'material-change', payload: { materialChange: change } }] })
  check('only first-party material events project verified file facts', forged.length === 0 && observed.length === 1 && observed[0].observedRevision === 'B')
  console.log(`ACP document reader: ${checks} checks passed`)
} finally {
  delete globalThis.__readerApi; delete globalThis.__readerHooks; delete globalThis.__readerStore
  rmSync(directory, { recursive: true, force: true })
}
