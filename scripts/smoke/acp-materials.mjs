/** Product material/binding/source guards. Owned files and diagnostic ACP process only. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'
const temporary = mkdtempSync(join(tmpdir(), 'trellis-acp-materials-'))
await prepareAcpHistoryWorker(temporary)
process.env.TPAP_SMOKE_DIR = temporary
process.env.TRELLIS_READER_SETTLE_MS = '0'
const root = join(temporary, 'project a')
const rootB = join(temporary, 'project b')
for (const project of [root, rootB]) for (const task of ['task-a', 'task-b']) {
  const directory = join(project, '.trellis', 'tasks', task)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'task.json'), JSON.stringify({ id: task, title: task, status: 'planning' }))
  writeFileSync(join(directory, 'prd.md'), `${project} ${task} requirements`)
}
const longBody = '\uFEFF' + '材料A🙂'.repeat(5000)
const prdPath = join(root, '.trellis', 'tasks', 'task-a', 'prd.md')
writeFileSync(prdPath, longBody)
const output = (channel) => (globalThis.__TPANEL_EVENTS__ ?? []).filter((event) => event.channel === channel).map((event) => event.payload)
const wait = async (predicate, label) => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 20)) }
  throw new Error(`Timeout: ${label}`)
}
const pauses = []
const nativeSetTimeout = globalThis.setTimeout
let service
try {
  const watcherMock = { name: 'owned-material-watcher', setup(builder) {
    builder.onResolve({ filter: /^\.\/services\/watcher$/ }, () => ({ path: 'watcher', namespace: 'material-mock' }))
    builder.onLoad({ filter: /.*/, namespace: 'material-mock' }, () => ({ loader: 'js', contents: `
      export class TrellisWatcher { start(root,onChange,onFile) { (globalThis.__MATERIAL_WATCHERS__??=[]).push({root,onChange,onFile}) } stop() {} }
    ` }))
  } }
  await build({ stdin: { contents: `export * from './src/main/services/acp';
    export {readDocument,computeRevision} from './src/main/services/documents/controller';
    export {verifyMaterialChange,eventTaskMaterial,preparePromptMaterials} from './src/main/services/acp/materials';
    export {utf8ByteLength,clipUtf8} from './src/shared/material-budget';
    export {openProjectAt,closeProjectAt,routeMaterialNotice,getProjectGeneration} from './src/main/state';
    export {watchReaderDocument,onReaderDocumentChanged} from './src/main/services/documents/change-bridge';`, loader: 'ts', resolveDir: process.cwd() },
    bundle: true, format: 'esm', platform: 'node', banner: { js: "import {createRequire as smokeRequire} from 'node:module';import {dirname as smokeDirname} from 'node:path';import {fileURLToPath as smokeFilePath} from 'node:url';const require=smokeRequire(import.meta.url);const __dirname=smokeDirname(smokeFilePath(import.meta.url));" },
    alias: { electron: resolve('scripts/smoke/mock-electron.mjs') }, plugins: [watcherMock], outfile: join(temporary, 'materials.mjs') })
  service = await import(pathToFileURL(join(temporary, 'materials.mjs')).href)
  const budgetRoot = join(temporary, 'budget project'), budgetPrefix = '.trellis/tasks/budget/'
  const budgetFiles = new Map()
  const putBudgetFile = (path, body) => { mkdirSync(join(budgetRoot, path, '..'), { recursive: true }); writeFileSync(join(budgetRoot, path), body); budgetFiles.set(path, Buffer.from(body)) }
  const budgetReference = (path) => ({ projectRoot: budgetRoot, taskDir: 'budget', relativePath: path, displayedRevision: service.computeRevision(budgetFiles.get(path)), targetSessionId: 'budget' })
  const enclosingLabel = readFileSync(resolve('src/main/services/acp.ts'), 'utf8').match(/\$\{instruction\}\\n\\n(\[[^\r\n]+?\])\$\{prepared\.text\}/)?.[1]
  assert.ok(enclosingLabel, 'Check the actual facade framing as well as file headers/notices')
  const framing = '\n\n' + enclosingLabel
  const principalPaths = ['prd.md', 'design.md', 'implement.md'].map((name) => budgetPrefix + name)
  putBudgetFile(principalPaths[0], 'PRD_BODY_MARKER' + '中'.repeat(20000))
  putBudgetFile(principalPaths[1], '<html><img src="data:image/png;base64,IMAGE_BODY_MARKER">HTML_BODY_MARKER</html>')
  putBudgetFile(principalPaths[2], '{"annotations":"JSON_BODY_MARKER","replay":"REPLAY_BODY_MARKER"}')
  const index = await service.preparePromptMaterials(budgetRoot, 'budget', [])
  assert.ok(Buffer.byteLength(framing + index.text) <= 8192)
  assert.deepEqual(index.files, [])
  for (const path of principalPaths) assert.ok(index.text.includes(`[Read on demand: ${path}]`))
  for (const marker of ['PRD_BODY_MARKER', 'HTML_BODY_MARKER', 'IMAGE_BODY_MARKER', 'JSON_BODY_MARKER', 'REPLAY_BODY_MARKER']) assert.ok(!index.text.includes(marker))
  const verifyBudgetSources = (prepared) => {
    assert.ok(Buffer.byteLength(framing + prepared.text) <= 24576)
    for (const source of prepared.sources) {
      const bytes = budgetFiles.get(source.relativePath), original = bytes.toString('utf8').replace(/^\uFEFF/, '')
      assert.equal(source.sourceRevision, service.computeRevision(bytes), 'Whole-file identity belongs to its exact path')
      assert.equal(source.sourceBytes, bytes.length)
      assert.deepEqual(source.extent, { start: 0, end: source.includedChars, unit: 'utf16-code-units' })
      const prefix = original.slice(0, source.includedChars)
      assert.equal(source.includedBytes, Buffer.byteLength(prefix))
      assert.equal(source.includedRevision, source.included ? service.computeRevision(Buffer.from(prefix)) : null)
      if (source.included) {
        const header = `\n\n--- ${source.relativePath} ---\n`, offset = prepared.text.indexOf(header)
        assert.ok(offset >= 0)
        assert.equal(prepared.text.slice(offset + header.length, offset + header.length + source.includedChars), prefix, 'Rendered prefix cannot acquire another file provenance')
        assert.ok(!/[\uD800-\uDBFF]$/.test(prefix))
      } else assert.equal(source.includedChars, 0)
      if (!source.included || source.truncated) assert.ok(prepared.text.includes(`[Read on demand: ${source.relativePath}]`) || prepared.text.includes(`[Truncated; read: ${source.relativePath}]`))
    }
    assert.deepEqual(prepared.files, prepared.sources.filter((source) => source.included).map((source) => source.relativePath))
  }
  verifyBudgetSources(index)
  for (const body of ['\uFEFF' + 'ASCII'.repeat(20000), '材料'.repeat(20000), '🙂🦊'.repeat(20000)]) {
    putBudgetFile(principalPaths[0], body)
    const prepared = await service.preparePromptMaterials(budgetRoot, 'budget', [budgetReference(principalPaths[0]), budgetReference(principalPaths[0])])
    verifyBudgetSources(prepared)
    const implicit = principalPaths.slice(1).map((path) => `\n[Read on demand: ${path}]\n`).join('')
    assert.ok(prepared.text.startsWith(implicit))
    assert.ok(Buffer.byteLength(framing + prepared.text.slice(implicit.length)) <= 16384)
    assert.equal(prepared.sources.filter((source) => source.relativePath === principalPaths[0]).length, 1)
    assert.equal(prepared.sources.find((source) => source.relativePath === principalPaths[0]).truncated, true)
    assert.equal(service.utf8ByteLength(body), Buffer.byteLength(body))
    for (const limit of [0, 1, 2, 3, 4, 7, 8192]) {
      const prefix = service.clipUtf8(body, limit)
      assert.ok(body.startsWith(prefix)); assert.ok(Buffer.byteLength(prefix) <= limit); assert.ok(!/[\uD800-\uDBFF]$/.test(prefix))
    }
  }
  const references = [...principalPaths, ...Array.from({ length: 5 }, (_, number) => `${budgetPrefix}source-${number}.md`)]
  references.forEach((path, number) => putBudgetFile(path, `FILE_${number}\n` + '中🙂A'.repeat(20000)))
  const packed = await service.preparePromptMaterials(budgetRoot, 'budget', references.map(budgetReference))
  verifyBudgetSources(packed)
  assert.ok(Buffer.byteLength(framing + packed.text) <= 16384)
  assert.equal(packed.sources.length, 8); assert.ok(packed.sources.some((source) => source.status === 'omitted'))
  const deep = Array.from({ length: 9 }, () => '中'.repeat(80)).join('/')
  const longPaths = Array.from({ length: 8 }, (_, number) => `${budgetPrefix}${deep}/source-${number}.md`)
  longPaths.forEach((path) => putBudgetFile(path, 'body'))
  await assert.rejects(service.preparePromptMaterials(budgetRoot, 'budget', longPaths.map(budgetReference)), /路径提示超过输入预算/)
  console.log('PASS implicit indexes, UTF-8 ASCII/CJK/emoji budgets, actual framing, source extents/digests and exact-path overflow')
  assert.equal(service.openProjectAt(root).ok, true)
  assert.equal(service.eventTaskMaterial(root, join(root, '.trellis', 'tasks', 'task-a', 'task.json')).taskDir, 'task-a')
  assert.equal(service.eventTaskMaterial(root, join(root, '.trellis', 'tasks', 'archive', '2026-10', 'task-a', 'prd.md')), null)
  const created = await service.newAcpSession(root, { agentId: 'mock', taskDir: 'task-a' })
  assert.equal(created.ok, true)
  const current = () => service.listAcpSessions(root).sessions.find((session) => session.sessionId === created.sessionId)
  await wait(() => current()?.status === 'ready', 'material session ready')
  const read = await service.readDocument(root, { workspaceId: root, taskRef: 'task-a' }, { relativePath: '.trellis/tasks/task-a/prd.md', requestId: 'display-a' })
  const reference = { projectRoot: root, taskDir: 'task-a', relativePath: '.trellis/tasks/task-a/prd.md', displayedRevision: read.revision,
    targetSessionId: created.sessionId, targetConnectionGeneration: current().connectionGeneration, sectionAnchor: 'requirements', quote: 'Review this source' }
  const sent = await service.promptAcpSession(root, created.sessionId, 'review exact displayed source', { sourceReferences: [reference] })
  assert.equal(sent.ok, true)
  const permission = await wait(() => output('acp:permission').find((event) => event.turnId === sent.turnId), 'source-bound permission')
  assert.equal((await service.bindAcpSessionTask(root, created.sessionId, { taskDir: 'task-b', expectedConnectionGeneration: current().connectionGeneration })).code, 'E_CONFLICT')
  service.respondAcpPermission(root, permission.requestId, 'reject')
  await wait(() => current().status === 'ready', 'source-bound completed')
  const included = current().materialSnapshot.sources.find((source) => source.relativePath === reference.relativePath)
  assert.equal(included.sourceRevision, read.revision)
  assert.equal(included.sourceRevision, service.computeRevision(readFileSync(prdPath)))
  assert.equal(included.includedRevision, service.computeRevision(Buffer.from(read.rawText.slice(0, included.includedChars))))
  assert.equal(included.truncated, true)
  assert.notEqual(included.sourceRevision, included.includedRevision)
  assert.equal(included.sourceBytes, Buffer.byteLength(longBody))
  assert.equal(included.extent.end, included.includedChars)
  assert.equal(current().materialSnapshot.sources.find((source) => source.relativePath.endsWith('design.md')).status, 'missing')
  const unchangedSnapshot = JSON.stringify(current().materialSnapshot)
  const unchangedTurn = current().turnId
  const eventsBefore = output('acp:output').length
  writeFileSync(prdPath, '# Revision B\n')
  const drift = await service.promptAcpSession(root, created.sessionId, 'draft stays unsent', { sourceReferences: [reference] })
  assert.equal(drift.code, 'E_CONFLICT'); assert.equal(drift.reason, 'SOURCE_CHANGED')
  assert.equal(drift.sources[0].expectedRevision, reference.displayedRevision)
  assert.equal(drift.sources[0].actualRevision, service.computeRevision(readFileSync(prdPath)))
  assert.equal(current().turnId, unchangedTurn)
  assert.equal(JSON.stringify(current().materialSnapshot), unchangedSnapshot)
  assert.equal(output('acp:output').length, eventsBefore)
  assert.equal(current().status, 'ready')
  for (const invalid of [ { ...reference, projectRoot: rootB }, { ...reference, taskDir: 'task-b' }, { ...reference, targetSessionId: 'other-session' }, { ...reference, relativePath: '.trellis/tasks/task-a/../../outside.md' } ]) {
    assert.equal((await service.promptAcpSession(root, created.sessionId, 'wrong source', { sourceReferences: [invalid] })).ok, false)
  }
  assert.equal((await service.promptAcpSession(root, created.sessionId, 'stale connection', { expectedConnectionGeneration: 'old' })).reason, 'SCOPE_CHANGED')
  console.log('PASS source references reject drift/foreign targets before a turn and capture exact source versus truncated included bytes')

  const oldEvent = current().events.find((event) => event.turnId === sent.turnId && event.kind === 'message')
  assert.equal(oldEvent.taskDir, 'task-a')
  assert.equal((await service.bindAcpSessionTask(rootB, created.sessionId, { taskDir: 'task-b', expectedConnectionGeneration: current().connectionGeneration })).code, 'E_DENIED')
  assert.equal((await service.bindAcpSessionTask(root, created.sessionId, { taskDir: 'task-b', expectedConnectionGeneration: 'stale' })).code, 'E_CONFLICT')
  assert.equal((await service.bindAcpSessionTask(root, created.sessionId, { taskDir: 'missing', expectedConnectionGeneration: current().connectionGeneration })).code, 'E_INVALID_ARG')
  const bind = await service.bindAcpSessionTask(root, created.sessionId, { taskDir: 'task-b', expectedConnectionGeneration: current().connectionGeneration })
  assert.equal(bind.ok, true)
  assert.equal(current().taskDir, 'task-b')
  assert.equal(oldEvent.taskDir, 'task-a')
  assert.equal(current().materialSnapshot.taskDir, 'task-a')
  const plain = await service.promptAcpSession(root, created.sessionId, 'legacy two-argument prompt remains valid')
  assert.equal(plain.ok, true)
  const plainPermission = await wait(() => output('acp:permission').find((event) => event.turnId === plain.turnId), 'plain permission')
  service.respondAcpPermission(root, plainPermission.requestId, 'reject')
  await wait(() => current().status === 'ready', 'plain completed')
  assert.equal(current().materialSnapshot.taskDir, 'task-b')
  assert.ok(current().materialSnapshot.files.every((path) => path.startsWith('.trellis/tasks/task-b/')))
  assert.equal((await service.bindAcpSessionTask(root, created.sessionId, { taskDir: null, expectedConnectionGeneration: current().connectionGeneration })).ok, true)
  assert.equal(current().taskDir, undefined)
  assert.equal(current().materialSnapshot.taskDir, 'task-b')
  const cancelPreparation = service.promptAcpSession(root, created.sessionId, 'cancel before dispatch')
  assert.equal((await service.cancelAcpSession(root, created.sessionId)).ok, true)
  assert.equal((await cancelPreparation).reason, 'SCOPE_CHANGED')
  const capturedGeneration = service.getProjectGeneration()
  const scopeRace = service.promptAcpSession(root, created.sessionId, 'old root request', undefined, () => service.getProjectGeneration() === capturedGeneration)
  service.openProjectAt(rootB); service.openProjectAt(root)
  assert.equal((await scopeRace).reason, 'SCOPE_CHANGED')
  assert.equal(current().status, 'ready')
  console.log('PASS idle task binding affects future material only; busy/stale/missing/foreign and root/cancel races do not dispatch')

  const outside = join(temporary, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'task.json'), '{}')
  writeFileSync(join(outside, 'prd.md'), 'Outside source')
  symlinkSync(outside, join(root, '.trellis', 'tasks', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await service.bindAcpSessionTask(root, created.sessionId, { taskDir: 'escape', expectedConnectionGeneration: current().connectionGeneration })).code, 'E_INVALID_ARG')
  assert.equal(await service.verifyMaterialChange(root, service.getProjectGeneration(), join(root, '.trellis', 'tasks', 'escape', 'prd.md'), 'change'), null)
  console.log('PASS junction material and task records cannot escape the open project')

  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = nativeSetTimeout(callback, delay, ...args)
    if (delay === 8000) pauses.push({ callback, timer })
    return timer
  }
  const changed = []
  const removeListener = service.onReaderDocumentChanged((event) => changed.push(event))
  const materialPath = join(root, '.trellis', 'tasks', 'task-b', 'implement.md')
  writeFileSync(materialPath, '# implementation A')
  const latestWatcher = globalThis.__MATERIAL_WATCHERS__.at(-1)
  latestWatcher.onFile(materialPath, 'add')
  const oldPending = pauses.at(-1)
  service.openProjectAt(rootB)
  const bPath = join(rootB, '.trellis', 'tasks', 'task-b', 'implement.md')
  writeFileSync(bPath, '# implementation B')
  globalThis.__MATERIAL_WATCHERS__.at(-1).onFile(bPath, 'add')
  const bPending = pauses.at(-1)
  const beforeMaterial = output('bridge:material-updated').length
  oldPending.callback()
  clearTimeout(bPending.timer); bPending.callback()
  await wait(() => output('bridge:material-updated').length > beforeMaterial, 'current B notice')
  const materialB = output('bridge:material-updated').at(-1)
  assert.equal(materialB.projectRoot, rootB)
  assert.equal(materialB.changes[0].relativePath, '.trellis/tasks/task-b/implement.md')
  assert.equal(materialB.changes[0].availability, 'readable')
  assert.equal(materialB.changes[0].source, 'filesystem-event')
  assert.equal(output('bridge:material-updated').some((event) => event.projectRoot === root), false)
  service.openProjectAt(root)
  const finalWatcher = globalThis.__MATERIAL_WATCHERS__.at(-1)
  const finalGeneration = service.getProjectGeneration()
  assert.equal(service.watchReaderDocument(root, { workspaceId: root, taskRef: 'task-b' }, { relativePath: '.trellis/tasks/task-b/implement.md', knownRevision: null }).ok, true)
  unlinkSync(materialPath)
  finalWatcher.onFile(materialPath, 'unlink')
  const deletion = pauses.at(-1)
  clearTimeout(deletion.timer); deletion.callback()
  await wait(() => changed.some((event) => event.revision === null), 'unlink reaches open reader')
  await wait(() => output('bridge:material-updated').some((event) => event.projectRoot === root && event.projectGeneration === finalGeneration), 'unlink material fact')
  const removed = output('bridge:material-updated').at(-1).changes[0]
  assert.equal(removed.kind, 'unlink'); assert.equal(removed.availability, 'missing'); assert.equal(removed.revision, null)
  latestWatcher.onFile(materialPath, 'change')
  assert.equal(pauses.at(-1), deletion, 'Old-root callback cannot schedule into returned A generation')
  const timeline = output('acp:output').find((event) => event.kind === 'material-change' && event.payload.materialChange.projectRoot === rootB)
  assert.equal(timeline.sessionId, undefined); assert.equal(timeline.turnId, undefined)
  const realResearch = join(root, '.trellis', 'tasks', 'task-b', 'research', 'real')
  const aliasResearch = join(root, '.trellis', 'tasks', 'task-b', 'research', 'alias')
  mkdirSync(realResearch, { recursive: true })
  symlinkSync(realResearch, aliasResearch, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(realResearch, 'note.md'), '# internal alias document')
  assert.equal(service.watchReaderDocument(root, { workspaceId: root, taskRef: 'task-b' }, { relativePath: '.trellis/tasks/task-b/research/alias/note.md', knownRevision: null }).ok, true)
  const beforeAliasChange = changed.length
  unlinkSync(join(aliasResearch, 'note.md'))
  finalWatcher.onFile(join(aliasResearch, 'note.md'), 'unlink')
  await wait(() => changed.length > beforeAliasChange, 'unlink of internal junction document reaches canonical reader')
  assert.equal(changed.at(-1).canonicalPath, join(realResearch, 'note.md'))
  assert.equal(changed.at(-1).revision, null)
  removeListener()
  console.log('PASS settled implement add/delete facts, old-root notices, root generations and modern reader unlink bridge')

  await build({ entryPoints: ['src/main/services/watcher.ts'], bundle: true, format: 'esm', platform: 'node', outfile: join(temporary, 'watcher.mjs'), plugins: [{ name: 'lazy-chokidar-fixture', setup(builder) {
    builder.onResolve({ filter: /^chokidar$/ }, () => ({ path: 'chokidar', namespace: 'lazy-watch' }))
    builder.onLoad({ filter: /.*/, namespace: 'lazy-watch' }, () => ({ loader: 'js', contents: `export function watch(path) {
      const item={path,handlers:new Map(),on(event,callback){this.handlers.set(event,callback);return this},close(){return Promise.resolve()}};
      (globalThis.__LAZY_MATERIAL_WATCHERS__??=[]).push(item); return item;
    }` }))
  } }] })
  const { TrellisWatcher } = await import(pathToFileURL(join(temporary, 'watcher.mjs')).href)
  const watcher = new TrellisWatcher()
  const watcherEvents = []
  watcher.start(root, () => watcherEvents.push('old-scan'), () => watcherEvents.push('old-file'))
  watcher.start(rootB, () => watcherEvents.push('current-scan'), (_path, kind) => watcherEvents.push(kind))
  await wait(() => globalThis.__LAZY_MATERIAL_WATCHERS__?.length === 1, 'one watcher after competing lazy starts')
  assert.ok(globalThis.__LAZY_MATERIAL_WATCHERS__[0].path.startsWith(rootB))
  const staleCallback = globalThis.__LAZY_MATERIAL_WATCHERS__[0].handlers.get('change')
  watcher.start(root, () => watcherEvents.push('returned-scan'), (_path, kind) => watcherEvents.push(kind))
  await wait(() => globalThis.__LAZY_MATERIAL_WATCHERS__?.length === 2, 'replacement watcher ready')
  staleCallback(join(rootB, '.trellis', 'tasks', 'task-b', 'prd.md'))
  assert.deepEqual(watcherEvents, [])
  globalThis.__LAZY_MATERIAL_WATCHERS__[1].handlers.get('unlink')(prdPath)
  assert.deepEqual(watcherEvents, ['unlink'])
  watcher.stop()
  delete globalThis.__LAZY_MATERIAL_WATCHERS__
  console.log('PASS lazy watcher replacement closes stale starts/callbacks and forwards unlink')
} finally {
  globalThis.setTimeout = nativeSetTimeout
  for (const item of pauses) clearTimeout(item.timer)
  if (service) { service.closeProjectAt(); await service.shutdownAcp() }
  delete globalThis.__MATERIAL_WATCHERS__
  rmSync(temporary, { recursive: true, force: true })
}
