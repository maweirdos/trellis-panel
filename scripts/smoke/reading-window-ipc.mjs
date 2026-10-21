/** Execute actual doc/document/window IPC handlers with real files/materials/watch leases.
 * Electron ownership is simulated: this does not prove real native window behavior. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tpanel-reader-ipc-')))
const root = join(directory, 'project'), other = join(directory, 'other'), relativePath = '.trellis/tasks/demo/prd.md'
mkdirSync(join(root, '.trellis/tasks/demo'), { recursive: true }); mkdirSync(other)
writeFileSync(join(root, '.trellis/tasks/demo/task.json'), '{"id":"demo-task"}')
writeFileSync(join(root, relativePath), '# A\nOriginal body.\n')
const fixture = { root, generation: 1, windows: new Map(), handlers: new Map(), listeners: new Map(), events: [], opened: [], showMain: 0 }
globalThis.__readerIpc = fixture
const absolute = (file) => resolve(file).replace(/\\/g, '/')
const emitter = (id) => Object.assign(new EventEmitter(), { id })
const windowFor = (id) => { const window = { sender: emitter(id), pinned: true, minimized: 0, maximized: false, closed: 0, hidden: 0, isDestroyed: () => false, isAlwaysOnTop() { return this.pinned }, setAlwaysOnTop(value) { this.pinned = value }, isMaximized() { return this.maximized }, minimize() { this.minimized++ }, maximize() { this.maximized = true }, unmaximize() { this.maximized = false }, close() { this.closed++ }, hide() { this.hidden++ }, getBounds: () => ({ x: -1800, y: 0, width: 1200, height: 800 }), webContents: { send: (...args) => fixture.events.push(args) } }; fixture.windows.set(id, window); return window }
const main = windowFor(1), unrelated = windowFor(99)
let count = 0, m
const check = (name, value) => { assert.ok(value, name); count++; console.log(`PASS ${name}`) }
try {
  const mocks = {
    electron: `const f=globalThis.__readerIpc; export const ipcMain={handle:(c,h)=>f.handlers.set(c,h),on:(c,h)=>f.listeners.set(c,h)}; export const BrowserWindow={fromWebContents:(s)=>f.windows.get(s.id),getFocusedWindow:()=>{throw Error('focused window fallback forbidden')}}; export const screen={};`,
    '../state': `const f=globalThis.__readerIpc; export const getProjectRoot=()=>f.root,getProjectGeneration=()=>f.generation,getSnapshot=()=>f.snapshot??({meta:{root:f.root},tasks:[{dirName:'demo',path:f.root+'/.trellis/tasks/demo'}],archived:[]}),openProjectAt=(root)=>{f.root=root;f.generation++;return {ok:true}},pushFocusTask=()=>{};`,
    '../services/acp': `export const listAcpSessions=()=>({ok:true,sessions:globalThis.__readerIpc.sessions??[{sessionId:'origin-session',connectionGeneration:'generation-a'}]}); export const getAcpHistorySession=async()=>({ok:false,error:'not found'});`,
    '../services/bridge': 'export const broadcastToWindows=()=>{};'
  }
  const entry = join(directory, 'entry.ts'), bundle = join(directory, 'bundle.mjs')
  writeFileSync(entry, [
    `export {registerDocsIpc} from '${absolute('src/main/ipc/docs.ts')}'`,
    `export {registerDocumentsIpc} from '${absolute('src/main/ipc/documents.ts')}'`,
    `export {registerWindowIpc} from '${absolute('src/main/ipc/window.ts')}'`,
    `export {getDocumentViews} from '${absolute('src/main/services/document-views.ts')}'`,
    `export {invalidateDocument,clearReaderDocuments,stopDiffWorker} from '${absolute('src/main/services/documents/index.ts')}'`
  ].join('\n'))
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', banner: { js: "import {createRequire} from 'module'; const require=createRequire(import.meta.url);" }, plugins: [{ name: 'ipc-boundaries', setup(b) { b.onResolve({ filter: /.*/ }, (a) => Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'mock' } : undefined); b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({ contents: mocks[a.path], loader: 'js' })) } }] })
  m = await import(pathToFileURL(bundle).href)
  const deps = { getMain: () => main, getCapsule: () => null, getQuickTodo: () => null, showMain: () => { fixture.showMain++; fixture.onShowMain?.() }, createMain() {}, capsule: {}, isDocWindowSender: (id) => fixture.opened.some((item) => item.senderId === id), openDocWindow(options) {
    const old = fixture.opened.find((item) => item.key === options.key)
    if (old) return { ok: true, focused: true }
    const senderId = 100 + fixture.opened.length
    const win = windowFor(senderId)
    fixture.opened.push({ ...options, senderId, win }); options.onCreated?.(senderId)
    return { ok: true }
  } }
  m.registerDocsIpc(deps); m.registerDocumentsIpc(); m.registerWindowIpc(deps)
  const call = (channel, id, ...args) => { const handler = fixture.handlers.get(channel); assert.ok(handler, `registered ${channel}`); return handler({ sender: fixture.windows.get(id).sender }, ...args) }
  const send = (channel, id) => fixture.listeners.get(channel)({ sender: fixture.windows.get(id).sender })
  const scope = { workspaceId: 'UI-cache', taskRef: 'not-authorization' }
  const a = await call('document:read', 1, scope, { relativePath, requestId: 'read-A' })
  check('ordinary main reader captures fixed A before delivering read response', a.ok && a.fixedVersion && a.rawText.includes('Original body.'))
  writeFileSync(join(root, relativePath), '# B\nCurrent agent save.\n'); m.invalidateDocument(join(root, relativePath))
  const opened = await call('doc:open-version', 1, { token: a.fixedVersion.token, origin: { taskDir: 'demo', sessionId: 'origin-session' } })
  check('opening A passes opaque view registry and source display anchor into native manager', opened.ok && fixture.opened.length === 1 && fixture.opened[0].readerViewId === opened.viewId && fixture.opened[0].file === '' && fixture.opened[0].anchorBounds.x < 0)
  const nativeId = fixture.opened[0].senderId, boot = await call('doc:view-bootstrap', nativeId)
  check('native bootstrap returns selected A after disk B and normalized exact origin', boot.ok && boot.document.rawText === a.rawText && boot.origin.sessionId === 'origin-session' && boot.origin.taskDir.replace(/\\/g, '/').endsWith('/.trellis/tasks/demo'))
  check('foreign sender cannot bootstrap another view', !(await call('doc:view-bootstrap', 99)).ok)
  const sourceState = await call('doc:source-state', nativeId)
  check('source-state is sender-bound and returns only the active boolean', sourceState.ok && sourceState.sourceActive && Object.keys(sourceState).sort().join(',')==='ok,sourceActive' && !(await call('doc:source-state',99)).ok && !(await call('doc:source-state',nativeId,{viewId:'foreign'})).ok)
  const alias=join(directory,'project-alias');symlinkSync(root,alias,process.platform==='win32'?'junction':'dir')
  fixture.root=alias
  check('same physical source through actual directory alias remains active at original generation', (await call('doc:source-state',nativeId)).sourceActive===true)
  fixture.root=root
  const nativeScope = { workspaceId: boot.document.source.workspaceId }
  const current = await call('doc:view-current', nativeId, nativeScope, { relativePath, requestId: 'candidate-B' })
  check('registered native live read captures B as separately addressable version', current.ok && current.fixedVersion.token !== a.fixedVersion.token && current.rawText.includes('Current agent save.'))
  check('native read rejects unrelated source path', !(await call('doc:view-current', nativeId, nativeScope, { relativePath: '.trellis/tasks/demo/task.json', requestId: 'foreign-path' })).ok)
  const watched = await call('doc:view-watch', nativeId, nativeScope, { relativePath, knownRevision: current.revision })
  check('native watch obtains genuine bounded-controller owner lease', watched.ok && typeof watched.watchId === 'string')
  check('another window cannot change pin for focused document', !(await call('doc:setPin', 99, false)).ok && fixture.windows.get(nativeId).pinned)
  const pin = await call('doc:setPin', nativeId, false)
  check('pin acknowledgement comes from sender-owned window', pin.ok && pin.pinned === false && !fixture.windows.get(nativeId).pinned && unrelated.pinned)
  send('win:minimize', nativeId); send('win:maximize', nativeId); send('win:close', nativeId)
  check('native minimize/maximize/close affect sender despite unrelated focus', fixture.windows.get(nativeId).minimized === 1 && fixture.windows.get(nativeId).maximized && fixture.windows.get(nativeId).closed === 1 && unrelated.closed === 0 && main.hidden === 0)
  send('win:close', 1); check('main close-to-tray compatibility remains sender-bound', main.hidden === 1)
  check('unknown origin session is rejected without opening guessed latest chat', !(await call('doc:open-version', 1, { token: a.fixedVersion.token, origin: { sessionId: 'invented' } })).ok && fixture.opened.length === 1)
  const second = await call('doc:open-version', 1, { token: a.fixedVersion.token })
  check('explicit second view of same fixed source has independent view ownership', second.ok && second.viewId !== opened.viewId && fixture.opened.length === 2)
  fixture.root = other; fixture.generation++
  check('source-state becomes inactive on real project change', (await call('doc:source-state',nativeId)).sourceActive===false)
  check('project switch rejects old native current read and capture, retains fixed A bootstrap', !(await call('doc:view-current', nativeId, nativeScope, { relativePath, requestId: 'switched' })).ok && !(await call('doc:capture-version', nativeId, relativePath)).ok && (await call('doc:view-bootstrap', nativeId)).document.rawText === a.rawText)
  const returned = await call('doc:return-origin', nativeId)
  check('return opens original project and dispatches recorded session/task only', returned.ok && fixture.root === root && fixture.showMain === 1 && fixture.events.at(-1)[0] === 'doc:origin-return' && fixture.events.at(-1)[1].sessionId === 'origin-session')
  check('away/back return cannot reactivate a retained old view generation', (await call('doc:source-state',nativeId)).sourceActive===false)
  check('old live generation stays fenced even after switching project away and back', !(await call('doc:view-current', nativeId, nativeScope, { relativePath, requestId: 'reentered' })).ok)
  await call('doc:view-unwatch', nativeId, watched.canonicalPath, watched.watchId)
  const beforeLegacy = fixture.opened.length
  const legacyA = await call('doc:open', 1, { key: 'same-client-key', title: 'PRD', file: join(root, relativePath) })
  const legacyB = await call('doc:open', 1, { key: 'same-client-key', title: 'Task JSON', file: join(root, '.trellis/tasks/demo/task.json') })
  check('legacy IssuePeek path opens safe modern reader; client key cannot collide sources', legacyA.ok && legacyB.ok && fixture.opened.length === beforeLegacy + 2 && fixture.opened.at(-1).key !== fixture.opened.at(-2).key && fixture.opened.at(-1).readerViewId)
  const repeat = await call('doc:open', 1, { key: 'different-client-key', title: 'PRD', file: join(root, relativePath) })
  check('legacy repeated source focuses previous view without leaking a new registry owner', repeat.ok && repeat.focused && fixture.opened.length === beforeLegacy + 2)
  fixture.sessions=[]
  const beforeMissing=fixture.events.length
  check('return revalidates removed original session without dispatching a guessed target', !(await call('doc:return-origin',nativeId)).ok&&fixture.events.length===beforeMissing)
  fixture.sessions=[{sessionId:'origin-session',connectionGeneration:'generation-a'}]
  const withGeneration=await call('doc:open-version',1,{token:a.fixedVersion.token,origin:{sessionId:'origin-session',connectionGeneration:'generation-a'}})
  const generationId=fixture.opened.at(-1).senderId
  check('origin capture rejects a session generation that is already stale',withGeneration.ok&&!(await call('doc:open-version',1,{token:a.fixedVersion.token,origin:{sessionId:'origin-session',connectionGeneration:'old-generation'}})).ok)
  fixture.sessions=[{sessionId:'origin-session',connectionGeneration:'generation-b'}]
  check('return rejects a replacement session connection instead of following latest generation',!(await call('doc:return-origin',generationId)).ok)
  fixture.sessions=[{sessionId:'origin-session',connectionGeneration:'generation-a'}]
  const beforeRace=fixture.events.length
  fixture.onShowMain=()=>{fixture.root=other;fixture.generation++}
  check('project switch during showMain prevents late origin return publication',!(await call('doc:return-origin',nativeId)).ok&&fixture.events.length===beforeRace)
  delete fixture.onShowMain;fixture.root=root;fixture.generation++
  const archivedDir=join(root,'.trellis/tasks/archive/2026-10/demo');mkdirSync(join(root,'.trellis/tasks/archive/2026-10'),{recursive:true})
  renameSync(join(root,'.trellis/tasks/demo'),archivedDir)
  fixture.snapshot={meta:{root},tasks:[],archived:[{dirName:'demo',path:archivedDir}]}
  const taskOnlyId=fixture.opened[1].senderId
  const archiveReturn=await call('doc:return-origin',taskOnlyId)
  check('stable original task ref resolves its unique archived directory at return',archiveReturn.ok&&fixture.events.at(-1)[1].taskDir===archivedDir)
  const afterArchive=await call('doc:open-version',1,{token:a.fixedVersion.token})
  check('opening an old fixed version after archive resolves stored task identity without disk fallback',afterArchive.ok&&(await call('doc:view-bootstrap',fixture.opened.at(-1).senderId)).document.rawText===a.rawText)
  const copy=join(root,'.trellis/tasks/copied-demo');mkdirSync(copy);writeFileSync(join(copy,'task.json'),'{"id":"demo-task"}')
  const ambiguousId=fixture.opened[1].senderId
  fixture.snapshot.archived.push({dirName:'copied-demo',path:copy})
  check('ambiguous moved-task IDs are rejected without selecting a same-name replacement',!(await call('doc:return-origin',ambiguousId)).ok)
  m.getDocumentViews().closeView(opened.viewId)
  check('closed native view cannot query any source affinity', !(await call('doc:source-state',nativeId)).ok)
  console.log(`Reading window IPC: ${count} checks passed; Electron/OS window operations simulated`)
} finally { m?.clearReaderDocuments(); m?.stopDiffWorker(); delete globalThis.__readerIpc; rmSync(directory, { recursive: true, force: true }) }

